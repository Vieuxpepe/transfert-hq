import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {create}=require('../assets/hq-companion-reaction-audio.js');
const manifest=JSON.parse(readFileSync(new URL('../assets/companion/chat/reactions/manifest.json',import.meta.url)));
for(const sample of Object.values({...manifest.samples,...manifest.phases,...manifest.impacts}).flatMap(v=>Array.isArray(v)?v:[v])){
 assert.ok(sample.duration_ms>=150&&sample.duration_ms<=12000);
 assert.ok(existsSync(new URL('..'+sample.url,import.meta.url)),'reaction file exists locally');
}
let enabled=true;const sounds=[];
class Audio{
 constructor(url){this.url=url;this.paused=false;sounds.push(this)}
 play(){this.played=true;return Promise.resolve()}
 pause(){this.paused=true}
}
const win={document:{hidden:false},Audio,fetch:async()=>({ok:true,json:async()=>manifest})};
const player=create(win,()=>enabled,()=>0);
assert.equal(await player.ready,true);
const sampleFor=(pool,url)=>Array.isArray(pool)?pool.find(s=>s.url===url):pool;
const hmmDuration=player.start('hmm');
const hmmSample=sampleFor(manifest.samples.hmm,sounds[0].url);
assert.equal(hmmDuration,hmmSample.duration_ms/sounds[0].playbackRate,'animation uses the actual playback duration');
assert.equal(sounds[0].preservesPitch,!!hmmSample.natural,'natural takes keep pitch; legacy takes vary rate');
if(!hmmSample.natural){
 assert.ok(Math.abs(12*Math.log2(sounds[0].playbackRate)+.45)<1e-10,'lower pitch stays within 45 cents');
}
assert.ok(Math.abs(sounds[0].volume-.25*10**(-6/20))<1e-6,'idle reaction gets another 6 dB attenuation');
assert.equal(player.start('laugh'),manifest.samples.laugh.find(s=>s.url===sounds[1].url).duration_ms/sounds[1].playbackRate);
assert.equal(sounds[1].playbackRate,1,'imported takes retain their original pitch and tempo');
assert.equal(sounds[1].preservesPitch,true);
assert.equal(sounds[0].paused,true,'a new gesture stops the old sound');
enabled=false;assert.equal(player.start('exhale'),0);
assert.equal(sounds[1].paused,true,'disabled sound stops current playback');
enabled=true;win.document.hidden=true;assert.equal(player.start('hmm'),0,'hidden pages remain quiet');
win.document.hidden=false;player.start('exhale');player.stop();assert.equal(sounds.at(-1).paused,true,'speech/interruption can stop a reaction');
if(!hmmSample.natural){
 const firstPitch=sounds[0].playbackRate;
 player.start('hmm');assert.notEqual(sounds.at(-1).playbackRate,firstPitch,'repeated reactions avoid nearly identical pitches');
}
const upper=create(win,()=>true,()=>1);await upper.ready;
for(const kind of Object.keys(manifest.samples)){
 const duration=upper.start(kind),sound=sounds.at(-1);
 const sample=Array.isArray(manifest.samples[kind])?manifest.samples[kind].find(s=>s.url===sound.url):manifest.samples[kind];
 assert.ok(Math.abs(12*Math.log2(sound.playbackRate)-(sample.natural?0:.45))<1e-10,'pitch policy for '+kind);
 assert.equal(duration,sample.duration_ms/sound.playbackRate);
}
upper.stop();player.stop();
const unsafe=create({...win,fetch:async()=>({ok:true,json:async()=>({samples:{hmm:{url:'https://example.com/sound.wav',duration_ms:600}}})})},()=>true);
assert.equal(await unsafe.ready,false,'remote reaction URLs are rejected');
assert.equal(unsafe.start('hmm'),0);
const blocked=create({...win,Audio:class{play(){return Promise.reject(new Error('autoplay denied'))}pause(){}}},()=>true);
await blocked.ready;blocked.start('hmm');await Promise.resolve();blocked.stop();
console.log('check_hq_companion_reaction_audio: local assets, settings, interruption and autoplay fallback ok');

const variants=create(win,()=>true);await variants.ready;
const urls=[];
for(let i=0;i<manifest.samples.giggle.length+1;i++){
 variants.start('giggle');urls.push(sounds.at(-1).url);
}
assert.equal(new Set(urls.slice(0,-1)).size,manifest.samples.giggle.length,'every distinct take is used once before repeating');
assert.notEqual(urls.at(-2),urls.at(-1),'shuffle cycles never repeat the boundary take');
const count=sounds.length;
assert.equal(variants.start('yawn',{interrupt:false}),0,'ambient events cannot cut an active recording');
assert.equal(sounds.length,count);
variants.stop('whimper');assert.equal(sounds.at(-1).paused,false,'releasing an unrelated gesture cannot stop the current reaction');
variants.stop('giggle');assert.equal(sounds.at(-1).paused,true);
for(const [kind,samples] of Object.entries(manifest.phases)){
 const urls=samples.map(()=>variants.pickPhase(kind).url);
 assert.deepEqual(new Set(urls),new Set(samples.map(s=>s.url)),'spoken phase visits each matching take: '+kind);
}
assert.equal(variants.pickPhase('unknown'),null);
assert.equal(variants.pickReaction('unknown'),null);
assert.equal(variants.has('slap'),false,'impact recordings are not vocal reactions');
assert.equal(variants.has('unknown'),false);
variants.stop();
console.log('Imported voice pools: natural playback, variants, phase routing and overlap admission passed');

const quiet=create(win,()=>true);await quiet.ready;
quiet.start('giggle',{priority:0});const idleVolume=sounds.at(-1).volume;
quiet.stop();quiet.start('giggle',{priority:1});
assert.ok(Math.abs(sounds.at(-1).volume/idleVolume-10**(6/20))<1e-6,'direct reactions remain louder than idle sounds');
quiet.stop();
