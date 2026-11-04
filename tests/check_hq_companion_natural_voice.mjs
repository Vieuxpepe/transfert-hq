import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {create}=require('../assets/hq-companion-reaction-audio.js');
const manifest=JSON.parse(readFileSync(new URL('../assets/companion/chat/reactions/manifest.json',import.meta.url)));
const source=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8')
  .replace('testCry: bustPullCry,','__natural: {state:S,playNaturalVoiceCue,syncCompanionMusic,startIdleHumming,stopIdleHumming}, testCry: bustPullCry,');
let now=100000;
class Clock extends Date { static now(){return now;} }
const sandbox={module:{exports:{}},Date:Clock};vm.runInNewContext(source,sandbox);
const {state,playNaturalVoiceCue,syncCompanionMusic}=sandbox.module.exports.__natural;
const {startIdleHumming,stopIdleHumming}=sandbox.module.exports.__natural;
const sounds=[],classes=new Set(),storage=new Map([['hq_companion_forge_sound','1']]);
const classList={contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k),
  toggle(k,on){if(on)classes.add(k);else classes.delete(k);}};
const media={paused:true,ended:false,readyState:4};
const win={document:{hidden:false,querySelectorAll:()=>[media]},
  matchMedia:()=>({matches:false}),setTimeout:(fn,ms)=>{win.lastTimer={fn,ms};return 1;},clearTimeout(){},
  requestAnimationFrame:()=>1,
  localStorage:{getItem:k=>storage.get(k)||null},
  Audio:class{constructor(url){this.url=url;sounds.push(this);}pause(){this.paused=true;}play(){return Promise.resolve();}},
  fetch:async()=>({ok:true,json:async()=>manifest})};
state.el={hidden:false,classList,querySelector:()=>null};
const player=create(win,()=>true,()=>1);await player.ready;state.reactionAudio=player;
syncCompanionMusic(win);
assert.equal(sounds.length,0,'a loaded but paused track is not a humming context');
media.paused=false;syncCompanionMusic(win);
assert.equal(sounds.at(-1).url,manifest.samples.humming[0].url,'actual playback starts humming without a random idle draw');
const humming=sounds.at(-1);
assert.ok(playNaturalVoiceCue(win,'tickle')>0);
assert.equal(humming.paused,true,'a direct tickle supersedes ambient humming');
assert.equal(sounds.at(-1).url,manifest.samples.giggle[0].url);
const laugh=sounds.at(-1);
assert.equal(player.start('exhale',{interrupt:false,priority:0}),0,'an idle mouth gesture cannot steal the interaction sound');
player.stop('exhale');assert.equal(laugh.paused,undefined,'a different gesture cannot stop laughter');
assert.equal(playNaturalVoiceCue(win,'tickle'),0,'tickle cooldown prevents repeated restarts');
media.paused=true;syncCompanionMusic(win);
assert.equal(laugh.paused,undefined,'pausing music cannot stop an unrelated reaction');
player.stop();
state.currentAudio={};
assert.equal(playNaturalVoiceCue(win,'stretch'),0,'speech retains ownership');
state.currentAudio=null;
assert.ok(playNaturalVoiceCue(win,'stretch')>0,'stretch supplies a natural yawn context');
assert.equal(sounds.at(-1).url,manifest.samples.yawn[0].url);
player.stop();assert.equal(playNaturalVoiceCue(win,'stretch'),0,'idle yawns are bounded');
assert.ok(playNaturalVoiceCue(win,'lip_bite')>0);
assert.equal(sounds.at(-1).url,manifest.samples.lipsmack[0].url);
player.stop();
for(let i=1;i<manifest.samples.humming.length;i++){
  now+=46000;media.paused=false;syncCompanionMusic(win);
  assert.equal(sounds.at(-1).url,manifest.samples.humming[i].url,'successive music situations reach each humming take');
  media.paused=true;syncCompanionMusic(win);
  assert.equal(sounds.at(-1).paused,true,'humming stops when music pauses');
}
now+=100000;const before=sounds.length;
win.document.hidden=true;playNaturalVoiceCue(win,'tickle');
win.document.hidden=false;state.voicePreview=true;playNaturalVoiceCue(win,'tickle');
state.voicePreview=false;storage.set('hq_companion_forge_sound','0');playNaturalVoiceCue(win,'tickle');
assert.equal(sounds.length,before,'natural contexts respect hidden pages, preview and effects toggle');
for(const item of manifest.import.sources){
  assert.ok(manifest.contexts[item.context],item.source+' has an assigned natural context');
  const [section,key]=item.context.split('.');
  const pool=manifest[section][key];
  const list=Array.isArray(pool)?pool:[pool];
  const stem=item.source.replace(/\.mp3$/i,'').toLowerCase();
  const reachable=list.some(sample=>sample.url===item.url)||
    list.some(sample=>String(sample.url||'').includes(stem));
  if (String(item.url||'').includes('/elevenlabs_20261104/')) {
    assert.ok(reachable,item.source+' is reachable through its context pool');
  }
}
const importUrls=new Set(manifest.import.sources.map(item=>item.url));
assert.ok(manifest.import.sources.length >= 95,'import ledger keeps growing with sound-design batches');
assert.ok(importUrls.size >= 90,'distinct imported recordings remain addressable');
assert.ok(importUrls.size <= manifest.import.sources.length);
storage.set('hq_companion_forge_sound','1');state.win=win;state.lastActAt=now-25000;
assert.equal(startIdleHumming(win),true,'quiet idle can hum without music');
assert.equal(classes.has('is-idle-humming'),true);
assert.equal(win.lastTimer.ms,manifest.samples.humming[0].duration_ms,'animation follows the current recorded take');
const idleSound=sounds.at(-1);syncCompanionMusic(win);
assert.notEqual(idleSound.paused,true,'media polling does not cancel independent idle humming');
stopIdleHumming(win);assert.equal(idleSound.paused,true);
assert.equal(classes.has('is-idle-humming'),false);
assert.equal(startIdleHumming(win),false,'two-minute cooldown prevents idle repeats');
now+=120001;state.lastActAt=now-1000;
assert.equal(startIdleHumming(win),false,'recent user activity postpones humming');
state.lastActAt=now-25000;state.currentAudio={};
assert.equal(startIdleHumming(win),false,'speech prevents idle humming');
state.currentAudio=null;win.matchMedia=()=>({matches:true});
assert.equal(startIdleHumming(win),false,'reduced motion disables the idle animation');
win.matchMedia=()=>({matches:false});
// Exercise the mouth's actual audio-ownership lifecycle without needing a rendered SVG.
const mouthSource=readFileSync(new URL('../assets/hq-companion-mouth.js',import.meta.url),'utf8');
const fragment=mouthSource.slice(mouthSource.indexOf('    let gesture = null,'),mouthSource.indexOf('    const afterSpeech ='));
const makeGestures=vm.runInNewContext('(function(win,reactionAudio){'+fragment+';return {beginGesture,clearGesture};})');
const stopped=[];let admitted=false;
const gestures=makeGestures({performance:{now:()=>now}},
  {start:()=>admitted?1000:0,stop:kind=>stopped.push(kind)});
gestures.beginGesture('exhale',now);gestures.clearGesture();
assert.deepEqual(stopped,[],'an animation whose audio was not admitted cannot stop another interaction');
admitted=true;gestures.beginGesture('laugh',now);gestures.clearGesture();
assert.deepEqual(stopped,['laugh'],'an animation cancels only its own admitted sound kind');
console.log('Natural recording contexts: real music, tickling, stretch, lip gesture, priority, cooldowns and import coverage passed');
