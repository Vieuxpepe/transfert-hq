import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

// Private test hooks stay out of the shipped API.
const source = readFileSync(new URL("../assets/hq-companion.js", import.meta.url), "utf8")
  .replace("testCry: bustPullCry,", "__voice: {speak, stopSpeech, fallbackSpeech, state:S}, testCry: bustPullCry,");
const sandbox = {module:{exports:{}}, console, setTimeout, clearTimeout};
vm.runInNewContext(source, sandbox);
const api = sandbox.module.exports.__voice;
const requests = [], audios = [], utterances = [], timers = new Map();
const storage = new Map([["hq_companion_voice", "1"], ["hq_companion_device_id", "voice-test-device"]]);
const win = {
  document:{hidden:false}, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
  matchMedia:()=>({matches:true}), clearInterval:()=>{}, AbortController,
  setTimeout:(fn, ms)=>{const id=Symbol();timers.set(id,{fn,ms});return id;}, clearTimeout:id=>timers.delete(id),
  speechSynthesis:{cancel(){},getVoices:()=>[],speak:u=>utterances.push(u)},
  SpeechSynthesisUtterance:class {constructor(text){this.text=text;}},
  Audio:class {constructor(url){this.url=url;audios.push(this);} play(){return Promise.resolve();} pause(){this.paused=true;}},
  fetch:(url,options)=>new Promise(resolve=>requests.push({options,resolve})),
};
const flush = ()=>new Promise(resolve=>setImmediate(resolve));
const respond = (index,url)=>requests[index].resolve({json:async()=>({ok:true,audio_url:url})});

api.speak(win,"Première phrase.");
api.speak(win,"Deuxième phrase.");
assert.equal(requests[0].options.signal.aborted,true);
respond(1,"/new.mp3"); await flush();
respond(0,"/old.mp3"); await flush();
assert.deepEqual(audios.map(a=>a.url),["/new.mp3"]);
const old=audios[0];
api.speak(win,"Troisième phrase."); respond(2,"/third.mp3"); await flush();
assert.equal(old.paused,true);
old.onended();
assert.equal(api.state.currentAudio.url,"/third.mp3");

api.speak(win,"Réponse annulée.");
storage.set("hq_companion_voice","0"); api.stopSpeech(win);
respond(3,"/muted.mp3"); await flush();
assert.equal(audios.length,2);
assert.equal(api.state.currentAudio,null);

storage.set("hq_companion_voice","1");
const text="Je me demande pourquoi. Peut-être demain ?";
api.fallbackSpeech(win,text,{rate:.94,pitch:1.01,pause:360});
assert.equal(utterances[0].rate,.94);
utterances[0].onend();
assert.equal([...timers.values()][0].ms,360);
const next=[...timers.values()][0].fn; timers.clear(); next();
assert.equal(utterances.map(u=>u.text).join(""),text);
utterances[1].onend();
api.stopSpeech(win);
assert.equal(timers.size,0);
api.state.voicePreview=true;
const before=requests.length;
api.speak(win,"Une ligne ambiante pendant l'essai.");
assert.equal(requests.length,before);
api.speak(win,"Un essai volontaire.",null,"social","warm");
assert.equal(JSON.parse(requests.at(-1).options.body).style,"warm");
api.state.voicePreview=false;
api.stopSpeech(win);
console.log("Companion voice cancellation and pacing: passed");
