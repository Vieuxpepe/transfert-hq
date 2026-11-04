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
const fetched=[],played=[];let enabled=true,fail=false;
const param={setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}};
const ctx={currentTime:2,destination:{},state:'running',decodeAudioData:async url=>({url,duration:2.8}),
 createGain:()=>({gain:param,connect(){}}),createBufferSource(){
  const s={playbackRate:{value:0},connect(){},start(t){played.push(this);this.started=t;},stop(t){this.stopped=t;}};return s;
 }};
state.audioCtx=ctx;
const win={HqCompanionReactionAudio:{pickVariant:(samples,state)=>pickVariant(samples,state,()=>0)},document:{hidden:false},AudioContext:class{},matchMedia:()=>({matches:false}),
 localStorage:{getItem:k=>k==='hq_companion_forge_sound'?(enabled?'1':'0'):null},
 fetch:async url=>{fetched.push(url);return {ok:!fail||url.endsWith('.m4a'),arrayBuffer:async()=>url};}};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
await warmImpactAudio(win);assert.equal(fetched.length,3,'all impact takes preload before contact');
for(let i=0;i<4;i++){
 now+=150;playBustSlapSfx(win,.8);await flush();
 assert.ok(manifest.impacts.slap.some(s=>s.url===played[i].buffer.url),'impact uses an imported take');
 if(i)assert.notEqual(played[i].buffer.url,played[i-1].buffer.url,'consecutive impacts do not repeat');
 assert.equal(played[i].playbackRate.value,1,'original pitch and tempo');
 assert.equal(played[i].stopped-played[i].started,2.8,'full clip plays without the legacy short truncation');
}
assert.equal(new Set(played.slice(0,3).map(s=>s.buffer.url)).size,3,'each take plays before reshuffling');
assert.equal(fetched.length,3,'preloaded impact buffers are reused on contact');
assert.ok(fetched.every(url=>url.endsWith('.wav')),'legacy impact is not layered underneath');
enabled=false;playBustSlapSfx(win,.8);await flush();assert.equal(played.length,4);
enabled=true;win.document.hidden=true;playBustSlapSfx(win,.8);await flush();assert.equal(played.length,4);
win.document.hidden=false;state.bustSlapBuffers={};fail=true;now+=150;
playBustSlapSfx(win,.8);await flush();
assert.ok(played.at(-1).buffer.url.endsWith('/bust-slap.m4a'),'legacy sound is used only if the selected import fails');
console.log('Impact audio: three-take rotation, cache, full duration, original pitch, controls and exclusive fallback passed');
