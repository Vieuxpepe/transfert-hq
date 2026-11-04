import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {pickVariant}=createRequire(import.meta.url)('../assets/hq-companion-reaction-audio.js');
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('../assets/companion/chat/reactions/manifest.json',import.meta.url)));
const source=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8')
 .replace('testCry: bustPullCry,','__impact:{state:S,playBustSlapSfx,warmImpactAudio},testCry: bustPullCry,');
let now=100000;class Clock extends Date{static now(){return now;}}
const box={module:{exports:{}},Date:Clock};vm.runInNewContext(source,box);
const {state,playBustSlapSfx,warmImpactAudio}=box.module.exports.__impact;
const fetched=[],played=[];let enabled=true,fail=false,timerFns=[];
const param={setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}};
const ctx={currentTime:2,destination:{},state:'running',decodeAudioData:async url=>({url,duration:2.8}),
 createGain:()=>({gain:param,connect(){}}),
 createOscillator:()=>({type:'sine',frequency:param,connect(){},start(){},stop(){}}),
 createBufferSource(){
  const s={playbackRate:{value:0},connect(){},start(t){played.push(this);this.started=t;},stop(t){this.stopped=t;}};return s;
 }};
state.audioCtx=ctx;
state.reactionAudio={
  ready:Promise.resolve(true),
  slapImpactUrls:()=>manifest.impacts.slap.map(s=>s.url),
};
const win={HqCompanionReactionAudio:{pickVariant:(samples,state)=>pickVariant(samples,state,()=>0)},document:{hidden:false},AudioContext:class{},matchMedia:()=>({matches:false}),
 setTimeout:(fn)=>{if(typeof fn==='function')timerFns.push(fn);return timerFns.length;},clearTimeout(){},
 localStorage:{getItem:k=>k==='hq_companion_forge_sound'?(enabled?'1':'0'):null},
 fetch:async url=>{fetched.push(url);return {ok:!fail||url.endsWith('.m4a'),arrayBuffer:async()=>url};}};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const slapUrls=manifest.impacts.slap.map(s=>s.url);
await warmImpactAudio(win);
assert.ok(fetched.length>=1&&fetched.length<=2,'deferred warm preloads one or two slap takes first');
for(const url of slapUrls){
 if(!state.bustSlapBuffers?.[url]||state.bustSlapBuffers[url].then){
  state.bustSlapBuffers[url]={url,duration:2.8};
 }
}
const rotate=Math.min(4,slapUrls.length);
for(let i=0;i<rotate;i++){
 now+=150;playBustSlapSfx(win,.8);await flush();
 assert.ok(manifest.impacts.slap.some(s=>s.url===played[i].buffer.url),'impact uses an imported take');
 if(i)assert.notEqual(played[i].buffer.url,played[i-1].buffer.url,'consecutive impacts do not repeat');
 assert.equal(played[i].playbackRate.value,1,'original pitch and tempo');
 assert.equal(played[i].stopped-played[i].started,2.8,'full clip plays without the legacy short truncation');
}
assert.equal(new Set(played.slice(0,Math.min(3,slapUrls.length)).map(s=>s.buffer.url)).size,
 Math.min(3,slapUrls.length),'each take plays before reshuffling');
assert.ok(fetched.length<=2,'startup avoids decoding every impact at once');
assert.ok(fetched.every(url=>url.endsWith('.ogg')),'legacy impact is not layered underneath');
enabled=false;playBustSlapSfx(win,.8);await flush();assert.equal(played.length,rotate);
enabled=true;win.document.hidden=true;playBustSlapSfx(win,.8);await flush();assert.equal(played.length,rotate);
win.document.hidden=false;state.bustSlapBuffers={};fail=true;now+=150;
const fallbackKinds=[];
state.reactionAudio={
  ready:Promise.resolve(true),
  slapImpactUrls:()=>manifest.impacts.slap.map(s=>s.url),
  impactGainDb:()=>3.5,
  has:k=>k==='surprised',
  start:(kind)=>{fallbackKinds.push(kind);return 0.4;},
};
playBustSlapSfx(win,.8);
for(let i=0;i<40;i++)await Promise.resolve();
assert.equal(played.length,rotate,'import failure does not start another impact buffer');
assert.deepEqual(fallbackKinds,['surprised'],'failed import falls back to a surprised vocal reaction');
console.log('Impact audio: manifest slap rotation, cache, full duration, original pitch, controls and vocal fallback passed');
