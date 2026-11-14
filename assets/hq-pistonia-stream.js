/* Transfert HQ — the text/event-stream reader behind Pistonia's streaming (assets/hq-pistonia-stream.js).
 *
 * Only the fiddly part lives here: turning whatever one fetch body read() returned into whole events, across chunk
 * boundaries, CRLF or LF line endings, with comment lines ignored, [DONE] skipped and a malformed frame dropped
 * instead of killing the whole turn. The browser gets it as window.HqPistoniaStream and node as module.exports, so
 * tests/check_hq_pistonia_stream.mjs can drive it without a DOM.
 *
 * The chip falls back to .../message when this file did not load (see streamTurn): an old cached page must never be
 * left with a chat that can neither stream nor post. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else if (root) root.HqPistoniaStream = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* One event block -> its JSON payload, or null when it carries no data: line (a comment, an empty block) or a
     payload that will not parse. */
  function frame(block) {
    var lines = String(block).split("\n"), data = [], i, text;
    for (i = 0; i < lines.length; i++) {
      if (lines[i].slice(0, 5) === "data:") data.push(lines[i].slice(5).replace(/^[ \t]/, ""));
    }
    if (!data.length) return null;
    text = data.join("\n").replace(/^\s+|\s+$/g, "");
    if (!text || text === "[DONE]") return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /* push(chunk) -> the events this chunk completed, in order; the tail of a half-received event is kept for the next
     call. CRLF and bare CR are folded to LF, a trailing CR waits for the LF that may start the next chunk. */
  function Feed() { this.buf = ""; }
  Feed.prototype.push = function (chunk) {
    var out = [], cut, ev;
    this.buf = (this.buf + (chunk === undefined || chunk === null ? "" : String(chunk)))
      .replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
    while ((cut = this.buf.indexOf("\n\n")) >= 0) {
      ev = frame(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut + 2);
      if (ev) out.push(ev);
    }
    return out;
  };

  return { frame: frame, Feed: Feed };
}));
