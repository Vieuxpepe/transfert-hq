import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
let now=100000;
class Clock extends Date{static now(){return now;}}
const source=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8')
 .replace('testCry: bustPullCry,','__spam:{state:S,playBustSlapSfx,stopImpactAudio,playLewdPhaseWav,stopSpeech,playVocalSynthFx},testCry: bustPullCry,');
const box={module:{exports:{}},Date:Clock};vm.runInNewContext(source,box);
const api=box.module.exports.__spam,state=api.state,sources=[],audios=[],oscillators=[];
const param=()=>({value:.1,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){},cancelScheduledValues(){}});
let deferred=null;
const ctx={currentTime:100,state:'running',destination:{},
 decodeAudioData:async()=>deferred?await deferred:{duration:2.8},
 createGain:()=>({gain:param(),connect(){},disconnect(){}}),
 createBufferSource(){const s={playbackRate:{},connect(){},disconnect(){},start(){sources.push(this);},stop(t){this.stopAt=t;}};return s;},
 createOscillator(){const o={frequency:param(),connect(){},start(){oscillators.push(this);},stop(){}};return o;}};
state.audioCtx=ctx;state.nsfwOn=true;
const win={document:{hidden:false},AudioContext:class{},matchMedia:()=>({matches:false}),clearTimeout(){},clearInterval(){},
 localStorage:{getItem:k=>k==='hq_companion_forge_sound'||k==='hq_companion_voice'?'1':null},
 speechSynthesis:{cancel(){}},fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}),
 Audio:class{constructor(url){this.url=url;audios.push(this);}play(){return Promise.resolve();}pause(){this.paused=true;}}};
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
for(let i=0;i<100;i++)api.playBustSlapSfx(win,.8);
await flush();assert.equal(sources.length,1,'same-event duplicates and pointer bursts produce one impact');
for(let i=0;i<10;i++){now+=120;ctx.currentTime=now/1000;api.playBustSlapSfx(win,.8);await flush();}
assert.equal(state.activeImpactVoices.length,2,'sustained fast contact cannot stack unlimited impact tails');
assert.ok(sources[0].stopAt<102,'older tails are faded out early');
api.stopImpactAudio();assert.equal(state.activeImpactVoices.length,0);
state.bustSlapBuffers={};now+=300;let resolve;
deferred=new Promise(r=>resolve=r);api.playBustSlapSfx(win,.8);await flush();
const before=sources.length;now+=300;resolve({duration:2.8});await flush();
assert.equal(sources.length,before,'late decode is discarded instead of playing a catch-up impact');
deferred=null;state.reactionAudio={pickPhase:()=>({url:'/test.wav'}),stop(){}};
now+=9000;
for(let i=0;i<100;i++){api.playLewdPhaseWav(win,'climax_fever');api.stopSpeech(win);}
assert.equal(audios.length,1,'a repeated spoken phase cannot restart itself in a burst');
now+=1000;api.playLewdPhaseWav(win,'deepthroat');assert.equal(audios.length,1,'different phases share a two-second gap');
now+=8000;api.playLewdPhaseWav(win,'climax_fever');assert.equal(audios.length,2,'phase can play again after cooldown');
api.stopSpeech(win);state.reactionAudio=null;now+=1000;
for(let i=0;i<100;i++)api.playVocalSynthFx(win,'mwah');
assert.equal(oscillators.length,1,'legacy synth fallback is also rate-limited');
now+=200;api.playVocalSynthFx(win,'mwah');assert.equal(oscillators.length,1,'per-kind cooldown prevents a fallback drone');
state.currentAudio={};now+=1000;api.playVocalSynthFx(win,'mwah');assert.equal(oscillators.length,1,'legacy effects do not play under speech');
const audioBox={module:{exports:{}},Date:Clock};
vm.runInNewContext(readFileSync(new URL('../assets/hq-companion-reaction-audio.js',import.meta.url),'utf8'),audioBox);
const sample={url:'/assets/companion/chat/reactions/test.deadbee1.ogg',duration_ms:1000};
const player=audioBox.module.exports.create({...win,fetch:async()=>({ok:true,json:async()=>({samples:{hmm:sample}})})},()=>true,()=>1,
 ()=>({paceReactions:true}));await player.ready;
for(let i=0;i<3;i++){assert.ok(player.start('hmm')>0);audios.at(-1).onended();now+=12000;}
assert.equal(player.start('hmm'),0,'idle playback is limited to three starts per minute');
now+=30000;assert.ok(player.start('hmm')>0,'idle budget recovers without a queued burst');player.stop();
console.log('Audio spam audit: burst deduplication, bounded impact tails, stale decode, phase/synth guards and idle budget passed');
