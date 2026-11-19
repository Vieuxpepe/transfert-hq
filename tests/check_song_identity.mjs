// The shared now-playing identity (assets/hq-now-playing.js): the beat-grid key, local vs Spotify precedence,
// how long a song has been stable, and the guard that rejects a line naming another track.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const N = createRequire(import.meta.url)('../assets/hq-now-playing.js');

// 1) local key: the beat-grid key, stable from the first frame and across url fragments
assert.equal(N.localKey(''), '', 'no source, no key');
assert.equal(N.localKey('http://127.0.0.1:8765/media/Uni/a.mp3'), 'l-42bdec145f7eb9aa', 'golden vector');
assert.equal(N.localKey('/media/Uni/a.mp3'), 'l-49c194339988234a', 'golden vector, relative url');
assert.equal(N.localKey('http://127.0.0.1:8765/media/Uni/a.mp3#t=12'),
  N.localKey('http://127.0.0.1:8765/media/Uni/a.mp3'), 'a fragment cannot change the key');
assert.equal(N.localKey('http://127.0.0.1:8765/media/Uni/b.mp3'),
  N.localKey('http://127.0.0.1:8765/media/Uni/b.mp3'), 'same source, same key on every call');
assert.notEqual(N.localKey('http://127.0.0.1:8765/media/Uni/a.mp3'),
  N.localKey('http://127.0.0.1:8765/media/Uni/b.mp3'), 'different files differ');
assert.match(N.localKey('/media/Uni/a.mp3'), /^l-[0-9a-f]{8,16}[0-9a-f]{8,16}$/);

// 2) Spotify key: sanitised, bounded, empty for no id
assert.equal(N.spotifyKey(''), '');
assert.match(N.spotifyKey('abc/def:ghi'), /^s-[A-Za-z0-9:_-]+$/);
assert.ok(N.spotifyKey('x'.repeat(200)).length <= 80, 'spotify key is bounded');

// 3) precedence: the local file of the Lecteur tab wins over the Spotify snapshot
const spotify = {trackId: 'sp-1', track: 'Song S', artist: 'Band S'};
assert.deepEqual(N.identity({view: 'lecteur', src: '/media/Uni/a.mp3', playback: spotify}),
  {key: 'l-49c194339988234a', title: '', artist: '', local: true});
assert.deepEqual(N.identity({view: 'musique', src: '/media/Uni/a.mp3', playback: spotify}),
  {key: 's-sp-1', title: 'Song S', artist: 'Band S', local: false});
assert.equal(N.identity({view: 'lecteur', src: '', playback: spotify}).key, 's-sp-1',
  'an empty Lecteur does not shadow Spotify');
assert.equal(N.identity({}).key, '', 'nothing playing, no key');

// 4) remember(): stability starts at the first frame, not when the beat loop starts
N.reset();
const first = N.remember({key: 'l-a', title: 'A'}, 1000);
assert.equal(first.stableMs, 0);
assert.equal(N.remember({key: 'l-a', title: 'A'}, 3500).stableMs, 2500, 'stable while the song holds');
N.reset();
N.remember({key: 'l-a'}, 1000);
assert.equal(N.remember({key: 'l-b'}, 1200).stableMs, 0, 'a new song restarts the clock');
assert.equal(N.remember({key: '', title: ''}, 1400).stableMs, 0, 'no song has no stability');

// 5) the speech guard: a line may not name another track
const title = 'Song A';
assert.equal(N.mentionsOtherTitle('I love “Song A” with you', title), false, 'own title is fine');
assert.equal(N.mentionsOtherTitle('You were playing “Song B” earlier, Master', title), true, 'other title is caught');
assert.equal(N.mentionsOtherTitle('The last track you played was so good', title), true, 'recent-track phrasing is caught');
assert.equal(N.mentionsOtherTitle('You were playing “Song Z” earlier', ''), true, 'with no known title, any quoted track is untrusted');
assert.equal(N.mentionsOtherTitle('My hips move on their own', title), false, 'no title named, no objection');
assert.deepEqual(N.filterLines(['I love “Song B”', 'I love “Song A”', 'just moving~'], title),
  ['I love “Song A”', 'just moving~'], 'filterLines keeps only safe lines');

// 6) the owner override is scoped to the song it was set on
N.setOverride({key: 'l-a', title: 'Real Title'});
assert.equal(N.overrideFor('l-a').title, 'Real Title');
assert.equal(N.overrideFor('l-b'), null, 'an override never leaks onto the next track');
N.setOverride({key: '', title: 'Everywhere'});
assert.equal(N.overrideFor('l-b').title, 'Everywhere', 'an empty key applies until replaced');
N.setOverride(null);
assert.equal(N.overrideFor('l-a'), null, 'clearing the override restores the automatic title');

// 7) current() and reset() expose the last identity
N.reset();
assert.equal(N.current(), null);
N.remember({key: 'l-a', title: 'A'}, 1000);
assert.equal(N.current().key, 'l-a');
N.reset();
assert.equal(N.current(), null, 'reset forgets the song');

// 8) the blind-match flag belongs to the module, so every surface reads the same answer
N.conceal(true);
assert.equal(N.isConcealed(), true, 'conceal(true) hides the song');
assert.equal(N.conceal(false), false, 'conceal() returns the new state');
assert.equal(N.isConcealed(), false);
N.concealFromServer(true);
assert.equal(N.isConcealed(), true, 'the station flag hides the song even without the Musique page');
N.concealFromServer(false);
assert.equal(N.isConcealed(), false);

// 9) the server copy (persisted in .hq-music) wins over the local one and can be cleared
N.setOverride({key: 'l-s', title: 'Local'});
assert.equal(N.overrideFor('l-s').title, 'Local');
N.setServerOverride('l-s', {title: 'Server', artist: 'A'});
assert.equal(N.overrideFor('l-s').title, 'Server', 'the server copy is what every device shows');
N.setServerOverride('l-s', null);
assert.equal(N.overrideFor('l-s').title, 'Local', 'clearing the server copy falls back to the local override');
N.overrideFor('l-s');
N.setServerOverride('l-s', {title: 'Server'});
N.setOverride({key: 'l-s', title: 'Fresh edit'});
assert.equal(N.overrideFor('l-s').title, 'Fresh edit', 'a fresh edit beats the server copy until the POST answers');
N.setOverride(null);

// 10) wiring: the Musique page and the chip both go through the module
const chip = readFileSync(new URL('../assets/hq-musica-chip.js', import.meta.url), 'utf8');
const music = readFileSync(new URL('../assets/hq-music.js', import.meta.url), 'utf8');
assert.match(chip, /SongUnit\.isConcealed\(\)/, 'the chip reads the conceal flag from the module');
assert.equal((chip.match(/window\.__hqBlindMatch/g) || []).length, 1, 'only the module-missing fallback reads the old global');
assert.match(music, /var Song = root\.HqNowPlaying \|\| null;/, 'Musique loads the shared module');
assert.match(music, /Song\.conceal\(hidden\)/, 'the tournament concealment goes through the module');
assert.match(music, /Song\.identity\(/, 'the DJ announce and on-air label resolve the song through identity()');
assert.match(music, /addEventListener\("hq:now-playing"/, 'the page listens to hq:now-playing');
assert.match(music, /addEventListener\("hq:local-play"/, 'the page hears local playback from the Lecteur');
assert.match(music, /\/api\/musica\/dj\/local/, 'local playback makes the show step aside');
assert.match(music, /Song\.filterLines\(\[data\.line\]/, 'the DJ line goes through the shared speech guard');
assert.match(music, /key: song\.key/, 'the DJ announce carries the shared song key');
assert.match(chip, /concealFromServer\(/, 'the chip polls the station conceal flag');
assert.match(chip, /hq:local-play/, 'the Lecteur audio publishes local playback');
assert.match(chip, /var touchHold = event\.pointerType === "touch"[\s\S]{0,1800}spankBooty\(\)[\s\S]{0,1200}openSongTitleEditor\(\)/, 'a touch hold spanks first, then a longer hold opens the title editor');
assert.equal((chip.match(/addEventListener\("contextmenu"/g) || []).length, 1, 'one right-click handler only');
assert.match(chip, /addEventListener\("contextmenu", function \(event\) \{[\s\S]{0,120}openSongTitleEditor\(\)/, 'right-click opens the title editor');
assert.match(chip, /key: askKey/, 'the dance payload carries the shared song key');
assert.match(chip, /\/api\/musica\/song-titles\//, 'the chip asks the server for the saved title');
assert.match(chip, /postSongTitle\(/, 'the editor saves the title server-side');
assert.match(chip, /function stillHolding\(id\) \{\s*return !!\(available && drag && drag\.id === id && !drag\.moved && !pinching\);/, 'the touch hold waits for a still finger on a live chip (a drag, pinch or hide cancels it)');
assert.match(chip, /stillHolding\(holdId\)[\s\S]{0,240}openSongTitleEditor\(\)/, 'the title editor only opens while that hold is still valid');
assert.doesNotMatch(music, /track: item\.name/, 'the DJ announce no longer reads the raw Spotify item');

console.log('song identity ok (stable local key, local>spotify precedence, filtered speech, shared conceal)');
