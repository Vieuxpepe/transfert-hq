import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {grabWeights,releaseFeel,bustPullSettle}=require('../assets/hq-companion.js').pure;
assert.deepEqual(grabWeights(.5),{left:1,right:1});
const left=grabWeights(.2),right=grabWeights(.8);
assert.ok(left.left>left.right); assert.equal(left.left,right.right);
for(const x of [-20,0,.2,.5,.8,1,20]) {
 const g=grabWeights(x); assert.ok(Math.abs(g.left+g.right-2)<1e-12);
 assert.ok(g.left>=.6 && g.left<=1.4 && g.right>=.6 && g.right<=1.4);
}
const gentle=releaseFeel(0).bounce,fast=releaseFeel(140).bounce;
assert.ok(gentle<fast && fast<=1);
assert.equal(bustPullSettle(20,0,0,gentle),20,'gentle release has no position jump');
const energy=b=>Array.from({length:70},(_,i)=>bustPullSettle(20,0,.8+i*.02,b)**2).reduce((a,b)=>a+b,0);
assert.ok(energy(gentle)<energy(fast)*.2,'slow release has much less secondary bounce');
assert.ok(Math.abs(bustPullSettle(20,0,2.3,fast))<.001);
console.log('check_hq_companion_touch: side selection, symmetry, limits and release energy ok');
