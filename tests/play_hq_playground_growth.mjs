// Growth proof for the playground: do real duels against different kinds of opponent actually move a sister's stored
// traits in different directions? Plays full games through the engine and the same `learnFromGame` entry point the page
// uses, with two opponent policies that are deliberately opposite (hungry for captures and checks vs development and the
// centre), then prints the before/after traits and the two Classement orders built from them.
// Deterministic: fixed search depth, a budget the search never reaches, and no random numbers anywhere.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
if (process.env.GROWTH_HOUSE_PLAN === "0") globalThis.HQ_CARRY = false;
const P = require("../assets/hq-playground.js").pure;
console.log("plan de la maison : " + (process.env.GROWTH_HOUSE_PLAN === "0" ? "sans" : "avec"));

const DEPTH = 3;
const BUDGET = 600000;
const SERIES = 3;
const GAMES_PER_SERIES = 5;
const LEARNER_DEPTH = 2;
const PLY_CAP = 120;
const OPENING = ["e2", "e4"];
const TRAITS = ["bold", "material", "center", "develop"];

// Two learners, both playing their own game through the page's engine and book: the only deliberate difference is the
// sister opposite them and the way she plays. One faces an all-out attacker, the other a material-hungry positional
// player.
const CARD = [
  { learner: "culinia", opponent: "forgia", against: "aggressive" },
  // Pistonia used to face Inventoria through the fixture's own positional shortcut, which made the rival far weaker
  // than the engine she is: fifteen wins out of fifteen, nothing left to win, and a yardstick that could only sit at
  // the ceiling. She now faces the same sister playing her own game, at the same depth, so the series has headroom to
  // measure growth against.
  { learner: "pistonia", opponent: "inventoria", against: "engine" },
];

function engineMove(key, pos, history, opponentKey, depth = DEPTH) {
  const prefs = P.duel.prefsFor(key);
  const tuned = P.duel.tune(key, opponentKey);
  const style = { opening: prefs.opening, risk: prefs.risk, convert: prefs.convert, reply: prefs.reply };
  return P.bestMove(pos, depth, BUDGET, P.styleOf(key), history, tuned.tune, P.growth.base(key), tuned.shift, {
    style, ply: history.length, first: history[0] && history[0].move, deepPlan: P.duel.deepPlanFor(key, history),
  });
}

const PIECE_VALUE = { p: 1, n: 2, b: 2, r: 3, q: 4, k: 0 };
const fileOf = (square) => square & 7;
const rankOf = (square) => square >> 3;
const backRank = (color) => (color === "w" ? 7 : 0);

// Aggressive: Forgia's own game, engine and book — her temperament is the forcing one, and the page plays her exactly
// this way. Kept as a named policy so the two pairings read the same in the log.
function aggressiveMove(pos, history, key, opponentKey) {
  return engineMove(key, pos, history, opponentKey);
}

// Positional materialist: take everything that is takeable, hold the centre, develop when there is nothing to take. The
// shortlist keeps her sound enough to be a real opponent rather than a piñata.
function positionalMove(pos, history, key, opponentKey) {
  const engine = engineMove(key, pos, history, opponentKey);
  if (!engine) return null;
  const scored = P.legalMoves(pos).map((move) => {
    const target = pos.board[move.to];
    const piece = (pos.board[move.from] || "").toLowerCase();
    const central = (fileOf(move.to) === 3 || fileOf(move.to) === 4) && (rankOf(move.to) === 3 || rankOf(move.to) === 4) ? 1 : 0;
    const develop = (piece === "n" || piece === "b") && rankOf(move.from) === backRank(pos.turn) ? 1 : 0;
    const worth = target ? 10 + (PIECE_VALUE[(target || "").toLowerCase()] || 0) : 0;
    return { move, score: worth * 6 + central * 4 + develop * 3, keep: -P.evaluate(P.applyMove(pos, move)) };
  });
  const shortlist = scored.concat([{ move: engine, score: 0, keep: 0 }]).sort((a, b) => b.keep - a.keep).slice(0, 4);
  shortlist.sort((a, b) => b.score - a.score || a.move.from - b.move.from || a.move.to - b.move.to);
  return shortlist[0].move;
}

function playDuel(learner, opponent, against, index) {
  P.duel.commitBook(learner);
  P.duel.commitBook(opponent);
  const learnerIsWhite = index % 2 === 0;
  let pos = P.parseFen(P.START_FEN);
  const history = [];
  // Same first move every game so both learners meet the same opening; the first white move belongs to the opponent
  // when she has white, and to the learner otherwise (her own book drives it).
  const firstWhite = learnerIsWhite ? learner : opponent;
  let status = P.gameStatus(pos);
  let plies = 0;
  while (plies < PLY_CAP) {
    status = P.settleDraw(P.gameStatus(pos), history, pos);
    if (status.over) break;
    const key = pos.turn === "w" ? (learnerIsWhite ? learner : opponent) : (learnerIsWhite ? opponent : learner);
    let move;
    if (history.length === 0) {
      const want = P.legalMoves(pos).find((m) => m.from === P.sq(OPENING[0]) && m.to === P.sq(OPENING[1]));
      move = want || engineMove(key, pos, history, key === learner ? opponent : learner);
    } else if (key === opponent) {
      move = against === "aggressive"
        ? aggressiveMove(pos, history, key, learner)
        : (against === "positional"
          ? positionalMove(pos, history, key, learner) || engineMove(key, pos, history, learner)
          : engineMove(key, pos, history, learner));
    } else {
      // The learner plays her own game, engine and book, exactly as the page runs a duel — one shelf shallower, so the
      // sister opposite her is the one who gets to show what she does with the position. That is what she learns from.
      move = engineMove(key, pos, history, opponent, LEARNER_DEPTH);
    }
    if (!move) break;
    const before = pos;
    pos = P.applyMove(pos, move);
    history.push({ pos: before, move, color: before.turn, by: key, captured: !!before.board[move.to] });
    plies += 1;
  }
  const finalStatus = P.settleDraw(P.gameStatus(pos), history, pos);
  const winner = finalStatus.over ? (finalStatus.winner || "") : "";
  const players = learnerIsWhite ? { w: learner, b: opponent } : { w: opponent, b: learner };
  const gameId = "g" + (1794900000000 + index * 1000);
  P.growth.learnFromGame(history, players, winner, gameId);
  P.duel.noteDuel(players.w, players.b, winner, P.gameStatus(pos), history.length, gameId);
  return {
    winner, plies, firstWhite,
    signature: P.growth.signatureOf(opponent, history),
    learnerSignature: P.growth.signatureOf(learner, history),
  };
}

const num = (value) => Number(value).toFixed(3);
const deltas = (key, base) => {
  const traits = P.growth.traitsFor(key);
  return TRAITS.reduce((rows, trait) => rows.concat({ trait, base: base[trait], now: traits[trait], delta: traits[trait] - base[trait] }), []);
};

const before = {};
for (const entry of CARD) {
  before[entry.learner] = P.growth.base(entry.learner);
  before[entry.opponent] = P.growth.base(entry.opponent);
}
console.log("Départ — traits de naissance :");
for (const entry of CARD) {
  console.log("  " + entry.learner.padEnd(9) + TRAITS.map((trait) => trait + " " + num(before[entry.learner][trait])).join("  "));
}
console.log("");

let index = 0;
// Three series over the same pairing and the same first move. One series shows a lesson landing; a series repeated
// shows whether the lesson changed her results, which is the only thing "growth" can honestly mean here. The learner
// keeps the one-shelf handicap of the proof above, so the sister opposite her has something to teach.
const driftOf = (key) => {
  const traits = P.growth.traitsFor(key);
  const base = P.growth.base(key);
  return TRAITS.reduce((sum, trait) => sum + Math.abs(traits[trait] - base[trait]), 0);
};
const lessonsOf = (key) => {
  const book = P.duel.bookFor(key);
  return book && book.learn ? Object.keys(book.learn).length : 0;
};
// A yardstick that does not learn: the same games against the same sister, played with no lesson written on either
// side, and with the sister herself restored to her state before the series, so the only thing that can move between
// the two measurements is the learner. The neutral sister is Musica, who never faces the learners in the series; the
// frozen sister is the one the learner actually studied, which is where a learned plan can show up.
const BENCH = "musica";
// One opening per colour would make every game in a colour identical, and a board would be two games reported twelve
// times. The yardstick rotates through her repertoire instead, so the mean is over different games and the spread is
// the games' own.
const BENCH_OPENINGS = [["e2", "e4"], ["d2", "d4"], ["g1", "f3"], ["c2", "c4"], ["d2", "d3"], ["b1", "c3"], ["b2", "b3"], ["g2", "g3"]];
// One opponent at one depth makes a board two deterministic games reported many times: the result came out the same for
// every opening, because the colour decided it. Each board therefore mixes two variants of the same sister — her own
// engine at depth three and at depth four — with the opening rotating, so the games are genuinely different and the
// spread belongs to the games instead of to the colour.
const BENCH_VARIANTS = [3, 4];
const BENCH_GAMES = Number(process.env.GROWTH_BENCH_GAMES || 16);

function playBenchmarkGame(learner, rival, learnerIsWhite, against, opening, rivalDepth) {
  let pos = P.parseFen(P.START_FEN);
  const history = [];
  let plies = 0;
  let status = P.settleDraw(P.gameStatus(pos), history, pos);
  while (plies < PLY_CAP) {
    status = P.settleDraw(P.gameStatus(pos), history, pos);
    if (status.over) break;
    const key = pos.turn === "w" ? (learnerIsWhite ? learner : rival) : (learnerIsWhite ? rival : learner);
    const opponent = key === learner ? rival : learner;
    const forced = history.length === 0 && opening
      ? P.legalMoves(pos).find((m) => m.from === P.sq(opening[0]) && m.to === P.sq(opening[1]))
      : null;
    // The parenthesis matters: without it `forced || key === learner ? a : b` parses as `(forced || key === learner)`,
    // the forced opening was never played, and every game of a board was literally the same game.
    const move = forced || (key === learner
      ? engineMove(key, pos, history, opponent, LEARNER_DEPTH)
      : (against === "aggressive"
        ? aggressiveMove(pos, history, key, learner)
        : (against === "positional"
          ? positionalMove(pos, history, key, learner) || engineMove(key, pos, history, learner)
          : engineMove(key, pos, history, learner, rivalDepth))));
    if (!move) break;
    const before = pos;
    pos = P.applyMove(pos, move);
    history.push({ pos: before, move, color: before.turn, by: key, captured: !!before.board[move.to] });
    plies += 1;
  }
  const final = P.settleDraw(P.gameStatus(pos), history, pos);
  if (!final.over || !final.winner) return 0.5;
  return final.winner === (learnerIsWhite ? "w" : "b") ? 1 : 0;
}

// Score and its own sampling error: the games are the sample, and the standard error is what a margin has to beat.
function benchmark(learner, rival, against, games) {
  const scores = [];
  const total = games || BENCH_GAMES;
  for (let game = 0; game < total; game += 1) {
    const variant = BENCH_VARIANTS[Math.floor(game / 2) % BENCH_VARIANTS.length];
    const opening = BENCH_OPENINGS[Math.floor(game / 4) % BENCH_OPENINGS.length];
    scores.push(playBenchmarkGame(learner, rival, game % 2 === 0, against, opening, variant));
  }
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const spread = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, scores.length - 1);
  const distinct = new Set(scores).size;
  return { mean, sd: Math.sqrt(spread / scores.length), scores, distinct };
}

const frozenRival = {};
for (const entry of CARD) frozenRival[entry.learner] = JSON.parse(JSON.stringify(P.growth.read()[entry.opponent] || {}));
const benchmarkBefore = {};
const targetedBefore = {};
for (const entry of CARD) {
  benchmarkBefore[entry.learner] = benchmark(entry.learner, BENCH, "engine");
  const rival = JSON.parse(JSON.stringify(frozenRival[entry.learner]));
  targetedBefore[entry.learner] = benchmark(entry.learner, entry.opponent, entry.against);
  P.growth.read()[entry.opponent] = rival;
}
console.log("Étalon avant les séries — " + BENCH_GAMES + " parties, aucune leçon écrite :");
for (const entry of CARD) {
  console.log("  " + entry.learner.padEnd(9) + " contre " + BENCH.padEnd(10) + " score " + num(benchmarkBefore[entry.learner].mean)
    + " (n=" + BENCH_GAMES + ", écart-type " + num(benchmarkBefore[entry.learner].sd) + ", issues " + benchmarkBefore[entry.learner].distinct + ") " + benchmarkBefore[entry.learner].scores.join("·"));
  console.log("  " + entry.learner.padEnd(9) + " contre " + entry.opponent.padEnd(10) + " score " + num(targetedBefore[entry.learner].mean)
    + " (écart-type " + num(targetedBefore[entry.learner].sd) + ") " + targetedBefore[entry.learner].scores.join("·"));
}
console.log("");

const seriesLog = [];
for (const entry of CARD) {
  const signatures = [];
  const learnerSignatures = [];
  seriesLog.push({ learner: entry.learner, opponent: entry.opponent, against: entry.against, rows: [] });
  for (let series = 1; series <= SERIES; series += 1) {
    let points = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    for (let game = 0; game < GAMES_PER_SERIES; game += 1) {
      index += 1;
      const played = playDuel(entry.learner, entry.opponent, entry.against, index);
      if (played.signature) signatures.push(played.signature);
      if (played.learnerSignature) learnerSignatures.push(played.learnerSignature);
      const learnerIsWhite = played.firstWhite === entry.learner;
      if (!played.winner) { draws += 1; points += 0.5; }
      else if (played.winner === (learnerIsWhite ? "w" : "b")) { wins += 1; points += 1; }
      else { losses += 1; }
      const outcome = !played.winner ? "nulle" : (played.winner === (learnerIsWhite ? "w" : "b") ? "victoire de l'apprenante" : "défaite de l'apprenante");
      console.log("S" + series + " Partie " + String(index).padStart(2) + " " + entry.learner.padEnd(9) + " vs " + entry.opponent.padEnd(9)
        + " (" + entry.against + ") " + outcome + " · " + played.plies + " plies · apprenante " + (learnerIsWhite ? "blancs" : "noirs"));
    }
    const traits = P.growth.traitsFor(entry.learner);
    const rate = points / GAMES_PER_SERIES;
    seriesLog[seriesLog.length - 1].rows.push({ series: series, rate: rate, drift: driftOf(entry.learner), lessons: lessonsOf(entry.learner) });
    console.log("  série " + series + " · score " + num(rate) + " (" + wins + "v " + draws + "n " + losses + "d)"
      + " · " + TRAITS.map((trait) => trait + " " + num(traits[trait])).join("  ")
      + " · écart " + num(seriesLog[seriesLog.length - 1].rows[series - 1].drift) + " · leçons " + seriesLog[seriesLog.length - 1].rows[series - 1].lessons);
  }
  const meanOf = (list, trait) => list.reduce((sum, sig) => sum + sig[trait], 0) / list.length;
  console.log("  signature réelle de " + entry.opponent + " : " + TRAITS.map((trait) => trait + " " + num(meanOf(signatures, trait))).join("  "));
  console.log("  signature de " + entry.learner + " dans ces parties : " + TRAITS.map((trait) => trait + " " + num(meanOf(learnerSignatures, trait))).join("  "));
}

console.log("");
console.log("Croissance sur les séries (série 1 → série " + SERIES + ") :");
for (const row of seriesLog) {
  const first = row.rows[0];
  const last = row.rows[row.rows.length - 1];
  console.log("  " + row.learner.padEnd(9) + " score " + num(first.rate) + " → " + num(last.rate)
    + " · écart " + num(first.drift) + " → " + num(last.drift) + " · leçons " + first.lessons + " → " + last.lessons);
}

const AUDIT_ONLY = process.env.GROWTH_AUDIT === "1";
if (!AUDIT_ONLY) {
console.log("");
console.log("Étalon après les séries — mêmes " + BENCH_GAMES + " parties, sœur opposée remise dans son état d'avant :");
for (const entry of CARD) {
  const rival = JSON.parse(JSON.stringify(frozenRival[entry.learner]));
  const neutral = benchmark(entry.learner, BENCH, "engine");
  P.growth.read()[entry.opponent] = rival;
  const targeted = benchmark(entry.learner, entry.opponent, entry.against);
  P.growth.read()[entry.opponent] = rival;
  const moved = neutral.mean - benchmarkBefore[entry.learner].mean;
  const target = targeted.mean - targetedBefore[entry.learner].mean;
  console.log("  " + entry.learner.padEnd(9) + " contre " + BENCH.padEnd(10) + " score " + num(benchmarkBefore[entry.learner].mean) + " → " + num(neutral.mean)
    + " (" + (moved >= 0 ? "+" : "") + num(moved) + " · n=" + BENCH_GAMES + " · écart-type " + num(neutral.sd) + " · issues " + neutral.distinct + ") " + neutral.scores.join("·"));
  console.log("  " + entry.learner.padEnd(9) + " contre " + entry.opponent.padEnd(10) + " score " + num(targetedBefore[entry.learner].mean) + " → " + num(targeted.mean)
    + " (" + (target >= 0 ? "+" : "") + num(target) + " · n=" + BENCH_GAMES + " · écart-type " + num(targeted.sd) + " · issues " + targeted.distinct + ") " + targeted.scores.join("·"));
}
}

// What the learning actually did to her moves: the plan is removed from the same position and the search re-run, and
// the book's answer at move two is compared with the one she was born with. A lesson that never changes a move is a
// line in a panel, not learning.
// The proof, on her own stored state: replay the opening of one fresh game (nothing is written), then re-search her
// own positions with the learned plan removed. A plan that changes no move is decoration; a book slot whose answer
// differs from the one she was born with is a first move she would not otherwise have made.
function learningProof(learner, opponent) {
  const book = P.duel.bookFor(learner);
  const black = (book && book.black) || {};
  const slot = "e4";
  const held = black[slot];
  const nameOf = (entry) => (entry && entry.name) || "—";
  const lesson = black.changed && black.changed[slot];
  // Three fresh games, both colours, every position she actually had after the opening. A plan that only ever
  // decided one move in seventy is still a plan that decides moves; two games would have missed it.
  const shots = [];
  for (let game = 0; game < 3; game += 1) {
    const learnerIsWhite = game % 2 === 0;
    let pos = P.parseFen(P.START_FEN);
    const history = [];
    let plies = 0;
    while (plies < PLY_CAP) {
      if (P.settleDraw(P.gameStatus(pos), history, pos).over) break;
      const key = pos.turn === "w" ? (learnerIsWhite ? learner : opponent) : (learnerIsWhite ? opponent : learner);
      const other = key === learner ? opponent : learner;
      const move = engineMove(key, pos, history, other, key === learner ? LEARNER_DEPTH : DEPTH);
      if (!move) break;
      if (key === learner && history.length >= 4) shots.push({ pos, history: history.slice(), other });
      const before = pos;
      pos = P.applyMove(pos, move);
      history.push({ pos: before, move, color: before.turn, by: key, captured: !!before.board[move.to] });
      plies += 1;
    }
  }
  let changed = 0;
  for (const shot of shots) {
    const prefs = P.duel.prefsFor(learner);
    const tuned = P.duel.tune(learner, shot.other);
    const style = { opening: prefs.opening, risk: prefs.risk, convert: prefs.convert, reply: prefs.reply };
    const args = [shot.pos, LEARNER_DEPTH, BUDGET, P.styleOf(learner), shot.history, tuned.tune, P.growth.base(learner)];
    const opts = { style, ply: shot.history.length, first: shot.history[0] && shot.history[0].move, deepPlan: P.duel.deepPlanFor(learner, shot.history) };
    const withPlan = P.bestMove(...args, tuned.shift, opts);
    const withoutPlan = P.bestMove(...args, { bold: 0, material: 0, center: 0, develop: 0 }, opts);
    if (withPlan && withoutPlan && (withPlan.from !== withoutPlan.from || withPlan.to !== withoutPlan.to)) changed += 1;
  }
  const shifts = P.duel.tune(learner, opponent).shift;
  const planText = ["bold", "material", "center", "develop"]
    .map((trait) => trait[0] + (Number(shifts[trait]) >= 0 ? "+" : "") + Number(shifts[trait]).toFixed(3)).join(" ");
  const cell = black.learn && black.learn[slot];
  const tally = cell && cell.tally && black.map ? cell.tally[black.map[slot]] : null;
  const record = tally ? " · record " + tally.wins + "v/" + tally.draws + "n/" + tally.losses + "d" : "";
  const bookNote = lesson
    ? "livre : " + (black[lesson.from] ? black[lesson.from].name : lesson.from) + " → " + (black[lesson.to] ? black[lesson.to].name : lesson.to) + " (appris)" + record
    : "livre : réponse de naissance tenue" + record;
  // What the gate lets through to a sister she has never played: the carried traits, named, or nothing at all.
  const unseen = P.duel.tune(learner, BENCH);
  const carry = ((unseen.plan && unseen.plan.notes) || []).filter((note) => note.indexOf("appris ailleurs") >= 0);
  const carried = carry.length ? carry[0] : "rien (porte fermée)";
  return { learner, plan: planText, changed, tested: shots.length, answer: nameOf(held), bookNote, carried };
}
const planProbe = [];
for (const entry of CARD) planProbe.push(learningProof(entry.learner, entry.opponent));
console.log("");
console.log("Chemin appris → coup joué :");
for (const row of planProbe) {
  console.log("  " + row.learner.padEnd(9) + " plan appris " + row.plan + " · coups changés par le plan " + row.changed + "/" + row.tested
    + " · réponse au 1.e4 " + row.answer + " · " + row.bookNote + " · portée vers " + BENCH + " : " + row.carried);
}

console.log("");
console.log("Après la série — traits stockés contre les traits de naissance :");
const after = {};
for (const entry of CARD) {
  after[entry.learner] = deltas(entry.learner, before[entry.learner]);
  console.log("  " + entry.learner + " (" + (SERIES * GAMES_PER_SERIES) + " duels contre " + entry.opponent + " " + entry.against + ")");
  for (const row of after[entry.learner]) {
    console.log("    " + row.trait.padEnd(9) + num(row.base) + " → " + num(row.now) + "  (" + (row.delta >= 0 ? "+" : "") + num(row.delta) + ")");
  }
}

console.log("");
console.log("Classement de progression (P.growth.progress) :");
P.growth.progress().forEach((row) => {
  console.log("  " + String(row.position).padStart(2) + "  " + row.name.padEnd(12)
    + (row.stored
      ? "écart " + num(row.drift) + " · trait " + (row.traitName ? row.traitName + (row.up ? " ↑" : " ↓") : "—") + " · " + row.games + " partie" + (row.games > 1 ? "s" : "")
      : "—"));
});

console.log("");
console.log("Classement aux points (P.growth.ranking) :");
P.growth.ranking().forEach((row) => {
  console.log("  " + String(row.position).padStart(2) + "  " + row.name.padEnd(12) + (row.stored ? row.wins + "–" + row.draws + "–" + row.losses + " · " + row.points + " pts · " + row.habitName : "—"));
});

const moveOf = (key, trait) => after[key].find((row) => row.trait === trait).delta;
console.log("");

// The gate's verdict, checked against the board instead of asserted, in its own short pass: the state is the one
// the series left, so `GROWTH_AUDIT=1` re-runs the series and then only this.
if (AUDIT_ONLY) {
// The gate's verdict, checked against the board instead of asserted. A trait the gate opens is carried alone and the
// board is played with and without it, so the reader sees whether that direction helps her against the sister she has
// never met. A trait it shuts changes no shift at all, so its board cannot move — that is verified as an identity
// rather than paid for in games, and printed as such.
const AUDIT_GAMES = 4;
function carriedMean(learner, trait) {
  const state = P.growth.read()[learner] || {};
  const plans = state.plans && typeof state.plans === "object" ? state.plans : {};
  const names = Object.keys(plans).filter((name) => plans[name] && typeof plans[name] === "object");
  if (!names.length) return 0;
  let total = 0;
  for (const name of names) total += Number(plans[name][trait]) || 0;
  return total / names.length;
}
function gateRows(learner) {
  const base = P.growth.base(learner);
  const mine = P.growth.traitsFor(learner);
  return ["bold", "material", "center", "develop"].map((trait) => {
    const mean = carriedMean(learner, trait);
    const learned = (Number(mine[trait]) || 1) - (Number(base[trait]) || 1);
    const open = Math.abs(mean) >= 0.005 && Math.abs(learned) >= 0.01 && (mean > 0) === (learned > 0);
    return { trait: trait, open: open, mean: mean, learned: learned };
  });
}
function auditBoard(learner, rival, against) {
  const savedCarry = globalThis.HQ_CARRY;
  const savedOnly = globalThis.HQ_CARRY_ONLY;
  const rows = gateRows(learner);
  const opened = rows.filter((row) => row.open);
  let reference = null;
  for (const row of rows) {
    if (!row.open) {
      // The shift she plays with is the same object whether this trait is carried or not: nothing can move.
      globalThis.HQ_CARRY = false;
      globalThis.HQ_CARRY_ONLY = null;
      const off = P.duel.tune(learner, rival).shift;
      globalThis.HQ_CARRY = true;
      globalThis.HQ_CARRY_ONLY = null;
      const on = P.duel.tune(learner, rival).shift;
      row.same = ["bold", "material", "center", "develop"].every((trait) => off[trait] === on[trait]);
      continue;
    }
    if (!reference) {
      globalThis.HQ_CARRY = false;
      globalThis.HQ_CARRY_ONLY = null;
      reference = benchmark(learner, rival, against, AUDIT_GAMES);
    }
    globalThis.HQ_CARRY = true;
    globalThis.HQ_CARRY_ONLY = row.trait;
    const carried = benchmark(learner, rival, against, AUDIT_GAMES);
    row.reference = reference.mean;
    row.carried = carried.mean;
    row.delta = carried.mean - reference.mean;
  }
  globalThis.HQ_CARRY = savedCarry;
  globalThis.HQ_CARRY_ONLY = savedOnly;
  return { rows: rows, reference: reference };
}
console.log("Lecture : mordant " + num(moveOf("culinia", "bold")) + " (face à l'attaquante) contre "
  + num(moveOf("pistonia", "bold")) + " (face à la matérialiste) · matériel "
  + num(moveOf("culinia", "material")) + " contre " + num(moveOf("pistonia", "material")));


console.log("");
console.log("Porte trait par trait — le trait ouvert porté seul, " + AUDIT_GAMES + " parties par cellule :");
for (const entry of CARD) {
  for (const board of [{ rival: "musica", against: "engine" }, { rival: entry.opponent, against: entry.against }]) {
    const audit = auditBoard(entry.learner, board.rival, board.against);
    console.log("  " + entry.learner + " contre " + board.rival + (board.against === "engine" ? " (engine)" : " (" + board.against + ")"));
    for (const row of audit.rows) {
      const head = "    " + row.trait.padEnd(9) + (row.open ? "ouverte" : "fermée ");
      const why = " · moyenne " + (row.mean >= 0 ? "+" : "") + num(row.mean) + " · dérive " + (row.learned >= 0 ? "+" : "") + num(row.learned);
      if (row.open) {
        console.log(head + why + " · " + num(row.reference) + " → " + num(row.carried)
          + " (" + (row.delta >= 0 ? "+" : "") + num(row.delta) + ")");
      } else {
        console.log(head + why + (row.same ? " · plan inchangé (aucun effet possible)" : " · plan modifié"));
      }
    }
  }
}
}
