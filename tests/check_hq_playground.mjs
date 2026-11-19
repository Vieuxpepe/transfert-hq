// Playground chess rules (assets/hq-playground.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../assets/hq-playground.js").pure;

function playUci(pos, moves) {
  for (const text of moves) {
    const from = P.sq(text.slice(0, 2));
    const to = P.sq(text.slice(2, 4));
    const move = P.legalMoves(pos).find((m) => m.from === from && m.to === to);
    assert.ok(move, "coup légal attendu : " + text);
    pos = P.applyMove(pos, move);
  }
  return pos;
}

function perft(pos, depth) {
  if (depth === 0) return 1;
  let count = 0;
  for (const move of P.legalMoves(pos)) count += perft(P.applyMove(pos, move), depth - 1);
  return count;
}

assert.equal(P.sq("a8"), 0);
assert.equal(P.sq("h1"), 63);
assert.equal(P.nameOf(52), "e2");
assert.equal(P.sq("z9"), -1);

const start = P.parseFen(P.START_FEN);
assert.equal(P.legalMoves(start).length, 20, "20 coups au départ");
assert.equal(perft(start, 2), 400, "perft 2");
assert.equal(perft(start, 3), 8902, "perft 3 : la génération couvre roques, prises et clouages");
assert.equal(P.attacked(start.board, P.sq("e4"), "w"), false);
assert.equal(P.attacked(start.board, P.sq("e3"), "w"), true, "pions blancs sur e3");

// Mat du berger
const scholar = playUci(start, ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]);
const scholarStatus = P.gameStatus(scholar);
assert.equal(scholarStatus.over, true);
assert.equal(scholarStatus.reason, "checkmate");
assert.equal(scholarStatus.winner, "w");

// Mat du lion (fool's mate)
const fool = playUci(start, ["f2f3", "e7e5", "g2g4", "d8h4"]);
const foolStatus = P.gameStatus(fool);
assert.equal(foolStatus.reason, "checkmate");
assert.equal(foolStatus.winner, "b");

// Rois, roques et tours
const castleFen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
const castleMoves = P.legalMoves(P.parseFen(castleFen));
const kingside = castleMoves.find((m) => m.from === 60 && m.to === 62);
const queenside = castleMoves.find((m) => m.from === 60 && m.to === 58);
assert.ok(kingside && queenside, "les deux roques sont proposés");
const castled = P.applyMove(P.parseFen(castleFen), kingside);
assert.equal(castled.board[62], "K");
assert.equal(castled.board[61], "R");
assert.equal(castled.board[63], "");
assert.equal(castled.castling.K, false);
assert.equal(castled.castling.Q, false);
assert.equal(castled.castling.k, true, "les droits noirs restent");

// Une tour qui bouge retire le droit de ce côté
const rookMoved = playUci(P.parseFen(castleFen), ["a1a2"]);
assert.equal(rookMoved.castling.Q, false);
assert.equal(rookMoved.castling.K, true);

// Roque interdit à travers une case attaquée
const blocked = P.parseFen("4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1");
assert.ok(!P.legalMoves(blocked).some((m) => m.from === 60 && m.to === 62), "f1 attaquée : pas de petit roque");

// Prise en passant
const ep = playUci(start, ["e2e4", "a7a6", "e4e5", "d7d5"]);
const epMove = P.legalMoves(ep).find((m) => m.from === P.sq("e5") && m.to === P.sq("d6"));
assert.ok(epMove, "la prise en passant est proposée");
const afterEp = P.applyMove(ep, epMove);
assert.equal(afterEp.board[P.sq("d5")], "", "le pion noir de d5 disparaît");
assert.equal(afterEp.board[P.sq("d6")], "P");

// Promotion automatique en dame
const promoPos = P.parseFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
const promoMove = P.legalMoves(promoPos).find((m) => m.from === P.sq("a7") && m.to === P.sq("a8"));
assert.equal(promoMove.promo, "q");
assert.equal(P.applyMove(promoPos, promoMove).board[P.sq("a8")], "Q");

// Pat
const stale = P.gameStatus(P.parseFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"));
assert.equal(stale.over, true);
assert.equal(stale.reason, "stalemate");
assert.equal(stale.winner, "");

// L'assistante prend la dame offerte et ne renvoie que des coups légaux
const hanging = P.parseFen("7k/8/8/3q4/4Q3/8/8/4K3 w - - 0 1");
const choice = P.bestMove(hanging, 3);
assert.ok(choice);
assert.equal(choice.from, P.sq("e4"));
assert.equal(choice.to, P.sq("d5"), "la dame noire est prise");
for (let i = 0; i < 25; i += 1) {
  const reply = P.bestMove(start, 1);
  assert.ok(P.legalMoves(start).some((m) => m.from === reply.from && m.to === reply.to), "coup de l'assistante légal");
}

// Le budget de recherche borne le temps passé sur le fil principal
const slowStart = performance.now();
const budgetReply = P.bestMove(P.parseFen(P.START_FEN), 3, 120);
const budgetMs = performance.now() - slowStart;
assert.ok(budgetReply, "un coup est toujours rendu");
assert.ok(budgetMs < 800, "la recherche respecte son budget (" + Math.round(budgetMs) + " ms)");
assert.ok(P.legalMoves(P.parseFen(P.START_FEN)).some((m) => m.from === budgetReply.from && m.to === budgetReply.to), "coup légal même sous budget");

// L'évaluation est relative au trait
assert.equal(P.evaluate(P.parseFen(P.START_FEN)), 0);

// La surface ne construit rien avec des chaînes HTML et n'appelle pas le réseau
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../assets/hq-playground.js", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|fetch\(|new Function/.test(src), "pas de HTML depuis des chaînes, pas de réseau");
assert.ok(/ArrowUp|ArrowLeft/.test(src) && /aria-live/.test(src), "le clavier et les annonces font partie de la surface");
// --- adaptation : le journal des duels apprend, et la leçon change les coups ---
const log = [
  { w: "else", b: "securia", win: "securia", end: "checkmate", plies: 42, at: 1 },
  { w: "securia", b: "else", win: "securia", end: "repetition", plies: 30, at: 2 },
  { w: "else", b: "securia", win: "else", end: "checkmate", plies: 55, at: 3 },
  { w: "culinia", b: "pistonia", win: "pistonia", end: "checkmate", plies: 28, at: 4 },
  { w: "pistonia", b: "culinia", win: "pistonia", end: "checkmate", plies: 31, at: 5 },
  { w: "pistonia", b: "culinia", win: "culinia", end: "fifty", plies: 90, at: 6 },
];

const met = P.duel.meetingTally(log, "else", "securia");
assert.equal(met.games, 3, "trois rencontres lues dans le journal");
assert.equal(met.wins, 1);
assert.equal(met.losses, 2);
assert.equal(met.draws, 0);
assert.equal(met.matesAgainst, 1, "une défaite par mat est comptée comme telle");
assert.equal(met.avgPlies, 42, "la longueur moyenne des parties est lue dans le journal");
assert.equal(met.streak, 0, "sa dernière rencontre est une victoire");

const beaten = P.duel.planFor("else", "securia", log);
assert.equal(beaten.source, "directe");
assert.ok(beaten.shift.bold < 0, "deux défaites : elle resserre son jeu");
assert.ok(beaten.shift.material > 0, "… et garde le matériel");
assert.ok(beaten.notes.length >= 1 && /défaites/.test(beaten.notes[0]), "le réglage se justifie par le journal");

const streakLog = [
  { w: "else", b: "securia", win: "securia", end: "checkmate", plies: 40, at: 1 },
  { w: "securia", b: "else", win: "securia", end: "checkmate", plies: 36, at: 2 },
];
assert.ok(P.duel.planFor("else", "securia", streakLog).shift.bold <= -0.08, "deux défaites de suite serrent d'autant plus");

// Une rivale seulement regardée : la lecture existe sans rencontre directe, et diffère d'une inconnue.
const watched = P.duel.planFor("else", "culinia", log);
assert.equal(watched.source, "vue", "Culinia n'a jamais joué Else : elle l'a regardée");
assert.ok(watched.shift.bold < 0, "ce qu'elle a vu la rend prudente");
const stranger = P.duel.planFor("else", "musica", log);
assert.equal(stranger.source, "", "Musica n'apparaît nulle part : aucune lecture");
assert.deepEqual(stranger.shift, { bold: 0, material: 0, center: 0, develop: 0 }, "une inconnue ne change rien à son jeu");
assert.equal(P.duel.readFor("else", "musica", log).kind, "");
assert.notEqual(P.duel.readFor("else", "culinia", log).line, P.duel.readFor("else", "musica", log).line, "vue et inconnue ne se lisent pas pareil");
assert.ok(/parties vues/.test(P.duel.readFor("else", "culinia", log).plan.notes.join(" ")));

// Deux sœurs, deux profils : même journal, natures différentes, phrases différentes.
const profileElse = P.duel.profileOf("else", log);
const profileCulinia = P.duel.profileOf("culinia", log);
assert.equal(profileElse.games, 3);
assert.notDeepEqual(profileElse.words, profileCulinia.words, "les profils divergent après une série de duels");
assert.ok(profileElse.opening !== profileCulinia.opening || profileElse.risk !== profileCulinia.risk, "les tendances chiffrées diffèrent aussi");
const reloaded = JSON.parse(JSON.stringify(log));
assert.deepEqual(P.duel.profileOf("else", reloaded), profileElse, "le profil se relit depuis le journal stocké");

// Et la leçon entre dans les coups : une position fixe, un choix différent avec le plan.
const frozen = Math.random;
Math.random = () => 0.37;
try {
  const plainTune = P.growth.base("else");
  const planned = P.duel.tune("else", "securia", streakLog);
  assert.ok(planned.plan.notes.length, "le plan est bien celui du journal");
  assert.ok(planned.shift.bold < 0, "la recherche joue avec un mordant réduit");
  assert.deepEqual(planned.tune, plainTune, "le plan ne déforme pas les traits acquis");
  assert.deepEqual(P.duel.tune("else", "musica", streakLog).shift, { bold: 0, material: 0, center: 0, develop: 0 }, "sans lecture, aucun décalage");
  const fens = [
    P.START_FEN,
    "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "7k/8/8/3q4/4Q3/8/8/4K3 w - - 0 1",
    "r4rk1/ppp2ppp/2n1b3/3q4/3P4/2N1PN2/PP3PPP/R2QR1K1 w - - 0 12",
    "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
  ];
  let diverged = 0;
  for (const fen of fens) {
    const pos = P.parseFen(fen);
    const before = P.bestMove(pos, 2, 60000, "solid", [], plainTune, P.growth.base("else"));
    const after = P.bestMove(pos, 2, 60000, "solid", [], planned.tune, P.growth.base("else"), planned.shift);
    if (before.from !== after.from || before.to !== after.to) diverged += 1;
  }
  assert.ok(diverged > 0, "le plan du journal change réellement des coups (" + diverged + "/" + fens.length + ")");

  // Et dans des positions de vraie partie, pas seulement des diagrammes choisis.
  let board = P.parseFen(P.START_FEN);
  const played = [];
  const selfFens = [];
  for (let i = 0; i < 24; i += 1) {
    const move = P.bestMove(board, 2, 60000, "solid", played, plainTune, P.growth.base("else"));
    if (!move) break;
    played.push({ pos: board, move: move });
    board = P.applyMove(board, move);
    if (P.gameStatus(board).over) break;
    selfFens.push(board);
  }
  let real = 0;
  for (const pos of selfFens) {
    const before = P.bestMove(pos, 2, 60000, "solid", [], plainTune, P.growth.base("else"));
    const after = P.bestMove(pos, 2, 60000, "solid", [], planned.tune, P.growth.base("else"), planned.shift);
    if (before.from !== after.from || before.to !== after.to) real += 1;
  }
  assert.ok(real > 0, "le plan change aussi des coups en partie (" + real + "/" + selfFens.length + ")");
} finally {
  Math.random = frozen;
}

// --- le style appris change réellement le jeu : deux profils différents, des coups différents ---
const styleShy = { opening: 0.15, risk: 0.15, convert: 0.15 };
const styleBold = { opening: 0.9, risk: 0.9, convert: 0.9 };
const frozenStyle = Math.random;
Math.random = () => 0.37;
try {
  const tune = P.growth.base("else");
  const anchor = P.growth.base("else");
  let board = P.parseFen(P.START_FEN);
  const played = [];
  const fens = [];
  for (let i = 0; i < 24; i += 1) {
    const move = P.bestMove(board, 2, 60000, "solid", played, tune, anchor);
    if (!move) break;
    played.push({ pos: board, move: move });
    board = P.applyMove(board, move);
    if (P.gameStatus(board).over) break;
    fens.push(board);
  }
  let different = 0;
  for (const pos of fens) {
    const shy = P.bestMove(pos, 2, 60000, "solid", [], tune, anchor, null, { style: styleShy, ply: 4 });
    const bold = P.bestMove(pos, 2, 60000, "solid", [], tune, anchor, null, { style: styleBold, ply: 4 });
    if (shy.from !== bold.from || shy.to !== bold.to) different += 1;
  }
  assert.ok(different > 0, "deux styles appris jouent des coups différents (" + different + "/" + fens.length + ")");
} finally {
  Math.random = frozenStyle;
}

// --- l'ouverture apprise se voit dès le premier coup ---
const frozenOpening = Math.random;
Math.random = () => 0.37;
try {
  const base = P.growth.base("else");
  const startBoard = P.parseFen(P.START_FEN);
  const firstMove = (opening) => {
    const move = P.bestMove(startBoard, 3, 60000, "solid", [], base, base, null, { style: { opening: opening, risk: 0.5, convert: 0.5 }, ply: 0 });
    return P.nameOf(move.from) + P.nameOf(move.to);
  };
  const shy = firstMove(0.15);
  const bold = firstMove(0.85);
  assert.notEqual(shy, bold, "deux ouvertures apprises commencent par des coups différents (" + shy + " / " + bold + ")");
  const develops = /^[b-g]1[c-f]3$/.test(bold);
  const central = /^[de]2[de]4$/.test(bold);
  assert.ok(develops || central, "une ouverture haute sort une pièce ou avance un pion central (" + bold + ")");
  assert.ok(!/^[b-g]1[c-f]3$/.test(shy), "une ouverture basse ne sort pas de pièce au premier coup (" + shy + ")");
} finally {
  Math.random = frozenOpening;
}

// --- apprendre de l'autre : comparée à son propre jeu, pas à une moyenne ---
const growthStart = P.parseFen(P.START_FEN);
const stepMove = (pos, from, to, by) => {
  const move = { from: P.sq(from), to: P.sq(to) };
  const entry = { pos: pos, move: move, by: by, color: P.colorOf(pos.board[move.from]) };
  return { entry: entry, next: P.applyMove(pos, move) };
};
const g1 = stepMove(growthStart, "e2", "e4", "else");
const g2 = stepMove(g1.next, "h7", "h6", "pistonia");
const g3 = stepMove(g2.next, "g1", "f3", "else");
const g4 = stepMove(g3.next, "h6", "h5", "pistonia");
const g5 = stepMove(g4.next, "d2", "d4", "else");
const g6 = stepMove(g5.next, "a7", "a6", "pistonia");
const centralGame = [g1.entry, g2.entry, g3.entry, g4.entry, g5.entry, g6.entry];
P.growth.read().else = { games: 4, wins: 2, losses: 1, draws: 1, traits: P.growth.base("else"), style: null };
P.growth.read().pistonia = { games: 4, wins: 1, losses: 2, draws: 1, traits: P.growth.base("pistonia"), style: null };
P.growth.learnFromGame(centralGame, { w: "else", b: "pistonia" }, "w");
const learnedPistonia = P.growth.read().pistonia.traits;
const learnedElse = P.growth.read().else.traits;
assert.ok(learnedPistonia.center > P.growth.base("pistonia").center, "elle prend le centre qu'elle a vu jouer");
// La gagnante garde le jeu qui a gagné : son penchant central est renforcé, elle ne redescend plus vers celui qui a perdu.
// C'est la sélection par le résultat — sinon les deux se rejoignent au milieu et la maison finit dans un seul style.
assert.ok(learnedElse.center >= P.growth.base("else").center, "celle qui a gagné en jouant le centre garde son centre");
assert.ok(learnedPistonia.center <= P.growth.base("pistonia").center + 0.12 + 1e-9, "le emprunt reste dans sa bande");
assert.ok(learnedElse.center >= P.growth.base("else").center - 0.12 - 1e-9, "et l'autre ne perd pas son identité");
assert.ok(Math.abs(learnedElse.center - learnedPistonia.center) > 0.05, "elles ne deviennent pas la même joueuse");
for (let i = 0; i < 20; i += 1) P.growth.learnFromGame(centralGame, { w: "else", b: "pistonia" }, "w");
assert.ok(P.growth.read().pistonia.traits.center <= P.growth.base("pistonia").center + 0.12 + 1e-9, "vingt parties ne sortent pas de la bande");
assert.ok(P.growth.read().else.traits.center >= P.growth.base("else").center - 0.12 - 1e-9, "même après vingt parties");
assert.ok(Math.abs(P.growth.read().else.traits.center - P.growth.read().pistonia.traits.center) > 0.05, "et restent distinguables après vingt parties");

// --- une sœur qui n'a joué que les noirs a quand même un taux ---
// Ses parties vivent dans les cellules de répliques, une par ouverture affrontée : le tableau les compte au lieu de
// lui coller un tiret au motif que son ouverture aux blancs n'a jamais servi.
const blackOnly = "musica";
const replyStart = P.parseFen(P.START_FEN);
const replyOne = stepMove(replyStart, "e2", "e4", "else");
const replyTwo = stepMove(replyOne.next, "e7", "e5", blackOnly);
const replyGame = [replyOne.entry, replyTwo.entry];
P.growth.read()[blackOnly] = { games: 1, wins: 0, losses: 1, draws: 0, traits: P.growth.base(blackOnly), style: null };
P.duel.commitBook(blackOnly);
P.growth.learnFromGame(replyGame, { w: "else", b: blackOnly }, "w");
const blackOnlyRow = P.growth.board().find((row) => row.key === blackOnly);
assert.ok(blackOnlyRow && blackOnlyRow.blackPlayed > 0, "ses parties aux noirs sont comptées");
assert.equal(blackOnlyRow.whitePlayed, 0, "aucune partie comptée aux blancs");
assert.ok(blackOnlyRow.rate !== null, "elle a un taux, pas un tiret");
assert.equal(blackOnlyRow.basis, "avec ses répliques", "le taux dit d'où il vient");

// --- et elle est classée sur ses vrais chiffres, pas parquée en bas ---
// Une sœur qui n'a joué que les noirs et gagne doit passer devant une sœur qui n'a joué que les blancs et perd, et
// jamais derrière une sœur sans partie terminée. L'ordre doit aussi être le même d'un rendu à l'autre.
const blackStrong = blackOnly;
P.growth.learnFromGame(replyGame, { w: "else", b: blackStrong }, "b");   // une victoire aux noirs de plus
const whiteWeak = "securia";
P.growth.read()[whiteWeak] = { games: 1, wins: 0, losses: 1, draws: 0, traits: P.growth.base(whiteWeak), style: null };
P.duel.commitBook(whiteWeak);
// Elle joue son ouverture aux blancs telle qu'elle l'a engagée, et perd : c'est cette partie-là qui doit compter.
const whiteHabit = P.duel.prefsFor(whiteWeak).habit;
const whiteOne = stepMove(P.parseFen(P.START_FEN), whiteHabit.from, whiteHabit.to, whiteWeak);
const whiteTwo = stepMove(whiteOne.next, "e7", "e5", "else");
P.growth.learnFromGame([whiteOne.entry, whiteTwo.entry], { w: whiteWeak, b: "else" }, "b");
const noGame = "transferania";
P.growth.read()[noGame] = { games: 0, wins: 0, losses: 0, draws: 0, traits: P.growth.base(noGame), style: null };
const boardOrder = P.growth.board();
const placeOf = (key) => boardOrder.findIndex((row) => row.key === key);
const strongRow = boardOrder.find((row) => row.key === blackStrong);
const weakRow = boardOrder.find((row) => row.key === whiteWeak);
assert.ok(strongRow.blackPlayed >= 2 && strongRow.whitePlayed === 0, "elle n'a que des parties aux noirs");
assert.ok(strongRow.rate !== null && weakRow.rate !== null, "les deux sœurs ont un taux mesuré");
assert.ok(strongRow.rate > weakRow.rate, "elle gagne là où l'autre perd");
assert.ok(placeOf(blackStrong) < placeOf(whiteWeak), "elle passe devant la sœur qui n'a joué que les blancs et perd");
assert.ok(placeOf(blackStrong) < placeOf(noGame), "et jamais derrière une sœur sans partie terminée");
assert.equal(boardOrder.find((row) => row.key === noGame).rate, null, "la sœur sans partie garde un tiret");
assert.deepEqual(P.growth.board().map((row) => row.key), boardOrder.map((row) => row.key), "l'ordre ne bouge pas d'un rendu à l'autre");

// --- le vote suit ce qu'elle a appris, et le hasard n'a plus voix au chapitre ---
const voteStart = P.parseFen(P.START_FEN);
const voteHistory = [];
let votePos = voteStart;
for (const text of ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"]) {
  const from = P.sq(text.slice(0, 2));
  const to = P.sq(text.slice(2, 4));
  const move = P.legalMoves(votePos).find((m) => m.from === from && m.to === to);
  voteHistory.push({ pos: votePos, move: move, by: votePos.turn === "w" ? "else" : "pistonia", color: votePos.turn });
  votePos = P.applyMove(votePos, move);
}
const seedRandom = Math.random;
Math.random = () => 0.04;
const plainPick = P.bestMove(votePos, 2, 60000, null, voteHistory, P.growth.base("else"), P.growth.base("else"), null, null);
Math.random = () => 0.96;
const otherPick = P.bestMove(votePos, 2, 60000, null, voteHistory, P.growth.base("else"), P.growth.base("else"), null, null);
Math.random = seedRandom;
assert.deepEqual(plainPick, otherPick, "le hasard ne choisit plus son coup");
const learnedTune = Object.assign({}, P.growth.base("else"), { center: P.growth.base("else").center + 0.05 });
const learnedPick = P.bestMove(votePos, 2, 60000, null, voteHistory, learnedTune, P.growth.base("else"), null, null);
const learnedFile = learnedPick.to & 7;
const learnedRank = learnedPick.to >> 3;
assert.ok((learnedFile === 3 || learnedFile === 4) && (learnedRank === 3 || learnedRank === 4), "un petit gain de goût du centre se voit dans le coup joué");
assert.notDeepEqual(learnedPick, plainPick, "elle ne rejoue pas le même coup qu'avant d'apprendre");

// --- une ouverture nommée, tirée du style, et réellement jouée au premier coup ---
const habit = P.duel.habitOf;
assert.equal(habit(0.9, 0.7).name, "1.e4", "une ouverture franche commence par e4");
assert.equal(habit(0.9, 0.2).name, "1.d4", "une ouverture haute mais posée commence par d4");
assert.equal(habit(0.55, 0.5).name, "1.Cf3");
assert.equal(habit(0.4, 0.7).name, "1.c4");
assert.equal(habit(0.2, 0.9).name, "1.d3", "une ouverture prudente commence par d3");
const frozenHabit = Math.random;
Math.random = () => 0.37;
try {
  const base = P.growth.base("else");
  const startBoard = P.parseFen(P.START_FEN);
  const played = (opening, risk) => {
    const book = habit(opening, risk);
    const move = P.bestMove(startBoard, 3, 60000, "solid", [], base, base, null, { style: { opening: opening, risk: risk, convert: 0.5, habit: book }, ply: 0 });
    return P.nameOf(move.from) + P.nameOf(move.to);
  };
  assert.equal(played(0.9, 0.7), "e2e4", "e4 est joué, pas seulement annoncé");
  assert.equal(played(0.9, 0.2), "d2d4", "d4 aussi");
  assert.equal(played(0.2, 0.9), "d2d3", "et d3 pour une prudente");
} finally {
  Math.random = frozenHabit;
}

// --- la réplique aux noirs : nommée, tirée du style, et elle répond au premier coup blanc ---
const reply = P.duel.replyOf;
assert.equal(reply(0.5, 0.9, "e4").name, "1…c5", "un risque haut répond par le flanc à 1.e4");
assert.equal(reply(0.5, 0.9, "d4").name, "1…Cf6", "…et par le cavalier à 1.d4");
assert.equal(reply(0.9, 0.3, "e4").name, "1…e5");
assert.equal(reply(0.9, 0.3, "d4").name, "1…d5");
assert.equal(reply(0.5, 0.5, "e4").name, "1…c6", "une ouverture moyenne prépare la Caro-Kann");
assert.equal(reply(0.5, 0.5, "d4").name, "1…e6");
assert.equal(reply(0.2, 0.3, "e4").name, "1…d5", "une prudente répond d5");
assert.equal(reply(0.2, 0.3, "c4").name, "1…e5");
assert.equal(reply(0.2, 0.3, "inconnu").name, "1…d5", "un premier coup hors livre reçoit la réponse par défaut");
// Deux styles appris, dans la même humeur, ne rendent plus la même réponse : le penchant accumulé (centre + audace)
// choisit l'alternative nommée, donc une dérive de quelques centièmes se voit dans le livre noir.
const replyBase = { bold: 0.9, material: 1, center: 1, develop: 1 };
const leanCentral = P.duel.replyPlan(0.45, 0.35, { bold: 0.95, material: 1.03, center: 1.05, develop: 1 }, replyBase);
const leanFlexible = P.duel.replyPlan(0.45, 0.35, { bold: 0.87, material: 0.97, center: 0.99, develop: 1 }, replyBase);
assert.equal(leanCentral.family, leanFlexible.family, "même humeur");
assert.equal(leanCentral.d4.name, "1…d5", "un penchant central répond au centre");
assert.equal(leanFlexible.d4.name, "1…e6", "un penchant souple prépare");
assert.notEqual(leanCentral.e4.name, leanFlexible.e4.name, "deux styles distincts, deux réponses distinctes");
assert.equal(P.duel.replyPlan(0.45, 0.35).d4.name, "1…e6", "sans apprentissage, la préférence de l'humeur");

const sharpPlan = P.duel.replyPlan(0.5, 0.9);
assert.equal(P.duel.replyTo(sharpPlan, { from: P.sq("d2"), to: P.sq("d4") }).name, "1…Cf6", "le plan répond au vrai coup blanc");
assert.equal(P.duel.replyTo(sharpPlan, null).name, "1…c5");

const frozenReply = Math.random;
Math.random = () => 0.37;
try {
  const base = P.growth.base("securia");
  const startBoard = P.parseFen(P.START_FEN);
  const opening = (from, to) => ({ from: P.sq(from), to: P.sq(to) });
  const after = (first) => P.applyMove(startBoard, P.legalMoves(startBoard).find((m) => m.from === first.from && m.to === first.to));
  const answer = P.duel.replyPlan(0.5, 0.9);
  const e4First = opening("e2", "e4");
  const againstE4 = P.bestMove(after(e4First), 3, 60000, "solid", [], base, base, null, { style: { reply: answer }, ply: 1, first: e4First });
  assert.equal(P.nameOf(againstE4.from) + P.nameOf(againstE4.to), "c7c5", "la réplique nommée contre 1.e4 est réellement jouée");
  const d4First = opening("d2", "d4");
  const againstD4 = P.bestMove(after(d4First), 3, 60000, "solid", [], base, base, null, { style: { reply: answer }, ply: 1, first: d4First });
  assert.equal(P.nameOf(againstD4.from) + P.nameOf(againstD4.to), "g8f6", "contre 1.d4, elle joue l'autre réponse nommée");
} finally {
  Math.random = frozenReply;
}

// Persistance : une habitude formée survit aux petits mouvements de style et ne change que si le style a vraiment bougé.
const book = P.duel.bookFor;
P.growth.read().securia = { games: 2, wins: 1, losses: 1, draws: 0, traits: P.growth.base("securia") };
P.duel.refineBook("securia", { opening: 0.9, risk: 0.7, convert: 0.5 });
assert.equal(P.growth.read().securia.book.white, "e4", "l'habitude est écrite dans le profil");
assert.equal(P.growth.read().securia.book.black.map.e4, "c5", "le livre noir range sa réponse par ouverture");
assert.equal(P.growth.read().securia.book.black.map.d4, "nf6");
assert.equal(P.growth.read().securia.book.black.family, "sharp");
const formed = P.duel.bookFor("securia", 0.9, 0.7);
assert.equal(formed.white.name, "1.e4");
assert.equal(formed.black.e4.name, "1…c5");
assert.equal(formed.black.d4.name, "1…Cf6");
assert.equal(formed.saved, true, "l'habitude vient du profil, pas d'un calcul");
P.duel.refineBook("securia", { opening: 0.88, risk: 0.71, convert: 0.5 });
assert.equal(P.growth.read().securia.book.white, "e4", "un petit dérive ne renomme pas son ouverture");
assert.equal(P.growth.read().securia.book.opening, 0.9, "le repère de l'habitude n'a pas bougé");
assert.equal(P.growth.read().securia.book.black.map.e4, "c5");
P.duel.refineBook("securia", { opening: 0.2, risk: 0.9, convert: 0.5 });
assert.equal(P.growth.read().securia.book.white, "d3", "un vrai changement de style la fait évoluer");
assert.equal(book("securia", 0.2, 0.9).white.name, "1.d3");

// Une habitude déjà là gagne sur le style courant : c'est son identité, pas un calcul du moment.
delete P.growth.read().securia.book;
P.growth.read().securia.style = { opening: 0.2, risk: 0.2, convert: 0.5, games: 2 };
P.duel.commitBook("securia");
assert.equal(P.growth.read().securia.book.white, "d3");
assert.equal(P.growth.read().securia.book.black.family, "solid");
assert.equal(P.growth.read().securia.book.black.map.e4, "d5");
const kept = book("securia", 0.95, 0.95);
assert.equal(kept.saved, true);
assert.equal(kept.white.name, "1.d3", "un style qui change ne réécrit pas une habitude acquise");
assert.equal(kept.black.e4.name, "1…d5");
assert.equal(kept.black.d4.name, "1…d5");
P.duel.commitBook("securia");
assert.equal(P.growth.read().securia.book.black.map.d4, "d5", "commettre deux fois ne change rien");

// --- le livre noir apprend des ouvertures qu'elle a vraiment affrontées ---
const e4Move = { from: P.sq("e2"), to: P.sq("e4") };
const d4Move = { from: P.sq("d2"), to: P.sq("d4") };
const d5Reply = { from: P.sq("d7"), to: P.sq("d5") };
const e5Reply = { from: P.sq("e7"), to: P.sq("e5") };

// Deux défaites de suite avec la même réponse, et elle change pour une autre réponse nommée du même style.
P.growth.read().securia = { games: 4, wins: 1, losses: 3, draws: 0, traits: P.growth.base("securia"), style: { opening: 0.2, risk: 0.2, convert: 0.5, games: 4 } };
delete P.growth.read().securia.book;
P.duel.commitBook("securia");
assert.equal(P.growth.read().securia.book.black.map.e4, "d5");
const firstLoss = P.duel.noteReplyOutcome("securia", e4Move, d5Reply, "l");
assert.equal(firstLoss.changed, false, "une seule défaite ne suffit pas");
assert.equal(P.growth.read().securia.book.black.map.e4, "d5");
const secondLoss = P.duel.noteReplyOutcome("securia", e4Move, d5Reply, "l");
assert.equal(secondLoss.changed, false, "deux parties avec cette réponse : ce n'est pas encore une preuve");
const thirdLoss = P.duel.noteReplyOutcome("securia", e4Move, d5Reply, "l");
assert.equal(thirdLoss.changed, true, "trois défaites de suite, elle change de réponse");
assert.equal(P.growth.read().securia.book.black.map.e4, "e5", "la réponse suivante du style remplace celle qui échoue");
assert.equal(P.growth.read().securia.book.black.map.d4, "d5", "l'ouverture jamais affrontée garde sa réponse");
assert.equal(P.growth.read().securia.book.black.learn.e4.losses, 3);
assert.equal(P.growth.read().securia.book.black.learn.e4.history.length, 3, "l'historique garde l'ouverture, la réponse et le résultat");
assert.deepEqual([P.growth.read().securia.book.black.learn.e4.history[0].answer, P.growth.read().securia.book.black.learn.e4.history[0].result], ["d5", "l"]);
assert.equal(P.growth.read().securia.book.black.changed.e4.from, "d5");
assert.equal(P.growth.read().securia.book.black.changed.e4.to, "e5");

// Une réponse qui gagne n'est pas chassée : elle reste, et l'historique explique pourquoi.
P.growth.read().forgia = { games: 2, wins: 2, losses: 0, draws: 0, traits: P.growth.base("forgia"), style: { opening: 0.2, risk: 0.2, convert: 0.5, games: 2 } };
delete P.growth.read().forgia.book;
P.duel.commitBook("forgia");
const winning = P.growth.read().forgia.book.black.map.e4;
P.duel.noteReplyOutcome("forgia", e4Move, d5Reply, "w");
P.duel.noteReplyOutcome("forgia", e4Move, d5Reply, "w");
assert.equal(P.growth.read().forgia.book.black.map.e4, winning, "une préférence qui gagne est gardée");
assert.equal(P.growth.read().forgia.book.black.learn.e4.wins, 2);
assert.ok(!P.growth.read().forgia.book.black.changed.e4, "aucun changement appris quand elle gagne");

// Deux répertoires différents donnent deux livres différents.
P.growth.read().musica = { games: 4, wins: 1, losses: 3, draws: 0, traits: P.growth.base("musica"), style: { opening: 0.2, risk: 0.2, convert: 0.5, games: 4 } };
delete P.growth.read().musica.book;
P.duel.commitBook("musica");
P.duel.noteReplyOutcome("musica", d4Move, d5Reply, "l");
P.duel.noteReplyOutcome("musica", d4Move, d5Reply, "l");
P.duel.noteReplyOutcome("musica", d4Move, d5Reply, "l");
assert.equal(P.growth.read().musica.book.black.map.d4, "e6", "elle change la réponse à l'ouverture qu'elle a vue perdre");
assert.equal(P.growth.read().musica.book.black.map.e4, "d5", "et laisse l'autre intacte");
assert.notEqual(P.growth.read().securia.book.black.map.e4, P.growth.read().musica.book.black.map.e4, "deux répertoires, deux livres");

// Le changement appris survit à l'évolution de style : la préférence est re-semée, pas ce que les parties ont appris.
P.duel.refineBook("securia", { opening: 0.9, risk: 0.7, convert: 0.5 });
assert.equal(P.growth.read().securia.book.black.family, "sharp", "sans leçon de famille, c'est encore le bandeau qui la nomme");
assert.equal(P.growth.read().securia.book.black.map.e4, "e5", "la réponse apprise reste");
assert.equal(P.growth.read().securia.book.black.pref.e4, "c5", "la préférence de style a suivi le nouveau style");
assert.equal(P.growth.read().securia.book.black.map.d4, "nf6", "une réponse jamais apprise suit la préférence");
assert.equal(P.growth.read().securia.book.black.learn.e4.losses, 3, "l'historique n'est pas effacé par un changement de style");
const roundTrip = JSON.parse(JSON.stringify(P.growth.read().securia.book));
assert.equal(roundTrip.black.map.e4, "e5");
assert.equal(roundTrip.black.learn.e4.history[0].answer, "d5");
assert.equal(roundTrip.black.changed.e4.to, "e5");

// --- les familles de répliques apprennent de leurs propres résultats ---
// Deux sœurs dans le même bandeau partent de la même famille et de la même table : ce sont leurs parties qui les
// séparent, pas leur humeur.
const sharpBand = { opening: 0.5, risk: 0.8, convert: 0.5, games: 4 };
for (const sister of ["culinia", "forgia"]) {
  P.growth.read()[sister] = { games: 4, wins: 1, losses: 3, draws: 0, traits: P.growth.base(sister), style: Object.assign({}, sharpBand) };
  delete P.growth.read()[sister].book;
  P.duel.commitBook(sister);
}
const blackOf = (sister) => P.growth.read()[sister].book.black;
assert.equal(blackOf("culinia").family, "sharp");
assert.equal(blackOf("forgia").family, "sharp", "même bandeau : la même famille au départ");
assert.equal(blackOf("culinia").map.d4, blackOf("forgia").map.d4, "et d'abord la même table de répliques");
const REPLY_MOVES = {
  e5: { from: P.sq("e7"), to: P.sq("e5") }, c5: { from: P.sq("c7"), to: P.sq("c5") },
  d5: { from: P.sq("d7"), to: P.sq("d5") }, nf6: { from: P.sq("g8"), to: P.sq("f6") },
  e6: { from: P.sq("e7"), to: P.sq("e6") }, c6: { from: P.sq("c7"), to: P.sq("c6") },
  g6: { from: P.sq("g7"), to: P.sq("g6") },
};
const playBlack = (sister, slot, result) => P.duel.noteReplyOutcome(
  sister, slot === "e4" ? e4Move : d4Move, REPLY_MOVES[blackOf(sister).map[slot]], result,
);
// Culinia perd quatre parties en répondant à deux ouvertures différentes ; Forgia gagne les mêmes.
for (let game = 0; game < 4; game += 1) {
  const slot = game % 2 ? "d4" : "e4";
  playBlack("culinia", slot, "l");
  playBlack("forgia", slot, "w");
}
assert.equal(blackOf("forgia").family, "sharp", "gagner garde sa famille");
assert.equal(blackOf("culinia").family, "classical", "une table qui perd sur deux ouvertures change de famille");
assert.notEqual(blackOf("culinia").map.d4, blackOf("forgia").map.d4, "deux sœurs du même bandeau ne partagent plus la même table");
assert.equal(blackOf("culinia").familyChanged.from, "sharp");
assert.equal(blackOf("culinia").familyChanged.to, "classical");
assert.equal(blackOf("culinia").pref.d4, "d5", "la préférence suit la nouvelle famille");
assert.equal(blackOf("culinia").learn.e4.games, 2, "l'historique par ouverture reste");
// Une seule ouverture ne juge pas une famille : Securia n'a jamais affronté que 1.e4.
assert.equal(blackOf("securia").family, "sharp", "une seule ouverture ne condamne pas la table");
assert.ok(!blackOf("securia").familyChanged.to, "aucune famille apprise sur un seul répertoire");
// Un passage de style ne ramène pas la famille du bandeau, ni les réponses apprises.
const learnedE4 = blackOf("culinia").map.e4;
P.duel.refineBook("culinia", { opening: 0.95, risk: 0.75, convert: 0.5 });
assert.equal(blackOf("culinia").family, "classical", "un passage de style ne rend pas la famille du bandeau");
assert.equal(blackOf("culinia").map.e4, learnedE4, "et ne jette pas les réponses apprises");
const culiniaRead = P.duel.prefsFor("culinia");
assert.equal(culiniaRead.reply.family, "classical", "la table lue est celle de sa famille apprise");
assert.equal(culiniaRead.replyFamily.to, "classical");
assert.ok(culiniaRead.replyFamily.games >= 3, "la leçon nomme son échantillon");

// --- la deuxième réponse dépend de la ligne, pas seulement du premier coup blanc ---
const lineStart = P.parseFen(P.START_FEN);
const play = (pos, from, to) => { const move = { from: P.sq(from), to: P.sq(to) }; return { pos, move, next: P.applyMove(pos, move) }; };
const line1 = play(lineStart, "e2", "e4");
const line2 = play(line1.next, "c7", "c5");
const line3 = play(line2.next, "g1", "f3");
const lineHistory = [
  { pos: line1.pos, move: line1.move, by: "else", color: "w" },
  { pos: line2.pos, move: line2.move, by: "forgia", color: "b" },
  { pos: line3.pos, move: line3.move, by: "else", color: "w" },
];
assert.equal(P.duel.deepPrefixOf(lineHistory), "e4|c5|nf3", "la ligne se nomme par les trois premiers demi-coups");
const e5 = play(line3.next, "e7", "e5");
const lineHistory4 = lineHistory.concat([{ pos: e5.pos, move: e5.move, by: "forgia", color: "b" }]);
assert.equal(P.duel.planOfMove(line3.next, e5.move), "center", "un pion central est une intention de centre");
assert.equal(P.duel.planOfMove(line3.next, { from: P.sq("b8"), to: P.sq("c6") }), "knight", "un cavalier est une intention de développement");
assert.equal(P.duel.planOfMove(line3.next, { from: P.sq("f8"), to: P.sq("g7") }), "bishop", "un fou est une intention de fou");
assert.equal(P.duel.planMatches("calm", line3.next, { from: P.sq("b8"), to: P.sq("c6") }), true, "consolider accepte un développement");
assert.equal(P.duel.planMatches("calm", line3.next, e5.move), false, "consolider refuse une poussée de pion");
assert.equal(P.duel.planMatches("calm", line3.next, { from: P.sq("d8"), to: P.sq("d6") }), false, "consolider refuse une sortie de dame");
assert.equal(P.duel.planOfMove(line3.next, { from: P.sq("d8"), to: P.sq("d6") }), "", "une sortie de dame n'est pas une intention nommée");
assert.equal(P.duel.seedDeepPlan("e4|c5|nf3", 0.5, 0.5), "knight", "après 2.Cf3 elle pense au cavalier");
assert.equal(P.duel.seedDeepPlan("e4|c5|d4", 0.5, 0.5), "center", "après 2.d4 elle dispute le centre");
assert.equal(P.duel.seedDeepPlan("e4|c5|nf3", 0.5, 0.9), "center", "une joueuse de risque frappe le centre");
assert.equal(P.duel.seedDeepPlan("e4|c5|nf3", 0.2, 0.2), "bishop", "derrière son 1…c5, une prudente pense au fou");
assert.notEqual(P.duel.seedDeepPlan("e4|c5|other", 0.5, 0.5), P.duel.seedDeepPlan("e4|e6|other", 0.5, 0.5), "sa propre première réponse change l'intention");

// Le moteur joue l'intention de la ligne : un cavalier dans 1.e4 1…c5 2.Cf3.
const deepBase = P.growth.base("pistonia");
const frozenDeep = Math.random;
Math.random = () => 0.41;
try {
  const second = P.bestMove(line3.next, 3, 60000, "solid", lineHistory, deepBase, deepBase, null, { style: { opening: 0.5, risk: 0.5, convert: 0.5 }, ply: 3, first: line1.move, deepPlan: "knight" });
  assert.equal((line3.next.board[second.from] || "").toLowerCase(), "n", "sa deuxième réponse est un cavalier quand la ligne le demande");
  const centred = P.bestMove(line3.next, 3, 60000, "solid", lineHistory, deepBase, deepBase, null, { style: { opening: 0.5, risk: 0.5, convert: 0.5 }, ply: 3, first: line1.move, deepPlan: "center" });
  assert.equal((line3.next.board[centred.from] || "").toLowerCase(), "p", "et un pion central quand c'est l'intention de la ligne");
} finally {
  Math.random = frozenDeep;
}

// Deux défaites avec la même intention : cette ligne change d'intention, et elle seule.
P.growth.read().forgia = { games: 2, wins: 1, losses: 1, draws: 0, traits: P.growth.base("forgia"), style: { opening: 0.2, risk: 0.9, convert: 0.5, games: 2 } };
delete P.growth.read().forgia.book;
P.duel.commitBook("forgia");
assert.deepEqual(P.growth.read().forgia.book.black.deep, {}, "le livre noir commence sans ligne apprise");
const deepFirstLoss = P.duel.noteDeepOutcome("forgia", lineHistory4, "l");
assert.equal(deepFirstLoss.changed, false, "une seule défaite ne change pas l'intention");
assert.equal(P.growth.read().forgia.book.black.deep["e4|c5|nf3"].plan, "center", "l'intention jouée devient celle de la ligne");
assert.equal(P.growth.read().forgia.book.black.deep["e4|c5|nf3"].learn.center.losses, 1);
const deepSecondLoss = P.duel.noteDeepOutcome("forgia", lineHistory4, "l");
assert.equal(deepSecondLoss.changed, false, "deux défaites ne suffisent pas quand l'échantillon est mince");
const deepThirdLoss = P.duel.noteDeepOutcome("forgia", lineHistory4, "l");
assert.equal(deepThirdLoss.changed, true, "trois défaites de suite, la ligne change d'intention");
assert.equal(P.growth.read().forgia.book.black.deep["e4|c5|nf3"].plan, "knight");
assert.equal(P.growth.read().forgia.book.black.deep["e4|c5|nf3"].changed.from, "center");
assert.equal(P.growth.read().forgia.book.black.deep["e4|c5|nf3"].changed.to, "knight");
assert.equal(P.growth.read().forgia.book.black.deep["d4|d5|nf3"], undefined, "une ligne jamais jouée ne reçoit rien");
assert.equal(P.growth.read().forgia.book.black.map.e4, "c5", "le livre du premier coup blanc n'est pas touché par la ligne");

// Une intention apprise survit au changement de style ; l'infobulle nomme la ligne.
P.duel.refineBook("forgia", { opening: 0.9, risk: 0.2, convert: 0.5 });
const refined = P.growth.read().forgia.book.black.deep["e4|c5|nf3"];
assert.equal(refined.plan, "knight", "une intention apprise reste après un changement de style");
assert.equal(refined.pref, "knight", "la préférence de cette ligne suit le nouveau style");
const deepRound = JSON.parse(JSON.stringify(P.growth.read().forgia.book.black.deep));
assert.equal(deepRound["e4|c5|nf3"].changed.to, "knight", "la ligne apprise survit à la sérialisation");
// Son intention de style couvre plusieurs pièces : un fou joué dans « consolide » reste consolider, pas une ligne apprise.
const solidF3 = play(lineStart, "g1", "f3");
const solidD5 = play(solidF3.next, "d7", "d5");
const solidNa3 = play(solidD5.next, "b1", "a3");
const solidBg4 = play(solidNa3.next, "c8", "g4");
const solidHistory = [
  { pos: solidF3.pos, move: solidF3.move, by: "else", color: "w" },
  { pos: solidD5.pos, move: solidD5.move, by: "culinia", color: "b" },
  { pos: solidNa3.pos, move: solidNa3.move, by: "else", color: "w" },
  { pos: solidBg4.pos, move: solidBg4.move, by: "culinia", color: "b" },
];
P.growth.read().culinia = { games: 3, wins: 1, losses: 2, draws: 0, traits: P.growth.base("culinia"), style: { opening: 0.2, risk: 0.2, convert: 0.5, games: 3 } };
delete P.growth.read().culinia.book;
P.duel.commitBook("culinia");
P.duel.noteDeepOutcome("culinia", solidHistory, "l");
const calmLine = P.growth.read().culinia.book.black.deep["nf3|d5|other"];
assert.equal(calmLine.plan, "calm", "un fou dans « consolide » ne renomme pas l'intention");
assert.equal(calmLine.pref, "calm");
assert.equal(calmLine.learn.calm.losses, 1, "le résultat est compté pour l'intention tenue");
assert.deepEqual(calmLine.changed, {}, "aucun changement appris sur une seule partie");
const detail = P.duel.replyDetail(P.duel.replyPlan(0.9, 0.2), null, P.growth.read().forgia.book.black.deep);
assert.ok(detail.indexOf("ligne : 1.e4 1…c5 2.Cf3 : développe un cavalier") >= 0, "l'infobulle nomme la ligne et son intention");

// Une sœur sans aucun profil : le premier duel écrit son livre dans une réserve en attente, sans lui inventer un
// profil à zéro partie. Un rechargement en pleine première partie retrouve donc la même ouverture, et la première
// leçon terminée fait entrer ce livre dans le profil qu'elle se crée.
const beforeFresh = P.growth.read();
delete beforeFresh.pistonia;
delete beforeFresh.transferania;
P.duel.commitBook("pistonia");
assert.equal(P.growth.read().pistonia, undefined, "aucun profil à zéro partie n'est créé");
const waiting = P.duel.pendingBook("pistonia");
assert.ok(waiting, "le livre attend hors de tout profil");
assert.equal(waiting.white, "d4", "son habitude de nature y est déjà écrite");
assert.equal(waiting.black.map.e4, "d5");
assert.equal(waiting.black.map.d4, "d5");
assert.equal(book("pistonia", 0.95, 0.95).saved, true, "c'est bien le livre en attente qui fait foi ensuite");
assert.equal(book("pistonia", 0.95, 0.95).white.name, "1.d4");
P.duel.commitBook("pistonia");
assert.equal(P.duel.pendingBook("pistonia").white, "d4", "commettre deux fois ne change rien");
const carried = JSON.parse(JSON.stringify(P.growth.read()));
assert.equal(carried.__books.pistonia.white, "d4", "le livre en attente survit à la sérialisation");
assert.equal(carried.__books.pistonia.black.map.e4, "d5");
assert.equal(carried.pistonia, undefined, "et la réserve ne crée toujours aucun profil");
// La première partie terminée lui donne un profil : le livre en attente y entre et la réserve se vide.
P.growth.read().pistonia = { games: 1, wins: 0, losses: 1, draws: 0, style: null, with: "transferania", vs: "transferania", traits: P.growth.base("pistonia") };
const adopted = P.duel.adoptPendingBook("pistonia", P.growth.read().pistonia);
assert.equal(adopted.white, "d4", "le livre rejoint le profil sans perdre son ouverture");
assert.equal(P.duel.pendingBook("pistonia"), null, "la réserve se vide une fois le livre adopté");
assert.equal(book("pistonia", 0.95, 0.95).saved, true);
assert.equal(book("pistonia", 0.95, 0.95).white.name, "1.d4");
assert.equal(JSON.parse(JSON.stringify(P.growth.read())).__books, undefined, "la réserve disparaît du stockage");

// --- son ouverture suit sa propre échelle quand son style a vraiment bougé ---
const elseBase = P.growth.base("else");
P.growth.read().else = { games: 4, wins: 2, losses: 1, draws: 1, style: { opening: 0.548, risk: 0.46, convert: 0.5, games: 4 }, with: "pistonia", vs: "pistonia", traits: elseBase };
P.duel.commitBook("else");
assert.equal(P.duel.bookFor("else", 0.548, 0.46).white.name, "1.Cf3", "elle part de son ouverture de naissance");
P.duel.refineBook("else", { opening: 0.54, risk: 0.44, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.54, 0.44).white.name, "1.Cf3", "une dérive trop petite ne change pas son ouverture");
P.duel.refineBook("else", { opening: 0.5, risk: 0.3, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.5, 0.3).white.name, "1.d4", "une vraie dérive la fait descendre d'un cran, vers le jeu qu'elle a affronté");
P.duel.refineBook("else", { opening: 0.54, risk: 0.36, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.54, 0.36).white.name, "1.d4", "revenir au bruit de son style ne lui rend pas son ancienne ouverture");
const pistoniaBase = P.growth.base("pistonia");
delete P.growth.read().pistonia;
P.growth.read().pistonia = { games: 4, wins: 1, losses: 2, draws: 1, style: { opening: 0.388, risk: 0.4, convert: 0.5, games: 4 }, with: "else", vs: "else", traits: pistoniaBase };
P.duel.commitBook("pistonia");
assert.equal(P.duel.bookFor("pistonia", 0.388, 0.4).white.name, "1.d4");
P.duel.refineBook("pistonia", { opening: 0.44, risk: 0.33, convert: 0.5 });
assert.equal(P.duel.bookFor("pistonia", 0.44, 0.33).white.name, "1.Cf3", "l'autre sœur monte d'un cran en s'ouvrant");
assert.notEqual(P.duel.bookFor("else", 0.5, 0.3).white.name, P.duel.bookFor("pistonia", 0.44, 0.33).white.name, "les deux restent distinctes");

// --- l'ouverture blanche apprend aussi de ses résultats ---
P.growth.read().else = { games: 4, wins: 0, losses: 4, draws: 0, style: { opening: 0.548, risk: 0.41, convert: 0.5, games: 4 }, with: "pistonia", vs: "pistonia", traits: P.growth.base("else") };
delete P.growth.read().else.book;
P.duel.commitBook("else");
assert.equal(P.duel.bookFor("else", 0.548, 0.41).white.name, "1.Cf3", "elle part de son ouverture");
const cf3 = { from: P.sq("g1"), to: P.sq("f3") };
const d4Open = { from: P.sq("d2"), to: P.sq("d4") };
const openFirstLoss = P.duel.noteOpeningOutcome("else", cf3, "l");
assert.equal(openFirstLoss.changed, false, "une défaite ne renomme pas son ouverture");
assert.equal(P.growth.read().else.book.white, "nf3");
const openSecondLoss = P.duel.noteOpeningOutcome("else", cf3, "l");
assert.equal(openSecondLoss.changed, false, "deux parties seulement : elle ne renomme pas encore son ouverture");
// Tant qu'elle a des défaites avec son ouverture, une dérive de style ne peut pas passer devant le verdict du plateau.
P.duel.refineBook("else", { opening: 0.62, risk: 0.5, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.62, 0.5).white.name, "1.Cf3", "le style ne remplace pas une ouverture qu'elle a perdue avant le verdict");
assert.equal(P.growth.read().else.book.opening, 0.548, "et le repère de dérive n'est pas remis à zéro");
assert.equal(P.growth.read().else.book.black.family, "classical", "ses réponses, elles, suivent déjà le nouveau style");
const openThirdLoss = P.duel.noteOpeningOutcome("else", cf3, "l");
assert.equal(openThirdLoss.changed, true, "trois défaites de suite la font changer");
assert.equal(P.growth.read().else.book.white, "d4", "elle descend d'un cran dans son propre répertoire");
assert.equal(P.growth.read().else.book.whiteChanged.from, "nf3");
assert.equal(P.duel.bookFor("else", 0.548, 0.41).white.name, "1.d4", "le livre la joue dès la partie suivante");
const cardLesson = P.duel.prefsFor("else").habitLesson;
assert.ok(cardLesson, "la carte nomme le changement d'ouverture venu des résultats");
assert.equal(cardLesson.from, "1.Cf3", "elle dit d'où elle vient");
assert.equal(cardLesson.to, "1.d4", "et où elle est");
assert.equal(cardLesson.losses, 2, "avec le nombre de défaites qui ont décidé");
assert.match(cardLesson.text, /1\.Cf3 → 1\.d4 · apprise après 2 défaites/, "la carte l'écrit en clair");
assert.deepEqual(P.growth.read().else.traits, P.growth.base("else"), "la leçon ne touche pas ses traits");
assert.equal(JSON.parse(JSON.stringify(P.growth.read())).else.book.white, "d4", "l'ouverture apprise survit à la sérialisation");
P.duel.refineBook("else", { opening: 0.548, risk: 0.41, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.548, 0.41).white.name, "1.d4", "son style inchangé ne défait pas la leçon");
// Une vraie dérive de style re-sème ses réponses mais ne lui rend pas l'ouverture qu'elle a perdue.
P.duel.refineBook("else", { opening: 0.62, risk: 0.5, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.62, 0.5).white.name, "1.d4", "une dérive de style ne défait pas l'ouverture apprise aux résultats");
assert.equal(P.growth.read().else.book.black.family, "classical", "la dérive re-sème quand même ses réponses");
assert.equal(P.growth.read().else.book.whiteChanged.to, "d4", "la trace de la leçon reste avec le livre");
assert.equal(P.growth.read().else.book.whiteLearn.nf3.history.length, 3, "l'échantillon appris survit au re-seed de style");
assert.equal(JSON.parse(JSON.stringify(P.growth.read().else.book)).whiteChanged.to, "d4", "et la leçon survit à la sérialisation");
P.duel.noteOpeningOutcome("else", d4Open, "l");
P.duel.noteOpeningOutcome("else", d4Open, "l");
P.duel.noteOpeningOutcome("else", d4Open, "l");
assert.equal(P.growth.read().else.book.white, "e4", "une deuxième ouverture qui perd aussi la fait monter d'un cran");
assert.equal(P.growth.read().else.book.whiteChanged.from, "d4", "la dernière leçon de résultats est la bonne");
P.duel.refineBook("else", { opening: 0.4, risk: 0.2, convert: 0.5 });
assert.equal(P.duel.bookFor("else", 0.4, 0.2).white.name, "1.e4", "la nouvelle ouverture apprise reste elle aussi à l'abri du style");
// Une victoire dans la foulée protège l'ouverture : la patience se juge sur les deux derniers résultats.
P.growth.read().else.book.white = "nf3";
P.growth.read().else.book.whiteLearn = {};
P.duel.noteOpeningOutcome("else", cf3, "l");
P.duel.noteOpeningOutcome("else", cf3, "w");
const guarded = P.duel.noteOpeningOutcome("else", cf3, "l");
assert.equal(guarded.changed, false, "une victoire récente protège son ouverture");
assert.equal(P.growth.read().else.book.white, "nf3");
// Le hasard n'a aucun rôle dans la décision.
const sealedRandom = Math.random;
Math.random = () => 0.99;
P.growth.read().else.book.white = "nf3";
P.growth.read().else.book.whiteLearn = {};
P.duel.noteOpeningOutcome("else", cf3, "l");
P.duel.noteOpeningOutcome("else", cf3, "l");
const third = P.duel.noteOpeningOutcome("else", cf3, "l");
Math.random = sealedRandom;
assert.equal(third.changed, true);
assert.equal(P.growth.read().else.book.white, "d4", "les résultats décident, pas le hasard");
assert.equal(P.duel.nextHabitKey(P.growth.read().else.book, "else"), "e4", "le cran suivant reste déterministe");
// Le seuil s'adapte à l'échantillon : aucune leçon avant trois parties avec la réponse, puis la moitié de ce qu'elle
// en a joué, entre deux et quatre défaites.
assert.equal(P.duel.patienceFor(1), Infinity, "une seule partie ne prouve rien");
assert.equal(P.duel.patienceFor(2), Infinity, "deux non plus : pas de réaction précoce");
assert.equal(P.duel.patienceFor(3), 2, "trois parties : deux défaites suffisent");
assert.equal(P.duel.patienceFor(6), 3, "six parties : il en faut trois");
assert.equal(P.duel.patienceFor(20), 4, "le plafond l'empêche de devenir impossible");
// Après le verdict du plateau (trois parties, aucune leçon), le style peut de nouveau parler : pas de gel.
P.growth.read().else.book.white = "nf3";
P.growth.read().else.book.opening = 0.548;
P.growth.read().else.book.risk = 0.41;
P.growth.read().else.book.whiteLearn = { nf3: { games: 3, wins: 0, losses: 2, draws: 1, history: [{ result: "l" }, { result: "l" }, { result: "d" }] } };
delete P.growth.read().else.book.whiteChanged;
P.duel.refineBook("else", { opening: 0.62, risk: 0.5, convert: 0.5 });
assert.notEqual(P.duel.bookFor("else", 0.62, 0.5).white.name, "1.Cf3", "après le verdict sans changement, une vraie dérive peut encore déplacer son ouverture");

// Chaque défaite d'une leçon pointe la partie du journal qui l'a causée : adversaire, rang et date, pas seulement
// un compte. Le journal est la donnée persistée (même forme que `hq_playground_duels`).
const journal = [
  { id: "g1", w: "else", b: "forgia", win: "forgia", at: 1763000000000, end: "checkmate", plies: 60 },
  { id: "g2", w: "else", b: "pistonia", win: "pistonia", at: 1763000600000, end: "checkmate", plies: 80 },
  { id: "g3", w: "else", b: "forgia", win: "forgia", at: 1763001200000, end: "checkmate", plies: 55 },
];
P.growth.read().else.book.white = "nf3";
P.growth.read().else.book.whiteLearn = {};
delete P.growth.read().else.book.whiteChanged;
P.duel.noteOpeningOutcome("else", cf3, "l", "forgia", "g1");
P.duel.noteOpeningOutcome("else", cf3, "l", "pistonia", "g2");
const named = P.duel.noteOpeningOutcome("else", cf3, "l", "forgia", "g3");
assert.equal(named.changed, true, "la troisième défaite change bien l'ouverture");
assert.deepEqual(P.growth.read().else.book.whiteChanged.defeats.map((entry) => entry.id), ["g2", "g3"], "les deux défaites du verdict gardent la référence de leur partie");
const namedLesson = P.duel.habitLessonText(P.growth.read().else.book.whiteChanged, journal);
assert.deepEqual(namedLesson.defeats.map((entry) => entry.name), ["Pistonia", "Forgia"], "les deux défaites du verdict sont nommées");
assert.match(namedLesson.title, /Pistonia \(partie n°2 · /, "la première défaité pointe la deuxième ligne du journal");
assert.match(namedLesson.title, /Forgia \(partie n°3 · /, "la seconde pointe la troisième, pas la première défaite contre Forgia");
assert.equal(namedLesson.text, "1.Cf3 → 1.d4 · apprise après 2 défaites", "la pastille reste courte");
// Deux défaites contre la même sœur restent deux parties distinctes, pas "2 fois".
const twiceLesson = P.duel.habitLessonText({ from: "nf3", to: "d4", losses: 2, defeats: [{ vs: "forgia", id: "g1" }, { vs: "forgia", id: "g3" }] }, journal);
assert.match(twiceLesson.title, /Forgia \(partie n°1 · /, "la première défaite contre Forgia pointe sa propre partie");
assert.match(twiceLesson.title, /Forgia \(partie n°3 · /, "la seconde aussi");
assert.doesNotMatch(twiceLesson.title, /fois/, "plus de comptage agrégé");
// Une partie jamais gardée le dit, sans emprunter le rang d'une autre.
const orphanLesson = P.duel.habitLessonText({ from: "nf3", to: "d4", losses: 1, defeats: [{ vs: "pistonia", id: "g999", at: 1763000000000 }] }, journal);
assert.match(orphanLesson.title, /Pistonia \(partie non enregistrée\)/, "une défaite sans partie persistée est annoncée comme telle");
// Les leçons écrites avant les références retrouvent leurs parties dans le journal, une ligne par défaite.
P.growth.read().else.book.whiteChanged = { from: "nf3", to: "d4", losses: 2, defeats: [{ vs: "forgia", at: 1763000000010 }, { vs: "pistonia", at: 1763000600010 }] };
P.growth.read().else.book.white = "d4";
assert.equal(P.duel.backfillLessonGames("else", journal), 2, "les deux défaites héritées retrouvent leur partie");
assert.deepEqual(P.growth.read().else.book.whiteChanged.defeats.map((entry) => entry.id), ["g1", "g2"], "et la leçon stockée garde les références");
const backfilledLesson = P.duel.habitLessonText(P.growth.read().else.book.whiteChanged, journal);
assert.match(backfilledLesson.title, /Forgia \(partie n°1 · /);
assert.match(backfilledLesson.title, /Pistonia \(partie n°2 · /);
assert.deepEqual(JSON.parse(JSON.stringify(P.growth.read().else.book)).whiteChanged.defeats.map((entry) => entry.id), ["g1", "g2"], "les références survivent à la sérialisation");

// Le classement de croissance lit le même état que les cartes : ouverture réellement jouée, taux avec cette ouverture,
// acquis (leçon + répliques remplacées + lignes apprises). Rien n'est calculé pour la table seule.
P.growth.read().else.games = 5;
P.growth.read().else.wins = 3;
P.growth.read().else.draws = 0;
P.growth.read().else.losses = 2;
P.growth.read().else.book.whiteLearn = { d4: { games: 4, wins: 3, losses: 1, draws: 0, history: [] } };
delete P.growth.read().transferania;
const board = P.growth.board();
assert.equal(board.length, 8, "les huit sœurs sont classées");
const elseRow = board.find((row) => row.key === "else");
assert.equal(elseRow.stored, true, "Else a un livre : sa ligne est remplie");
assert.equal(elseRow.habit, P.duel.prefsFor("else").habit.name, "l'ouverture affichée est celle du livre, pas une étiquette inventée");
assert.equal(elseRow.rate, 75, "le taux est celui de son ouverture préférée (3 victoires sur 4)");
assert.equal(elseRow.played, 4);
assert.equal(elseRow.won, 3);
assert.equal(elseRow.lessonText, "1.Cf3 → 1.d4 · apprise après 2 défaites", "la leçon affichée est celle de la carte");
assert.ok(elseRow.learned >= 1, "sa leçon compte dans les acquis");
assert.equal(elseRow.points, P.growth.read().else.wins * 3 + P.growth.read().else.draws, "les points restent ceux du classement V–N–D");
// Une sœur sans partie terminée : aucun style, aucun taux, aucun acquis inventés.
const emptyRow = board.find((row) => row.key === "transferania");
assert.equal(emptyRow.stored, false, "aucun livre : la ligne le dit");
assert.equal(emptyRow.habit, "", "aucune ouverture inventée");
assert.equal(emptyRow.reply, "", "aucune réplique inventée");
assert.equal(emptyRow.rate, null, "aucun taux inventé");
assert.equal(emptyRow.learned, 0, "aucun acquis inventé");
assert.equal(emptyRow.points, 0);
// Le classement ordonne d'abord sur les acquis, puis sur le taux : les points ne suffisent pas.
for (let i = 1; i < board.length; i += 1) {
  assert.ok(board[i - 1].learned >= board[i].learned, "les acquis décroissent d'une ligne à l'autre");
}
assert.ok(board[0].learned > board[board.length - 1].learned, "la première ligne a réellement appris plus que la dernière");

// Le classement se lit seul : ordre des points, ouverture réellement jouée, leçon apprise — et un tiret pour qui n'a
// pas encore fini de duel.
const ranking = P.growth.ranking();
assert.equal(ranking.length, 8, "les huit sœurs restent au classement");
assert.deepEqual(ranking.map((row) => row.position), [1, 2, 3, 4, 5, 6, 7, 8], "le classement numérote ses lignes");
for (let i = 1; i < ranking.length; i += 1) {
  assert.ok(ranking[i - 1].points >= ranking[i].points, "le classement garde l'ordre des points");
}
const rankedElse = ranking.find((row) => row.key === "else");
assert.equal(rankedElse.stored, true);
assert.equal(rankedElse.name, "Else");
assert.equal(rankedElse.habitName, P.duel.prefsFor("else").habit.name, "l'ouverture du classement est celle du livre");
assert.equal(rankedElse.lessonText, P.duel.prefsFor("else").habitLesson.text, "la leçon du classement est celle de la carte");
assert.equal(rankedElse.points, board.find((row) => row.key === "else").points, "les points sont les mêmes que sur la carte");
const rankedEmpty = ranking.find((row) => row.key === "transferania");
assert.equal(rankedEmpty.stored, false, "sans duel terminé, sa ligne reste vide");
assert.equal(rankedEmpty.habitName, "", "aucune ouverture inventée dans le classement");
assert.equal(rankedEmpty.lessonText, "", "aucune leçon inventée dans le classement");
assert.equal(rankedEmpty.points, 0);

// Le second classement range sur la croissance du style, pas sur les points : l'écart aux traits de naissance.
const progress = P.growth.progress();
assert.equal(progress.length, 8, "les huit sœurs sont mesurées");
assert.deepEqual(progress.map((row) => row.position), [1, 2, 3, 4, 5, 6, 7, 8]);
for (let i = 1; i < progress.length; i += 1) {
  assert.ok(progress[i - 1].drift >= progress[i].drift, "l'écart de style décroît d'une ligne à l'autre");
}
const grownElse = progress.find((row) => row.key === "else");
const baseElse = P.growth.base("else");
const traitsElse = P.growth.traitsFor("else");
const expectedDrift = ["bold", "material", "center", "develop"]
  .reduce((sum, trait) => sum + Math.abs(traitsElse[trait] - baseElse[trait]), 0);
assert.ok(grownElse.stored, "Else a joué : elle est mesurée");
assert.equal(grownElse.drift, Math.round(expectedDrift * 1000) / 1000, "l'écart est la somme des traits déplacés");
assert.equal(grownElse.games, P.growth.read().else.games);
// Une sœur dont les traits ont bougé donne la mesure : écart, trait et sens viennent des traits, pas des points.
const musicBase = P.growth.base("musica");
P.growth.read().musica = {
  games: 3, wins: 1, losses: 2, draws: 0,
  traits: Object.assign({}, musicBase, { bold: musicBase.bold + 0.1, develop: musicBase.develop - 0.05 }),
  style: { opening: 0.5, risk: 0.5, convert: 0.5, games: 3 },
};
const movedRows = P.growth.progress();
const movedMusic = movedRows.find((row) => row.key === "musica");
const musicDrift = ["bold", "material", "center", "develop"]
  .reduce((sum, trait) => sum + Math.abs(P.growth.traitsFor("musica")[trait] - musicBase[trait]), 0);
assert.equal(movedMusic.drift, Math.round(musicDrift * 1000) / 1000, "l'écart vient des traits stockés");
assert.equal(movedMusic.trait, "bold", "le trait le plus déplacé est nommé");
assert.equal(movedMusic.up, true);
assert.equal(movedMusic.traitName, "mordant");
assert.equal(movedRows[0].key, "musica", "la sœur qui a le plus bougé passe devant");
assert.equal(P.growth.ranking()[0].key, "else", "le classement aux points garde son propre ordre");
const measuredEmpty = progress.find((row) => row.key === "transferania");
assert.equal(measuredEmpty.stored, false, "sans partie, aucun écart inventé");
assert.equal(measuredEmpty.drift, 0);
assert.equal(measuredEmpty.traitName, "");
assert.equal(measuredEmpty.games, 0);

// Une partie qu'elle n'a pas commencée (le duel de fond) n'a aucun livre committé : l'échantillon doit quand même
// s'écrire depuis la fin de partie, contre l'ouverture qu'elle a réellement jouée, avec l'id de la ligne du journal.
delete P.growth.read().pistonia;
const bornPistonia = P.duel.prefsFor("pistonia").habit.key;
const firstSquares = { d3: ["d2", "d3"], d4: ["d2", "d4"], nf3: ["g1", "f3"], e4: ["e2", "e4"], c4: ["c2", "c4"] }[bornPistonia];
assert.ok(firstSquares, "une ouverture de départ connue pour Pistonia");
const bgStart = P.parseFen(P.START_FEN);
const bgFirst = P.legalMoves(bgStart).find((m) => m.from === P.sq(firstSquares[0]) && m.to === P.sq(firstSquares[1]));
const bgPos1 = P.applyMove(bgStart, bgFirst);
const bgReply = P.legalMoves(bgPos1).find((m) => m.from === P.sq("d7") && m.to === P.sq("d5")) || P.legalMoves(bgPos1)[0];
const bgPos2 = P.applyMove(bgPos1, bgReply);
const bgHistory = [
  { pos: bgStart, move: bgFirst, by: "pistonia", color: "w", actor: "them", captured: false },
  { pos: bgPos1, move: bgReply, by: "else", color: "b", actor: "them", captured: false },
];
P.growth.learnFromGame(bgHistory, { w: "pistonia", b: "else" }, "b", "g-bg-1");
const bgRecord = P.growth.read().pistonia;
assert.equal(bgRecord.book.white, bornPistonia, "l'ouverture notée est celle qu'elle a jouée");
const bgCell = bgRecord.book.whiteLearn[bornPistonia];
assert.equal(bgCell.games, 1, "une partie, un échantillon");
assert.equal(bgCell.losses, 1);
assert.equal(bgCell.history.length, 1, "un seul échantillon gardé");
assert.equal(bgCell.history[0].id, "g-bg-1", "l'échantillon porte l'id de la ligne du journal");
assert.equal(bgCell.history[0].vs, "else", "et l'adversaire de cette partie");
assert.equal(bgCell.history[0].result, "l");
assert.ok(!bgRecord.book.whiteChanged, "une seule partie ne fait toujours pas une leçon");

console.log("check_hq_playground: ok");
