import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {create}=require('../assets/hq-companion-reaction-audio.js');
const manifest=JSON.parse(readFileSync(new URL('../assets/companion/chat/reactions/manifest.json',import.meta.url)));
const source=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8')
  .replace('testCry: bustPullCry,','__audio: {state:S,playVocalSynthFx,playPleasureGruntSfx,playLewdPhaseWav,playTreatWav,stopSpeech}, testCry: bustPullCry,');
let now=100000;class Clock extends Date{static now(){return now;}}
const sandbox={module:{exports:{}},Date:Clock};vm.runInNewContext(source,sandbox);
const api=sandbox.module.exports,fx=api.__audio,state=fx.state;
const storage=new Map([['hq_companion_forge_sound','1'],['hq_companion_voice','1']]);
const sounds=[];
const classes=new Set();
const classList={contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k)};
const win={document:{hidden:false},performance:{now:()=>1000},
  localStorage:{getItem:k=>storage.get(k)||null},matchMedia:()=>({matches:false}),
  clearTimeout(){},clearInterval(){},speechSynthesis:{cancel(){}},
  Audio:class{constructor(url){this.url=url;sounds.push(this);}play(){return Promise.resolve();}pause(){this.paused=true;}},
  fetch:async()=>({ok:true,json:async()=>manifest})};
const player=create(win,()=>!classes.has('is-speaking')&&!state.voicePreview&&!win.document.hidden);
await player.ready;state.reactionAudio=player;state.nsfwOn=true;
for(const [kind,event] of Object.entries({mwah:'kiss',gasp:'surprised',sigh:'contented',moan:'moan',whisper:'lipsmack'})){
  player.stop();fx.playVocalSynthFx(win,kind);
  assert.ok(manifest.samples[event].some(s=>s.url===sounds.at(-1).url),kind+' uses the matching new pool');
}
player.stop();fx.playPleasureGruntSfx(win,.8);
assert.ok(manifest.samples.pleasure.some(s=>s.url===sounds.at(-1).url));
player.stop();state.pullVoice=null;
for(let i=0;i<50;i++)api.testCry(win,60,.8);
assert.equal(sounds.filter(a=>manifest.samples.whimper.some(s=>s.url===a.url)).length,1,'pointermove starts one recorded take per gesture');
api.testStop();assert.equal(sounds.at(-1).paused,true);
state.el=null;
for(const [phase,pool] of Object.entries(manifest.phases)){
  now+=9000;fx.playLewdPhaseWav(win,phase);
  assert.ok(pool.some(s=>s.url===sounds.at(-1).url),phase+' replaces the legacy phase bank');
  fx.stopSpeech(win);
}
fx.playTreatWav(win,'kiss');assert.ok(manifest.samples.kiss.some(s=>s.url===sounds.at(-1).url));
fx.stopSpeech(win);
const before=sounds.length;
state.nsfwOn=false;fx.playLewdPhaseWav(win,'deepthroat');fx.playVocalSynthFx(win,'moan');
assert.equal(sounds.length,before,'adult recordings require the existing adult mode');
state.nsfwOn=true;storage.set('hq_companion_mute_until',String(Date.now()+60000));
fx.playVocalSynthFx(win,'mwah');fx.playLewdPhaseWav(win,'deepthroat');
assert.equal(sounds.length,before,'mute applies to recorded effects and lines');
storage.delete('hq_companion_mute_until');win.document.hidden=true;
fx.playVocalSynthFx(win,'mwah');fx.playLewdPhaseWav(win,'deepthroat');
assert.equal(sounds.length,before,'hidden pages stay silent');
win.document.hidden=false;state.voicePreview=true;
fx.playVocalSynthFx(win,'mwah');fx.playLewdPhaseWav(win,'deepthroat');
assert.equal(sounds.length,before,'voice preview keeps ownership');
console.log('Recorded event routing: matching pools, pull voice limit, speech, mode, mute, visibility and preview passed');
