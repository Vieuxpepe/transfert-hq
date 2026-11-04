import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {lateralImpact}=require('../assets/hq-companion.js').pure;
for(const width of [72,112,168]) {
 const a=lateralImpact(width*.08,16,width,.25);
 const b=lateralImpact(-width*.08,16,width,.75);
 assert.ok(a && b); assert.equal(a.direction,1); assert.equal(b.direction,-1);
 assert.equal(a.strength,b.strength); assert.equal(a.side,'left'); assert.equal(b.side,'right');
 assert.equal(lateralImpact(width*.08,100,width,.25),null,'slow pass is a caress');
 assert.equal(lateralImpact(200,1000,width,.25),null,'stale pointer sample cannot slap');
 assert.equal(lateralImpact(200,0,width),null);
 const fast=lateralImpact(width*.16,16,width,.25);
 assert.ok(fast.strength>a.strength && fast.strength<=1,'speed controls bounded impulse');
}
console.log('check_hq_companion_slap: direction, speed, target side and stale samples ok');
import {createRequire as createPollingRequire} from 'node:module';
const {sampleLateralSwipe}=createPollingRequire(import.meta.url)('../assets/hq-companion.js').pure;
for(const interval of [1,4,8,16]) {
 const trail=[]; let hit;
 for(let t=0;t<=48;t+=interval) hit=sampleLateralSwipe(trail,t*.8,80,t,168,.25)||hit;
 assert.ok(hit,'fast swipes register at '+interval+'ms polling');
 assert.equal(hit.direction,1); assert.ok(trail.length<=64);
}
let trail=[]; let hit;
for(let t=0;t<=100;t+=4) hit=sampleLateralSwipe(trail,t*.04,80,t,168,.25)||hit;
assert.equal(hit,undefined,'slow support motion does not slap');
trail=[];
for(let t=0;t<=48;t+=4) assert.equal(sampleLateralSwipe(trail,t*.05,80-t,t,168,.25),null,'vertical lift is not a slap');
assert.equal(sampleLateralSwipe(trail,300,80,1000,168,.25),null,'idle gap resets swipe history');
console.log('check_hq_companion_slap: high polling, slow movement, vertical support and idle gaps ok');
