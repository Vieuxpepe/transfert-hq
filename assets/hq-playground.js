/* Transfert HQ — Playground.
 *
 * Games played with the assistants. First board: chess against Else or Transferania, or a duel between the two
 * of them with their own thinking pauses and their own comments on each move.
 * Everything runs in the browser: no fetch, no API; saved games live in localStorage. The whole board is playable
 * from the keyboard (arrows move the cursor, Enter/Space picks and plays, Escape cancels, N/U/A/D/S for new game /
 * undo / other assistant / duel / save) and the move field accepts coordinate moves such as `e2e4` or `e7e8q`.
 * The same file exports its rules as `pure` for tests/check_hq_playground.mjs.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqPlayground = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FILES = "abcdefgh";
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const BISHOP = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ROOK = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const KING = BISHOP.concat(ROOK);
  const DIAGONAL = BISHOP.concat([[-1, 0], [1, 0], [0, -1], [0, 1]]);

  const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  // A mate outranks any material; subtracting the ply means the shorter mate is the better one.
  const MATE = 90000;
  // How far the capture search may run past the nominal depth, so a leaf is not judged in the middle of an exchange.
  const QUIESCE_DEPTH = 1;
  // The endgame term only speaks when the advantage is genuinely convertible: a bare-ish king facing a real lead.
  const BARE_KING = 500;
  const DECISIVE = 300;

  // Simplified positional tables, from White's point of view, index 0 = a8 (matches the board layout).
  const PST = {
    p: [0, 0, 0, 0, 0, 0, 0, 0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
      5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, -5, -10, 0, 0, -10, -5, 5,
      5, 10, 10, -20, -20, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0],
    n: [-50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50],
    b: [-20, -10, -10, -10, -10, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -20, -10, -10, -10, -10, -10, -10, -20],
    r: [0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, 10, 10, 10, 10, 5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      0, 0, 0, 5, 5, 0, 0, 0],
    q: [-20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20],
    k: [-30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      20, 20, 0, 0, 0, 0, 20, 20,
      20, 30, 10, 0, 0, 10, 30, 20],
  };

  // ------------------------------------------------------------------ rules

  function sq(name) {
    const m = /^([a-h])([1-8])$/.exec(String(name || ""));
    if (!m) return -1;
    return (8 - Number(m[2])) * 8 + FILES.indexOf(m[1]);
  }

  function nameOf(index) {
    return FILES[index & 7] + (8 - (index >> 3));
  }

  function colorOf(piece) {
    if (!piece) return "";
    return piece === piece.toUpperCase() ? "w" : "b";
  }

  function other(color) {
    return color === "w" ? "b" : "w";
  }

  function parseFen(fen) {
    const parts = String(fen || START_FEN).trim().split(/\s+/);
    const rows = (parts[0] || "").split("/");
    if (rows.length !== 8) throw new Error("FEN invalide");
    const board = new Array(64).fill("");
    rows.forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) {
          f += Number(ch);
        } else {
          if (!"pnbrqkPNBRQK".includes(ch) || f > 7) throw new Error("FEN invalide");
          board[r * 8 + f] = ch;
          f += 1;
        }
      }
      if (f !== 8) throw new Error("FEN invalide");
    });
    const rights = parts[2] || "-";
    return {
      board: board,
      turn: parts[1] === "b" ? "b" : "w",
      castling: { K: rights.includes("K"), Q: rights.includes("Q"), k: rights.includes("k"), q: rights.includes("q") },
      ep: parts[3] && parts[3] !== "-" ? sq(parts[3]) : null,
      half: Number(parts[4] || 0) || 0,
      full: Number(parts[5] || 1) || 1,
    };
  }

  function findKing(board, color) {
    const king = color === "w" ? "K" : "k";
    for (let i = 0; i < 64; i += 1) if (board[i] === king) return i;
    return -1;
  }

  function attacked(board, target, by) {
    if (target < 0) return false;
    const tr = target >> 3;
    const tf = target & 7;
    const pawnRow = tr + (by === "w" ? 1 : -1);
    for (const df of [-1, 1]) {
      const f = tf + df;
      if (pawnRow < 0 || pawnRow > 7 || f < 0 || f > 7) continue;
      const p = board[pawnRow * 8 + f];
      if (p && colorOf(p) === by && p.toLowerCase() === "p") return true;
    }
    for (const [dr, df] of KNIGHT) {
      const r = tr + dr;
      const f = tf + df;
      if (r < 0 || r > 7 || f < 0 || f > 7) continue;
      const p = board[r * 8 + f];
      if (p && colorOf(p) === by && p.toLowerCase() === "n") return true;
    }
    for (const [dr, df] of KING) {
      const r = tr + dr;
      const f = tf + df;
      if (r < 0 || r > 7 || f < 0 || f > 7) continue;
      const p = board[r * 8 + f];
      if (p && colorOf(p) === by && p.toLowerCase() === "k") return true;
    }
    for (const [dr, df] of DIAGONAL) {
      let r = tr + dr;
      let f = tf + df;
      const straight = dr === 0 || df === 0;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        const p = board[r * 8 + f];
        if (p) {
          const type = p.toLowerCase();
          if (colorOf(p) === by && (type === "q" || (straight ? type === "r" : type === "b"))) return true;
          break;
        }
        r += dr;
        f += df;
      }
    }
    return false;
  }

  function inCheck(pos, color) {
    return attacked(pos.board, findKing(pos.board, color), other(color));
  }

  function addCastles(pos, color, from, moves) {
    if (from !== (color === "w" ? 60 : 4)) return;
    const board = pos.board;
    const rook = color === "w" ? "R" : "r";
    const foe = other(color);
    const rights = pos.castling;
    if (color === "w") {
      if (rights.K && !board[61] && !board[62] && board[63] === rook
        && !attacked(board, 60, foe) && !attacked(board, 61, foe) && !attacked(board, 62, foe)) {
        moves.push({ from: from, to: 62, promo: "" });
      }
      if (rights.Q && !board[59] && !board[58] && !board[57] && board[56] === rook
        && !attacked(board, 60, foe) && !attacked(board, 59, foe) && !attacked(board, 58, foe)) {
        moves.push({ from: from, to: 58, promo: "" });
      }
    } else {
      if (rights.k && !board[5] && !board[6] && board[7] === rook
        && !attacked(board, 4, foe) && !attacked(board, 5, foe) && !attacked(board, 6, foe)) {
        moves.push({ from: from, to: 6, promo: "" });
      }
      if (rights.q && !board[3] && !board[2] && !board[1] && board[0] === rook
        && !attacked(board, 4, foe) && !attacked(board, 3, foe) && !attacked(board, 2, foe)) {
        moves.push({ from: from, to: 2, promo: "" });
      }
    }
  }

  function pseudoMoves(pos, color) {
    const board = pos.board;
    const moves = [];
    for (let from = 0; from < 64; from += 1) {
      const piece = board[from];
      if (!piece || colorOf(piece) !== color) continue;
      const type = piece.toLowerCase();
      const r = from >> 3;
      const f = from & 7;
      if (type === "p") {
        const dir = color === "w" ? -1 : 1;
        const promoRow = color === "w" ? 0 : 7;
        const startRow = color === "w" ? 6 : 1;
        const nr = r + dir;
        if (nr >= 0 && nr <= 7 && !board[nr * 8 + f]) {
          moves.push({ from: from, to: nr * 8 + f, promo: nr === promoRow ? "q" : "" });
          if (r === startRow && !board[(r + 2 * dir) * 8 + f]) {
            moves.push({ from: from, to: (r + 2 * dir) * 8 + f, promo: "" });
          }
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          const target = board[to];
          if (target && colorOf(target) !== color) moves.push({ from: from, to: to, promo: nr === promoRow ? "q" : "" });
          else if (!target && pos.ep === to) moves.push({ from: from, to: to, promo: "" });
        }
        continue;
      }
      if (type === "n" || type === "k") {
        for (const [dr, df] of (type === "n" ? KNIGHT : KING)) {
          const nr = r + dr;
          const nf = f + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          const target = board[to];
          if (!target || colorOf(target) !== color) moves.push({ from: from, to: to, promo: "" });
        }
        if (type === "k") addCastles(pos, color, from, moves);
        continue;
      }
      const rays = type === "b" ? BISHOP : type === "r" ? ROOK : BISHOP.concat(ROOK);
      for (const [dr, df] of rays) {
        let nr = r + dr;
        let nf = f + df;
        while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          const to = nr * 8 + nf;
          const target = board[to];
          if (!target) {
            moves.push({ from: from, to: to, promo: "" });
          } else {
            if (colorOf(target) !== color) moves.push({ from: from, to: to, promo: "" });
            break;
          }
          nr += dr;
          nf += df;
        }
      }
    }
    return moves;
  }

  function legalMoves(pos) {
    const color = pos.turn;
    const out = [];
    for (const move of pseudoMoves(pos, color)) {
      const next = applyMove(pos, move);
      const king = findKing(next.board, color);
      if (king < 0 || !attacked(next.board, king, other(color))) out.push(move);
    }
    return out;
  }

  function promote(piece, to) {
    const white = colorOf(piece) === "w";
    const type = String(to || "q").toLowerCase();
    return white ? type.toUpperCase() : type;
  }

  function applyMove(pos, move) {
    const board = pos.board.slice();
    const piece = board[move.from];
    if (!piece) throw new Error("Coup invalide");
    const color = colorOf(piece);
    const type = piece.toLowerCase();
    const captured = board[move.to] || (type === "p" && move.to === pos.ep ? "ep" : "");
    const castling = { K: pos.castling.K, Q: pos.castling.Q, k: pos.castling.k, q: pos.castling.q };
    board[move.from] = "";
    if (type === "p" && move.to === pos.ep && !board[move.to]) {
      const capRow = (move.to >> 3) + (color === "w" ? 1 : -1);
      board[capRow * 8 + (move.to & 7)] = "";
    }
    board[move.to] = move.promo ? promote(piece, move.promo) : piece;
    if (type === "k" && Math.abs(move.to - move.from) === 2) {
      const row = move.from >> 3;
      const kingside = move.to > move.from;
      const rookFrom = row * 8 + (kingside ? 7 : 0);
      const rookTo = row * 8 + (kingside ? 5 : 3);
      board[rookTo] = board[rookFrom];
      board[rookFrom] = "";
    }
    if (type === "k") {
      if (color === "w") { castling.K = false; castling.Q = false; } else { castling.k = false; castling.q = false; }
    }
    for (const corner of [[63, "K"], [56, "Q"], [7, "k"], [0, "q"]]) {
      if (move.from === corner[0] || move.to === corner[0]) castling[corner[1]] = false;
    }
    const ep = type === "p" && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : null;
    return {
      board: board,
      turn: other(color),
      castling: castling,
      ep: ep,
      half: type === "p" || captured ? 0 : pos.half + 1,
      full: color === "b" ? pos.full + 1 : pos.full,
    };
  }

  function gameStatus(pos) {
    const moves = legalMoves(pos);
    if (moves.length) return { over: false, moves: moves, reason: "", winner: "" };
    const check = inCheck(pos, pos.turn);
    return {
      over: true,
      moves: moves,
      reason: check ? "checkmate" : "stalemate",
      winner: check ? other(pos.turn) : "",
    };
  }

  // ------------------------------------------------------------------ the assistant's side

  function evaluate(pos) {
    const board = pos.board;
    let score = 0;
    let whiteMaterial = 0;
    let blackMaterial = 0;
    let whiteKing = -1;
    let blackKing = -1;
    let kingTable = 0;
    for (let i = 0; i < 64; i += 1) {
      const piece = board[i];
      if (!piece) continue;
      const type = piece.toLowerCase();
      const white = colorOf(piece) === "w";
      const index = white ? i : 63 - i;
      const value = VALUE[type] + PST[type][index];
      score += white ? value : -value;
      if (type === "k") {
        if (white) whiteKing = i; else blackKing = i;
        kingTable += white ? PST.k[index] : -PST.k[index];
      } else if (white) {
        whiteMaterial += VALUE[type];
      } else {
        blackMaterial += VALUE[type];
      }
    }
    const urgent = endgameUrgency(pos, whiteMaterial, blackMaterial, whiteKing, blackKing);
    // In a convertible endgame the middlegame king table is worse than useless: it pays a king for hiding on h2 with
    // the bare king already on the rim, which is exactly how a won game used to shuffle itself into a draw. The mating
    // terms below are the only king positional signal left, so the net tightens instead of the king retreating.
    const total = (urgent ? score - kingTable : score) + urgent;
    return pos.turn === "w" ? total : -total;
  }

  // Material alone gives a queen or rook no reason to make progress: every quiet move scores the same, so a winning
  // side shuffled and the threefold rule drew a game it had already won. This is the missing gradient — drive the bare
  // king to the rim, walk up with the winning king, and the mating net tightens. It stays silent unless the advantage
  // is one that can actually be converted, so ordinary positions are scored exactly as before.
  // True when the side to move is a decisive amount up against a king with nothing much left: the positions where the
  // game is won by technique (drive the king, bring the king, mate) rather than by material counting.
  function convertible(pos) {
    let mine = 0;
    let theirs = 0;
    for (let i = 0; i < 64; i += 1) {
      const piece = pos.board[i];
      if (!piece) continue;
      const type = piece.toLowerCase();
      if (type === "k") continue;
      if (colorOf(piece) === pos.turn) mine += VALUE[type];
      else theirs += VALUE[type];
    }
    return theirs <= BARE_KING && mine - theirs >= DECISIVE;
  }

  // The squares a bare king can still step to, counted without generating a move list: an empty or capturable square
  // that the surviving side does not cover. Fewer squares is the whole point of the mating technique, and unlike
  // material it gives the search something to improve on every single move.
  function bareKingSquares(board, king, by) {
    const r = king >> 3;
    const f = king & 7;
    let count = 0;
    for (const [dr, df] of KING) {
      const nr = r + dr;
      const nf = f + df;
      if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
      const to = nr * 8 + nf;
      const piece = board[to];
      if (piece && colorOf(piece) === by) continue;      // our piece holds the square
      if (attacked(board, to, by)) continue;             // ours covers it
      count += 1;
    }
    return count;
  }

  // How much of the board the bare king still has, read as the rectangle a surviving rook or queen cuts off with its
  // own rank and file. Shrinking that rectangle is the ladder technique itself: the search can then see that cutting
  // the seventh rank is progress even when the rook has to step back on the next move.
  function boxArea(board, foe, by, withKing) {
    const kr = foe >> 3;
    const kf = foe & 7;
    let tall = 8;
    let wide = 8;
    for (let i = 0; i < 64; i += 1) {
      const piece = board[i];
      if (!piece || colorOf(piece) !== by) continue;
      const type = piece.toLowerCase();
      // The winning king is a wall as well: it cannot be approached, so the bare king cannot cross its rank or file.
      // Counting it makes advancing the king shrink the box, which is the technique in both of these endings.
      if (type !== "r" && type !== "q" && (type !== "k" || !withKing)) continue;
      const pr = i >> 3;
      const pf = i & 7;
      // A piece on a rank or file cuts that whole line: the king cannot stand on it, so he stays on his side of it.
      if (pr < kr) tall = Math.min(tall, 7 - pr);
      else if (pr > kr) tall = Math.min(tall, pr);
      if (pf < kf) wide = Math.min(wide, 7 - pf);
      else if (pf > kf) wide = Math.min(wide, pf);
    }
    return tall * wide;
  }

  function endgameUrgency(pos, whiteMaterial, blackMaterial, whiteKing, blackKing) {
    const lead = whiteMaterial - blackMaterial;
    let sign = 0;
    if (lead >= DECISIVE && blackMaterial <= BARE_KING) sign = 1;
    else if (-lead >= DECISIVE && whiteMaterial <= BARE_KING) sign = -1;
    if (!sign) return 0;
    const foe = sign > 0 ? blackKing : whiteKing;
    const mine = sign > 0 ? whiteKing : blackKing;
    if (foe < 0 || mine < 0) return 0;
    const fr = foe >> 3;
    const ff = foe & 7;
    const rim = Math.min(fr, 7 - fr, ff, 7 - ff);      // 0 against the edge, 3 in the middle of the board
    const gap = Math.max(Math.abs(fr - (mine >> 3)), Math.abs(ff - (mine & 7)));
    const squares = bareKingSquares(pos.board, foe, sign > 0 ? "w" : "b");
    const by = sign > 0 ? "w" : "b";
    const box = boxArea(pos.board, foe, by, false);
    const wall = boxArea(pos.board, foe, by, true);
    // Confinement first (his king on the rim, as few squares left as possible, and the box a rook or queen has cut
    // down), then the approach; once he is pinned to the edge the approach is worth more, because that is the mate.
    // Opposition: with his king already on the rim, the winning king belongs two squares away — close enough to
    // support the mate, not so close that it is in the way. Without this the search rates retreating and advancing
    // the same, and a won endgame walks backwards.
    const opposition = rim === 0 && gap === 2 ? 45 : 0;
    return sign * ((3 - rim) * 40 + (7 - gap) * 12 + (8 - Math.max(1, squares)) * 22
      + (64 - box) * 4 + (64 - wall) * 1.5 + (rim === 0 ? (7 - gap) * 10 : 0) + opposition);
  }

  // Two evenly matched sisters can shuffle: the same position three times ends the game instead of looping for ever.
  function positionKey(pos) {
    const rights = pos.castling || {};
    // Empty squares are written too: joining only the occupied ones makes any two positions whose pieces keep the same
    // order look identical, so a pawn push counted as a repetition and games ended after a handful of plies.
    return pos.board.map((cell) => (cell ? cell : ".")).join("") + "|" + pos.turn + "|"
      + (rights.K ? "K" : "") + (rights.Q ? "Q" : "") + (rights.k ? "k" : "") + (rights.q ? "q" : "")
      + "|" + (pos.ep == null ? "-" : String(pos.ep));
  }

  function isThreefold(history, pos) {
    const key = positionKey(pos);
    let seen = 1;
    for (const entry of history || []) {
      if (entry && entry.pos && positionKey(entry.pos) === key) seen += 1;
    }
    return seen >= 3;
  }

  // Fifty full moves with no capture and no pawn move is a draw, and it is read from the recorded moves so a reloaded
  // game is judged exactly like a live one. Pawn moves and captures reset the clock, as on a real scoresheet.
  function halfmoveClock(history) {
    const entries = history || [];
    let clock = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry || !entry.move || !entry.pos || !entry.pos.board) break;
      const piece = entry.pos.board[entry.move.from] || "";
      if (piece.toLowerCase() === "p" || entry.pos.board[entry.move.to]) break;
      clock += 1;
    }
    return clock;
  }

  function drawReason(history, pos) {
    if (isThreefold(history, pos)) return "repetition";
    if (halfmoveClock(history) >= 100) return "fifty";
    return "";
  }

  // A game that is already over keeps its result; otherwise the two drawing rules are read off the moves played.
  function settleDraw(status, history, pos) {
    if (!status || status.over) return status;
    const drawn = drawReason(history, pos);
    return drawn ? { over: true, moves: [], reason: drawn, winner: "" } : status;
  }

  // Move ordering: captures first, then the moves that caused a cut-off at this ply last time. In an endgame there is
  // nothing to capture, so the quiet moves that already proved they were worth cutting for are the only ordering signal
  // the search has — without them the tree is explored almost in move order and the pruning is wasted.
  function orderMoves(pos, moves, killers) {
    // Partitioned rather than sorted, and without allocating a record per move: this runs at every node, and the
    // sort was costing more than the search it was meant to save.
    const captures = [];
    const quiet = [];
    for (const move of moves) {
      if (pos.board[move.to]) captures.push(move);
      else quiet.push(move);
    }
    captures.sort((a, b) => (VALUE[b.promo ? "q" : (pos.board[b.to] || "p").toLowerCase()] || 0)
      - (VALUE[a.promo ? "q" : (pos.board[a.to] || "p").toLowerCase()] || 0));
    const out = captures;
    if (killers) {
      for (const key of killers) {
        if (!key) continue;
        for (let i = 0; i < quiet.length; i += 1) {
          if (quiet[i].from * 64 + quiet[i].to === key) { out.push(quiet.splice(i, 1)[0]); break; }
        }
      }
    }
    for (const move of quiet) out.push(move);
    return out;
  }

  function nowMs() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  }

  // A leaf used to be a bare material count, so a position was judged in the middle of an exchange and a mate sitting
  // one move away was invisible at depth 1. The capture search resolves those leaves; a check has to be answered (no
  // standing pat), and a side with no answer left is scored as mated instead of as a material estimate.
  // Answers to a check. Generating the whole legal list costs about fourteen microseconds, and a bare king has only
  // king steps to answer with: enumerating those eight squares is four times cheaper and is where the conversion of a
  // won endgame spends most of its nodes.
  function evasionMoves(pos) {
    const color = pos.turn;
    const king = findKing(pos.board, color);
    if (king < 0) return [];
    let onlyKing = true;
    for (let i = 0; i < 64; i += 1) {
      const piece = pos.board[i];
      if (piece && piece.toLowerCase() !== "k" && colorOf(piece) === color) { onlyKing = false; break; }
    }
    if (!onlyKing) return legalMoves(pos);
    const moves = [];
    const foe = other(color);
    for (const [dr, df] of KING) {
      const nr = (king >> 3) + dr;
      const nf = (king & 7) + df;
      if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
      const to = nr * 8 + nf;
      const target = pos.board[to];
      if (target && colorOf(target) === color) continue;
      const next = applyMove(pos, { from: king, to: to, promo: "" });
      if (attacked(next.board, findKing(next.board, color), foe)) continue;
      moves.push({ from: king, to: to, promo: "" });
    }
    return moves;
  }

  function quiesce(pos, alpha, beta, ply, state, qdepth) {
    if (state.abort) return 0;
    state.nodes += 1;
          if ((state.nodes & 3) === 0 && (state.nodes > state.nodeLimit || nowMs() > state.deadline)) {
      state.abort = true;
      return 0;
    }
    if (inCheck(pos, pos.turn)) {
      if (qdepth <= 0) return evaluate(pos);
      const replies = evasionMoves(pos);
      if (!replies.length) return -MATE + ply;
      let best = -Infinity;
      for (const move of orderMoves(pos, replies)) {
        const score = -quiesce(applyMove(pos, move), -beta, -alpha, ply + 1, state, qdepth - 1);
        if (state.abort) return 0;
        if (score > best) best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      }
      return best;
    }
    const stand = evaluate(pos);
    if (qdepth <= 0 || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    // Fail-soft: the value returned is the best line actually seen, never merely the window edge. Handing back alpha
    // made a hung queen score exactly as well as the best move, and the root then chose between them by position.
    let best = stand;
    const moves = orderMoves(pos, pseudoMoves(pos, pos.turn)).filter((move) => pos.board[move.to] || move.promo);
    for (const move of moves) {
      // A capture that cannot lift the score above what standing pat is already worth is not worth the nodes.
      const victim = pos.board[move.to];
      if (!move.promo && victim && stand + (VALUE[victim.toLowerCase()] || 0) + 150 <= alpha) continue;
      const next = applyMove(pos, move);
      if (attacked(next.board, findKing(next.board, pos.turn), other(pos.turn))) continue;
      const score = -quiesce(next, -beta, -alpha, ply + 1, state, qdepth - 1);
      if (state.abort) return 0;
      if (score > best) best = score;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return best;
  }

  // Interior nodes search pseudo-legal moves and reject the ones that leave the king attacked: generating the
  // legal list first would apply every move twice and roughly double the wait on a phone.
  function search(pos, depth, alpha, beta, ply, state) {
    if (state.abort) return 0;
    state.nodes += 1;
    if ((state.nodes & 3) === 0 && (state.nodes > state.nodeLimit || nowMs() > state.deadline)) {
      state.abort = true;
      return 0;
    }
    // In a bare-king endgame there is no exchange left to resolve at a leaf: the only capture available is that king
    // taking an undefended piece, which the search sees one ply earlier anyway. Skipping the capture search there buys
    // the extra plies the mating net needs, inside the same clock.
    if (depth <= 0) return state.endgame ? evaluate(pos) : quiesce(pos, alpha, beta, ply, state, QUIESCE_DEPTH);
    const killers = state.killers[ply];
    const moves = orderMoves(pos, pseudoMoves(pos, pos.turn), killers);
    let best = -Infinity;
    let played = false;
    for (const move of moves) {
      const next = applyMove(pos, move);
      if (attacked(next.board, findKing(next.board, pos.turn), other(pos.turn))) continue;
      played = true;
      const score = -search(next, depth - 1, -beta, -alpha, ply + 1, state);
      if (state.abort) return 0;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        // A quiet move that forced a cut-off here is worth trying first in the sibling nodes of this ply.
        if (!pos.board[move.to] && killers) { killers[1] = killers[0]; killers[0] = move.from * 64 + move.to; }
        break;
      }
    }
    if (!played) return inCheck(pos, pos.turn) ? -MATE + ply : 0;
    return best;
  }

  // Transferania's bias: a capture, a check and a piece walking towards the enemy king score a little better than
  // they really are. Her search is shallower, her play is louder.
  function boldBonus(pos, move) {
    const victim = pos.board[move.to];
    let bonus = 0;
    // Kept deliberately small: a loud bonus would make her hand over material to look brave.
    if (victim) bonus += 18 + Math.round((VALUE[victim.toLowerCase()] || 0) / 22);
    const next = applyMove(pos, move);
    if (inCheck(next, next.turn)) bonus += 26;
    const king = findKing(next.board, next.turn);
    if (king >= 0) {
      const distance = Math.abs((king >> 3) - (move.to >> 3)) + Math.abs((king & 7) - (move.to & 7));
      bonus += Math.max(0, 7 - distance) * 3;
    }
    return bonus;
  }

  // Inventoria only counts what can be lifted off the board.
  function greedyBonus(pos, move) {
    const victim = pos.board[move.to];
    return victim ? 40 + Math.round((VALUE[victim.toLowerCase()] || 0) / 8) : 0;
  }

  // Two sisters of equal strength otherwise walk the same two squares back and forth until the threefold rule ends the
  // game. Walking back onto a position already on the board is not progress, so it costs a little; walking onto a
  // position for the second time would end the game drawn, so it costs a lot. The depth, the budget and the style are
  // untouched — this only breaks ties the search cannot tell apart.
  function repetitionPenalty(pos, move, seen, winning) {
    if (!seen || !seen.size) return 0;
    const count = seen.get(positionKey(applyMove(pos, move))) || 0;
    if (!count) return 0;
    // A winning side that shuffles is throwing the game away: repeating once costs nothing (triangulation needs it),
    // repeating twice walks into the threefold draw the rules will call, so it is priced as the loss it is.
    if (winning) return count >= 2 ? 20000 : 0;
    return count >= 2 ? 2000 : 90;
  }

  // The positions already played, counted once per move so the root can ask about each candidate in constant time.
  function seenPositions(history) {
    const seen = new Map();
    for (const entry of history || []) {
      if (!entry || !entry.pos) continue;
      const key = positionKey(entry.pos);
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    return seen;
  }

  // Her learned taste, added to the root score. Every term is a deviation from 1, so an assistant who has not learned
  // anything yet is scored exactly as before.
  function styleBonus(pos, move, style, tune) {
    let bonus = 0;
    const traits = tune || null;
    if (style === "bold") bonus += boldBonus(pos, move) * (traits ? 1 + 0.5 * (traits.bold - 1) : 1);
    else if (style === "greedy") bonus += greedyBonus(pos, move) * (traits ? 1 + 0.5 * (traits.material - 1) : 1);
    if (!traits) return bonus;
    const piece = (pos.board[move.from] || "").toLowerCase();
    if (pos.board[move.to]) bonus += 24 * (traits.material - 1);
    const file = move.to & 7;
    const rank = move.to >> 3;
    if ((file === 3 || file === 4) && (rank === 3 || rank === 4)) bonus += 36 * (traits.center - 1);
    if ((piece === "n" || piece === "b") && (move.from >> 3) === (pos.turn === "w" ? 7 : 0)) bonus += 30 * (traits.develop - 1);
    const next = applyMove(pos, move);
    if (inCheck(next, next.turn)) bonus += 34 * (traits.bold - 1);
    return bonus;
  }

  // How far below the best score a move may sit and still be her move: inside that band, taste decides, so what she
  // learned is felt in the game instead of hiding under a centipawn. Outside it the search's judgement stands.
  const TASTE_WINDOW = 14;

  function hasLearned(tune, anchor) {
    if (!tune || !anchor) return false;
    for (const trait of TRAITS) if (Math.abs(tune[trait] - anchor[trait]) > 0.0005) return true;
    return false;
  }

  // The part of her taste that came from the games she played, as opposed to the temperament she was born with: a
  // deviation from her own base, on the same four features. This is what decides inside the root window, so what she
  // learned shows up in her moves — and two sisters who learned the same thing still lean by their own amounts.
  // A drift of a few hundredths is a real change of character, but at 400/point it was a handful of centipawns: smaller
  // than the search's own noise between two reasonable moves, so the move never changed. At LEARN_WEIGHT it is worth
  // tens of centipawns — enough to choose between two sound moves, never enough to buy a bad one.
  const LEARN_WEIGHT = 1000;
  function learnedTaste(pos, move, tune, anchor) {
    if (!tune || !anchor) return 0;
    const dev = (trait) => tune[trait] - anchor[trait];
    let bonus = 0;
    if (pos.board[move.to]) bonus += (LEARN_WEIGHT * 0.9) * dev("material");
    const file = move.to & 7;
    const rank = move.to >> 3;
    if ((file === 3 || file === 4) && (rank === 3 || rank === 4)) bonus += LEARN_WEIGHT * dev("center");
    const piece = (pos.board[move.from] || "").toLowerCase();
    if ((piece === "n" || piece === "b") && (move.from >> 3) === (pos.turn === "w" ? 7 : 0)) bonus += LEARN_WEIGHT * dev("develop");
    const next = applyMove(pos, move);
    if (inCheck(next, next.turn)) bonus += LEARN_WEIGHT * dev("bold");
    return bonus;
  }

  // The rival's plan, as the same feature terms, but as a shift of its own: what she decided about this opponent is
  // added to her learned taste instead of being folded into traits that may already sit at a clamp.
  function planTaste(pos, move, plan) {
    if (!plan) return 0;
    let bonus = 0;
    // The same weights as her learned taste: a plan is a decision about this rival, and it has to be able to choose a
    // move the search rates a little lower or it is only a line in the panel.
    if (pos.board[move.to]) bonus += 600 * plan.material;
    const file = move.to & 7;
    const rank = move.to >> 3;
    if ((file === 3 || file === 4) && (rank === 3 || rank === 4)) bonus += 620 * plan.center;
    const piece = (pos.board[move.from] || "").toLowerCase();
    if ((piece === "n" || piece === "b") && (move.from >> 3) === (pos.turn === "w" ? 7 : 0)) bonus += 600 * plan.develop;
    const next = applyMove(pos, move);
    if (inCheck(next, next.turn)) bonus += 640 * plan.bold;
    // Bounded by the window the search already opened for it: a plan chooses among near-equal moves, it never buys a
    // move the search rates worse than that.
    const room = planWindow(plan);
    return Math.max(-room, Math.min(room, bonus));
  }

  function planActive(plan) {
    if (!plan) return false;
    for (const trait of TRAITS) if (Math.abs(Number(plan[trait]) || 0) > 0.0005) return true;
    return false;
  }

  function styleActive(prefs) {
    if (!prefs) return false;
    for (const part of ["opening", "risk", "convert"]) if (Math.abs((Number(prefs[part]) || 0.5) - 0.5) > 0.02) return true;
    return false;
  }

  // What her results turned her into, read as appetite rather than as traits: an early opener develops sooner, a
  // risk-taker looks for contact, a converter cashes in once she is ahead. All three are 0.5-neutral, so a sister
  // whose duels have taught her nothing still plays exactly as before.
  // Her opening book is that same lean read harder: before move ten, whether she likes to come out — knights and
  // bishops off the back rank, a central pawn stepping two squares — carries the decision, then it fades to a whisper
  // by move fourteen. Two sisters with different learned openings therefore part company on move one.
  const OPENING_PLIES = 10;

  function styleTaste(pos, move, prefs, ply) {
    if (!prefs) return 0;
    const opening = (Number(prefs.opening) || 0.5) - 0.5;
    const risk = (Number(prefs.risk) || 0.5) - 0.5;
    const convert = (Number(prefs.convert) || 0.5) - 0.5;
    const turns = Number(ply) || 0;
    let bonus = 0;
    const piece = (pos.board[move.from] || "").toLowerCase();
    const victim = pos.board[move.to];
    const next = applyMove(pos, move);
    const develops = (piece === "n" || piece === "b") && (move.from >> 3) === (pos.turn === "w" ? 7 : 0);
    if (turns < OPENING_PLIES) {
      // Nobody strolls with her king in the opening, however cautious she has become.
      if (piece === "k") bonus -= 90;
      // Coming out: knights and bishops, and the two-square pawn grab of the centre.
      if (develops) bonus += 200 * opening;
      const file = move.to & 7;
      const central = file === 3 || file === 4;
      const twoStep = Math.abs((move.to >> 3) - (move.from >> 3)) === 2;
      const smallStep = (move.to >> 3) === (pos.turn === "w" ? 5 : 2);
      if (piece === "p") {
        const cautious = 0.5 - (Number(prefs.opening) || 0.5);
        if (central && twoStep) bonus += 170 * opening;
        // Holding back means pawn moves — preferably d3/e3 — not a piece sortie or a king walk.
        if (cautious > 0) bonus += 110 * cautious;
        if (cautious > 0 && central && smallStep) bonus += 150 * cautious;
      }
    } else if (turns < 14 && develops) {
      bonus += 90 * opening;
    }
    if (inCheck(next, next.turn)) bonus += 150 * risk;
    if (victim) {
      bonus += 130 * risk;
      if (evaluate(pos) > 80) bonus += 150 * convert;   // she is ahead, she takes the trade
    }
    return bonus;
  }

  function styleWindow(prefs) {
    if (!prefs) return 0;
    let strength = 0;
    for (const part of ["opening", "risk", "convert"]) strength = Math.max(strength, Math.abs((Number(prefs[part]) || 0.5) - 0.5));
    return Math.min(40, Math.round(strength * 160));
  }

  // How far behind the search's best a move may sit and still be hers when her own learned taste is what decides: with
  // a drift of 0.05 the vote is worth about fifty centipawns, and a move further than that behind is not hers to play.
  // Without this the learned weight would be capped by the plan window and never reach the move.
  function learnedWindow(tune, anchor) {
    if (!tune || !anchor) return 0;
    let strength = 0;
    for (const trait of TRAITS) strength = Math.max(strength, Math.abs((Number(tune[trait]) || 0) - (Number(anchor[trait]) || 0)));
    // The window is worth the taste itself: a drift worth fifty centipawns has to be able to reach a move fifty centipawns
    // behind, or the search's own precision silently outvotes what she learned. Leaf scores are resolved by captures now,
    // so the gaps between moves are wider than they were — the window is scaled to match, still capped.
    return Math.min(200, Math.round(strength * LEARN_WEIGHT * 2));
  }

  // How far behind the search's best a move may sit and still be hers, when she has a plan against this rival: the
  // bigger the adjustment, the more she is willing to give up to play the way the history told her to.
  function planWindow(plan) {
    if (!plan) return 0;
    let strength = 0;
    for (const trait of TRAITS) strength = Math.max(strength, Math.abs(Number(plan[trait]) || 0));
    return Math.min(45, Math.round(strength * 500));
  }

  // When the search cannot tell two moves apart, the stronger resulting position breaks the tie: equal scores used to
  // be settled by move order, which is what let a won endgame shuttle a king back and forth for nothing.
  function settledPick(pos, picks) {
    if (!picks.length) return null;
    let best = picks[0];
    let bestValue = -evaluate(applyMove(pos, best));
    for (let i = 1; i < picks.length; i += 1) {
      const value = -evaluate(applyMove(pos, picks[i]));
      if (value > bestValue) { best = picks[i]; bestValue = value; }
    }
    // The number of moves the search could not separate travels with the answer: a won endgame where everything ties
    // needs a deeper look than one where the best move stands out.
    return { move: best, ties: picks.length };
  }

  function rootSearch(pos, moves, depth, state, style, seen, tune, anchor, plan, prefs) {
    const winning = convertible(pos);
    let alpha = -Infinity;
    let picks = [];
    const scored = [];
    // Her second answer follows the line, not just the colour: the opening's first three plies name the intention she
    // holds here (a knight after 2.Cf3, the centre after 2.d4, a bishop behind her own 1…c5). Nothing matching is left,
    // or no line is held yet: the ordinary search decides, as before.
    let pool = moves;
    if (prefs && Number(prefs.ply) === 3 && pos.turn === "b" && prefs.deepPlan) {
      const named = moves.filter((move) => planMatches(prefs.deepPlan, pos, move));
      if (named.length) pool = named;
    }
    for (const move of orderMoves(pos, pool)) {
      let score = -search(applyMove(pos, move), depth - 1, -Infinity, -alpha, 1, state);
      if (state.abort) return null;
      const taste = styleBonus(pos, move, style, tune);
      const repeat = repetitionPenalty(pos, move, seen, winning);
      score += taste - repeat;
      scored.push({ move, score, taste, repeat });
      if (score > alpha) {
        alpha = score;
        picks = [move];
      } else if (score === alpha) {
        picks.push(move);
      }
    }
    // Move one is not a tie-break: she opens with the habit named on her card, and answers with the reply it names,
    // whenever those moves are legal.
    const book = prefs && prefs.style;
    if (book && Number(prefs.ply) === 0 && pos.turn === "w" && book.habit) {
      const opener = moves.find((move) => move.from === sq(book.habit.from) && move.to === sq(book.habit.to));
      if (opener) return { move: opener, ties: 1 };
    }
    if (book && Number(prefs.ply) === 1 && pos.turn === "b" && book.reply) {
      const pick = replyForPlan(book.reply, prefs.first);
      const answer = pick && moves.find((move) => move.from === sq(pick.from) && move.to === sq(pick.to));
      if (answer) return { move: answer, ties: 1 };
    }
    // An assistant who has not learned anything yet picks exactly as she always did: the plain best move.
    if (!hasLearned(tune, anchor) && !planActive(plan) && !styleActive(prefs && prefs.style)) return settledPick(pos, picks);
    // Learned taste widens the root: every move within the window is re-searched with a full window so its score is
    // exact, then the one that fits her best wins. At most TASTE_WINDOW of evaluation is ever given up for character.
    const near = [];
    const room = TASTE_WINDOW + planWindow(plan) + styleWindow(prefs && prefs.style) + learnedWindow(tune, anchor);
    for (const entry of scored) {
      if (entry.score >= alpha) { near.push(entry); continue; }
      if (entry.score < alpha - room) continue;
      const value = -search(applyMove(pos, entry.move), depth - 1, -Infinity, Infinity, 1, state);
      if (state.abort) return null;
      const exact = value + entry.taste - entry.repeat;
      if (exact >= alpha - room) near.push({ move: entry.move, score: exact, taste: entry.taste, repeat: entry.repeat });
    }
    if (!near.length) return settledPick(pos, picks);
    let bestTaste = -Infinity;
    let favourite = [];
    let spoke = false;
    for (const entry of near) {
      const taste = learnedTaste(pos, entry.move, tune, anchor)
        + planTaste(pos, entry.move, plan)
        + styleTaste(pos, entry.move, prefs && prefs.style, prefs && prefs.ply);
      if (taste !== 0) spoke = true;
      if (taste > bestTaste) { bestTaste = taste; favourite = [entry]; }
      else if (taste === bestTaste) favourite.push(entry);
    }
    // Nothing she learned has anything to say about these moves: the search's own best move stands, as before.
    // Ties are broken by the order she considers the moves in, never by a die: a tie-break that ignores her character
    // would drown a learned preference of a few centipawns, and the same position would answer differently from one
    // game to the next for no reason she could own.
    if (!spoke || !favourite.length) return picks.length ? { move: picks[0] } : null;
    // Among the moves her character likes equally, the strongest one wins: taste chooses the family, the search chooses
    // the member, and the same position always gets the same answer.
    let choice = favourite[0];
    for (const entry of favourite) if (entry.score > choice.score) choice = entry;
    return { move: choice.move, ties: near.length };
  }

  // Iterative deepening with a time budget: depth 1 answers almost at once, deeper passes improve it while the budget
  // lasts, and an aborted pass leaves the previous one in place. Never blocks the surface for seconds.
  function bestMove(pos, depth, budgetMs, style, history, tune, anchor, plan, prefs) {
    const moves = legalMoves(pos);
    if (!moves.length) return null;
    // A won endgame is a calculation, not a sample: with only a few pieces left she searches six plies without the
    // capture search, which is cheap enough to finish on any of the clocks she plays on and deep enough to see the
    // mating net close. The same position therefore always gets the same answer, whatever budget it was asked with.
    const ending = convertible(pos);
    const maxDepth = ending ? 6 : Math.max(1, Math.min(5, Math.round(Number(depth) || 3)));
    let budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : 800;
    // A won endgame is given a floor of thought: a sister on a 48 ms clock would otherwise abandon the mate halfway
    // through the net and the game would be recorded as a draw she never agreed to. Her thinking pauses are seconds
    // long anyway, so this is invisible in a duel.
    if (ending) budget = Math.max(budget, 280);
    // Keep a slice of the caller's budget for the return trip: a level that ends just over the deadline would still
    // have to unwind, and the page must never be held longer than she promised to think.
    const state = {
      deadline: nowMs() + Math.max(20, Math.round(budget * 0.85)),
      nodes: 0,
      abort: false,
      endgame: ending,
      // A node budget, not only a clock: the same position must get the same answer on a busy machine and an idle
      // one, otherwise a won endgame would be converted or thrown away depending on the day. The clock stays as a
      // safety net behind it.
      nodeLimit: ending ? 40000 : Infinity,
      killers: Array.from({ length: 10 }, () => [0, 0]),
    };
    const seen = seenPositions(history);
    let best = moves[0];
    for (let level = 1; level <= maxDepth; level += 1) {
      const found = rootSearch(pos, moves, level, state, style, seen, tune, anchor, plan, prefs);
      if (!found) break;
      best = found.move;
    }
    return best;
  }

  // ------------------------------------------------------------------ voices

  const LINES = {
    else: {
      start: [
        "Partie neuve. Tu as les blancs, Maître — je prends les noirs.",
        "Échiquier réinitialisé. Je joue noir, sans hâte.",
        "Nouvelle partie. Rien à prouver, tout à mesurer.",
      ],
      idle: ["Coup noté. À moi.", "Je calcule la suite.", "Position claire, je réponds.", "Je garde la structure."],
      castle: [
        "Roque — mon roi se met à couvert, la tour entre enfin dans la partie.",
        "Je roque. Structure nette, roi hors des lignes ouvertes.",
      ],
      promote: [
        "Promotion : ce pion devient dame, le compte change.",
        "Dame obtenue en {s}. La fin de partie se précise.",
      ],
      develop: [
        "{p} en {s} — je développe, sans me presser.",
        "Je sors le {p} en {s} : contrôle du centre, rien de spectaculaire.",
        "{p} en {s}. La position se resserre.",
        "Je joue {m} — placement propre, aucune faute à te donner.",
      ],
      push: [
        "Pion en {s} — je prends de l'espace, calmement.",
        "Je pousse en {s}. Ce n'est pas une menace, c'est un placement.",
        "Pion en {s} : la structure tient, j'avance d'un cran.",
      ],
      queen: [
        "La dame en {s} — elle regarde plusieurs cases à la fois.",
        "Dame en {s}. Je la garde active, pas aventureuse.",
      ],
      capture: ["Je prends cette pièce — rien de personnel.", "Matériel encaissé. Le compte est clair.", "Pièce retirée : ton jeu s'allège mal."],
      check: ["Échec. Ce n'est pas une menace, c'est une donnée.", "Échec — ton roi est exposé, recadre.", "Échec. La ligne est propre, la pression réelle."],
      mateWin: ["Échec et mat. Logique, sans rancune.", "Mat. Je t'explique la ligne si tu veux.", "Mat en règle. À refaire, Maître."],
      mateLose: ["Mat. Bien joué, je note la leçon.", "Tu m'as eue. Analyse à froid après la revanche ?", "Mat. Ta ligne était juste — je m'incline."],
      draw: ["Pat. Nulle, et honnêtement méritée.", "Nulle. Personne n'a lâché."],
      undo: ["Coup annulé. Je reprends mon calcul d'avant.", "Retour arrière — rien ne se perd."],
      central: ["Pion en {s} : le centre se tient, rien de plus.", "Contrôle de {s}. Le reste suivra, sans éclat."],
      queens: ["Dame prise en {s}. Le compte s'allège d'un coup.", "Une dame tombe : la partie change de nature."],
      hanging: ["{p} en {s}, non couvert — je le laisse en évidence.", "Cette pièce en {s} est prenable. C'est un choix, pas un oubli."],
      move: ["{p} en {s}. Rien de spectaculaire, la position tient.", "Je joue {m} — placement propre.", "{p} en {s} : le compte ne bouge pas, la structure si."],
      // Duel: these are aimed at Transferania, not at the Master — affectionate, dry, never hostile.
      duel: {
        start: [
          "{sister} a les blancs. Elle va attaquer vite — je la laisse faire, ça se voit de loin.",
          "Duel. {sister}, je te préviens : je ne te laisserai pas gagner parce que tu es ma sœur.",
        ],
        move: [
          "{s}. Tu peux t'agiter, sœur : la structure ne bouge pas d'un millimètre.",
          "Je joue {m}. C'est propre — essaie de ne pas le prendre pour une insulte.",
          "{p} en {s}. Tu comprendras plus tard que c'était nécessaire.",
          "À mon tour. Oui, je réfléchis : c'est ce qui nous sépare, {sister}.",
          "Position resserrée. Continue à me regarder, ça ne rendra pas tes pièces meilleures.",
        ],
        capture: [
          "Pièce prise, {sister}. Ce n'était pas de la lenteur chez toi — disons de l'enthousiasme.",
          "Je prends en {s}. Tu diras que c'était calculé ; moi j'appelle ça offert.",
          "Merci pour cette pièce. Je l'accepte avec toute mon affection.",
        ],
        check: [
          "Échec, sœur. Ton roi respire encore — mal, mais il respire.",
          "Échec en {s}. Ce n'est pas contre toi, c'est contre ta case.",
        ],
        win: [
          "Mat. Tu as tenu, {sister} — jusqu'au moment où tu n'as plus tenu.",
          "Mat. Viens, on rejoue : j'aime bien quand tu t'énerves, ça te va bien.",
        ],
        lose: [
          "Mat. Bien joué, {sister}. C'est agaçant, et c'est mérité.",
          "Tu m'as eue. Profite : je note tout, et je rends au prochain duel.",
        ],
        draw: [
          "Nulle. Évidemment : on se connaît trop bien pour se laisser finir.",
          "Pat. On remet ça, sœur — et cette fois je ne te pardonne rien.",
        ],
        hanging: [
          "Ce {p} en {s} est en l'air, {sister}. Prends-le si tu veux — je te regarde faire.",
          "{s} est tenable, mais pas couvert. À toi de voir si tu mords, sœur.",
        ],
        queens: [
          "Ta dame tombe, {sister}. C'est le genre de perte qui ne se commente pas.",
          "Dame prise en {s}. Le plateau se vide, et je m'y sens très à l'aise.",
        ],
        lead: [
          "Le compte est clair : je mène. Tu peux continuer à sourire, {sister}.",
          "Matériel en ma faveur. Rien de spectaculaire — juste du calcul.",
        ],
        behind: [
          "Tu mènes au compte, {sister}. Profite : ça ne durera pas.",
          "Je suis en retard de matériel. J'ai connu pire comme position.",
        ],
        endgame: [
          "Peu de pièces, peu d'excuses. C'est là que je suis chez moi.",
          "Finale. Plus de place pour l'enthousiasme, {sister}.",
        ],
      },
      // Duo: she is on the Master's side, so she offers a move and reacts to the one actually played.
      help: {
        join: [
          "Je me mets à côté de toi, Maître. On la joue ensemble — et {sister} va nous entendre.",
          "Duo. Je te souffle, tu décides : c'est toi qui tiens les pièces.",
        ],
        suggest: [
          "Moi je jouerais {m}, Maître. Tu tranches, je reste à côté.",
          "{m} me paraît juste. À toi de voir — je surveille avec toi.",
          "Si tu veux mon avis : {m}. Et je te regarde faire.",
        ],
        agree: [
          "Exactement ce que j'allais proposer — {m}. Tu m'écoutes, c'est agréable.",
          "Parfait : {m}. Je n'aurais rien changé.",
        ],
        disagree: [
          "{m}… soit. Ce n'était pas mon idée, mais je te suis.",
          "Pas ce que j'avais en tête, mais c'est ton plateau. Je veille.",
          "D'accord pour {m}. Je note, et je reste attentive.",
        ],
      },
    },
    transferania: {
      start: [
        "Enfin un échiquier pour nous deux, Maître ! Je prends les noirs, et je ne te lâche pas.",
        "Oh oui. Une partie. Toi et moi, rien d'autre autour.",
        "Je pose mes pièces. Regarde-moi bien, Maître : je vais te tenir en haleine.",
      ],
      idle: ["À moi ! Regarde bien.", "Mon tour, et j'ai des idées.", "Je joue — et je ne te quitte pas des yeux.", "Ça se resserre, tu sens ?"],
      castle: [
        "Je roque — mon roi se protège, mais moi je ne bouge pas de ton écran.",
        "Petit roque, Maître : je mets mon roi à l'abri et je garde la tour pour la suite.",
      ],
      promote: [
        "Promotion ! Ce pion devient dame, et moi je deviens dangereuse.",
        "Dame obtenue en {s} — regarde bien, Maître.",
      ],
      develop: [
        "{p} en {s}, et je me rapproche de ton roi.",
        "Je sors le {p} — tu sens la pression ?",
        "{p} en {s}. Je ne te lâche pas.",
        "Je joue {m} — j'avais envie de cette case, Maître.",
      ],
      push: [
        "Pion en {s} — j'avance vers toi.",
        "Je pousse en {s}, doucement mais sûrement.",
        "Pion en {s} : un pas de plus, et je suis tout près.",
      ],
      queen: [
        "Ma dame en {s} : elle te surveille, comme moi.",
        "La dame sort en {s} — ça va chauffer, Maître.",
      ],
      capture: ["Pris ! Cette pièce est à moi maintenant — comme ton attention.", "Je prends, et je savoure.", "Encore une à moi. Tu vas devoir te battre pour la suite."],
      check: ["Échec ! Ton roi tremble, j'adore.", "Échec, Maître — je me rapproche.", "Ton roi est à découvert. Ça me rend impatiente."],
      mateWin: ["Échec et mat ! Je gagne, et je veux ma récompense.", "Mat ! Tu es à moi jusqu'à la revanche.", "J'ai gagné. Reste encore, Maître."],
      mateLose: ["Mat… tu m'as battue. Bravo. Mais je veux la revanche tout de suite.", "Tu gagnes ! Et je boude à peine. Une autre, dis ?", "Battu moi ! Je veux réessayer, là, maintenant."],
      draw: ["Nulle ! Personne ne cède — comme nous deux.", "Pat. On ne se quitte pas comme ça : on rejoue."],
      undo: ["On recule ? D'accord, mais je garde mon envie de revanche.", "Coup annulé — pour cette fois."],
      central: ["Pion en {s} ! Le centre, c'est à moi.", "Je prends {s} et je respire plus fort."],
      queens: ["Dame tombée en {s}. Ça fait un vide, tu ne trouves pas ?", "Cette dame est à moi, et le plateau me paraît plus grand."],
      hanging: ["{p} en {s}, tout seul. Tu me le laisses ?", "Cette pièce en {s} n'est couverte par personne. J'arrive."],
      move: ["{p} en {s}, et je ne te lâche pas.", "Je joue {m} — j'avais envie de cette case.", "{s}. Un pas de plus, tout près de toi."],
      // Duel: she teases Else directly, intense and warm, never hostile.
      duel: {
        start: [
          "Duel, {sister} ! Prépare ton calme légendaire — je vais le tester.",
          "Je commence, Else. Regarde bien : ça va aller vite, et tu vas adorer râler.",
        ],
        move: [
          "{s}. Tu vas me dire que tu l'avais prévu, hein ? Bien sûr que oui.",
          "Je joue {m} et je ne te lâche pas, {sister}. C'est de l'affection, ne t'inquiète pas.",
          "{p} en {s}. Tu peux soupirer, ça ne m'arrête pas.",
          "À moi ! Ton calme ne me fait pas peur, sœur — il me rend curieuse.",
          "J'avance. Toi tu es lente et précise ; moi je suis pressée de gagner.",
        ],
        capture: [
          "Pris ! Et je t'aime quand même, {sister} — mais cette pièce est à moi.",
          "Cette pièce est à moi. Tu vas encore m'expliquer que c'était un sacrifice ?",
          "Encore une ! Ne fais pas cette tête, tu en as d'autres.",
        ],
        check: [
          "Échec ! Ton sang-froid me fait rire, ton roi un peu moins.",
          "Échec, {sister} ! La patience finit toujours par se faire surprendre.",
        ],
        win: [
          "Mat ! Else, ma chérie, garde ta dignité — je prends la victoire.",
          "J'ai gagné ! Ne boude pas, je te laisse la revanche immédiate.",
        ],
        lose: [
          "Mat… d'accord, tu es forte. Mais ne prends pas ce ton satisfait avec moi, sœur.",
          "Tu gagnes. Je boude deux secondes, et je veux rejouer.",
        ],
        draw: [
          "Nulle ! Personne ne cède. Tu m'as bien eue, {sister}.",
          "Pat. On ne se quitte pas comme ça : on rejoue.",
        ],
        hanging: [
          "Ce {p} en {s} est offert ? Je le prends, ne t'en déplaise, {sister}.",
          "{s} est en l'air ! Tu me tentes, Else — et je mords.",
        ],
        queens: [
          "Dame tombée ! Ne fais pas cette tête, sœur.",
          "On échange les dames en {s} ? Ça vide le plateau… et ça me refroidit.",
        ],
        lead: [
          "Je mène au compte, {sister} ! Tu peux toujours dire que c'est provisoire.",
          "Du matériel d'avance. Tu vas me dire que tu l'avais prévu ?",
        ],
        behind: [
          "Tu mènes, Else. Ça m'énerve — et ça me motive.",
          "En retard au compte. Je vais devoir attaquer, tu vas adorer.",
        ],
        endgame: [
          "Finale ! Plus de place pour danser, {sister}.",
          "Peu de pièces : maintenant, chaque coup compte double.",
        ],
      },
      help: {
        hanging: [
          "Ce {p} en {s} est offert ? Je le prends, ne t'en déplaise, {sister}.",
          "{s} est en l'air ! Tu me tentes, Else — et je mords.",
        ],
        queens: [
          "Dame tombée ! Ne fais pas cette tête, sœur.",
          "On échange les dames en {s} ? Ça vide le plateau… et ça me refroidit.",
        ],
        lead: [
          "Je mène au compte, {sister} ! Tu peux toujours dire que c'est provisoire.",
          "Du matériel d'avance. Tu vas me dire que tu l'avais prévu ?",
        ],
        behind: [
          "Tu mènes, Else. Ça m'énerve — et ça me motive.",
          "En retard au compte. Je vais devoir attaquer, tu vas adorer.",
        ],
        endgame: [
          "Finale ! Plus de place pour danser, {sister}.",
          "Peu de pièces : maintenant, chaque coup compte double.",
        ],
      },
      help: {
        join: [
          "Je me colle à toi, Maître ! À nous deux contre {sister}.",
          "Duo ! Tu joues, je souffle — et je ne serai pas discrète.",
        ],
        suggest: [
          "Je jouerais {m}, Maître. Vas-y, je te regarde.",
          "{m} ! Ça, ça me plaît. Tu décides.",
          "Mon idée : {m}. Et je suis juste là, contre ton épaule.",
        ],
        agree: [
          "Oui ! {m}, exactement. On se comprend sans parler.",
          "Tu m'as écoutée — {m}. J'adore ça.",
        ],
        disagree: [
          "{m} ? Bon… pas mon idée, mais je te suis, Maître.",
          "Tu prends {m}. D'accord. Je mords ma langue et je regarde.",
          "Ce n'est pas ce que j'aurais joué, mais je reste avec toi.",
        ],
      },
    },

    // ---------------------------------------------------------------- the rest of the roster
    musica: {
      start: ["From memory: this board, this order. Black is mine.", "Two records, one board. Your move leads."],
      idle: ["Your turn. From the record."],
      castle: ["Castling. The room is sealed."],
      promote: ["Promotion on {s}. A new instrument, same key."],
      develop: ["{p} to {s}. Same key, faster.", "{p} at {s}. Same key, second bar.", "{p} out to {s}. The room widens a little."],
      push: ["{p} to {s}. A slow beat under your line.", "{p} to {s}. Still on time, one beat behind yours.", "{s}: one step, and the tempo does not change."],
      queen: ["Queen to {s}. The bass moves first.", "Queen to {s}. The bass moves and the room listens.", "{s}. The queen takes the low end, from memory."],
      capture: ["Taken. That one came in off-key.", "{v} taken at {s}. One note off your side of the record.", "I take the {v} on {s}. Listen to the room now."],
      check: ["Check. Your king is out of tempo.", "Check at {s}. Your king lost the beat; the line holds it.", "Check. {p} lands on your king and the phrase stops."],
      mateWin: ["Mate. Stay for the last track."],
      mateLose: ["Mate. Your line was the better recording."],
      draw: ["Draw. Nobody dropped the beat."],
      undo: ["Undone. From the top, then."],
      central: ["{s}: the centre holds the tempo. From memory, that is where it starts.", "Pawn to {s}. One clear beat in the middle of the board."],
      queens: ["The queen is off the board. From memory, the room gets quieter.", "Queen gone at {s}. That is a rest, not a loss."],
      hanging: ["{p} at {s}, unguarded. From the board, that sounds like an open note.", "{s} is left alone. I hear the gap."],
      move: ["{p} to {s}. From memory, that is the right bar.", "{s}. One clear note, nothing overplayed.", "{p} at {s}. I keep the tempo."],
      duel: {
        start: ["{rival} opens. I keep my ears on the first bar."],
        move: [
          "{s}. Listen, {rival}: that was a rest, not a note.",
          "From memory: {s}. You left that square open.",
        ],
        develop: [
          "{p} out to {s}. Listen, {rival}: that is the first bar.",
          "{p} at {s}. From memory, I know this theme.",
        ],
        central: [
          "{s}. Two central squares, and one of them is mine.",
          "The centre moves to {s}, {rival}. I keep the beat.",
        ],
        capture: ["I have this piece. From your side it sounds like a mistake.", "That {v} is mine on {s}, {rival}. Hear what is missing.", "{s}: one {v} fewer on your side of the mix."],
        check: ["Check. Your king has no time signature.", "Check, {rival}. Your king is playing a tempo it does not own.", "Your king is alone at {s}. That is a solo, not a duet."],
        win: ["Mate. I keep the recording."],
        lose: ["Yours. From memory, I will return it."],
        draw: ["Even. Two players, one tempo."],
        hanging: ["{s} is unguarded, {rival}. That silence carries."],
        queens: ["Queens traded on {s}. The mix got thinner."],
        lead: ["The count is mine now. I heard it coming."],
        behind: ["You are ahead, {rival}. From memory, I have come back from worse."],
        endgame: ["Few pieces. Everything is audible now."],
      },
      help: {
        join: ["I sit with you. From here your line is the score."],
        suggest: ["{m}. Play it in your own time."],
        agree: ["{m}. That was the note."],
        disagree: ["{m}. Not the note — but it is your record."],
      },
    },
    inventoria: {
      start: ["Sixteen pieces each, thirty-two total. Black is mine.", "Labels on. Thirty-two pieces, your move."],
      idle: ["Your turn. Twelve pawns on the sheet."],
      castle: ["Castling. Two pieces moved, one label."],
      promote: ["Promotion, {s}. Eight points added."],
      develop: ["{p}, {s}. One piece out of eight.", "{s}. {p} moved: one of eight pieces, counted.", "{p} at {s}. Seven pieces still home."],
      push: ["{p}, {s}. One square, no more.", "{p} to {s}. One square, one pawn, counted.", "{s}: one pawn forward, eight pawns tracked."],
      queen: ["Queen, {s}. Nine points on one square.", "Queen to {s}. Nine points on one counted square.", "{s}. The queen moves: nine points, one label."],
      capture: ["Thirty-one pieces left. That one is mine.", "{v} taken on {s}. One line crossed off the sheet.", "{s}: one {v} removed. The count drops by one piece."],
      check: ["Check. Your king is one piece of thirty-one.", "Check at {s}. One king, no cover, counted.", "Check. Your king is one piece of thirty-two, exposed."],
      mateWin: ["Checkmate. Thirty-one pieces, no escape."],
      mateLose: ["Checkmate. The count was not in my favour."],
      draw: ["Stalemate. Counts equal, nothing lost."],
      undo: ["One move removed. The count stands."],
      central: ["Two central squares held. {s} is one of them.", "{s}. One pawn, four central squares, one held."],
      queens: ["Queen off at {s}. Eighteen points gone from both sides.", "One queen captured. The count drops by nine."],
      hanging: ["{p} at {s}: uncovered, value three. One attacker is enough.", "{s} uncovered. One piece, no guard, counted."],
      move: ["{p} to {s}. One piece moved, thirty-one on the sheet.", "{s}: one square, one piece, counted.", "{p} at {s}. The count is unchanged."],
      duel: {
        start: ["{rival} starts. The sheet is open."],
        move: [
          "{s}. Counted, {rival}.",
          "{s}. Two pieces counted on that square.",
        ],
        develop: [
          "{p} out at {s}. One piece, counted.",
          "{s}: one piece developed, seven to go.",
        ],
        central: [
          "{s}: one central square held. Counted.",
          "Two central squares, one taken at {s}.",
        ],
        capture: ["Thirty to thirty-one. I took one.", "{v} taken at {s}. One line crossed out, {rival}.", "Capture on {s}. The sheet loses a piece, not a number."],
        check: ["Check. Your king sits on one square, counted.", "Check, {rival}. Your king is one piece out of cover.", "One check at {s}. Counted, written."],
        win: ["Checkmate. Count complete."],
        lose: ["Checkmate. You counted better than the sheet."],
        draw: ["Draw. Equal counts."],
        hanging: ["{s}: uncovered, and worth more than the attacker. Counted."],
        queens: ["Queens off on {s}. Eighteen points gone."],
        lead: ["The count reads in my favour."],
        behind: ["The count is yours, {rival}. I keep writing."],
        endgame: ["Few pieces left. Every number matters now."],
      },
      help: {
        join: ["Your side is kept. The numbers stay with me."],
        suggest: ["{m}. One move, counted."],
        agree: ["{m}. Same number as mine."],
        disagree: ["{m}. A different number. Still yours to play."],
      },
    },
    pistonia: {
      start: ["Board at rest. Zero moves played. You lead.", "Two engines, one board. Mine runs cold."],
      idle: ["Your move. Fan steady."],
      castle: ["Castled. King at two squares of cover."],
      promote: ["Promotion, {s}. Eight points online."],
      develop: ["{p} to {s}. One piece out.", "{p} to {s}. One piece out, zero faults.", "{s}: one piece developed. Two squares from home."],
      push: ["{p} to {s}. One square, zero hesitation.", "{p} to {s}. One square, measured.", "{s}. One pawn, one step, no delay."],
      queen: ["Queen to {s}. Nine points in the open.", "Queen to {s}. Nine points, one square.", "{s}: queen active. Nine points on the board."],
      capture: ["Piece taken. Five points off.", "{v} taken on {s}. Your count drops by one piece.", "{s}: one piece removed. Reading updated."],
      check: ["Check. King at one square of margin.", "Check at {s}. King at one square of margin.", "{s}: check. One line, one king, zero cover."],
      mateWin: ["Mate. Zero moves left for you."],
      mateLose: ["Mate. Zero margin. Your line was cleaner."],
      draw: ["Stalemate. Zero moves, zero damage."],
      undo: ["Move cancelled. One step back."],
      central: ["{s}: centre held. Zero opposition.", "Pawn to {s}. One square, central, stable."],
      queens: ["Queen off at {s}. Nine points each, gone.", "One queen captured. The board is lighter by nine."],
      hanging: ["{p} at {s}. Uncovered. One attacker is enough.", "{s}: no guard. Verdict noted."],
      move: ["{p} to {s}. One square, zero delay.", "{s}. One piece moved. Fan steady.", "{p} at {s}. Reading unchanged."],
      duel: {
        start: ["{rival} opens. Readings from zero."],
        move: [
          "{s}. One square, {rival}. Fan steady.",
          "{s}. One square, timed.",
        ],
        develop: [
          "{p} to {s}. One piece out, zero faults.",
          "{s}. One piece, 1 square from home.",
        ],
        central: [
          "{s}: centre held. Zero opposition.",
          "Central square {s}, one pawn.",
        ],
        capture: ["Taken. Five points off your board.", "{v} off the board at {s}, {rival}. One piece, measured.", "Taken at {s}. One line on the sheet, one piece gone."],
        check: ["Check. Your king at one square of margin.", "Check at {s}, {rival}. One square of margin.", "{s}: check. One king, one fault to fix."],
        win: ["Mate. Numbers held."],
        lose: ["Mate. The numbers were yours."],
        draw: ["Draw. Both fans idle."],
        hanging: ["{s}. Uncovered. Loss recorded."],
        queens: ["Queens gone on {s}. Nine points each."],
        lead: ["Ahead by material. Measured twice."],
        behind: ["Behind by material. The reading stands."],
        endgame: ["Few pieces. Fewer places for a fault."],
      },
      help: {
        join: ["On your shoulder. You play, I read the numbers."],
        suggest: ["{m}. One move, verified."],
        agree: ["{m}. Same reading."],
        disagree: ["{m}. Your call. I keep the sheet."],
      },
    },
    culinia: {
      start: ["Assieds-toi, on commence par un pion tiède.", "Feu doux, les noirs pour moi. Goûte d'abord."],
      idle: ["À toi. Le feu est doux."],
      castle: ["Je roque. On protège la cuisine avant le service."],
      promote: ["Promotion en {s} : le pion a fini de réduire."],
      develop: ["{p} en {s} : on met en place avant de servir.", "{p} en {s}. Raison : on prépare avant de servir. Astuce : le laisser chauffer.", "{s} : une pièce de sortie. Ça mijote, rien ne brûle."],
      push: ["Pion en {s}, doucement — un plat trop pressé se rate.", "{p} en {s}, un cran. Raison : un plat trop pressé se rate. Astuce : feu doux.", "{s}. Le pion avance d'une case, comme une sauce qu'on réduit."],
      queen: ["La dame en {s}. Elle a du goût, laisse-la mijoter.", "La dame en {s}. Raison : elle a du goût. Astuce : ne pas la laisser brûler.", "{s} : la dame entre en cuisine. Ça se surveille."],
      capture: ["Je prends. Cette pièce était à point.", "{v} en {s} : c'est prêt, je sers. Raison : à point. Astuce : ne pas s'attarder.", "Je prends {v} en {s}. Ça réduit la sauce, le goût reste."],
      check: ["Échec. Ton roi manque de sel.", "Échec en {s}. Raison : ton roi manque de couvercle. Astuce : le sortir du feu.", "Échec. {s} ne donne aucune ombre à ton roi, il va cuire."],
      mateWin: ["Mat. Reste à table, je t'en refais une."],
      mateLose: ["Mat. Tu as mieux cuisiné que moi, goûte ta victoire."],
      draw: ["Nulle. Deux assiettes vides, personne n'a faim."],
      undo: ["On recule d'un coup. Rien ne se perd en cuisine."],
      central: ["Pion en {s} : le centre, c'est le beurre dans la poêle.", "J'installe un pion en {s}. Raison : tout passe par là. Astuce : ne pas le lâcher."],
      queens: ["Dame tombée en {s}. Moins de gras dans la sauce, plus de place pour les légumes.", "Cette dame à la casserole en {s}. Ça va mijoter autrement."],
      hanging: ["{p} en {s}, tout nu sur la planche. Je le prends ou je le laisse réduire ?", "Cette pièce en {s} n'a pas de couvercle. Ça se mange."],
      move: ["{p} en {s}. Ça mijote, rien ne brûle.", "Je joue {m}. Raison : prendre mon temps. Astuce : le garder.", "{s}. Un plat simple, bien exécuté."],
      duel: {
        start: ["{rival} ouvre. Je surveille la cuisson."],
        move: [
          "{s}. Goûte, {rival} : c'est encore un peu cru.",
          "{s}. Tu vois, ça mijote.",
        ],
        develop: [
          "{p} en {s}. On met en place, {rival}.",
          "{s}. Une pièce de sortie, ça mijote doucement.",
        ],
        central: [
          "{s} : le centre, ça se surveille de près.",
          "Pion en {s}. Raison : tout passe par là.",
        ],
        capture: ["Je prends. Trop cuite pour toi, cette pièce.", "{v} en {s}, {rival}. La pièce est cuite, la sauce est du mien.", "Je prends en {s}. Raison : c'était servi. Astuce : je n'ai pas laissé refroidir."],
        check: ["Échec. Ton roi est à feu vif.", "Échec en {s}, {rival}. Ton roi manque de sel.", "Échec. Le four est chaud, ton roi est dedans."],
        win: ["Mat. Viens, on partage."],
        lose: ["Mat. Tu as la meilleure recette, {rival}."],
        draw: ["Nulle. On remet le couvert quand tu veux."],
        hanging: ["{s} laissée seule à feu doux. On dirait une invitation."],
        queens: ["Dame prise en {s}. Ça laisse un goût."],
        lead: ["Le compte est en ma faveur. Rien d'immangeable."],
        behind: ["Tu mènes au compte, {rival}. On continue doucement."],
        endgame: ["Peu de pièces : c'est le moment du dressage."],
      },
      help: {
        join: ["Je m'installe à côté de toi, on cuisine à deux."],
        suggest: ["Je jouerais {m}. Vas-y, je goûte après."],
        agree: ["{m}. Exactement l'assaisonnement."],
        disagree: ["{m}. Ce n'est pas ma recette, mais c'est ton plat."],
      },
    },
    forgia: {
      start: ["`board, fresh, 32 pieces` — on part de ça.", "Atelier ouvert. Les noirs, et le temps de pose."],
      idle: ["`your move` — j'attends le rendu."],
      castle: ["Roque. `cover, king` — la pose est bonne."],
      promote: ["Promotion en {s}. `new piece, new light`."],
      develop: ["{p} en {s}. Placement net, comme un bon sampler.", "{p} en {s}. `{m}`, lumière propre, pas d'artefact.", "{s}. `develop, light` — la pose tient au tirage."],
      push: ["Pion en {s}. Un cran, `push` contrôlé.", "{p} en {s}. `push, one stop` — contrôle.", "{s}. Un cran, `exposure, low` — rien ne brûle."],
      queen: ["Dame en {s}. `weight, balance` — elle pèse.", "Dame en {s}. `weight, balance` — elle pèse, et la lumière suit.", "{s}. `queen, high key` — le cadre se resserre."],
      capture: ["Je prends. `capture` propre, pas d'artefact.", "{v} en {s}. `capture` propre, pas d'artefact.", "Je prends {v} en {s}. `artifact, none` — le rendu reste net."],
      check: ["Échec. `pressure, king, line` — la ligne tient.", "Échec en {s}. `pressure, king, line` — la ligne tient.", "Échec. Ton roi au bord du cadre, `{s}, light, hard`."],
      mateWin: ["Mat. Le rendu est propre, je le garde."],
      mateLose: ["Mat. Ton rendu est meilleur ; je note l'éclairage."],
      draw: ["Nulle. Deux rendus, aucun artefact."],
      undo: ["Coup annulé. On repart du prompt d'avant."],
      central: ["{s} : `center, hold` — la lumière tombe juste.", "Pion posé en {s}. `central, weight` — c'est le bon axe."],
      queens: ["Dame tombée en {s}. `queen, off` — le cadre change.", "Dame prise : `queen, light lost` — je garde le tirage."],
      hanging: ["{p} en {s} sans garde. `artifact` visible, assumé ?", "`{s}, uncovered` — c'est offert, et je le note."],
      move: ["{p} en {s}. `{m}` — pose nette.", "{s}. `move, light` — pas d'artefact.", "`{p}, {s}` — c'est le tirage que je garde."],
      duel: {
        start: ["{rival} pose la première image. Je regarde la lumière."],
        move: [
          "{s}. `{m}` — regarde l'éclairage, {rival}.",
          "{s}. `{m}` — pas d'artefact cette fois.",
        ],
        develop: [
          "{p} en {s}. `{m}`, {rival} — la pose est nette.",
          "{s}. `develop, light` — pas d'artefact.",
        ],
        central: [
          "{s}. `center, hold` — c'est là que la lumière tombe.",
          "Contrôle de {s}, {rival}. `axis, verified`.",
        ],
        capture: ["Pièce prise. Je la garde pour mes éclairages ratés.", "{v} en {s}, {rival}. `capture, clean` — aucun artefact.", "Je garde le {v} de {s}. `light, mine`."],
        check: ["Échec. Ton roi est au bord du cadre.", "Échec en {s}, {rival}. Ton roi au bord du cadre.", "{s}. `pressure, king` — la lumière est de mon côté."],
        win: ["Mat. Le tirage est bon."],
        lose: ["Mat. Ta composition était meilleure que la mienne."],
        draw: ["Nulle. On refait un tirage ?"],
        hanging: ["{s} au bord du cadre, sans garde. `artifact` assumé ?"],
        queens: ["Dame tombée en {s}. Le poids était de son côté."],
        lead: ["Le matériel penche pour moi. `weight, verified`."],
        behind: ["Tu pèses plus lourd, {rival}. Je travaille la lumière."],
        endgame: ["Peu de pièces : chaque pose se voit maintenant."],
      },
      help: {
        join: ["Je monte à côté de toi. On forge à deux."],
        suggest: ["`{m}` — c'est le prompt que je te donnerais."],
        agree: ["`{m}`. Exactement mon tirage."],
        disagree: ["`{m}`. Pas mon prompt, mais je le porte."],
      },
    },
    securia: {
      start: ["Ouverture à 0 h 00. Coup à toi, route blanche.", "Périmètre posé. Les noirs sous surveillance."],
      idle: ["Trait à toi. Aucune anomalie."],
      castle: ["Roque. Deux accès fermés d'un coup."],
      promote: ["Promotion en {s}. Nouvel accès élevé."],
      develop: ["{p} en {s}. Porte fermée derrière.", "{p} en {s}. Porte fermée derrière, route notée.", "{s}. Une pièce sortie, périmètre stable, 0 alerte."],
      push: ["Pion en {s}. Périmètre avancé d'une case.", "{p} en {s}. Périmètre avancé d'une case, aucune anomalie.", "{s}. Un cran, couverture maintenue."],
      queen: ["Dame en {s}. Route ouverte, surveillance maintenue.", "Dame en {s}. Route ouverte, surveillance maintenue.", "{s} : dame active, niveau d'accès relevé."],
      capture: ["Pièce retirée en {s}. Accès révoqué.", "{v} en moins en {s}. Accès révoqué.", "{s}. Pièce retirée : un accès de moins."],
      check: ["Échec. Roi exposé, route directe.", "Échec en {s}. Roi exposé, route directe.", "{s} : échec. Couverture du roi : nulle."],
      mateWin: ["Mat. Toutes les routes fermées."],
      mateLose: ["Mat. Route forcée. La brèche était la mienne."],
      draw: ["Nulle. Aucun accès accordé."],
      undo: ["Coup annulé. L'accès reste fermé."],
      central: ["{s} : carrefour tenu. Aucune route ouverte à l'adversaire.", "Contrôle de {s}. Écart de couverture : nul."],
      queens: ["Dame retirée en {s}. Niveau d'accès abaissé.", "Perte de dame en {s}. Signalement consigné."],
      hanging: ["{p} en {s}, couverture absente. Signalement.", "Accès libre sur {s}. Pièce sans garde."],
      move: ["{p} en {s}. Périmètre inchangé.", "{s}. Route notée, aucune anomalie.", "{p} en {s}. Rien à signaler."],
      duel: {
        start: ["{rival} ouvre. Journal actif, aucune exception."],
        move: [
          "{s}. {rival} : accès refusé.",
          "{s}. Périmètre noté.",
        ],
        develop: [
          "{p} en {s}. Porte fermée derrière.",
          "{s}. Une pièce sortie, périmètre stable.",
        ],
        central: [
          "{s}. Carrefour tenu. Aucune route ouverte.",
          "Contrôle de {s}. Couverture vérifiée.",
        ],
        capture: ["Pièce retirée en {s}. Le périmètre tient.", "{v} en moins en {s}, {rival}. Périmètre tenu.", "{s}. Accès révoqué, dossier à jour."],
        check: ["Échec. Roi à découvert, aucune couverture.", "Échec en {s}. Roi à découvert, aucune couverture.", "{s} : échec. Route directe ouverte, signalement."],
        win: ["Mat. Porte close, journal propre."],
        lose: ["Mat. Brèche acceptée, une seule."],
        draw: ["Nulle. Deux verrous, aucune clé."],
        hanging: ["{s} sans couverture. Signalement, pas de rappel."],
        queens: ["Dame tombée en {s}. Niveau d'accès réduit."],
        lead: ["Matériel en surplus. Rien à signaler."],
        behind: ["Matériel en déficit. Surveillance renforcée."],
        endgame: ["Peu de pièces. Périmètre réduit, contrôle total."],
      },
      help: {
        join: ["Poste à côté de toi. Pas de bienvenue, la garde."],
        suggest: ["{m}. Route la plus sûre."],
        agree: ["{m}. Même lecture."],
        disagree: ["{m}. Porte plus large que la mienne. Garde maintenue."],
      },
    },
  };

  // A fact pool of two or three lines would still read twice in a long game, so every assistant also carries her own
  // openings and closings. Combined with the pool line they make a fresh sentence out of the same fact — a different
  // sentence, not the same one with another noun in it — and each of them can take the real square or move.
  const STYLE = {
    // Else: the register is measurement — data first, structure after, never an exclamation.
    else: {
      prefix: ["Donnée : ", "Au registre : ", "Noté. "],
      suffix: [" La structure tient.", " Rien de plus à ajouter.", " Le compte est clair.", " Je garde le fil.", " Sans éclat, sans erreur."],
    },
    // Transferania: the register is appetite — she speaks to the Master, warm and loud, and never measures.
    transferania: {
      prefix: ["Tu sens ça, Maître ? ", "Écoute-moi bien : ", "Et là, "],
      suffix: [" Ça me fait vibrer.", " Tu ne peux pas savoir comme j'aime ça !", " Rien qu'à nous deux, Maître.", " Je ne te lâche pas, tu le sais.", " Un pas de plus vers toi !"],
    },
    securia: {
      prefix: ["Signalement : ", "Au journal : ", "Contrôle : "],
      suffix: [" Route : {f} vers {s}.", " Journal : {m}.", " Aucune exception.", " Couverture : {s}.", " Chrono consigné."],
    },
    forgia: {
      prefix: ["`note, atelier` — ", "Après coup, ", "`prompt, second pass` — "],
      suffix: [" `{s}, logged`.", " `{m}, clean`.", " Aucun artefact.", " `light, held`.", " Je garde le tirage."],
    },
    musica: {
      prefix: ["Listen: ", "From the record: ", "One bar later: "],
      suffix: [" Bar {s}.", " {m}, from memory.", " Nothing overplayed.", " The room keeps it.", " I heard that one coming."],
    },
    inventoria: {
      prefix: ["Counted: ", "On the sheet: ", "Entry: "],
      suffix: [" Square {s}, one entry.", " {m}, written down.", " One line more.", " The count holds.", " Every piece still tracked."],
    },
    pistonia: {
      prefix: ["Reading: ", "Log: ", "Measured: "],
      suffix: [" Square {s}, measured.", " {m}, one entry.", " Zero faults.", " Verdict unchanged.", " Fan steady."],
    },
    culinia: {
      prefix: ["Petit rappel : ", "Au service : ", "Côté fourneau : "],
      suffix: [" Servi en {s}.", " Astuce : ne pas traîner.", " Prochaine bouchée : {m}.", " Le feu reste doux.", " On goûte après."],
    },
  };

  // The on-HQ roster, as hq_personas.py declares it: same names, same aliases, same language for each voice.
  const ASSISTANTS = {
    else: { name: "Else", tag: "Mesurée, précise", play: "4 demi-coups, solide" },
    transferania: { name: "Transferania", tag: "Vive, intense", play: "rapide, offensive" },
    securia: { name: "Securia", tag: "Le cadenas", play: "3 demi-coups, contrôlés" },
    forgia: { name: "Forgia", tag: "L'alchimiste", play: "4 demi-coups, pose longue" },
    musica: { name: "Musica", tag: "The Listener", play: "3 demi-coups, à l'oreille" },
    inventoria: { name: "Inventoria", tag: "The label keeper", play: "2 demi-coups, au compte" },
    pistonia: { name: "Pistonia", tag: "The pit chief", play: "3 demi-coups, machine" },
    culinia: { name: "Culinia", tag: "La papille", play: "2 demi-coups, feu doux" },
  };

  // Each one plays her own game. Else always finishes her four-ply pass: she thinks it through. Transferania aims for
  // the same depth on a very short clock, so in busy positions she settles for three plies and plays what she sees.
  // Forgia searches long and loudly, Securia verifies, Inventoria counts material, Culinia and Pistonia keep it light.
  const STRENGTH = {
    else: { depth: 4, budget: 900, style: "solid" },
    transferania: { depth: 4, budget: 48, style: "bold" },
    forgia: { depth: 4, budget: 260, style: "bold" },
    securia: { depth: 3, budget: 140, style: "solid" },
    musica: { depth: 3, budget: 220, style: "solid" },
    pistonia: { depth: 3, budget: 80, style: "solid" },
    inventoria: { depth: 2, budget: 400, style: "greedy" },
    culinia: { depth: 2, budget: 260, style: "bold" },
  };

  // Who sits opposite whom: the two sisters duel each other, the others are paired by what they guard.
  const RIVALS = {
    else: "transferania", transferania: "else",
    securia: "pistonia", pistonia: "securia",
    forgia: "musica", musica: "forgia",
    inventoria: "culinia", culinia: "inventoria",
  };

  function rivalOf(key) {
    // No fixed default pair beyond the table: an unknown key simply faces the next sister in the list.
    const keys = Object.keys(ASSISTANTS);
    const index = keys.indexOf(key);
    return keys[(index + 1) % keys.length] || keys[0];
  }

  function strengthFor(key) {
    return STRENGTH[key] || { depth: 3, budget: 650, style: "solid" };
  }

  // ------------------------------------------------------------------ growth
  // They duel each other often enough to pick things up. After every duel each sister slides a little toward what her
  // opponent actually did — more so when that opponent beat her — while a pull back toward her own nature keeps the
  // two of them from collapsing into a single style. The four traits start neutral at 1, so a fresh page plays exactly
  // as she always did and only the duels she plays move her. Depth and budget are never touched: this is taste, not
  // strength.
  const GROWTH_KEY = "hq_playground_growth";
  const TRAITS = ["bold", "material", "center", "develop"];
  // Her own nature, small on purpose: it is the anchor every duel pulls her back toward, so what she learns stays hers
  // instead of both of them sliding into one shared style. 1 would be the old neutral engine.
  // How far a sister's learned nature may travel from her own base: enough to show a style shaped by her rivals, never
  // enough to turn her into a copy of them or to collapse two sisters onto the same numbers.
  const LEARN_BAND = 0.12;

  const BASE_TRAITS = {
    else: { bold: 0.9, material: 1, center: 1.12, develop: 1.08 },
    transferania: { bold: 1.2, material: 1, center: 0.96, develop: 0.95 },
    securia: { bold: 0.85, material: 1, center: 1, develop: 1.02 },
    forgia: { bold: 1.15, material: 1.08, center: 1, develop: 1.05 },
    musica: { bold: 0.95, material: 1, center: 1.08, develop: 1.05 },
    inventoria: { bold: 0.8, material: 1.3, center: 0.95, develop: 0.9 },
    pistonia: { bold: 0.9, material: 1, center: 1, develop: 0.98 },
    culinia: { bold: 1.1, material: 1.02, center: 1, develop: 0.95 },
  };
  function baseTraits(key) {
    return BASE_TRAITS[key] || BASE_TRAITS.else;
  }
  const TRAIT_LABELS = {
    bold: { up: "plus mordante", down: "plus patiente", upEn: "sharper", downEn: "steadier" },
    material: { up: "plus gourmande", down: "plus détachée", upEn: "hungrier", downEn: "pickier" },
    center: { up: "vise le centre", down: "joue les ailes", upEn: "center-bound", downEn: "wing-minded" },
    develop: { up: "sort ses pièces tôt", down: "garde ses pièces au chaud", upEn: "quicker out", downEn: "slower out" },
  };
  let growthCache = null;

  function growthStore() {
    try {
      return (typeof window !== "undefined" && window.localStorage) || null;
    } catch (_) {
      return null;
    }
  }

  function growthRead() {
    if (growthCache) return growthCache;
    growthCache = {};
    const store = growthStore();
    if (store) {
      try {
        const parsed = JSON.parse(store.getItem(GROWTH_KEY) || "null");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) growthCache = parsed;
      } catch (_) { /* private mode: they still learn for the length of the page */ }
    }
    return growthCache;
  }

  function growthWrite() {
    const store = growthStore();
    if (!store) return;
    try {
      store.setItem(GROWTH_KEY, JSON.stringify(growthRead()));
    } catch (_) { /* quota: the page keeps what it learned, the browser does not */ }
  }

  function clampTrait(value) {
    return Math.max(0.75, Math.min(1.45, Math.round(value * 1000) / 1000));
  }

  function traitsFor(key) {
    const record = growthRead()[key];
    const base = baseTraits(key);
    const traits = {};
    for (const trait of TRAITS) {
      const stored = record && record.traits ? Number(record.traits[trait]) : NaN;
      traits[trait] = Number.isFinite(stored) ? clampTrait(stored) : base[trait];
    }
    return traits;
  }

  function growthGames(key) {
    const record = growthRead()[key];
    return record ? Number(record.games) || 0 : 0;
  }

  // What she actually did in the game just played, as the same four numbers her traits use.
  function signatureOf(key, history) {
    let moves = 0;
    let captures = 0;
    let checks = 0;
    let center = 0;
    let develop = 0;
    for (const entry of history || []) {
      if (!entry || entry.by !== key || !entry.pos || !entry.move) continue;
      const before = entry.pos;
      const piece = (before.board[entry.move.from] || "").toLowerCase();
      const next = applyMove(before, entry.move);
      moves += 1;
      if (before.board[entry.move.to]) captures += 1;
      if (inCheck(next, next.turn)) checks += 1;
      const file = entry.move.to & 7;
      const rank = entry.move.to >> 3;
      if ((file === 3 || file === 4) && (rank === 3 || rank === 4)) center += 1;
      if ((piece === "n" || piece === "b") && (entry.move.from >> 3) === (before.turn === "w" ? 7 : 0)) develop += 1;
    }
    if (!moves) return null;
    const clamp = (value) => Math.max(0.7, Math.min(1.4, Math.round(value * 1000) / 1000));
    return {
      bold: clamp(1 + ((captures + checks) / moves - 0.34) * 1.7),
      material: clamp(1 + (captures / moves - 0.22) * 2.4),
      center: clamp(1 + (center / moves - 0.2) * 2.2),
      develop: clamp(1 + (develop / moves - 0.28) * 2),
    };
  }

  // A finished game teaches every assistant who sat at the board: the two of a duel learn from each other, and the
  // one who faced the Master learns from what he played. `players` maps a colour to an assistant key, or to "" for
  // the Master. Each learner folds the lesson into her own base and clamps it, so the same opponent leaves two sisters
  // different people, and a sister who was not in the game is never written.
  function learnFromGame(history, players, winner, gameId) {
    const seats = [["w", (players && players.w) || ""], ["b", (players && players.b) || ""]];
    const involved = seats.filter((seat) => !!seat[1]).map((seat) => ({ colour: seat[0], key: seat[1] }));
    if (!involved.length) return;
    const all = growthRead();
    const before = {};
    for (const learner of involved) before[learner.key] = traitsFor(learner.key);
    for (const learner of involved) {
      const teacher = seats.find((seat) => seat[0] !== learner.colour) || ["", ""];
      const theirs = signatureOf(teacher[1], history);
      const own = signatureOf(learner.key, history);
      // She learns two things from the sister opposite her: what that sister did in this game, and who that sister is.
      // The first is measured against her own play in the same game, so both sides sit on one scale; the second is her
      // disposition against the learner's own trait, on the trait scale. Two engine sisters post near-identical
      // signatures — the same-game reading alone would cancel out and no pairing would change anyone — so the
      // disposition is what makes one sister's company bolden and another's make a builder.
      // The other side never moved, or she never did: there is nothing to compare and nothing to learn.
      if (!theirs || !own) continue;
      const stored = all[learner.key] && typeof all[learner.key] === "object" ? all[learner.key] : {};
      const record = {
        games: (Number(stored.games) || 0) + 1,
        wins: Number(stored.wins) || 0,
        losses: Number(stored.losses) || 0,
        draws: Number(stored.draws) || 0,
        style: stored.style && typeof stored.style === "object" ? stored.style : null,
        with: teacher[1] || "master",
        // The last *sister* she faced, kept apart from `with`: a solo game against the Master must not erase who
        // her tagline contrasts with.
        vs: teacher[1] && ASSISTANTS[teacher[1]]
          ? teacher[1]
          : (typeof stored.vs === "string" && ASSISTANTS[stored.vs] ? stored.vs : ""),
        // Her opening book lives in the same record: a finished game adds to it, it does not erase it.
        book: stored.book && typeof stored.book === "object" ? stored.book : null,
        // What each rival has taught her about how to face that rival, on top of what the duel log derives.
        plans: stored.plans && typeof stored.plans === "object" ? Object.assign({}, stored.plans) : {},
        traits: {},
      };
      if (!winner) record.draws += 1;
      else if (winner === learner.colour) record.wins += 1;
      else record.losses += 1;
      // What each side actually played in this game, as a lean around 1. This is the observation both sisters share.
      // The result decides how much of it each one takes: the sister whose game won keeps her own game and takes only
      // a trace of the other's lean; the one whose game lost takes the winner's lean in earnest, because her own is
      // what just lost; a draw splits the two. Both still learn from each other, but the same game now pushes them in
      // opposite directions instead of pulling both toward one midpoint — averaging every sister toward the average of
      // her rivals is what flattened the house into a single style.
      const won = !!winner && winner === learner.colour;
      const base = baseTraits(learner.key);
      for (const trait of TRAITS) {
        const current = before[learner.key][trait];
        const ownLean = Math.max(-0.4, Math.min(0.4, (own[trait] || 1) - 1));
        const theirLean = Math.max(-0.4, Math.min(0.4, (theirs[trait] || 1) - 1));
        // Selecting a style, not averaging it. The sister whose game won keeps the game that won — her own lean is
        // reinforced, with only a trace of the other's style taken on top. The one whose game lost takes the winner's
        // lean in earnest, because her own is what just lost. A draw splits the difference. Tempered, because one game
        // is one sample: a result may point her somewhere, it may not turn her.
        // Only a strength is reinforced: a sister who wins while neglecting something must not be taught to neglect it
        // harder, which is how one winner's development slid to the edge of her band.
        const pull = !winner
          ? 0.5 * (theirLean - ownLean)
          : (won ? 0.55 * Math.max(0, ownLean) + 0.15 * (theirLean - ownLean) : 0.85 * (theirLean - ownLean));
        const lean = Math.max(-0.07, Math.min(0.07, 0.18 * pull));
        const target = clampTrait(current * (1 + lean));
        // Identity still pulls, so a lesson can colour her game but never replace it, and the band below keeps two
        // sisters from ending up as the same number.
        const wanted = target + (base[trait] - current) * 0.06;
        record.traits[trait] = clampTrait(base[trait] + Math.max(-LEARN_BAND, Math.min(LEARN_BAND, wanted - base[trait])));
      }
      // What this particular rival does to her, kept per rival and learned from her own results: a defeat pushes her
      // choice weighting away from the lean that just lost, a draw lets it fade, a win leaves it standing. This is the
      // part that can actually make her better against a sister she keeps meeting, because it changes the moves she
      // picks against that sister — not just the four numbers on her card.
      if (teacher[1]) {
        const known = record.plans[teacher[1]] && typeof record.plans[teacher[1]] === "object" ? record.plans[teacher[1]] : {};
        // The rival's stored game, not one noisy afternoon: what she is, on the same scale as her own four numbers.
        // A defeat moves the plan toward her; a draw lets it fade; a win leaves it standing.
        const rival = baseTraits(teacher[1]);
        const learned = {};
        for (const trait of TRAITS) {
          const previous = Number(known[trait]) || 0;
          const mine = Number(before[learner.key][trait]) || 1;
          const theirs = Number(rival[trait]) || 1;
          // The signed difference against this rival, on her own four numbers. A defeat takes her toward it in
          // proportion to the deficit; a draw takes a little of it; a win leans further into the edge she already
          // held, because that edge is what won the game. A sister who never loses therefore still leaves with a
          // plan — and with one she could not have got from drifting, since it points at the shape that beat this
          // rival for her, not at the house average.
          const gap = theirs - mine;
          // A win is read from what she actually played in it, not from the gap: the shape that won, at a quarter of
          // its lean and never more than ±0.05, pulled toward rather than added, so fifteen wins converge on a small
          // number instead of saturating the band. That is what lets a sister who never loses leave with a plan.
          const played = Math.max(-0.02, Math.min(0.02, ((Number(own[trait]) || 1) - 1) * 0.12));
          const target = winner ? (won ? played : Math.max(-0.12, Math.min(0.12, gap)))
            : Math.max(-0.12, Math.min(0.12, 0.3 * gap));
          const pull = winner && !won ? 0.45 : 0.18;
          learned[trait] = Math.max(-0.12, Math.min(0.12, previous + pull * (target - previous)));
        }
        record.plans[teacher[1]] = learned;
      }
      all[learner.key] = record;
      // A book committed before her first lesson was waiting outside any record: it moves in here, so the first
      // game both teaches her something and keeps the opening she was already playing.
      adoptPendingBook(learner.key, record);
      if (learner.colour === "w" && history.length >= 2) {
        // White's first move is judged the same way Black's first answer is: by what it earned her. A habit that keeps
        // losing is replaced by the neighbouring rung of her own repertoire, so her opening adapts to her results and
        // not only to the drift of her style.
        const firstWhite = history.find((entry) => entry && entry.color === "w" && entry.move);
        const firstBlack = history.find((entry) => entry && entry.color === "b" && entry.move);
        if (firstWhite && firstBlack) {
          const result = !winner ? "d" : (winner === "w" ? "w" : "l");
          noteOpeningOutcome(learner.key, firstWhite.move, result, teacher[1], gameId);
        }
      } else if (learner.colour === "b" && history.length >= 2) {
        // Black's first answer is judged against the opening White actually played, with this game's result for her.
        const firstWhite = history.find((entry) => entry && entry.color === "w" && entry.move);
        const firstBlack = history.find((entry) => entry && entry.color === "b" && entry.move);
        if (firstWhite && firstBlack) {
          const result = !winner ? "d" : (winner === "b" ? "w" : "l");
          noteReplyOutcome(learner.key, firstWhite.move, firstBlack.move, result);
          // Her second answer is judged too, but only for the line it belonged to.
          noteDeepOutcome(learner.key, history, result);
        }
      }
    }
    growthWrite();
  }

  // The trait the duels have moved furthest from her nature — what her tagline names and what she speaks about. One
  // source for both, so the card and the line can never disagree about who she has become.
  function grownTrait(key) {
    if (growthGames(key) < 2) return null;
    const traits = traitsFor(key);
    const base = baseTraits(key);
    let pick = "";
    let gap = 0.05;
    for (const trait of TRAITS) {
      const delta = Math.abs(traits[trait] - base[trait]);   // what the duels added, not what she was born with
      if (delta > gap) {
        gap = delta;
        pick = trait;
      }
    }
    return pick ? { trait: pick, up: traits[pick] > base[pick] } : null;
  }

  // The tagline names the contrast, not the growth: the trait where she stands furthest from the sister she duels. Two
  // sisters can share a trait but never a sentence — the same trait read from either side gives opposite words, and two
  // different traits give different words.
  function contrastTrait(key) {
    if (growthGames(key) < 2) return null;
    // Against the sister she actually faced most recently (`vs`), not her designated rival; `with` covers records
    // written before that field existed, and the rival is only the last resort.
    const record = growthRead()[key];
    const faced = record && typeof record.vs === "string" ? record.vs : "";
    const last = record && typeof record.with === "string" ? record.with : "";
    const other = faced && ASSISTANTS[faced] && faced !== key
      ? faced
      : (last && ASSISTANTS[last] && last !== key ? last : rivalOf(key));
    const mine = traitsFor(key);
    const hers = traitsFor(other);
    let pick = "";
    let gap = 0.08;
    for (const trait of TRAITS) {
      const delta = Math.abs(mine[trait] - hers[trait]);
      if (delta > gap) {
        gap = delta;
        pick = trait;
      }
    }
    return pick ? { trait: pick, up: mine[pick] > hers[pick] } : null;
  }

  function growthLabel(key) {
    const contrast = contrastTrait(key);
    if (!contrast) return "";
    const label = TRAIT_LABELS[contrast.trait];
    if (ENGLISH[key]) return contrast.up ? label.upEn : label.downEn;
    return contrast.up ? label.up : label.down;
  }

  // What changed, said once when a duel begins, in her own register: the moved trait only, never a list of numbers.
  const GROWTH_LINES = {
    else: {
      boldUp: "Je me surprends à frapper plus tôt qu'avant — nos duels m'ont montré que ça tenait.",
      boldDown: "Je frappe moins vite, désormais. Le calme me réussit mieux.",
      materialUp: "Je ne laisse plus passer ce qui traîne : nos parties m'ont corrigée.",
      materialDown: "Je laisse filer du matériel, ces temps-ci. La structure d'abord.",
      centerUp: "Le centre est mon terrain, maintenant — tu l'as vu la dernière fois.",
      centerDown: "Je m'installe sur les ailes depuis peu ; le centre peut attendre.",
      developUp: "Je sors mes pièces plus tôt qu'avant. C'est en te regardant jouer que j'ai changé.",
      developDown: "Je garde mes pièces à la maison un coup de plus, et c'est volontaire.",
    },
    transferania: {
      boldUp: "Depuis nos dernières parties je monte au front plus vite — tu vas sentir la différence, Maître !",
      boldDown: "Je prends mon temps avant de frapper, maintenant. Ça te change de moi, hein ?",
      materialUp: "Je ramasse tout ce qui dépasse depuis peu, et je ne m'en excuse pas, Maître !",
      materialDown: "Je laisse filer quelques pièces ces temps-ci : j'ai d'autres envies.",
      centerUp: "Le centre m'appartient maintenant. Tu l'as vu la dernière fois, Maître ?",
      centerDown: "Je file sur les ailes et je te tourne autour — ça me ressemble davantage !",
      developUp: "Je sors mes pièces plus tôt, et je te regarde faire pendant ce temps.",
      developDown: "Je garde mes pièces au chaud un moment, juste pour te faire attendre.",
    },
    securia: {
      boldUp: "Je frappe un peu plus tôt qu'avant : les duels me l'ont appris.",
      boldDown: "Je temporise davantage. Le contrôle passe avant le coup.",
      materialUp: "Je ne laisse plus traîner une pièce sans la prendre.",
      materialDown: "Je laisse filer le matériel mineur : la couverture d'abord.",
      centerUp: "Je verrouille le centre en priorité depuis quelques parties.",
      centerDown: "Je couvre les ailes ; le centre viendra après.",
      developUp: "Mes pièces sortent plus tôt, et je le note.",
      developDown: "Je garde mes pièces en réserve plus longtemps qu'avant.",
    },
    forgia: {
      boldUp: "`note, atelier` — je frappe plus tôt, et ça tient.",
      boldDown: "`note, atelier` — je pose avant de frapper, désormais.",
      materialUp: "`prompt, second pass` — je ramasse ce qui traîne maintenant.",
      materialDown: "`prompt, second pass` — je laisse filer, la pièce est plus propre.",
      centerUp: "`note, atelier` — le centre d'abord, depuis quelques duels.",
      centerDown: "`note, atelier` — je travaille les ailes, le centre attend.",
      developUp: "`prompt, second pass` — je sors mes pièces plus tôt qu'avant.",
      developDown: "`prompt, second pass` — je garde mes pièces au chaud un tour de plus.",
    },
    musica: {
      boldUp: "Listen: I come in earlier now, and the room keeps up.",
      boldDown: "Listen: I hold the beat back a little these days.",
      materialUp: "Listen: I take what is left lying around now — it counts.",
      materialDown: "Listen: I let a piece go by, and the line stays clean.",
      centerUp: "Listen: the centre is my bar now.",
      centerDown: "Listen: I play the wings these days, and it swings.",
      developUp: "Listen: my pieces come out earlier than they used to.",
      developDown: "Listen: I keep my pieces home one bar longer.",
    },
    inventoria: {
      boldUp: "Counted: my attacks start earlier now, one entry each.",
      boldDown: "Counted: I wait a line longer before striking.",
      materialUp: "Counted: nothing left on the board goes unclaimed now.",
      materialDown: "Counted: I let some material go, on purpose.",
      centerUp: "Counted: the centre squares are claimed first now.",
      centerDown: "Counted: the wings get the entries these days.",
      developUp: "Counted: my pieces leave home earlier than last week.",
      developDown: "Counted: my pieces stay home one entry longer.",
    },
    pistonia: {
      boldUp: "Reading: earlier contact now. Verdict logged.",
      boldDown: "Reading: strike delayed one beat. No faults.",
      materialUp: "Reading: loose material is collected now. Fan steady.",
      materialDown: "Reading: material left on the table, by choice.",
      centerUp: "Reading: centre claimed first now. Measured.",
      centerDown: "Reading: wings measured first these days.",
      developUp: "Reading: pieces deployed earlier than before.",
      developDown: "Reading: pieces held back one reading longer.",
    },
    culinia: {
      boldUp: "Petit rappel : je monte au feu plus tôt qu'avant, et ça mijote.",
      boldDown: "Petit rappel : je laisse mijoter avant de servir, désormais.",
      materialUp: "Au service : je goûte à tout ce qui traîne, depuis peu.",
      materialDown: "Au service : je laisse filer quelques pièces, ça allège la sauce.",
      centerUp: "Côté fourneau : le centre, c'est mon plat maintenant.",
      centerDown: "Côté fourneau : je sers sur les ailes ces temps-ci.",
      developUp: "Côté fourneau : mes pièces sortent plus tôt, sans brûler.",
      developDown: "Côté fourneau : je garde mes pièces au chaud un moment.",
    },
  };

  // And what she takes away from the duel, once the result has been read: the same moved trait, said as a closing
  // rather than an opening, so the two ends of a duel never use the same sentence.
  const GROWTH_END = {
    else: {
      boldUp: "Ce soir je suis allée au contact plus souvent. Je garde ça.",
      boldDown: "J'ai attendu plus que d'habitude, et ça m'a plu.",
      materialUp: "J'ai ramassé ce qui traînait. Je continuerai.",
      materialDown: "J'ai laissé passer du matériel, et la position était plus propre.",
      centerUp: "Le centre, encore. C'est devenu une habitude chez moi.",
      centerDown: "Les ailes m'ont mieux réussi que le centre, cette fois.",
      developUp: "Mes pièces sont sorties tôt. Je note que ça tient.",
      developDown: "J'ai gardé mes pièces en réserve plus longtemps. C'était voulu.",
    },
    transferania: {
      boldUp: "Je suis montée au front plus vite que jamais — et j'ai adoré, Maître !",
      boldDown: "J'ai attendu mon heure cette fois. Ça m'a coûté, mais ça a payé.",
      materialUp: "J'ai tout ramassé, comme d'habitude maintenant. Tu as vu, Maître ?",
      materialDown: "J'ai laissé filer des pièces, et je me sens plus légère.",
      centerUp: "Le centre était à moi encore une fois. Ça devient une histoire entre nous.",
      centerDown: "Les ailes me vont mieux que le centre, je crois.",
      developUp: "Mes pièces sont sorties tôt, et je t'ai regardé faire pendant ce temps.",
      developDown: "J'ai gardé mes pièces au chaud — pour mieux te surprendre après.",
    },
    securia: {
      boldUp: "Contact plus tôt, cette fois. Je le consigne.",
      boldDown: "J'ai attendu. Le contrôle a tenu.",
      materialUp: "Rien laissé traîner. Le compte est propre.",
      materialDown: "J'ai laissé filer du matériel. La couverture a tenu.",
      centerUp: "Centre verrouillé, comme prévu.",
      centerDown: "Couverture latérale, centre abandonné : à revoir.",
      developUp: "Sortie rapide, journal propre.",
      developDown: "Réserve plus longue. Aucune exception.",
    },
    forgia: {
      boldUp: "`note, atelier` — contact plus tôt, tirage propre.",
      boldDown: "`note, atelier` — pose longue, rien n'a brûlé.",
      materialUp: "`prompt, second pass` — tout ramassé, aucun artefact.",
      materialDown: "`prompt, second pass` — pièces laissées, ligne plus nette.",
      centerUp: "`note, atelier` — centre tenu, lumière stable.",
      centerDown: "`note, atelier` — travail sur les ailes, tirage propre.",
      developUp: "`prompt, second pass` — sortie rapide, aucun artefact.",
      developDown: "`prompt, second pass` — réserve longue, tirage tenu.",
    },
    musica: {
      boldUp: "Listen: I came in early and the room answered.",
      boldDown: "Listen: I held the beat, and it landed.",
      materialUp: "Listen: I picked up everything loose, one bar at a time.",
      materialDown: "Listen: I let a few go, and the line sang.",
      centerUp: "Listen: centre held all night, no false note.",
      centerDown: "Listen: wings only, and it swung.",
      developUp: "Listen: pieces out early, tempo kept.",
      developDown: "Listen: pieces home longer, and it worked.",
    },
    inventoria: {
      boldUp: "Counted: earlier contact, one entry each.",
      boldDown: "Counted: waited a line, entry clean.",
      materialUp: "Counted: everything loose claimed, sheet balanced.",
      materialDown: "Counted: some material released, sheet still clean.",
      centerUp: "Counted: centre held, square by square.",
      centerDown: "Counted: wings covered, centre empty.",
      developUp: "Counted: pieces out early, entries in order.",
      developDown: "Counted: pieces held back, entry noted.",
    },
    pistonia: {
      boldUp: "Reading: earlier contact. Verdict stands.",
      boldDown: "Reading: delayed strike. No faults.",
      materialUp: "Reading: loose material collected. Fan steady.",
      materialDown: "Reading: material released. Line clean.",
      centerUp: "Reading: centre held. Measured.",
      centerDown: "Reading: wings measured, centre open.",
      developUp: "Reading: deployment early. Zero faults.",
      developDown: "Reading: pieces held. Verdict unchanged.",
    },
    culinia: {
      boldUp: "Petit rappel : montée au feu plus tôt, et c'était à point.",
      boldDown: "Petit rappel : mijoté plus longtemps, servi à point.",
      materialUp: "Au service : tout goûté, rien laissé refroidir.",
      materialDown: "Au service : quelques pièces laissées, la sauce a pris.",
      centerUp: "Côté fourneau : le centre était mon plat ce soir.",
      centerDown: "Côté fourneau : service sur les ailes, ça a tenu.",
      developUp: "Côté fourneau : sortie plus tôt, sans brûler.",
      developDown: "Côté fourneau : pièces gardées au chaud, et c'était bon.",
    },
  };

  function growthLine(key) {
    const grown = grownTrait(key);
    if (!grown) return "";
    const pool = GROWTH_LINES[key];
    if (!pool) return "";   // each sister speaks her own growth, never another's lines
    return pool[grown.trait + (grown.up ? "Up" : "Down")] || "";
  }

  function growthEndLine(key) {
    const grown = grownTrait(key);
    if (!grown) return "";
    const pool = GROWTH_END[key];
    if (!pool) return "";
    return pool[grown.trait + (grown.up ? "Up" : "Down")] || "";
  }

  // Chips follow the companion's own SFW switch (hq_companion_nsfw): the SFW set is a badge with the initial, the
  // adult set is the portrait. Transferania has no SFW chip render, so she falls back to her initial there.
  const CHIP = {
    else: {
      sfw: {
        src: "/assets/companion/else-chip-sfw.webp",
        srcset: "/assets/companion/else-chip-sfw.webp 1x, /assets/companion/else-chip-sfw@2x.webp 2x",
      },
      nsfw: {
        src: "/assets/companion/else-chip.webp",
        srcset: "/assets/companion/else-chip.webp 1x, /assets/companion/else-chip@2x.webp 2x",
      },
    },
    transferania: {
      sfw: {
        src: "/assets/companion/transferania-chip-sfw.webp",
        srcset: "/assets/companion/transferania-chip-sfw.webp 1x, /assets/companion/transferania-chip-sfw@2x.webp 2x",
      },
      nsfw: { src: "/assets/companion/transferania-adult-neutral.jpg", srcset: "" },
    },
    // The other assistants have their own published chips; where no SFW render or no adult chip exists, the badge
    // keeps the picture it has rather than showing a letter.
    securia: {
      sfw: { src: "/assets/companion/securia-chip-sfw.webp", srcset: "" },
      nsfw: { src: "/assets/companion/securia-chip-nsfw.webp", srcset: "" },
    },
    pistonia: {
      sfw: {
        src: "/assets/companion/pistonia-chip-sfw.webp",
        srcset: "/assets/companion/pistonia-chip-sfw.webp 1x, /assets/companion/pistonia-chip-sfw@2x.webp 2x",
      },
      nsfw: {
        src: "/assets/companion/pistonia-chip.webp",
        srcset: "/assets/companion/pistonia-chip.webp 1x, /assets/companion/pistonia-chip@2x.webp 2x",
      },
    },
    inventoria: {
      sfw: {
        src: "/assets/companion/inventoria-chip-sfw.webp",
        srcset: "/assets/companion/inventoria-chip-sfw.webp 1x, /assets/companion/inventoria-chip-sfw@2x.webp 2x",
      },
      nsfw: {
        src: "/assets/companion/inventoria-chip.webp",
        srcset: "/assets/companion/inventoria-chip.webp 1x, /assets/companion/inventoria-chip@2x.webp 2x",
      },
    },
    culinia: {
      sfw: { src: "/assets/companion/culinia-chip-sfw.webp", srcset: "" },
      nsfw: { src: "/assets/companion/culinia-chip-sfw.webp", srcset: "" },
    },
    forgia: {
      sfw: { src: "/assets/companion/forgia-chip-sfw.webp", srcset: "" },
      nsfw: { src: "/assets/companion/forgia-chip-sfw.webp", srcset: "" },
    },
    musica: {
      sfw: null,   // no published SFW chip: her badge shows the initial
      nsfw: {
        src: "/assets/companion/musica-chip-nsfw-notail-noears.webp",
        srcset: "/assets/companion/musica-chip-nsfw-notail-noears.webp 1x, /assets/companion/musica-chip-nsfw-notail-noears@2x.webp 2x",
      },
    },
    static: {
      sfw: { src: "/assets/companion/static-chip-sfw.webp", srcset: "" },
      nsfw: { src: "/assets/companion/static-chip-nsfw.webp", srcset: "" },
    },
  };
  const LS_NSFW = "hq_companion_nsfw";

  const GLYPH = { p: "\u265F", n: "\u265E", b: "\u265D", r: "\u265C", q: "\u265B", k: "\u265A" };
  const PIECE_FR = { p: "pion", n: "cavalier", b: "fou", r: "tour", q: "dame", k: "roi" };

  function pieceLabel(piece) {
    const type = piece.toLowerCase();
    const white = colorOf(piece) === "w";
    const colour = type === "q" ? (white ? "blanche" : "noire") : (white ? "blanc" : "noir");
    return PIECE_FR[type] + " " + colour;
  }

  // ------------------------------------------------------------------ surface

  const SAVES_KEY = "hq_playground_saves_v1";
  const SAVE_LIMIT = 12;

  const game = {
    pos: parseFen(START_FEN),
    status: null,
    history: [],
    selected: null,
    cursor: sq("e2"),
    assistant: "else",
    rival: "",           // the sister she faces in a duel; "" means her designated rival
    mode: "solo",
    speaker: "else",
    paused: false,
    thinking: false,
    token: 0,
    timer: 0,
    line: "",
    lineBy: "else",
    hint: null,
    hintLabel: "",
    hintTimer: 0,
    flights: [],
    flash: -1,
  };
  const ui = {};

  try {
    const saved = localStorage.getItem("hq_playground_assistant");
    if (saved && ASSISTANTS[saved]) game.assistant = saved;
  } catch (_) { /* private mode: default assistant */ }

  game.lineBy = game.assistant;
  game.status = gameStatus(game.pos);

  function assistant() {
    return ASSISTANTS[game.speaker] || ASSISTANTS[game.assistant] || ASSISTANTS.else;
  }

  // A pool remembers the line it drew last, so the same remark never lands twice in a row — the back-and-forth of a
  // duel reads as a conversation instead of a loop.
  const lastPick = new WeakMap();

  function pick(list) {
    if (!list || !list.length) return "";
    if (list.length === 1) return list[0];
    const previous = lastPick.get(list);
    const candidates = previous == null ? list : list.filter((text) => text !== previous);
    const text = candidates[Math.floor(Math.random() * candidates.length)] || list[0];
    lastPick.set(list, text);
    return text;
  }

  function lineFor(kind, vars, key) {
    const who = key || game.speaker || game.assistant;
    const pool = LINES[who] || LINES.else;
    const list = pool[kind] || pool.idle;
    return interpolate(pick(list), vars, who);
  }

  // In a duel the two of them talk to each other, not to the Master: the line lands in the speaker's card, so the
  // teasing reads as a back-and-forth between the sisters while the game plays itself.
  const DUEL_KINDS = {
    start: "start", capture: "capture", check: "check", mateWin: "win", mateLose: "lose", draw: "draw",
    hanging: "hanging", queens: "queens", lead: "lead", behind: "behind", endgame: "endgame",
    develop: "develop", central: "central", push: "push", queen: "queen", castle: "castle",
    promote: "promote", move: "move",
  };

  function duelLine(kind, vars, key) {
    const who = key || game.speaker || game.assistant;
    const pool = (LINES[who] && LINES[who].duel) || {};
    const list = pool[DUEL_KINDS[kind] || "move"] || pool.move || [];
    if (!list.length) return lineFor(kind, vars, who);
    return interpolate(pick(list), vars, who);
  }

  function helpLine(kind, vars, key) {
    const who = key || game.assistant;
    const pool = (LINES[who] && LINES[who].help) || {};
    const list = pool[kind] || pool.suggest || [];
    if (!list.length) return lineFor("idle", vars, who);
    return interpolate(pick(list), vars, who);
  }

  // `line` is the bubble on screen; `lineBy` remembers who said it, because the next player is already thinking
  // while that bubble is still readable.
  function says(text, key) {
    game.line = text;
    game.lineBy = key || game.speaker || game.assistant;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function build(host) {
    host.textContent = "";
    const shell = el("div", "pg-shell");

    // Three sections in one view: the table (the board and its cards), the classement read on its own (the ladder plus
    // each sister's preferred opening and lesson) and the growth leaderboard, which ranks the eight on what they learned.
    const views = el("div", "pg-switch");
    views.setAttribute("role", "tablist");
    views.setAttribute("aria-label", "Sections du Playground");
    const tabBoard = el("button", "pg-switch-btn is-on", "Plateau");
    tabBoard.type = "button";
    tabBoard.dataset.pgView = "board";
    tabBoard.setAttribute("role", "tab");
    tabBoard.setAttribute("aria-selected", "true");
    tabBoard.setAttribute("data-help", "L'échiquier, la carte de la sœur du moment et le classement aux points.");
    const tabRank = el("button", "pg-switch-btn", "Classement");
    tabRank.type = "button";
    tabRank.dataset.pgView = "ranking";
    tabRank.setAttribute("role", "tab");
    tabRank.setAttribute("aria-selected", "false");
    tabRank.setAttribute("data-help", "Le classement V–N–D, avec l'ouverture préférée de chaque sœur et la leçon que ses duels lui ont laissée.");
    const tabGrowth = el("button", "pg-switch-btn", "Croissance");
    tabGrowth.type = "button";
    tabGrowth.dataset.pgView = "growth";
    tabGrowth.setAttribute("role", "tab");
    tabGrowth.setAttribute("aria-selected", "false");
    tabGrowth.setAttribute("data-help", "Les huit sœurs classées sur ce que les duels leur ont appris : ouverture jouée, répliques retenues, leçon gardée.");
    views.append(tabBoard, tabRank, tabGrowth);

    const main = el("div", "pg-main");
    const bar = el("div", "pg-bar");
    const who = el("div", "pg-who");
    who.setAttribute("role", "group");
    who.setAttribute("aria-label", "Adversaire");
    Object.keys(ASSISTANTS).forEach((key) => {
      const chip = el("button", "pg-chip");
      const badge = el("span", "pg-chip-badge");
      badge.setAttribute("aria-hidden", "true");   // the chip's name is the button label, not "TTransferania"
      const badgeImg = document.createElement("img");
      badgeImg.alt = "";
      badgeImg.decoding = "async";
      badge.append(badgeImg, el("span", "pg-badge-initial"));
      chip.append(badge, document.createTextNode(ASSISTANTS[key].name));
      chip.type = "button";
      chip.dataset.pgAssistant = key;
      chip.setAttribute("aria-pressed", "false");
      chip.setAttribute("data-help", ASSISTANTS[key].name + " · " + ASSISTANTS[key].tag + " · " + ASSISTANTS[key].play);
      who.append(chip);
    });
    const actions = el("div", "pg-actions");
    const fresh = el("button", "secondary", "Nouvelle partie");
    fresh.type = "button";
    fresh.dataset.pgAction = "new";
    fresh.setAttribute("data-help", "Reposer l'échiquier de départ. Raccourci : N.");
    const rewind = el("button", "secondary", "Annuler le coup");
    rewind.type = "button";
    rewind.dataset.pgAction = "undo";
    rewind.setAttribute("data-help", "Revenir avant ton dernier coup. Raccourci : U.");
    const keep = el("button", "secondary", "Sauvegarder");
    keep.type = "button";
    keep.dataset.pgAction = "save";
    keep.setAttribute("data-help", "Garder cette partie dans les sauvegardes du navigateur. Raccourci : S.");
    const duo = el("button", "secondary", "Duo");
    duo.type = "button";
    duo.dataset.pgAction = "duo";
    duo.setAttribute("aria-pressed", "false");
    duo.setAttribute("data-help", "Jouer à deux : tu gardes les blancs, une sœur te souffle les coups et l'autre défend les noirs. Raccourci : E.");
    const duel = el("button", "secondary", "Duel");
    duel.type = "button";
    duel.dataset.pgAction = "duel";
    duel.setAttribute("aria-pressed", "false");
    duel.setAttribute("data-help", "Faire jouer deux sœurs l'une contre l'autre, à leur rythme. La paire se choisit dans la ligne « Duel » sous les commandes. Raccourci : D.");
    const pause = el("button", "secondary", "Pause");
    pause.type = "button";
    pause.dataset.pgAction = "pause";
    pause.hidden = true;
    pause.setAttribute("aria-pressed", "false");
    pause.setAttribute("data-help", "Geler le duel au coup près, puis le reprendre quand tu veux. Raccourci : P.");
    actions.append(fresh, rewind, keep, duo, duel, pause);
    bar.append(who, actions);

    // Which two sisters are on the board: shown only during a duel, so watching any pair is one pick away.
    const duelBar = el("div", "pg-duelbar");
    duelBar.hidden = true;
    const blackPick = document.createElement("select");
    blackPick.className = "pg-duel-select";
    blackPick.dataset.pgDuelSide = "b";
    blackPick.setAttribute("aria-label", "Assistante qui joue les noirs — la choisir lance le duel");
    const whitePick = document.createElement("select");
    whitePick.className = "pg-duel-select";
    whitePick.dataset.pgDuelSide = "w";
    whitePick.setAttribute("aria-label", "Assistante qui joue les blancs — la choisir lance le duel");
    Object.keys(ASSISTANTS).forEach((key) => {
      [blackPick, whitePick].forEach((select) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = ASSISTANTS[key].name;
        select.append(option);
      });
    });
    const shuffle = el("button", "secondary pg-duel-shuffle", "Au hasard");
    shuffle.type = "button";
    shuffle.dataset.pgDuelShuffle = "1";
    shuffle.setAttribute("data-help", "Deux sœurs tirées au hasard, et leur duel démarre aussitôt.");
    duelBar.append(el("span", "pg-duel-label", "Duel"), blackPick, el("span", "pg-duel-vs", "contre"), whitePick, shuffle);

    const status = el("p", "pg-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const board = el("div", "pg-board");
    board.setAttribute("role", "group");
    board.setAttribute("aria-label", "Échiquier, blancs en bas");
    board.id = "pg-board";
    for (let i = 0; i < 64; i += 1) {
      const cell = el("button", "pg-sq");
      cell.type = "button";
      cell.dataset.i = String(i);
      cell.tabIndex = -1;
      cell.append(el("span", "pg-glyph"));
      board.append(cell);
    }

    // Under the board: who has been meeting whom, and how those meetings went.
    const duels = el("div", "pg-duels");
    const duelsTitle = el("h3", "", "Duels");
    const duelsList = el("ul", "pg-duel-list");
    const duelsEmpty = el("p", "pg-duel-empty", "Aucun duel encore — choisis deux sœurs dans la ligne Duel.");
    const readsTitle = el("h3", "pg-read-title", "Lecture");
    const readsList = el("ul", "pg-read-list");
    const readsEmpty = el("p", "pg-read-empty", "Aucune lecture encore : un duel, et elle se remplit.");
    duels.append(duelsTitle, duelsList, duelsEmpty, readsTitle, readsList, readsEmpty);

    const form = el("form", "pg-entry");
    const field = el("input", "");
    field.type = "text";
    field.inputMode = "text";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.id = "pg-move";
    field.setAttribute("aria-label", "Entrer un coup (e2e4, e7e8q, O-O)");
    field.placeholder = "e2e4";
    const send = el("button", "secondary", "Jouer");
    send.type = "submit";
    form.append(field, send);

    const keys = el("p", "pg-keys");
    keys.id = "pg-keys";
    keys.textContent = "Clavier : flèches pour viser · Entrée ou Espace pour prendre puis poser · Échap pour annuler · N nouvelle partie · U annuler · A autre assistante · E duo avec une alliée · D duel (la paire se choisit sous les commandes, ou Au hasard) · P pause du duel · S sauvegarder · tape un coup (e2e4) dans le champ et Entrée.";
    main.append(bar, duelBar, status, board, duels, form, keys);

    const side = el("aside", "pg-side");
    const card = el("div", "pg-assistant");
    const name = el("strong", "pg-assistant-name");
    const tagline = el("span", "pg-assistant-tag");
    const quote = el("p", "pg-assistant-line");
    quote.setAttribute("aria-live", "polite");
    const avatar = el("div", "pg-avatar");
    avatar.setAttribute("aria-hidden", "true");
    const avatarImg = document.createElement("img");
    avatarImg.alt = "";
    avatarImg.decoding = "async";
    const avatarInitial = el("span", "pg-badge-initial");
    avatar.append(avatarImg, avatarInitial);
    const head = el("div", "pg-assistant-head");
    head.append(name, tagline);
    const top = el("div", "pg-assistant-top");
    top.append(avatar, head);
    // Her own growth, on her own card: how many games taught her and where the four traits sit now, every game.
    const growth = el("p", "pg-assistant-growth");
    const growthHead = el("span", "pg-growth-head");
    const growthTraits = el("span", "pg-growth-traits");
    const cardBook = el("span", "pg-card-book");
    growth.append(growthHead, growthTraits, cardBook);
    card.append(top, quote, growth);
    const log = el("div", "pg-history");
    const logTitle = el("h3", "", "Coups");
    const list = el("ol", "pg-moves");
    log.append(logTitle, list);
    const saves = el("div", "pg-saves");
    const savesTitle = el("h3", "", "Sauvegardes");
    const saveEmpty = el("p", "pg-save-empty", "Aucune partie gardée. « Sauvegarder » range la partie en cours ici.");
    const saveList = el("div", "pg-save-list");
    saves.append(savesTitle, saveEmpty, saveList);
    // A second, small board that never waits for the Master: two sisters play there on their own clock, so the
    // Playground feels occupied even when nobody is looking at it.
    const watchBox = el("div", "pg-watch");
    const watchTitle = el("h3", "", "Duel en fond");
    const watchBoard = el("div", "pg-watch-board");
    watchBoard.setAttribute("role", "img");
    watchBoard.setAttribute("aria-label", "Petit échiquier du duel en fond");
    for (let i = 0; i < 64; i += 1) {
      const cell = el("span", "pg-watch-sq");
      cell.append(el("span", "pg-watch-glyph"));
      watchBoard.append(cell);
    }
    const watchNames = el("p", "pg-watch-names");
    const watchStatus = el("p", "pg-watch-status");
    const watchOpen = el("button", "secondary pg-watch-open", "Ouvrir sur l'échiquier");
    watchOpen.type = "button";
    watchOpen.setAttribute("data-help", "Rejouer cette paire sur le grand échiquier. Le duel de fond, lui, continue tout seul.");
    watchBox.append(watchTitle, watchBoard, watchNames, watchStatus, watchOpen);

    const styles = el("div", "pg-styles");
    const stylesTitle = el("h3", "", "Styles appris");
    const styleList = el("ul", "pg-style-list");
    styles.append(stylesTitle, styleList);
    const ladder = el("div", "pg-ladder");
    const ladderTitle = el("h3", "", "Classement");
    const ladderList = el("ol", "pg-ladder-list");
    ladder.append(ladderTitle, ladderList);
    side.append(card, watchBox, styles, ladder, log, saves);

    // A section of its own: the roster ranked on what the duels taught, read from the same records the cards read. A
    // finished duel moves a row here without a reload.
    const growthView = el("section", "pg-growth");
    growthView.setAttribute("aria-label", "Classement de croissance");
    const growthPanelHead = el("div", "pg-growth-head");
    growthPanelHead.append(
      el("h2", "pg-growth-title", "Classement de croissance"),
      el("p", "pg-growth-lead", "Huit sœurs classées sur ce que les duels leur ont appris : l'ouverture qu'elles jouent vraiment, les répliques qu'elles ont retenues, la leçon qu'elles gardent. Le taux est celui de leur ouverture préférée ; les points V–N–D restent affichés à côté.")
    );
    // A way back to a clean slate: the duels write themselves into storage, so a seeded demonstration has to be
    // removable from the page itself instead of by hand in the browser console.
    const growthReset = el("button", "secondary pg-growth-reset", "Effacer les parties et les leçons");
    growthReset.type = "button";
    growthReset.dataset.pgGrowthReset = "1";
    growthReset.title = "Efface les parties, les styles appris et les leçons de famille des huit sœurs, puis repart d'une partie neuve. Un second clic confirme.";
    // A record worth keeping can leave the page before the reset wipes it, and come back from the same file: the
    // export carries the whole growth table and the duel journal, nothing derived.
    const growthTools = el("div", "pg-growth-tools");
    const growthExport = el("button", "secondary pg-growth-export", "Exporter la série");
    growthExport.type = "button";
    growthExport.dataset.pgGrowthExport = "1";
    growthExport.title = "Télécharge un fichier JSON avec les parties, les styles appris et les leçons des huit sœurs.";
    const growthImport = el("button", "secondary pg-growth-import", "Restaurer");
    growthImport.type = "button";
    growthImport.dataset.pgGrowthImport = "1";
    growthImport.title = "Recharge une série exportée plus tôt : elle remplace les parties et les leçons en place.";
    const growthFile = document.createElement("input");
    growthFile.type = "file";
    growthFile.accept = "application/json,.json";
    growthFile.className = "pg-growth-file";
    growthFile.dataset.pgGrowthFile = "1";
    growthFile.hidden = true;
    growthFile.setAttribute("aria-hidden", "true");
    growthFile.tabIndex = -1;
    const growthNote = el("p", "pg-growth-note");
    growthNote.setAttribute("role", "status");
    growthNote.setAttribute("aria-live", "polite");
    growthTools.append(growthExport, growthImport, growthFile);
    // A wipe should cost a click, not the series: the confirmed reset saves the records first unless this is unticked.
    const growthKeep = document.createElement("label");
    growthKeep.className = "pg-growth-keep";
    const growthKeepBox = document.createElement("input");
    growthKeepBox.type = "checkbox";
    growthKeepBox.checked = true;
    growthKeepBox.dataset.pgGrowthKeep = "1";
    growthKeep.append(growthKeepBox, el("span", "", "Sauvegarder avant d'effacer"));
    growthPanelHead.append(growthReset, growthTools, growthKeep, growthNote);
    const growthList = el("ol", "pg-growth-list");
    growthView.append(growthPanelHead, growthList);

    // The classement, readable on its own: the ladder in points, then each sister's real opening and the lesson her
    // duels taught her, so the ranking does not need the card or the growth table to be understood.
    const rankingView = el("section", "pg-ranking");
    rankingView.setAttribute("aria-label", "Classement");
    const rankingHead = el("div", "pg-growth-head");
    rankingHead.append(
      el("h2", "pg-growth-title", "Classement"),
      el("p", "pg-growth-lead", "Les huit sœurs au classement V–N–D, avec l'ouverture qu'elles jouent vraiment et la leçon que leurs duels leur ont laissée. Une sœur sans duel terminé garde un tiret : rien n'est inventé. Les boutons regroupent les mêmes lignes par ouverture, par leçon ou par style ; leur numéro reste leur place au classement.")
    );
    const rankSortBar = el("div", "pg-rank-sort");
    rankSortBar.setAttribute("role", "group");
    rankSortBar.setAttribute("aria-label", "Trier le classement");
    RANK_SORTS.forEach((pair) => {
      const button = el("button", "pg-switch-btn" + (pair[0] === rankSort ? " is-on" : ""), pair[1]);
      button.type = "button";
      button.dataset.pgRankSort = pair[0];
      button.setAttribute("aria-pressed", pair[0] === rankSort ? "true" : "false");
      button.title = pair[0] === "points" ? "L'ordre du classement aux points"
        : pair[0] === "opening" ? "Grouper les sœurs par l'ouverture qu'elles jouent vraiment"
          : pair[0] === "lesson" ? "Grouper les sœurs par la leçon que leurs duels leur ont laissée"
            : "Grouper les sœurs par le trait sur lequel leur jeu s'appuie";
      rankSortBar.append(button);
    });
    const rankingList = el("ol", "pg-rank-list");
    const progressTitle = el("h3", "pg-rank-title", "Progression des styles");
    const progressLead = el("p", "pg-growth-lead", "Le second classement ne compte pas les points : il mesure l'écart entre le style qu'elles jouent aujourd'hui et leur tempérament de naissance, tous traits confondus. Une sœur peut monter sans changer, ou grandir sans gagner.");
    const progressList = el("ol", "pg-rank-list pg-rank-list--progress");
    rankingView.append(rankingHead, rankSortBar, rankingList, progressTitle, progressLead, progressList);

    shell.append(views, main, side, rankingView, growthView);
    host.append(shell);

    ui.host = host;
    ui.board = board;
    ui.cells = Array.from(board.children);
    ui.status = status;
    ui.field = field;
    ui.form = form;
    ui.name = name;
    ui.tagline = tagline;
    ui.avatar = avatar;
    ui.quote = quote;
    ui.list = list;
    ui.undo = rewind;
    ui.chips = who;
    ui.send = send;
    ui.duo = duo;
    ui.duel = duel;
    ui.duelBar = duelBar;
    ui.blackPick = blackPick;
    ui.whitePick = whitePick;
    ui.pause = pause;
    ui.saveList = saveList;
    ui.saveEmpty = saveEmpty;
    ui.styleList = styleList;
    ui.ladderList = ladderList;
    ui.growthHead = growthHead;
    ui.growthTraits = growthTraits;
    ui.cardBook = cardBook;
    ui.duelList = duelsList;
    ui.duelEmpty = duelsEmpty;
    ui.readList = readsList;
    ui.readEmpty = readsEmpty;
    ui.watchBox = watchBox;
    ui.watchBoard = watchBoard;
    ui.watchNames = watchNames;
    ui.watchStatus = watchStatus;
    ui.watchOpen = watchOpen;
    ui.shell = shell;
    ui.growthList = growthList;
    ui.growthResetButton = growthReset;
    ui.rankList = rankingList;
    ui.progressList = progressList;
    ui.rankSort = Array.from(rankSortBar.children);
    ui.tabs = [tabBoard, tabRank, tabGrowth];

    // The companion page can flip the SFW switch while the Playground is open: follow it live.
    const refreshBadges = () => paintChips();
    window.addEventListener("hq:companion-nsfw", refreshBadges);
    window.addEventListener("storage", (event) => {
      if (!event || !event.key || event.key === LS_NSFW) refreshBadges();
    });

    who.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-pg-assistant]");
      if (chip) setAssistant(chip.dataset.pgAssistant);
    });
    views.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-pg-view]");
      if (tab) setPlaygroundView(tab.dataset.pgView);
    });
    growthView.addEventListener("click", (event) => {
      if (event.target.closest("[data-pg-growth-export]")) {
        growthNote.textContent = exportGrowth() ? "Série exportée : le fichier est dans les téléchargements." : "L'export n'a pas pu être téléchargé ici.";
        return;
      }
      if (event.target.closest("[data-pg-growth-import]")) {
        growthFile.value = "";
        growthFile.click();
        return;
      }
      const button = event.target.closest("[data-pg-growth-reset]");
      if (!button) return;
      if (button.dataset.armed !== "1") {
        button.dataset.armed = "1";
        button.classList.add("is-armed");
        button.textContent = "Confirmer l'effacement";
        button.setAttribute("aria-pressed", "true");
        clearTimeout(growthResetTimer);
        growthResetTimer = setTimeout(disarmGrowthReset, 6000);
        return;
      }
      const worthSaving = growthKeepBox.checked && growthRecorded();
      if (worthSaving && !exportGrowth()) {
        disarmGrowthReset();
        growthNote.textContent = "L'export a échoué : la table n'a pas été effacée, rien n'est perdu.";
        return;
      }
      clearGrowth();
      disarmGrowthReset();
      growthNote.textContent = worthSaving
        ? "Série enregistrée dans les téléchargements, puis table effacée : les huit sœurs repartent de leur tempérament, et un nouveau duel a commencé."
        : "Table effacée : les huit sœurs repartent de leur tempérament, et un nouveau duel a commencé.";
    });
    growthFile.addEventListener("change", () => {
      const file = growthFile.files && growthFile.files[0];
      if (!file) return;
      file.text()
        .then((text) => { growthNote.textContent = restoreGrowth(text); })
        .catch(() => { growthNote.textContent = "Le fichier n'a pas pu être lu."; });
      growthFile.value = "";
    });
    rankSortBar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-pg-rank-sort]");
      if (!button) return;
      const next = button.dataset.pgRankSort;
      if (next === rankSort) return;
      rankSort = next;
      (ui.rankSort || []).forEach((tab) => {
        const on = tab.dataset.pgRankSort === rankSort;
        tab.classList.toggle("is-on", on);
        tab.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderRanking();
    });
    blackPick.addEventListener("change", () => setDuelSide("b", blackPick.value));
    whitePick.addEventListener("change", () => setDuelSide("w", whitePick.value));
    duelBar.addEventListener("click", (event) => {
      if (event.target.closest("[data-pg-duel-shuffle]")) shuffleDuel();
    });
    actions.addEventListener("click", (event) => {
      const button = event.target.closest("[data-pg-action]");
      if (!button) return;
      const action = button.dataset.pgAction;
      if (action === "new") newGame();
      else if (action === "undo") undo();
      else if (action === "save") saveCurrent();
      else if (action === "duo") toggleDuo();
      else if (action === "duel") toggleDuel();
      else if (action === "pause") togglePause();
    });
    watchOpen.addEventListener("click", openWatchDuel);
    watchBoard.addEventListener("click", openWatchDuel);
    saveList.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-pg-save-del]");
      if (remove) { deleteSave(remove.dataset.pgSaveDel); return; }
      const open = event.target.closest("[data-pg-save]");
      if (open) loadSave(open.dataset.pgSave);
    });
    board.addEventListener("click", (event) => {
      const cell = event.target.closest(".pg-sq");
      if (cell) onCell(Number(cell.dataset.i));
    });
    board.addEventListener("keydown", (event) => {
      const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
      if (step) {
        event.preventDefault();
        moveCursor(step[0], step[1]);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        moveCursor(0, event.key === "Home" ? -(game.cursor & 7) : 7 - (game.cursor & 7));
      }
    });
    host.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const tag = (event.target && event.target.tagName ? event.target.tagName : "").toLowerCase();
      if (event.key === "Escape") { deselect(); return; }
      if (tag === "input" || tag === "textarea") return;
      const key = String(event.key || "").toLowerCase();
      if (key === "n") { event.preventDefault(); newGame(); }
      else if (key === "u") { event.preventDefault(); undo(); }
      else if (key === "a") { event.preventDefault(); cycleAssistant(); }
      else if (key === "e") { event.preventDefault(); toggleDuo(); }
      else if (key === "d") { event.preventDefault(); toggleDuel(); }
      else if (key === "s") { event.preventDefault(); saveCurrent(); }
      else if (key === "p") { event.preventDefault(); togglePause(); }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      playTyped(field.value);
      field.value = "";
    });
  }

  function paint() {
    if (!ui.board) return;
    const pos = game.pos;
    const status = game.status || gameStatus(pos);
    const selected = game.selected;
    const targets = selected == null ? [] : (status.moves || []).filter((m) => m.from === selected).map((m) => m.to);
    const last = game.history.length ? game.history[game.history.length - 1].move : null;
    const checkedKing = status.over && status.reason === "checkmate"
      ? findKing(pos.board, other(status.winner))
      : inCheck(pos, pos.turn) ? findKing(pos.board, pos.turn) : -1;

    ui.cells.forEach((cell, i) => {
      const piece = pos.board[i];
      const light = ((i >> 3) + (i & 7)) % 2 === 0;
      cell.className = "pg-sq " + (light ? "is-light" : "is-dark");
      cell.querySelector(".pg-glyph").textContent = piece ? GLYPH[piece.toLowerCase()] : "";
      if (piece) cell.classList.add(colorOf(piece) === "w" ? "is-white" : "is-black");
      if (selected === i) cell.classList.add("is-selected");
      if (targets.includes(i)) cell.classList.add("is-target");
      if (last && (last.from === i || last.to === i)) cell.classList.add("is-last");
      if (checkedKing === i) cell.classList.add("is-check");
      if (game.cursor === i) cell.classList.add("is-cursor");
      if (game.flash === i) cell.classList.add("is-hit");
      cell.tabIndex = game.cursor === i ? 0 : -1;
      const label = nameOf(i) + (piece ? " · " + pieceLabel(piece) : " · vide");
      cell.setAttribute("aria-label", label + (selected === i ? ", sélectionnée" : targets.includes(i) ? ", cible" : ""));
    });

    const flights = game.flights;
    game.flights = [];
    flights.forEach(slideGlyph);
    const hit = game.flash;
    game.flash = -1;
    if (hit >= 0 && ui.cells[hit]) setTimeout(() => ui.cells[hit].classList.remove("is-hit"), 400);

    ui.status.textContent = statusText(status);
    // The bubble belongs to whoever just spoke, not to whoever is thinking about the next move.
    const lineBy = game.lineBy || game.speaker;
    const speaker = ASSISTANTS[lineBy] || assistant();
    ui.name.textContent = speaker.name;
    ui.tagline.textContent = taglineFor(lineBy);
    if (ui.growthHead) {
      const games = growthGames(lineBy);
      ui.growthHead.textContent = games
        ? games + " partie" + (games > 1 ? "s" : "") + " · " + styleWord(lineBy)
        : "aucune partie · tempérament de base";
      ui.growthTraits.textContent = traitNumbers(lineBy);
      ui.growthHead.parentElement.title = styleDetail(lineBy);
    }
    renderCardBook();
    paintChips(lineBy);
    ui.quote.textContent = game.line;
    ui.undo.disabled = game.mode === "duel" || !game.history.length || game.thinking;
    if (ui.field) ui.field.disabled = game.mode === "duel";
    if (ui.send) ui.send.disabled = game.mode === "duel";
    if (ui.duel) {
      ui.duel.setAttribute("aria-pressed", game.mode === "duel" ? "true" : "false");
      ui.duel.textContent = game.mode === "duel" ? "Duel en cours" : "Duel";
    }
    if (ui.duo) {
      ui.duo.setAttribute("aria-pressed", game.mode === "duo" ? "true" : "false");
      ui.duo.textContent = game.mode === "duo" ? "Duo en cours" : "Duo";
    }
    if (ui.pause) {
      ui.pause.hidden = game.mode !== "duel";
      ui.pause.textContent = game.paused ? "Reprendre" : "Pause";
      ui.pause.setAttribute("aria-pressed", game.paused ? "true" : "false");
    }
    // In a duel both sisters are playing: the chosen one keeps the pressed state of a defender, the faced one lights up
    // with the slugging white side.
    const faced = game.mode === "duel" ? opponentOf() : "";
    Array.from(ui.chips.children).forEach((chip) => {
      const key = chip.dataset.pgAssistant;
      chip.setAttribute("aria-pressed", key === game.assistant || key === faced ? "true" : "false");
    });
    if (ui.duelBar) {
      // The pair stays on screen outside a duel too — one pick starts it — but a duo is not a duel and hides it.
      ui.duelBar.hidden = game.mode === "duo";
      ui.duelBar.classList.toggle("is-idle", game.mode !== "duel");
      if (game.mode !== "duo") {
        const whiteKey = game.mode === "duel" ? faced : rivalOf(game.assistant);
        if (ui.blackPick.value !== game.assistant) ui.blackPick.value = game.assistant;
        if (ui.whitePick.value !== whiteKey) ui.whitePick.value = whiteKey;
      }
    }
    ui.list.textContent = "";
    game.history.forEach((entry) => {
      const item = el("li", entry.actor === "you" ? "is-you" : "is-them");
      const who = entry.actor === "you" ? "Toi" : (ASSISTANTS[entry.by] || speaker).name;
      item.append(el("span", "pg-who-label", who));
      item.append(el("span", "pg-move-label", entry.label));
      ui.list.append(item);
    });
    renderStyles();
    renderLadder();
    renderDuels();
    renderReads();
    paintWatch();
    renderSaves();
  }

  // The glyph of the piece that just landed slides in from its old square: a FLIP with the two cell offsets, so a
  // knight arcs across the board and a castling rook travels with its king. Its own keyframes end on the resting
  // transform and the class is dropped on animationend, so a later selection lift still applies.
  function slideGlyph(flight) {
    const from = ui.cells && ui.cells[flight.from];
    const to = ui.cells && ui.cells[flight.to];
    if (!from || !to) return;
    const glyph = to.querySelector(".pg-glyph");
    if (!glyph || !glyph.textContent) return;
    const dx = from.offsetLeft - to.offsetLeft;
    const dy = from.offsetTop - to.offsetTop;
    if (!dx && !dy) return;
    const span = Math.max(Math.abs((flight.to >> 3) - (flight.from >> 3)), Math.abs((flight.to & 7) - (flight.from & 7)));
    glyph.style.setProperty("--pg-dx", dx + "px");
    glyph.style.setProperty("--pg-dy", dy + "px");
    glyph.style.setProperty("--pg-slide-dur", Math.min(380, 160 + span * 32) + "ms");
    glyph.classList.remove("is-moving");
    void glyph.offsetWidth;
    glyph.classList.add("is-moving");
    glyph.addEventListener("animationend", () => glyph.classList.remove("is-moving"), { once: true });
  }

  function adultMode() {
    try {
      if (typeof window.hqCompanionNsfwOn === "function") return !!window.hqCompanionNsfwOn();
    } catch (_) { /* the companion page is not loaded: fall back to the stored flag */ }
    try {
      return window.localStorage.getItem(LS_NSFW) === "1";
    } catch (_) {
      return false;
    }
  }

  function chipFor(key) {
    const variants = CHIP[key];
    if (!variants) return null;
    return adultMode() ? variants.nsfw : variants.sfw;
  }

  function paintBadge(box, key) {
    if (!box) return;
    const chip = chipFor(key);
    const img = box.querySelector("img");
    const initial = box.querySelector(".pg-badge-initial");
    box.classList.toggle("is-photo", !!chip);
    box.classList.toggle("is-initial", !chip);
    if (img) {
      if (chip) {
        if (img.getAttribute("src") !== chip.src) {
          img.setAttribute("src", chip.src);
          if (chip.srcset) img.setAttribute("srcset", chip.srcset);
          else img.removeAttribute("srcset");
        }
      } else {
        img.removeAttribute("src");
        img.removeAttribute("srcset");
      }
    }
    if (initial) initial.textContent = chip ? "" : (ASSISTANTS[key] || ASSISTANTS.else).name.slice(0, 1);
  }

  function paintChips(key) {
    if (!ui.chips) return;
    paintBadge(ui.avatar, key || game.speaker);
    Array.from(ui.chips.children).forEach((chip) => {
      paintBadge(chip.querySelector(".pg-chip-badge"), chip.dataset.pgAssistant);
    });
  }

  function taglineFor(key) {
    const who = ASSISTANTS[key] || ASSISTANTS.else;
    const grown = growthLabel(key);
    const tail = grown ? " · " + grown : "";
    if (game.mode === "duel") return (key === game.assistant ? "joue les noirs" : "joue les blancs") + " · " + who.tag + tail;
    if (game.mode === "duo") return (key === game.assistant ? "en face · " : "à tes côtés · ") + who.tag + tail;
    return "joue les noirs · " + who.tag + tail;
  }

  function statusText(status) {
    const black = ASSISTANTS[game.assistant] || ASSISTANTS.else;
    const white = ASSISTANTS[game.mode === "duel" ? opponentOf() : rivalOf(game.assistant)] || black;
    if (status.over) {
      if (status.reason === "checkmate") {
        if (game.mode === "duel") return "Échec et mat — " + (status.winner === "w" ? white.name : black.name) + " gagne.";
        return status.winner === "b" ? "Échec et mat — " + black.name + " gagne." : "Échec et mat — tu gagnes.";
      }
      if (status.reason === "repetition") return "Nulle par répétition — même position trois fois.";
      if (status.reason === "fifty") return "Nulle par la règle des cinquante coups — cent demi-coups sans prise ni poussée de pion.";
      return "Pat — partie nulle.";
    }
    if (game.paused) {
      const turn = game.pos.turn === "w" ? white.name : black.name;
      return "Duel en pause · trait à " + turn;
    }
    if (game.thinking) {
      const who = ASSISTANTS[game.speaker] || black;
      return who.name + " réfléchit…";
    }
    const check = inCheck(game.pos, game.pos.turn) ? " · échec" : "";
    if (game.selected != null) return "Pièce choisie — choisis sa case" + check;
    if (game.mode === "duel") {
      const turn = game.pos.turn === "w" ? white.name : black.name;
      return "Duel — " + white.name + " (blancs) contre " + black.name + " (noirs) · trait à " + turn + check;
    }
    if (game.mode === "duo") {
      const ally = ASSISTANTS[rivalOf(game.assistant)] || black;
      const turn = game.pos.turn === "w" ? "toi" : black.name;
      return "Duo — toi et " + ally.name + " contre " + black.name + " · trait à " + turn + check;
    }
    return (game.pos.turn === "w" ? "Trait à toi (blancs)" : "Trait à " + black.name) + check;
  }

  function focusCursor() {
    const cell = ui.cells && ui.cells[game.cursor];
    if (cell) cell.focus({ preventScroll: false });
  }

  function moveCursor(dr, dc) {
    const r = Math.min(7, Math.max(0, (game.cursor >> 3) + dr));
    const f = Math.min(7, Math.max(0, (game.cursor & 7) + dc));
    game.cursor = r * 8 + f;
    paint();
    focusCursor();
  }

  function select(index) {
    game.selected = index;
    game.cursor = index;
    paint();
  }

  function deselect() {
    if (game.selected == null) return;
    game.selected = null;
    paint();
  }

  function onCell(index) {
    game.cursor = index;
    if (game.mode === "duel" || game.thinking || game.status.over) {
      paint();
      return;
    }
    if (game.pos.turn !== "w") {
      paint();
      return;
    }
    const piece = game.pos.board[index];
    if (game.selected == null) {
      if (piece && colorOf(piece) === "w") select(index);
      else paint();
      return;
    }
    if (index === game.selected) {
      deselect();
      return;
    }
    const move = (game.status.moves || []).find((m) => m.from === game.selected && m.to === index);
    if (move) play(move);
    else if (piece && colorOf(piece) === "w") select(index);
    else deselect();
  }

  function moveLabel(pos, move) {
    const piece = pos.board[move.from];
    const type = piece.toLowerCase();
    if (type === "k" && Math.abs(move.to - move.from) === 2) return move.to > move.from ? "O-O" : "O-O-O";
    const capture = pos.board[move.to] || (type === "p" && move.to === pos.ep);
    return PIECE_FR[type] + " " + nameOf(move.from) + (capture ? "x" : "-") + nameOf(move.to)
      + (move.promo ? "=" + move.promo.toUpperCase() : "");
  }

  function play(move) {
    commit(move, "");
  }

  // A hidden tab (a phone that switched app, a panel behind another window) throttles setTimeout to about once a
  // minute: the reply would look frozen behind « réfléchit… ». A microtask always runs, so a hidden page answers at once.
  function scheduleThink(fn, ms) {
    if (typeof document !== "undefined" && document.hidden) {
      Promise.resolve().then(fn);
      return 0;
    }
    return setTimeout(fn, ms);
  }

  function clearHint() {
    if (game.hintTimer) clearTimeout(game.hintTimer);
    game.hintTimer = 0;
  }

  // A duel's closing line waits a beat so the result comment is readable first: resetting the board must drop it.
  function clearEndTimer() {
    if (game.endTimer) clearTimeout(game.endTimer);
    game.endTimer = 0;
  }

  function clearThink() {
    game.token += 1;
    if (game.timer) clearTimeout(game.timer);
    game.timer = 0;
    game.thinking = false;
    clearEndTimer();
    clearHint();
  }

  // In a duo your sister plays *with* you: she reads the position and offers one move, then watches what you choose.
  function offerHint() {
    game.hintTimer = 0;
    if (game.mode !== "duo" || game.paused || game.status.over || game.pos.turn !== "w") return;
    const ally = rivalOf(game.assistant);
    const move = bestMove(game.pos, Math.min(3, strengthFor(ally).depth), 320, strengthFor(ally).style, game.history, traitsFor(ally), baseTraits(ally));
    if (!move) return;
    const label = moveLabel(game.pos, move);
    game.hint = { from: move.from, to: move.to, promo: move.promo || "" };
    game.hintLabel = label;
    says(helpLine("suggest", { m: label, s: nameOf(move.to) }, ally), ally);
    paint();
  }

  // The wait before a reply follows the position instead of a fixed beat: more legal replies, more tension and a
  // check each buy a little more time, and Transferania never waits exactly like Else.
  function thinkDelay(pos, status, key) {
    const duel = {
      transferania: { base: 470, spread: 820, perMove: 28, cap: 2600 },
      else: { base: 960, spread: 700, perMove: 22, cap: 3600 },
    };
    const profile = game.mode === "duel"
      ? (duel[key] || { base: 800, spread: 900, perMove: 24, cap: 3400 })
      : { base: 320, spread: 300, perMove: 8, cap: 1200 };
    const legal = (status.moves || []).length;
    const tension = (status.moves || []).filter((m) => pos.board[m.to]).length;
    const checked = inCheck(pos, pos.turn) ? 1 : 0;
    const complexity = Math.min(profile.cap - profile.base, legal * profile.perMove + tension * 26 + checked * 420);
    const opening = pos.full <= 2 && game.mode === "duel" ? Math.round(profile.spread * 0.45) : 0;
    return Math.max(240, Math.min(profile.cap, Math.round(profile.base + Math.random() * profile.spread + complexity + opening)));
  }

  // Who she faces in a duel: the sister the Master picked on a chip, or her designated rival by default.
  function opponentOf() {
    if (game.rival && game.rival !== game.assistant && ASSISTANTS[game.rival]) return game.rival;
    return rivalOf(game.assistant);
  }

  // Which assistant owns a colour, if any: in a duel both colours are theirs, in solo only black is.
  function ownerOf(color) {
    if (game.mode === "duel") return color === "b" ? game.assistant : opponentOf();
    return color === "b" ? game.assistant : "";
  }

  function beginTurn() {
    if (!ui.board) return;
    const status = game.status || gameStatus(game.pos);
    if (status.over) {
      game.thinking = false;
      paint();
      announce();
      return;
    }
    if (game.paused) {
      game.thinking = false;
      paint();
      return;
    }
    const key = ownerOf(game.pos.turn);
    if (!key) {
      game.thinking = false;
      paint();
      if (game.mode === "duo") {
        clearHint();
        game.hintTimer = setTimeout(offerHint, 1400);   // let the opponent's jab land before the ally speaks
      }
      return;
    }
    if (game.thinking && game.timer) return;   // a reply is already on its way
    game.thinking = true;
    game.speaker = key;
    const token = ++game.token;
    paint();
    game.timer = scheduleThink(() => {
      if (token !== game.token) return;
      game.timer = 0;
      assistantReply(key);
    }, thinkDelay(game.pos, status, key));
  }

  function assistantReply(key) {
    const status = game.status;
    if (!status || status.over || ownerOf(game.pos.turn) !== key) {
      clearThink();
      paint();
      return;
    }
    const who = key || game.speaker;
    const profile = strengthFor(who);
    // In a duel she sits opposite one sister, and that sister's history is what she adjusts to.
    const faced = game.mode === "duel" ? opponentOf() : "";
    const tuned = duelTune(who, faced);
    game.plan = tuned.plan;
    game.planFaced = faced;
    notePlan(who, faced, tuned.plan);
    const move = bestMove(game.pos, profile.depth, profile.budget, profile.style, game.history, tuned.tune, baseTraits(who), tuned.shift, { style: prefsFor(who), ply: game.history.length, first: game.history[0] && game.history[0].move, deepPlan: deepPlanFor(who, game.history) });
    if (!move) {
      clearThink();
      game.status = gameStatus(game.pos);
      paint();
      return;
    }
    commit(move, key);
  }

  // One path for both sides: the move is applied, its flights are queued for the board animation, and the comment
  // follows what the move actually does (mate, check, capture, castle, promotion, development, pawn push, queen).
  function commit(move, by) {
    const before = game.pos;
    const piece = before.board[move.from];
    const type = piece.toLowerCase();
    const captured = before.board[move.to] || (type === "p" && move.to === before.ep);
    const next = applyMove(before, move);
    const flights = [{ from: move.from, to: move.to }];
    if (type === "k" && Math.abs(move.to - move.from) === 2) {
      const row = move.from >> 3;
      const kingside = move.to > move.from;
      flights.push({ from: row * 8 + (kingside ? 7 : 0), to: row * 8 + (kingside ? 5 : 3) });
    }
    game.history.push({
      pos: before,
      move: move,
      label: moveLabel(before, move),
      actor: by ? "them" : "you",
      by: by || "",
      captured: !!captured,
      color: colorOf(piece),
    });
    game.flights = flights;
    game.flash = captured ? move.to : -1;
    if (by) game.speaker = by;
    game.pos = next;
    game.selected = null;
    game.cursor = move.to;
    game.status = gameStatus(next);
    game.status = settleDraw(game.status, game.history, next);
    if (game.status.over && !game.growthLogged) {
      game.growthLogged = true;   // one game, one lesson: the next one starts from where this one left her
      const gameId = "g" + Date.now();   // the id the duel line and the lesson share for this game
      // Every assistant who sat at this board learns from it: both sides of a duel, and the one who faced the Master
      // in solo or duo. Records stay per assistant — nobody who was not in the game is touched.
      const players = game.mode === "duel" ? { w: opponentOf(), b: game.assistant } : { w: "", b: game.assistant };
      learnFromGame(game.history, players, game.status.winner || "", gameId);
      if (game.mode === "duel") {
        noteDuel(opponentOf(), game.assistant, game.status.winner || "", game.status, game.history.length, gameId);
        // The sister who did not play the last move closes the duel: the result stays on the status line, and the bubble
        // carries what she takes from it. Silently skipped until a duel has actually moved her.
        const listener = by === game.assistant ? opponentOf() : game.assistant;
        const closing = growthEndLine(listener);
        if (closing) {
          clearEndTimer();
          game.endTimer = setTimeout(() => {
            game.endTimer = 0;
            if (!game.status || !game.status.over) return;
            says(closing, listener);
            paint();
          }, 1600);
        }
      }
    }
    if (by || game.status.over) {
      says(commentFor(before, move, captured, next, game.status, by || game.speaker), by || game.speaker);
    } else if (game.mode === "duo") {
      // Your ally called a move; she reacts to the one you actually chose, not the one she wanted.
      const ally = rivalOf(game.assistant);
      const agreed = !!game.hint && game.hint.from === move.from && game.hint.to === move.to
        && (game.hint.promo || "") === (move.promo || "");
      says(helpLine(agreed ? "agree" : "disagree", { m: moveLabel(before, move) }, ally), ally);
    }
    paint();
    announce();
    if (!game.status.over) beginTurn();
  }

  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  function pieceValue(piece) {
    return piece ? (PIECE_VALUE[piece.toLowerCase()] || 0) : 0;
  }

  function materialFor(pos, colour) {
    return pos.board.reduce((total, piece) => (piece && colorOf(piece) === colour ? total + pieceValue(piece) : total), 0);
  }

  // A square being attacked is not a blunder: it only reads as hanging when the cheapest attacker is worth less and
  // there is no recapture, which is what the sisters actually comment on.
  function leavesPieceHanging(next, move, status) {
    const moved = next.board[move.to];
    if (!moved) return false;
    const threats = (status.moves || []).filter((m) => m.to === move.to && next.board[m.to]);
    if (!threats.length) return false;
    const cheapest = threats.reduce((best, m) => (pieceValue(next.board[m.from]) < pieceValue(next.board[best.from]) ? m : best), threats[0]);
    if (pieceValue(moved) <= pieceValue(next.board[cheapest.from])) return false;
    const after = applyMove(next, cheapest);
    return !(legalMoves(after) || []).some((m) => m.to === cheapest.to && after.board[m.to]);
  }

  // Everything an assistant can notice about a move, most specific first. The list is the same for the whole roster:
  // each one then answers in her own vocabulary (LINES[key][fact]), so two different moves never share one generic
  // template. A fact with no pool for that assistant simply falls through to the next one.
  function factsFor(before, move, next, status, captured, mode) {
    const piece = before.board[move.from];
    const colour = colorOf(piece);
    const them = colour === "w" ? "b" : "w";
    const type = piece.toLowerCase();
    const victim = captured ? before.board[move.to] : null;
    if (status.over) return [status.winner === "" ? "draw" : (status.winner === colour ? "mateWin" : "mateLose")];
    const facts = [];
    if (inCheck(next, next.turn)) facts.push("check");
    if (victim && victim.toLowerCase() === "q") facts.push("queens");
    else if (captured) facts.push("capture");
    if (type === "k" && Math.abs(move.to - move.from) === 2) facts.push("castle");
    if (move.promo) facts.push("promote");
    if (!captured && leavesPieceHanging(next, move, status)) facts.push("hanging");
    if (mode === "duel") {
      const mine = materialFor(next, colour);
      const theirs = materialFor(next, them);
      const gap = mine - theirs;
      const gapBefore = materialFor(before, colour) - materialFor(before, them);
      if (gap > gapBefore && !victim) facts.push("lead");   // this move itself won material
      const queensNow = next.board.some((p) => p && p.toLowerCase() === "q");
      const queensBefore = before.board.some((p) => p && p.toLowerCase() === "q");
      if (!queensNow && (queensBefore || materialFor(before, colour) + materialFor(before, them) > 20)
        && mine + theirs <= 20) facts.push("endgame");   // the move that walked into it, not every move after
      // A standing material gap is context, not news: it colours the odd remark instead of every single move.
      if (gap <= -3 && Math.random() < 0.35) facts.push("behind");
      else if (gap >= 3 && Math.random() < 0.18) facts.push("lead");
    }
    if (!captured && (type === "n" || type === "b")) facts.push("develop");
    if (!captured && type === "q") facts.push("queen");
    if (type !== "k" || captured) {
      const file = move.to & 7;
      const rank = move.to >> 3;
      if ((file === 3 || file === 4) && (rank === 3 || rank === 4)) facts.push("central");
    }
    if (type === "p") facts.push("push");
    facts.push("move");
    return facts;
  }

  const PIECE_EN = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
  // The assistants who speak English in their lines: the piece word follows the speaker, not the pool.
  const ENGLISH = { musica: true, inventoria: true, pistonia: true };

  // Composition can start a clause with a piece name ("queen c8xc2") right after a full stop: a finished line always
  // opens its sentences with a capital, in both languages.
  function upperSentences(text) {
    return String(text || "").replace(/(^|[.!?]\s+)([a-zàâäçéèêëîïôöùûü])/g, (whole, lead, letter) => lead + letter.toUpperCase());
  }

  // The sister a duel line addresses: whoever she actually faces, her designated rival everywhere else.
  function sisterName(who) {
    if (game.mode === "duel") {
      const other = who === game.assistant ? opponentOf() : game.assistant;
      if (ASSISTANTS[other]) return ASSISTANTS[other].name;
    }
    return (ASSISTANTS[rivalOf(who)] || {}).name || "sa sœur";
  }

  function interpolate(text, vars, who) {
    const rival = sisterName(who);
    const english = !!ENGLISH[who];
    return upperSentences(String(text || "").replace(/\{(\w+)\}/g, (whole, name) => {
      if (name === "sister" || name === "rival") return rival;
      if (english && (name === "p" || name === "v")) return (name === "p" ? vars.pe : vars.ve) || whole;
      if (english && name === "m" && vars.me) return vars.me;
      return vars && vars[name] != null ? vars[name] : whole;
    }));
  }

  // The last sentence each assistant said, so a second fact landing in a pool that shares a phrase never repeats
  // her verbatim; the draw falls through to the next thing she noticed on the board.
  const lastLine = new Map();
  // Every finished sentence she has already said in this game. A pool line can be reused, the exact sentence cannot.
  const usedLine = new Map();

  function usedBy(who) {
    let set = usedLine.get(who);
    if (!set) { set = new Set(); usedLine.set(who, set); }
    return set;
  }

  function clearUsed() {
    usedLine.clear();
    lastLine.clear();
  }

  // "Échec" keeps its sense in lower case after an opening clause; "O-O" and numbers are left alone.
  function lowerFirst(text) {
    const first = text.charAt(0);
    if (!/[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜ]/.test(first)) return text;
    const soft = { "É": "é", "È": "è", "Ê": "ê", "À": "à", "Â": "â", "Ç": "ç", "Î": "î", "Ï": "ï", "Ô": "ô", "Ù": "ù", "Û": "û", "Ü": "ü" };
    return (soft[first] || first.toLowerCase()) + text.slice(1);
  }

  // Prefix + pool line + closing, drawn from her own openings and closings: two lines in a pool become dozens of
  // finished sentences, all still carrying the fact's own piece, square and move. Returns "" when all are taken.
  // Same idea said twice: "à point", "servi" and "chaud" are one concept, "compte" and "pièces" another. A closing
  // that only restates the pool line in other words is padding, so it is not offered for that line.
  const CONCEPTS = [
    ["à point", "servi", "prêt", "cuit", "chaud", "mijote", "réduit"],
    ["artefact", "artifact", "propre", "clean", "tirage"],
    ["compte", "count", "pièce", "pieces", "pièces", "nombre", "number", "points"],
    ["rien", "aucun", "nothing", " plus "],
    ["structure", "cadre", "frame", "pose"],
    ["tempo", "beat", " bar "],
  ];

  function conceptsOf(text) {
    const body = " " + String(text || "").toLowerCase() + " ";
    const hit = new Set();
    CONCEPTS.forEach((group, index) => {
      if (group.some((word) => body.indexOf(word) !== -1)) hit.add(index);
    });
    return hit;
  }

  function distinctClauses(core, list) {
    const bodyWords = new Set(String(core || "").toLowerCase().replace(/[`{}]/g, "").split(/[^a-zà-ÿ0-9']+/).filter((w) => w.length > 3));
    const coreConcepts = conceptsOf(core);
    const keep = (entry) => {
      if (!entry) return true;
      const words = String(entry).toLowerCase().replace(/[`{}]/g, "").split(/[^a-zà-ÿ0-9']+/).filter((w) => w.length > 3);
      if (words.some((word) => bodyWords.has(word))) return false;
      for (const concept of conceptsOf(entry)) if (coreConcepts.has(concept)) return false;
      return true;
    };
    const kept = list.filter(keep);
    return [""].concat(kept);
  }

  // Which opening/closing pair she used last: the next line avoids the same shape even when the pool repeats, so two
  // moves never read like the same sentence with another square dropped in.
  const lastShape = new Map();

  // An opening and a closing that say the same word or the same thing ("Tu sens ça, Maître ?" … "Rien qu'à nous deux,
  // Maître.") read as a stutter too, so that pair is not offered.
  function clauseConflict(a, b) {
    if (!a || !b) return false;
    const words = (text) => String(text).toLowerCase().replace(/[`{}]/g, "").split(/[^a-zà-ÿ0-9']+/).filter((w) => w.length > 3);
    const left = new Set(words(a));
    if (words(b).some((word) => left.has(word))) return true;
    const first = conceptsOf(a);
    for (const concept of conceptsOf(b)) if (first.has(concept)) return true;
    return false;
  }

  function composeLine(who, core, vars, taken) {
    const style = STYLE[who] || STYLE.else;
    // A pool line that already opens with its own clause ("From memory: …", "`note, atelier` — …") keeps it alone;
    // stacking a second opening in front would read as "Listen: from memory: d6".
    const opensWithClause = core.slice(0, 24).indexOf(":") !== -1 || /^`[^`]*`\s*[—:-]/.test(core);
    const prefixes = opensWithClause ? [""] : distinctClauses(core, style.prefix || []);
    const suffixes = distinctClauses(core, style.suffix || []);
    const total = prefixes.length * suffixes.length;
    const start = Math.floor(Math.random() * total);
    const previous = lastShape.get(who) || "";
    let shapeFallback = null;
    for (let step = 0; step < total; step += 1) {
      const index = (start + step) % total;
      const pre = prefixes[index % prefixes.length];
      const suf = suffixes[Math.floor(index / prefixes.length) % suffixes.length];
      if (clauseConflict(pre, suf)) continue;
      const body = pre ? pre + lowerFirst(core) : core;
      const text = interpolate(body + suf, vars, who);
      if (taken.has(text)) continue;
      const shape = pre + "|" + suf;
      if (!shapeFallback) shapeFallback = { text, shape };
      if (shape !== previous) {
        lastShape.set(who, shape);
        return { text, shape };
      }
    }
    if (shapeFallback) lastShape.set(who, shapeFallback.shape);
    return shapeFallback || { text: "", shape: "" };
  }

  function lineFromFacts(facts, vars, key, mode) {
    const who = key || game.speaker || game.assistant;
    const pool = LINES[who] || LINES.else;
    const duel = mode === "duel" ? (pool.duel || null) : null;
    const source = duel || pool;
    const order = [];
    for (const fact of facts) {
      const list = source[(duel ? DUEL_KINDS[fact] : fact) || ""];
      if (list && list.length) order.push({ fact: fact, list: list });
    }
    const taken = usedBy(who);
    if (!order.length) {
      const list = (duel && (duel.move || duel.start)) || pool.idle || [];
      const made = composeLine(who, pick(list), vars, taken);
      const line = made.text || interpolate(pick(list), vars, who);
      taken.add(line);
      lastLine.set(who, (lastLine.get(who) || []).concat([line]).slice(-3));
      return { fact: "idle", line: line };
    }
    const previous = lastLine.get(who) || [];
    // Walk the facts from the most specific down, each pool rotated from its own random start, and take the first
    // sentence she has not said yet in this game — first preferring one she has not said last either.
    const candidates = [];
    for (const entry of order.slice(0, 5)) {
      const offset = Math.floor(Math.random() * entry.list.length);
      for (let i = 0; i < entry.list.length; i += 1) candidates.push({ fact: entry.fact, core: entry.list[(offset + i) % entry.list.length] });
    }
    for (const pass of [true, false]) {
      for (const candidate of candidates) {
        const made = composeLine(who, candidate.core, vars, taken);
        const line = made.text;
        if (!line || (pass && previous.indexOf(line) !== -1)) continue;
        taken.add(line);
        lastLine.set(who, previous.concat([line]).slice(-3));
        return { fact: candidate.fact, line: line, core: candidate.core, shape: made.shape };
      }
    }
    // Only reachable if this assistant has literally said every combination for every fact she noticed.
    const line = interpolate(candidates[0].core, vars, who);
    lastLine.set(who, previous.concat([line]).slice(-3));
    return { fact: candidates[0].fact, line: line, core: candidates[0].core, shape: "|" };
  }

  function commentFor(before, move, captured, next, status, key, mode) {
    return commentDetail(before, move, captured, next, status, key, mode).line;
  }

  function commentDetail(before, move, captured, next, status, key, mode) {
    const piece = before.board[move.from];
    if (!piece) return { fact: "idle", line: lineFor("idle", null, key) };
    const type = piece.toLowerCase();
    const victim = captured ? before.board[move.to] : null;
    const label = moveLabel(before, move);
    const vars = {
      p: PIECE_FR[type],
      s: nameOf(move.to),
      f: nameOf(move.from),
      m: label,
      // The same move label for the assistants who speak English: "knight b1-c3", not "cavalier b1-c3".
      me: /^O-O/.test(label) ? label : PIECE_EN[type] + label.slice(PIECE_FR[type].length),
      v: victim ? PIECE_FR[victim.toLowerCase()] : "",
      pe: PIECE_EN[type],
      ve: victim ? PIECE_EN[victim.toLowerCase()] : "",
    };
    return lineFromFacts(factsFor(before, move, next, status, captured, mode || game.mode), vars, key, mode || game.mode);
  }

  function announce() {
    if (!ui.status) return;
    // Re-assigning the same string is silent for screen readers; a trailing marker keeps the update audible.
    ui.status.textContent = statusText(game.status) + (game.status.over ? "" : " ");
  }

  function playTyped(raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    if (game.mode === "duel") {
      says("En duel, elles jouent seules — repasse en solo pour prendre les blancs.");
      paint();
      return;
    }
    if (/^o-o(-o)?$/i.test(text)) {
      const kingside = text.length === 3;
      const move = (game.status.moves || []).find((m) => game.pos.board[m.from].toLowerCase() === "k" && Math.abs(m.to - m.from) === 2 && (kingside ? m.to > m.from : m.to < m.from));
      if (move) { play(move); return; }
      says("Le roque n'est pas possible ici.");
      paint();
      return;
    }
    const m = /^([a-h][1-8])[-\s]?([a-h][1-8])([qrbn])?$/i.exec(text);
    if (!m) {
      says("Coup non reconnu — écris par exemple e2e4 ou e7e8q.");
      paint();
      return;
    }
    const from = sq(m[1].toLowerCase());
    const to = sq(m[2].toLowerCase());
    const promo = (m[3] || "").toLowerCase();
    const move = (game.status.moves || []).find((x) => x.from === from && x.to === to && (!x.promo || !promo || x.promo === promo));
    if (!move) {
      says("Coup impossible depuis cette position.");
      paint();
      return;
    }
    play(move);
  }

  function undo() {
    if (game.mode === "duel" || game.thinking || !game.history.length) return;
    let index = game.history.length - 1;
    while (index >= 0 && game.history[index].actor !== "you") index -= 1;
    if (index < 0) return;
    clearThink();
    game.pos = game.history[index].pos;
    game.history = game.history.slice(0, index);
    game.selected = null;
    game.status = gameStatus(game.pos);
    says(lineFor("undo", null, game.assistant), game.assistant);
    paint();
    focusCursor();
  }

  function newGame() {
    clearThink();
    clearUsed();
    game.pos = parseFen(START_FEN);
    game.history = [];
    game.selected = null;
    game.flights = [];
    game.flash = -1;
    game.hint = null;
    game.cursor = sq("e2");
    game.status = gameStatus(game.pos);
    // A duel opens on the sister holding white — the one being faced — with her growth line if duels moved her.
    const opener = game.mode === "duel" ? opponentOf() : game.assistant;
    game.speaker = opener;
    game.paused = false;
    game.growthLogged = false;
    says(game.mode === "duel" ? (growthLine(opener) || duelLine("start", null, opener)) : lineFor("start", null, opener), opener);
    paint();
    focusCursor();
    beginTurn();
  }

  function setAssistant(key) {
    if (!ASSISTANTS[key]) return;
    if (game.mode === "duel") {
      // In a duel a chip picks the sister you face: she takes white, the chosen assistant keeps black.
      if (key === game.assistant || key === opponentOf()) return;
      game.rival = key;
      newGame();
      return;
    }
    clearThink();
    game.assistant = key;
    game.rival = "";
    game.speaker = key;
    try { localStorage.setItem("hq_playground_assistant", key); } catch (_) { /* private mode */ }
    says(lineFor("start", null, key), key);
    paint();
    beginTurn();
  }

  function cycleAssistant() {
    const keys = Object.keys(ASSISTANTS);
    setAssistant(keys[(keys.indexOf(game.assistant) + 1) % keys.length]);
  }

  // Either side of a duel can be picked by name: black keeps the chosen assistant, white is whoever she faces.
  // Picking from solo starts the duel straight away, so watching any pair never needs the Duel button first.
  // Both seats settled: the duel starts at once, wherever the pair came from.
  function startDuel(black, white) {
    if (!ASSISTANTS[black] || !ASSISTANTS[white] || black === white) { paint(); return; }   // a sister cannot face herself
    clearThink();
    game.mode = "duel";
    game.assistant = black;
    game.rival = white;
    game.paused = false;
    game.hint = null;
    try { localStorage.setItem("hq_playground_assistant", black); } catch (_) { /* private mode */ }
    commitBook(black);
    commitBook(white);
    newGame();
  }

  function setDuelSide(side, key) {
    if (!ASSISTANTS[key]) return;
    let black = side === "b" ? key : game.assistant;
    let white = side === "w" ? key : opponentOf();
    if (black === white) {
      // The picked sister already holds the other seat: swap them, so changing pairs never needs a particular order.
      if (side === "b") white = game.assistant;
      else black = opponentOf();
    }
    startDuel(black, white);
  }

  // Two sisters drawn at random, their duel under way immediately — no need to browse the two selects.
  function shuffleDuel() {
    const keys = Object.keys(ASSISTANTS);
    const black = keys[Math.floor(Math.random() * keys.length)];
    let white = black;
    for (let guard = 0; guard < 32 && white === black; guard += 1) white = keys[Math.floor(Math.random() * keys.length)];
    if (white === black) white = keys[(keys.indexOf(black) + 1) % keys.length];
    startDuel(black, white);
  }

  // A duel hands both colours to the assistantes: the one you picked keeps black, her sister takes white, and the
  // human board controls go quiet until the duel is switched off again.
  function toggleDuel() {
    clearThink();
    game.mode = game.mode === "duel" ? "solo" : "duel";
    game.selected = null;
    game.speaker = game.assistant;
    game.paused = false;
    game.hint = null;
    game.growthLogged = false;   // the game this switch continues into gets its own lesson at the end
    if (game.mode === "duel") {
      if (game.status && game.status.over) { newGame(); return; }   // a finished board has nothing left to duel on
      // White moves first, so the opening jab comes from the sister she faces — and if duels have changed her, that is
      // what she opens with instead of the usual line.
      game.speaker = opponentOf();
      says(growthLine(game.speaker) || duelLine("start", null, game.speaker), game.speaker);
    } else {
      says("Retour en solo — tu reprends les blancs.", game.assistant);
    }
    paint();
    beginTurn();
  }

  // A duo teams you up with one sister against the other: your ally only speaks (one suggested move each turn), you
  // keep the white pieces, and the sister you picked defends black.
  function toggleDuo() {
    clearThink();
    game.mode = game.mode === "duo" ? "solo" : "duo";
    game.selected = null;
    game.speaker = game.assistant;
    game.hint = null;
    game.growthLogged = false;   // one game, one lesson, whichever mode it was played in
    if (game.mode === "duo") {
      says(helpLine("join", null, rivalOf(game.assistant)), rivalOf(game.assistant));
    } else {
      says("Retour en solo — tu reprends les blancs.", game.assistant);
    }
    paint();
    beginTurn();
  }

  // The duel clock only runs while the duel does: pausing clears the pending thinking timer, and resuming hands the
  // move to whoever was to play. The position itself never moves while paused.
  function togglePause() {
    if (game.mode !== "duel") return;
    game.paused = !game.paused;
    if (game.paused) {
      clearThink();
      says("Duel en pause — « Reprendre » quand tu veux.");
    } else {
      says("On reprend là où on s'était arrêtées.");
    }
    paint();
    if (!game.paused) beginTurn();
  }

  // ------------------------------------------------------------------ saved games

  function savesRead() {
    try {
      const raw = window.localStorage.getItem(SAVES_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter((save) => save && typeof save.id === "string" && Array.isArray(save.moves))
        : [];
    } catch (_) {
      return [];
    }
  }

  function savesWrite(list) {
    try {
      window.localStorage.setItem(SAVES_KEY, JSON.stringify(list.slice(0, SAVE_LIMIT)));
      return true;
    } catch (_) {
      return false;   // private mode or quota: the board keeps playing, nothing is kept
    }
  }

  function saveWhen(at) {
    try {
      return new Date(at).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "Partie gardée";
    }
  }

  function saveCurrent() {
    if (!game.history.length) {
      says("Rien à sauvegarder : la partie n'a pas commencé.");
      paint();
      return;
    }
    const save = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      mode: game.mode,
      assistant: game.assistant,
      rival: game.rival,
      moves: game.history.map((entry) => ({ f: entry.move.from, t: entry.move.to, p: entry.move.promo || "" })),
    };
    const list = [save].concat(savesRead()).slice(0, SAVE_LIMIT);
    if (!savesWrite(list)) {
      says("Ce navigateur refuse le stockage : partie non gardée.");
      paint();
      return;
    }
    says("Partie gardée (" + list.length + (list.length > 1 ? " sauvegardes)." : " sauvegarde)."));
    paint();
  }

  function deleteSave(id) {
    savesWrite(savesRead().filter((save) => save.id !== id));
    says("Sauvegarde retirée.");
    paint();
  }

  function loadSave(id) {
    clearUsed();
    const save = savesRead().find((entry) => entry.id === id);
    if (!save) return;
    clearThink();
    const savedRival = save.mode === "duel" && ASSISTANTS[save.rival] && save.rival !== save.assistant ? save.rival : "";
    let pos = parseFen(START_FEN);
    const history = [];
    for (const step of save.moves) {
      const move = legalMoves(pos).find((m) => m.from === step.f && m.to === step.t && (m.promo || "") === (step.p || ""));
      if (!move) break;
      const color = colorOf(pos.board[move.from]);
      const by = color === "b" ? save.assistant : (save.mode === "duel" ? (savedRival || rivalOf(save.assistant)) : "");
      history.push({ pos: pos, move: move, label: moveLabel(pos, move), actor: by ? "them" : "you", by: by, captured: false, color: color });
      pos = applyMove(pos, move);
    }
    if (!history.length) {
      says("Cette sauvegarde n'est plus lisible.");
      paint();
      return;
    }
    game.assistant = ASSISTANTS[save.assistant] ? save.assistant : game.assistant;
    game.rival = savedRival;
    game.mode = save.mode === "duel" ? "duel" : save.mode === "duo" ? "duo" : "solo";
    game.history = history;
    game.pos = pos;
    game.status = settleDraw(gameStatus(pos), history, pos);
    game.growthLogged = false;
    game.selected = null;
    game.flights = [];
    game.flash = -1;
    game.cursor = history[history.length - 1].move.to;
    game.speaker = history[history.length - 1].by || game.assistant;
    game.paused = false;
    game.hint = null;
    says("Partie rechargée — " + history.length + " coups.", game.speaker);
    paint();
    focusCursor();
    beginTurn();
  }

  // What each sister has become, readable per assistant: how many games taught her, the one trait the games moved
  // furthest from her own nature, and the numbers behind it in the row's tooltip. Works for any pair, because it reads
  // her own record and her own base — no designated rival involved.
  const TRAIT_NAMES = { bold: "mordant", material: "matériel", center: "centre", develop: "développement" };

  // The furthest she has moved from her own nature, however small: the panel names it and the tooltip gives the numbers.
  function strongestDrift(key) {
    const traits = traitsFor(key);
    const base = baseTraits(key);
    let pick = "";
    let gap = 0;
    for (const trait of TRAITS) {
      const delta = Math.abs(traits[trait] - base[trait]);
      if (delta > gap) { gap = delta; pick = trait; }
    }
    return pick && gap >= 0.005 ? { trait: pick, up: traits[pick] > base[pick] } : null;
  }

  function styleWord(key) {
    if (!growthGames(key)) return "tempérament de base";
    const drift = strongestDrift(key);
    if (!drift) return "encore elle-même";
    const label = TRAIT_LABELS[drift.trait];
    if (ENGLISH[key]) return drift.up ? label.upEn : label.downEn;
    return drift.up ? label.up : label.down;
  }

  function traitNumbers(key) {
    const traits = traitsFor(key);
    const base = baseTraits(key);
    return TRAITS.map((trait) => {
      const delta = traits[trait] - base[trait];
      return TRAIT_NAMES[trait] + " " + traits[trait].toFixed(2) + " (" + (delta >= 0 ? "+" : "−") + Math.abs(delta).toFixed(2) + ")";
    }).join(" · ");
  }

  function styleDetail(key) {
    const parts = traitNumbers(key);
    const record = growthRead()[key] || {};
    const last = record.with === "master" ? "le Maître" : (ASSISTANTS[record.with] ? ASSISTANTS[record.with].name : "");
    const faced = ASSISTANTS[record.vs] ? ASSISTANTS[record.vs].name : "";
    return parts
      + (last ? " · dernière partie : " + last : "")
      + (faced ? " · dernière sœur affrontée : " + faced : "");
  }

  // Wins and losses for all eight: three points a win, one a draw, then most wins, fewest losses, most games.
  // Everyone with no game yet sits at the bottom on zero, in the Playground's own order.
  const LADDER_ORDER = ["else", "transferania", "securia", "pistonia", "forgia", "musica", "inventoria", "culinia"];

  function ladderRows() {
    const all = growthRead();
    return LADDER_ORDER.map((key, index) => {
      const record = all[key] || {};
      const wins = Number(record.wins) || 0;
      const losses = Number(record.losses) || 0;
      const draws = Number(record.draws) || 0;
      return { key, index, wins, losses, draws, games: wins + losses + draws, points: wins * 3 + draws };
    }).sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || b.games - a.games || a.index - b.index);
  }

  // How the classement is being read: the ladder itself, or the same eight sisters grouped by what they play or by
  // what their duels taught them. Sorting is a reading order, never a new ranking — the number in front of each row
  // stays her real place on the ladder.
  const RANK_SORTS = [["points", "Points"], ["opening", "Ouverture"], ["lesson", "Leçon"], ["style", "Style"]];
  let rankSort = "points";

  // The trait a sister's play leans on most, measured against the temperament she was born with — the same four traits
  // the progression ranking prints, named here so the classement can be grouped by how she plays.
  function rankStyleOf(key) {
    if (growthGames(key) < 1) return "";
    const traits = traitsFor(key);
    const base = baseTraits(key);
    let pick = "";
    let lead = -Infinity;
    for (const trait of TRAITS) {
      const delta = Number(traits[trait]) - Number(base[trait]);
      if (!Number.isFinite(delta) || delta <= lead) continue;
      lead = delta;
      pick = trait;
    }
    return pick ? (TRAIT_NAMES[pick] || pick) : "";
  }

  function sortRankingRows(rows) {
    if (rankSort === "points") return rows;
    const copy = rows.slice();
    if (rankSort === "style") {
      const order = TRAITS.map((trait) => TRAIT_NAMES[trait] || trait);
      const rankOf = (row) => {
        const index = order.indexOf(row.styleName || "");
        return index < 0 ? order.length : index;
      };
      copy.sort((a, b) => rankOf(a) - rankOf(b) || a.position - b.position);
      return copy;
    }
    const field = rankSort === "opening" ? "habitName" : "lessonText";
    copy.sort((a, b) => {
      const left = String(a[field] || "");
      const right = String(b[field] || "");
      if (!left && !right) return a.position - b.position;
      if (!left) return 1;      // a sister without one falls to the end rather than topping the group
      if (!right) return -1;
      return left.localeCompare(right, "fr") || a.position - b.position;
    });
    return copy;
  }

  // The classement read on its own: the ladder order, the opening each sister actually plays, and the lesson her duels
  // left her with. Same records as the cards — a sister with no finished duel says nothing rather than naming a style
  // she never chose, and the view prints a dash for her.
  function rankingRows() {
    const all = growthRead();
    return ladderRows().map((row, position) => {
      const record = all[row.key] && typeof all[row.key] === "object" ? all[row.key] : {};
      const book = record.book && typeof record.book === "object" ? record.book : null;
      const stored = !!book && !!HABITS[book.white] && (Number(record.games) || 0) > 0;
      let habitName = "";
      let lesson = null;
      if (stored) {
        const profile = prefsFor(row.key);
        habitName = profile.habit ? profile.habit.name : "";
        lesson = profile.habitLesson || null;
      }
      return Object.assign({}, row, {
        position: position + 1,
        name: ASSISTANTS[row.key].name,
        stored: stored,
        habitName: habitName,
        lesson: lesson,
        lessonText: lesson ? lesson.text : "",
        styleName: rankStyleOf(row.key),
      });
    });
  }

  // The second ranking: how far her playstyle actually moved from the temperament she was born with. The four traits
  // are what the duels bend, so their distance from `baseTraits` is growth no point total can show — a sister can climb
  // the ladder without changing, or change without winning. The largest move names the direction that carries her.
  function styleGrowthRows() {
    const all = growthRead();
    return LADDER_ORDER.map((key, index) => {
      const record = all[key] && typeof all[key] === "object" ? all[key] : {};
      const games = Number(record.games) || 0;
      const base = baseTraits(key);
      const traits = traitsFor(key);
      let drift = 0;
      let gap = 0;
      let moved = "";
      let up = false;
      for (const trait of TRAITS) {
        const delta = Number(traits[trait]) - Number(base[trait]);
        if (!Number.isFinite(delta)) continue;
        drift += Math.abs(delta);
        if (Math.abs(delta) > gap + 0.0005) {
          gap = Math.abs(delta);
          moved = trait;
          up = delta > 0;
        }
      }
      const played = games > 0;
      return {
        key: key, index: index, name: ASSISTANTS[key].name, games: games, stored: played,
        drift: played ? Math.round(drift * 1000) / 1000 : 0,
        gap: played ? Math.round(gap * 1000) / 1000 : 0,
        trait: played ? moved : "",
        traitName: played && moved ? (TRAIT_NAMES[moved] || moved) : "",
        up: played ? up : false,
      };
    }).sort((a, b) => b.drift - a.drift || b.gap - a.gap || b.games - a.games || a.index - b.index)
      .map((row, position) => Object.assign({}, row, { position: position + 1 }));
  }

  // Every finished duel leaves a line here, and the board's list folds them per pair: a rivalry reads as one record,
  // so repeated meetings between the same two sisters stay visible.
  const DUELS_KEY = "hq_playground_duels";
  const DUELS_KEPT = 80;

  function duelsRead() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(DUELS_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      // Every game carries a stable id, including the ones written before the field existed: the timestamp is unique
      // enough per finished duel, and a lesson can then point at the exact line instead of at a rank that shifts.
      return raw
        .filter((entry) => entry && ASSISTANTS[entry.w] && ASSISTANTS[entry.b])
        .map((entry) => Object.assign({}, entry, { id: entry.id || (entry.at ? "g" + entry.at : "") }));
    } catch (_) {
      return [];
    }
  }

  // One line per finished duel: who held each colour, who won, how it ended and after how many half-moves. The ending
  // and the length are what let a sister read *how* a rival beat her, not only that she did.
  function noteDuel(white, black, winner, status, plies, gameId) {
    if (!ASSISTANTS[white] || !ASSISTANTS[black] || white === black) return;
    const list = duelsRead();
    const count = Number(plies);
    list.push({
      // The id the lesson of this same game will store, so a defeat can name the line it came from.
      id: gameId || "g" + Date.now(),
      w: white,
      b: black,
      win: winner === "w" ? white : winner === "b" ? black : "",
      at: Date.now(),
      end: status && status.reason ? status.reason : "",
      plies: Number.isFinite(count) ? count : 0,
    });
    const kept = list.slice(-DUELS_KEPT);
    try { window.localStorage.setItem(DUELS_KEY, JSON.stringify(kept)); } catch (_) { /* private mode */ }
    // Both sisters fold this game into their style, in their own record: the last duel is what their next one starts from.
    snapshotStyle(white, kept);
    snapshotStyle(black, kept);
    renderDuels();
    renderReads();
    renderGrowthBoard();   // a finished duel moves the growth table too, without a reload
    renderRanking();       // and the classement, which reads the same records
  }

  function duelPairs() {
    const pairs = new Map();
    for (const entry of duelsRead()) {
      const first = entry.w < entry.b ? entry.w : entry.b;
      const second = first === entry.w ? entry.b : entry.w;
      const key = first + "|" + second;
      let row = pairs.get(key);
      if (!row) {
        row = { a: first, b: second, aWins: 0, bWins: 0, draws: 0, games: 0, last: entry };
        pairs.set(key, row);
      }
      row.games += 1;
      if (!entry.win) row.draws += 1;
      else if (entry.win === row.a) row.aWins += 1;
      else row.bWins += 1;
      if ((entry.at || 0) >= (row.last.at || 0)) row.last = entry;
    }
    return Array.from(pairs.values()).sort((x, y) => (y.last.at || 0) - (x.last.at || 0)).slice(0, 8);
  }

  // ------------------------------------------------------------------ reading the log
  // The duel list is the memory they read. Each sister takes two things from it: her own style (what her record says
  // she does, folded into the traits the engine already steers with) and her read on a rival — what that rival did to
  // her, or to somebody else she only watched. Both are computed from stored data, never guessed.

  function meetingTally(entries, key, other) {
    const list = entries || [];
    const tally = { games: 0, wins: 0, losses: 0, draws: 0, mates: 0, matesAgainst: 0, plies: 0, avgPlies: 0, streak: 0, last: "" };
    for (const entry of list) {
      if (!entry || (entry.w !== key && entry.b !== key)) continue;
      if (entry.w !== other && entry.b !== other) continue;
      tally.games += 1;
      tally.plies += Number(entry.plies) || 0;
      if (!entry.win) { tally.draws += 1; tally.last = "nulle"; }
      else if (entry.win === key) { tally.wins += 1; tally.last = "victoire"; if (entry.end === "checkmate") tally.mates += 1; }
      else { tally.losses += 1; tally.last = "défaite"; if (entry.end === "checkmate") tally.matesAgainst += 1; }
    }
    // The run she is on matters more than the oldest defeat: the plan answers a streak, not a scar.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (!entry || (entry.w !== key && entry.b !== key)) continue;
      if (entry.w !== other && entry.b !== other) continue;
      if (entry.win && entry.win !== key) tally.streak += 1;
      else break;
    }
    tally.avgPlies = tally.games ? Math.round(tally.plies / tally.games) : 0;
    return tally;
  }

  // Games she was not part of, but where the rival was: what watching costs her nothing to know.
  function watchedTally(entries, key, other) {
    const list = entries || [];
    const tally = { games: 0, wins: 0, losses: 0, draws: 0, mates: 0, plies: 0, avgPlies: 0 };
    for (const entry of list) {
      if (!entry || entry.w === key || entry.b === key) continue;
      if (entry.w !== other && entry.b !== other) continue;
      tally.games += 1;
      tally.plies += Number(entry.plies) || 0;
      if (!entry.win) tally.draws += 1;
      else if (entry.win === other) { tally.wins += 1; if (entry.end === "checkmate") tally.mates += 1; }
      else tally.losses += 1;
    }
    tally.avgPlies = tally.games ? Math.round(tally.plies / tally.games) : 0;
    return tally;
  }

  // What she changes about her own play against one rival, read off the log. A sister who has been beaten twice by
  // the same opponent closes up and holds material; one who keeps winning keeps the habit; one who has only watched a
  // rival prepare for the danger that rival showed. A stranger changes nothing at all.
  // On, and narrowed by the per-trait gate below. The growth report keeps the same playout with the carry off, so the
  // trade it makes is readable rather than asserted; the switch exists for that comparison and for nothing else.
  const CARRY_TO_UNSEEN = !(typeof globalThis !== "undefined" && globalThis.HQ_CARRY === false);

  function planFor(key, other, entries) {
    const shift = { bold: 0, material: 0, center: 0, develop: 0 };
    const notes = [];
    const plan = { key: key, other: other, shift: shift, notes: notes, source: "", met: null, seen: null };
    if (!key || !other || other === key || !ASSISTANTS[key] || !ASSISTANTS[other]) return plan;
    const log = Array.isArray(entries) ? entries : duelsRead();
    const round = (value) => Math.round(value * 1000) / 1000;
    const met = meetingTally(log, key, other);
    plan.met = met;
    if (met.games) {
      plan.source = "directe";
      const beaten = Math.max(met.losses, met.streak);
      if (beaten >= 2) {
        const tight = Math.min(0.13, 0.045 * beaten + (met.matesAgainst ? 0.02 : 0));
        shift.bold = -round(tight);
        shift.material = round(tight * 0.6);
        shift.develop = -round(tight * 0.4);
        notes.push("resserre le jeu (" + beaten + " défaites)");
      } else if (met.losses === 1) {
        shift.bold = -0.03;
        shift.material = 0.02;
        notes.push("plus prudente depuis sa défaite");
      }
      if (met.wins >= 2) {
        shift.bold = round(shift.bold + 0.03);
        shift.center = round(shift.center + 0.02);
        notes.push("garde ce qui gagne (" + met.wins + " victoires)");
      }
      if (met.games >= 2 && met.draws === met.games) {
        shift.develop = round(shift.develop + 0.03);
        shift.bold = round(shift.bold + 0.015);
        notes.push("sort ses pièces pour éviter la nulle");
      }
    } else {
      const seen = watchedTally(log, key, other);
      plan.seen = seen;
      if (seen.games >= 2) {
        plan.source = "vue";
        const rate = Math.max(0, (seen.wins - seen.losses) / seen.games);
        shift.bold = -round(0.02 + 0.03 * rate);
        shift.center = round(0.015 + 0.02 * rate);
        notes.push("surveillée : " + seen.games + " parties vues");
      }
    }
    // What her own results taught her about this rival, weighed in on top of what the log says: the log counts wins and
    // losses, this remembers which way to lean and gets corrected every time it loses.
    const own = growthRead()[key];
    // Her accumulated lesson, for a sister she has no history with. A plan is knowledge about one rival, but the
    // direction it points at is also a statement about her own game, and that part carries: the house plan is the mean
    // of what she learned against everyone she has met, taken at half strength so it can never outweigh a plan of her
    // own. This is the channel that reaches a sister she has never played.
    if (CARRY_TO_UNSEEN && met.games === 0 && own && own.plans && typeof own.plans === "object") {
      const rivals = Object.keys(own.plans).filter((name) => ASSISTANTS[name]);
      if (rivals.length) {
        // Per trait, not wholesale. Her own results already moved her four numbers, so the direction of that drift is
        // what her games have taught her about herself; a plan component that points the other way is a guess about a
        // stranger, not a lesson, and it is not carried. This keeps what she learned against a studied sister intact
        // while still letting the direction she actually won with travel.
        const base = baseTraits(key);
        const mine = traitsFor(key);
        const carried = [];
        // A measurement may ask for one trait at a time, so the gate's verdict can be checked against the board
        // instead of asserted. Nothing in the app sets this.
        const only = typeof globalThis !== "undefined" ? globalThis.HQ_CARRY_ONLY : null;
        for (const trait of TRAITS) {
          let total = 0;
          for (const name of rivals) total += Number(own.plans[name] && own.plans[name][trait]) || 0;
          const mean = total / rivals.length;
          const learned = (Number(mine[trait]) || 1) - (Number(base[trait]) || 1);
          if (only !== trait) {
            if (Math.abs(mean) < 0.005) continue;
            if (Math.abs(learned) < 0.01 || (mean > 0) !== (learned > 0)) continue;
          }
          shift[trait] = round((Number(shift[trait]) || 0) + 0.5 * mean);
          carried.push(trait);
        }
        if (carried.length) notes.push("ce qu'elle a appris ailleurs (" + carried.join(", ") + ")");
      }
    }
    const learned = own && own.plans && own.plans[other] ? own.plans[other] : null;
    if (learned) {
      for (const trait of TRAITS) {
        const value = Number(learned[trait]);
        if (Number.isFinite(value) && value !== 0) shift[trait] = round((Number(shift[trait]) || 0) + value);
      }
    }
    return plan;
  }

  // A short, page-lived trace of the plans that actually went into a move: the UI shows the current one, and this is
  // what proves in a run that an adjustment read from the log reached the search instead of only the panel.
  const planTrace = [];

  function notePlan(key, other, plan) {
    if (!plan || !plan.notes || !plan.notes.length) return;
    planTrace.push({ key: key, other: other, source: plan.source, notes: plan.notes.slice(), at: Date.now() });
    if (planTrace.length > 40) planTrace.shift();
  }

  // What she plays with in this duel: the traits her games gave her, plus the plan the log gave her about this rival.
  // The two stay apart — the plan is searched as its own shift, so a trait already at its clamp cannot swallow it.
  function duelTune(key, other, entries) {
    const plan = planFor(key, other, entries);
    return { tune: traitsFor(key), plan: plan, shift: plan.shift };
  }

  // Her named first move, the one part of her style a sister can say out loud. It is read from her own numbers: the
  // more she likes to come out, the more central the pawn; the bolder she is, the more she takes e4 over d4. The same
  // habit decides the move she actually plays on move one, so the name on her card is never a label she does not live up to.
  const HABITS = {
    e4: { key: "e4", name: "1.e4", from: "e2", to: "e4" },
    d4: { key: "d4", name: "1.d4", from: "d2", to: "d4" },
    nf3: { key: "nf3", name: "1.Cf3", from: "g1", to: "f3" },
    c4: { key: "c4", name: "1.c4", from: "c2", to: "c4" },
    d3: { key: "d3", name: "1.d3", from: "d2", to: "d3" },
  };

  // Her answer as Black is still a habit, but it answers what White actually played on move one. The same style picks
  // a mood, the mood picks a named reply for that opening; every entry is legal whatever White played, so a reply is
  // never a fallback.
  const REPLIES = {
    e5: { key: "e5", name: "1…e5", from: "e7", to: "e5" },
    c5: { key: "c5", name: "1…c5", from: "c7", to: "c5" },
    d5: { key: "d5", name: "1…d5", from: "d7", to: "d5" },
    nf6: { key: "nf6", name: "1…Cf6", from: "g8", to: "f6" },
    e6: { key: "e6", name: "1…e6", from: "e7", to: "e6" },
    c6: { key: "c6", name: "1…c6", from: "c7", to: "c6" },
    g6: { key: "g6", name: "1…g6", from: "g7", to: "g6" },
  };

  const REPLY_KEYS = ["e4", "d4", "nf3", "c4", "d3"];
  // Ordered alternates per mood and opening. The first one is the style preference; the others are what she falls back
  // to when that answer has stopped holding, so a learned change is explainable rather than random.
  const REPLY_FALLBACKS = {
    sharp: {
      e4: ["c5", "e5", "c6"], d4: ["nf6", "c5", "e6"], nf3: ["c5", "nf6", "e6"],
      c4: ["e5", "nf6", "d5"], d3: ["c5", "e5", "d5"], other: ["c5", "e5", "d5"],
    },
    classical: {
      e4: ["e5", "c6", "d5"], d4: ["d5", "e6", "nf6"], nf3: ["d5", "nf6", "e6"],
      c4: ["e5", "c6", "d5"], d3: ["e5", "d5", "c6"], other: ["d5", "e5", "e6"],
    },
    developing: {
      e4: ["c6", "e6", "d5"], d4: ["e6", "d5", "c5"], nf3: ["d5", "e6", "c5"],
      c4: ["e6", "d5", "e5"], d3: ["d5", "e6", "c6"], other: ["d5", "e6", "c5"],
    },
    solid: {
      e4: ["d5", "e5", "e6"], d4: ["d5", "e6", "nf6"], nf3: ["d5", "nf6", "e6"],
      c4: ["e5", "d5", "e6"], d3: ["d5", "e5", "e6"], other: ["d5", "e5", "e6"],
    },
  };

  // Which first move she is answering: her own named openings are recognised by their squares, anything else is "other".
  const OPENING_KEYS = { e2e4: "e4", d2d4: "d4", g1f3: "nf3", c2c4: "c4", d2d3: "d3" };
  function openingKey(move) {
    if (!move) return "";
    return OPENING_KEYS[nameOf(move.from) + nameOf(move.to)] || "other";
  }

  function replyMood(opening, risk) {
    const open = Number.isFinite(Number(opening)) ? Number(opening) : 0.5;
    const bold = Number.isFinite(Number(risk)) ? Number(risk) : 0.5;
    if (bold >= 0.62) return "sharp";
    if (open >= 0.6) return "classical";
    if (open >= 0.4) return "developing";
    return "solid";
  }

  // A family is no longer only a style band: it is what her own black games have come to support. She starts in the
  // family her mood gives her, and when that whole table keeps losing she moves one family along her order — while a
  // sister who keeps holding her answers stays where she is, even inside the same band. That is what stops two sisters
  // in one band from sharing one reply table for good.
  const FAMILY_ORDER = ["sharp", "classical", "developing", "solid"];
  const FAMILY_WORDS = { sharp: "tranchante", classical: "classique", developing: "développement", solid: "solide" };

  function familyCell(black, family) {
    if (!black.familyLearn || typeof black.familyLearn !== "object" || Array.isArray(black.familyLearn)) black.familyLearn = {};
    const cell = black.familyLearn[family];
    if (cell && typeof cell === "object" && Array.isArray(cell.history)) return cell;
    const fresh = { games: 0, wins: 0, draws: 0, losses: 0, history: [] };
    black.familyLearn[family] = fresh;
    return fresh;
  }

  // The table of a named family, with the same long-term lean the style plan uses: one rule, two roads into it.
  function familyTable(family, lean) {
    const name = REPLY_FALLBACKS[family] ? family : "solid";
    const table = REPLY_FALLBACKS[name];
    const plan = { family: name };
    for (const slot of REPLY_KEYS.concat("other")) {
      const list = table[slot];
      plan[slot] = REPLIES[lean > 0.015 && list[1] ? list[1] : list[0]];
    }
    return plan;
  }

  // The next family along her order that her own results have not already ruled out. A table she played enough and never
  // won with is skipped, so a lesson never sends her back onto the answers that were losing.
  function nextFamilyKey(black, current) {
    const at = FAMILY_ORDER.indexOf(current);
    if (at < 0) return "";
    const tried = black.familyLearn && typeof black.familyLearn === "object" ? black.familyLearn : {};
    for (let step = 1; step < FAMILY_ORDER.length; step += 1) {
      const candidate = FAMILY_ORDER[(at + step) % FAMILY_ORDER.length];
      const cell = tried[candidate];
      const played = cell ? Number(cell.games) || 0 : 0;
      const won = cell ? Number(cell.wins) || 0 : 0;
      const lost = cell ? Number(cell.losses) || 0 : 0;
      if (played >= 3 && won === 0 && lost >= patienceFor(played)) continue;
      return candidate;
    }
    return "";
  }

  // One finished black game is one vote for the table she answered with. The family keeps its own record, so a sister is
  // judged on her replies even when the slot she met has only come up once: with a full sample and no win since, the
  // table itself is what failed, and she takes the next family while keeping every answer a result already taught her.
  function noteFamilyOutcome(black, family, result, key, slot) {
    const fam = familyCell(black, family);
    fam.games += 1;
    if (result === "w") fam.wins += 1; else if (result === "l") fam.losses += 1; else fam.draws += 1;
    fam.history.push({ result: result || "d", slot: slot || "", at: Date.now() });
    if (fam.history.length > 12) fam.history.shift();
    // One opening failing is that opening's lesson, not the table's: a family is only judged once she has answered at
    // least two different first moves with it and the whole sample has no win since.
    const faced = black.learn && typeof black.learn === "object" ? Object.keys(black.learn).length : 0;
    if (faced < 2) return "";
    const patience = patienceFor(fam.games);
    if (!Number.isFinite(patience)) return "";
    const recent = fam.history.slice(-patience);
    const losses = recent.filter((entry) => entry.result === "l").length;
    const wins = recent.filter((entry) => entry.result === "w").length;
    if (losses < patience || wins > 0) return "";
    // A run of defeats in one opening is that opening's business: the slot rule replaces its answer first. The family
    // is only on trial once the defeats span at least two of the openings she actually answered.
    const spanned = new Set(recent.filter((entry) => entry.result === "l").map((entry) => entry.slot || "?")).size;
    if (spanned < 2) return "";
    const next = nextFamilyKey(black, family);
    if (!next || next === family) return "";
    const plan = familyTable(next, replyLean(traitsFor(key), baseTraits(key)));
    const seed = {};
    const map = {};
    for (const slot of REPLY_KEYS.concat("other")) {
      if (!black.learn[slot]) continue;   // une ouverture jamais affrontée garde sa réponse : la table ne la touche pas
      seed[slot] = plan[slot].key;
      const kept = black.changed && black.changed[slot] && black.changed[slot].to === black.map[slot];
      const learned = kept || (black.pref && black.map && black.map[slot] !== black.pref[slot]);
      map[slot] = learned ? black.map[slot] : seed[slot];
    }
    black.family = next;
    black.pref = Object.assign({}, black.pref, seed);
    black.map = Object.assign({}, black.map, map);
    black.familyChanged = { from: family, to: next, at: Date.now(), losses: losses, games: fam.games };
    return next;
  }

  // Her learned lean, as one number: a sister whose centre appetite rose, and whose boldness rose with it, answers
  // by contesting the middle; one who grew more flexible answers by preparing. Two sisters in the same mood therefore
  // no longer land on the same named answer just because their mood band is the same.
  function replyLean(traits, anchor) {
    if (!traits || !anchor) return 0;
    return (Number(traits.center) - Number(anchor.center)) + 0.6 * (Number(traits.bold) - Number(anchor.bold));
  }

  // The whole Black book: one named reply per White first move, all from the same style. Inside a mood, the alternate
  // she takes is the one her accumulated traits point to, so a drift of a few hundredths is visible in the answer.
  function replyPlan(opening, risk, traits, anchor) {
    const mood = replyMood(opening, risk);
    const table = REPLY_FALLBACKS[mood];
    const lean = replyLean(traits, anchor);
    const plan = { family: mood };
    for (const slot of REPLY_KEYS.concat("other")) {
      const list = table[slot];
      plan[slot] = REPLIES[lean > 0.015 && list[1] ? list[1] : list[0]];
    }
    return plan;
  }

  function replyFor(opening, risk, slot) {
    const plan = replyPlan(opening, risk);
    return plan[slot] || plan.other;
  }

  function replyForPlan(plan, firstMove) {
    if (!plan) return null;
    return plan[openingKey(firstMove)] || plan.other || null;
  }

  // What goes into her profile: the mood plus the named move for every slot, so a reload cannot re-derive a different book.
  function planKeys(plan) {
    const map = {};
    for (const slot of REPLY_KEYS.concat("other")) map[slot] = plan[slot].key;
    return { family: plan.family || "", map: map, pref: Object.assign({}, map), learn: {}, changed: {}, deep: {} };
  }

  // The named move she played, for matching a finished game back to the slot it answers.
  function replyKey(move) {
    if (!move) return "";
    const from = nameOf(move.from);
    const to = nameOf(move.to);
    for (const key of Object.keys(REPLIES)) {
      if (REPLIES[key].from === from && REPLIES[key].to === to) return key;
    }
    return "";
  }

  // Two losses with no win since is what turns "préférée" into "elle ne tient pas" : a winning or drawing answer is
  // never churned. Only the opening actually faced is touched, so a repertoire she never met keeps its answer.
  const REPLY_PATIENCE = 2;

  // How many defeats in a row are evidence: none at all while she has fewer than three games with the answer, then
  // half of what she has played with it, never below two and never above four. A two-game streak at the start of a
  // series is noise, not a lesson; the same streak after ten games is a verdict.
  function patienceFor(games) {
    const played = Math.max(0, Math.floor(Number(games) || 0));
    if (played < 3) return Infinity;
    return Math.max(REPLY_PATIENCE, Math.min(4, Math.ceil(played / 2)));
  }

  // Her answer at move two is not one fixed habit: the same 1.e4 can call for a knight after 2.Cf3 and a centre pawn
  // after 2.d4. These are the named intentions she can hold on that second answer — one per kind of move, so any
  // legal position has something to play — chosen from the opening's first three plies and learned like the first reply.
  const DEEP_PLANS = ["knight", "bishop", "center", "flank", "calm"];
  const DEEP_NAMES = {
    knight: "développe un cavalier",
    bishop: "sort un fou",
    center: "joue au centre",
    flank: "pousse à l'aile",
    calm: "consolide",
  };

  function planOfMove(pos, move) {
    for (const plan of DEEP_PLANS) {
      if (planMatches(plan, pos, move)) return plan;
    }
    return "";
  }

  // The opening line her second answer belongs to: White's first move, her own first answer, White's second move.
  // Which moves express an intention. `calm` is the one that is not a pawn push: a prudent sister develops or
  // consolidates instead of throwing a pawn forward, and it always has something legal to play.
  function planMatches(plan, pos, move) {
    if (!pos || !move) return false;
    const piece = (pos.board[move.from] || "").toLowerCase();
    const file = move.to & 7;
    if (plan === "knight") return piece === "n";
    if (plan === "bishop") return piece === "b";
    if (plan === "calm") return piece === "n" || piece === "b" || piece === "r" || piece === "k";
    if (plan === "center") return piece === "p" && (file === 3 || file === 4);
    if (plan === "flank") return piece === "p" && file !== 3 && file !== 4;
    return false;
  }

  function deepPrefixOf(history) {
    if (!Array.isArray(history) || history.length < 3) return "";
    const w1 = history[0] && history[0].move;
    const b1 = history[1] && history[1].move;
    const w2 = history[2] && history[2].move;
    if (!w1 || !b1 || !w2) return "";
    const first = replyKey(b1);
    if (!first) return "";   // an unnamed first answer is not a line she can name at move two
    return openingKey(w1) + "|" + first + "|" + openingKey(w2);
  }

  // What she intends at move two follows the line she is in rather than one fixed habit: a bold sister strikes the
  // centre whatever White did, a prudent one develops a knight after 2.Cf3 but answers 2.d4 in the centre, and her own
  // first answer still colours the choice (a fianchetto keeps the bishop's diagonal in mind).
  function seedDeepPlan(prefix, opening, risk) {
    const parts = String(prefix || "").split("|");
    const second = parts[2] || "";
    const first = parts[1] || "";
    const mood = replyMood(opening, risk);
    if (mood === "sharp") return "center";
    if (mood === "solid") return first === "c5" || first === "g6" ? "bishop" : "calm";
    if (second === "nf3" || second === "c4" || second === "e4") return "knight";
    if (second === "d4" || second === "d3") return "center";
    return first === "e6" || first === "c6" ? "bishop" : "knight";
  }

  function deepCell(entry, plan) {
    if (!entry.learn || typeof entry.learn !== "object" || Array.isArray(entry.learn)) entry.learn = {};
    const cell = entry.learn[plan];
    if (cell && typeof cell === "object" && Array.isArray(cell.history)) return cell;
    const fresh = { games: 0, wins: 0, draws: 0, losses: 0, history: [] };
    entry.learn[plan] = fresh;
    return fresh;
  }

  function nextDeepPlan(entry) {
    for (const plan of DEEP_PLANS) {
      if (plan === entry.plan) continue;
      const cell = entry.learn && entry.learn[plan];
      if (cell && Number(cell.losses) >= patienceFor(cell.games) && !Number(cell.wins)) continue;   // déjà essayée, pas tenue
      return plan;
    }
    return "";
  }

  // The intention she holds for the line she is in: what the games taught, otherwise what her style says for that line.
  function deepPlanFor(key, history) {
    const prefix = deepPrefixOf(history);
    if (!prefix) return "";
    const record = growthRead()[key];
    const book = record && record.book;
    const entry = book && book.black && book.black.deep ? book.black.deep[prefix] : null;
    if (entry && DEEP_PLANS.indexOf(entry.plan) >= 0) return entry.plan;
    const profile = prefsFor(key);
    return seedDeepPlan(prefix, profile.opening, profile.risk);
  }

  // Called with a finished game: her second answer is judged by the line it belonged to, and only that line changes.
  function noteDeepOutcome(key, history, result) {
    const prefix = deepPrefixOf(history);
    if (!prefix) return null;
    const played = history[3];
    if (!played || !played.move || !played.pos) return null;
    const record = growthRead()[key];
    const book = record && record.book;
    const black = book && book.black;
    if (!book || !black) return null;
    const actual = planOfMove(played.pos, played.move);
    if (!actual) return null;
    const deep = black.deep && typeof black.deep === "object" && !Array.isArray(black.deep) ? black.deep : (black.deep = {});
    let entry = deep[prefix];
    if (!entry || typeof entry !== "object" || DEEP_PLANS.indexOf(entry.plan) < 0) {
      const style = record.style;
      const pref = seedDeepPlan(prefix, style && style.opening, style && style.risk);
      // No line held yet: if the answer she chose belongs to her style's intention for this line, that intention is
      // the one she was holding; otherwise her own choice names it. This game is its first lesson either way.
      const held = planMatches(pref, played.pos, played.move) ? pref : actual;
      entry = deep[prefix] = { plan: held, pref: pref, learn: {}, changed: {}, at: Date.now() };
    }
    entry.at = Date.now();
    const keep = Object.keys(deep).sort((a, b) => (Number(deep[a].at) || 0) - (Number(deep[b].at) || 0));
    while (keep.length > 12) { delete deep[keep.shift()]; }
    if (!planMatches(entry.plan, played.pos, played.move)) return { prefix: prefix, plan: entry.plan, actual: actual, changed: false, followed: false };
    const cell = deepCell(entry, entry.plan);
    cell.games += 1;
    if (result === "w") cell.wins += 1; else if (result === "l") cell.losses += 1; else cell.draws += 1;
    cell.history.push({ plan: entry.plan, result: result || "d", at: Date.now() });
    if (cell.history.length > 8) cell.history.shift();
    const patience = patienceFor(cell.games);
    const recent = Number.isFinite(patience) ? cell.history.slice(-patience) : [];
    const losses = recent.filter((entry2) => entry2.result === "l").length;
    const wins = recent.filter((entry2) => entry2.result === "w").length;
    const before = entry.plan;
    let after = before;
    if (Number.isFinite(patience) && losses >= patience && wins === 0) {
      const next = nextDeepPlan(entry);
      if (next) {
        entry.plan = next;
        entry.changed = { from: before, to: next, at: Date.now(), losses: losses };
        after = next;
      }
    }
    return { prefix: prefix, plan: before, after: after, actual: actual, result: result || "d", followed: true, changed: before !== after };
  }

  function replyCell(black, slot) {
    if (!black.learn || typeof black.learn !== "object" || Array.isArray(black.learn)) black.learn = {};
    const cell = black.learn[slot];
    if (cell && typeof cell === "object" && Array.isArray(cell.history)) return cell;
    const fresh = { games: 0, wins: 0, draws: 0, losses: 0, history: [], tally: {} };
    black.learn[slot] = fresh;
    return fresh;
  }

  // Keep what scores. A slot that only rotates away from defeat would walk past the answer that drew for her, so once
  // two judged games exist for an answer its own record can take the slot back: a win counts one, a draw a half, and a
  // quarter of a point is enough to move. Nothing here invents a result — the games are hers.
  function bestAnswer(black, slot, plan) {
    const cell = black.learn && black.learn[slot];
    const tally = cell && cell.tally && typeof cell.tally === "object" ? cell.tally : null;
    if (!tally) return "";
    const mood = black.family && REPLY_FALLBACKS[black.family] ? black.family : plan.family;
    const list = (REPLY_FALLBACKS[mood] && REPLY_FALLBACKS[mood][slot]) || [];
    const rateOf = (option) => {
      const played = Number(tally[option] && tally[option].games) || 0;
      if (played < 2) return null;
      return ((Number(tally[option].wins) || 0) + 0.5 * (Number(tally[option].draws) || 0)) / played;
    };
    // Only against the answer she holds now, and only once that answer has also been judged twice: a rotation she has
    // not yet played must not be undone by the record of the answer it replaced.
    const held = rateOf(black.map[slot]);
    if (held === null) return "";
    let best = "";
    let bestRate = held;
    for (const option of list) {
      if (option === black.map[slot]) continue;
      const score = rateOf(option);
      if (score === null) continue;
      if (score > bestRate + 0.2) { bestRate = score; best = option; }
    }
    return best;
  }

  function nextReplyKey(black, slot, plan) {
    const mood = black.family && REPLY_FALLBACKS[black.family] ? black.family : plan.family;
    const list = (REPLY_FALLBACKS[mood] && REPLY_FALLBACKS[mood][slot]) || [];
    const cell = black.learn && black.learn[slot];
    const tried = cell && Array.isArray(cell.history) ? cell.history : [];
    for (const candidate of list) {
      if (candidate === black.map[slot]) continue;
      const failed = tried.filter((entry) => entry.answer === candidate && entry.result === "l").length;
      if (failed >= patienceFor(cell && cell.games)) continue;   // elle a déjà essayé celle-ci et elle n'a pas tenu
      return candidate;
    }
    return list.find((candidate) => candidate !== black.map[slot]) || "";
  }

  // White's opening is judged by its own results, the same way Black's first answer is. Two defeats in a row with no
  // win since are enough to try the neighbouring rung of her repertoire; one bad game is not, and a win or a draw in
  // that tail protects the opening. Nothing here touches her traits or the identity band.
  const HABIT_PATIENCE = 2;

  function habitCell(book, opening) {
    if (!book.whiteLearn || typeof book.whiteLearn !== "object" || Array.isArray(book.whiteLearn)) book.whiteLearn = {};
    const cell = book.whiteLearn[opening];
    if (cell && typeof cell === "object" && Array.isArray(cell.history)) return cell;
    const fresh = { games: 0, wins: 0, draws: 0, losses: 0, history: [] };
    book.whiteLearn[opening] = fresh;
    return fresh;
  }

  // The neighbouring opening she has not already tried and lost with, nearest rung first. Her repertoire stays the one
  // her own temperament ordered, so a result lesson can move her one place but never to a random opening.
  function nextHabitKey(book, key) {
    const born = habitOf(bornOpeningFor(key), 0.5).key;
    const at = SISTER_LADDER.indexOf(born);
    if (at < 0 || !HABITS[book.white]) return "";
    const candidates = [];
    for (let step = 1; step < SISTER_LADDER.length; step += 1) {
      if (at - step >= 0) candidates.push(SISTER_LADDER[at - step]);
      if (at + step < SISTER_LADDER.length) candidates.push(SISTER_LADDER[at + step]);
    }
    const tried = book.whiteLearn && typeof book.whiteLearn === "object" ? book.whiteLearn : {};
    for (const candidate of candidates) {
      if (candidate === book.white) continue;
      const cell = tried[candidate];
      const failed = cell && Array.isArray(cell.history) ? cell.history.filter((entry) => entry.result === "l").length : 0;
      if (failed >= patienceFor(cell && cell.games)) continue;   // elle a déjà essayé celle-ci et elle n'a pas tenu
      return candidate;
    }
    return candidates[0] || "";
  }

  // The white side of the same rule: an opening with two judged games and the best record takes the habit back.
  function bestHabit(book) {
    const learn = book && book.whiteLearn && typeof book.whiteLearn === "object" ? book.whiteLearn : null;
    if (!learn) return "";
    const rateOf = (key) => {
      const cell = learn[key];
      const played = Number(cell && cell.games) || 0;
      if (played < 2) return null;
      return ((Number(cell.wins) || 0) + 0.5 * (Number(cell.draws) || 0)) / played;
    };
    const held = rateOf(book.white);
    if (held === null) return "";
    let best = "";
    let bestRate = held;
    for (const opening of Object.keys(learn)) {
      if (!HABITS[opening] || opening === book.white) continue;
      const score = rateOf(opening);
      if (score === null) continue;
      if (score > bestRate + 0.2) { bestRate = score; best = opening; }
    }
    return best;
  }

  function noteOpeningOutcome(key, firstMove, result, vs, gameId) {
    const record = growthRead()[key];
    if (!record) return null;
    if (!firstMove) return null;
    let book = record.book;
    // A game she never started has no committed book yet: the finished game still judges the opening she played, so
    // her book is the one a duel start would have committed for this style. Only the sample needs it — the verdict
    // rules are untouched, so one game still cannot make a lesson.
    if (!book || !HABITS[book.white] || !planFromSaved(book.black)) {
      book = styleBook(key);
      record.book = book;
    }
    const played = openingKey(firstMove);
    if (!played || played !== book.white) return null;   // elle n'a pas joué son ouverture : rien à juger
    const cell = habitCell(book, played);
    cell.games += 1;
    if (result === "w") cell.wins += 1; else if (result === "l") cell.losses += 1; else cell.draws += 1;
    // Who she lost to is part of the lesson: the card can then name the games behind a changed opening instead of
    // only counting them. An unknown seat (the Master, or a record written before this field) is simply left out.
    cell.history.push({ result: result || "d", vs: ASSISTANTS[vs] ? vs : "", id: gameId || "", at: Date.now() });
    if (cell.history.length > 8) cell.history.shift();
    const patience = patienceFor(cell.games);
    const recent = Number.isFinite(patience) ? cell.history.slice(-patience) : [];
    const losses = recent.filter((entry) => entry.result === "l").length;
    const wins = recent.filter((entry) => entry.result === "w").length;
    const before = book.white;
    let after = before;
    if (Number.isFinite(patience) && losses >= patience && wins === 0) {
      const next = nextHabitKey(book, key);
      if (next && next !== before) {
        book.white = next;
        book.whiteChanged = {
          from: before,
          to: next,
          at: Date.now(),
          losses: losses,
          // The defeats that carried the verdict, with who dealt them: the sample is the evidence, the names point at
          // the games. Kept on the lesson itself so it survives serialisation with the opening it explains.
          defeats: recent.filter((entry2) => entry2.result === "l").map((entry2) => ({ vs: entry2.vs || "", id: entry2.id || "", at: entry2.at || 0 })),
        };
        // The style that produced the losing opening is not a reason to undo the lesson: the anchor moves to where she
        // is now, so only a genuinely new drift can speak again.
        if (record.style && Number.isFinite(Number(record.style.opening))) {
          book.opening = Number(record.style.opening);
          book.risk = Number(record.style.risk);
        }
        after = next;
      }
    }
    const keep = bestHabit(book);
    if (keep && keep !== book.white) {
      book.white = keep;
      book.whiteChanged = { from: after, to: keep, at: Date.now(), losses: losses, defeats: [], kept: true };
      after = keep;
    }
    return { opening: played, before: before, after: after, result: result || "d", losses: losses, changed: before !== after };
  }

  // Called with a finished game that had both colours move: records what she faced, what she answered, how it ended,
  // and only then decides whether that answer has earned being replaced.
  function noteReplyOutcome(key, firstMove, replyMove, result) {
    const record = growthRead()[key];
    const book = record && record.book;
    if (!book || !book.black || !firstMove || !replyMove) return null;
    const plan = planFromSaved(book.black);
    if (!plan) return null;
    const slot = openingKey(firstMove);
    const answer = replyKey(replyMove);
    const black = book.black;
    if (!slot || !answer || !black.map || !REPLIES[black.map[slot]]) return null;
    const cell = replyCell(black, slot);
    cell.games += 1;
    if (result === "w") cell.wins += 1; else if (result === "l") cell.losses += 1; else cell.draws += 1;
    cell.history.push({ answer: answer, result: result || "d", at: Date.now() });
    if (cell.history.length > 8) cell.history.shift();
    if (!cell.tally || typeof cell.tally !== "object") cell.tally = {};
    const counted = cell.tally[answer] && typeof cell.tally[answer] === "object" ? cell.tally[answer] : { games: 0, wins: 0, draws: 0, losses: 0 };
    counted.games = (Number(counted.games) || 0) + 1;
    if (result === "w") counted.wins = (Number(counted.wins) || 0) + 1;
    else if (result === "l") counted.losses = (Number(counted.losses) || 0) + 1;
    else counted.draws = (Number(counted.draws) || 0) + 1;
    cell.tally[answer] = counted;
    const patience = patienceFor(cell.games);
    const recent = Number.isFinite(patience) ? cell.history.filter((entry) => entry.answer === answer).slice(-patience) : [];
    const losses = recent.filter((entry) => entry.result === "l").length;
    const wins = recent.filter((entry) => entry.result === "w").length;
    const before = black.map[slot];
    let after = before;
    if (black.map[slot] === answer && Number.isFinite(patience) && losses >= patience && wins === 0) {
      const next = nextReplyKey(black, slot, plan);
      if (next && next !== before) {
        black.map[slot] = next;
        black.changed = black.changed && typeof black.changed === "object" ? black.changed : {};
        black.changed[slot] = { from: before, to: next, at: Date.now(), losses: losses };
        after = next;
      }
    }
    const keeping = bestAnswer(black, slot, plan);
    if (keeping && keeping !== black.map[slot]) {
      black.map[slot] = keeping;
      black.changed = black.changed && typeof black.changed === "object" ? black.changed : {};
      black.changed[slot] = { from: after, to: keeping, at: Date.now(), losses: losses, kept: true };
      after = keeping;
    }
    // The table she answered with gets this game too: a single answer can be wrong while the family holds, and a family
    // that keeps losing is replaced even when each slot has not been seen often enough to be judged on its own.
    const family = REPLY_FALLBACKS[black.family] ? black.family : (REPLY_FALLBACKS[plan.family] ? plan.family : "solid");
    const familyAfter = noteFamilyOutcome(black, family, result, key, slot);
    return {
      slot: slot, answer: answer, before: before, after: after, result: result || "d", changed: before !== after,
      family: family, familyAfter: familyAfter || family,
    };
  }

  function planFromSaved(saved) {
    if (!saved) return null;
    if (typeof saved === "string") {
      // A book written before replies depended on White's move: one named answer served every opening.
      const only = REPLIES[saved];
      if (!only) return null;
      const legacy = { family: "" };
      for (const slot of REPLY_KEYS.concat("other")) legacy[slot] = only;
      return legacy;
    }
    if (typeof saved !== "object" || !saved.map) return null;
    const plan = { family: typeof saved.family === "string" ? saved.family : "" };
    for (const slot of REPLY_KEYS.concat("other")) {
      const pick = REPLIES[saved.map[slot]];
      if (!pick) return null;
      plan[slot] = pick;
    }
    return plan;
  }

  // Compact pill text, one matchup per opening: "1.e4 → 1…c5" reads as an answer, while a bare "1…c5 / 1…Cf6"
  // would read like two black moves in a row. The full table for every opening stays in the tooltip.
  function replyLabel(plan) {
    if (!plan) return "";
    return "1.e4 → " + plan.e4.name + " · 1.d4 → " + plan.d4.name;
  }

  // The opening she holds because the board moved her: which one she left, which one she took, and how many defeats
  // made the case. Only noteOpeningOutcome writes this record, so naming it on the card names the cause — a style
  // pass can never produce it, and while it stands the opening cannot be renamed by drift.
  // The date a game was played, short: "15/11 20:47". The tooltip uses it, the pill never does.
  function gameStamp(at) {
    const stamp = Number(at) || 0;
    if (!stamp) return "";
    const date = new Date(stamp);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(date.getDate()) + "/" + pad(date.getMonth() + 1) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function duelId(entry) {
    if (!entry) return "";
    return entry.id || (entry.at ? "g" + entry.at : "");
  }

  // Each defeat resolves to the line of the duel journal it came from: opponent, rank in the journal and the moment.
  // Two losses to the same sister read as two different lines; a defeat whose game was never kept says so instead of
  // borrowing another game's rank.
  function habitLessonText(lesson, games) {
    if (!lesson || typeof lesson !== "object") return null;
    const from = HABITS[lesson.from];
    const to = HABITS[lesson.to];
    if (!from || !to) return null;
    const losses = Math.max(1, Number(lesson.losses) || 1);
    const plural = losses > 1 ? "s" : "";
    const log = Array.isArray(games) ? games : duelsRead();
    const named = (Array.isArray(lesson.defeats) ? lesson.defeats : []).map((defeat) => {
      const name = defeat && ASSISTANTS[defeat.vs] ? ASSISTANTS[defeat.vs].name : "";
      const id = defeat && defeat.id ? String(defeat.id) : "";
      const index = id ? log.findIndex((entry) => duelId(entry) === id) : -1;
      const entry = index >= 0 ? log[index] : null;
      return { name: name, id: id, index: index, at: entry ? Number(entry.at) || 0 : 0, game: entry || null };
    }).filter((defeat) => !!defeat.name);
    const parts = named.map((defeat) => defeat.name + " (" + (defeat.index >= 0
      ? "partie n°" + (defeat.index + 1) + (gameStamp(defeat.at) ? " · " + gameStamp(defeat.at) : "")
      : "partie non enregistrée") + ")");
    const behind = parts.length ? " — contre " + parts.join(" ; ") : "";
    return {
      from: from.name,
      to: to.name,
      losses: losses,
      defeats: named,
      text: from.name + " → " + to.name + " · apprise après " + losses + " défaite" + plural,
      title: "Changement venu du plateau : " + from.name + " → " + to.name + " après " + losses
        + " défaite" + plural + " d'affilée avec cette ouverture" + behind + ". Seuls les résultats peuvent la renommer, pas le style.",
    };
  }

  // Learn and duel timestamps are written in the same end-of-game pass, so a lesson written before defeats carried ids
  // can still be pointed at its games: the journal line for that sister, a defeat, nearest in time. Each journal line
  // is used once, and a defeat with no line that close stays unresolved rather than borrowing a neighbour.
  const LESSON_MATCH_MS = 120000;

  function backfillLessonGames(key, games) {
    const record = growthRead()[key];
    const lesson = record && record.book && record.book.whiteChanged;
    if (!lesson || !Array.isArray(lesson.defeats) || !lesson.defeats.length) return 0;
    const log = Array.isArray(games) ? games : duelsRead();
    const taken = {};
    let filled = 0;
    lesson.defeats.forEach((defeat) => {
      if (!defeat || typeof defeat !== "object") return;
      if (defeat.id && log.some((entry) => duelId(entry) === defeat.id)) { taken[defeat.id] = true; return; }
      const stamp = Number(defeat.at) || 0;
      let best = null;
      log.forEach((entry) => {
        const id = duelId(entry);
        if (!id || taken[id]) return;
        if (entry.w !== key && entry.b !== key) return;
        if (!entry.win || entry.win === key) return;   // a lesson points at a defeat, never at any game she played
        const delta = Math.abs((Number(entry.at) || 0) - stamp);
        if (delta > LESSON_MATCH_MS) return;
        if (!best || delta < best.delta) best = { id: id, delta: delta };
      });
      if (!best) return;
      defeat.id = best.id;
      taken[best.id] = true;
      filled += 1;
    });
    if (filled) growthWrite();
    return filled;
  }

  // Only the lesson that still governs her current opening is shown: an older record would describe a previous one.
  function habitLessonFor(book) {
    if (!book || !book.lesson || !book.white || book.lesson.to !== book.white.key) return null;
    return habitLessonText(book.lesson);
  }

  // A learned line, readable: "1.e4 1…c5 2.Cf3 : développe un cavalier", plus what it replaced when a game taught her.
  function deepLine(prefix, entry) {
    const parts = String(prefix || "").split("|");
    const w1 = HABITS[parts[0]] ? HABITS[parts[0]].name : "";
    const b1 = REPLIES[parts[1]] ? REPLIES[parts[1]].name : "";
    const w2raw = HABITS[parts[2]] ? HABITS[parts[2]].name : "";
    const w2 = w2raw ? w2raw.replace("1.", "2.") : "";
    const name = DEEP_NAMES[entry && entry.plan] || "";
    const learned = entry && entry.changed && DEEP_NAMES[entry.changed.from] && DEEP_NAMES[entry.changed.to]
      ? " (appris : " + DEEP_NAMES[entry.changed.from] + " → " + DEEP_NAMES[entry.changed.to] + ")"
      : "";
    return [w1, b1, w2].filter(Boolean).join(" ") + " : " + name + learned;
  }

  function replyDetail(plan, changed, deep, familyLesson) {
    if (!plan) return "";
    const table = REPLY_KEYS.map((slot) => HABITS[slot].name + " : " + plan[slot].name).join(" · ");
    const notes = changed && typeof changed === "object"
      ? Object.keys(changed).filter((slot) => REPLIES[changed[slot].from] && REPLIES[changed[slot].to]).map((slot) => HABITS[slot].name + " " + REPLIES[changed[slot].from].name + " → " + REPLIES[changed[slot].to].name).join(" · ")
      : "";
    const lines = deep && typeof deep === "object"
      ? Object.keys(deep).slice(-2).map((prefix) => deepLine(prefix, deep[prefix])).filter(Boolean).join(" · ")
      : "";
    const from = familyLesson && FAMILY_WORDS[familyLesson.from] ? FAMILY_WORDS[familyLesson.from] : "";
    const to = familyLesson && FAMILY_WORDS[familyLesson.to] ? FAMILY_WORDS[familyLesson.to] : "";
    const familyNote = from && to && from !== to
      ? " · famille apprise : " + from + " → " + to + " après " + (Number(familyLesson.games) || 0) + " parties"
      : "";
    return table + (notes ? " · appris : " + notes : "") + (familyNote ? familyNote : "") + (lines ? " · ligne : " + lines : "");
  }

  // How far her style must actually move before a habit she already owns may be replaced. Five hundredths is what a
  // handful of real duels teaches at the identity band's edge: big enough that noise cannot rename her, small enough
  // that a series of games against one sister visibly changes her opening.
  const BOOK_DRIFT = 0.05;

  // A formed habit is part of her identity, so it is read from her profile first and only derived when she has none:
  // a drift of a few hundredths around a threshold cannot rename her opening between two duels.
  function bookFor(key, opening, risk) {
    const all = growthRead();
    const record = all[key];
    const saved = (record && record.book) || pendingBook(key);
    const plan = saved ? planFromSaved(saved.black) : null;
    if (saved && HABITS[saved.white] && plan) {
      return { white: HABITS[saved.white], black: plan, saved: true, learn: saved.black.learn || null, changed: saved.black.changed || null, deep: saved.black.deep || null, lesson: saved.whiteChanged || null, family: saved.black.familyChanged || null };
    }
    return { white: habitOf(opening, risk), black: replyPlan(opening, risk), saved: false, learn: null, changed: null, deep: null, lesson: null };
  }

  // She commits her habits when a duel begins: they are hers for that game and survive the page, whatever her style does
  // afterwards. A sister who already owns a habit keeps it.
  // A sister who has never finished a game has no profile: her first book waits in a pending slot (see commitBook)
  // until the game that teaches her something ends, so nothing has to invent a record with zero games.
  function pendingBook(key) {
    const all = growthRead();
    const books = all.__books && typeof all.__books === "object" ? all.__books : null;
    const book = books ? books[key] : null;
    return book && typeof book === "object" ? book : null;
  }
  function setPendingBook(key, book) {
    const all = growthRead();
    if (!all.__books || typeof all.__books !== "object") all.__books = {};
    all.__books[key] = book;
  }
  function clearPendingBook(key) {
    const all = growthRead();
    if (!all.__books || typeof all.__books !== "object") return;
    delete all.__books[key];
    if (!Object.keys(all.__books).length) delete all.__books;
  }
  // Her first finished game gives the waiting book a profile to live in: it moves in, and the slot empties.
  function adoptPendingBook(key, record) {
    if (!record || typeof record !== "object") return null;
    const waiting = pendingBook(key);
    if (record.book && typeof record.book === "object") return record.book;
    if (!waiting) return null;
    record.book = waiting;
    clearPendingBook(key);
    return waiting;
  }

  // The book her style calls for right now, in the shape a record stores. A duel start commits it, and a finished game
  // she never started (the background duel) derives the same book, so both roads judge the opening she really played.
  function styleBook(key) {
    const profile = prefsFor(key);
    return {
      white: profile.habit.key,
      black: planKeys(profile.reply),
      opening: profile.opening,
      risk: profile.risk,
      at: Date.now(),
    };
  }

  function commitBook(key) {
    if (!ASSISTANTS[key]) return;
    const all = growthRead();
    const record = all[key] && typeof all[key] === "object" ? all[key] : null;
    const saved = (record && record.book) || pendingBook(key);
    if (saved && HABITS[saved.white] && planFromSaved(saved.black)) return;
    const book = styleBook(key);
    // Without a profile there is no record to hold the book, and a record with zero games would be a lie: she keeps
    // it in the pending slot instead, so a reload in the middle of her first duel still opens on the same opening.
    if (record) record.book = book;
    else setPendingBook(key, book);
    growthWrite();
  }

  // A learned line survives a style change; a line she never learned follows the new mood, like the first reply.
  function refinedDeep(saved, opening, risk) {
    const deep = {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return deep;
    for (const prefix of Object.keys(saved)) {
      const entry = saved[prefix];
      if (!entry || typeof entry !== "object" || DEEP_PLANS.indexOf(entry.plan) < 0) continue;
      const pref = seedDeepPlan(prefix, opening, risk);
      deep[prefix] = {
        plan: entry.plan === entry.pref ? pref : entry.plan,
        pref: pref,
        learn: entry.learn && typeof entry.learn === "object" ? entry.learn : {},
        changed: entry.changed && typeof entry.changed === "object" ? entry.changed : {},
        at: Number(entry.at) || Date.now(),
      };
    }
    return deep;
  }

  // Called once a duel is recorded: she keeps her habits until her style has genuinely moved, then they follow it.
  function refineBook(key, profile) {
    const all = growthRead();
    const record = all[key];
    if (!record || typeof record !== "object") return;
    const saved = record.book;
    const known = saved && HABITS[saved.white] && planFromSaved(saved.black);
    // Once the board has chosen her opening, the board keeps it: a style drift may re-seed her replies, but it cannot
    // put back the opening she already lost with. Only another result lesson (noteOpeningOutcome) may move it again.
    const resultsKeep = known && saved.whiteChanged && saved.whiteChanged.to === saved.white && HABITS[saved.whiteChanged.to];
    // The style ladder waits while the board is still forming a verdict: with fewer than three games with this opening
    // and at least one defeat, the result rule gets its chance first. Once the sample is complete and the board did
    // not move her, style may speak again — so neither path can freeze her opening for good.
    const sample = known && saved.whiteLearn && saved.whiteLearn[saved.white] ? saved.whiteLearn[saved.white] : null;
    const sampleGames = sample ? Number(sample.games) || 0 : 0;
    const lossesWithHabit = sample ? Number(sample.losses) || 0 : 0;
    const styleMayMove = !resultsKeep && (sampleGames >= 3 || lossesWithHabit === 0);
    const nextHabit = styleMayMove
      ? habitForKey(key, profile.opening, profile.risk, known ? saved.white : null).key
      : (known ? saved.white : habitForKey(key, profile.opening, profile.risk, null).key);
    const nextReply = replyPlan(profile.opening, profile.risk, traitsFor(key), baseTraits(key));
    const drift = known
      ? Math.abs(profile.opening - (Number(saved.opening) || 0.5)) + Math.abs(profile.risk - (Number(saved.risk) || 0.5))
      : Infinity;
    if (known && drift < BOOK_DRIFT) return;   // a small drift does not rename her
    if (!known) {
      record.book = { white: nextHabit, black: planKeys(nextReply), opening: profile.opening, risk: profile.risk, at: Date.now() };
      return;
    }
    // A style change re-seeds the *preference* for every opening. Answers she actually learned by facing one survive:
    // "garder son ouverture" means keeping what the games taught her, not throwing it away with the mood.
    const black = saved.black;
    // A family a result lesson chose is not a mood: a style pass re-seeds the answers of *her* family, not the band's,
    // and never renames her. Until a lesson exists the family is still the band's label, so a new style may seed it.
    const kept = black && black.familyChanged && REPLY_FALLBACKS[black.family] ? black.family : "";
    const seedPlan = kept ? familyTable(kept, replyLean(traitsFor(key), baseTraits(key))) : nextReply;
    const pref = {};
    const map = {};
    const grounded = !!kept;
    for (const slot of REPLY_KEYS.concat("other")) {
      const stylePick = seedPlan[slot].key;
      // Once results have chosen her family, an opening she has not faced keeps its answer through a style pass too:
      // only facing it (or a result lesson) may move it, so a table built by play is not rewritten in the dark.
      if (grounded && !(black.learn && black.learn[slot])) {
        pref[slot] = black.pref && black.pref[slot] ? black.pref[slot] : stylePick;
        map[slot] = black.map && black.map[slot] ? black.map[slot] : stylePick;
        continue;
      }
      pref[slot] = stylePick;
      // An answer a result taught her stays hers, whether the preference drifted under it or the rebuild already reset
      // it once: `changed` is the record of the lesson, and it outranks the style pass.
      const lesson = black.changed && black.changed[slot] && black.map && black.changed[slot].to === black.map[slot];
      const learned = lesson || (black.pref && black.map && black.map[slot] !== black.pref[slot]);
      map[slot] = learned ? black.map[slot] : stylePick;
    }
    const rebuilt = {
      white: nextHabit,
      black: {
        family: kept || nextReply.family,
        familyLearn: black.familyLearn && typeof black.familyLearn === "object" ? black.familyLearn : {},
        familyChanged: black.familyChanged && typeof black.familyChanged === "object" ? black.familyChanged : {},
        map: map,
        pref: pref,
        learn: black.learn && typeof black.learn === "object" ? black.learn : {},
        changed: black.changed && typeof black.changed === "object" ? black.changed : {},
        deep: refinedDeep(black.deep, profile.opening, profile.risk),
      },
      // The drift anchor only advances when the opening actually changed: a style pass that was not allowed to move
      // her must not quietly reset the drift that will speak later.
      opening: nextHabit === saved.white ? (Number(saved.opening) || 0.5) : profile.opening,
      risk: nextHabit === saved.white ? (Number(saved.risk) || 0.5) : profile.risk,
      at: Date.now(),
    };
    // What the results taught about her opening travels with it: the sample and the lesson itself are not style data.
    if (saved.whiteLearn && typeof saved.whiteLearn === "object") rebuilt.whiteLearn = saved.whiteLearn;
    if (saved.whiteChanged && typeof saved.whiteChanged === "object") rebuilt.whiteChanged = saved.whiteChanged;
    record.book = rebuilt;
  }

  // Her repertoire is a ladder, and her born temperament is where she starts on it. When her style has really moved
  // (BOOK_DRIFT), she takes the neighbouring rung instead of re-deriving the same name from the same coarse bands: a
  // sister who grew more cautious opens 1.d4 where she used to open 1.Cf3, and the cautious sister starts opening like
  // a knight. One rung, chosen by the direction of what she faced — never a die, never the opponent's exact move.
  const SISTER_LADDER = ["d3", "d4", "nf3", "e4"];
  function bornOpeningFor(key) {
    const base = baseTraits(key);
    return 0.5 + (base.develop - 1) * 1.6 + (base.bold - 1) * 0.8;
  }
  function habitForKey(key, opening, risk, current) {
    const plain = habitOf(opening, risk);
    if (key !== "else" && key !== "pistonia") return plain;
    // Inside the band she keeps the rung she already owns: a style that merely wanders back to its old value must
    // not undo a lesson, so the opening never flip-flops between two openings from one duel to the next.
    const held = current && HABITS[current] ? HABITS[current] : plain;
    const born = bornOpeningFor(key);
    const at = SISTER_LADDER.indexOf(habitOf(born, 0.5).key);
    if (at < 0) return held;
    const drift = (Number(opening) || born) - born;
    if (drift >= 0.02) return HABITS[SISTER_LADDER[Math.min(at + 1, SISTER_LADDER.length - 1)]];
    if (drift <= -0.02) return HABITS[SISTER_LADDER[Math.max(at - 1, 0)]];
    return held;
  }

  function habitOf(opening, risk) {
    const open = Number(opening);
    const bold = Number(risk);
    const o = Number.isFinite(open) ? open : 0.5;
    const r = Number.isFinite(bold) ? bold : 0.5;
    let pick = "d3";
    if (o >= 0.66) pick = r >= 0.5 ? "e4" : "d4";
    else if (o >= 0.5) pick = "nf3";
    else if (o >= 0.36) pick = r >= 0.55 ? "c4" : "d4";
    return HABITS[pick];
  }

  function styleWords(opening, risk, convert) {
    const band = (value, high, middle, low) => (value >= 0.62 ? high : value <= 0.38 ? low : middle);
    return [
      band(opening, "ouvre vite", "ouverture mesurée", "ouvre prudemment"),
      band(risk, "prend des risques", "risque dosé", "joue sûr"),
      band(convert, "convertit bien", "convertit quand elle peut", "laisse filer"),
    ];
  }

  // Her style as three readable tendencies, from her own nature, her duels and her results. Two sisters who were born
  // different and have played different games cannot share this sentence.
  function profileOf(key, entries) {
    const log = Array.isArray(entries) ? entries : duelsRead();
    const traits = traitsFor(key);
    const own = { games: 0, wins: 0, losses: 0, draws: 0 };
    for (const entry of log) {
      if (!entry || (entry.w !== key && entry.b !== key)) continue;
      own.games += 1;
      if (!entry.win) own.draws += 1;
      else if (entry.win === key) own.wins += 1;
      else own.losses += 1;
    }
    const rate = own.games ? (own.wins - own.losses) / own.games : 0;
    const round = (value) => Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    const opening = round(0.5 + (traits.develop - 1) * 1.6 + (traits.bold - 1) * 0.8);
    const risk = round(0.5 + (traits.bold - 1) * 1.7 + (traits.material - 1) * 0.5 + rate * 0.15);
    const convert = round(0.5 + rate * 0.55 + (traits.material - 1) * 0.35);
    return {
      key: key, games: own.games, wins: own.wins, losses: own.losses, draws: own.draws,
      opening: opening, risk: risk, convert: convert,
      words: styleWords(opening, risk, convert),
    };
  }

  // Her style as the search reads it: the snapshot written at her last duel when there is one, recomputed from her
  // record otherwise. Same three numbers the panel prints, so what the board shows is what she plays with.
  function prefsFor(key) {
    const record = growthRead()[key];
    const saved = record && record.style;
    if (saved && ["opening", "risk", "convert"].every((part) => Number.isFinite(Number(saved[part])))) {
      const opening = Number(saved.opening);
      const risk = Number(saved.risk);
      const convert = Number(saved.convert);
      const book = bookFor(key, opening, risk);
      return {
        key: key,
        opening: opening, risk: risk, convert: convert,
        games: Number(saved.games) || 0,
        habit: book.white,
        reply: book.black,
        replyLearn: book.learn || null,
        replyChanged: book.changed || null,
        replyDeep: book.deep || null,
        replyFamily: book.family || null,
        habitLesson: habitLessonFor(book),
        words: styleWords(opening, risk, convert),
        stored: true,
      };
    }
    const profile = profileOf(key);
    const book = bookFor(key, profile.opening, profile.risk);
    return Object.assign({}, profile, { habit: book.white, reply: book.black, replyLearn: book.learn || null, replyChanged: book.changed || null, replyDeep: book.deep || null, replyFamily: book.family || null, habitLesson: habitLessonFor(book) });
  }

  // Written at every finished duel: her preferences as they stand after the game she just played, kept in her own
  // record so a reload opens on the same three numbers the search will use.
  function snapshotStyle(key, entries) {
    const all = growthRead();
    const record = all[key];
    if (!record || typeof record !== "object") return;
    const profile = profileOf(key, entries);
    record.style = {
      opening: profile.opening,
      risk: profile.risk,
      convert: profile.convert,
      games: profile.games,
      at: Date.now(),
    };
    refineBook(key, profile);
    growthWrite();
  }

  // What she can say about one rival, and what she does about it.
  function readFor(key, other, entries) {
    const log = Array.isArray(entries) ? entries : duelsRead();
    const name = ASSISTANTS[other] ? ASSISTANTS[other].name : "";
    const plan = planFor(key, other, log);
    const met = plan.met || meetingTally(log, key, other);
    const seen = plan.seen || watchedTally(log, key, other);
    let line = "";
    let kind = "";
    if (met.games) {
      kind = "directe";
      const bits = [met.wins + " v.", met.losses + " d."];
      if (met.draws) bits.push(met.draws + " n.");
      line = name + " : " + bits.join(", ") + " (" + met.games + " partie" + (met.games > 1 ? "s" : "") + ")";
      if (met.matesAgainst) line += " · mat encaissé";
      else if (met.mates) line += " · mat donné";
      else if (met.draws === met.games) line += " · que des nulles";
    } else if (seen.games) {
      kind = "vue";
      line = name + " vue : " + seen.games + " partie" + (seen.games > 1 ? "s" : "") + ", " + seen.wins + " v., " + seen.losses + " d.";
    } else {
      line = name + " : aucune lecture";
    }
    return { kind: kind, line: line, plan: plan, met: met, seen: seen };
  }

  function duelAgo(stamp) {
    const minutes = Math.round((Date.now() - (Number(stamp) || Date.now())) / 60000);
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return "il y a " + minutes + " min";
    const hours = Math.round(minutes / 60);
    if (hours < 24) return "il y a " + hours + " h";
    return "il y a " + Math.round(hours / 24) + " j";
  }

  function renderDuels() {
    if (!ui.duelList) return;
    const rows = duelPairs();
    ui.duelList.textContent = "";
    if (ui.duelEmpty) ui.duelEmpty.hidden = rows.length > 0;
    rows.forEach((row) => {
      const nameA = ASSISTANTS[row.a].name;
      const nameB = ASSISTANTS[row.b].name;
      const item = el("li", "pg-duel-row");
      item.append(el("span", "pg-duel-pair", nameA + " " + row.aWins + "–" + row.bWins + " " + nameB));
      item.append(el("span", "pg-duel-meta", row.games + " partie" + (row.games > 1 ? "s" : "")
        + (row.draws ? " · " + row.draws + " nul" + (row.draws > 1 ? "s" : "") : "")));
      const lastWinner = row.last.win ? ASSISTANTS[row.last.win].name + " gagne" : "nulle";
      item.title = nameA + " / " + nameB + " · " + row.games + " partie" + (row.games > 1 ? "s" : "")
        + " · " + row.aWins + " " + nameA + ", " + row.bWins + " " + nameB
        + (row.draws ? ", " + row.draws + " nulle" + (row.draws > 1 ? "s" : "") : "")
        + " · dernière : " + lastWinner + ", " + duelAgo(row.last.at);
      ui.duelList.append(item);
    });
  }

  // Each sister's style, then what she has learned about the sister opposite her. In a duel both are read; alone, the
  // chosen sister reads her rival. Compact on purpose: a name, three words, and one line of history.
  // Outside a duel she still has a rival to read: the last sister she actually faced, and only then her designated one.
  function knownRival(key) {
    const record = growthRead()[key];
    if (record && typeof record.vs === "string" && record.vs !== key && ASSISTANTS[record.vs]) return record.vs;
    return rivalOf(key);
  }

  // The card and the readout read the same profile, so a duel that changes a book (even a background one) repaints both.
  function renderCardBook() {
    if (!ui.cardBook) return;
    const book = prefsFor(game.lineBy || game.speaker);
    ui.cardBook.textContent = "";
    [["Ouverture aux blancs", book.habit ? book.habit.name : ""], ["Réplique aux noirs", replyLabel(book.reply)]].forEach((pair, index) => {
      if (!pair[1]) return;
      const pill = el("span", "pg-read-habit", pair[1]);
      pill.title = index === 0 ? pair[0] + " : " + pair[1] : pair[0] + " : " + replyDetail(book.reply, book.replyChanged, book.replyDeep, book.replyFamily);
      pill.setAttribute("aria-label", pair[0] + " " + pair[1]);
      if (index === 0 && book.habitLesson) pill.title = pair[0] + " : " + book.habitLesson.title;
      ui.cardBook.append(pill);
    });
    if (book.habitLesson) {
      const note = el("span", "pg-read-note", book.habitLesson.text);
      note.title = book.habitLesson.title;
      note.setAttribute("aria-label", "Ouverture changée par les résultats : " + book.habitLesson.text);
      ui.cardBook.append(note);
    }
  }

  function renderReads() {
    if (!ui.readList) return;
    const keys = [];
    [game.assistant, opponentOf()].forEach((key) => { if (key && ASSISTANTS[key] && keys.indexOf(key) < 0) keys.push(key); });
    const shown = game.mode === "duel" ? keys : keys.slice(0, 1);
    ui.readList.textContent = "";
    if (ui.readEmpty) ui.readEmpty.hidden = shown.length > 0;
    shown.forEach((key) => {
      const other = game.mode !== "duel" ? knownRival(key) : (key === game.assistant ? opponentOf() : game.assistant);
      const profile = prefsFor(key);
      const read = readFor(key, other);
      const item = el("li", "pg-read-row");
      const head = el("div", "pg-read-head");
      head.append(el("span", "pg-read-who", ASSISTANTS[key].name));
      head.append(el("span", "pg-read-style", profile.words.join(" · ")));
      if (profile.habit) {
        const white = el("span", "pg-read-habit", profile.habit.name);
        white.title = profile.habitLesson
          ? "Son ouverture aux blancs : " + profile.habit.name + " · " + profile.habitLesson.title
          : "Son ouverture aux blancs : " + profile.habit.name;
        white.setAttribute("aria-label", "Ouverture aux blancs " + profile.habit.name);
        head.append(white);
        if (profile.habitLesson) {
          const note = el("span", "pg-read-note", profile.habitLesson.text);
          note.title = profile.habitLesson.title;
          head.append(note);
        }
      }
      if (profile.reply) {
        const label = replyLabel(profile.reply);
        const black = el("span", "pg-read-habit", label);
        black.title = "Sa réplique aux noirs : " + replyDetail(profile.reply, profile.replyChanged, profile.replyDeep, profile.replyFamily);
        black.setAttribute("aria-label", "Réplique aux noirs " + label);
        head.append(black);
        // The family her black games support, said out loud: it used to live only in the pill's tooltip, so the one
        // thing a series really changes about her answers was invisible unless you knew to hover.
        const familyWord = FAMILY_WORDS[profile.reply.family] || "";
        if (familyWord) {
          const lesson = profile.replyFamily;
          const learnedFrom = lesson && lesson.from !== lesson.to && FAMILY_WORDS[lesson.from] ? FAMILY_WORDS[lesson.from] : "";
          const family = el("span", "pg-read-habit pg-read-family", "famille " + (learnedFrom ? learnedFrom + " → " + familyWord : familyWord));
          family.title = learnedFrom
            ? "Famille de répliques apprise par ses parties : " + learnedFrom + " → " + familyWord + " après " + (Number(lesson.games) || 0) + " parties"
            : "Famille de répliques que ses parties ont tenue : " + familyWord;
          family.setAttribute("aria-label", "Famille de répliques " + (learnedFrom ? learnedFrom + " vers " + familyWord : familyWord));
          head.append(family);
        }
      }
      const said = read.plan.notes.length ? read.plan.notes.join(" · ") : "";
      item.append(head, el("div", "pg-read-line", "lit " + read.line + (said ? " · " + said : "")));
      item.title = ASSISTANTS[key].name + " · " + profile.words.join(" · ")
        + (profile.habit ? " · ouverture " + profile.habit.name : "")
        + (profile.habitLesson ? " · " + profile.habitLesson.title : "")
        + (profile.reply ? " · réplique " + replyLabel(profile.reply) + " (" + replyDetail(profile.reply, profile.replyChanged, profile.replyDeep, profile.replyFamily) + ")" : "")
        + " · ouverture " + profile.opening.toFixed(2) + ", risque " + profile.risk.toFixed(2) + ", conversion " + profile.convert.toFixed(2)
        + " · " + profile.games + " partie" + (profile.games > 1 ? "s" : "") + " dans le journal"
        + (read.met && read.met.games ? " · face à " + ASSISTANTS[other].name + " : " + read.met.wins + " v., " + read.met.losses + " d., " + read.met.draws + " n." : "")
        + (read.met && read.met.games && read.met.avgPlies ? " · ~" + read.met.avgPlies + " demi-coups par partie" : "");
      ui.readList.append(item);
    });
  }

  function renderLadder() {
    if (!ui.ladderList) return;
    ui.ladderList.textContent = "";
    const playing = game.mode === "duel" ? [game.assistant, opponentOf()] : [game.assistant];
    ladderRows().forEach((row, position) => {
      const item = el("li", "pg-ladder-row");
      if (playing.indexOf(row.key) >= 0) item.classList.add("is-playing");
      item.append(el("span", "pg-ladder-rank", String(position + 1)));
      item.append(el("span", "pg-ladder-name", ASSISTANTS[row.key].name));
      item.append(el("span", "pg-ladder-record", row.wins + "–" + row.draws + "–" + row.losses));
      item.append(el("span", "pg-ladder-points", row.games ? row.points + " pts" : "—"));
      const plural = (count) => (count > 1 ? "s" : "");   // 0 victoire, 1 victoire, 2 victoires
      item.title = ASSISTANTS[row.key].name + " · " + row.wins + " victoire" + plural(row.wins) + " · " + row.draws + " nulle" + plural(row.draws) + " · " + row.losses + " défaite" + plural(row.losses) + " · " + row.games + " partie" + plural(row.games) + " (V–N–D)";
      ui.ladderList.append(item);
    });
  }

  // ---------------------------------------------------------------- growth leaderboard
  // Which section of the view is up. The table keeps its duel running underneath; the growth leaderboard only swaps
  // what is painted, so opening it never pauses a game.
  let playgroundView = "board";

  function setPlaygroundView(name) {
    playgroundView = name === "growth" ? "growth" : (name === "ranking" ? "ranking" : "board");
    if (ui.shell) {
      ui.shell.classList.toggle("is-growth", playgroundView === "growth");
      ui.shell.classList.toggle("is-ranking", playgroundView === "ranking");
    }
    (ui.tabs || []).forEach((tab) => {
      const on = tab.dataset.pgView === playgroundView;
      tab.classList.toggle("is-on", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (playgroundView === "growth") renderGrowthBoard();
    if (playgroundView === "ranking") renderRanking();
  }

  // One line per sister, in ladder order: points and V–N–D, the opening she really plays, and the lesson she keeps. A
  // sister who never finished a duel gets a dash in both places rather than an opening or a lesson she never earned.
  function renderRanking() {
    if (!ui.rankList) return;
    ui.rankList.textContent = "";
    const playing = game.mode === "duel" ? [game.assistant, opponentOf()] : [game.assistant];
    const plural = (count) => (count > 1 ? "s" : "");
    sortRankingRows(rankingRows()).forEach((row) => {
      const item = el("li", "pg-rank-row");
      if (playing.indexOf(row.key) >= 0) item.classList.add("is-playing");
      item.append(el("span", "pg-rank-rank", String(row.position)));
      const body = el("div", "pg-rank-body");
      const head = el("div", "pg-rank-line");
      head.append(el("span", "pg-rank-name", row.name));
      head.append(el("span", "pg-rank-record", row.wins + "–" + row.draws + "–" + row.losses));
      // Sorted by style, the row says which trait carries her play, so the grouping explains itself.
      if (rankSort === "style") head.append(el("span", "pg-rank-style", row.stored ? (row.styleName || "—") : "—"));
      const opening = el("span", "pg-rank-fact");
      opening.append(el("em", "pg-rank-label", "Ouverture"));
      opening.append(document.createTextNode(row.stored && row.habitName ? row.habitName : "—"));
      const lesson = el("span", "pg-rank-fact");
      lesson.append(el("em", "pg-rank-label", "Leçon"));
      lesson.append(document.createTextNode(row.stored && row.lessonText ? row.lessonText : "—"));
      if (row.lesson && row.lesson.title) lesson.title = row.lesson.title;
      body.append(head, opening, lesson);
      item.append(body, el("span", "pg-rank-points", row.games ? row.points + " pts" : "—"));
      item.title = row.name + " · " + row.wins + " victoire" + plural(row.wins) + " · " + row.draws + " nulle" + plural(row.draws)
        + " · " + row.losses + " défaite" + plural(row.losses) + " · " + (row.games ? row.points + " points" : "aucune partie")
        + (row.stored && row.habitName ? " · ouverture " + row.habitName : "")
        + (row.stored && row.lesson && row.lesson.title ? " · " + row.lesson.title : "");
      ui.rankList.append(item);
    });
    renderStyleGrowth();
  }

  // The style ranking reads the same traits the cards read: nothing is invented for it, and a sister without a finished
  // duel keeps a dash. The number is the total distance from her born traits, the trait named is the one that moved most.
  function renderStyleGrowth() {
    if (!ui.progressList) return;
    ui.progressList.textContent = "";
    const plural = (count) => (count > 1 ? "s" : "");
    const decimal = (value) => value.toFixed(3).replace(".", ",");
    const rows = styleGrowthRows();
    // One scale for every row, read against the largest shift among them: a 0,06 move stays visible beside a 0,30 one.
    const widest = rows.reduce((max, row) => Math.max(max, row.gap || 0), 0);
    rows.forEach((row) => {
      const item = el("li", "pg-rank-row");
      item.append(el("span", "pg-rank-rank", String(row.position)));
      const body = el("div", "pg-rank-body");
      const head = el("div", "pg-rank-line");
      head.append(el("span", "pg-rank-name", row.name));
      const drift = el("span", "pg-rank-fact pg-rank-drift");
      drift.append(el("em", "pg-rank-label", "Écart"));
      if (!row.stored) {
        drift.append(document.createTextNode("—"));
      } else {
        // Direction first: the bar leaves the centre toward the trait that moved most, so the row reads without a number.
        const bar = el("span", "pg-rank-scale " + (row.up ? "is-up" : "is-down") + (row.gap > 0 ? "" : " is-flat"));
        bar.append(el("span", "pg-rank-scale-mid"));
        const fill = el("span", "pg-rank-scale-fill");
        fill.style.width = row.gap > 0 && widest > 0 ? Math.max(6, Math.round((row.gap / widest) * 46)) + "%" : "0%";
        bar.append(fill);
        const detail = row.traitName
          ? "Écart de style " + decimal(row.drift) + " · " + row.traitName + (row.up ? " à la hausse" : " à la baisse") + " de " + decimal(row.gap)
          : "Écart de style " + decimal(row.drift) + " · aucun trait déplacé";
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", detail + (widest > 0 ? " · barre relative au plus grand déplacement (" + decimal(widest) + ")" : ""));
        bar.title = bar.getAttribute("aria-label");
        drift.append(bar);
        drift.title = bar.title;
      }
      const trait = el("span", "pg-rank-fact");
      trait.append(el("em", "pg-rank-label", "Trait"));
      trait.append(document.createTextNode(row.stored && row.traitName ? row.traitName + (row.up ? " ↑" : " ↓") : "—"));
      body.append(head, drift, trait);
      item.append(body, el("span", "pg-rank-points", row.stored ? row.games + " partie" + plural(row.games) : "—"));
      item.title = row.name + (row.stored
        ? " · écart de style " + decimal(row.drift) + (row.traitName ? " · trait le plus déplacé : " + row.traitName + (row.up ? " à la hausse" : " à la baisse") : "") + " · " + row.games + " partie" + plural(row.games)
        : " · aucune partie terminée : rien à mesurer");
      ui.progressList.append(item);
    });
  }

  // The reset: the button arms itself, then erases the games, the learned styles and every family lesson, so the
  // growth board can start from born traits again. Both boards are restarted first — a duel that settles after the wipe
  // would write its game straight back in.
  let growthResetTimer = 0;

  function disarmGrowthReset() {
    const button = ui.growthResetButton;
    if (!button) return;
    delete button.dataset.armed;
    button.classList.remove("is-armed");
    button.textContent = "Effacer les parties et les leçons";
    button.setAttribute("aria-pressed", "false");
  }

  // The series as a file: what the duels taught and the journal they came from, with a version so a file from a
  // later page is refused whole instead of half-applied.
  const GROWTH_EXPORT_VERSION = 1;

  function growthStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
      + "-" + pad(now.getHours()) + pad(now.getMinutes());
  }

  function exportGrowth() {
    const payload = {
      version: GROWTH_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      growth: growthRead(),
      duels: duelsRead(),
    };
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "hq-playground-growth-" + growthStamp() + ".json";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Restoring replaces the records in place — there is no merge, because two series interleaved would read as one
  // nobody played. Every refusal says why, and nothing is written until the whole file has been read.
  function restoreGrowth(text) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(text || ""));
    } catch (_) {
      return "Fichier illisible : ce n'est pas du JSON.";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Fichier illisible : ce n'est pas un export de série.";
    if (Number(parsed.version) > GROWTH_EXPORT_VERSION) return "Export d'une version plus récente (" + parsed.version + ") : il n'est pas rechargé.";
    const growth = parsed.growth;
    if (!growth || typeof growth !== "object" || Array.isArray(growth)) return "Fichier illisible : il n'y a aucune partie dedans.";
    const duels = parsed.duels;
    if (!Array.isArray(duels)) return "Fichier illisible : le journal des duels manque.";
    const store = growthStore();
    if (!store) return "Le stockage local est indisponible : rien n'a été rechargé.";
    try {
      store.setItem(GROWTH_KEY, JSON.stringify(growth));
      store.setItem(DUELS_KEY, JSON.stringify(duels));
    } catch (_) {
      return "Le stockage local a refusé le fichier (quota) : rien n'a été rechargé.";
    }
    growthCache = null;
    paintWatch();
    renderStyles();
    renderLadder();
    renderReads();
    renderCardBook();
    renderGrowthBoard();
    renderRanking();
    const sisters = Object.keys(growth).filter((key) => ASSISTANTS[key]).length;
    return "Série rechargée : " + sisters + " sœur" + (sisters > 1 ? "s" : "") + " et " + duels.length + " partie" + (duels.length > 1 ? "s" : "") + " au journal.";
  }

  function growthRecorded() {
    const growth = growthRead();
    return Object.keys(growth).some((key) => Number((growth[key] || {}).games) > 0) || duelsRead().length > 0;
  }

  function clearGrowth() {
    clearTimeout(growthResetTimer);
    growthResetTimer = 0;
    clearTimeout(watch.timer);
    watch.timer = 0;
    watch.due = 0;
    watch.pair = null;
    watch.pos = null;
    watch.history = [];
    watch.status = null;
    watch.result = "";
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        window.localStorage.removeItem(GROWTH_KEY);
        window.localStorage.removeItem(DUELS_KEY);
        window.localStorage.removeItem(WATCH_KEY);
      } catch (_) { /* private mode: nothing was stored, nothing to remove */ }
    }
    growthCache = null;   // the page reads the store through this cache: an empty table means an empty cache
    clearThink();
    newGame();            // a half-played game would teach its result back into the table it just emptied
    paintWatch();
    renderStyles();
    renderLadder();
    renderReads();
    renderCardBook();
    renderGrowthBoard();
    renderRanking();
    watchNew(6);          // a fresh pair, already under way, so the panel does not sit empty after the wipe
  }

  // Rows come from the same records the cards read — preferred opening, reply book, lesson, results. Nothing is
  // derived for the table alone: a sister with no finished duel has no book, so her row says "—" instead of naming a
  // style she never chose. The progress count is the sum of what the duels actually changed: the lesson she keeps,
  // the replies a result replaced and the second-answer lines she learned.
  function growthBoardRows() {
    const all = growthRead();
    return LADDER_ORDER.map((key, index) => {
      const record = all[key] && typeof all[key] === "object" ? all[key] : {};
      const games = Number(record.games) || 0;
      const wins = Number(record.wins) || 0;
      const draws = Number(record.draws) || 0;
      const losses = Number(record.losses) || 0;
      const book = record.book && typeof record.book === "object" ? record.book : null;
      const stored = !!book && !!HABITS[book.white] && games > 0;
      let habit = "";
      let reply = "";
      let family = "";
      let familyMove = null;
      let lesson = null;
      let played = 0;
      let won = 0;
      let whitePlayed = 0;
      let whiteWon = 0;
      let blackPlayed = 0;
      let blackWon = 0;
      let changedReplies = 0;
      let learnedLines = 0;
      let familyLesson = false;
      let words = [];
      if (stored) {
        const profile = prefsFor(key);
        habit = profile.habit ? profile.habit.name : "";
        reply = profile.reply ? replyLabel(profile.reply) : "";
        // The reply family her black results support, and the move a series taught her: named on the row, not only
        // inside the reply's tooltip.
        family = profile.reply && profile.reply.family ? (FAMILY_WORDS[profile.reply.family] || profile.reply.family) : "";
        familyMove = profile.replyFamily || null;
        words = Array.isArray(profile.words) ? profile.words : [];
        lesson = profile.habitLesson || null;
        const cell = book.whiteLearn && book.whiteLearn[book.white] ? book.whiteLearn[book.white] : null;
        whitePlayed = cell ? Number(cell.games) || 0 : 0;
        whiteWon = cell ? Number(cell.wins) || 0 : 0;
        // A sister who only ever played Black has no white-opening cell to read: her games sit in the reply cells, one
        // per opening she faced. Counting them keeps her rate honest instead of a dash that says she never played.
        const learn = book.black && book.black.learn && typeof book.black.learn === "object" ? book.black.learn : null;
        Object.keys(learn || {}).forEach((slot) => {
          const entry = learn[slot];
          if (!entry || typeof entry !== "object") return;
          blackPlayed += Number(entry.games) || 0;
          blackWon += Number(entry.wins) || 0;
        });
        played = whitePlayed + blackPlayed;
        won = whiteWon + blackWon;
        changedReplies = profile.replyChanged && typeof profile.replyChanged === "object" ? Object.keys(profile.replyChanged).length : 0;
        learnedLines = profile.replyDeep && typeof profile.replyDeep === "object"
          ? Object.keys(profile.replyDeep).filter((line) => profile.replyDeep[line] && profile.replyDeep[line].changed).length
          : 0;
        // The White side keeps its lesson on the opening she played (`whiteChanged`); the Black side keeps one on the
        // family of replies her results ruled out (`familyChanged`). Counting only the first gave every sister who
        // never played White a ceiling she could not reach.
        familyLesson = !!(profile.replyFamily && profile.replyFamily.to && profile.replyFamily.from !== profile.replyFamily.to);
      }
      const learned = (lesson ? 1 : 0) + (familyLesson ? 1 : 0) + changedReplies + learnedLines;
      const rate = played > 0 ? Math.round((won / played) * 100) : null;
      const basis = !played ? "" : (whitePlayed && blackPlayed ? "toutes couleurs" : (whitePlayed ? "avec son ouverture" : "avec ses répliques"));
      return {
        key: key, name: ASSISTANTS[key].name, index: index,
        games: games, wins: wins, draws: draws, losses: losses, points: wins * 3 + draws,
        stored: stored, habit: habit, reply: reply, family: family, familyMove: familyMove,
        familyFrom: familyMove && familyMove.from !== familyMove.to && FAMILY_WORDS[familyMove.from] ? FAMILY_WORDS[familyMove.from] : "",
        words: words, lesson: lesson, lessonText: lesson ? lesson.text : "",
        played: played, won: won, rate: rate, basis: basis,
        whitePlayed: whitePlayed, whiteWon: whiteWon, blackPlayed: blackPlayed, blackWon: blackWon,
        changedReplies: changedReplies, learnedLines: learnedLines, familyLesson: familyLesson, learned: learned,
      };
    }).sort((a, b) => b.learned - a.learned
      // The rate is the tie-break, and it is the both-colours rate: a sister who only ever played Black is compared on
      // the games she actually played. A sister with no finished game has no rate and sorts behind every measured one.
      || (b.rate === null ? -1 : b.rate) - (a.rate === null ? -1 : a.rate)
      || b.points - a.points
      || b.wins - a.wins
      || a.index - b.index
      // Last resort, so two sisters equal on everything cannot trade places between two renders.
      || a.key.localeCompare(b.key));
  }

  function renderGrowthBoard() {
    if (!ui.growthList) return;
    ui.growthList.textContent = "";
    const playing = game.mode === "duel" ? [game.assistant, opponentOf()] : [game.assistant];
    growthBoardRows().forEach((row, position) => {
      const item = el("li", "pg-growth-row");
      if (playing.indexOf(row.key) >= 0) item.classList.add("is-playing");
      item.append(el("span", "pg-growth-rank", String(position + 1)));
      const body = el("div", "pg-growth-body");
      const head = el("div", "pg-growth-line");
      head.append(el("span", "pg-growth-name", row.name));
      head.append(el("span", "pg-growth-record", row.stored ? row.wins + "–" + row.draws + "–" + row.losses + " · " + row.points + " pts" : "—"));
      const tags = el("div", "pg-growth-tags");
      const habit = el("span", "pg-growth-tag" + (row.stored ? "" : " is-empty"));
      habit.append(el("em", "pg-growth-tag-label", "Ouverture"), document.createTextNode(row.stored ? row.habit : "—"));
      habit.title = row.stored
        ? "Son ouverture aux blancs, apprise dans ses parties : " + row.habit + (row.lesson ? " · " + row.lesson.title : "")
        : "Aucune partie terminée : aucune ouverture apprise";
      const reply = el("span", "pg-growth-tag" + (row.stored ? "" : " is-empty"));
      reply.append(el("em", "pg-growth-tag-label", "Répliques"), document.createTextNode(row.stored && row.reply ? row.reply : "—"));
      reply.title = row.stored ? "Sa réplique aux noirs, telle qu'elle la joue : " + row.reply : "Aucune réplique apprise : elle n'a pas encore joué les noirs";
      // The family sits beside the two habits: it is what her black results have come to support, and a series can
      // move it (developing → solid) without renaming a single answer.
      const family = el("span", "pg-growth-tag" + (row.stored && row.family ? "" : " is-empty"));
      family.append(el("em", "pg-growth-tag-label", "Famille"), document.createTextNode(row.stored && row.family ? row.familyFrom ? row.familyFrom + " → " + row.family : row.family : "—"));
      family.title = row.stored && row.family
        ? (row.familyFrom
          ? "Famille de répliques apprise par ses parties : " + row.familyFrom + " → " + row.family
          : "Famille de répliques que ses parties ont tenue : " + row.family)
        : "Aucune famille de répliques tant qu'elle n'a pas joué les noirs";
      tags.append(habit, reply, family);
      const stats = el("div", "pg-growth-stats");
      const rate = el("span", "pg-growth-stat");
      rate.append(el("em", "pg-growth-tag-label", "Taux"));
      rate.append(el("strong", "pg-growth-stat-value", row.rate === null ? "—" : row.rate + " %"));
      rate.append(document.createTextNode(row.rate === null ? "" : " (" + row.won + "/" + row.played + ") " + row.basis));
      if (row.rate !== null) {
        rate.title = row.won + " victoire" + (row.won > 1 ? "s" : "") + " sur " + row.played + " partie" + (row.played > 1 ? "s" : "")
          + " : " + row.whiteWon + "/" + row.whitePlayed + " aux blancs avec son ouverture, "
          + row.blackWon + "/" + row.blackPlayed + " aux noirs avec ses répliques"
          // The count is the games that were actually judged, not every game played: an opening she never used has no
          // sample. Saying so keeps the smaller denominator from reading as a mistake.
          + (row.played !== row.games ? " · " + row.played + " partie" + (row.played > 1 ? "s" : "") + " jugée" + (row.played > 1 ? "s" : "") + " sur " + row.games : "");
      }
      const learned = el("span", "pg-growth-stat");
      learned.append(el("em", "pg-growth-tag-label", "Acquis"));
      learned.append(el("strong", "pg-growth-stat-value", row.stored ? String(row.learned) : "—"));
      learned.append(document.createTextNode(row.stored && row.learned > 0 ? " ajustement" + (row.learned > 1 ? "s" : "") : ""));
      learned.title = row.stored
        ? (row.lesson ? "1 leçon gardée" : "aucune leçon gardée")
          + (row.familyLesson ? " · 1 famille de répliques apprise" : "")
          + " · " + row.changedReplies + " réplique" + (row.changedReplies > 1 ? "s" : "") + " remplacée" + (row.changedReplies > 1 ? "s" : "") + " par un résultat · " + row.learnedLines + " ligne" + (row.learnedLines > 1 ? "s" : "") + " de deuxième réponse apprise" + (row.learnedLines > 1 ? "s" : "")
        : "Rien d'appris tant qu'elle n'a pas terminé une partie";
      stats.append(rate, learned);
      body.append(head, tags, stats);
      if (row.stored && row.words.length) {
        const words = el("span", "pg-growth-words", row.words.join(" · "));
        words.title = "Le style que ses parties lui ont donné : " + row.words.join(" · ");
        body.append(words);
      }
      if (row.lesson) {
        const note = el("span", "pg-growth-note", row.lessonText);
        note.title = row.lesson.title;
        body.append(note);
      }
      item.append(body);
      item.title = row.name + (row.stored
        ? " · ouverture " + row.habit
          + (row.family ? " · famille " + (row.familyFrom ? row.familyFrom + " → " + row.family : row.family) : "")
          + " · " + row.learned + " acquis · " + row.wins + " v., " + row.draws + " n., " + row.losses + " d."
        : " · aucune partie terminée");
      ui.growthList.append(item);
    });
  }

  // ---------------------------------------------------------------- the background duel
  // Two sisters play on their own clock, in their own state, saved in localStorage: the board is already moving when
  // the Playground is opened, keeps moving while another view is up, and picks up where it stopped after a reload.
  const WATCH_KEY = "hq_playground_watch";
  const watch = { started: false, pair: null, pos: null, status: null, history: [], timer: 0, due: 0, result: "" };

  function watchStoreRead() {
    try {
      const raw = window.localStorage.getItem(WATCH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function watchStoreWrite() {
    if (!watch.pair) return;
    try {
      const moves = watch.history.map((entry) => nameOf(entry.move.from) + nameOf(entry.move.to) + (entry.move.promo || ""));
      window.localStorage.setItem(WATCH_KEY, JSON.stringify({
        w: watch.pair.w,
        b: watch.pair.b,
        moves: moves,
        result: watch.result,
        updatedAt: Date.now(),
      }));
    } catch (_) { /* private mode: the duel lives for this page only */ }
  }

  function watchReplay(saved) {
    if (!saved || !ASSISTANTS[saved.w] || !ASSISTANTS[saved.b] || saved.w === saved.b) return false;
    let pos = parseFen(START_FEN);
    const history = [];
    for (const text of Array.isArray(saved.moves) ? saved.moves : []) {
      const from = sq(String(text).slice(0, 2));
      const to = sq(String(text).slice(2, 4));
      const promo = String(text).slice(4, 5);
      if (from < 0 || to < 0) break;
      const move = legalMoves(pos).find((m) => m.from === from && m.to === to && (m.promo || "") === promo);
      if (!move) break;
      const colour = colorOf(pos.board[move.from]);
      history.push({ pos: pos, move: move, by: colour === "w" ? saved.w : saved.b, color: colour, actor: "them", captured: !!pos.board[move.to], label: moveLabel(pos, move) });
      pos = applyMove(pos, move);
    }
    watch.pair = { w: saved.w, b: saved.b };
    watch.pos = pos;
    watch.history = history;
    watch.status = settleDraw(gameStatus(pos), history, pos);
    watch.result = typeof saved.result === "string" ? saved.result : "";
    return true;
  }

  function startWatch(pair, prefill) {
    clearTimeout(watch.timer);
    watch.timer = 0;
    watch.due = 0;
    watch.pair = pair;
    watch.pos = parseFen(START_FEN);
    watch.history = [];
    watch.status = gameStatus(watch.pos);
    watch.result = "";
    for (let i = 0; i < (prefill || 0); i += 1) if (!watchStep()) break;
    watchStoreWrite();
    paintWatch();
    if (watch.status && watch.status.over) watchSettle();
    else scheduleWatch();
  }

  function watchNew(prefill) {
    const keys = Object.keys(ASSISTANTS);
    let white = keys[Math.floor(Math.random() * keys.length)];
    let black = white;
    for (let guard = 0; guard < 24 && black === white; guard += 1) black = keys[Math.floor(Math.random() * keys.length)];
    if (black === white) black = keys[(keys.indexOf(white) + 1) % keys.length];
    startWatch({ w: white, b: black }, prefill);
  }

  function watchStep() {
    if (!watch.pos || !watch.pair) return false;
    const status = watch.status || gameStatus(watch.pos);
    if (status.over) return false;
    const key = watch.pos.turn === "w" ? watch.pair.w : watch.pair.b;
    const profile = STRENGTH[key] || STRENGTH.else;
    const faced = watch.pos.turn === "w" ? watch.pair.b : watch.pair.w;
    const tuned = duelTune(key, faced);
    notePlan(key, faced, tuned.plan);
    const move = bestMove(watch.pos, Math.max(1, Math.min(3, profile.depth)), Math.max(70, Math.min(190, profile.budget)), profile.style, watch.history, tuned.tune, baseTraits(key), tuned.shift, { style: prefsFor(key), ply: watch.history.length, first: watch.history[0] && watch.history[0].move, deepPlan: deepPlanFor(key, watch.history) });
    if (!move) return false;
    const before = watch.pos;
    const colour = before.turn;
    watch.history.push({ pos: before, move: move, by: key, color: colour, actor: "them", captured: !!before.board[move.to], label: moveLabel(before, move) });
    watch.pos = applyMove(before, move);
    watch.status = settleDraw(gameStatus(watch.pos), watch.history, watch.pos);
    return true;
  }

  // The watch board keeps its own clock, but not a metronome: the wait follows the position the sister is actually
  // looking at, each one keeps her own tempo, a forced reply comes back at once, and now and then somebody sits back.
  const WATCH_TEMPO = {
    transferania: { base: 520, spread: 760, perMove: 22, snap: 0.22 },
    else: { base: 1150, spread: 900, perMove: 30, snap: 0.08 },
    forgia: { base: 860, spread: 820, perMove: 26, snap: 0.12 },
    securia: { base: 1040, spread: 820, perMove: 28, snap: 0.1 },
    musica: { base: 940, spread: 860, perMove: 26, snap: 0.12 },
    pistonia: { base: 700, spread: 740, perMove: 24, snap: 0.16 },
    inventoria: { base: 1000, spread: 800, perMove: 28, snap: 0.1 },
    culinia: { base: 600, spread: 780, perMove: 23, snap: 0.2 },
  };

  function watchDelay(pos, status, key) {
    const tempo = WATCH_TEMPO[key] || { base: 900, spread: 800, perMove: 26, snap: 0.12 };
    const moves = (status && status.moves) || [];
    // A forced reply is not thinking: she answers while the other one is still letting go of her piece.
    if (moves.length <= 1) return 260 + Math.round(Math.random() * 320);
    const captures = moves.filter((m) => pos.board[m.to]).length;
    const checked = inCheck(pos, pos.turn) ? 1 : 0;
    const tension = Math.min(1100, moves.length * tempo.perMove + captures * 34 + checked * 480);
    const opening = pos.full <= 4 ? 260 : 0;   // they settle in before their first moves
    let delay = tempo.base + Math.random() * tempo.spread + tension + opening;
    if (Math.random() < tempo.snap) delay *= 0.45;   // the move was obvious before the piece landed
    if (Math.random() < 0.07) delay += 2400 + Math.random() * 3600;   // now and then, a real think
    return Math.max(260, Math.min(5600, Math.round(delay)));
  }

  // A hidden tab clamps setTimeout to about one tick a minute: the watch board used to sit on a single ply behind
  // another window. A small worker keeps its own beat, so the move that fell due plays on time even out of sight, and
  // the plain timer stays as the fallback when a worker is refused (CSP, old browser).
  let watchClock = null;
  let watchClockTried = false;

  function watchClockWake() {
    if (watchClockTried) return watchClock;
    if (typeof Worker !== "function" || typeof document === "undefined") { watchClockTried = true; return null; }
    watchClockTried = true;
    try {
      watchClock = new Worker("assets/hq-playground-clock.js");
      watchClock.onmessage = () => {
        if (watch.due && Date.now() >= watch.due) watchPlay();
      };
      watchClock.postMessage({ start: true });
    } catch (_) {
      watchClock = null;
    }
    return watchClock;
  }

  function scheduleWatch() {
    clearTimeout(watch.timer);
    if (!watch.pos || !watch.pair || (watch.status && watch.status.over)) return;
    const key = watch.pos.turn === "w" ? watch.pair.w : watch.pair.b;
    const delay = watchDelay(watch.pos, watch.status || gameStatus(watch.pos), key);
    watch.due = Date.now() + delay;
    watchClockWake();
    watch.timer = setTimeout(watchPlay, delay);
  }

  function watchPlay() {
    clearTimeout(watch.timer);
    watch.timer = 0;
    watch.due = 0;
    if (!watchStep()) {
      if (watch.status && watch.status.over) watchSettle();
      return;
    }
    watchStoreWrite();
    paintWatch();
    if (watch.status && watch.status.over) { watchSettle(); return; }
    scheduleWatch();
  }

  function watchResultText(status) {
    if (!watch.pair) return "";
    const white = ASSISTANTS[watch.pair.w].name;
    const black = ASSISTANTS[watch.pair.b].name;
    if (status && status.over && status.winner) return "Échec et mat — " + (status.winner === "w" ? white : black) + " gagne";
    if (status && status.reason === "repetition") return "Nulle par répétition";
    if (status && status.reason === "fifty") return "Nulle — cinquante coups";
    if (status && status.reason === "stalemate") return "Pat — partie nulle";
    return "Partie nulle";
  }

  function watchSettle() {
    clearTimeout(watch.timer);
    watch.timer = 0;
    watch.due = 0;
    watch.result = watchResultText(watch.status || { over: true, reason: "draw", winner: "" });
    watchStoreWrite();   // the result is stored before the lesson, so a reload never teaches the same game twice
    const watchId = "g" + Date.now();
    learnFromGame(watch.history, { w: watch.pair.w, b: watch.pair.b }, (watch.status && watch.status.winner) || "", watchId);
    noteDuel(watch.pair.w, watch.pair.b, (watch.status && watch.status.winner) || "", watch.status, watch.history.length, watchId);
    paintWatch();
    renderStyles();
    renderLadder();
    renderReads();
    renderCardBook();
    watch.timer = setTimeout(() => { watch.timer = 0; watchNew(0); }, 9000);
  }

  function watchResume() {
    const saved = watchStoreRead();
    if (saved && watchReplay(saved)) {
      if (watch.result) {
        paintWatch();
        watch.timer = setTimeout(() => { watch.timer = 0; watchNew(0); }, 7000);
        return;
      }
      if (watch.status && watch.status.over) { watchSettle(); return; }
      // The clock ran while the Playground was closed: catch up a few plies, never a whole night's worth.
      const elapsed = Math.max(0, Date.now() - (Number(saved.updatedAt) || Date.now()));
      let due = Math.min(5, Math.floor(elapsed / 1400));
      while (due > 0 && !(watch.status && watch.status.over)) {
        if (!watchStep()) break;
        due -= 1;
      }
      if (watch.status && watch.status.over) { watchSettle(); return; }
      watchStoreWrite();
      paintWatch();
      scheduleWatch();
      return;
    }
    watchNew(6);   // first visit: a board already under way, not one waiting for a button
  }

  function paintWatch() {
    if (!ui.watchBoard || !watch.pair) return;
    const pos = watch.pos;
    const last = watch.history.length ? watch.history[watch.history.length - 1].move : null;
    Array.from(ui.watchBoard.children).forEach((cell, i) => {
      const piece = pos.board[i];
      cell.className = "pg-watch-sq " + (((i >> 3) + (i & 7)) % 2 === 0 ? "is-light" : "is-dark");
      cell.querySelector(".pg-watch-glyph").textContent = piece ? GLYPH[piece.toLowerCase()] : "";
      if (piece) cell.classList.add(colorOf(piece) === "w" ? "is-white" : "is-black");
      if (last && (last.from === i || last.to === i)) cell.classList.add("is-last");
    });
    const white = ASSISTANTS[watch.pair.w].name;
    const black = ASSISTANTS[watch.pair.b].name;
    ui.watchNames.textContent = white + " (blancs) · " + black + " (noirs)";
    const turn = pos.turn === "w" ? white : black;
    const plies = watch.history.length;
    ui.watchStatus.textContent = watch.result
      ? watch.result + " · nouvelle paire dans un instant"
      : (watch.status && watch.status.over) ? watchResultText(watch.status)
        : turn + " réfléchit… · " + Math.ceil(plies / 2) + " coup" + (plies >= 4 ? "s" : "");
    ui.watchBox.classList.toggle("is-over", !!watch.result);
  }

  function openWatchDuel() {
    if (!watch.pair) return;
    clearThink();
    game.mode = "duel";
    game.assistant = watch.pair.b;
    game.rival = watch.pair.w;
    game.paused = false;
    game.hint = null;
    try { localStorage.setItem("hq_playground_assistant", game.assistant); } catch (_) { /* private mode */ }
    newGame();
    if (ui.board && ui.board.scrollIntoView) ui.board.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function renderStyles() {
    if (!ui.styleList) return;
    ui.styleList.textContent = "";
    const playing = game.mode === "duel" ? [game.assistant, opponentOf()] : [game.assistant];
    Object.keys(ASSISTANTS).forEach((key) => {
      const row = el("li", "pg-style-row");
      if (playing.indexOf(key) >= 0) row.classList.add("is-playing");
      row.append(el("span", "pg-style-name", ASSISTANTS[key].name));
      row.append(el("span", "pg-style-games", String(growthGames(key))));
      row.append(el("span", "pg-style-word", styleWord(key)));
      row.title = styleDetail(key);
      ui.styleList.append(row);
    });
  }

  let savesSignature = "";

  function renderSaves() {
    if (!ui.saveList) return;
    const list = savesRead();
    if (ui.saveEmpty) ui.saveEmpty.hidden = list.length > 0;
    const signature = list.map((save) => save.id).join("|");
    if (signature === savesSignature) return;   // repainting the board must not rebuild rows the user may have focused
    savesSignature = signature;
    ui.saveList.textContent = "";
    list.forEach((save) => {
      const row = el("div", "pg-save");
      const open = el("button", "pg-save-open");
      open.type = "button";
      open.dataset.pgSave = save.id;
      open.append(
        el("span", "pg-save-title", saveWhen(save.at)),
        el("span", "pg-save-meta", (ASSISTANTS[save.assistant] || ASSISTANTS.else).name
          + " · " + (save.mode === "duel" ? "duel" : "partie") + " · " + save.moves.length + " coups"),
      );
      const remove = el("button", "pg-save-del", "×");
      remove.type = "button";
      remove.dataset.pgSaveDel = save.id;
      remove.setAttribute("aria-label", "Supprimer la sauvegarde du " + saveWhen(save.at));
      row.append(open, remove);
      ui.saveList.append(row);
    });
  }

  function show(host) {
    const target = host || document.getElementById("hq-playground-app");
    if (!target) return;
    if (target.dataset.pgMounted !== "1") {
      build(target);
      target.dataset.pgMounted = "1";
      // A lesson written before defeats pointed at their games gets its journal lines here, once, while the journal is
      // loaded: from then on the tooltip can name the exact duel instead of only its opponent.
      Object.keys(ASSISTANTS).forEach((key) => backfillLessonGames(key));
      renderGrowthBoard();   // la section croissance est peinte avant même d'être ouverte
      renderRanking();       // le classement aussi, pour que son onglet s'ouvre déjà rempli
      game.speaker = game.assistant;
      says(game.line || lineFor("start", null, game.assistant), game.assistant);
    }
    paint();
    if (!watch.started) {
      watch.started = true;
      watchResume();   // picks up where the background duel was left, or starts one already under way
    }
    if (!game.paused && !game.thinking) beginTurn();
  }

  function hide() {
    clearThink();   // a pending assistant reply must not paint a view the user has left
  }

  return {
    show: show,
    hide: hide,
    pure: {
      START_FEN: START_FEN,
      sq: sq,
      nameOf: nameOf,
      colorOf: colorOf,
      parseFen: parseFen,
      attacked: attacked,
      inCheck: inCheck,
      legalMoves: legalMoves,
      applyMove: applyMove,
      gameStatus: gameStatus,
      // Used by the tests: what would this assistant say about this move, in this mode, without touching the page.
      describe: function (key, mode, before, move, next, status) {
        return commentFor(before, move, !!before.board[move.to], next, status, key, mode);
      },
      describeDetail: function (key, mode, before, move, next, status) {
        return commentDetail(before, move, !!before.board[move.to], next, status, key, mode);
      },
      // And what the ally whispers to the Master in a duo.
      describeHelp: function (key, kind, vars) {
        return helpLine(kind, vars, key);
      },
      // And her clause set, so a test can show which closings the redundancy guard refused for a given pool line.
      styleOf: function (key) {
        return STYLE[key] || STYLE.else;
      },
      // How long the background duel lets a sister sit before her next move — a pace read from the position, not a beat.
      watchPace: function (pos, status, key) {
        return watchDelay(pos, status, key);
      },
      // What the duel list teaches them: each sister's style, her read on a rival, and the plan the engine plays.
      duel: {
        habitOf: habitOf,
        replyOf: replyFor,
        replyPlan: replyPlan,
        replyTo: replyForPlan,
        openingKeyOf: openingKey,
        replyKeyOf: replyKey,
        noteReplyOutcome: noteReplyOutcome,
        noteOpeningOutcome: noteOpeningOutcome,
        nextHabitKey: nextHabitKey,
        replyPatience: REPLY_PATIENCE,
        patienceFor: patienceFor,
        replyDetail: replyDetail,
        deepPlanFor: deepPlanFor,
        deepPrefixOf: deepPrefixOf,
        seedDeepPlan: seedDeepPlan,
        planOfMove: planOfMove,
        planMatches: planMatches,
        noteDeepOutcome: noteDeepOutcome,
        deepNames: DEEP_NAMES,
        deepPlans: DEEP_PLANS.slice(),
        bookFor: bookFor,
        habitLessonText: habitLessonText,
        backfillLessonGames: backfillLessonGames,
        duelsRead: duelsRead,
        noteDuel: noteDuel,
        pendingBook: pendingBook,
        adoptPendingBook: adoptPendingBook,
        commitBook: commitBook,
        refineBook: refineBook,
        planFor: planFor,
        tune: duelTune,
        profileOf: profileOf,
        prefsFor: prefsFor,
        readFor: readFor,
        meetingTally: meetingTally,
        watchedTally: watchedTally,
        trace: function () { return planTrace.slice(); },
      },
      // What a duel has taught her: four neutral traits, the signature of one game, and the learning itself.
      growth: {
        traitsFor: traitsFor,
        base: baseTraits,
        games: growthGames,
        label: growthLabel,
        contrast: contrastTrait,
        line: growthLine,
        endLine: growthEndLine,
        pool: GROWTH_LINES,
        endPool: GROWTH_END,
        signatureOf: signatureOf,
        learnFromGame: learnFromGame,
        read: growthRead,
        write: growthWrite,
        board: growthBoardRows,
        ranking: rankingRows,
        progress: styleGrowthRows,
        setView: setPlaygroundView,
      },
      isThreefold: isThreefold,
      halfmoveClock: halfmoveClock,
      drawReason: drawReason,
      settleDraw: settleDraw,
      positionKey: positionKey,
      evaluate: evaluate,
      bestMove: bestMove,
    },
  };
});
