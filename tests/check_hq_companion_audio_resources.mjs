import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {create}=createRequire(import.meta.url)('../assets/hq-companion-reaction-audio.js');
const nodes=new Set(),media=new Set(),timers=new Map();let serial=0,lastAudio,ownedContexts=0;
const param=()=>({value:.1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}});
const node=extra=>{const value={...extra,connect(){},disconnect(){nodes.delete(value);}};nodes.add(value);return value;};
const ctx={currentTime:1,state:'running',destination:{},
 createBiquadFilter:()=>node({frequency:param(),Q:param()}),
 createGain:()=>node({gain:param()}),createMediaElementSource:()=>node({})};
let fail=false;
const win={document:{hidden:false},
 AudioContext:class{constructor(){ownedContexts++;}},
 setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
 Audio:class{constructor(url){this.url=url;lastAudio=this;media.add(this);}pause(){}removeAttribute(){media.delete(this);}load(){}
  play(){return fail?Promise.reject(new Error('blocked')):Promise.resolve();}},
 fetch:async()=>({ok:true,json:async()=>({samples:{hmm:{url:'/assets/companion/chat/reactions/test.deadbee1.ogg',duration_ms:1000}}})})};
const player=create(win,()=>true,()=>1,()=>({audioContext:ctx,smoothStops:true}));await player.ready;
for(let i=0;i<2000;i++){
 assert.ok(player.start('hmm')>0);assert.ok(nodes.size>=3&&nodes.size<=4);assert.equal(media.size,1);
 switch(i%4){
 case 0:lastAudio.onended();break;
 case 1:lastAudio.onerror();break;
 case 2:player.stop(undefined,true);break;
 case 3:player.stop();for(const fn of [...timers.values()])fn();break;
 }
 assert.ok(nodes.size<=1,'per-play nodes released; master bus may persist');assert.equal(media.size,0,'finished media releases its source');
 assert.equal(timers.size,0,'interruption cleanup leaves no timers');
 assert.equal(lastAudio.onended,null);assert.equal(lastAudio.onerror,null);
}
fail=true;player.start('hmm');await Promise.resolve();
assert.ok(nodes.size<=1,'rejected playback releases its graph');assert.equal(media.size,0);
assert.equal(ownedContexts,0,'reaction playback reuses the shared context');
console.log('Audio resource stress: 2,000 play/end/error/stop cycles; zero retained nodes, sources or timers; shared context reused');
