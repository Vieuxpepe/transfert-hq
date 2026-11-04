import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {cursorSupportContact:contact,cursorSupportSpring:spring}=require('../assets/hq-companion.js').pure;
let c=contact(null,.29,.90,-.01,25);
assert.equal(c.side,'left');
for(let i=0;i<6;i++) c=contact(c,.29,.90-i*.01,-.01,25);
assert.equal(c.lift,.055,'lift stays bounded');
assert.equal(contact(c,.29,.79,0,3000).lift,c.lift,'stationary hold survives a long pause');
assert.equal(contact(c,.29,.80,.01,25).lift,.045,'lowering the cursor unloads the support');
assert.equal(contact(null,.7,.9,-.01,25).side,'right');
assert.equal(contact(c,.49,.8,-.01,25),null,'cleavage gap releases contact');
assert.equal(contact(c,.3,.5,-.01,25),null,'leaving lower chest releases contact');
assert.equal(contact(c,.3,.8,-.09,16),null,'fast movements do not act like support');
assert.equal(contact(null,.3,.8,.01,25),null,'downward hovering does not pick up');
let s={p:0,v:0}; for(let i=0;i<120;i++) s=spring(s,1,1/60);
assert.ok(s.p>.99 && s.p<=1.03,'stable bounded hold');
for(let i=0;i<120;i++) s=spring(s,0,1/60);
assert.ok(s.p<.001 && Math.abs(s.v)<.001,'moving away settles without residual lift');
console.log('check_hq_companion_support: pickup, hold, lowering, release and spring bounds ok');

assert.ok(contact(null,.3,.70,-.005,16),'pickup works on visible chest above the bottom rim');

const {readFileSync}=await import('node:fs');
const css=readFileSync(new URL('../assets/hq-companion.css',import.meta.url),'utf8');
for(const side of ['left','right']) {
 const selector='.hq-companion-rig-bust-stack-'+side+' .hq-companion-rig-bust-'+side+'{';
 const rule=css.split('\n').join('\n').match(new RegExp('^'+selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^}]+)}','m'));
 assert.ok(rule,'local transform rule exists');
 assert.ok(rule[1].includes('transform:scale3d('));
 assert.ok(rule[1].includes('--cursor-support-'+side),'support state drives actual visible transform');
}

assert.equal(contact(c,.29,.75,-.04,50).lift,.055,'extra upward travel saturates without losing contact');
assert.equal(contact(c,.45,.8,-.005,25),null,'moving too far sideways releases');
const {supportMapPixel}=require('../assets/hq-companion.js').pure;
let minDet=Infinity;
for(let y=1;y<63;y++) for(let x=1;x<63;x++) {
 const u=x/63,v=y/63;
 const p=supportMapPixel(u,v), mirror=supportMapPixel(1-u,v);
 assert.ok(Math.abs(p[0]+mirror[0]-255)<=1,'left and right displacement balances');
 const l=supportMapPixel((x-1)/63,v),r=supportMapPixel((x+1)/63,v);
 const t=supportMapPixel(u,(y-1)/63),b=supportMapPixel(u,(y+1)/63);
 const ru=(r[0]-l[0])*63/510,rv=(b[0]-t[0])*63/510;
 const gu=(r[1]-l[1])*63/510,gv=(b[1]-t[1])*63/510;
 minDet=Math.min(minDet,(1+.20/.56*ru)*(1+.20/.38*gv)-(.20/.38*rv)*(.20/.56*gu));
}
assert.ok(minDet>.15,'contact displacement cannot fold the texture at full strength');
assert.ok(supportMapPixel(.25,.55)[0]>128 && supportMapPixel(.75,.55)[0]<128,'opposite sides move outward');
console.log('support map symmetry and non-folding bounds ok; min determinant',minDet.toFixed(3));

assert.ok(supportMapPixel(.5,.52)[1]>128,'the cursor contact lifts');
assert.ok(supportMapPixel(.22,.52)[1]<128 && supportMapPixel(.78,.52)[1]<128,'both sides hang below the contact instead of lifting as one flat crop');
