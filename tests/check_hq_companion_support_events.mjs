import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {cursorSupportContact,lateralImpact,sampleLateralSwipe}=require('../assets/hq-companion.js').pure;
const source=readFileSync(new URL('../assets/hq-companion.js',import.meta.url),'utf8');
const start=source.indexOf('    win.addEventListener("pointermove", (ev) => {',source.indexOf('let supportSample = null'));
const end=source.indexOf('}, { capture: true, passive: false });',start)+'}, { capture: true, passive: false });'.length;
let handler,options,now=100,starts=0,blocked=0;
const classes=new Set();
const state={nsfwOn:true,el:{hidden:false,classList:{contains:k=>k==='has-layered-portrait',add(){}}}};
const crop={parentElement:{getBoundingClientRect:()=>({left:90,top:90,width:120,height:120})},getBoundingClientRect:()=>({left:100,top:100,width:100,height:100})};
const scope={cachedRect:(w,el)=>el.getBoundingClientRect?el.getBoundingClientRect():{width:100},setSupportCursor(){},swipeTrail:[],sampleLateralSwipe,supportSample:null,petTimer:0,tickleResetT:0,S:state,cursorSupportContact,lateralImpact,
 calm:()=>false,stopHeartbeatHold(){},syncCleavagePreTension(){},startLive2DLoop:()=>starts++,
 win:{performance:{now:()=>now},clearInterval(){},clearTimeout(){},addEventListener:(name,fn,opt)=>{handler=fn;options=opt;}},
 av:{querySelector:()=>crop,classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k),remove:(...ks)=>ks.forEach(k=>classes.delete(k))}}};
vm.runInNewContext(source.slice(start,end),scope);
const event=y=>({clientX:130,clientY:y,pointerType:'mouse',buttons:0,target:{closest:()=>null},stopImmediatePropagation:()=>blocked++});
handler(event(204)); now=116; handler(event(203));
assert.equal(options.capture,true,'route contact before avatar and window hover handlers');
assert.ok(state.cursorSupport,'visible crop overflow receives support even below avatar button');
assert.ok(classes.has('is-cursor-supporting'));
assert.ok(Math.abs(state.cursorSupport.mapU-1/3)<1e-9,'filter uses wrapper rather than scaled image coordinates');
assert.ok(Math.abs(state.cursorSupport.mapV-113/120)<1e-9,'contact aligns vertically in wrapper space'); assert.equal(state.chestContactOwned,true);
const lift=state.cursorSupport.lift; now=132;handler(event(202));
assert.ok(state.cursorSupport.lift>lift); assert.ok(blocked>=3); assert.ok(starts>=3);
now=148;handler({...event(202),clientX:500});
assert.equal(state.cursorSupport,null,'leaving the displayed crop releases support');
assert.equal(state.chestContactOwned,false);
console.log('check_hq_companion_support_events: capture routing, rendered overflow pickup, lift and release ok');

now=400; handler(event(203)); now=416;handler(event(202));
for(let i=0;i<12;i++){now+=16;handler(event(201-i));}
assert.ok(state.cursorSupport,'reaching maximum lift keeps contact');
assert.equal(state.cursorSupport.lift,.055);
now+=16;handler(event(188));assert.ok(state.cursorSupport,'continued lift remains held at its cap');
const frame=state.cursorSupport.frame;
crop.getBoundingClientRect=()=>({left:900,top:900,width:10,height:10});
now+=16;handler(event(187));assert.ok(state.cursorSupport,'deformation or animation cannot move the hitbox away');
assert.equal(state.cursorSupport.frame,frame,'held contact uses its stable frame');
let leaveHandler;
scope.av.addEventListener=(name,fn)=>{leaveHandler=fn;};
const leaveStart=source.indexOf('    av.addEventListener("pointerleave", () => {',end);
const leaveEnd=source.indexOf('\n    });',leaveStart)+8;
vm.runInNewContext(source.slice(leaveStart,leaveEnd),scope);
const heldBeforeLeave=state.cursorSupport;
leaveHandler();
assert.equal(state.cursorSupport,heldBeforeLeave,'button pointerleave cannot cancel crop overflow support');
assert.equal(state.chestContactOwned,true);
now+=16;handler({...event(187),clientX:800});assert.equal(state.cursorSupport,null,'leaving stable contact bounds releases');
