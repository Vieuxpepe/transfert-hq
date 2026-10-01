/* Transfert HQ — Carnet Stage 07: engineering core (PURE: no DOM, no network, no storage, no Date.now()).
 *
 * 1. Safe calculator. An explicit tokenizer + recursive-descent parser over a closed alphabet. It never uses
 *    eval / Function / dynamic code, has no identifiers, no property access, no strings, no assignment.
 *      expr   := sum
 *      sum    := prod (("+" | "-") prod)*
 *      prod   := unary (("*" | "/") unary)*
 *      unary  := ("+" | "-") unary | power
 *      power  := atom ("^" unary)?              right-associative; -2^2 = -4; 2^-1 = 0.5; 2^3^2 = 2^9
 *      atom   := NUMBER | "(" sum ")"
 *      NUMBER := digits ["." digits] [("e"|"E") ["+"|"-"] digits]     ASCII digits only; "," = decimal separator
 *    Arithmetic only (no functions in Stage 07, so there is no angle convention to document).
 *    Bounds: expression <= 200 chars, numeric token <= 24, nesting <= 32, |exponent| <= 1000, every intermediate and
 *    final value finite with 1e-100 <= |x| <= 1e100 (or 0). A comma is ALWAYS a decimal separator (no thousands
 *    separators); whitespace never means multiplication.
 * 2. Curated unit conversion (exact rational constants, BigInt): mm<->in, N<->lbf, N·m<->lb·ft, bar<->psi,
 *    °C<->°F (affine), kg<->lb. Result precision: significant digits of the input clamped to 3..6 (temperature:
 *    decimals of the input, at least 1), half away from zero.
 * 3. Payload schema of the Stage-07 blocks (calc / measure / decision) — byte-for-byte the rules of
 *    hq_carnet_eng.py, checked by the shared vectors tests/fixtures_carnet_eng.json — plus the exact-decimal
 *    measurement verdict and the readable (TXT/Markdown) descriptions.
 *
 * Plain ES2020, UMD (browser global HqCarnetEng / CommonJS).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetEng = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---------------------------------------------------------------- constants (mirror hq_carnet_eng.py)

  const ENG_TYPES = ["calc", "measure", "decision"];
  const ATOM_TYPES = ["calc", "measure"];
  const CALC_VERSION = 1;
  const UNITS = ["mm", "in", "N", "lbf", "N·m", "lb·ft", "bar", "psi", "°C", "°F", "kg", "lb"];
  const MODES = ["none", "sym", "bounds", "pct"];
  const LINK_KINDS = ["source", "media", "drawing", "file"];
  const EXPR_MAX = 200;
  const RESULT_MAX = 40;
  const LABEL_MAX = 80;
  const DIGITS_MAX = 15;
  const DEC_LEN_MAX = 18;
  const PCT_MAX = 100;
  const AT_MIN = 946684800;
  const AT_MAX = 4102444800;
  const ATOMS_PER_PAGE_MAX = 50;
  const DECISIONS_PER_PAGE_MAX = 100;

  const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const BLANK_RE = /^[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*$/;
  const DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  const RESULT_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-][0-9]{1,3})?$/;
  const EXPR_RE = /^[0-9+\-*/^().eE ]+$/;
  const SRC_RE = /^srce-[A-Za-z0-9_-]{1,64}$/;

  function isObj(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function isInt(v) {
    return typeof v === "number" && Number.isInteger(v);
  }

  function sameKeys(o, keys) {
    const k = Object.keys(o).sort();
    const w = keys.slice().sort();
    return k.length === w.length && k.every((x, i) => x === w[i]);
  }

  // ---------------------------------------------------------------- calculator

  const CALC_LIMITS = { exprMax: EXPR_MAX, numberMax: 24, depthMax: 32, exponentAbsMax: 1000, absMax: 1e100, absMin: 1e-100 };
  const WS = /[ \t  ]/; // the only whitespace accepted (NBSP / NNBSP are typed on French keyboards)

  const CALC_MESSAGES = {
    empty: "Expression vide",
    too_long: "Expression trop longue",
    bad_char: "Caractère non autorisé",
    bad_number: "Nombre invalide",
    syntax: "Expression incomplète ou invalide",
    trailing: "Texte inattendu après l'expression",
    depth: "Expression trop imbriquée",
    div0: "Division par zéro",
    range: "Résultat hors limites",
    exponent: "Exposant trop grand",
    undefined: "Résultat indéfini",
  };

  class CalcError extends Error {
    constructor(code) {
      super(CALC_MESSAGES[code] || "Expression invalide");
      this.code = code;
    }
  }

  function isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }

  /** Deterministic tokenizer. Returns [{t: "num"|"op"|"lp"|"rp", v, pos}] or throws CalcError. */
  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (WS.test(ch)) {
        i += 1;
      } else if (isDigit(ch)) {
        let j = i;
        let text = "";
        const take = () => {
          while (j < src.length && isDigit(src[j])) {
            text += src[j];
            j += 1;
          }
        };
        take();
        if (j < src.length && (src[j] === "." || src[j] === ",") && j + 1 < src.length && isDigit(src[j + 1])) {
          text += ".";
          j += 1;
          take();
        } else if (j < src.length && (src[j] === "." || src[j] === ",")) {
          throw new CalcError("bad_number"); // "5." / "5," / "5.e3"
        }
        if (j < src.length && (src[j] === "e" || src[j] === "E")) {
          let k = j + 1;
          let sign = "";
          if (k < src.length && (src[k] === "+" || src[k] === "-")) {
            sign = src[k];
            k += 1;
          }
          if (!(k < src.length && isDigit(src[k]))) throw new CalcError("bad_number"); // malformed scientific notation
          let ex = "";
          while (k < src.length && isDigit(src[k])) {
            ex += src[k];
            k += 1;
          }
          text += "e" + sign + ex;
          j = k;
        }
        if (j < src.length && (isDigit(src[j]) || src[j] === "." || src[j] === ",")) throw new CalcError("bad_number");
        if (text.length > CALC_LIMITS.numberMax) throw new CalcError("bad_number");
        toks.push({ t: "num", v: text, pos: i });
        i = j;
      } else if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^") {
        toks.push({ t: "op", v: ch, pos: i });
        i += 1;
      } else if (ch === "." || ch === ",") {
        throw new CalcError("bad_number"); // ".5" / ",5": a number starts with a digit
      } else if (ch === "(") {
        toks.push({ t: "lp", v: ch, pos: i });
        i += 1;
      } else if (ch === ")") {
        toks.push({ t: "rp", v: ch, pos: i });
        i += 1;
      } else {
        throw new CalcError("bad_char"); // identifiers, quotes, [] {} ; = . , non-ASCII lookalikes, ...
      }
    }
    return toks;
  }

  function checkFinite(x) {
    if (Number.isNaN(x)) throw new CalcError("undefined");
    if (!Number.isFinite(x)) throw new CalcError("range");
    const a = Math.abs(x);
    if (a > CALC_LIMITS.absMax || (a !== 0 && a < CALC_LIMITS.absMin)) throw new CalcError("range");
    return x;
  }

  /** Parse + evaluate the token list. Full input consumption is enforced by the caller (trailing garbage). */
  function evaluateTokens(toks) {
    let pos = 0;
    const peek = () => toks[pos];
    const isOp = (v) => toks[pos] && toks[pos].t === "op" && toks[pos].v === v;

    function atom(depth) {
      const t = toks[pos];
      if (!t) throw new CalcError("syntax");
      if (t.t === "num") {
        pos += 1;
        return checkFinite(Number(t.v));
      }
      if (t.t === "lp") {
        if (depth + 1 > CALC_LIMITS.depthMax) throw new CalcError("depth");
        pos += 1;
        const v = sum(depth + 1);
        if (!toks[pos] || toks[pos].t !== "rp") throw new CalcError("syntax");
        pos += 1;
        return v;
      }
      throw new CalcError("syntax");
    }

    function power(depth) {
      const base = atom(depth);
      if (isOp("^")) {
        pos += 1;
        if (depth + 1 > CALC_LIMITS.depthMax) throw new CalcError("depth");
        const ex = unary(depth + 1);
        if (Math.abs(ex) > CALC_LIMITS.exponentAbsMax) throw new CalcError("exponent");
        if (base === 0 && ex < 0) throw new CalcError("div0");
        const pw = Math.pow(base, ex);
        if (pw === 0 && base !== 0) throw new CalcError("range"); // underflow is never a silent 0
        return checkFinite(pw);
      }
      return base;
    }

    function unary(depth) {
      if (isOp("+") || isOp("-")) {
        if (depth + 1 > CALC_LIMITS.depthMax) throw new CalcError("depth");
        const neg = toks[pos].v === "-";
        pos += 1;
        const v = unary(depth + 1);
        return neg ? (v === 0 ? 0 : -v) : v;
      }
      return power(depth);
    }

    function prod(depth) {
      let v = unary(depth);
      while (isOp("*") || isOp("/")) {
        const op = toks[pos].v;
        pos += 1;
        const r = unary(depth);
        let res;
        if (op === "*") res = v * r;
        else {
          if (r === 0) throw new CalcError("div0");
          res = v / r;
        }
        if (res === 0 && v !== 0 && r !== 0) throw new CalcError("range"); // underflow is never a silent 0
        v = checkFinite(res);
      }
      return v;
    }

    function sum(depth) {
      let v = prod(depth);
      while (isOp("+") || isOp("-")) {
        const op = toks[pos].v;
        pos += 1;
        const r = prod(depth);
        let res = op === "+" ? v + r : v - r;
        // Cancellation below double-precision noise is exactly 0 (0.1 + 0.2 - 0.3 must not show 5.55e-17).
        if (res !== 0 && Math.abs(res) <= Math.max(Math.abs(v), Math.abs(r)) * 1e-15) res = 0;
        v = checkFinite(res);
      }
      return v;
    }

    const value = sum(0);
    if (peek()) throw new CalcError("trailing");
    return value;
  }

  /** Canonical result text: 12 significant digits, trailing zeros removed, never "-0", no false precision. */
  function formatResult(x) {
    if (x === 0 || !Number.isFinite(x)) return "0";
    const p = x.toPrecision(12);
    const strip = (m) => (m.indexOf(".") >= 0 ? m.replace(/0+$/, "").replace(/\.$/, "") : m);
    const at = p.indexOf("e");
    const out = at < 0 ? strip(p) : strip(p.slice(0, at)) + p.slice(at);
    return out === "-0" ? "0" : out;
  }

  /** Normalized expression text stored with a calculation block: whitespace runs -> one space, "," -> ".". */
  function normalizeExpr(input) {
    return String(input).replace(/[ \t  ]+/g, " ").trim().replace(/,/g, ".");
  }

  /**
   * calculate(input) -> {ok: true, expr, value, result} | {ok: false, code, message}. Never throws, never evaluates
   * anything but the grammar above.
   */
  function calculate(input) {
    try {
      if (typeof input !== "string") throw new CalcError("bad_char");
      if (input.length > CALC_LIMITS.exprMax) throw new CalcError("too_long");
      if (!input.trim()) throw new CalcError("empty");
      const toks = tokenize(input);
      if (!toks.length) throw new CalcError("empty");
      const value = evaluateTokens(toks);
      const expr = normalizeExpr(input);
      return { ok: true, expr, value, result: formatResult(value) };
    } catch (e) {
      if (e instanceof CalcError) return { ok: false, code: e.code, message: e.message };
      if (e instanceof RangeError) return { ok: false, code: "depth", message: CALC_MESSAGES.depth }; // a stack overflow can only mean too deep
      return { ok: false, code: "syntax", message: CALC_MESSAGES.syntax };
    }
  }

  // ---------------------------------------------------------------- exact decimals (BigInt): {n, s} = n / 10^s

  function dec(text) {
    const neg = text.charAt(0) === "-";
    const body = neg ? text.slice(1) : text;
    const dot = body.indexOf(".");
    const whole = dot < 0 ? body : body.slice(0, dot);
    const frac = dot < 0 ? "" : body.slice(dot + 1);
    const n = BigInt(whole + frac);
    return { n: neg ? -n : n, s: frac.length };
  }

  function pow10(k) {
    return 10n ** BigInt(k);
  }

  function align(a, b) {
    const s = Math.max(a.s, b.s);
    return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
  }

  function cmp(a, b) {
    const [x, y] = align(a, b);
    return x > y ? 1 : x < y ? -1 : 0;
  }

  function add(a, b) {
    const [x, y, s] = align(a, b);
    return { n: x + y, s };
  }

  function neg(a) {
    return { n: -a.n, s: a.s };
  }

  function fmtDec(a) {
    const negative = a.n < 0n;
    let digits = (negative ? -a.n : a.n).toString();
    if (a.s) digits = digits.padStart(a.s + 1, "0");
    const whole = a.s ? digits.slice(0, digits.length - a.s) : digits;
    const frac = a.s ? digits.slice(digits.length - a.s).replace(/0+$/, "") : "";
    const text = whole + (frac ? "." + frac : "");
    return text === "0" ? "0" : (negative ? "-" : "") + text;
  }

  // ---------------------------------------------------------------- payload validation (mirror hq_carnet_eng.py)

  function lineOk(v, lo, hi) {
    return typeof v === "string" && v.length >= lo && v.length <= hi && !CTRL.test(v) && !LONE_SURROGATE.test(v);
  }

  function negZero(text) {
    const m = text.split("e")[0];
    return m.charAt(0) === "-" && !/[1-9]/.test(m);
  }

  function decimalOk(v) {
    if (typeof v !== "string" || v.length > DEC_LEN_MAX || !DEC_RE.test(v)) return false;
    return v.replace(/[^0-9]/g, "").length <= DIGITS_MAX && !negZero(v);
  }

  function unitOk(v, allowEmpty) {
    return typeof v === "string" && (UNITS.indexOf(v) >= 0 || (allowEmpty && v === ""));
  }

  function atOk(v) {
    return isInt(v) && v >= AT_MIN && v <= AT_MAX;
  }

  function checkCalc(p) {
    if (!isObj(p) || !sameKeys(p, ["expr", "result", "unit", "at", "v"])) return null;
    if (!lineOk(p.expr, 1, EXPR_MAX) || !EXPR_RE.test(p.expr)) return null;
    if (typeof p.result !== "string" || p.result.length > RESULT_MAX || !RESULT_RE.test(p.result) || negZero(p.result)) return null;
    if (p.unit !== null && !unitOk(p.unit, false)) return null;
    if (!atOk(p.at) || !isInt(p.v) || p.v !== CALC_VERSION) return null;
    return { expr: p.expr, result: p.result, unit: p.unit, at: p.at, v: CALC_VERSION };
  }

  function quantityOk(q) {
    if (!isObj(q) || !sameKeys(q, ["v", "u"]) || !decimalOk(q.v) || !unitOk(q.u, true)) return null;
    return { v: q.v, u: q.u };
  }

  function tolOk(mode, t) {
    if (mode === "none") return t === null ? { ok: true, value: null } : { ok: false };
    if (!isObj(t)) return { ok: false };
    if (mode === "sym") {
      if (!sameKeys(t, ["t", "u"]) || !decimalOk(t.t) || t.t.charAt(0) === "-" || !unitOk(t.u, true)) return { ok: false };
      return { ok: true, value: { t: t.t, u: t.u } };
    }
    if (mode === "bounds") {
      if (!sameKeys(t, ["lo", "hi", "u"]) || !decimalOk(t.lo) || !decimalOk(t.hi) || !unitOk(t.u, true)) return { ok: false };
      if (cmp(dec(t.lo), dec(t.hi)) > 0) return { ok: false };
      return { ok: true, value: { lo: t.lo, hi: t.hi, u: t.u } };
    }
    if (!sameKeys(t, ["p"]) || !decimalOk(t.p) || t.p.charAt(0) === "-" || cmp(dec(t.p), { n: BigInt(PCT_MAX), s: 0 }) > 0) return { ok: false };
    return { ok: true, value: { p: t.p } };
  }

  /** `linkCheck(link)` (optional) owns the path rules of the optional link; it returns a clean link or null. */
  function checkMeasure(p, linkCheck) {
    if (!isObj(p) || !sameKeys(p, ["label", "observed", "mode", "nominal", "tol", "at", "link"])) return null;
    if (typeof p.mode !== "string" || MODES.indexOf(p.mode) < 0) return null;
    const nominal = p.nominal === null ? null : quantityOk(p.nominal);
    if (p.nominal !== null && !nominal) return null;
    if ((p.mode === "sym" || p.mode === "pct") && !nominal) return null;
    let link = null;
    if (p.link !== null) {
      link = linkCheck ? linkCheck(p.link) : linkShape(p.link);
      if (!link) return null;
    }
    const observed = quantityOk(p.observed);
    const tol = tolOk(p.mode, p.tol);
    if (!lineOk(p.label, 1, LABEL_MAX) || BLANK_RE.test(p.label) || !observed || !tol.ok || !atOk(p.at)) return null;
    return { label: p.label, observed, mode: p.mode, nominal, tol: tol.value, at: p.at, link };
  }

  function linkShape(l) {
    if (!isObj(l) || !sameKeys(l, ["kind", "id"]) || LINK_KINDS.indexOf(l.kind) < 0 || typeof l.id !== "string") return null;
    if (l.kind === "source" && !SRC_RE.test(l.id)) return null;
    return { kind: l.kind, id: l.id };
  }

  function checkDecision(p) {
    if (!isObj(p) || !sameKeys(p, ["at"]) || !atOk(p.at)) return null;
    return { at: p.at };
  }

  function checkPayload(kind, p, linkCheck) {
    if (kind === "calc") return checkCalc(p);
    if (kind === "measure") return checkMeasure(p, linkCheck);
    if (kind === "decision") return checkDecision(p);
    return null;
  }

  // ---------------------------------------------------------------- compact fixed-order encoding (draft `fmt` rows)
  // Never object keys: equality of two contents is a plain string compare.

  function encode(kind, p) {
    if (kind === "calc") return [p.expr, p.result, p.unit, p.at, p.v];
    if (kind === "decision") return [p.at];
    const tol = p.mode === "none" ? null : p.mode === "sym" ? [p.tol.t, p.tol.u] : p.mode === "bounds" ? [p.tol.lo, p.tol.hi, p.tol.u] : [p.tol.p];
    return [
      p.label,
      [p.observed.v, p.observed.u],
      p.mode,
      p.nominal ? [p.nominal.v, p.nominal.u] : null,
      tol,
      p.at,
      p.link ? [p.link.kind, p.link.id] : null,
    ];
  }

  /** Inverse of encode(); strict: anything malformed returns null. `linkCheck` as in checkMeasure. */
  function decode(kind, a, linkCheck) {
    if (!Array.isArray(a)) return null;
    if (kind === "calc") return a.length === 5 ? checkCalc({ expr: a[0], result: a[1], unit: a[2], at: a[3], v: a[4] }) : null;
    if (kind === "decision") return a.length === 1 ? checkDecision({ at: a[0] }) : null;
    if (kind !== "measure" || a.length !== 7) return null;
    const pair = (x) => (x === null ? null : Array.isArray(x) && x.length === 2 ? { v: x[0], u: x[1] } : undefined);
    const observed = pair(a[1]);
    const nominal = pair(a[3]);
    if (observed === undefined || observed === null || nominal === undefined) return null;
    let tol = null;
    if (a[2] === "sym") tol = Array.isArray(a[4]) && a[4].length === 2 ? { t: a[4][0], u: a[4][1] } : undefined;
    else if (a[2] === "bounds") tol = Array.isArray(a[4]) && a[4].length === 3 ? { lo: a[4][0], hi: a[4][1], u: a[4][2] } : undefined;
    else if (a[2] === "pct") tol = Array.isArray(a[4]) && a[4].length === 1 ? { p: a[4][0] } : undefined;
    else tol = a[4];
    if (tol === undefined) return null;
    const link = a[6] === null ? null : Array.isArray(a[6]) && a[6].length === 2 ? { kind: a[6][0], id: a[6][1] } : undefined;
    if (link === undefined) return null;
    return checkMeasure({ label: a[0], observed, mode: a[2], nominal, tol, at: a[5], link }, linkCheck);
  }

  // ---------------------------------------------------------------- measurement verdict (exact, inclusive)

  /**
   * {deviation, lo, hi, status}. status: "none" | "in" | "out" | "incompatible". Units are compared as labels:
   * a mismatch is never converted and never compared ("incompatible"). Mirrors hq_carnet_eng.evaluate.
   */
  function evaluate(m) {
    const obs = m.observed;
    const nom = m.nominal;
    const value = dec(obs.v);
    const out = { deviation: null, lo: null, hi: null, status: "none" };
    if (nom && nom.u === obs.u) out.deviation = fmtDec(add(value, neg(dec(nom.v))));
    if (m.mode === "none") return out;
    let lo;
    let hi;
    if (m.mode === "bounds") {
      if (m.tol.u !== obs.u) {
        out.status = "incompatible";
        return out;
      }
      lo = dec(m.tol.lo);
      hi = dec(m.tol.hi);
    } else {
      if (nom.u !== obs.u || (m.mode === "sym" && m.tol.u !== obs.u)) {
        out.status = "incompatible";
        return out;
      }
      const centre = dec(nom.v);
      let half;
      if (m.mode === "sym") half = dec(m.tol.t);
      else {
        const p = dec(m.tol.p);
        half = { n: (centre.n < 0n ? -centre.n : centre.n) * p.n, s: centre.s + p.s + 2 };
      }
      lo = add(centre, neg(half));
      hi = add(centre, half);
    }
    out.lo = fmtDec(lo);
    out.hi = fmtDec(hi);
    out.status = cmp(lo, value) <= 0 && cmp(value, hi) <= 0 ? "in" : "out";
    return out;
  }

  // ---------------------------------------------------------------- readable representation (UTC, deterministic)

  const STATUS_TEXT = { in: "dans la tolérance", out: "hors tolérance", incompatible: "unités incompatibles (comparaison non faite)" };
  const DISCLAIMER = "aide de carnet, non certifié";

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function fmtTime(at) {
    const d = new Date(at * 1000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
  }

  function withUnit(v, u) {
    return v + (u ? " " + u : "");
  }

  function describeCalc(p) {
    return "Calcul : " + p.expr + " = " + withUnit(p.result, p.unit) + " — " + fmtTime(p.at);
  }

  function describeMeasure(p) {
    const verdict = evaluate(p);
    const obs = p.observed;
    const parts = [];
    if (p.nominal) parts.push("nominal " + withUnit(p.nominal.v, p.nominal.u));
    if (p.mode === "sym") parts.push("±" + withUnit(p.tol.t, p.tol.u));
    else if (p.mode === "pct") parts.push("±" + p.tol.p + " %");
    else if (p.mode === "bounds") parts.push("limites " + p.tol.lo + " … " + withUnit(p.tol.hi, p.tol.u));
    if (verdict.deviation !== null) {
      const d = verdict.deviation;
      parts.push("écart " + withUnit(d !== "0" && d.charAt(0) !== "-" ? "+" + d : d, obs.u));
    }
    if (STATUS_TEXT[verdict.status]) parts.push(STATUS_TEXT[verdict.status]);
    const head = "Mesure : " + p.label + " — observé " + withUnit(obs.v, obs.u);
    return head + (parts.length ? " ; " + parts.join(" ; ") : "") + " — " + DISCLAIMER + " — " + fmtTime(p.at);
  }

  function decisionLabel(p) {
    return "DÉCISION · " + fmtTime(p.at);
  }

  // ---------------------------------------------------------------- unit conversion (exact rationals)

  // value_to = value_from * num / den, all constants EXACT (definitions, not measurements):
  //   1 in = 25.4 mm · 1 lb = 0.45359237 kg · 1 lbf = 0.45359237 kg * 9.80665 m/s² = 4.4482216152605 N
  //   1 lb·ft = 1 lbf * 0.3048 m = 1.35581794833140... N·m · 1 psi = 1 lbf / (0.0254 m)² = 6894.757293168361... Pa
  //   1 bar = 100000 Pa
  const RATIO = {
    "in>mm": [254n, 10n],
    "lb>kg": [45359237n, 100000000n],
    "lbf>N": [44482216152605n, 10000000000000n],
    "lb·ft>N·m": [44482216152605n * 3048n, 10000000000000n * 10000n],
    "psi>bar": [44482216152605n, 10000000000n * 64516n],
  };
  const INVERSE_OF = { "mm>in": "in>mm", "kg>lb": "lb>kg", "N>lbf": "lbf>N", "N·m>lb·ft": "lb·ft>N·m", "bar>psi": "psi>bar" };
  const PAIRS = ["mm>in", "in>mm", "N>lbf", "lbf>N", "N·m>lb·ft", "lb·ft>N·m", "bar>psi", "psi>bar", "°C>°F", "°F>°C", "kg>lb", "lb>kg"];
  const ALIASES = { "N.m": "N·m", Nm: "N·m", "lb.ft": "lb·ft", lbft: "lb·ft" };
  const CONVERT_LIMIT_DIGITS = 15;

  const CONVERT_MESSAGES = {
    bad_value: "Valeur invalide",
    bad_unit: "Unité non prise en charge",
    bad_pair: "Conversion non prise en charge",
    range: "Résultat hors limites",
  };

  function canonicalUnit(u) {
    const t = String(u).trim();
    return ALIASES[t] || t;
  }

  /** "25,4" / " -3.5 " -> canonical decimal string or null (one comma = decimal separator, no thousands separators). */
  function parseDecimalInput(text) {
    const t = String(text).trim().replace(/,/g, ".");
    if (!t || t.indexOf(".") !== t.lastIndexOf(".")) return null;
    const v = t.charAt(0) === "+" ? t.slice(1) : t;
    if (!DEC_RE.test(v)) return null;
    if (v.replace(/[^0-9]/g, "").length > CONVERT_LIMIT_DIGITS) return null;
    return negZero(v) ? v.slice(1) : v;
  }

  /** "25,4 mm", "  12 N·m " -> {value, unit} | null. Whitespace around and between value and unit is ignored. */
  function parseQuantity(text) {
    const m = /^\s*([+-]?[0-9][0-9.,]*)\s*([^\s0-9][^\s]*)\s*$/u.exec(String(text));
    if (!m) return null;
    const value = parseDecimalInput(m[1]);
    const unit = canonicalUnit(m[2]);
    return value !== null && UNITS.indexOf(unit) >= 0 ? { value, unit } : null;
  }

  function sigDigits(v) {
    // Whole numbers: trailing zeros are placeholders, not expressed precision ("100" = 1 digit; "100.0" = 4).
    let digits = v.replace(/^-/, "").replace(".", "").replace(/^0+/, "");
    if (v.indexOf(".") < 0) digits = digits.replace(/0+$/, "");
    return digits.length;
  }

  function divRound(a, b) {
    // half away from zero; b > 0
    const neg = a < 0n;
    const x = neg ? -a : a;
    const q = (2n * x + b) / (2n * b);
    return neg ? -q : q;
  }

  function scaledToString(q, d) {
    const negative = q < 0n;
    let digits = (negative ? -q : q).toString();
    if (d > 0) {
      digits = digits.padStart(d + 1, "0");
      return (negative ? "-" : "") + digits.slice(0, digits.length - d) + "." + digits.slice(digits.length - d);
    }
    return (negative ? "-" : "") + digits + "0".repeat(-d);
  }

  function e10Of(n, s, num, den) {
    // floor(log10(|n / 10^s * num / den|)) of a non-zero rational, exact: digit-count estimate, then at most a step or two
    const top = (n < 0n ? -n : n) * num;
    const bottom = den * pow10(s);
    let e = top.toString().length - bottom.toString().length;
    const ge = (k) => (k >= 0 ? top >= bottom * pow10(k) : top * pow10(-k) >= bottom);
    while (!ge(e)) e -= 1;
    while (ge(e + 1)) e += 1;
    return e;
  }

  /**
   * convert(valueText, from, to) -> {ok: true, value, from, to, rounded} | {ok: false, code, message}.
   * `value` is the canonical decimal string (check: a valid measurement decimal). Never throws.
   */
  function convert(valueText, from, to) {
    const fail = (code) => ({ ok: false, code, message: CONVERT_MESSAGES[code] });
    const v = parseDecimalInput(valueText);
    if (v === null) return fail("bad_value");
    const a = canonicalUnit(from);
    const b = canonicalUnit(to);
    if (UNITS.indexOf(a) < 0 || UNITS.indexOf(b) < 0) return fail("bad_unit");
    const pair = a + ">" + b;
    if (PAIRS.indexOf(pair) < 0) return fail("bad_pair");
    const x = dec(v);
    const decimals = x.s;
    if (x.n === 0n) return { ok: true, value: a === "°C" || a === "°F" ? convertTemp(v, a, decimals) : "0", from: a, to: b, rounded: false };
    if (a === "°C" || a === "°F") {
      const value = convertTemp(v, a, decimals);
      return value === null ? fail("range") : { ok: true, value, from: a, to: b, rounded: true };
    }
    let num;
    let den;
    if (RATIO[pair]) [num, den] = RATIO[pair];
    else {
      [den, num] = RATIO[INVERSE_OF[pair]];
    }
    const S = Math.min(6, Math.max(1, sigDigits(v)));
    const e = e10Of(x.n, x.s, num, den);
    const d = S - 1 - e;
    const numer = x.n * num * pow10(Math.max(d, 0));
    const denom = den * pow10(x.s) * pow10(Math.max(-d, 0));
    let q = divRound(numer, denom);
    let dd = d;
    if ((q < 0n ? -q : q).toString().length > S) {
      // rounding carried across a power of ten (9.996 -> 10.00): the magnitude grew by one, so drop one decimal place;
      // q is then exactly 10^S and the division is exact. Never show more significant digits than the input has.
      q /= 10n;
      dd -= 1;
    }
    const value = scaledToString(q, dd);
    if (value.replace(/[^0-9]/g, "").length > CONVERT_LIMIT_DIGITS) return fail("range");
    return { ok: true, value, from: a, to: b, rounded: true };
  }

  function convertTemp(v, from, decimals) {
    const x = dec(v);
    const d = decimals === undefined ? 1 : decimals;
    let numer;
    let denom;
    if (from === "°C") {
      // F = C * 9/5 + 32
      numer = x.n * 9n + 32n * 5n * pow10(x.s);
      denom = 5n * pow10(x.s);
    } else {
      // C = (F - 32) * 5/9
      numer = (x.n - 32n * pow10(x.s)) * 5n;
      denom = 9n * pow10(x.s);
    }
    const q = divRound(numer * pow10(d), denom);
    const value = scaledToString(q, d);
    const text = /^-0(\.0*)?$/.test(value) ? value.slice(1) : value;
    return text.replace(/[^0-9]/g, "").length > CONVERT_LIMIT_DIGITS ? null : text;
  }

  return {
    ENG_TYPES, ATOM_TYPES, CALC_VERSION, UNITS, MODES, LINK_KINDS, EXPR_MAX, LABEL_MAX, RESULT_MAX, AT_MIN, AT_MAX, PCT_MAX,
    ATOMS_PER_PAGE_MAX, DECISIONS_PER_PAGE_MAX, CALC_LIMITS, PAIRS,
    calculate, tokenize, formatResult, normalizeExpr,
    convert, parseQuantity, parseDecimalInput, canonicalUnit,
    checkCalc, checkMeasure, checkDecision, checkPayload, linkShape, decimalOk, encode, decode,
    evaluate, fmtTime, describeCalc, describeMeasure, decisionLabel, STATUS_TEXT, DISCLAIMER,
  };
});
