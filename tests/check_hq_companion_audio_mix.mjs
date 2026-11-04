import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {create,pickVariant}=require('../assets/hq-companion-reaction-audio.js');
const state={},takes=['a','b','c'];let last;
for(let cycle=0;cycle<10;cycle++){
 const bag=[];
 for(let i=0;i<3;i++){
  const take=pickVariant(takes,state,()=>0);
  assert.notEqual(take,last,'no immediate repeats, including cycle boundaries');
  last=take;bag.push(take);
 }
 assert.equal(new Set(bag).size,3,'every take is used before reshuffling');
}
const sounds=[],timers=new Map();let serial=0,enabled=true;
const scene={smoothStops:true,paceReactions:false,mediaPlaying:true};
const sample={url:'/assets/companion/chat/reactions/test.wav',duration_ms:1000,natural:true};
const win={document:{hidden:false},
 setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
 Audio:class{constructor(url){this.url=url;sounds.push(this);}play(){return Promise.resolve();}pause(){this.paused=true;}},
 fetch:async()=>({ok:true,json:async()=>({samples:{hmm:sample,laugh:sample}})})};
const player=create(win,()=>enabled,()=>1,()=>scene);await player.ready;
player.start('hmm',{priority:0});const musicVolume=sounds.at(-1).volume;
player.stop();const outgoing=sounds.at(-1);
assert.notEqual(outgoing.paused,true,'interruption does not hard-pause immediately');
assert.equal([...timers.values()].at(-1).ms,80,'interruption fades over 80ms');
for(const [id,timer] of [...timers])if(timer.ms<80){timers.delete(id);timer.fn();}
assert.ok(outgoing.volume<musicVolume&&outgoing.volume>0,'plain audio fallback fades in steps');
player.start('laugh',{priority:1});const incoming=sounds.at(-1);
for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}
assert.equal(outgoing.paused,true);assert.notEqual(incoming.paused,true,'an old fade cannot stop new playback');
player.stop();enabled=false;player.stop();assert.equal(timers.size,0,'mute clears pending fades immediately');
enabled=true;scene.mediaPlaying=false;player.start('hmm',{priority:0});
assert.ok(Math.abs(sounds.at(-1).volume/musicVolume-10**(-4/20))<1e-6,'idle is another 4dB quieter in silence');
player.stop(undefined,true);scene.paceReactions=true;scene.typing=true;
const before=sounds.length;
assert.equal(player.start('hmm',{priority:0}),0,'typing suppresses spontaneous sounds');
scene.typing=false;scene.busy=true;assert.equal(player.start('hmm',{priority:0}),0,'focused work suppresses idle sounds');
scene.busy=false;assert.equal(player.start('hmm',{priority:0}),0,'recent sound prevents an idle cluster');
assert.equal(sounds.length,before);
const events=[];
const param={value:.12,setValueAtTime(v,t){events.push(['value',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);},
 linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);}};
const ctx={currentTime:5,destination:{},createBiquadFilter:()=>({type:'',frequency:{setValueAtTime(){}},Q:{setValueAtTime(){}},connect(){}}),
 createMediaElementSource:()=>({connect(){}}),createGain:()=>({gain:param,connect(){}})};
const web=create({...win,AudioContext:class{constructor(){return ctx;}}},()=>true,()=>1,()=>({smoothStops:true}));
await web.ready;web.start('hmm',{priority:1});web.stop();
assert.deepEqual(events.at(-1),['ramp',0,5.08],'Web Audio interruptions ramp the current gain to zero');
web.stop(undefined,true);
const mainSource=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8')
 .replace('testCry: bustPullCry,','__mix:{state:S,fadeAudioOut},testCry: bustPullCry,');
const box={module:{exports:{}}};vm.runInNewContext(mainSource,box);
const {fadeAudioOut}=box.module.exports.__mix;
const speechWin={...win,localStorage:{getItem:k=>k==='hq_companion_voice'?'1':null}};
const spoken={volume:1,pause(){this.paused=true;}};
fadeAudioOut(speechWin,spoken);assert.notEqual(spoken.paused,true,'spoken recording fades rather than hard-stopping');
for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}
assert.equal(spoken.volume,0);assert.equal(spoken.paused,true);
const muted={volume:1,pause(){this.paused=true;}};
speechWin.document.hidden=true;fadeAudioOut(speechWin,muted);
assert.equal(muted.paused,true,'hiding the page silences spoken audio immediately');
assert.equal(timers.size,0);
console.log('Audio mix: shuffle coverage, no repeats, smooth interruption, cancellation, quiet-room mix and pacing passed');
