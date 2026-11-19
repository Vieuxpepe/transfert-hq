# Playground growth — live series report

**Status: live-observed, not persisted.** Every number below was read from the
running Playground page (`assets/hq-playground.js`) during one bridge session.
None of it is backed by a surviving on-disk artifact — see
[Evidence status](#evidence-status).

## Series

- 27 duels played through the bridge on the ordinary play-and-learn path.
  The harness froze only the clock and `Math.random`; no styles, traits, books or
  learning calls were injected.
- Sisters: **Else** (4 plies), **Forgia** (4 plies, bold), **Pistonia** (3 plies),
  **Inventoria** (2 plies).
- 15-game round-robin (each pair meets 5×, each sister opens White 5×), then 12
  games with Inventoria opening: 6 White / 6 Black against Forgia and Else, and
  6 more after her opening lesson.
- Colour split per sister: Else 8 White / 8 Black, Forgia 7/9, Pistonia 5/5,
  Inventoria 7/5.

## End state (read after game 27)

| Sister | Opening | Reply family | Replies (1.e4 / 1.d4 / 1.Cf3) | Style opening / risk |
|--------|---------|--------------|------------------------------|----------------------|
| Else | 1.d4 | developing | 1…c6 / 1…e6 / 1…d5 | 0.51 / 0.32 |
| Forgia | 1.Cf3 | sharp | 1…c5 / 1…Cf6 / 1…c5 | 0.65 / 0.73 |
| Pistonia | 1.Cf3 | developing | 1…e6 / 1…d5 / 1…e6 | 0.41 / 0.35 |
| Inventoria | 1.Cf3 | solid | 1…e5 / 1…d5 / 1…Cf6 | 0.24 / 0.34 |

Three reply families are live at the end (`sharp`, `developing`, `solid`) and
hold for the whole series: Forgia `sharp` from her first game, Inventoria `solid`
in all 12 of hers, Else `developing` from her second game. Pistonia was `solid`
in game 1 and `developing` from game 4 (her born opening sits on the 0.40 band
edge). The pair that differs on all three axes is **Forgia vs Else**: family,
opening (`1.Cf3` vs `1.d4`) and risk character (0.73 vs 0.32).

## Result-learned opening (Inventoria)

Two lessons, both written by `noteOpeningOutcome` — a style re-seed never writes
these fields:

```json
"whiteLearn": { "d3": { "games": 3, "losses": 2, "wins": 0, "hist": "dll" } },
"whiteChanged": { "from": "d3", "to": "d4", "losses": 2 }        // after game 20

"whiteLearn": { "d4": { "games": 3, "losses": 2, "wins": 0, "hist": "dll" } },
"whiteChanged": { "from": "d4", "to": "nf3", "losses": 2 }       // after game 26
```

These records predate the `defeats` field (each losing game with its opponent and
the id of its journal line), so the live series could only count its defeats.
Games played from now on carry the id, and on load the page backfills an older
lesson from the duel journal when the game is still there; a defeat whose game
was never kept says "partie non enregistrée" instead of borrowing another line.

She opened `1.d3` in games 16, 18, 20 (draw, loss, loss) and changed at game 20;
`1.d4` in games 22, 23, 26 and changed at game 26. Before the first lesson, style
drift had already reached 0.08 at game 18 and moved her replies
(`1…d5` → `1…e5`, `1…d5` → `1…e6`) without touching `1.d3`.

## Drift after the lesson (game 25)

Anchor `{opening 0.21, risk 0.30}`:

| Game | Drift | Opening | 1.e4 reply | 1.d4 reply | Style |
|------|-------|---------|------------|------------|-------|
| 21 | 0.070 | 1.d4 | 1…e5 | 1…e6 | 0.26 / 0.32 |
| 24 | 0.060 | 1.d4 | 1…e5 | 1…e6 | 0.24 / 0.33 |
| 25 | 0.070 | **1.d4** | 1…e5 | **1…d5** | 0.24 / 0.34 |
| 26 | — | 1.Cf3 (second result lesson) | 1…e5 | 1…d5 | 0.24 / 0.35 |

At game 25 the style pass ran (drift 0.070 ≥ `BOOK_DRIFT` 0.05), re-seeded her
replies (`1.d4 → 1…d5` instead of `1…e6`) and left the result-chosen opening in
place. Traits moved over the same span: bold 0.853 → 0.870, material 1.363 →
1.374.

## Growth, early vs late

Each sister's games split in half, points = win 1, draw 0.5.

| Sister | Early | Late | Trend |
|--------|-------|------|-------|
| Else | 5.0 / 8 (4W 2D 2L, 5W/3B) | 7.5 / 8 (7W 1D 0L, 3W/5B) | clear rise, with fewer Whites |
| Forgia | 4.0 / 8 (3W 2D 3L, 3W/5B) | 5.5 / 8 (4W 3D 1L, 4W/4B) | rise |
| Pistonia | 2.5 / 5 (2W 1D 2L, 3W/2B) | 1.5 / 5 (1W 1D 3L, 2W/3B) | decline |
| Inventoria | 0.5 / 6 (0W 1D 5L, 3W/3B) | 0.5 / 6 (0W 1D 5L, 4W/2B) | flat |

Opening stability: Else changed once (`1.Cf3 → 1.d4`, game 7) and held for 20
games; Pistonia once (`1.d4 → 1.Cf3`, game 5); Forgia once (`1.e4 → 1.Cf3`, style,
no result record); Inventoria twice, both result lessons.

## Evidence status

- **Live-observed, not persisted.** The figures above came from `localStorage`
  (`hq_playground_growth`, `hq_playground_duels`) read in the running page by the
  harness.
- **The disk artifact was destroyed by cleanup.** The harness ran a throwaway
  Chrome profile (`%TEMP%/hq-cdp-live-*`) and removed it after the run; the
  harness report (`C:/Users/Public/hq-live-report.json`) was deleted in the same
  cleanup. No profile, `leveldb` log or report file for this series survives, so
  none of the numbers here can be re-read from disk.
- **Retracted claim.** An earlier report said the lesson record was "byte-intact
  after serialisation and a fresh page load". That was a page reload *inside the
  same Chrome process*, so the new document read the same in-memory storage; no
  disk read was performed. Disk persistence does work — a separate 3-game probe
  ended with a clean `Browser.close`, and its `leveldb` then matched the
  in-memory state exactly (`else 2 games / 1.Cf3 / developing / 1…c6`,
  `forgia 2 / 1.e4 / sharp / 1…c5`, `transferania 1 / 1.Cf3 / sharp / 1…c5`,
  `musica 1 / 1.Cf3 / developing / 1…c6`) — but that check was never run for the
  27-game series.

## Series 2026-11-15 — one lesson, played not seeded

A throwaway profile, empty growth and journal, eight duels finished by the
playground's own background engine (the same `watchSettle` path the page uses;
no lesson object was written by hand): four Culinia–Musica games, then two
Culinia–Inventoria, then two Musica–Culinia.

| Culinia (learner) | before | after |
|---|---|---|
| White samples | `1.Cf3` 3 games, 0 v., 3 d., 0 n. | `1.Cf3` 3 (frozen) + `1.d4` 2 games, 2 v., 0 d. |
| Opening | `1.Cf3` | `1.d4` (lesson `nf3 → d4`) |
| Lesson defeats | — | journal parts 3 and 4, both `vs: musica`, ids `g1794780269747`, `g1794780273310` |
| Replies | sharp: `1…e5 / 1…c5 / 1…Cf6` | sharp, unchanged; learned slot `nf3` |
| Traits | born bold 1.10, develop 0.95 | bold 1.156, material 1.065, develop 0.945 |

Musica, same profile, six games: white `1.Cf3` (2 games, 2 v.), replies
`developing` (`1…c6 / 1…e6 / 1…d5`), traits bold 0.904, develop 1.054. The two
sisters therefore hold different openings (`1.d4` vs `1.Cf3`), different reply
tables on every slot, and different trait directions; Culinia owns the `1.d4`
habit and Musica the `1.Cf3` line. Transferania never sat down and has no record
at all — nothing was invented for her.

The lesson is what moved Culinia: after Musica won parts 3 and 4, the next two
games in the line (against Inventoria) were played with `1.d4` and won, and the
lesson stayed one record with the same two ids — the sample grew, nothing was
duplicated. `patienceFor` kept the verdict quiet while the sample had fewer than
three games, so no lesson appeared before part 4.

## Played series 2026-11-15 — two same-band sisters grow apart

`node tests/play_hq_playground_series.mjs` plays full games through the engine and
finishes each one through `learnFromGame`, the same entry point the page uses at
the end of a duel. Culinia and Forgia start on the same band (`opening 0.5`,
`risk 0.8`) and the same table; they face the same opponent (Musica) on the same
forced first moves — four games on `1.e4`, then four on `1.d4`. Culinia's series
is lost (after her first answer she plays the worst move available, so the defeats
are played on the board), Forgia's is won (Musica plays those bad moves instead).
Four extra games then meet two first moves neither sister faced in the series.

The series is deterministic: the harness fixes the search depth and hands `bestMove` a
budget the search never reaches, and the search itself draws no random numbers, so two
runs print the same 20 games byte for byte. `node tests/check_hq_playground_report.mjs` runs
the script and fails on the first line that drifts from the block below, so the quoted
trajectory cannot go stale without a red check. It checks the trait proof further down the
same way, but only its deterministic rows (see that block). The block was refreshed after the style
learning rule changed the games, refreshed again after the endgame work did, and again when the
learned plan was given weight in move selection: plies and a few results moved, the replies,
families and lessons did not.

```
Départ — même bandeau, même famille, même table :
  culinia  famille sharp  1.e4→1…c5 1.d4→1…Cf6 1.Cf3→1…c5 1.c4→1…e5 1.d3→1…c5
  forgia   famille sharp  1.e4→1…c5 1.d4→1…Cf6 1.Cf3→1…c5 1.c4→1…e5 1.d3→1…c5

Partie  1  culinia  1.e4  défaite (45 plies)  famille sharp  table 1.e4→1…c5  joué 1…c5  1.e4: 1p 0v 0n 1d  appris —  autre 1…e5
Partie  2  forgia  1.e4  victoire (28 plies)  famille sharp  table 1.e4→1…c5  joué 1…c5  1.e4: 1p 1v 0n 0d  appris —  autre 1…e5
Partie  3  culinia  1.e4  défaite (27 plies)  famille sharp  table 1.e4→1…e5  joué 1…e5  1.e4: 2p 0v 0n 2d  appris —  autre 1…e5
Partie  4  forgia  1.e4  victoire (16 plies)  famille sharp  table 1.e4→1…e5  joué 1…e5  1.e4: 2p 2v 0n 0d  appris —  autre 1…e5
Partie  5  culinia  1.e4  défaite (21 plies)  famille sharp  table 1.e4→1…e5  joué 1…e5  1.e4: 3p 0v 0n 3d  appris 1…e5→1…c5  autre 1…e5
Partie  6  forgia  1.e4  victoire (26 plies)  famille sharp  table 1.e4→1…e5  joué 1…e5  1.e4: 3p 3v 0n 0d  appris —  autre 1…e5
Partie  7  culinia  1.e4  défaite (23 plies)  famille sharp  table 1.e4→1…c5  joué 1…c5  1.e4: 4p 0v 0n 4d  appris 1…c5→1…c6  autre 1…e5
Partie  8  forgia  1.e4  victoire (26 plies)  famille sharp  table 1.e4→1…e5  joué 1…e5  1.e4: 4p 4v 0n 0d  appris —  autre 1…e5
Partie  9  culinia  1.d4  défaite (23 plies)  famille classical [famille sharp→classical]  table 1.d4→1…c5  joué 1…c5  1.d4: 1p 0v 0n 1d  appris —  autre 1…e5 (leçon) 1…e5 (style) 1…e5
Partie 10  forgia  1.d4  victoire (26 plies)  famille sharp  table 1.d4→1…c5  joué 1…c5  1.d4: 1p 1v 0n 0d  appris —  autre 1…e5
Partie 11  culinia  1.d4  défaite (21 plies)  famille classical [famille sharp→classical]  table 1.d4→1…e6  joué 1…e6  1.d4: 2p 0v 0n 2d  appris —  autre 1…e5
Partie 12  forgia  1.d4  victoire (30 plies)  famille sharp  table 1.d4→1…c5  joué 1…c5  1.d4: 2p 2v 0n 0d  appris —  autre 1…e5
Partie 13  culinia  1.d4  défaite (21 plies)  famille classical [famille sharp→classical]  table 1.d4→1…e6  joué 1…e6  1.d4: 3p 0v 0n 3d  appris 1…e6→1…d5  autre 1…e5
Partie 14  forgia  1.d4  victoire (26 plies)  famille sharp  table 1.d4→1…c5  joué 1…c5  1.d4: 3p 3v 0n 0d  appris —  autre 1…e5
Partie 15  culinia  1.d4  défaite (17 plies)  famille classical [famille sharp→classical]  table 1.d4→1…d5  joué 1…d5  1.d4: 4p 0v 0n 4d  appris 1…e6→1…d5  autre 1…e5
Partie 16  forgia  1.d4  victoire (26 plies)  famille sharp  table 1.d4→1…c5  joué 1…c5  1.d4: 4p 4v 0n 0d  appris —  autre 1…e5

Après la série — deux ouvertures jamais affrontées pendant la série :
Partie 17  culinia  1.Cf3  nulle (100 plies)  famille classical [famille sharp→classical]  table 1.Cf3→1…Cf6  joué 1…Cf6  1.Cf3: 1p 0v 1n 0d  appris —  autre 1…e5
Partie 18  forgia  1.Cf3  nulle (100 plies)  famille sharp  table 1.Cf3→1…Cf6  joué 1…Cf6  1.Cf3: 1p 0v 1n 0d  appris —  autre 1…e5
Partie 19  culinia  1.c4  nulle (100 plies)  famille classical [famille sharp→classical]  table 1.c4→1…Cf6  joué 1…Cf6  1.c4: 1p 0v 1n 0d  appris —  autre 1…e5
Partie 20  forgia  1.c4  nulle (100 plies)  famille sharp  table 1.c4→1…Cf6  joué 1…Cf6  1.c4: 1p 0v 1n 0d  appris —  autre 1…e5

État final :
  culinia  famille classical  1.e4→1…c6 1.d4→1…d5 1.Cf3→1…Cf6 1.c4→1…c6 1.d3→1…e5  famille apprise sharp→classical (5 parties)
           appris 1.e4 c5→c6, 1.d4 e6→d5
  forgia   famille sharp  1.e4→1…e5 1.d4→1…c5 1.Cf3→1…Cf6 1.c4→1…Cf6 1.d3→1…e5
           appris —

Passage de style après la série (refineBook, 0.95 / 0.75) :
  culinia  famille classical → classical  table 1.e4→1…c6 1.d4→1…d5 1.Cf3→1…Cf6 1.c4→1…c6 1.d3→1…e5  réponses apprises gardées : oui
  forgia   famille sharp → sharp  table 1.e4→1…e5 1.d4→1…c5 1.Cf3→1…Cf6 1.c4→1…Cf6 1.d3→1…e5  réponses apprises gardées : oui
```
Reading the log, per column: `famille` is the family she holds, `[famille X→Y]`
names a result lesson that moved it, `table 1…X→1…Y` is the answer her book held
before she moved, `joué` is the answer she actually played (no `ÉCART` anywhere:
the book drives the first black answer), `1…e4/ligne: Np Vv Nn Dd` is that slot's
sample, `appris` is the recorded answer lesson, and `autre` is a slot she never
faced.

What the series shows:

- Same start, opposite results: identical `sharp` tables in game 1, then Culinia's
  four `1.e4` defeats teach her `1…c5 → 1…e5 → 1…c5 → 1…c6` while Forgia's four wins
  move her from `1…c5` to `1…e5` and keep her there. By game 3 their `1.e4` answers already
  differ.
- The family lesson: once the defeats span two openings (her four `1.e4` losses
  plus the `1.d4` loss of game 9) with no win since, Culinia's family moves
  `sharp → classical` at game 9 and
  stays there for the rest of the series; Forgia's stays `sharp` for all 16 games.
  Two slots still coincide at the end (`1.Cf3 → 1…Cf6`, `1.d3 → 1…e5`):
  `1…c6 / 1…d5 / 1…Cf6 / 1…c6 / 1…e5` against `1…e5 / 1…c5 / 1…Cf6 / 1…Cf6 / 1…e5`.
- Learned answers stay learned: both of Culinia's replaced answers (`1.e4 1…c5 → 1…c6`
  at game 7, `1.d4 1…e6 → 1…d5` at game 15) survive every later game and the
  closing `refineBook` to a 0.95 / 0.75 style, which keeps her `solid` family
  (no `undefined` re-derivation, no return to the band's table).
- Never-faced openings: the `autre` slot stays `1…e5` for both sisters from game 1 to game 20 —
  including at the family switch of game 9, where the learning step prints the same answer
  before and after the switch.
- Later openings come from each sister's own table: `1.c4` is answered `1…c6` by Culinia and
  `1…Cf6` by Forgia, and `1.Cf3` `1…Cf6` by both — the same answer for a different reason,
  her own book rather than a shared default.

Two defects the series exposed, both fixed in `assets/hq-playground.js`:

1. `refineBook` re-derived the family from the style band on every style snapshot
   (`snapshotStyle` runs at each finished duel), which wiped a family a result had
   chosen and dropped per-slot lessons once a rebuild had reset `pref`. It now keeps
   a lesson-chosen family, seeds from that family, and treats `changed[slot].to` as
   learned even after a rebuild.
2. `positionKey` joined only the occupied squares, so most positions with the same
   pieces collided and the repetition rule ended real games after 4–7 plies (the
   series printed `nulle (repetition)` in 7 plies before the fix). Every square is
   now written, empty ones included.

The `répliques` family verdict also gained its two-opening guard while chasing the
first defect: a single opening's defeats stay that opening's lesson.

## Duels joués 2026-11-15 — la leçon de style, réparée

### Ce qui n'allait pas

La leçon comparait deux signatures d'une même partie : `ratio = theirs / own`.
Une signature est dépendante du résultat — une nulle de 120 plies capture peu, un
gain capture beaucoup — alors que les traits vivent autour de 1,0. Deux sœurs qui
jouent le même moteur produisaient donc des signatures presque égales, le rapport
valait ~1 et rien ne bougeait ; et dès qu'une partie traînait, toutes les
signatures baissaient, ce qui se lisait « tout le monde s'est calmé » et refroidissait
les huit sœurs ensemble. Le classement de progression mesurait alors un frémissement
de ±0,005, c'est-à-dire des nombres statiques.

### La règle

Chaque partie porte maintenant deux lectures, chacune autour de 1 pour qu'aucune
échelle n'écrase l'autre :

- `observed = theirs[trait] / own[trait]` — ce qu'elle a vu, sur l'échelle des
  signatures, les deux côtés dans la même partie (poids 0,35) ;
- `company = baseTraits(adversaire)[trait] / current` — qui elle avait en face,
  sur l'échelle des traits (poids 0,65).

`ratio = 0,35 × observed + 0,65 × company`, puis `nudge` borné à ±0,22,
`target = current × (1 + 0,6 × nudge)` et le pas habituel (0,09 gain / 0,11 nulle /
0,16 défaite). La leçon reste plafonnée à ±0,12 autour de son tempérament :
la compagnie la déplace, elle ne la remplace pas. C'est la lecture `company` qui
rend « apprendre de l'autre » démontrable entre deux joueuses du même moteur.

### Preuve hors page — `tests/play_hq_playground_growth.mjs`

Cinq duels par paire et par série, trois séries — quinze duels par paire —, premier coup
`1.e2e4` imposé, couleurs alternées, moteur déterministe (profondeur 3, budget jamais
atteint), l'apprenante une profondeur sous son adversaire pour que l'autre ait quelque
chose à lui montrer. Trait de naissance → trait stocké :

```
  culinia (15 duels contre forgia aggressive)
    bold     1.100 → 1.074  (-0.026)
    material 1.020 → 1.046  (+0.026)
    center   1.000 → 0.968  (-0.032)
    develop  0.950 → 0.938  (-0.012)
  pistonia (15 duels contre inventoria engine)
    bold     0.900 → 1.016  (+0.116)
    material 1.000 → 1.066  (+0.066)
    center   1.000 → 1.104  (+0.104)
    develop  0.980 → 0.982  (+0.002)
```

The same check reads both sides of this block and compares only what the script prints the same way every run: the
learner, the four traits, their born → stored numbers and each row's delta (which must stay the difference of its own
two numbers). The scoreline the script also prints — game results, plies, signatures, the two ladders — is left alone,
because the search stops on a wall-clock budget and a game can end one ply later without the traits moving.

Les deux fiches restent distinctes, et aucune ligne ne sort de la bande. Culinia, quinze fois
face à l'attaquante, perd un peu de mordant (-0,026), prend du matériel (+0,026), lâche un peu de
centre et de sortie (-0,032, -0,012) : sa fiche bouge à peine, et c'est un résultat — elle gagne
sa troisième série sans se transformer. Pistonia, quinze fois face à Inventoria jouée par le
moteur, prend du mordant (+0,116), du matériel (+0,066), du centre (+0,104) et garde sa sortie
(+0,002). Les lignes différentes : mordant 1,074 contre 1,016, centre 0,968 contre 1,104, sortie
0,938 contre 0,982. Le matériel se touche — 1,046 contre 1,066 — et le rapport le dit plutôt que
de le maquiller : les deux sœurs convergent sur l'appétit matériel, pas sur la façon de jouer.

Classement de progression qui en sort (ordre complet, écart = Σ|trait − naissance|) :

```
   1  Pistonia    écart 0.236 · trait centre ↑ · 15 parties
   2  Culinia     écart 0.085 · trait mordant ↓ · 15 parties
   3  Else        —
   4  Transferania—
   5  Securia     —
   6  Forgia      —
   7  Musica      —
   8  Inventoria  —
```

## Croissance par séries — ce que la boucle fait vraiment (2026-11-16)

Le même duel trois fois de suite, et deux étalons rejoués à l'identique avant et après : Musica,
qui ne rencontre jamais les apprenantes dans les séries (transfert vers une inconnue), et la sœur
étudiée elle-même, remise dans son état d'avant la série avant chaque mesure (ce que le plan
appris par rivale peut changer). Six parties par étalon et par mesure, un score par partie pour que
l'écart-type soit celui de l'échantillon et non une impression. Le bloc qui suit est comparé mot
pour mot par `check_hq_playground_report.mjs`.

```
Croissance sur les séries (série 1 → série 3) :
  culinia   score 0.400 → 0.500 · écart 0.072 → 0.096 · leçons 1 → 1
  pistonia  score 0.400 → 0.300 · écart 0.132 → 0.288 · leçons 1 → 1

Étalon après les séries — mêmes 16 parties, sœur opposée remise dans son état d'avant :
  culinia   contre musica     score 0.344 → 0.344 (+0.000 · n=16 · écart-type 0.075 · issues 3) 0.5·0·0.5·0·0.5·0·0·1·0.5·0.5·0.5·0·0.5·0.5·0·0.5
  culinia   contre forgia     score 0.375 → 0.250 (-0.125 · n=16 · écart-type 0.065 · issues 2) 0·0.5·0·0.5·0.5·0.5·0.5·0.5·0.5·0·0.5·0·0·0·0·0
  pistonia  contre musica     score 0.469 → 0.250 (-0.219 · n=16 · écart-type 0.065 · issues 2) 0·0.5·0.5·0.5·0·0.5·0·0.5·0.5·0·0·0·0·0.5·0.5·0
  pistonia  contre inventoria score 0.188 → 0.156 (-0.031 · n=16 · écart-type 0.060 · issues 2) 0.5·0·0·0·0.5·0.5·0·0·0·0.5·0·0·0·0.5·0·0

Chemin appris → coup joué :
  culinia   plan appris b+0.037 m+0.037 c+0.015 d+0.042 · coups changés par le plan 16/168 · réponse au 1.e4 1…c5 · livre : réponse de naissance tenue · portée vers musica : ce qu'elle a appris ailleurs (material)
  pistonia  plan appris b-0.094 m+0.144 c-0.076 d-0.055 · coups changés par le plan 50/124 · réponse au 1.e4 1…c6 · livre : réponse de naissance tenue · portée vers musica : ce qu'elle a appris ailleurs (material)

Après la série — traits stockés contre les traits de naissance :
```

**Un étalon qui mesure enfin quelque chose.** Le tableau précédent était un escalier : six
ouvertures, et pour chaque couleur une seule et même partie, donc deux scores et un écart-type qui
mesurait la couleur. Chaque tableau joue maintenant **seize parties** : deux variantes de la sœur
opposée — son moteur à profondeur trois et à profondeur quatre — croisées avec huit ouvertures
tournantes (`1.e4`, `1.d4`, `1.Cf3`, `1.c4`, `1.d3`, `1.Cc3`, `1.b3`, `1.g3`), deux parties par
cellule, une par couleur. Les résultats ne sont plus binaires : 2 à 3 issues distinctes par tableau,
écart-type de 0,056 à 0,107, et les quatre tableaux d'avant-série tombent sur 0,344 / 0,375 / 0,469
/ 0,188 — quatre valeurs différentes, donc quatre questions différentes. La parenthèse manquante
qui empêchait l'ouverture imposée d'être jouée (`forced || key === learner ? …`) est corrigée dans
le même geste : sans elle, les seize parties d'un tableau étaient littéralement la même partie.

**Les deux configurations, mesurées sur ces seize parties par tableau :**

- Sans la portée (`GROWTH_HOUSE_PLAN=0`) : Culinia 0,344 → 0,313 contre Musica (-0,031 · écart-type
  0,063 · 2 issues) et 0,375 → 0,188 contre Forgia figée (-0,188 · 0,063 · 2) ; Pistonia 0,469 →
  0,188 contre Musica (-0,281 · 0,063 · 2) et 0,188 → 0,156 contre Inventoria figée (-0,031 · 0,060
  · 2). Séries : 0,400 → 0,600 et 0,400 → 0,400.
- Avec la portée gatée par trait (ce qui est livré) : Culinia 0,344 → 0,344 contre Musica (+0,000 ·
  écart-type 0,075 · 3 issues) et 0,375 → 0,250 contre Forgia figée (-0,125 · 0,065 · 2) ; Pistonia
  0,469 → 0,250 contre Musica (-0,219 · 0,065 · 2) et 0,188 → 0,156 contre Inventoria figée (-0,031
  · 0,060 · 2). Séries : 0,400 → 0,500 et 0,400 → 0,300.

**Ce que la mesure tranche, et ce qu'elle refuse de trancher.** Avec un étalon qui varie vraiment,
apprendre coûte plus qu'il ne rapporte : les quatre tableaux reculent ou stagnent, dans les deux
configurations. La portée gatée n'est pas neutre pour autant — elle vaut +0,156 en moyenne sur les
quatre tableaux comparée à la même course sans elle (+0,000 contre -0,031, -0,125 contre -0,188,
-0,219 contre -0,281, -0,031 contre -0,031) — et c'est elle qui tient le tableau étudié de Culinia
à 0,250, exactement la référence. Elle ne fait pas *ajouter* le canal : elle amortit ce que la
leçon coûte. C'est la configuration livrée, parce qu'elle est la seule à tenir les deux tableaux
des sœurs étudiées (0,250 et 0,156) et la série de Culinia (0,500).

**Donc, en toute honnêteté : la porte n'atteint pas la cible.** Les conditions tenues sont celles
des sœurs étudiées (Forgia 0,250 ≥ 0,250 ; Inventoria 0,156 ≥ 0,000), celle de Culinia contre
l'inconnue (0,344 > 0,250) et sa série (0,500 ≥ 0,200). Deux conditions tombent : Pistonia contre
Musica à 0,250 pour une cible de plus de 0,500 (elle partait de 0,469), et sa série à 0,300 pour
une référence de 0,400. Aucun réglage n'a été ajusté sur un tableau isolé pour les rattraper : la
seule re-prise mesurée (seuil de la porte à 0,02 au lieu de 0,005) a donné pire sur les deux
tableaux de Culinia (0,219 et 0,125) et a été écartée. Le détail et la cause sont dans les limites.

### La porte, trait par trait — `GROWTH_AUDIT=1`

Chaque trait est porté **seul** sur les deux tableaux de l'apprenante (quatre parties par cellule),
avec et sans lui. Un trait que la porte ferme ne change aucun décalage : le plan qu'elle joue est
identique au bit près, donc son tableau ne peut pas bouger, et c'est vérifié comme une identité
plutôt que payé en parties. Ce que la porte ouvre, elle le paie en parties :

```
Porte trait par trait — le trait ouvert porté seul, 4 parties par cellule :
  culinia contre musica (engine)
    bold     fermée  · moyenne +0.037 · dérive -0.026 · plan inchangé (aucun effet possible)
    material ouverte · moyenne +0.025 · dérive +0.026 · 0.250 → 0.250 (+0.000)
    center   fermée  · moyenne +0.015 · dérive -0.032 · plan inchangé (aucun effet possible)
    develop  fermée  · moyenne +0.042 · dérive -0.012 · plan inchangé (aucun effet possible)
  culinia contre forgia (aggressive)
    bold     fermée  · moyenne +0.037 · dérive -0.026 · plan inchangé (aucun effet possible)
    material ouverte · moyenne +0.025 · dérive +0.026 · 1.000 → 0.750 (-0.250)
    center   fermée  · moyenne +0.015 · dérive -0.032 · plan inchangé (aucun effet possible)
    develop  fermée  · moyenne +0.042 · dérive -0.012 · plan inchangé (aucun effet possible)
  pistonia contre musica (engine)
    bold     fermée  · moyenne -0.094 · dérive +0.116 · plan inchangé (aucun effet possible)
    material ouverte · moyenne +0.096 · dérive +0.066 · 0.375 → 0.375 (+0.000)
    center   fermée  · moyenne -0.076 · dérive +0.104 · plan inchangé (aucun effet possible)
    develop  fermée  · moyenne -0.055 · dérive +0.002 · plan inchangé (aucun effet possible)
  pistonia contre inventoria (engine)
    bold     fermée  · moyenne -0.094 · dérive +0.116 · plan inchangé (aucun effet possible)
    material ouverte · moyenne +0.096 · dérive +0.066 · 0.125 → 0.000 (-0.125)
    center   fermée  · moyenne -0.076 · dérive +0.104 · plan inchangé (aucun effet possible)
    develop  fermée  · moyenne -0.055 · dérive +0.002 · plan inchangé (aucun effet possible)
```

**Ce que cette vérification dit, et elle ne dit pas ce qu'on espérait.** La porte est cohérente :
elle ouvre exactement là où le signe de la moyenne s'accorde avec celui de la dérive, et ferme
partout ailleurs — mordant, centre et sortie restent fermés pour les deux apprenantes, et les
quatre traits se comportent comme annoncé. Mais le trait qu'elle ouvre, `material`, n'aide pas :
neutre contre l'inconnue pour les deux (0,250 → 0,250, 0,375 → 0,375 sur quatre parties) et coûteux
contre la sœur étudiée (1,000 → 0,750 pour Culinia, 0,125 → 0,000 pour Pistonia). Sur cet
échantillon-là, la portée ne rend personne meilleure ; elle ne fait pas de dégât non plus, et c'est
pourquoi le tableau à seize parties et l'audit à quatre ne disent pas la même chose — 0,250 contre
0,188 sur Forgia — sans qu'aucun des deux puisse trancher à lui seul. Les deux lectures restent
dans ce rapport.

### Preuve dans la page — sans rechargement

Page ouverte sur `#playground`, `performance.timeOrigin = 1794784194422.9` relevé
avant le premier duel et retrouvé identique après le seizième : aucun rechargement.
Seize duels joués dans la page avec ses propres règles (`HqPlayground.pure` :
`bestMove`, `learnFromGame`, `noteDuel`), et le Classement redessiné après chaque
partie par `growth.setView("ranking")`.

```
culinia  (8 duels contre forgia, agressive)   bold 1.123 → 1.201 (+0.078)
                                              material 1.042 → 1.094 (+0.052)
                                              center 1.021 → 1.024 · develop 0.950 → 0.979
pistonia (8 duels contre inventoria, positionnelle) bold 0.900 → 0.842 (-0.058)
                                              material 1.000 → 1.031 (+0.031)
                                              center 1.000 → 0.990 · develop 0.980 → 0.982
```

Classement de progression, lu dans le DOM avant et après, même chargement :

```
avant                           après
1 Culinia    0,066 mordant ↑   1 Culinia     0,228 mordant ↑  9 parties
2 Transferania 0,037 mordant ↓ 2 Inventoria  0,158 mordant ↑  8 parties
3 Else       —                 3 Forgia      0,110 mordant ↓  8 parties
4 Securia    —                 4 Pistonia    0,101 mordant ↓  8 parties
5 Pistonia   —                 5 Transferania 0,037 mordant ↓ 1 partie
6 Forgia     —                 6 Else        —
7 Musica     —                 7 Securia     —
8 Inventoria —                 8 Musica      —
```

La liste s'est réordonnée, les écarts sont ceux des traits stockés, le trait
nommé suit le mouvement, et les trois sœurs qui ont joué (Inventoria, Forgia,
Pistonia) ont quitté le tiret ; Else, Securia et Musica, qui n'ont pas joué,
gardent un « — » honnête. Le classement aux points, lui, n'a pas été touché par
la règle : `Pistonia 24 pts · Forgia 20 · Transferania 3 · Culinia 2 · Inventoria 0`.

## Fin de partie — convertir un gain (2026-11-16)

Une sœur qui gagne matériellement ne gagnait pas la partie : dame ou tour de plus contre
roi seul, elle échangeait des coups jusqu'au partage par répétition. La cause n'était
pas la règle de nulle, mais l'évaluation :

- les feuilles étaient évaluées sans distance de mat, donc une position à mat en deux et
  une position à mat en vingt valaient le même centième de pion ;
- la recherche des captures renvoyait `alpha` en cas de coupure, ce qui fabriquait des
  égalités artificielles — d'où des coups qui pendaient la dame ; elle est maintenant
  fail-soft et évade les échecs ;
- la table du roi du milieu de partie le payait pour se cacher en h2 pendant que le roi
  nu restait au bord : elle est retirée quand la position est déjà gagnée ;
- les égalités se départageaient par l'ordre des coups, donc deux coups de même score
  étaient joués au hasard du générateur ;
- dans une finale silencieuse, l'ordre « captures d'abord » ne trie rien : les coups
  tranquilles qui ont déjà coupé à ce niveau sont rejoués en premier (killer moves),
  sinon l'élagage perdait les trois quarts de son effet.

Une finale convertible se calcule : profondeur fixe de 6 plies sans recherche des
captures, budget de 40 000 nœuds (déterministe, la même position donne toujours le même
coup d'une machine à l'autre) avec l'horloge en filet de sécurité, et un plancher de
280 ms de réflexion pour qu'une sœur sur un chronomètre de 48 ms ne renonce pas au mat
au milieu du filet. L'évaluation de finale ajoute le confinement (rim, boîte taillée par
la tour ou la dame, et le roi gagnant comme mur), la mobilité, l'approche et l'opposition.

Mesures avec le code livré, attaquant au profil de la page (profondeur 3, 320 ms),
trois répétitions par case et par profil de défense :

| Finale | défense 2 / 190 ms | défense 3 / 260 ms | défense 3 / 320 ms |
| --- | --- | --- | --- |
| D contre R, centre | 3/3 mats, 15–17 plis | 3/3 mats, 17–19 plis | 3/3 mats, 17 plis |
| D contre R, bord | 3/3 mats, 21 plis | 2/3 mats, 19–31 plis | 3/3 mats, 19–23 plis |
| T contre R, centre | 3/3 mats, 21–29 plis | 3/3 mats, 19 plis | 3/3 mats, 19–29 plis |
| T contre R, bord | 2/3 mats, 31 plis | 3/3 mats, 19–23 plis | 3/3 mats, 21–23 plis |

34 playouts sur 36 finissent par un mat du camp qui gagne (35 sur 36 au passage
précédent, même réglage). Sur les deux passages, le taux est de 95 % : la dame contre roi convertit
presque toujours, la tour contre roi manque encore parfois et finit alors sur une
répétition, jamais sur une nulle acceptée. Les nulles restent honnêtes : roi contre
roi, roi et fou contre roi, roi et cavalier contre roi partagent toujours. Les trois
règles de nulle sont inchangées et `tests/check_hq_playground.mjs` passe (perft et
coups compris), ainsi que les six positions tactiques au budget de la page (6/6, pire
temps 280 ms). Le milieu de partie ne bouge pas : médiane 52 ms pour un budget de
320 ms, 7 ms pour 190 ms.

Ce qui reste : une finale n'est pas résolue par une table de finales mais par
l'évaluation et six plis, donc une défense qui joue la position exacte peut encore
retarder le mat et forcer une répétition (le mat de T+R demande une quinzaine de coups,
bien au-delà de l'horizon de six plis). Et une finale gagnée coûte jusqu'à ~300 ms par
coup, parfois 350–400 ms quand la machine est chargée : c'est le prix du mat, et c'est
au niveau du budget de la page.

## Limits

- **The benchmark measures games now, not colours.** Sixteen games a board: the sister opposite
  plays two variants (her engine at depth three and at depth four) across eight rotating openings,
  two games per cell, one per colour. Each board reports n, sd and the number of distinct outcomes —
  2 or 3 per board, sd between 0,056 and 0,107 — and the four pre-series boards read 0,344 / 0,375 /
  0,469 / 0,188, which is four separable questions instead of four copies of one. The parenthesis
  bug that stopped the forced opening from ever being played is fixed; before it, all sixteen games
  of a board were the same game.
- **Learning is net negative under this benchmark, and that is the finding.** Every board declines
  or stalls after fifteen duels against the studied sister. The carried plan softens the loss but
  does not turn it into a gain; the honest reading is that the plan is learned against one rival
  and does not generalise to a strongly-played stranger.
- The residual trade, with its numbers: Pistonia against Musica 0,469 → 0,250 (−0,219, sd 0,065,
  2 distinct outcomes, n=16) and her series 0,400 → 0,300. Culinia against Musica holds at 0,344
  (±0,075, 3 outcomes); against frozen Forgia she lands exactly on the 0,250 reference (−0,125,
  sd 0,065); against Inventoria Pistonia holds 0,156 (−0,031, sd 0,060) and her series still ends at
  0,400 when the carry is off. Cause: the gate opens on `material` alone for both learners, and a
  material-hungry lean is what a packed depth-four opponent punishes; the direction is signed by her
  own drift, which was earned against a sister who beats her, not against a stranger.
- The comparison with the carry off is in the section above, same protocol: 0,313 / 0,188 / 0,188 /
  0,156 with series 0,600 / 0,400. Neither configuration meets the whole target; the shipped one is
  the only one that holds both studied-sister boards and Culinia's series, which is the tie-break
  the brief sets. No weight was tuned to a single board: the one re-take measured (gate threshold
  0,02 instead of 0,005) came out worse on both Culinia boards (0,219 and 0,125) and was dropped.
- The gate's open/shut behaviour is verified per learner and per trait in its own short pass
  (`GROWTH_AUDIT=1`, four games per cell): the trait the gate opens is carried alone and the board is
  played with and without it; every other trait is checked by shift identity — carrying it leaves the
  plan she plays with byte-identical, so its board cannot move. The block is quoted below.
- The learning-to-move path is verified for both learners: re-searching her own real positions with
  the plan stripped changes 16 of 168 moves for Culinia and 50 of 124 for Pistonia.
- Trait rows stay inside ±0,12 and stay distinct: boldness 1,074 against 1,016, centre 0,968
  against 1,104, development 0,938 against 0,982. Material is the one near-tie (1,046 against
  1,066) and is reported as such rather than engineered apart.
- The audit pass re-runs the series to reach the same state, so it is a separate ~10-minute command
  rather than part of the default playout; its numbers are not compared by
  `check_hq_playground_report.mjs` (which raises its ceiling to 90 minutes for the now longer
  playout), only the series log, the trait rows and the growth block are.
- The growth proof gives the learner one search shelf less than her opponent, so
the sister opposite her is the one who gets to show her style. It is a deliberate
handicap, not a claim that a full-strength duel moves traits as far.
- Traits stay inside ±0,12 of the temperament a sister was born with, so a series
moves them by hundredths. The progression écart is the honest size of that move,
not a score to maximise.
- Reply families start from the style bands (`sharp` risk ≥ 0.62, `classical`
  opening ≥ 0.60, `developing` ≥ 0.40, else `solid`) but are now judged by their
  own results. Every finished black game is a vote for the family she answered
  with (`black.familyLearn`); once she has answered at least two different first
  moves and the last `patienceFor(familyGames)` games hold no win, she takes the
  next family along `sharp → classical → developing → solid`, skipping a family
  her results already ruled out (`0 v.` with enough defeats). The switch re-seeds
  the preference of the openings she actually faced — a never-faced opening keeps
  its answer — and keeps every answer a result taught her, so it travels into
  `refineBook` with the learned family instead of being reset to the band's.
  A family is only on trial once the defeats span at least two openings: a run of
  losses in one opening is that opening's business, and the slot rule replaces its
  answer first. Two sisters in one band therefore separate through their games,
  not their mood. Proven in `tests/check_hq_playground.mjs` (same-band pair) and
  played end-to-end in the series below.
- Only Inventoria's openings are result-chosen in that series. Else's and
  Pistonia's moves were style-ladder moves (`whiteChanged: null`).
- A family change moves only the openings she has faced; slots she never met keep
  their answer, and once a family lesson exists a style pass leaves those slots
  alone too. Before any family lesson, the band still names her family and a style
  pass re-seeds every slot, as it always did — so the first games of a series show
  her answers moving with her style, and the result rule takes over from the first
  family lesson.
- The family's verdict needs two openings, so one bad answer never renames the
  whole table.
- Colour distribution is uneven per half for some sisters (Else played Black in
  5 of her late 8 games), so the growth table is a tendency, not a controlled
  measurement.
- One deterministic series under frozen clock/random, not a sample of runs.
- `tests/play_hq_playground_growth.mjs` is deterministic in its traits (two runs gave
  the same eight numbers) but not in its scoreline: the search stops on a wall-clock
  budget, so a game can end one ply later and the points ladder shifts. The trait rows
  and the series/yardstick block are what it is there to print, and both are compared
  by `tests/check_hq_playground_report.mjs`; the score ladder and the rankings beside
  them are a by-product and are not compared. That check now runs the playout once and
  reads its output three times, with a 40-minute ceiling, because the playout is a
  quarter of an hour of real games.

## Checks

```bash
node --check assets/hq-playground.js        # syntax
node tests/check_hq_playground.mjs          # learning rules: ladder, band, patience, lessons, families, protection
node tests/check_hq_sister.mjs              # sister director, rows, message caps
node tests/check_hq_pistonia_stream.mjs     # stream/playback
node tests/play_hq_playground_series.mjs    # the played series quoted above (prints its log, no assertions)
node tests/check_hq_playground_report.mjs   # replays the series and the trait proof; fails if either quoted block drifted
node tests/play_hq_playground_growth.mjs    # the two-pairing trait proof quoted above (prints, no assertions)
```

All seven pass at the time of writing. The page was also read live: no console error
(only the pre-existing preload warnings), and at a 320 px viewport the document had
`scrollWidth 304 = clientWidth`, `overflow 0`, every `.pg-rank-row` narrower than
the viewport.
