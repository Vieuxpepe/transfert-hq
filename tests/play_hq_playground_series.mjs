// Played series for the playground's reply families (assets/hq-playground.js).
// Two sisters in the same style band and the same reply family, the same opponent, the same forced first moves, and
// opposite results: Culinia loses her series, Forgia wins hers. Full games are played through the engine and the
// learning entry point the browser uses at the end of a duel (`learnFromGame`), so no lesson is planted by hand.
// Prints one line per game — family, learned state, the answer she actually played — then the two final tables.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../assets/hq-playground.js").pure;

const OPPONENT = "musica";
const LOSER = "culinia";
const WINNER = "forgia";
const BAND = { opening: 0.5, risk: 0.8, convert: 0.5, games: 4 };
// Openings come in runs, as a real series does: enough games on one first move for that answer to be judged on its own.
const OPENINGS = [["e2", "e4", "1.e4"], ["e2", "e4", "1.e4"], ["e2", "e4", "1.e4"], ["e2", "e4", "1.e4"],
  ["d2", "d4", "1.d4"], ["d2", "d4", "1.d4"], ["d2", "d4", "1.d4"], ["d2", "d4", "1.d4"]];
const NEW_OPENINGS = [["g1", "f3", "1.Cf3"], ["c2", "c4", "1.c4"]];
const GAMES = 8;
const PLY_CAP = 100;
// Determinism: the search is time-budgeted, so a short budget makes each run pick different moves. A fixed depth with a
// budget that is never reached (no abort, no `Math.random` in the search) plays the same games on every run.
const DEPTH = 3;
const BUDGET = 600000;

const SLOT_NAMES = { e4: "1.e4", d4: "1.d4", nf3: "1.Cf3", c4: "1.c4", d3: "1.d3", other: "autre" };
const REPLY_NAMES = { e5: "1…e5", c5: "1…c5", d5: "1…d5", nf6: "1…Cf6", e6: "1…e6", c6: "1…c6", g6: "1…g6" };
const slotName = (slot) => SLOT_NAMES[slot] || slot;
const replyName = (plan, slot) => (plan && plan[slot] ? plan[slot].name : "-");
const tableOf = (plan) => ["e4", "d4", "nf3", "c4", "d3"].map((slot) => slotName(slot) + "→" + replyName(plan, slot)).join(" ");

function seedStore() {
  const all = P.growth.read();
  for (const key of Object.keys(all)) delete all[key];
  for (const key of [LOSER, WINNER]) {
    all[key] = {
      games: 4, wins: 1, losses: 3, draws: 0,
      traits: P.growth.base(key), style: Object.assign({}, BAND),
    };
  }
  return all;
}

// The same argument list `assistantReply` hands to the search, minus the opening habit: the forced first move below is
// what keeps both series on the same openings instead of whatever White's book would open with.
function moveFor(key, pos, history) {
  const prefs = P.duel.prefsFor(key);
  const tuned = P.duel.tune(key, OPPONENT);
  const style = { opening: prefs.opening, risk: prefs.risk, convert: prefs.convert, reply: prefs.reply };
  return P.bestMove(pos, DEPTH, BUDGET, P.styleOf(key), history, tuned.tune, P.growth.base(key), tuned.shift, {
    style, ply: history.length, first: history[0] && history[0].move, deepPlan: P.duel.deepPlanFor(key, history),
  });
}

// The handicap: after her first answer the losing sister plays the move that is worst for her, so her defeats are
// played on the board rather than declared.
function worstMove(pos) {
  let pick = null;
  let worst = Infinity;
  for (const move of P.legalMoves(pos)) {
    const next = P.applyMove(pos, move);
    const status = P.gameStatus(next);
    const score = status.over && status.winner && status.winner !== pos.turn ? -1e6 : -P.evaluate(next);
    if (score < worst) {
      worst = score;
      pick = move;
    }
  }
  return pick;
}

// `bad` names the side playing the worst move available: the sister who must lose her series, or the opponent who must
// blunder in the sister's winning series. Same opponent, same openings, opposite outcomes — played, not declared.
function playGame(learner, opening, bad, index) {
  P.duel.commitBook(learner);
  P.duel.commitBook(OPPONENT);
  let pos = P.parseFen(P.START_FEN);
  const history = [];
  let status = P.gameStatus(pos);
  let answer = "";
  let bookAnswer = "";
  while (history.length < PLY_CAP) {
    status = P.settleDraw(P.gameStatus(pos), history, pos);
    if (status.over) break;
    const key = pos.turn === "w" ? OPPONENT : learner;
    let move;
    if (pos.turn === "w" && history.length === 0) {
      move = P.legalMoves(pos).find((m) => m.from === P.sq(opening[0]) && m.to === P.sq(opening[1])) || moveFor(key, pos, history);
    } else if (key !== OPPONENT && history.length === 1) {
      const prefs = P.duel.prefsFor(learner);
      bookAnswer = replyName(prefs.reply, P.duel.openingKeyOf(history[0].move));
      move = moveFor(key, pos, history);
    } else if (history.length > 1 && ((key !== OPPONENT && bad === "learner") || (key === OPPONENT && bad === "opponent"))) {
      move = worstMove(pos) || moveFor(key, pos, history);
    } else {
      move = moveFor(key, pos, history);
    }
    if (!move) break;
    const before = pos;
    pos = P.applyMove(pos, move);
    history.push({ pos: before, move, color: before.turn, by: key, captured: !!before.board[move.to] });
    if (history.length === 2) answer = P.duel.replyKeyOf(move) || answer;
  }
  const finalStatus = P.settleDraw(P.gameStatus(pos), history, pos);
  const winner = finalStatus.over ? (finalStatus.winner || "") : "";
  const gameId = "g" + (1794800000000 + index * 1000);
  const pre = P.duel.prefsFor(learner).reply;
  P.growth.learnFromGame(history, { w: OPPONENT, b: learner }, winner, gameId);
  // The learning step alone: this is where a family switch happens, before the duel journal's style snapshot.
  const mid = P.duel.prefsFor(learner).reply;
  P.duel.noteDuel(OPPONENT, learner, winner, P.gameStatus(pos), history.length, gameId);
  const post = P.duel.prefsFor(learner).reply;
  if (process.env.SERIES_TRACE) {
    const moves = history.map((entry) => P.nameOf(entry.move.from) + P.nameOf(entry.move.to)).join(" ");
    console.log("trace " + index + " " + learner + " " + moves + " | " + (finalStatus.reason || (finalStatus.winner ? "mat" : "plafond")));
  }
  return {
    winner, plies: history.length, answer, bookAnswer, status: finalStatus, gameId,
    switched: pre.family !== mid.family,
    unfaced: { before: replyName(pre, "other"), learned: replyName(mid, "other"), after: replyName(post, "other") },
  };
}

function report(learner, game, opening) {
  const prefs = P.duel.prefsFor(learner);
  const slot = P.duel.openingKeyOf({ from: P.sq(opening[0]), to: P.sq(opening[1]) });
  const cell = prefs.replyLearn && prefs.replyLearn[slot];
  const changed = prefs.replyChanged && prefs.replyChanged[slot];
  const result = !game.winner ? "nulle" + (game.status && game.status.reason ? " (" + game.status.reason + ")" : "") : (game.winner === "b" ? "victoire" : "défaite");
  const sample = cell ? cell.games + "p " + cell.wins + "v " + cell.draws + "n " + cell.losses + "d" : "—";
  const lesson = changed ? REPLY_NAMES[changed.from] + "→" + REPLY_NAMES[changed.to] : "—";
  const moved = prefs.replyFamily && prefs.replyFamily.from && prefs.replyFamily.to
    ? " [famille " + prefs.replyFamily.from + "→" + prefs.replyFamily.to + "]"
    : "";
  const table = game.bookAnswer || "?";
  const played = game.answer ? REPLY_NAMES[game.answer] : "?";
  // `autre` is never faced in this series: the learning step itself must leave it alone.
  const unfaced = game.switched
    ? "autre " + game.unfaced.before + " (leçon) " + game.unfaced.learned + " (style) " + game.unfaced.after
    : "autre " + game.unfaced.after;
  return learner + "  " + opening[2] + "  " + result + " (" + game.plies + " plies)  famille " + (prefs.reply.family || "?")
    + moved + "  table " + slotName(slot) + "→" + table + "  joué " + played
    + (played !== table ? "  ÉCART" : "") + "  " + slotName(slot) + ": " + sample + "  appris " + lesson
    + "  " + unfaced;
}

seedStore();
const before = {};
for (const key of [LOSER, WINNER]) {
  P.duel.commitBook(key);
  before[key] = P.duel.prefsFor(key).reply;
}
console.log("Départ — même bandeau, même famille, même table :");
for (const key of [LOSER, WINNER]) console.log("  " + key.padEnd(8) + " famille " + before[key].family + "  " + tableOf(before[key]));
console.log("");

let index = 0;
for (let game = 0; game < GAMES; game += 1) {
  const opening = OPENINGS[game % OPENINGS.length];
  for (const [learner, bad] of [[LOSER, "learner"], [WINNER, "opponent"]]) {
    index += 1;
    const played = playGame(learner, opening, bad, index);
    console.log("Partie " + String(index).padStart(2) + "  " + report(learner, played, opening));
  }
}

console.log("");
console.log("Après la série — deux ouvertures jamais affrontées pendant la série :");
for (const opening of NEW_OPENINGS) {
  for (const learner of [LOSER, WINNER]) {
    index += 1;
    const played = playGame(learner, opening, "", index);
    console.log("Partie " + String(index).padStart(2) + "  " + report(learner, played, opening));
  }
}

console.log("");
console.log("État final :");
for (const key of [LOSER, WINNER]) {
  const prefs = P.duel.prefsFor(key);
  const lesson = prefs.replyFamily && prefs.replyFamily.from && prefs.replyFamily.to
    ? "  famille apprise " + prefs.replyFamily.from + "→" + prefs.replyFamily.to + " (" + prefs.replyFamily.games + " parties)"
    : "";
  console.log("  " + key.padEnd(8) + " famille " + prefs.reply.family + "  " + tableOf(prefs.reply) + lesson);
  const learned = Object.keys(prefs.replyChanged || {});
  console.log("           appris " + (learned.length ? learned.map((slot) => slotName(slot) + " " + prefs.replyChanged[slot].from + "→" + prefs.replyChanged[slot].to).join(", ") : "—"));
}

// A style drift after the series must not undo the family a result lesson chose, nor the answers it taught.
console.log("");
console.log("Passage de style après la série (refineBook, 0.95 / 0.75) :");
for (const key of [LOSER, WINNER]) {
  const was = P.duel.prefsFor(key);
  P.duel.refineBook(key, { opening: 0.95, risk: 0.75, convert: 0.5 });
  const now = P.duel.prefsFor(key);
  const kept = ["e4", "d4", "nf3", "c4", "d3"].every((slot) => {
    const learned = was.replyChanged && was.replyChanged[slot];
    return !learned || was.reply[slot].key === now.reply[slot].key;
  });
  console.log("  " + key.padEnd(8) + " famille " + was.reply.family + " → " + now.reply.family
    + "  table " + tableOf(now.reply) + "  réponses apprises gardées : " + (kept ? "oui" : "NON"));
}
