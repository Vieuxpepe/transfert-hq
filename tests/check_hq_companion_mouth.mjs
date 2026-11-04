import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {geometry,target,browTarget,eyeGeometry,blinkClosure,textEnvelope,wordVisemes,visemeAt,textWordDuration,lifeGesture,VISEMES,MODES,BROW_MODES}=require('../assets/hq-companion-mouth.js');
for(const mode of Object.keys(MODES)) for(const time of [0,100,900,5000]){
 const t=target(mode,{time,speaking:true,pull:.7,voice:.2});
 for(const k of ['open','smile','round'])assert.ok(t[k]>=0&&t[k]<=1);
 const g=geometry(t.open,t.smile,t.round,t.extend,t.curl,t.sway);
 for(const k of ['cavity','upper','lower','teeth','tongue','highlight','tongueOut','tongueFold','tongueShine'])assert.ok(!/NaN|Infinity/.test(g[k]));
 assert.ok(g.width>=30&&g.width<=50);assert.ok(g.bottom<35);
}
assert.equal(target('auto',{}).open,0,'rest keeps original mouth');
assert.ok(target('auto',{pull:1}).open>.85,'reaction can open widely');
assert.ok(target('wide').open>target('open').open);
assert.ok(geometry(1,0,0).bottom>geometry(0,0,0).bottom+25,'wide opening adds a cavity rather than scaling a painted lip');
assert.ok(geometry(.1,1,0).width>geometry(.1,0,0).width,'smile widens corners');
assert.deepEqual(target('laugh',{time:0,reduced:true}),target('laugh',{time:500,reduced:true}),'reduced motion has a static laugh');
console.log('check_hq_companion_mouth: expression ranges, geometry, original rest and reduced motion ok');

const lickA=target('lick',{time:0}),lickB=target('lick',{time:700});
assert.notEqual(lickA.extend,lickB.extend,'tongue extension cycles');
assert.notEqual(lickA.curl,lickB.curl,'tongue tip curls independently');
assert.notEqual(geometry(lickA.open,lickA.smile,lickA.round,lickA.extend,lickA.curl,lickA.sway).tongueOut,
 geometry(lickB.open,lickB.smile,lickB.round,lickB.extend,lickB.curl,lickB.sway).tongueOut);
assert.equal(target('auto',{}).extend,0,'tongue-out is opt-in');
assert.deepEqual(target('lick',{time:0,reduced:true}),target('lick',{time:900,reduced:true}),'reduced motion uses a static tongue pose');
assert.equal(target('lick',{time:0}).extend,0,'gesture starts with lips preparing');
assert.ok(target('lick',{time:1300}).curl>target('lick',{time:930}).curl,'curl follows the outward reach');
assert.equal(target('lick',{time:2700}).extend,0,'tongue withdraws for a resting interval');
assert.deepEqual(target('lick',{time:0}),target('lick',{time:3200}),'loop closes without a pose jump');
for(let time=1;time<=3200;time++) {
 const previous=target('lick',{time:time-1}),next=target('lick',{time});
 for(const key of ['open','extend','curl','sway','jaw','headTilt','headNod']) assert.ok(Math.abs(next[key]-previous[key])<.006,'gesture has no sudden frame jumps');
}
assert.ok(target('lick',{time:930}).jaw>target('lick',{time:0}).jaw,'jaw opens during the reach');
assert.ok(target('lick',{time:930}).headTilt<-.5,'head leans into the gesture');
for(const mode of Object.keys(MODES)) if(mode!=='lick') {
 const pose=target(mode,{time:930});
 for(const key of ['jaw','headTilt','headNod']) assert.equal(pose[key],0,'other modes release gesture motion');
}
for(const key of ['jaw','headTilt','headNod']) assert.equal(target('lick',{reduced:true})[key],0,'reduced motion suppresses head and jaw movement');

for(const mode of Object.keys(BROW_MODES)) {
 for(let time=0;time<12000;time+=40) {
  const pose=browTarget(mode,{time}),next=browTarget(mode,{time:time+1});
  for(const side of ['left','right']) {
   assert.ok(pose[side]>=-.65&&pose[side]<=1,'bounded eyebrow movement');
   assert.ok(Math.abs(pose[side]-next[side])<.006,'smooth eyebrow transitions');
  }
 }
 assert.deepEqual(browTarget(mode,{time:0,reduced:true}),browTarget(mode,{time:9000,reduced:true}),'reduced brows remain static');
}
assert.equal(browTarget('left',{time:700}).right,0,'single eyebrow mode leaves the other resting');
assert.equal(browTarget('right',{time:700}).left,0);
assert.equal(browTarget('raise',{time:700}).left,1,'deliberate lift has a held pose');
assert.equal(browTarget('raise',{time:2500}).left,0,'expression releases fully');
assert.ok(browTarget('frown',{time:700}).left<0,'frown lowers the brows');
assert.ok(browTarget('auto',{time:3000}).left>0,'Auto adds a deliberate expression without a mouth gesture');
for(const mode of Object.keys(MODES)) {
 const reaction=target(mode,{pulling:true,pull:0,time:1000});
 assert.ok(reaction.open>.9,'an active pull opens wide regardless of the selected mouth mode or tension');
 assert.equal(reaction.extend,0,'pull temporarily suppresses the tongue gesture');
 assert.equal(reaction.headTilt,0,'pull retains ownership of face alignment');
}
assert.equal(target('neutral',{pulling:false}).open,0,'release restores the selected expression');
assert.equal(blinkClosure(0),0);
assert.equal(blinkClosure(.32),1,'upper lid reaches full closure quickly');
assert.equal(blinkClosure(.44),1,'blink holds closed briefly');
assert.equal(blinkClosure(1),0,'blink fully reopens');
assert.ok(blinkClosure(.2)>blinkClosure(.8),'reopening is slower than closing');
for(let i=0;i<=100;i++) {
 const g=eyeGeometry(i/100);
 for(const path of Object.values(g)) assert.ok(!/NaN|Infinity/.test(path));
}
assert.notEqual(eyeGeometry(0).lash,eyeGeometry(1).lash,'lash follows a changing curve rather than scaling an oval');
assert.notEqual(eyeGeometry(1,'left').lashes,eyeGeometry(1,'right').lashes,'eyelashes fan toward the outer corner on each side');
assert.notEqual(eyeGeometry(0).lashes,eyeGeometry(1).lashes,'eyelashes follow the moving lid');
for(const mode of Object.keys(MODES)) {
 const quiet=target(mode,{speaking:true,audioLevel:0,time:900});
 const soft=target(mode,{speaking:true,audioLevel:.2,time:900});
 const loud=target(mode,{speaking:true,audioLevel:.65,time:900});
 assert.equal(quiet.open,0,'measured silence closes the mouth without a synthetic pulse');
 assert.equal(quiet.jaw,0,'measured silence closes the jaw');
 assert.ok(loud.open>soft.open&&loud.jaw>soft.jaw,'voice intensity drives lips and jaw together in every selected mode');
 assert.ok(Math.abs(loud.jaw-loud.open*.95)<1e-9,'jaw follows the same opening envelope');
 assert.equal(loud.extend,0,'speaking temporarily suppresses other mouth gestures');
}
assert.equal(target('auto',{speaking:true,audioLevel:1,pulling:true}).open,.96,'pull reactions keep priority over speaking');
assert.equal(target('auto',{speaking:true,reduced:true}).jaw,0,'reduced motion suppresses speech jaw movement');
assert.equal(target('neutral',{speaking:false,audioLevel:.8}).open,0,'stopped speech restores the selected mode despite a stale audio level');
assert.ok(textEnvelope('Bonjour',60,140)>.3,'displayed words produce a readable mouth beat');
assert.equal(textEnvelope('Bonjour.',350,480),0,'punctuation pause closes the mouth');
assert.equal(textEnvelope('—',50,200),0,'punctuation alone does not make speech');
assert.equal(textEnvelope('Bonjour',141,140),0,'word animation expires');
for(const mode of Object.keys(MODES)) {
 const pose=target(mode,{textLevel:.45});
 assert.equal(pose.open,.45,'silent text animates regardless of the saved mouth mode');
 assert.equal(pose.jaw,.45*.95,'jaw follows streamed words');
 assert.equal(pose.extend,0);
}
assert.equal(target('auto',{textLevel:.5,speaking:true,audioLevel:0}).open,0,'actual voice silence takes priority over text beats');
assert.equal(target('auto',{textLevel:.5,pulling:true}).open,.96,'pull reaction takes priority over text beats');
assert.deepEqual(wordVisemes('beau'),['M','O'],'French eau stays one rounded vowel');
assert.deepEqual(wordVisemes('chat!'),['SH','A'],'ch is grouped and final t is silent');
assert.deepEqual(wordVisemes('papa'),['M','A','M','A'],'closed-lip consonants alternate with vowels');
assert.deepEqual(wordVisemes('vous'),['F','U'],'ou stays rounded and final s is silent');
assert.deepEqual(wordVisemes('…'),[],'punctuation has no sounds');
assert.ok(VISEMES.S.round<VISEMES.SH.round,'S/Z stay flatter than SH/CH');
assert.ok(geometry(VISEMES.I.open,VISEMES.I.smile,VISEMES.I.round).width>geometry(VISEMES.U.open,VISEMES.U.smile,VISEMES.U.round).width+10,'wide and rounded vowels have distinct lip widths');
assert.ok(geometry(.13,.35,.08,0,0,0,1).bottom<geometry(.13,.35,.08).bottom,'F/V raises the lower lip');
assert.equal(target('auto',{textPose:VISEMES.M}).seal,1,'closed consonants cover the painted mouth');
assert.equal(target('auto',{textPose:VISEMES.M}).jaw,0,'closed consonants close the jaw');
for(const word of ['Bonjour','papa','beau','vous','chérie!','…']) for(let elapsed=0;elapsed<=600;elapsed+=5) {
 const pose=visemeAt(wordVisemes(word),elapsed,600,word);
 for(const value of Object.values(pose)) assert.ok(Number.isFinite(value)&&value>=0&&value<=1,'visemes remain bounded through transitions');
 const to=target('auto',{textPose:pose});
 assert.ok(Math.abs(to.jaw-pose.open*.95)<1e-9,'jaw follows changing sound shapes');
}
assert.deepEqual(visemeAt(wordVisemes('Bonjour.'),500,600,'Bonjour.'),VISEMES.M,'punctuation keeps the drawn lips closed until speech ends');
assert.deepEqual(visemeAt(['I'],0,140,'me',VISEMES.U),VISEMES.U,'a new word starts from the preceding lip shape');
assert.equal(visemeAt(['O'],139,140,'you').seal,1,'unpunctuated words retain their drawn mouth through the last frame');
assert.ok(visemeAt(['O'],139,140,'you').round>.7,'vowels do not snap closed before the next word');
const longPlan=wordVisemes('internationalisation');
const longDuration=textWordDuration('internationalisation',160,longPlan);
assert.ok(longDuration>300,'long pronunciations are not compressed into a spelling-only interval');
assert.equal(textWordDuration('internationalisation.',160,longPlan)-longDuration,340,'full-stop pause remains separate from pronunciation time');
assert.equal(textWordDuration('a',83,['A']),83,'short words retain their normal pacing');
assert.equal(textWordDuration('…',415,[]),415,'punctuation-only pauses are not doubled');
for(const duration of [-100,0,40,160,1000,Infinity,NaN]) {
 const paced=textWordDuration('longword.',duration,Array(80).fill('M'));
 assert.ok(Number.isFinite(paced)&&paced>=40&&paced<=1600,'unusual input never creates an invalid timer');
}
for(const kind of ['smile','listen','press','exhale','linger','hmm','laugh']) for(const side of [-1,1]) {
 for(let time=0;time<3300;time+=25) {
  const pose=lifeGesture(kind,time,side);
  if(!pose)continue;
  const g=geometry(pose.open,pose.smile,pose.round,0,0,0,0,pose.asym,pose.press);
  assert.ok(g.width>30&&g.bottom>0,'small gestures retain valid proportions');
  for(const key of ['upper','lower','cavity','teeth','highlight'])assert.ok(!/NaN|Infinity/.test(g[key]));
 }
 assert.equal(lifeGesture(kind,3300,side),null,'gestures end rather than looping continuously');
}
assert.ok(lifeGesture('smile',650).asym>lifeGesture('smile',1600).asym,'one corner leads before the other catches up');
assert.ok(lifeGesture('listen',650).smile<lifeGesture('smile',650).smile,'listening stays gentler than a full smile');
assert.ok(lifeGesture('press',300).press>.7,'thoughtful gesture presses the lips');
assert.ok(lifeGesture('exhale',700).open>.07&&lifeGesture('exhale',700).open<.12,'exhale remains a small opening');
assert.ok(lifeGesture('linger',800).smile>lifeGesture('linger',2500).smile,'lingering smiles fade gradually');
assert.ok(lifeGesture('laugh',650).press>.6,'suppressed laughter first presses the lips');
assert.ok(lifeGesture('laugh',1300).open>.04&&lifeGesture('laugh',1300).jaw>.03,'laughter then parts the lips with a small jaw movement');
assert.equal(lifeGesture('hmm',800).open,0,'thoughtful hmm keeps the lips closed');
assert.ok(lifeGesture('hmm',800).shift>.5&&lifeGesture('hmm',800,-1).shift<-.5,'thoughtful hmm can shift to either side');
assert.equal(target('auto',{lifePose:lifeGesture('hmm',800),textPose:VISEMES.O}).shift,0,'speech clears the sideways mouth gesture');
const subtle=lifeGesture('smile',650);
assert.ok(target('auto',{lifePose:subtle}).asym>0,'Auto uses subtle gestures');
assert.equal(target('wide',{lifePose:subtle}).asym,0,'manual expressions retain control');
assert.equal(target('auto',{lifePose:subtle,reduced:true}).asym,0,'reduced motion suppresses automatic gestures');
assert.equal(target('auto',{lifePose:subtle,textPose:VISEMES.O}).asym,0,'pronunciation overrides idle gestures');
assert.equal(target('auto',{lifePose:subtle,pulling:true}).asym,0,'direct interaction overrides idle gestures');
for(const from of Object.values(VISEMES)) for(const id of Object.keys(VISEMES).filter(id=>id!=='rest')) {
 for(let elapsed=0;elapsed<160;elapsed+=4) {
  const pose=visemeAt([id],elapsed,160,'word',from);
  const g=geometry(pose.open,pose.smile,pose.round,0,0,0,pose.bite);
  assert.ok(g.width>30&&g.bottom>1,'rapid wide/rounded/biting transitions retain valid mouth proportions');
  assert.ok(!/NaN|Infinity/.test(g.cavity+g.upper+g.lower+g.teeth));
 }
}
assert.equal(target('auto',{textPose:VISEMES.A,speaking:true,audioLevel:0}).open,0,'recorded audio still has priority');
const hum=target('auto',{humming:true,time:900});
assert.equal(hum.open,0,'humming keeps the lips closed');
assert.ok(hum.seal>0&&Math.abs(hum.headTilt)<1&&hum.headNod<.5,'humming has a small sealed smile and bounded head motion');
assert.equal(target('auto',{humming:true,speaking:true,audioLevel:0}).seal,0,'speech takes priority over humming');
assert.equal(target('auto',{humming:true,reduced:true}).headTilt,0,'humming respects reduced motion');
