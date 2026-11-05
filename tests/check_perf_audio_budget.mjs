// Decoded-audio cache: bounded by count AND by bytes; concurrent decode jobs capped at 3; in-flight jobs never evicted.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {create}=createRequire(import.meta.url)('../assets/hq-companion-reaction-audio.js');
const MB=1024*1024;let live=0,peak=0,sizeOf=()=>2*MB/4;  // samples per buffer (mono float32)
const ctx={currentTime:1,state:'running',destination:{},resume:async()=>{},
 createBiquadFilter:()=>({connect(){},disconnect(){},frequency:{},Q:{}}),createGain:()=>({connect(){},disconnect(){},gain:{value:1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}}}),
 decodeAudioData:async()=>{live++;peak=Math.max(peak,live);await new Promise(r=>setTimeout(r,5));live--;return {length:sizeOf(),numberOfChannels:1,sampleRate:44100,duration:1};}};
const win={document:{hidden:false},AudioContext:class{},setTimeout,clearTimeout,Audio:class{},
 fetch:async(u)=>String(u).includes('manifest')?{ok:true,json:async()=>({samples:{hmm:{url:'/assets/companion/chat/reactions/a.deadbee1.ogg',duration_ms:1000}}})}:{ok:true,arrayBuffer:async()=>new ArrayBuffer(8)}};
const player=create(win,()=>true,()=>1,()=>({audioContext:ctx,smoothStops:true}));await player.ready;
// 1) twenty 8 MB buffers (160 MB) -> at most 48 MB retained, decoded 3 at a time
sizeOf=()=>2*MB;  // 2M samples * 4 bytes = 8 MB
const urls=Array.from({length:20},(_,i)=>'/assets/companion/chat/reactions/x'+i+'.deadbee1.ogg');
await player.warmSamples(urls);
const kept=urls.filter(u=>player.getDecodedBuffer(u));
assert.ok(kept.length>=1&&kept.length*8<=48,'retained '+kept.length+' x 8 MB must fit the 48 MB budget');
assert.equal(kept[kept.length-1],urls[urls.length-1],'the newest buffer is retained');
assert.ok(peak<=3,'decode concurrency '+peak+' must stay <= 3');
// 2) many tiny clips are still limited by count (48)
sizeOf=()=>1000;
const small=Array.from({length:80},(_,i)=>'/assets/companion/chat/reactions/s'+i+'.deadbee1.ogg');
await player.warmSamples(small);
const keptSmall=small.filter(u=>player.getDecodedBuffer(u)).length;
assert.ok(keptSmall<=48&&keptSmall>=40,'tiny clips: '+keptSmall+' retained (<=48)');
// 3) a duplicate in-flight request shares one decode
let dec=0;const orig=ctx.decodeAudioData;ctx.decodeAudioData=async(...a)=>{dec++;return orig(...a);};
const u='/assets/companion/chat/reactions/dup.deadbee1.ogg';await Promise.all([player.warmSample(u),player.warmSample(u),player.warmSample(u)]);
assert.equal(dec,1,'one decode for three concurrent requests');
console.log('audio budget ok: kept',kept.length,'x 8 MB, peak concurrency',peak,', tiny kept',keptSmall);
