// The Musica chip names a local song twice: syncBeatKey() stores the beat-grid key in beatKey, and the chip's
// speech asks the model about "the current track". When those derived the key differently (beatKey was empty at
// first, so the identity started as an ad-hoc key and switched to the grid key), dancePackFor() threw away a pack
// that had just been written and she spoke about the wrong song.
//
// Both now go through assets/hq-now-playing.js, and the speech payloads may only use that identity — never the
// raw Spotify snapshot. This check fails when that wiring drifts.
//
//   node tests/check_musica_song_identity.mjs [file]
//
// The optional file argument lets a test point the check at a copy (used to prove the guard fails on drift).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file = process.argv[2] || new URL('../assets/hq-musica-chip.js', import.meta.url);
const src = readFileSync(file, 'utf8');

// Text of a function body, brace-matched from its opening "{". Comments are stripped first: they may explain a
// rule by naming a symbol ("never read beatKey"), and only code decides.
function body(name) {
  const head = src.indexOf('function ' + name + '(');
  assert.ok(head >= 0, name + '() must exist in the chip');
  let i = src.indexOf('(', head);
  for (let depth = 0; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')' && (depth -= 1) === 0) break;
  }
  const open = src.indexOf('{', i);
  assert.ok(open > 0, name + '() must have a body');
  for (let depth = 0, j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && (depth -= 1) === 0) return stripComments(src.slice(open + 1, j));
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

const stripComments = (text) => String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// 1) musicKey() delegates to the shared module: one hash, one prefix, one source of truth.
assert.match(src, /var SongUnit = window\.HqNowPlaying;/, 'the chip must load the shared module as SongUnit');
assert.equal((src.match(/function musicKey\(/g) || []).length, 1, 'musicKey() must be defined once');
const keyFn = body('musicKey');
assert.match(keyFn, /SongUnit\.localKey\(/, 'musicKey() must delegate the local key to the shared localKey()');
assert.match(keyFn, /SongUnit\.spotifyKey\(/, 'musicKey() must delegate the Spotify key to the shared spotifyKey()');
assert.doesNotMatch(keyFn, /"l-"\s*\+/, 'musicKey() must not rebuild the local key beside the shared module');

// 2) syncBeatKey() stores musicKey(<its element parameter>) in beatKey.
const syncHead = src.slice(src.indexOf('function syncBeatKey(')).match(/function syncBeatKey\(\s*([\w$]+)\s*\)/);
assert.ok(syncHead, 'syncBeatKey() must take the element as its only parameter');
const syncEl = syncHead[1];
const sync = body('syncBeatKey');
const syncKey = sync.match(/([\w$]+)\s*=\s*musicKey\(\s*([\w$]+)\s*\)/);
assert.ok(syncKey, 'syncBeatKey() must compute its key with musicKey()');
assert.equal(syncKey[2], syncEl, 'syncBeatKey() must call musicKey() on the element it was given');
assert.match(sync, /beatKey\s*=\s*key\b/, 'syncBeatKey() must store that key in beatKey');

// 3) currentSong() reports the shared identity, and it remembers how long the song has been stable.
const song = body('currentSong');
assert.match(song, /SongUnit\.identity\(/, 'currentSong() must resolve the song through the shared identity()');
assert.match(song, /SongUnit\.remember\(/, 'currentSong() must track stability through the shared remember()');
assert.doesNotMatch(song, /\bbeatKey\b/,
  'currentSong() must not read beatKey: it is empty until the dance loop starts, so the key would change mid-track');
assert.doesNotMatch(song, /"l:/,
  'currentSong() must not build an ad-hoc "l:<src>" key beside the shared module');

// 4) Speech payloads use that identity, never the raw Spotify snapshot (the hq:playback event may still carry
//    the Spotify snapshot for other consumers; only the two speech requests are constrained here).
const dance = body('danceGenFetch');
assert.match(dance, /var song = currentSong\(\), askTrack = song\.title, askArtist = song\.artist/,
  'the dance pack must be requested for currentSong()');
assert.match(dance, /track:\s*askTrack,/, 'the dance payload must send the resolved title');
assert.match(dance, /artist:\s*askArtist,/, 'the dance payload must send the resolved artist');
assert.doesNotMatch(dance, /playback\.track|playback\.artist/, 'the dance payload must not read the Spotify snapshot');
const ambient = body('fetchAmbientWhisper');
assert.match(ambient, /var song = currentSong\(\);/, 'the whisper must resolve the song through currentSong()');
assert.match(ambient, /track:\s*song\.title,/, 'the whisper payload must send the resolved title');
assert.match(ambient, /artist:\s*song\.artist,/, 'the whisper payload must send the resolved artist');
assert.doesNotMatch(ambient, /playback\.track|playback\.artist/, 'the whisper must not read the Spotify snapshot');

console.log('musica song identity ok (currentSong() and syncBeatKey() share HqNowPlaying; speech uses it)');
