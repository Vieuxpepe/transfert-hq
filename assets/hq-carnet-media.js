/* Transfert HQ — Carnet Stage 06: browser-side image pipeline (input -> optimised image -> upload).
 *
 * The SERVER has no image decoder (stdlib only): it validates and bounds what is uploaded but never
 * transforms pixels. Everything that changes pixels therefore happens HERE, before the upload:
 *   - the source is bounded (<= 16 MiB, <= 50 megapixels) BEFORE it is decoded, from its own bytes (never from
 *     file.type / the file name, which are only hints);
 *   - it is decoded by the browser (EXIF orientation is applied by the decoder), drawn on a canvas scaled so the
 *     long side is <= 2560 px, and re-encoded. That bakes the orientation into the pixels and drops EXIF/GPS;
 *   - the result must fit the 12 MiB per-file server cap, else it is re-encoded smaller or refused.
 * The server then re-validates everything (magic, structure, dimensions, orientation == 1, size, quota).
 *
 * HEIC/HEIF are NOT supported (nothing here or on the server decodes them). Whether iOS converts a library photo to
 * JPEG before it reaches the file input depends on the OS/browser: that behaviour is UNVERIFIED here.
 *
 * Plain ES2020, no build step, no dynamic code generation, no HTML-string sinks.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetMedia = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const SOURCE_MAX_BYTES = 16 * 1024 * 1024; // server limits().media_source_bytes
  const SOURCE_MAX_PIXELS = 50 * 1000 * 1000;
  const LONG_SIDE = 2560; // server: MAX_LONG_SIDE
  const FILE_MAX_BYTES = 12 * 1024 * 1024; // server: MAX_FILE_BYTES
  const HEAD_BYTES = 2 * 1024 * 1024; // enough to find a JPEG SOF behind large APPn segments
  const ACCEPT = "image/jpeg,image/png,image/webp";
  const ACCEPT_FILES = ".jpg,.jpeg,.png,.webp," + ACCEPT;
  const MIMES = ["image/jpeg", "image/png", "image/webp"];
  const UPLOAD_URL = "/api/carnet/asset";

  class MediaError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "MediaError";
      this.code = code;
    }
  }

  // ------------------------------------------------------------------ header sniffing (dimensions only)

  function u32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }

  function u16(b, i) {
    return (b[i] << 8) | b[i + 1];
  }

  function ascii(b, i, n) {
    let s = "";
    for (let k = 0; k < n; k += 1) s += String.fromCharCode(b[i + k]);
    return s;
  }

  /**
   * {mime, w, h} read from the first bytes (stored dimensions, before any EXIF rotation), or null when the
   * content is not a JPEG/PNG/WebP whose size can be read. Never throws, never allocates more than a few bytes.
   */
  function sniffDims(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
      if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
      return { mime: "image/png", w: u32(b, 16), h: u32(b, 20) };
    }
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i] !== 0xff) return null;
        let m = b[i + 1];
        while (m === 0xff && i + 2 < b.length) {
          i += 1;
          m = b[i + 1];
        }
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
          i += 2;
          continue;
        }
        if (m === 0xd9 || m === 0xda || m === 0x00) return null;
        const len = u16(b, i + 2);
        if (len < 2) return null;
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          if (i + 9 > b.length) return null;
          return { mime: "image/jpeg", w: u16(b, i + 7), h: u16(b, i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
      const kind = ascii(b, 12, 4);
      if (kind === "VP8X" && b.length >= 30) {
        return { mime: "image/webp", w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
      }
      if (kind === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return { mime: "image/webp", w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
      }
      if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { mime: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    return null;
  }

  /** Pure sizing rule: fit (w, h) inside `longSide` on the long side, keep the aspect ratio, never upscale. */
  function fitWithin(w, h, longSide) {
    const long = Math.max(w, h);
    if (long <= longSide) return { w, h, scaled: false };
    const k = longSide / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
  }

  // ------------------------------------------------------------------ decode / encode

  function fail(code, message) {
    return new MediaError(code, message);
  }

  async function decodeImage(file, env) {
    const doc = env.document;
    const Img = env.Image;
    if (typeof Img === "function" && env.URL && typeof env.URL.createObjectURL === "function") {
      // <img> first: every engine applies the EXIF orientation when it draws an <img> on a canvas.
      const url = env.URL.createObjectURL(file);
      const img = new Img();
      img.decoding = "async";
      try {
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("decode"));
          img.src = url;
        });
        if (typeof img.decode === "function") {
          try {
            await img.decode();
          } catch (_) {}
        }
        return {
          source: img, w: img.naturalWidth, h: img.naturalHeight,
          close() {
            img.onload = img.onerror = null;
            img.src = "";
            env.URL.revokeObjectURL(url);
          },
        };
      } catch (_) {
        env.URL.revokeObjectURL(url);
      }
    }
    if (typeof env.createImageBitmap === "function") {
      try {
        const bmp = await env.createImageBitmap(file);
        return { source: bmp, w: bmp.width, h: bmp.height, close() { try { bmp.close(); } catch (_) {} } };
      } catch (_) {}
    }
    void doc;
    throw fail("decode", "Image illisible par ce navigateur");
  }

  function encodeCanvas(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), type, quality);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function render(decoded, size, type, quality, env) {
    const canvas = env.document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw fail("canvas", "Traitement d'image indisponible");
      if (type === "image/jpeg") {
        ctx.fillStyle = "#ffffff"; // JPEG has no alpha: transparent pixels become white, never black
        ctx.fillRect(0, 0, size.w, size.h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, 0, 0, size.w, size.h);
      return await encodeCanvas(canvas, type, quality);
    } finally {
      canvas.width = 0; // release the backing store now (Safari keeps it until GC otherwise)
      canvas.height = 0;
    }
  }

  function browserEnv() {
    return {
      document: global.document, Image: global.Image, URL: global.URL, createImageBitmap: global.createImageBitmap ? global.createImageBitmap.bind(global) : null,
      readHead: null,
    };
  }

  /**
   * file -> {blob, mime, w, h, scaled, sourceBytes}. Throws MediaError (user-facing French message) when the
   * file cannot be used. `o.env` replaces the browser primitives (tests).
   */
  async function prepare(file, o) {
    const opt = Object.assign({ longSide: LONG_SIDE, fileMax: FILE_MAX_BYTES, sourceMax: SOURCE_MAX_BYTES, pixelsMax: SOURCE_MAX_PIXELS }, o || {});
    const env = Object.assign(browserEnv(), (o && o.env) || {});
    if (!file || typeof file.size !== "number" || typeof file.slice !== "function") throw fail("bad_file", "Fichier illisible");
    if (file.size <= 0) throw fail("empty", "Fichier vide");
    if (file.size > opt.sourceMax) throw fail("source_too_large", "Image trop volumineuse (max " + Math.round(opt.sourceMax / 1048576) + " Mo)");
    let head;
    try {
      head = new Uint8Array(await file.slice(0, Math.min(file.size, HEAD_BYTES)).arrayBuffer());
    } catch (_) {
      throw fail("read", "Fichier illisible");
    }
    const info = sniffDims(head); // the bytes decide, never file.type or the name
    if (!info || MIMES.indexOf(info.mime) < 0) throw fail("unsupported_type", "Format non pris en charge (JPEG, PNG ou WebP ; HEIC n'est pas pris en charge)");
    if (!(info.w >= 1 && info.h >= 1)) throw fail("unreadable", "Image illisible");
    if (info.w * info.h > opt.pixelsMax) throw fail("source_pixels", "Image trop grande (max " + Math.round(opt.pixelsMax / 1000000) + " mégapixels)");
    const decoded = await decodeImage(file, env);
    try {
      if (!(decoded.w >= 1 && decoded.h >= 1)) throw fail("unreadable", "Image illisible");
      const size = fitWithin(decoded.w, decoded.h, opt.longSide); // decoded dims are already EXIF-oriented
      // PNG stays PNG (diagrams/screenshots stay lossless); everything else is lossy, WebP only if the engine encodes it.
      const plan = info.mime === "image/png" ? [["image/png", undefined], ["image/jpeg", 0.9], ["image/jpeg", 0.8], ["image/jpeg", 0.7]]
        : info.mime === "image/webp" ? [["image/webp", 0.9], ["image/jpeg", 0.88], ["image/jpeg", 0.8], ["image/jpeg", 0.7]]
          : [["image/jpeg", 0.88], ["image/jpeg", 0.8], ["image/jpeg", 0.7], ["image/jpeg", 0.6]];
      for (const [type, quality] of plan) {
        let blob;
        try {
          blob = await render(decoded, size, type, quality, env);
        } catch (e) {
          if (e instanceof MediaError) throw e;
          continue;
        }
        if (MIMES.indexOf(blob.type) < 0) continue; // the engine could not encode this type (e.g. WebP on Safari)
        if (blob.size > opt.fileMax) continue;
        return { blob, mime: blob.type, w: size.w, h: size.h, scaled: size.scaled, sourceBytes: file.size };
      }
      throw fail("too_heavy", "Image trop lourde, même réduite (max " + Math.round(opt.fileMax / 1048576) + " Mo)");
    } finally {
      decoded.close();
    }
  }

  // ------------------------------------------------------------------ upload

  /** Human message for a failed upload: the server's French text when there is one, else a generic one. */
  function describeError(err) {
    if (err instanceof MediaError) return err.message;
    if (err && err.data && typeof err.data.error === "string") return err.data.error;
    const m = err && err.message ? String(err.message) : "";
    return m && m.length < 140 ? m : "Téléversement impossible";
  }

  /** Upload one prepared blob. `apiCall(url, init)` is HQ's global api(): same-origin cookie, Origin sent by the browser. */
  async function upload(blob, apiCall) {
    const res = await apiCall(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Carnet-Mime": blob.type },
      body: blob,
      timeoutMs: 180000,
    });
    const a = res && res.asset;
    if (!a || typeof a.id !== "string" || MIMES.indexOf(a.mime) < 0 || !(a.w >= 1 && a.h >= 1)) throw fail("bad_response", "Réponse du serveur invalide");
    return { id: a.id, mime: a.mime, w: a.w, h: a.h, bytes: a.bytes };
  }

  return {
    SOURCE_MAX_BYTES, SOURCE_MAX_PIXELS, LONG_SIDE, FILE_MAX_BYTES, ACCEPT, ACCEPT_FILES, MIMES, UPLOAD_URL,
    MediaError, sniffDims, fitWithin, prepare, upload, describeError,
  };
});
