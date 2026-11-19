/* hq-playground-clock.js — the clock the background duel borrows.
 *
 * A hidden tab clamps setTimeout to about one tick a minute, which used to freeze the "Duel en fond" board behind
 * another window: it sat on one ply until the Master came back. A worker keeps its own timer, so the page can ask for
 * a steady beat and play the move that fell due instead of waking up a minute late. It says nothing but the time.
 */
let beat = 0;

self.onmessage = function (event) {
  const data = event.data || {};
  if (data.stop) {
    if (beat) clearInterval(beat);
    beat = 0;
    return;
  }
  if (beat) return;
  beat = setInterval(function () { self.postMessage({ now: Date.now() }); }, 120);
};
