/* Bundled @chestnutlabs/gcode-preview-element@0.24.0 + three@0.178.0 (MIT). See docs/third-party-licenses-gcode.md. Offline self-hosted bundle. */
var Dp=Object.defineProperty;var He=(i,e,t)=>()=>{if(t)throw t[0];try{return i&&(e=i(i=0)),e}catch(n){throw t=[n],n}};var Np=(i,e)=>{for(var t in e)Dp(i,t,{get:e[t],enumerable:!0})};var ut,wn,Vl=He(()=>{ut={None:0,Extrude:1,Travel:2,Retract:4,Unretract:8,Wipe:16,ArcSegment:32,Seam:64,Cut:128},wn={Unknown:0,Perimeter:1,ExternalPerimeter:2,Infill:3,SolidInfill:4,Support:5,Skirt:6,Brim:7,Bridge:8,Travel:9,Custom:10,PrimeTower:11,WipeTower:12,Raft:13,Purge:14}});var ru=He(()=>{});var jv,ou=He(()=>{Vl();jv=new Set([wn.Skirt,wn.Brim,wn.Support,wn.Raft,wn.PrimeTower,wn.WipeTower,wn.Purge])});function Gl(i,e){let t=i.byteOffsets,n=0,s=t.length-1,r=-1;for(;n<=s;){let o=n+s>>1;t[o]<=e?(r=o,n=o+1):s=o-1}return r===-1?-1:i.segmentIndices[r]}var Hl=He(()=>{});var au=He(()=>{});var lu=He(()=>{});function pi(i){return typeof i=="number"&&Number.isFinite(i)&&i>=0?i:void 0}function Hp(i,e){let t={percentBasis:"unknown"};if(i==null||typeof i!="object")return t;for(let n of["byte","line","layer","totalLayers","percent"]){let s=i[n];if(s==null)continue;let r=pi(s);r===void 0?cn(e,{code:"invalid-field",message:`position.${n} ignored`}):t[n]=r}return t.percent!==void 0&&t.percent>1&&(cn(e,{code:"invalid-field",message:"position.percent > 1 ignored"}),t.percent=void 0),i.percentBasis==="bytes"&&(t.percentBasis="bytes"),t}function cn(i,e){i.length<Op&&i.push(e)}function $i(i,e){return Math.max(0,Math.min(i.segments.count-1,e))}function cu(i,e){return i.segments.layer[e]}function hu(i,e){if(e!==void 0){if(pi(e)===void 0)throw new RangeError(`createProgressMapper: ${i} must be a finite number >= 0 (got ${String(e)})`);return e}}function uu(i,e){let t=hu("staleAfterMs",e?.staleAfterMs)??Fp,n=hu("fileSizeBytes",e?.fileSizeBytes),s=null,r=fi;function o(d,g,_,m){let f=Gl(i.sourceIndex,d);if(f===-1)return cn(m,{code:"before-first-segment"}),{segIndex:null,basis:"byte",confidence:g,band:null,layerIndex:null,stale:!1,notes:m};let w=$i(i,f-_),M=$i(i,f+_);return{segIndex:f,basis:"byte",confidence:g,band:[w,M],layerIndex:cu(i,f),stale:!1,notes:m}}function a(d,g){let _=i.layers.length,m=Math.floor(d);m>=_&&(cn(g,{code:"layer-out-of-range",message:`reported ${m}, IR has ${_}`}),m=_-1);let f=i.layers[m];return{segIndex:f.segEnd,basis:"layer",confidence:"inferred",band:[f.segStart,f.segEnd],layerIndex:m,stale:!1,notes:g}}function l(d,g){let _=i.segments.count,m=$i(i,Math.round(d*(_-1))),f=Math.ceil(_*kp),w=i.segments.layer[m],M=i.layers[w],v=Math.min($i(i,m-f),M?.segStart??m),A=Math.max($i(i,m+f),M?.segEnd??m);return{segIndex:m,basis:"percent",confidence:"approximated",band:[v,A],layerIndex:w,stale:!1,notes:g}}function c(d,g){if(d==null||typeof d!="object")return"ok";let _=i.header.source.sha256;if(typeof d.sha256=="string"&&_!==void 0&&d.sha256!==_)return cn(g,{code:"file-mismatch",message:"sha256 disagrees with the parsed source"}),"unavailable";let m=pi(d.sizeBytes),f=n??pi(i.header.source.byteLength);return m!==void 0&&f!==void 0&&f>0&&Math.abs(m-f)/f>zp?(cn(g,{code:"file-mismatch",message:`sizeBytes ${m} vs parsed ${f}`}),"demote"):"ok"}function h(d,g){if(d.layerIndex===null||d.band===null||i.layers.length===0)return d;let _=Math.min(Math.max(Math.floor(g),0),i.layers.length-1);if(Math.abs(d.layerIndex-_)<=1)return d;let m=i.layers[_],f=[...d.notes];return cn(f,{code:"cross-check-disagrees",message:`mapped layer ${d.layerIndex}, reported ${_}`}),{...d,band:[Math.min(d.band[0],m.segStart),Math.max(d.band[1],m.segEnd)],notes:f}}function u(d){if(i.segments.count===0)return{...fi,notes:[{code:"empty-ir"}]};if(d===null||typeof d!="object"||d.v!==Up)return{...fi,notes:[{code:"version-unsupported"}]};let g=[],_=Hp(d.position,g),m=c(d.file,g);if(m==="unavailable")return{...fi,notes:g};if(d.state==="complete"){let M=i.segments.count-1;return{segIndex:M,basis:_.byte!==void 0?"byte":"none",confidence:"known",band:[M,M],layerIndex:cu(i,M),stale:!1,notes:g}}if(_.byte!==void 0){if(m==="demote"){let v=pi(d.file?.sizeBytes);if(v!==void 0&&v>0){let I={...l(Math.min(1,_.byte/v),g),basis:"byte"};return _.layer!==void 0?h(I,_.layer):I}return{...fi,notes:g}}let M=o(_.byte,"known",0,g);return _.layer!==void 0?h(M,_.layer):M}_.line!==void 0&&cn(g,{code:"line-unmapped",message:"no line index in v1; falling through"});let f=m==="demote"?void 0:n??pi(d.file?.sizeBytes)??pi(i.header.source.byteLength);function w(M){if(_.percentBasis==="bytes"&&f!==void 0&&f>0){let v=Gl(i.sourceIndex,Math.round(M*f));return v===-1?0:v}return $i(i,Math.round(M*(i.segments.count-1)))}if(_.layer!==void 0&&i.layers.length>0){if(_.totalLayers!==void 0&&_.totalLayers>0&&Math.abs(_.totalLayers-i.layers.length)>Vp){cn(g,{code:"layer-count-mismatch",message:`reported total ${_.totalLayers}, IR has ${i.layers.length}`});let v=Math.min(1,_.layer/_.totalLayers);return{...l(v,g),basis:"layer"}}let M=a(_.layer,g);return _.percent!==void 0?h(M,i.segments.layer[w(_.percent)]):M}if(_.percent!==void 0){if(_.percentBasis==="bytes"&&f!==void 0&&f>0){let M=Math.ceil(i.segments.count*Bp),v={...o(Math.round(_.percent*f),"approximated",M,g),basis:"percent"};return _.layer!==void 0?h(v,_.layer):v}return l(_.percent,g)}return g.length===0&&cn(g,{code:"no-position-facts"}),{...fi,notes:g}}function p(d,g,_){let m=[...d.notes];return cn(m,_===void 0?{code:g}:{code:g,message:_}),{...d,notes:m}}return{observe(d){let g=r,_=u(d),m=d?.state;return(m==="cancelled"||m==="unknown")&&_.basis==="none"&&g.segIndex!==null?_=p({...g,stale:!1},m==="cancelled"?"job-cancelled":"state-unknown"):m==="cancelled"&&(_=p(_,"job-cancelled")),g.layerIndex!==null&&_.layerIndex!==null&&g.layerIndex-_.layerIndex>Gp&&(_=p(_,"position-regressed",`layer ${g.layerIndex} -> ${_.layerIndex}`)),s=typeof d?.timestampMs=="number"&&Number.isFinite(d.timestampMs)?d.timestampMs:null,r=_,_},tick(d){if(s===null)return r;let g=d-s>t;return g!==r.stale&&(r={...r,stale:g}),r},reset(){s=null,r=fi}}}var Up,Fp,Op,Bp,kp,zp,Vp,Gp,fi,du=He(()=>{Hl();Up=1,Fp=1e4,Op=8,Bp=.005,kp=.02,zp=.001,Vp=2,Gp=2,fi=Object.freeze({segIndex:null,basis:"none",confidence:"unavailable",band:null,layerIndex:null,stale:!1,notes:[]})});function fu(i){let e=i.segments,t=e.count,n=new Float64Array(t),s=0,r=!1;for(let o=0;o<t;o++){let a=e.x1[o]-e.x0[o],l=e.y1[o]-e.y0[o],c=e.z1[o]-e.z0[o],h=Math.hypot(a,l,c),u=e.feedrate[o],p=Number.isFinite(u)&&u>0?h/(u/6e4):NaN;Number.isFinite(p)?s+=p:h!==0&&(r=!0),n[o]=s}return{cumulativeMs:n,totalMs:s,hasUnknownFeedrate:r}}function pu(i,e){let t=0,n=i.length;for(;t<n;){let s=t+n>>>1;i[s]<=e?t=s+1:n=s}return t}var mu=He(()=>{});var gu=He(()=>{});var mi=He(()=>{Vl();au();ru();ou();Hl();lu();du();mu();gu()});function vu(i){for(let e of["width","height"]){let t=i[e];if(t!==void 0&&(typeof t!="number"||!Number.isFinite(t)||Math.round(t)>yu))throw new RangeError(`capture ${e} must be a finite number \u2264 ${yu} (got ${String(t)})`)}}function Mu(i,e){if(!(i*e<=xu))throw new RangeError(`capture size ${i}\xD7${e} exceeds ${xu} pixels`)}function bu(i,e,t){let n=Math.max(1,Math.round(i.width??e)),s=Math.max(1,Math.round(i.height??t));return{w:n,h:s}}function Su(i,e,t){let n=e*4,s=new Uint8Array(i.length);for(let r=0;r<t;r++){let o=r*n,a=(t-1-r)*n;s.set(i.subarray(o,o+n),a)}return s}async function wu(i,e,t,n,s){let r=qp(e,t),o=r.getContext("2d");if(o===null)throw new Error("capture: 2D canvas context unavailable");let a=new Uint8ClampedArray(i.buffer,i.byteOffset,i.byteLength);return o.putImageData(new ImageData(a,e,t),0,0),"convertToBlob"in r?r.convertToBlob({type:n,quality:s}):new Promise((l,c)=>{r.toBlob(h=>h?l(h):c(new Error("capture: toBlob returned null")),n,s)})}function qp(i,e){if(typeof OffscreenCanvas<"u")return new OffscreenCanvas(i,e);let t=document.createElement("canvas");return t.width=i,t.height=e,t}var hn,yu,xu,Wl=He(()=>{hn=class extends Error{code="E_CAPTURE_UNSUPPORTED";constructor(e){super(e),this.name="CaptureUnsupportedError"}},yu=16384,xu=1<<26});function Yp(i){let e=i.map(t=>`'${t}'`);return`${e.slice(0,-1).join(", ")} or ${e[e.length-1]}`}function gi(i,e,t){if(!t.includes(e))throw new RangeError(`${i} must be ${Yp(t)} (got ${String(e)})`)}function Tn(i){gi("cameraMode",i,Hn)}function oo(i){gi("view",i,Wn)}function Xn(i){gi("progressivePreview",i,Xs)}function gn(i){gi("qualityMode",i,qs)}function js(i){gi("frameContent",i,Ys)}function Ks(i){gi("interactionQuality",i,$s)}function ao(i){gi("renderer.mode",i,Zs)}function kt(i){if(!(i>=10&&i<=120))throw new RangeError(`fov must be in [10, 120] degrees (got ${String(i)})`)}function An(i){if(i!=="device"&&!(typeof i=="number"&&i>0&&i<=4))throw new RangeError(`pixelRatio must be 'device' or a number in (0, 4] (got ${String(i)})`)}function Zi(i){let e=i;if(typeof e!="object"||e===null)throw new RangeError("camera state must be an object");if(Tn(e.cameraMode),!Eu(e.position))throw new RangeError("camera state position must be {x, y, z} finite numbers");if(!Eu(e.target))throw new RangeError("camera state target must be {x, y, z} finite numbers");if(!Number.isFinite(e.zoom)||e.zoom<=0)throw new RangeError(`camera state zoom must be a finite number > 0 (got ${String(e.zoom)})`)}function Ws(i,e){if(e!==void 0&&!(e>=0&&e<=1))throw new RangeError(`theme ${i} must be a number in [0,1] (got ${String(e)})`)}function Xl(i,e){if(e!==void 0&&!(Number.isFinite(e)&&e>=0))throw new RangeError(`theme ${i} must be a finite number >= 0 (got ${String(e)})`)}function Tu(i,e,t){if(!t.includes(e))throw new RangeError(`theme ${i} must be one of ${t.map(n=>`'${n}'`).join(", ")} (got ${String(e)})`)}function _i(i){let e=i??{};if(Ws("gridOpacity",e.gridOpacity),Ws("gridMajor.opacity",e.gridMajor?.opacity),Ws("bedOutline.opacity",e.bedOutline?.opacity),Ws("contactShadow.opacity",e.contactShadow?.opacity),e.gridMajor!==void 0&&!(Number.isFinite(e.gridMajor.every)&&e.gridMajor.every>0))throw new RangeError(`theme gridMajor.every must be a positive number (got ${String(e.gridMajor.every)})`);Xl("hemisphereIntensity",e.hemisphereIntensity),Xl("directionalIntensity",e.directionalIntensity),e.materialPreset!==void 0&&Tu("materialPreset",e.materialPreset,["matte","glossy"]);let t=e.bedSurface;t!==void 0&&(Tu("bedSurface.mode",t.mode,["none","solid"]),Ws("bedSurface.opacity",t.opacity),Xl("bedSurface.thickness",t.thickness))}function yi(i){let e=i.grid??10;if(!(Number.isFinite(e)&&e>0))throw new RangeError(`buildVolume.grid must be a positive finite number (got ${String(e)})`);let t=[["x",i.x],["y",i.y],["z",i.z],["min.x",i.min?.x??0],["min.y",i.min?.y??0]];for(let[s,r]of t)if(!Number.isFinite(r))throw new RangeError(`buildVolume.${s} must be a finite number (got ${String(r)})`);for(let[s,r]of[["x",i.x],["y",i.y]]){let o=Math.floor(r/e)+1;if(o>En)throw new RangeError(`buildVolume.${s} of ${r} mm at a ${e} mm grid needs ${o} grid lines (> ${En} per axis)`)}for(let[s,r,o]of[["x",i.min?.x??0,(i.min?.x??0)+i.x],["y",i.min?.y??0,(i.min?.y??0)+i.y]])if(r+e===r||o+e===o)throw new RangeError(`buildVolume ${s} range ${r}..${o} is too large for a ${e} mm grid (the grid pitch is below the coordinate precision)`);let n=i.shape;if(n?.kind==="circular"){for(let s of[n.center.x,n.center.y,n.diameter])if(!Number.isFinite(s))throw new RangeError(`buildVolume.shape (circular) must be finite (got ${String(s)})`)}else if(n?.kind==="polygon"){for(let s of n.points)if(!(Number.isFinite(s.x)&&Number.isFinite(s.y)))throw new RangeError(`buildVolume.shape (polygon) points must be finite (got ${String(s.x)}, ${String(s.y)})`)}for(let s of i.excludedRegions??[])for(let r of s.points)if(!(Number.isFinite(r.x)&&Number.isFinite(r.y)))throw new RangeError(`buildVolume.excludedRegions points must be finite (got ${String(r.x)}, ${String(r.y)})`)}var Hn,Wn,Xs,qs,Ys,$s,Zs,Eu,En,_n=He(()=>{Hn=["perspective","orthographic"],Wn=["top","bottom","front","back","left","right","iso"],Xs=["auto","lines","hold","off"],qs=["full","adaptive","fast"],Ys=["object","all"],$s=["off","auto"],Zs=["2d","3d"];Eu=i=>{let e=i;return typeof e=="object"&&e!==null&&Number.isFinite(e.x)&&Number.isFinite(e.y)&&Number.isFinite(e.z)};En=1e4});function Js(i){let e=i??{};return _i(e),{...ql,...e.background!==void 0?{background:e.background}:{},...e.gridColor!==void 0?{gridColor:e.gridColor}:{},...e.gridOpacity!==void 0?{gridOpacity:e.gridOpacity}:{},...e.bedColor!==void 0?{bedColor:e.bedColor}:{},...e.hemisphereIntensity!==void 0?{hemisphereIntensity:e.hemisphereIntensity}:{},...e.directionalIntensity!==void 0?{directionalIntensity:e.directionalIntensity}:{},...e.materialPreset!==void 0?{materialPreset:e.materialPreset}:{},...e.bedSurface!==void 0?{bedSurface:e.bedSurface}:{},...e.gridMajor!==void 0?{gridMajor:e.gridMajor}:{},...e.bedOutline!==void 0?{bedOutline:e.bedOutline}:{},...e.contactShadow!==void 0?{contactShadow:e.contactShadow}:{}}}function co(i){let e={mode:"solid",color:"#7c8086",thickness:4,edgeColor:"#585c61"};return i==="dark"?{background:{top:"#23272e",bottom:"#2b3038"},bedSurface:e,gridColor:"#ffffff",gridOpacity:.11,gridMajor:{every:50,opacity:.39},bedOutline:{color:"#ffffff",opacity:.83},contactShadow:{opacity:.4}}:{background:{top:"#dfe3e8",bottom:"#c9ced5"},bedSurface:e,gridColor:"#1b2430",gridOpacity:.16,gridMajor:{every:50,opacity:.55},bedOutline:{color:"#1b2430",opacity:.87},contactShadow:{opacity:.3}}}var ql,lo,ho=He(()=>{_n();ql={background:null,gridColor:4491332,gridOpacity:.35,bedColor:8947848,bedOpacity:.5,hemisphereSky:16777215,hemisphereGround:3489869,hemisphereIntensity:1.6,directionalColor:16777215,directionalIntensity:1.1,materialPreset:"matte",bedSurface:{mode:"none"}};lo=32});var ji=He(()=>{Wl();ho();_n()});function $l(i){let e=1/0,t=-1/0;for(let n=0;n<i.length;n++){let s=i[n];!(s>=0)||s===1/0||(s<e&&(e=s),s>t&&(t=s))}return e<=t?[e,t]:[0,0]}function Ki(i){return $l(i.segments.feedrate)}function Cu(i){let e=i.segments.modal?.toolPower;return e===void 0?[0,0]:$l(e)}function Zl(i){let e=i.layers,t=new Float32Array(e.length);for(let n=0;n<e.length;n++)t[n]=n===0?Math.max(0,e[0].z):Math.max(0,e[n].z-e[n-1].z);return t}function jl(i){return $l(Zl(i))}function Ru(i,e){if(i.length===0)return uo;let n=(e>0?e<1?e:1:0)*(i.length-1),s=Math.floor(n),r=Math.min(s+1,i.length-1),o=n-s,a=i[s],l=i[r];return[a[0]+(l[0]-a[0])*o,a[1]+(l[1]-a[1])*o,a[2]+(l[2]-a[2])*o]}function $p(i,e){let t=0,n=i.length;for(;t<n;){let s=t+n>>>1;i[s].segIndex<=e?t=s+1:n=s}return t}function Yl(i,e,t,n,s){return e>=0?Ru(i,n>0?(e-t)/n:0):s}function Qt(i){if(jp(i),i.mode==="feedrate"||i.mode==="layerHeight"||i.mode==="power"){if(i.range==null)return;let e=i.range;if(!Array.isArray(e)||e.length!==2){let s=Array.isArray(e)?`[${e.map(String).join(", ")}]`:String(e);throw new RangeError(`${i.mode} color range must be two finite numbers >= 0, got ${s}`)}let[t,n]=i.range;if(!Number.isFinite(t)||!Number.isFinite(n)||t<0||n<0)throw new RangeError(`${i.mode} color range must be two finite numbers >= 0, got [${String(t)}, ${String(n)}]`);if(t>n)throw new RangeError(`${i.mode} color range is inverted: lo ${String(t)} > hi ${String(n)}. Pass [lo, hi] in ascending order; for a reversed scale, reverse the ramp instead`)}else if(i.mode==="object"){let e=i.only;if(e!==void 0&&!(Number.isSafeInteger(e)&&e>=1))throw new RangeError(`object color mode 'only' must be a 1-based integer object index, got ${String(e)}`)}}function Zp(i){if(typeof i=="object"&&i!==null&&typeof i.length=="number"){let e=i;return`[${Array.prototype.slice.call(e,0,4).map(String).join(", ")}${e.length>4?", \u2026":""}]`}return String(i)}function Qs(i,e,t){let n=t;if(!(typeof n=="object"&&n!==null&&typeof n.length=="number"&&Number.isFinite(n[0])&&Number.isFinite(n[1])&&Number.isFinite(n[2])))throw new RangeError(`${i} color mode ${e} must be [r, g, b] of three finite numbers, got ${Zp(t)}`)}function Au(i,e,t){let n=t;if(typeof n!="object"||n===null||typeof n.length!="number")throw new RangeError(`${i} color mode ${e} must be an array of [r, g, b] colours, got ${String(t)}`);for(let s=0;s<n.length;s++)Qs(i,`${e}[${String(s)}]`,n[s])}function jp(i){let e=i.mode;switch(i.mode){case"single":Qs(e,"color",i.color);return;case"tool":case"feature":case"colorChange":case"object":Au(e,"palette",i.palette);break;case"feedrate":case"layerHeight":case"power":Au(e,"ramp",i.ramp);break;case"moveKind":Qs(e,"cut",i.cut),Qs(e,"travel",i.travel);break;case"filament":break}(i.mode==="tool"||i.mode==="filament")&&i.fallback==null||Qs(e,"fallback",i.fallback)}function er(i,e){Qt(e);let t=i.segments;if(e.mode==="single"){let n=e.color;return()=>n}if(e.mode==="tool"){let n=e.fallback??uo;return s=>e.palette.length>0?e.palette[t.tool[s]%e.palette.length]:n}if(e.mode==="feature")return n=>{let s=t.feature[n];return s===0||e.palette.length===0?e.fallback:e.palette[(s-1)%e.palette.length]};if(e.mode==="colorChange")return n=>i.colorChanges.length===0||e.palette.length===0?e.fallback:e.palette[$p(i.colorChanges,n)%e.palette.length];if(e.mode==="filament"){let n=e.fallback??uo;return()=>n}if(e.mode==="feedrate"){let[n,s]=e.range??Ki(i),r=s-n;return o=>Yl(e.ramp,t.feedrate[o],n,r,e.fallback)}if(e.mode==="layerHeight"){let n=Zl(i),[s,r]=e.range??jl(i),o=r-s;return a=>Yl(e.ramp,n[t.layer[a]],s,o,e.fallback)}if(e.mode==="power"){let n=t.modal?.toolPower;if(n===void 0){let a=e.fallback;return()=>a}let[s,r]=e.range??Cu(i),o=r-s;return a=>Yl(e.ramp,n[a],s,o,e.fallback)}return e.mode==="moveKind"?n=>{let s=t.kind[n];return(s&(ut.Extrude|ut.Cut))!==0?e.cut:(s&ut.Travel)!==0?e.travel:e.fallback}:n=>{let s=t.object[n];return s===0||e.only!==void 0&&s!==e.only||e.palette.length===0?e.fallback:e.palette[(s-1)%e.palette.length]}}var uo,Iu=He(()=>{mi();uo=[.7,.7,.7]});var xi=He(()=>{Iu()});function ir(i){return i>1e7?5:i>5e6?3:i>2e6?2:1}function am(i){let e=i.segments,t=0,n=0,s=0;for(let r=0;r<e.count;r++){if(!Number.isFinite(e.x0[r]+e.y0[r]+e.z0[r]+e.x1[r]+e.y1[r]+e.z1[r])){t++;continue}(e.kind[r]&ut.Extrude)!==0?n++:(e.kind[r]&ut.Cut)!==0&&s++}return{extrudeCount:n,cutCount:s,skippedNonFinite:t}}function vi(i,e={}){let t=i.segments,n=e.targetSegmentsPerChunk??om,s=A=>Number.isFinite(t.x0[A]+t.y0[A]+t.z0[A]+t.x1[A]+t.y1[A]+t.z1[A]),{extrudeCount:r,cutCount:o,skippedNonFinite:a}=am(i),l;if(typeof e.decimation=="number"){if(!Number.isInteger(e.decimation)||e.decimation<1)throw new RangeError(`decimation must be a whole number >= 1 or 'auto' (got ${String(e.decimation)})`);l=e.decimation}else l=ir(r+o),e.tubeSegmentBudget!==void 0&&e.tubeSegmentBudget>0&&r>e.tubeSegmentBudget&&(l=Math.max(l,Math.ceil(r/e.tubeSegmentBudget)));let c=l>1,h=new Set;for(let A of i.layers){let I=-1,C=-1,P=-1,S=-1;for(let x=Math.max(0,A.segStart);x<=A.segEnd&&x<t.count;x++)(t.kind[x]&ut.Extrude)!==0&&s(x)?(I===-1&&(I=x),C=x):(t.kind[x]&ut.Cut)!==0&&s(x)&&(P===-1&&(P=x),S=x);I!==-1&&(h.add(I),h.add(C)),P!==-1&&(h.add(P),h.add(S))}let u=[],p=0,d=[],g=[],_=[],m=[],f=0,w=0,M=A=>{for(let[I,C]of[["extrude",d],["travel",g],["wipe",_],["cut",m]]){if(C.length===0)continue;let P=new Float32Array(C.length*6),S=new Uint32Array(C.length);for(let x=0;x<C.length;x++){let T=C[x],z=x*6;P[z]=t.x0[T],P[z+1]=t.y0[T],P[z+2]=t.z0[T],P[z+3]=t.x1[T],P[z+4]=t.y1[T],P[z+5]=t.z1[T],S[x]=T}u.push({kind:I,layerStart:f,layerEnd:A,count:C.length,positions:P,segIndices:S}),p+=C.length}d=[],g=[],_=[],m=[],w=0},v=i.layers.length;for(let A=0;A<v;A++){let I=i.layers[A];for(let C=Math.max(0,I.segStart);C<=I.segEnd&&C<t.count;C++){if(!s(C))continue;(t.kind[C]&ut.Extrude)!==0?(h.has(C)||C%l===0)&&(d.push(C),w++):(t.kind[C]&ut.Wipe)!==0?(_.push(C),w++):(t.kind[C]&ut.Cut)!==0?(h.has(C)||C%l===0)&&(m.push(C),w++):c||(g.push(C),w++)}(w>=n||A===v-1)&&(M(A),f=A+1)}return{chunks:u,decimationApplied:l,travelHidden:c,totalSegmentsIncluded:p,skippedNonFinite:a}}var om,ku,ec=He(()=>{mi();om=25e4,ku=4e5});function Mi(i,e,t){let n=new Float32Array(e.count*6),s=er(i,t);for(let r=0;r<e.count;r++){let o=s(e.segIndices[r]),a=r*6;n[a]=o[0],n[a+1]=o[1],n[a+2]=o[2],n[a+3]=o[0],n[a+4]=o[1],n[a+5]=o[2]}return n}var tc=He(()=>{xi();xi()});function lm(i,e,t){let n=i.segments.layer,s=0,r=e.count;for(;s<r;){let o=s+r>>1;n[e.segIndices[o]]<t?s=o+1:r=o}return s}function cm(i,e,t){let n=i.segments.layer,s=0,r=e.count;for(;s<r;){let o=s+r>>1;n[e.segIndices[o]]<=t?s=o+1:r=o}return s}function hm(i,e){let t=0,n=i.count;for(;t<n;){let s=t+n>>1;i.segIndices[s]<=e?t=s+1:n=s}return t}function bi(i,e,t,n,s){if(e.layerEnd<t||e.layerStart>n)return{visible:!1,drawStart:0,drawCount:0};let r=lm(i,e,t),o=cm(i,e,n);if(s!==void 0){let l=hm(e,s);l<o&&(o=l)}let a=Math.max(0,o-r);return{visible:a>0,drawStart:r,drawCount:a}}function mo(i,e,t,n,s,r){let o=bi(i,e,t,n);if(!o.visible){let g={visible:!1,drawStart:0,drawCount:0};return{completed:g,band:g,ghost:g}}let a=bi(i,e,t,n,s),l=r===s?a:bi(i,e,t,n,r),c=a.drawStart+a.drawCount,h=l.drawStart+l.drawCount,u=o.drawStart+o.drawCount,p=Math.max(0,h-c),d=u-h;return{completed:{...a},band:{visible:p>0,drawStart:c,drawCount:p},ghost:{visible:d>0,drawStart:h,drawCount:d}}}var nc=He(()=>{});function yo(i){if(i===void 0)return;let{radialSegments:e,lineWidth:t,lineHeight:n,maxVertices:s}=i;if(e!==void 0&&!sc(e,sr,ic))throw new RangeError(`tube.radialSegments must be a whole number in [${sr}, ${ic}] (got ${String(e)})`);if(t!==void 0&&!go(t))throw new RangeError(`tube.lineWidth must be a finite number > 0 (got ${String(t)})`);if(n!==void 0&&!go(n))throw new RangeError(`tube.lineHeight must be a finite number > 0 (got ${String(n)})`);if(s!==void 0&&!sc(s,1,Number.MAX_SAFE_INTEGER))throw new RangeError(`tube.maxVertices must be a whole number >= 1 (got ${String(s)})`)}function zu(i){if(i.qualityMode!==void 0&&gn(i.qualityMode),i.tubeByteBudget!==void 0&&!go(i.tubeByteBudget))throw new RangeError(`tubeByteBudget must be a finite number > 0 (got ${String(i.tubeByteBudget)})`);if(i.geometryMemoryBudgetBytes!==void 0&&!go(i.geometryMemoryBudgetBytes))throw new RangeError(`geometryMemoryBudgetBytes must be a finite number > 0 (got ${String(i.geometryMemoryBudgetBytes)})`);let e=i.geometryConcurrency;if(e!==void 0&&e!=="auto"&&e!=="off"&&!sc(e,1,Number.MAX_SAFE_INTEGER))throw new RangeError(`geometryConcurrency must be 'auto', 'off' or a whole number >= 1 (got ${String(e)})`)}function rr(i){return(i+1)*40+i*6*4}function xo(i,e,t=Qi){yo({radialSegments:e});for(let n=Math.min(e,ic);n>=sr;n--)if(i*rr(n)<=t)return n;return null}function dm(i){let e=i.positions,t=[];for(let n=0;n<i.count;n++){if(n===0){t.push(0);continue}let s=(n-1)*6+3,r=n*6;(e[s]!==e[r]||e[s+1]!==e[r+1]||e[s+2]!==e[r+2])&&t.push(n)}return t}function es(i,e={}){yo(e);let t=e.lineWidth??.6,n=e.lineHeight??.2,s=e.radialSegments??8,r=e.maxVertices??um,o=s+1,a=s*6,l=dm(i),h=(i.count+l.length)*o;if(h>r)throw new RangeError(`tube geometry needs ${h} vertices (> budget ${r}); use lines mode for this chunk`);let u=new Float32Array(h*3),p=new Float32Array(h*3),d=new Uint32Array(i.count*a),g=new Uint32Array(h),_=i.positions,m=0,f=0,w=(M,v,A,I,C,P,S,x,T,z)=>{let O=M-I,X=v-C,K=A-P,k=Math.hypot(O,X,K);k>0&&(O/=k,X/=k,K/=k);let te=S-M,W=x-v,se=T-A;k=Math.hypot(te,W,se),k>0&&(te/=k,W/=k,se/=k);let re=O+te,pe=X+W,Ce=K+se;k=Math.hypot(re,pe,Ce),k>0?(re/=k,pe/=k,Ce/=k):re=1;let Xe=0,Z=0,R=0,H=Math.abs(re),q=Math.abs(pe),de=Math.abs(Ce),Re=Number.MAX_VALUE;H<=Re&&(Re=H,Xe=1,Z=0,R=0),q<=Re&&(Re=q,Xe=0,Z=1,R=0),de<=Re&&(Xe=0,Z=0,R=1);let fe=pe*R-Ce*Z,xe=Ce*Xe-re*R,je=re*Z-pe*Xe;k=Math.hypot(fe,xe,je),k>0&&(fe/=k,xe/=k,je/=k);let Ge=pe*je-Ce*xe,L=Ce*fe-re*je,_t=re*xe-pe*fe,qe=pe*_t-Ce*L,$e=Ce*Ge-re*_t,me=re*L-pe*Ge;for(let ke=0;ke<=s;ke++){let Se=ke/s*Math.PI*2,Ue=Math.sin(Se),ct=-Math.cos(Se),E=ct*Ge+Ue*qe,y=ct*L+Ue*$e,B=ct*_t+Ue*me;k=Math.hypot(E,y,B),k>0&&(E/=k,y/=k,B/=k);let Y=m+ke;p[Y*3]=E,p[Y*3+1]=y,p[Y*3+2]=B,u[Y*3]=M+t*E*.5,u[Y*3+1]=v+t*y*.5,u[Y*3+2]=A+n*B*.5-n*.5,g[Y]=z}m+=o};for(let M=0;M<l.length;M++){let v=l[M],A=M+1<l.length?l[M+1]:i.count,I=A-v,C=m;for(let S=v;S<A;S++){let x=S*6,T=S>v?(S-1)*6:-1;w(_[x],_[x+1],_[x+2],T>=0?_[T]:_[x],T>=0?_[T+1]:_[x+1],T>=0?_[T+2]:_[x+2],_[x+3],_[x+4],_[x+5],S)}let P=(A-1)*6;w(_[P+3],_[P+4],_[P+5],_[P],_[P+1],_[P+2],_[P+3],_[P+4],_[P+5],A-1);for(let S=0;S<I;S++){let x=C+S*o,T=x+o;for(let z=1;z<=s;z++){let O=x+(z-1),X=T+(z-1),K=T+z,k=x+z;d[f++]=O,d[f++]=X,d[f++]=k,d[f++]=X,d[f++]=K,d[f++]=k}}}return{positions:u,normals:p,indices:d,vertexSegment:g,indicesPerSegment:a,vertexCount:h}}var _o,um,sr,ic,sc,go,Qi,vo=He(()=>{_n();_n();_o=1e6,um=8e6,sr=3,ic=64,sc=(i,e,t)=>Number.isInteger(i)&&i>=e&&i<=t,go=i=>Number.isFinite(i)&&i>0;Qi=45e7});function Bi(){let i=Math.random()*4294967295|0,e=Math.random()*4294967295|0,t=Math.random()*4294967295|0,n=Math.random()*4294967295|0;return(Tt[i&255]+Tt[i>>8&255]+Tt[i>>16&255]+Tt[i>>24&255]+"-"+Tt[e&255]+Tt[e>>8&255]+"-"+Tt[e>>16&15|64]+Tt[e>>24&255]+"-"+Tt[t&63|128]+Tt[t>>8&255]+"-"+Tt[t>>16&255]+Tt[t>>24&255]+Tt[n&255]+Tt[n>>8&255]+Tt[n>>16&255]+Tt[n>>24&255]).toLowerCase()}function ze(i,e,t){return Math.max(e,Math.min(t,i))}function oh(i,e){return(i%e+e)%e}function fm(i,e,t,n,s){return n+(i-e)*(s-n)/(t-e)}function pm(i,e,t){return i!==e?(t-i)/(e-i):0}function fr(i,e,t){return(1-t)*i+t*e}function mm(i,e,t,n){return fr(i,e,1-Math.exp(-t*n))}function gm(i,e=1){return e-Math.abs(oh(i,e*2)-e)}function _m(i,e,t){return i<=e?0:i>=t?1:(i=(i-e)/(t-e),i*i*(3-2*i))}function ym(i,e,t){return i<=e?0:i>=t?1:(i=(i-e)/(t-e),i*i*i*(i*(i*6-15)+10))}function xm(i,e){return i+Math.floor(Math.random()*(e-i+1))}function vm(i,e){return i+Math.random()*(e-i)}function Mm(i){return i*(.5-Math.random())}function bm(i){i!==void 0&&(Vu=i);let e=Vu+=1831565813;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}function Sm(i){return i*dr}function wm(i){return i*_s}function Em(i){return(i&i-1)===0&&i!==0}function Tm(i){return Math.pow(2,Math.ceil(Math.log(i)/Math.LN2))}function Am(i){return Math.pow(2,Math.floor(Math.log(i)/Math.LN2))}function Cm(i,e,t,n,s){let r=Math.cos,o=Math.sin,a=r(t/2),l=o(t/2),c=r((e+n)/2),h=o((e+n)/2),u=r((e-n)/2),p=o((e-n)/2),d=r((n-e)/2),g=o((n-e)/2);switch(s){case"XYX":i.set(a*h,l*u,l*p,a*c);break;case"YZY":i.set(l*p,a*h,l*u,a*c);break;case"ZXZ":i.set(l*u,l*p,a*h,a*c);break;case"XZX":i.set(a*h,l*g,l*d,a*c);break;case"YXY":i.set(l*d,a*h,l*g,a*c);break;case"ZYZ":i.set(l*g,l*d,a*h,a*c);break;default:console.warn("THREE.MathUtils: .setQuaternionFromProperEuler() encountered an unknown order: "+s)}}function fs(i,e){switch(e.constructor){case Float32Array:return i;case Uint32Array:return i/4294967295;case Uint16Array:return i/65535;case Uint8Array:return i/255;case Int32Array:return Math.max(i/2147483647,-1);case Int16Array:return Math.max(i/32767,-1);case Int8Array:return Math.max(i/127,-1);default:throw new Error("Invalid component type.")}}function Nt(i,e){switch(e.constructor){case Float32Array:return i;case Uint32Array:return Math.round(i*4294967295);case Uint16Array:return Math.round(i*65535);case Uint8Array:return Math.round(i*255);case Int32Array:return Math.round(i*2147483647);case Int16Array:return Math.round(i*32767);case Int8Array:return Math.round(i*127);default:throw new Error("Invalid component type.")}}function lh(i){for(let e=i.length-1;e>=0;--e)if(i[e]>=65535)return!0;return!1}function xr(i){return document.createElementNS("http://www.w3.org/1999/xhtml",i)}function lf(){let i=xr("canvas");return i.style.display="block",i}function Pi(i){i in Hu||(Hu[i]=!0,console.warn(i))}function cf(i,e,t){return new Promise(function(n,s){function r(){switch(i.clientWaitSync(e,i.SYNC_FLUSH_COMMANDS_BIT,0)){case i.WAIT_FAILED:s();break;case i.TIMEOUT_EXPIRED:setTimeout(r,t);break;default:n()}}setTimeout(r,t)})}function hf(i){let e=i.elements;e[2]=.5*e[2]+.5*e[3],e[6]=.5*e[6]+.5*e[7],e[10]=.5*e[10]+.5*e[11],e[14]=.5*e[14]+.5*e[15]}function uf(i){let e=i.elements;e[11]===-1?(e[10]=-e[10]-1,e[14]=-e[14]):(e[10]=-e[10],e[14]=-e[14]+1)}function Rm(){let i={enabled:!0,workingColorSpace:Ii,spaces:{},convert:function(s,r,o){return this.enabled===!1||r===o||!r||!o||(this.spaces[r].transfer===Qe&&(s.r=Dn(s.r),s.g=Dn(s.g),s.b=Dn(s.b)),this.spaces[r].primaries!==this.spaces[o].primaries&&(s.applyMatrix3(this.spaces[r].toXYZ),s.applyMatrix3(this.spaces[o].fromXYZ)),this.spaces[o].transfer===Qe&&(s.r=ps(s.r),s.g=ps(s.g),s.b=ps(s.b))),s},workingToColorSpace:function(s,r){return this.convert(s,this.workingColorSpace,r)},colorSpaceToWorking:function(s,r){return this.convert(s,r,this.workingColorSpace)},getPrimaries:function(s){return this.spaces[s].primaries},getTransfer:function(s){return s===zn?_r:this.spaces[s].transfer},getLuminanceCoefficients:function(s,r=this.workingColorSpace){return s.fromArray(this.spaces[r].luminanceCoefficients)},define:function(s){Object.assign(this.spaces,s)},_getMatrix:function(s,r,o){return s.copy(this.spaces[r].toXYZ).multiply(this.spaces[o].fromXYZ)},_getDrawingBufferColorSpace:function(s){return this.spaces[s].outputColorSpaceConfig.drawingBufferColorSpace},_getUnpackColorSpace:function(s=this.workingColorSpace){return this.spaces[s].workingColorSpaceConfig.unpackColorSpace},fromWorkingColorSpace:function(s,r){return Pi("THREE.ColorManagement: .fromWorkingColorSpace() has been renamed to .workingToColorSpace()."),i.workingToColorSpace(s,r)},toWorkingColorSpace:function(s,r){return Pi("THREE.ColorManagement: .toWorkingColorSpace() has been renamed to .colorSpaceToWorking()."),i.colorSpaceToWorking(s,r)}},e=[.64,.33,.3,.6,.15,.06],t=[.2126,.7152,.0722],n=[.3127,.329];return i.define({[Ii]:{primaries:e,whitePoint:n,transfer:_r,toXYZ:Wu,fromXYZ:Xu,luminanceCoefficients:t,workingColorSpaceConfig:{unpackColorSpace:xt},outputColorSpaceConfig:{drawingBufferColorSpace:xt}},[xt]:{primaries:e,whitePoint:n,transfer:Qe,toXYZ:Wu,fromXYZ:Xu,luminanceCoefficients:t,outputColorSpaceConfig:{drawingBufferColorSpace:xt}}}),i}function Dn(i){return i<.04045?i*.0773993808:Math.pow(i*.9478672986+.0521327014,2.4)}function ps(i){return i<.0031308?i*12.92:1.055*Math.pow(i,.41666)-.055}function ac(i){return typeof HTMLImageElement<"u"&&i instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&i instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&i instanceof ImageBitmap?Jo.getDataURL(i):i.data?{data:Array.from(i.data),width:i.width,height:i.height,type:i.data.constructor.name}:(console.warn("THREE.Texture: Unable to serialize Texture."),{})}function cc(i,e,t,n,s){for(let r=0,o=i.length-3;r<=o;r+=3){wi.fromArray(i,r);let a=s.x*Math.abs(wi.x)+s.y*Math.abs(wi.y)+s.z*Math.abs(wi.z),l=e.dot(wi),c=t.dot(wi),h=n.dot(wi);if(Math.max(-Math.max(l,c,h),Math.min(l,c,h))>a)return!1}return!0}function bc(i,e,t){return t<0&&(t+=1),t>1&&(t-=1),t<1/6?i+(e-i)*6*t:t<1/2?e:t<2/3?i+(e-i)*6*(2/3-t):i}function Gm(i,e,t,n,s,r,o,a){let l;if(e.side===Ft?l=n.intersectTriangle(o,r,s,!0,a):l=n.intersectTriangle(s,r,o,e.side===Nn,a),l===null)return null;Uo.copy(a),Uo.applyMatrix4(i.matrixWorld);let c=t.ray.origin.distanceTo(Uo);return c<t.near||c>t.far?null:{distance:c,point:Uo.clone(),object:i}}function Fo(i,e,t,n,s,r,o,a,l,c){i.getVertexPosition(a,Po),i.getVertexPosition(l,Lo),i.getVertexPosition(c,Do);let h=Gm(i,e,t,n,Po,Lo,Do,nd);if(h){let u=new D;Jn.getBarycoord(nd,Po,Lo,Do,u),s&&(h.uv=Jn.getInterpolatedAttribute(s,a,l,c,u,new ce)),r&&(h.uv1=Jn.getInterpolatedAttribute(r,a,l,c,u,new ce)),o&&(h.normal=Jn.getInterpolatedAttribute(o,a,l,c,u,new D),h.normal.dot(n.direction)>0&&h.normal.multiplyScalar(-1));let p={a,b:l,c,normal:new D,materialIndex:0};Jn.getNormal(Po,Lo,Do,p.normal),h.face=p,h.barycoord=u}return h}function ki(i){let e={};for(let t in i){e[t]={};for(let n in i[t]){let s=i[t][n];s&&(s.isColor||s.isMatrix3||s.isMatrix4||s.isVector2||s.isVector3||s.isVector4||s.isTexture||s.isQuaternion)?s.isRenderTargetTexture?(console.warn("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),e[t][n]=null):e[t][n]=s.clone():Array.isArray(s)?e[t][n]=s.slice():e[t][n]=s}}return e}function Pt(i){let e={};for(let t=0;t<i.length;t++){let n=ki(i[t]);for(let s in n)e[s]=n[s]}return e}function Hm(i){let e=[];for(let t=0;t<i.length;t++)e.push(i[t].clone());return e}function ch(i){let e=i.getRenderTarget();return e===null?i.outputColorSpace:e.isXRRenderTarget===!0?e.texture.colorSpace:Ye.workingColorSpace}function ko(i,e,t,n,s,r,o){let a=i.geometry.attributes.position;if(ia.fromBufferAttribute(a,s),sa.fromBufferAttribute(a,r),t.distanceSqToSegment(ia,sa,Tc,od)>n)return;Tc.applyMatrix4(i.matrixWorld);let c=e.ray.origin.distanceTo(Tc);if(!(c<e.near||c>e.far))return{distance:c,point:od.clone().applyMatrix4(i.matrixWorld),index:o,face:null,faceIndex:null,barycoord:null,object:i}}function hd(i,e,t,n,s,r,o){let a=Fc.distanceSqToPoint(i);if(a<t){let l=new D;Fc.closestPointToPoint(i,l),l.applyMatrix4(n);let c=s.ray.origin.distanceTo(l);if(c<s.near||c>s.far)return;r.push({distance:c,distanceToRay:Math.sqrt(a),point:l,index:e,face:null,faceIndex:null,barycoord:null,object:o})}}function hh(){let i=0,e=0,t=0,n=0;function s(r,o,a,l){i=r,e=a,t=-3*r+3*o-2*a-l,n=2*r-2*o+a+l}return{initCatmullRom:function(r,o,a,l,c){s(o,a,c*(a-r),c*(l-o))},initNonuniformCatmullRom:function(r,o,a,l,c,h,u){let p=(o-r)/c-(a-r)/(c+h)+(a-o)/h,d=(a-o)/h-(l-o)/(h+u)+(l-a)/u;p*=h,d*=h,s(o,a,p,d)},calc:function(r){let o=r*r,a=o*r;return i+e*r+t*o+n*a}}}function ud(i,e,t,n,s){let r=(n-e)*.5,o=(s-t)*.5,a=i*i,l=i*a;return(2*t-2*n+r+o)*l+(-3*t+3*n-2*r-o)*a+r*i+t}function jm(i,e){let t=1-i;return t*t*e}function Km(i,e){return 2*(1-i)*i*e}function Jm(i,e){return i*i*e}function pr(i,e,t,n){return jm(i,e)+Km(i,t)+Jm(i,n)}function Qm(i,e){let t=1-i;return t*t*t*e}function eg(i,e){let t=1-i;return 3*t*t*i*e}function tg(i,e){return 3*(1-i)*i*i*e}function ng(i,e){return i*i*i*e}function mr(i,e,t,n,s){return Qm(i,e)+eg(i,t)+tg(i,n)+ng(i,s)}function ig(i,e,t=2){let n=e&&e.length,s=n?e[0]*t:i.length,r=pf(i,0,s,t,!0),o=[];if(!r||r.next===r.prev)return o;let a,l,c;if(n&&(r=lg(i,e,r,t)),i.length>80*t){a=1/0,l=1/0;let h=-1/0,u=-1/0;for(let p=t;p<s;p+=t){let d=i[p],g=i[p+1];d<a&&(a=d),g<l&&(l=g),d>h&&(h=d),g>u&&(u=g)}c=Math.max(h-a,u-l),c=c!==0?32767/c:0}return Nr(r,o,t,a,l,c,0),o}function pf(i,e,t,n,s){let r;if(s===xg(i,e,t,n)>0)for(let o=e;o<t;o+=n)r=fd(o/n|0,i[o],i[o+1],r);else for(let o=t-n;o>=e;o-=n)r=fd(o/n|0,i[o],i[o+1],r);return r&&Cs(r,r.next)&&(Fr(r),r=r.next),r}function Di(i,e){if(!i)return i;e||(e=i);let t=i,n;do if(n=!1,!t.steiner&&(Cs(t,t.next)||dt(t.prev,t,t.next)===0)){if(Fr(t),t=e=t.prev,t===t.next)break;n=!0}else t=t.next;while(n||t!==e);return e}function Nr(i,e,t,n,s,r,o){if(!i)return;!o&&r&&fg(i,n,s,r);let a=i;for(;i.prev!==i.next;){let l=i.prev,c=i.next;if(r?rg(i,n,s,r):sg(i)){e.push(l.i,i.i,c.i),Fr(i),i=c.next,a=c.next;continue}if(i=c,i===a){o?o===1?(i=og(Di(i),e),Nr(i,e,t,n,s,r,2)):o===2&&ag(i,e,t,n,s,r):Nr(Di(i),e,t,n,s,r,1);break}}}function sg(i){let e=i.prev,t=i,n=i.next;if(dt(e,t,n)>=0)return!1;let s=e.x,r=t.x,o=n.x,a=e.y,l=t.y,c=n.y,h=Math.min(s,r,o),u=Math.min(a,l,c),p=Math.max(s,r,o),d=Math.max(a,l,c),g=n.next;for(;g!==e;){if(g.x>=h&&g.x<=p&&g.y>=u&&g.y<=d&&ur(s,a,r,l,o,c,g.x,g.y)&&dt(g.prev,g,g.next)>=0)return!1;g=g.next}return!0}function rg(i,e,t,n){let s=i.prev,r=i,o=i.next;if(dt(s,r,o)>=0)return!1;let a=s.x,l=r.x,c=o.x,h=s.y,u=r.y,p=o.y,d=Math.min(a,l,c),g=Math.min(h,u,p),_=Math.max(a,l,c),m=Math.max(h,u,p),f=Oc(d,g,e,t,n),w=Oc(_,m,e,t,n),M=i.prevZ,v=i.nextZ;for(;M&&M.z>=f&&v&&v.z<=w;){if(M.x>=d&&M.x<=_&&M.y>=g&&M.y<=m&&M!==s&&M!==o&&ur(a,h,l,u,c,p,M.x,M.y)&&dt(M.prev,M,M.next)>=0||(M=M.prevZ,v.x>=d&&v.x<=_&&v.y>=g&&v.y<=m&&v!==s&&v!==o&&ur(a,h,l,u,c,p,v.x,v.y)&&dt(v.prev,v,v.next)>=0))return!1;v=v.nextZ}for(;M&&M.z>=f;){if(M.x>=d&&M.x<=_&&M.y>=g&&M.y<=m&&M!==s&&M!==o&&ur(a,h,l,u,c,p,M.x,M.y)&&dt(M.prev,M,M.next)>=0)return!1;M=M.prevZ}for(;v&&v.z<=w;){if(v.x>=d&&v.x<=_&&v.y>=g&&v.y<=m&&v!==s&&v!==o&&ur(a,h,l,u,c,p,v.x,v.y)&&dt(v.prev,v,v.next)>=0)return!1;v=v.nextZ}return!0}function og(i,e){let t=i;do{let n=t.prev,s=t.next.next;!Cs(n,s)&&gf(n,t,t.next,s)&&Ur(n,s)&&Ur(s,n)&&(e.push(n.i,t.i,s.i),Fr(t),Fr(t.next),t=i=s),t=t.next}while(t!==i);return Di(t)}function ag(i,e,t,n,s,r){let o=i;do{let a=o.next.next;for(;a!==o.prev;){if(o.i!==a.i&&gg(o,a)){let l=_f(o,a);o=Di(o,o.next),l=Di(l,l.next),Nr(o,e,t,n,s,r,0),Nr(l,e,t,n,s,r,0);return}a=a.next}o=o.next}while(o!==i)}function lg(i,e,t,n){let s=[];for(let r=0,o=e.length;r<o;r++){let a=e[r]*n,l=r<o-1?e[r+1]*n:i.length,c=pf(i,a,l,n,!1);c===c.next&&(c.steiner=!0),s.push(mg(c))}s.sort(cg);for(let r=0;r<s.length;r++)t=hg(s[r],t);return t}function cg(i,e){let t=i.x-e.x;if(t===0&&(t=i.y-e.y,t===0)){let n=(i.next.y-i.y)/(i.next.x-i.x),s=(e.next.y-e.y)/(e.next.x-e.x);t=n-s}return t}function hg(i,e){let t=ug(i,e);if(!t)return e;let n=_f(t,i);return Di(n,n.next),Di(t,t.next)}function ug(i,e){let t=e,n=i.x,s=i.y,r=-1/0,o;if(Cs(i,t))return t;do{if(Cs(i,t.next))return t.next;if(s<=t.y&&s>=t.next.y&&t.next.y!==t.y){let u=t.x+(s-t.y)*(t.next.x-t.x)/(t.next.y-t.y);if(u<=n&&u>r&&(r=u,o=t.x<t.next.x?t:t.next,u===n))return o}t=t.next}while(t!==e);if(!o)return null;let a=o,l=o.x,c=o.y,h=1/0;t=o;do{if(n>=t.x&&t.x>=l&&n!==t.x&&mf(s<c?n:r,s,l,c,s<c?r:n,s,t.x,t.y)){let u=Math.abs(s-t.y)/(n-t.x);Ur(t,i)&&(u<h||u===h&&(t.x>o.x||t.x===o.x&&dg(o,t)))&&(o=t,h=u)}t=t.next}while(t!==a);return o}function dg(i,e){return dt(i.prev,i,e.prev)<0&&dt(e.next,i,i.next)<0}function fg(i,e,t,n){let s=i;do s.z===0&&(s.z=Oc(s.x,s.y,e,t,n)),s.prevZ=s.prev,s.nextZ=s.next,s=s.next;while(s!==i);s.prevZ.nextZ=null,s.prevZ=null,pg(s)}function pg(i){let e,t=1;do{let n=i,s;i=null;let r=null;for(e=0;n;){e++;let o=n,a=0;for(let c=0;c<t&&(a++,o=o.nextZ,!!o);c++);let l=t;for(;a>0||l>0&&o;)a!==0&&(l===0||!o||n.z<=o.z)?(s=n,n=n.nextZ,a--):(s=o,o=o.nextZ,l--),r?r.nextZ=s:i=s,s.prevZ=r,r=s;n=o}r.nextZ=null,t*=2}while(e>1);return i}function Oc(i,e,t,n,s){return i=(i-t)*s|0,e=(e-n)*s|0,i=(i|i<<8)&16711935,i=(i|i<<4)&252645135,i=(i|i<<2)&858993459,i=(i|i<<1)&1431655765,e=(e|e<<8)&16711935,e=(e|e<<4)&252645135,e=(e|e<<2)&858993459,e=(e|e<<1)&1431655765,i|e<<1}function mg(i){let e=i,t=i;do(e.x<t.x||e.x===t.x&&e.y<t.y)&&(t=e),e=e.next;while(e!==i);return t}function mf(i,e,t,n,s,r,o,a){return(s-o)*(e-a)>=(i-o)*(r-a)&&(i-o)*(n-a)>=(t-o)*(e-a)&&(t-o)*(r-a)>=(s-o)*(n-a)}function ur(i,e,t,n,s,r,o,a){return!(i===o&&e===a)&&mf(i,e,t,n,s,r,o,a)}function gg(i,e){return i.next.i!==e.i&&i.prev.i!==e.i&&!_g(i,e)&&(Ur(i,e)&&Ur(e,i)&&yg(i,e)&&(dt(i.prev,i,e.prev)||dt(i,e.prev,e))||Cs(i,e)&&dt(i.prev,i,i.next)>0&&dt(e.prev,e,e.next)>0)}function dt(i,e,t){return(e.y-i.y)*(t.x-e.x)-(e.x-i.x)*(t.y-e.y)}function Cs(i,e){return i.x===e.x&&i.y===e.y}function gf(i,e,t,n){let s=Wo(dt(i,e,t)),r=Wo(dt(i,e,n)),o=Wo(dt(t,n,i)),a=Wo(dt(t,n,e));return!!(s!==r&&o!==a||s===0&&Ho(i,t,e)||r===0&&Ho(i,n,e)||o===0&&Ho(t,i,n)||a===0&&Ho(t,e,n))}function Ho(i,e,t){return e.x<=Math.max(i.x,t.x)&&e.x>=Math.min(i.x,t.x)&&e.y<=Math.max(i.y,t.y)&&e.y>=Math.min(i.y,t.y)}function Wo(i){return i>0?1:i<0?-1:0}function _g(i,e){let t=i;do{if(t.i!==i.i&&t.next.i!==i.i&&t.i!==e.i&&t.next.i!==e.i&&gf(t,t.next,i,e))return!0;t=t.next}while(t!==i);return!1}function Ur(i,e){return dt(i.prev,i,i.next)<0?dt(i,e,i.next)>=0&&dt(i,i.prev,e)>=0:dt(i,e,i.prev)<0||dt(i,i.next,e)<0}function yg(i,e){let t=i,n=!1,s=(i.x+e.x)/2,r=(i.y+e.y)/2;do t.y>r!=t.next.y>r&&t.next.y!==t.y&&s<(t.next.x-t.x)*(r-t.y)/(t.next.y-t.y)+t.x&&(n=!n),t=t.next;while(t!==i);return n}function _f(i,e){let t=Bc(i.i,i.x,i.y),n=Bc(e.i,e.x,e.y),s=i.next,r=e.prev;return i.next=e,e.prev=i,t.next=s,s.prev=t,n.next=t,t.prev=n,r.next=n,n.prev=r,n}function fd(i,e,t,n){let s=Bc(i,e,t);return n?(s.next=n.next,s.prev=n,n.next.prev=s,n.next=s):(s.prev=s,s.next=s),s}function Fr(i){i.next.prev=i.prev,i.prev.next=i.next,i.prevZ&&(i.prevZ.nextZ=i.nextZ),i.nextZ&&(i.nextZ.prevZ=i.prevZ)}function Bc(i,e,t){return{i,x:e,y:t,prev:null,next:null,z:0,prevZ:null,nextZ:null,steiner:!1}}function xg(i,e,t,n){let s=0;for(let r=e,o=t-n;r<t;r+=n)s+=(i[o]-i[r])*(i[r+1]+i[o+1]),o=r;return s}function pd(i){let e=i.length;e>2&&i[e-1].equals(i[0])&&i.pop()}function md(i,e){for(let t=0;t<e.length;t++)i.push(e[t].x),i.push(e[t].y)}function vg(i,e){if(e.shapes=[],Array.isArray(i))for(let t=0,n=i.length;t<n;t++){let s=i[t];e.shapes.push(s.uuid)}else e.shapes.push(i.uuid);return e}function Xo(i,e){return!i||i.constructor===e?i:typeof e.BYTES_PER_ELEMENT=="number"?new e(i):Array.prototype.slice.call(i)}function Mg(i){return ArrayBuffer.isView(i)&&!(i instanceof DataView)}function xd(i,e){return i.distance-e.distance}function Hc(i,e,t,n){let s=!0;if(i.layers.test(e.layers)&&i.raycast(e,t)===!1&&(s=!1),s===!0&&n===!0){let r=i.children;for(let o=0,a=r.length;o<a;o++)Hc(r[o],e,t,!0)}}function fh(i,e,t,n){let s=Ig(n);switch(t){case Qc:return i*e;case th:return i*e/s.components*s.byteLength;case Oa:return i*e/s.components*s.byteLength;case nh:return i*e*2/s.components*s.byteLength;case Ba:return i*e*2/s.components*s.byteLength;case eh:return i*e*3/s.components*s.byteLength;case It:return i*e*4/s.components*s.byteLength;case ka:return i*e*4/s.components*s.byteLength;case Zr:case jr:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*8;case Kr:case Jr:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case Va:case Ha:return Math.max(i,16)*Math.max(e,8)/4;case za:case Ga:return Math.max(i,8)*Math.max(e,8)/2;case Wa:case Xa:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*8;case qa:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case Ya:return Math.floor((i+3)/4)*Math.floor((e+3)/4)*16;case $a:return Math.floor((i+4)/5)*Math.floor((e+3)/4)*16;case Za:return Math.floor((i+4)/5)*Math.floor((e+4)/5)*16;case ja:return Math.floor((i+5)/6)*Math.floor((e+4)/5)*16;case Ka:return Math.floor((i+5)/6)*Math.floor((e+5)/6)*16;case Ja:return Math.floor((i+7)/8)*Math.floor((e+4)/5)*16;case Qa:return Math.floor((i+7)/8)*Math.floor((e+5)/6)*16;case el:return Math.floor((i+7)/8)*Math.floor((e+7)/8)*16;case tl:return Math.floor((i+9)/10)*Math.floor((e+4)/5)*16;case nl:return Math.floor((i+9)/10)*Math.floor((e+5)/6)*16;case il:return Math.floor((i+9)/10)*Math.floor((e+7)/8)*16;case sl:return Math.floor((i+9)/10)*Math.floor((e+9)/10)*16;case rl:return Math.floor((i+11)/12)*Math.floor((e+9)/10)*16;case ol:return Math.floor((i+11)/12)*Math.floor((e+11)/12)*16;case Qr:case al:case ll:return Math.ceil(i/4)*Math.ceil(e/4)*16;case ih:case cl:return Math.ceil(i/4)*Math.ceil(e/4)*8;case hl:case ul:return Math.ceil(i/4)*Math.ceil(e/4)*16}throw new Error(`Unable to determine texture byte length for ${t} format.`)}function Ig(i){switch(i){case Ot:case jc:return{byteLength:1,components:1};case Is:case Kc:case Ps:return{byteLength:2,components:1};case Ua:case Fa:return{byteLength:2,components:4};case li:case Na:case Mn:return{byteLength:4,components:1};case Jc:return{byteLength:4,components:3}}throw new Error(`Unknown texture type ${i}.`)}var ri,oi,vd,Wc,Md,Xc,bd,vn,Nn,Ft,Rt,Bn,Ci,qc,Yc,$c,Sd,ei,wd,Ed,Td,Ad,Cd,Rd,Id,Pd,Yo,$o,Ld,Dd,Nd,Ud,Fd,Od,Bd,kd,zd,Sa,wa,Ea,Ri,Ta,Aa,Ca,Ra,Ia,Vd,Gd,kn,Hd,Wd,Xd,qd,Yd,$d,Zd,Zc,Fi,Oi,Pa,La,Yr,Zo,Qn,jo,zt,jd,$r,Et,Da,ai,Ot,jc,Kc,Is,Na,li,Mn,Ps,Ua,Fa,Ls,Jc,Qc,eh,It,gs,Ds,th,Oa,nh,Ba,ka,Zr,jr,Kr,Jr,za,Va,Ga,Ha,Wa,Xa,qa,Ya,$a,Za,ja,Ka,Ja,Qa,el,tl,nl,il,sl,rl,ol,Qr,al,ll,ih,cl,hl,ul,gr,Ko,qo,Pc,Lc,Dc,Kd,Jd,dl,Qd,zn,xt,Ii,_r,Qe,Ai,Nc,ef,tf,nf,sh,sf,rf,of,af,Uc,rh,yn,yr,xn,Tt,Vu,dr,_s,ah,ce,sn,D,rc,Gu,Be,oc,Hu,Wu,Xu,Ye,ts,Jo,Im,ys,Pm,lc,Ut,pt,Qo,rn,vr,ea,ti,Cn,un,Mo,ns,is,ss,qn,Yn,Si,or,bo,So,wi,Lm,ar,hc,ni,Rn,uc,wo,$n,dc,Eo,fc,Un,it,rs,dn,Dm,Nm,Zn,To,Yt,qu,Yu,on,xs,Um,$u,os,In,Ao,lr,Fm,Om,Zu,ju,Ku,Ju,Bm,as,pc,wt,fn,Pn,mc,Ln,ls,cs,Qu,gc,_c,yc,xc,vc,Mc,Jn,df,jn,Co,Ne,At,km,pn,Vt,yt,Ro,zm,Ke,Mr,br,ft,Vm,en,Sc,hs,$t,cr,St,lt,ed,Ei,Io,td,Po,Lo,Do,wc,No,nd,Uo,gt,vs,ff,Wm,Xm,mn,Sr,Kn,id,sd,Ct,us,ds,ta,wr,na,nn,qm,Ms,Er,Li,Ec,Ym,$m,tn,Ti,Zm,Oo,bs,Gt,ia,sa,rd,hr,Bo,Tc,od,Tr,ad,ld,Fn,Ss,ws,cd,Fc,zo,Vo,Ar,Es,Cr,Zt,Ts,ra,Go,Ac,Cc,Rc,oa,Rr,aa,Ir,la,Pr,ca,Lr,dd,ha,Dr,As,kc,ms,On,Or,Br,kr,zr,ua,da,Ni,fa,pa,ma,jt,ii,ga,_a,ya,Vr,si,xa,va,yf,Ma,Gr,Hr,Ic,gd,_d,zc,Ui,Vc,Wr,ba,uh,bg,dh,Sg,wg,Eg,Tg,Ag,Cg,Rg,Gc,ot,KM,yd,Xr,Rs,qr,ph=He(()=>{ri={LEFT:0,MIDDLE:1,RIGHT:2,ROTATE:0,DOLLY:1,PAN:2},oi={ROTATE:0,PAN:1,DOLLY_PAN:2,DOLLY_ROTATE:3},vd=0,Wc=1,Md=2,Xc=1,bd=2,vn=3,Nn=0,Ft=1,Rt=2,Bn=0,Ci=1,qc=2,Yc=3,$c=4,Sd=5,ei=100,wd=101,Ed=102,Td=103,Ad=104,Cd=200,Rd=201,Id=202,Pd=203,Yo=204,$o=205,Ld=206,Dd=207,Nd=208,Ud=209,Fd=210,Od=211,Bd=212,kd=213,zd=214,Sa=0,wa=1,Ea=2,Ri=3,Ta=4,Aa=5,Ca=6,Ra=7,Ia=0,Vd=1,Gd=2,kn=0,Hd=1,Wd=2,Xd=3,qd=4,Yd=5,$d=6,Zd=7,Zc=300,Fi=301,Oi=302,Pa=303,La=304,Yr=306,Zo=1e3,Qn=1001,jo=1002,zt=1003,jd=1004,$r=1005,Et=1006,Da=1007,ai=1008,Ot=1009,jc=1010,Kc=1011,Is=1012,Na=1013,li=1014,Mn=1015,Ps=1016,Ua=1017,Fa=1018,Ls=1020,Jc=35902,Qc=1021,eh=1022,It=1023,gs=1026,Ds=1027,th=1028,Oa=1029,nh=1030,Ba=1031,ka=1033,Zr=33776,jr=33777,Kr=33778,Jr=33779,za=35840,Va=35841,Ga=35842,Ha=35843,Wa=36196,Xa=37492,qa=37496,Ya=37808,$a=37809,Za=37810,ja=37811,Ka=37812,Ja=37813,Qa=37814,el=37815,tl=37816,nl=37817,il=37818,sl=37819,rl=37820,ol=37821,Qr=36492,al=36494,ll=36495,ih=36283,cl=36284,hl=36285,ul=36286,gr=2300,Ko=2301,qo=2302,Pc=2400,Lc=2401,Dc=2402,Kd=3200,Jd=3201,dl=0,Qd=1,zn="",xt="srgb",Ii="srgb-linear",_r="linear",Qe="srgb",Ai=7680,Nc=519,ef=512,tf=513,nf=514,sh=515,sf=516,rf=517,of=518,af=519,Uc=35044,rh="300 es",yn=2e3,yr=2001,xn=class{addEventListener(e,t){this._listeners===void 0&&(this._listeners={});let n=this._listeners;n[e]===void 0&&(n[e]=[]),n[e].indexOf(t)===-1&&n[e].push(t)}hasEventListener(e,t){let n=this._listeners;return n===void 0?!1:n[e]!==void 0&&n[e].indexOf(t)!==-1}removeEventListener(e,t){let n=this._listeners;if(n===void 0)return;let s=n[e];if(s!==void 0){let r=s.indexOf(t);r!==-1&&s.splice(r,1)}}dispatchEvent(e){let t=this._listeners;if(t===void 0)return;let n=t[e.type];if(n!==void 0){e.target=this;let s=n.slice(0);for(let r=0,o=s.length;r<o;r++)s[r].call(this,e);e.target=null}}},Tt=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"],Vu=1234567,dr=Math.PI/180,_s=180/Math.PI;ah={DEG2RAD:dr,RAD2DEG:_s,generateUUID:Bi,clamp:ze,euclideanModulo:oh,mapLinear:fm,inverseLerp:pm,lerp:fr,damp:mm,pingpong:gm,smoothstep:_m,smootherstep:ym,randInt:xm,randFloat:vm,randFloatSpread:Mm,seededRandom:bm,degToRad:Sm,radToDeg:wm,isPowerOfTwo:Em,ceilPowerOfTwo:Tm,floorPowerOfTwo:Am,setQuaternionFromProperEuler:Cm,normalize:Nt,denormalize:fs},ce=class i{constructor(e=0,t=0){i.prototype.isVector2=!0,this.x=e,this.y=t}get width(){return this.x}set width(e){this.x=e}get height(){return this.y}set height(e){this.y=e}set(e,t){return this.x=e,this.y=t,this}setScalar(e){return this.x=e,this.y=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;default:throw new Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;default:throw new Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y)}copy(e){return this.x=e.x,this.y=e.y,this}add(e){return this.x+=e.x,this.y+=e.y,this}addScalar(e){return this.x+=e,this.y+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this}subScalar(e){return this.x-=e,this.y-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this}multiply(e){return this.x*=e.x,this.y*=e.y,this}multiplyScalar(e){return this.x*=e,this.y*=e,this}divide(e){return this.x/=e.x,this.y/=e.y,this}divideScalar(e){return this.multiplyScalar(1/e)}applyMatrix3(e){let t=this.x,n=this.y,s=e.elements;return this.x=s[0]*t+s[3]*n+s[6],this.y=s[1]*t+s[4]*n+s[7],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this}clamp(e,t){return this.x=ze(this.x,e.x,t.x),this.y=ze(this.y,e.y,t.y),this}clampScalar(e,t){return this.x=ze(this.x,e,t),this.y=ze(this.y,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ze(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(e){return this.x*e.x+this.y*e.y}cross(e){return this.x*e.y-this.y*e.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ze(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y;return t*t+n*n}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this}equals(e){return e.x===this.x&&e.y===this.y}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this}rotateAround(e,t){let n=Math.cos(t),s=Math.sin(t),r=this.x-e.x,o=this.y-e.y;return this.x=r*n-o*s+e.x,this.y=r*s+o*n+e.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}},sn=class{constructor(e=0,t=0,n=0,s=1){this.isQuaternion=!0,this._x=e,this._y=t,this._z=n,this._w=s}static slerpFlat(e,t,n,s,r,o,a){let l=n[s+0],c=n[s+1],h=n[s+2],u=n[s+3],p=r[o+0],d=r[o+1],g=r[o+2],_=r[o+3];if(a===0){e[t+0]=l,e[t+1]=c,e[t+2]=h,e[t+3]=u;return}if(a===1){e[t+0]=p,e[t+1]=d,e[t+2]=g,e[t+3]=_;return}if(u!==_||l!==p||c!==d||h!==g){let m=1-a,f=l*p+c*d+h*g+u*_,w=f>=0?1:-1,M=1-f*f;if(M>Number.EPSILON){let A=Math.sqrt(M),I=Math.atan2(A,f*w);m=Math.sin(m*I)/A,a=Math.sin(a*I)/A}let v=a*w;if(l=l*m+p*v,c=c*m+d*v,h=h*m+g*v,u=u*m+_*v,m===1-a){let A=1/Math.sqrt(l*l+c*c+h*h+u*u);l*=A,c*=A,h*=A,u*=A}}e[t]=l,e[t+1]=c,e[t+2]=h,e[t+3]=u}static multiplyQuaternionsFlat(e,t,n,s,r,o){let a=n[s],l=n[s+1],c=n[s+2],h=n[s+3],u=r[o],p=r[o+1],d=r[o+2],g=r[o+3];return e[t]=a*g+h*u+l*d-c*p,e[t+1]=l*g+h*p+c*u-a*d,e[t+2]=c*g+h*d+a*p-l*u,e[t+3]=h*g-a*u-l*p-c*d,e}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get w(){return this._w}set w(e){this._w=e,this._onChangeCallback()}set(e,t,n,s){return this._x=e,this._y=t,this._z=n,this._w=s,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(e){return this._x=e.x,this._y=e.y,this._z=e.z,this._w=e.w,this._onChangeCallback(),this}setFromEuler(e,t=!0){let n=e._x,s=e._y,r=e._z,o=e._order,a=Math.cos,l=Math.sin,c=a(n/2),h=a(s/2),u=a(r/2),p=l(n/2),d=l(s/2),g=l(r/2);switch(o){case"XYZ":this._x=p*h*u+c*d*g,this._y=c*d*u-p*h*g,this._z=c*h*g+p*d*u,this._w=c*h*u-p*d*g;break;case"YXZ":this._x=p*h*u+c*d*g,this._y=c*d*u-p*h*g,this._z=c*h*g-p*d*u,this._w=c*h*u+p*d*g;break;case"ZXY":this._x=p*h*u-c*d*g,this._y=c*d*u+p*h*g,this._z=c*h*g+p*d*u,this._w=c*h*u-p*d*g;break;case"ZYX":this._x=p*h*u-c*d*g,this._y=c*d*u+p*h*g,this._z=c*h*g-p*d*u,this._w=c*h*u+p*d*g;break;case"YZX":this._x=p*h*u+c*d*g,this._y=c*d*u+p*h*g,this._z=c*h*g-p*d*u,this._w=c*h*u-p*d*g;break;case"XZY":this._x=p*h*u-c*d*g,this._y=c*d*u-p*h*g,this._z=c*h*g+p*d*u,this._w=c*h*u+p*d*g;break;default:console.warn("THREE.Quaternion: .setFromEuler() encountered an unknown order: "+o)}return t===!0&&this._onChangeCallback(),this}setFromAxisAngle(e,t){let n=t/2,s=Math.sin(n);return this._x=e.x*s,this._y=e.y*s,this._z=e.z*s,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(e){let t=e.elements,n=t[0],s=t[4],r=t[8],o=t[1],a=t[5],l=t[9],c=t[2],h=t[6],u=t[10],p=n+a+u;if(p>0){let d=.5/Math.sqrt(p+1);this._w=.25/d,this._x=(h-l)*d,this._y=(r-c)*d,this._z=(o-s)*d}else if(n>a&&n>u){let d=2*Math.sqrt(1+n-a-u);this._w=(h-l)/d,this._x=.25*d,this._y=(s+o)/d,this._z=(r+c)/d}else if(a>u){let d=2*Math.sqrt(1+a-n-u);this._w=(r-c)/d,this._x=(s+o)/d,this._y=.25*d,this._z=(l+h)/d}else{let d=2*Math.sqrt(1+u-n-a);this._w=(o-s)/d,this._x=(r+c)/d,this._y=(l+h)/d,this._z=.25*d}return this._onChangeCallback(),this}setFromUnitVectors(e,t){let n=e.dot(t)+1;return n<1e-8?(n=0,Math.abs(e.x)>Math.abs(e.z)?(this._x=-e.y,this._y=e.x,this._z=0,this._w=n):(this._x=0,this._y=-e.z,this._z=e.y,this._w=n)):(this._x=e.y*t.z-e.z*t.y,this._y=e.z*t.x-e.x*t.z,this._z=e.x*t.y-e.y*t.x,this._w=n),this.normalize()}angleTo(e){return 2*Math.acos(Math.abs(ze(this.dot(e),-1,1)))}rotateTowards(e,t){let n=this.angleTo(e);if(n===0)return this;let s=Math.min(1,t/n);return this.slerp(e,s),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(e){return this._x*e._x+this._y*e._y+this._z*e._z+this._w*e._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let e=this.length();return e===0?(this._x=0,this._y=0,this._z=0,this._w=1):(e=1/e,this._x=this._x*e,this._y=this._y*e,this._z=this._z*e,this._w=this._w*e),this._onChangeCallback(),this}multiply(e){return this.multiplyQuaternions(this,e)}premultiply(e){return this.multiplyQuaternions(e,this)}multiplyQuaternions(e,t){let n=e._x,s=e._y,r=e._z,o=e._w,a=t._x,l=t._y,c=t._z,h=t._w;return this._x=n*h+o*a+s*c-r*l,this._y=s*h+o*l+r*a-n*c,this._z=r*h+o*c+n*l-s*a,this._w=o*h-n*a-s*l-r*c,this._onChangeCallback(),this}slerp(e,t){if(t===0)return this;if(t===1)return this.copy(e);let n=this._x,s=this._y,r=this._z,o=this._w,a=o*e._w+n*e._x+s*e._y+r*e._z;if(a<0?(this._w=-e._w,this._x=-e._x,this._y=-e._y,this._z=-e._z,a=-a):this.copy(e),a>=1)return this._w=o,this._x=n,this._y=s,this._z=r,this;let l=1-a*a;if(l<=Number.EPSILON){let d=1-t;return this._w=d*o+t*this._w,this._x=d*n+t*this._x,this._y=d*s+t*this._y,this._z=d*r+t*this._z,this.normalize(),this}let c=Math.sqrt(l),h=Math.atan2(c,a),u=Math.sin((1-t)*h)/c,p=Math.sin(t*h)/c;return this._w=o*u+this._w*p,this._x=n*u+this._x*p,this._y=s*u+this._y*p,this._z=r*u+this._z*p,this._onChangeCallback(),this}slerpQuaternions(e,t,n){return this.copy(e).slerp(t,n)}random(){let e=2*Math.PI*Math.random(),t=2*Math.PI*Math.random(),n=Math.random(),s=Math.sqrt(1-n),r=Math.sqrt(n);return this.set(s*Math.sin(e),s*Math.cos(e),r*Math.sin(t),r*Math.cos(t))}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._w===this._w}fromArray(e,t=0){return this._x=e[t],this._y=e[t+1],this._z=e[t+2],this._w=e[t+3],this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._w,e}fromBufferAttribute(e,t){return this._x=e.getX(t),this._y=e.getY(t),this._z=e.getZ(t),this._w=e.getW(t),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}},D=class i{constructor(e=0,t=0,n=0){i.prototype.isVector3=!0,this.x=e,this.y=t,this.z=n}set(e,t,n){return n===void 0&&(n=this.z),this.x=e,this.y=t,this.z=n,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;default:throw new Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this}multiplyVectors(e,t){return this.x=e.x*t.x,this.y=e.y*t.y,this.z=e.z*t.z,this}applyEuler(e){return this.applyQuaternion(Gu.setFromEuler(e))}applyAxisAngle(e,t){return this.applyQuaternion(Gu.setFromAxisAngle(e,t))}applyMatrix3(e){let t=this.x,n=this.y,s=this.z,r=e.elements;return this.x=r[0]*t+r[3]*n+r[6]*s,this.y=r[1]*t+r[4]*n+r[7]*s,this.z=r[2]*t+r[5]*n+r[8]*s,this}applyNormalMatrix(e){return this.applyMatrix3(e).normalize()}applyMatrix4(e){let t=this.x,n=this.y,s=this.z,r=e.elements,o=1/(r[3]*t+r[7]*n+r[11]*s+r[15]);return this.x=(r[0]*t+r[4]*n+r[8]*s+r[12])*o,this.y=(r[1]*t+r[5]*n+r[9]*s+r[13])*o,this.z=(r[2]*t+r[6]*n+r[10]*s+r[14])*o,this}applyQuaternion(e){let t=this.x,n=this.y,s=this.z,r=e.x,o=e.y,a=e.z,l=e.w,c=2*(o*s-a*n),h=2*(a*t-r*s),u=2*(r*n-o*t);return this.x=t+l*c+o*u-a*h,this.y=n+l*h+a*c-r*u,this.z=s+l*u+r*h-o*c,this}project(e){return this.applyMatrix4(e.matrixWorldInverse).applyMatrix4(e.projectionMatrix)}unproject(e){return this.applyMatrix4(e.projectionMatrixInverse).applyMatrix4(e.matrixWorld)}transformDirection(e){let t=this.x,n=this.y,s=this.z,r=e.elements;return this.x=r[0]*t+r[4]*n+r[8]*s,this.y=r[1]*t+r[5]*n+r[9]*s,this.z=r[2]*t+r[6]*n+r[10]*s,this.normalize()}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this}divideScalar(e){return this.multiplyScalar(1/e)}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this}clamp(e,t){return this.x=ze(this.x,e.x,t.x),this.y=ze(this.y,e.y,t.y),this.z=ze(this.z,e.z,t.z),this}clampScalar(e,t){return this.x=ze(this.x,e,t),this.y=ze(this.y,e,t),this.z=ze(this.z,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ze(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this}cross(e){return this.crossVectors(this,e)}crossVectors(e,t){let n=e.x,s=e.y,r=e.z,o=t.x,a=t.y,l=t.z;return this.x=s*l-r*a,this.y=r*o-n*l,this.z=n*a-s*o,this}projectOnVector(e){let t=e.lengthSq();if(t===0)return this.set(0,0,0);let n=e.dot(this)/t;return this.copy(e).multiplyScalar(n)}projectOnPlane(e){return rc.copy(this).projectOnVector(e),this.sub(rc)}reflect(e){return this.sub(rc.copy(e).multiplyScalar(2*this.dot(e)))}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ze(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y,s=this.z-e.z;return t*t+n*n+s*s}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)+Math.abs(this.z-e.z)}setFromSpherical(e){return this.setFromSphericalCoords(e.radius,e.phi,e.theta)}setFromSphericalCoords(e,t,n){let s=Math.sin(t)*e;return this.x=s*Math.sin(n),this.y=Math.cos(t)*e,this.z=s*Math.cos(n),this}setFromCylindrical(e){return this.setFromCylindricalCoords(e.radius,e.theta,e.y)}setFromCylindricalCoords(e,t,n){return this.x=e*Math.sin(t),this.y=n,this.z=e*Math.cos(t),this}setFromMatrixPosition(e){let t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this}setFromMatrixScale(e){let t=this.setFromMatrixColumn(e,0).length(),n=this.setFromMatrixColumn(e,1).length(),s=this.setFromMatrixColumn(e,2).length();return this.x=t,this.y=n,this.z=s,this}setFromMatrixColumn(e,t){return this.fromArray(e.elements,t*4)}setFromMatrix3Column(e,t){return this.fromArray(e.elements,t*3)}setFromEuler(e){return this.x=e._x,this.y=e._y,this.z=e._z,this}setFromColor(e){return this.x=e.r,this.y=e.g,this.z=e.b,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let e=Math.random()*Math.PI*2,t=Math.random()*2-1,n=Math.sqrt(1-t*t);return this.x=n*Math.cos(e),this.y=t,this.z=n*Math.sin(e),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}},rc=new D,Gu=new sn,Be=class i{constructor(e,t,n,s,r,o,a,l,c){i.prototype.isMatrix3=!0,this.elements=[1,0,0,0,1,0,0,0,1],e!==void 0&&this.set(e,t,n,s,r,o,a,l,c)}set(e,t,n,s,r,o,a,l,c){let h=this.elements;return h[0]=e,h[1]=s,h[2]=a,h[3]=t,h[4]=r,h[5]=l,h[6]=n,h[7]=o,h[8]=c,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],this}extractBasis(e,t,n){return e.setFromMatrix3Column(this,0),t.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(e){let t=e.elements;return this.set(t[0],t[4],t[8],t[1],t[5],t[9],t[2],t[6],t[10]),this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,s=t.elements,r=this.elements,o=n[0],a=n[3],l=n[6],c=n[1],h=n[4],u=n[7],p=n[2],d=n[5],g=n[8],_=s[0],m=s[3],f=s[6],w=s[1],M=s[4],v=s[7],A=s[2],I=s[5],C=s[8];return r[0]=o*_+a*w+l*A,r[3]=o*m+a*M+l*I,r[6]=o*f+a*v+l*C,r[1]=c*_+h*w+u*A,r[4]=c*m+h*M+u*I,r[7]=c*f+h*v+u*C,r[2]=p*_+d*w+g*A,r[5]=p*m+d*M+g*I,r[8]=p*f+d*v+g*C,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[3]*=e,t[6]*=e,t[1]*=e,t[4]*=e,t[7]*=e,t[2]*=e,t[5]*=e,t[8]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[1],s=e[2],r=e[3],o=e[4],a=e[5],l=e[6],c=e[7],h=e[8];return t*o*h-t*a*c-n*r*h+n*a*l+s*r*c-s*o*l}invert(){let e=this.elements,t=e[0],n=e[1],s=e[2],r=e[3],o=e[4],a=e[5],l=e[6],c=e[7],h=e[8],u=h*o-a*c,p=a*l-h*r,d=c*r-o*l,g=t*u+n*p+s*d;if(g===0)return this.set(0,0,0,0,0,0,0,0,0);let _=1/g;return e[0]=u*_,e[1]=(s*c-h*n)*_,e[2]=(a*n-s*o)*_,e[3]=p*_,e[4]=(h*t-s*l)*_,e[5]=(s*r-a*t)*_,e[6]=d*_,e[7]=(n*l-c*t)*_,e[8]=(o*t-n*r)*_,this}transpose(){let e,t=this.elements;return e=t[1],t[1]=t[3],t[3]=e,e=t[2],t[2]=t[6],t[6]=e,e=t[5],t[5]=t[7],t[7]=e,this}getNormalMatrix(e){return this.setFromMatrix4(e).invert().transpose()}transposeIntoArray(e){let t=this.elements;return e[0]=t[0],e[1]=t[3],e[2]=t[6],e[3]=t[1],e[4]=t[4],e[5]=t[7],e[6]=t[2],e[7]=t[5],e[8]=t[8],this}setUvTransform(e,t,n,s,r,o,a){let l=Math.cos(r),c=Math.sin(r);return this.set(n*l,n*c,-n*(l*o+c*a)+o+e,-s*c,s*l,-s*(-c*o+l*a)+a+t,0,0,1),this}scale(e,t){return this.premultiply(oc.makeScale(e,t)),this}rotate(e){return this.premultiply(oc.makeRotation(-e)),this}translate(e,t){return this.premultiply(oc.makeTranslation(e,t)),this}makeTranslation(e,t){return e.isVector2?this.set(1,0,e.x,0,1,e.y,0,0,1):this.set(1,0,e,0,1,t,0,0,1),this}makeRotation(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,n,t,0,0,0,1),this}makeScale(e,t){return this.set(e,0,0,0,t,0,0,0,1),this}equals(e){let t=this.elements,n=e.elements;for(let s=0;s<9;s++)if(t[s]!==n[s])return!1;return!0}fromArray(e,t=0){for(let n=0;n<9;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e}clone(){return new this.constructor().fromArray(this.elements)}},oc=new Be;Hu={};Wu=new Be().set(.4123908,.3575843,.1804808,.212639,.7151687,.0721923,.0193308,.1191948,.9505322),Xu=new Be().set(3.2409699,-1.5373832,-.4986108,-.9692436,1.8759675,.0415551,.0556301,-.203977,1.0569715);Ye=Rm();Jo=class{static getDataURL(e,t="image/png"){if(/^data:/i.test(e.src)||typeof HTMLCanvasElement>"u")return e.src;let n;if(e instanceof HTMLCanvasElement)n=e;else{ts===void 0&&(ts=xr("canvas")),ts.width=e.width,ts.height=e.height;let s=ts.getContext("2d");e instanceof ImageData?s.putImageData(e,0,0):s.drawImage(e,0,0,e.width,e.height),n=ts}return n.toDataURL(t)}static sRGBToLinear(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap){let t=xr("canvas");t.width=e.width,t.height=e.height;let n=t.getContext("2d");n.drawImage(e,0,0,e.width,e.height);let s=n.getImageData(0,0,e.width,e.height),r=s.data;for(let o=0;o<r.length;o++)r[o]=Dn(r[o]/255)*255;return n.putImageData(s,0,0),t}else if(e.data){let t=e.data.slice(0);for(let n=0;n<t.length;n++)t instanceof Uint8Array||t instanceof Uint8ClampedArray?t[n]=Math.floor(Dn(t[n]/255)*255):t[n]=Dn(t[n]);return{data:t,width:e.width,height:e.height}}else return console.warn("THREE.ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),e}},Im=0,ys=class{constructor(e=null){this.isSource=!0,Object.defineProperty(this,"id",{value:Im++}),this.uuid=Bi(),this.data=e,this.dataReady=!0,this.version=0}getSize(e){let t=this.data;return t instanceof HTMLVideoElement?e.set(t.videoWidth,t.videoHeight):t!==null?e.set(t.width,t.height,t.depth||0):e.set(0,0,0),e}set needsUpdate(e){e===!0&&this.version++}toJSON(e){let t=e===void 0||typeof e=="string";if(!t&&e.images[this.uuid]!==void 0)return e.images[this.uuid];let n={uuid:this.uuid,url:""},s=this.data;if(s!==null){let r;if(Array.isArray(s)){r=[];for(let o=0,a=s.length;o<a;o++)s[o].isDataTexture?r.push(ac(s[o].image)):r.push(ac(s[o]))}else r=ac(s);n.url=r}return t||(e.images[this.uuid]=n),n}};Pm=0,lc=new D,Ut=class i extends xn{constructor(e=i.DEFAULT_IMAGE,t=i.DEFAULT_MAPPING,n=Qn,s=Qn,r=Et,o=ai,a=It,l=Ot,c=i.DEFAULT_ANISOTROPY,h=zn){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Pm++}),this.uuid=Bi(),this.name="",this.source=new ys(e),this.mipmaps=[],this.mapping=t,this.channel=0,this.wrapS=n,this.wrapT=s,this.magFilter=r,this.minFilter=o,this.anisotropy=c,this.format=a,this.internalFormat=null,this.type=l,this.offset=new ce(0,0),this.repeat=new ce(1,1),this.center=new ce(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new Be,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,this.colorSpace=h,this.userData={},this.updateRanges=[],this.version=0,this.onUpdate=null,this.renderTarget=null,this.isRenderTargetTexture=!1,this.isArrayTexture=!!(e&&e.depth&&e.depth>1),this.pmremVersion=0}get width(){return this.source.getSize(lc).x}get height(){return this.source.getSize(lc).y}get depth(){return this.source.getSize(lc).z}get image(){return this.source.data}set image(e=null){this.source.data=e}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}clone(){return new this.constructor().copy(this)}copy(e){return this.name=e.name,this.source=e.source,this.mipmaps=e.mipmaps.slice(0),this.mapping=e.mapping,this.channel=e.channel,this.wrapS=e.wrapS,this.wrapT=e.wrapT,this.magFilter=e.magFilter,this.minFilter=e.minFilter,this.anisotropy=e.anisotropy,this.format=e.format,this.internalFormat=e.internalFormat,this.type=e.type,this.offset.copy(e.offset),this.repeat.copy(e.repeat),this.center.copy(e.center),this.rotation=e.rotation,this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrix.copy(e.matrix),this.generateMipmaps=e.generateMipmaps,this.premultiplyAlpha=e.premultiplyAlpha,this.flipY=e.flipY,this.unpackAlignment=e.unpackAlignment,this.colorSpace=e.colorSpace,this.renderTarget=e.renderTarget,this.isRenderTargetTexture=e.isRenderTargetTexture,this.isArrayTexture=e.isArrayTexture,this.userData=JSON.parse(JSON.stringify(e.userData)),this.needsUpdate=!0,this}setValues(e){for(let t in e){let n=e[t];if(n===void 0){console.warn(`THREE.Texture.setValues(): parameter '${t}' has value of undefined.`);continue}let s=this[t];if(s===void 0){console.warn(`THREE.Texture.setValues(): property '${t}' does not exist.`);continue}s&&n&&s.isVector2&&n.isVector2||s&&n&&s.isVector3&&n.isVector3||s&&n&&s.isMatrix3&&n.isMatrix3?s.copy(n):this[t]=n}}toJSON(e){let t=e===void 0||typeof e=="string";if(!t&&e.textures[this.uuid]!==void 0)return e.textures[this.uuid];let n={metadata:{version:4.7,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(e).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(n.userData=this.userData),t||(e.textures[this.uuid]=n),n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(e){if(this.mapping!==Zc)return e;if(e.applyMatrix3(this.matrix),e.x<0||e.x>1)switch(this.wrapS){case Zo:e.x=e.x-Math.floor(e.x);break;case Qn:e.x=e.x<0?0:1;break;case jo:Math.abs(Math.floor(e.x)%2)===1?e.x=Math.ceil(e.x)-e.x:e.x=e.x-Math.floor(e.x);break}if(e.y<0||e.y>1)switch(this.wrapT){case Zo:e.y=e.y-Math.floor(e.y);break;case Qn:e.y=e.y<0?0:1;break;case jo:Math.abs(Math.floor(e.y)%2)===1?e.y=Math.ceil(e.y)-e.y:e.y=e.y-Math.floor(e.y);break}return this.flipY&&(e.y=1-e.y),e}set needsUpdate(e){e===!0&&(this.version++,this.source.needsUpdate=!0)}set needsPMREMUpdate(e){e===!0&&this.pmremVersion++}};Ut.DEFAULT_IMAGE=null;Ut.DEFAULT_MAPPING=Zc;Ut.DEFAULT_ANISOTROPY=1;pt=class i{constructor(e=0,t=0,n=0,s=1){i.prototype.isVector4=!0,this.x=e,this.y=t,this.z=n,this.w=s}get width(){return this.z}set width(e){this.z=e}get height(){return this.w}set height(e){this.w=e}set(e,t,n,s){return this.x=e,this.y=t,this.z=n,this.w=s,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this.w=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setW(e){return this.w=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;case 3:this.w=t;break;default:throw new Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this.w=e.w!==void 0?e.w:1,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this.w+=e.w,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this.w+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this.w=e.w+t.w,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this.w+=e.w*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this.w-=e.w,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this.w-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this.w=e.w-t.w,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this.w*=e.w,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this.w*=e,this}applyMatrix4(e){let t=this.x,n=this.y,s=this.z,r=this.w,o=e.elements;return this.x=o[0]*t+o[4]*n+o[8]*s+o[12]*r,this.y=o[1]*t+o[5]*n+o[9]*s+o[13]*r,this.z=o[2]*t+o[6]*n+o[10]*s+o[14]*r,this.w=o[3]*t+o[7]*n+o[11]*s+o[15]*r,this}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this.w/=e.w,this}divideScalar(e){return this.multiplyScalar(1/e)}setAxisAngleFromQuaternion(e){this.w=2*Math.acos(e.w);let t=Math.sqrt(1-e.w*e.w);return t<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=e.x/t,this.y=e.y/t,this.z=e.z/t),this}setAxisAngleFromRotationMatrix(e){let t,n,s,r,l=e.elements,c=l[0],h=l[4],u=l[8],p=l[1],d=l[5],g=l[9],_=l[2],m=l[6],f=l[10];if(Math.abs(h-p)<.01&&Math.abs(u-_)<.01&&Math.abs(g-m)<.01){if(Math.abs(h+p)<.1&&Math.abs(u+_)<.1&&Math.abs(g+m)<.1&&Math.abs(c+d+f-3)<.1)return this.set(1,0,0,0),this;t=Math.PI;let M=(c+1)/2,v=(d+1)/2,A=(f+1)/2,I=(h+p)/4,C=(u+_)/4,P=(g+m)/4;return M>v&&M>A?M<.01?(n=0,s=.707106781,r=.707106781):(n=Math.sqrt(M),s=I/n,r=C/n):v>A?v<.01?(n=.707106781,s=0,r=.707106781):(s=Math.sqrt(v),n=I/s,r=P/s):A<.01?(n=.707106781,s=.707106781,r=0):(r=Math.sqrt(A),n=C/r,s=P/r),this.set(n,s,r,t),this}let w=Math.sqrt((m-g)*(m-g)+(u-_)*(u-_)+(p-h)*(p-h));return Math.abs(w)<.001&&(w=1),this.x=(m-g)/w,this.y=(u-_)/w,this.z=(p-h)/w,this.w=Math.acos((c+d+f-1)/2),this}setFromMatrixPosition(e){let t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this.w=t[15],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this.w=Math.min(this.w,e.w),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this.w=Math.max(this.w,e.w),this}clamp(e,t){return this.x=ze(this.x,e.x,t.x),this.y=ze(this.y,e.y,t.y),this.z=ze(this.z,e.z,t.z),this.w=ze(this.w,e.w,t.w),this}clampScalar(e,t){return this.x=ze(this.x,e,t),this.y=ze(this.y,e,t),this.z=ze(this.z,e,t),this.w=ze(this.w,e,t),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(ze(n,e,t))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this.w+=(e.w-this.w)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this.w=e.w+(t.w-e.w)*n,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z&&e.w===this.w}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this.w=e[t+3],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this.w=e.getW(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}},Qo=class extends xn{constructor(e=1,t=1,n={}){super(),n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:Et,depthBuffer:!0,stencilBuffer:!1,resolveDepthBuffer:!0,resolveStencilBuffer:!0,depthTexture:null,samples:0,count:1,depth:1,multiview:!1},n),this.isRenderTarget=!0,this.width=e,this.height=t,this.depth=n.depth,this.scissor=new pt(0,0,e,t),this.scissorTest=!1,this.viewport=new pt(0,0,e,t);let s={width:e,height:t,depth:n.depth},r=new Ut(s);this.textures=[];let o=n.count;for(let a=0;a<o;a++)this.textures[a]=r.clone(),this.textures[a].isRenderTargetTexture=!0,this.textures[a].renderTarget=this;this._setTextureOptions(n),this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.resolveDepthBuffer=n.resolveDepthBuffer,this.resolveStencilBuffer=n.resolveStencilBuffer,this._depthTexture=null,this.depthTexture=n.depthTexture,this.samples=n.samples,this.multiview=n.multiview}_setTextureOptions(e={}){let t={minFilter:Et,generateMipmaps:!1,flipY:!1,internalFormat:null};e.mapping!==void 0&&(t.mapping=e.mapping),e.wrapS!==void 0&&(t.wrapS=e.wrapS),e.wrapT!==void 0&&(t.wrapT=e.wrapT),e.wrapR!==void 0&&(t.wrapR=e.wrapR),e.magFilter!==void 0&&(t.magFilter=e.magFilter),e.minFilter!==void 0&&(t.minFilter=e.minFilter),e.format!==void 0&&(t.format=e.format),e.type!==void 0&&(t.type=e.type),e.anisotropy!==void 0&&(t.anisotropy=e.anisotropy),e.colorSpace!==void 0&&(t.colorSpace=e.colorSpace),e.flipY!==void 0&&(t.flipY=e.flipY),e.generateMipmaps!==void 0&&(t.generateMipmaps=e.generateMipmaps),e.internalFormat!==void 0&&(t.internalFormat=e.internalFormat);for(let n=0;n<this.textures.length;n++)this.textures[n].setValues(t)}get texture(){return this.textures[0]}set texture(e){this.textures[0]=e}set depthTexture(e){this._depthTexture!==null&&(this._depthTexture.renderTarget=null),e!==null&&(e.renderTarget=this),this._depthTexture=e}get depthTexture(){return this._depthTexture}setSize(e,t,n=1){if(this.width!==e||this.height!==t||this.depth!==n){this.width=e,this.height=t,this.depth=n;for(let s=0,r=this.textures.length;s<r;s++)this.textures[s].image.width=e,this.textures[s].image.height=t,this.textures[s].image.depth=n,this.textures[s].isArrayTexture=this.textures[s].image.depth>1;this.dispose()}this.viewport.set(0,0,e,t),this.scissor.set(0,0,e,t)}clone(){return new this.constructor().copy(this)}copy(e){this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.textures.length=0;for(let t=0,n=e.textures.length;t<n;t++){this.textures[t]=e.textures[t].clone(),this.textures[t].isRenderTargetTexture=!0,this.textures[t].renderTarget=this;let s=Object.assign({},e.textures[t].image);this.textures[t].source=new ys(s)}return this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,this.resolveDepthBuffer=e.resolveDepthBuffer,this.resolveStencilBuffer=e.resolveStencilBuffer,e.depthTexture!==null&&(this.depthTexture=e.depthTexture.clone()),this.samples=e.samples,this}dispose(){this.dispatchEvent({type:"dispose"})}},rn=class extends Qo{constructor(e=1,t=1,n={}){super(e,t,n),this.isWebGLRenderTarget=!0}},vr=class extends Ut{constructor(e=null,t=1,n=1,s=1){super(null),this.isDataArrayTexture=!0,this.image={data:e,width:t,height:n,depth:s},this.magFilter=zt,this.minFilter=zt,this.wrapR=Qn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1,this.layerUpdates=new Set}addLayerUpdate(e){this.layerUpdates.add(e)}clearLayerUpdates(){this.layerUpdates.clear()}},ea=class extends Ut{constructor(e=null,t=1,n=1,s=1){super(null),this.isData3DTexture=!0,this.image={data:e,width:t,height:n,depth:s},this.magFilter=zt,this.minFilter=zt,this.wrapR=Qn,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},ti=class{constructor(e=new D(1/0,1/0,1/0),t=new D(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromArray(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t+=3)this.expandByPoint(un.fromArray(e,t));return this}setFromBufferAttribute(e){this.makeEmpty();for(let t=0,n=e.count;t<n;t++)this.expandByPoint(un.fromBufferAttribute(e,t));return this}setFromPoints(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){let n=un.copy(t).multiplyScalar(.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}setFromObject(e,t=!1){return this.makeEmpty(),this.expandByObject(e,t)}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(e){return this.isEmpty()?e.set(0,0,0):e.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(e){return this.isEmpty()?e.set(0,0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}expandByObject(e,t=!1){e.updateWorldMatrix(!1,!1);let n=e.geometry;if(n!==void 0){let r=n.getAttribute("position");if(t===!0&&r!==void 0&&e.isInstancedMesh!==!0)for(let o=0,a=r.count;o<a;o++)e.isMesh===!0?e.getVertexPosition(o,un):un.fromBufferAttribute(r,o),un.applyMatrix4(e.matrixWorld),this.expandByPoint(un);else e.boundingBox!==void 0?(e.boundingBox===null&&e.computeBoundingBox(),Mo.copy(e.boundingBox)):(n.boundingBox===null&&n.computeBoundingBox(),Mo.copy(n.boundingBox)),Mo.applyMatrix4(e.matrixWorld),this.union(Mo)}let s=e.children;for(let r=0,o=s.length;r<o;r++)this.expandByObject(s[r],t);return this}containsPoint(e){return e.x>=this.min.x&&e.x<=this.max.x&&e.y>=this.min.y&&e.y<=this.max.y&&e.z>=this.min.z&&e.z<=this.max.z}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y&&this.min.z<=e.min.z&&e.max.z<=this.max.z}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y),(e.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(e){return e.max.x>=this.min.x&&e.min.x<=this.max.x&&e.max.y>=this.min.y&&e.min.y<=this.max.y&&e.max.z>=this.min.z&&e.min.z<=this.max.z}intersectsSphere(e){return this.clampPoint(e.center,un),un.distanceToSquared(e.center)<=e.radius*e.radius}intersectsPlane(e){let t,n;return e.normal.x>0?(t=e.normal.x*this.min.x,n=e.normal.x*this.max.x):(t=e.normal.x*this.max.x,n=e.normal.x*this.min.x),e.normal.y>0?(t+=e.normal.y*this.min.y,n+=e.normal.y*this.max.y):(t+=e.normal.y*this.max.y,n+=e.normal.y*this.min.y),e.normal.z>0?(t+=e.normal.z*this.min.z,n+=e.normal.z*this.max.z):(t+=e.normal.z*this.max.z,n+=e.normal.z*this.min.z),t<=-e.constant&&n>=-e.constant}intersectsTriangle(e){if(this.isEmpty())return!1;this.getCenter(or),bo.subVectors(this.max,or),ns.subVectors(e.a,or),is.subVectors(e.b,or),ss.subVectors(e.c,or),qn.subVectors(is,ns),Yn.subVectors(ss,is),Si.subVectors(ns,ss);let t=[0,-qn.z,qn.y,0,-Yn.z,Yn.y,0,-Si.z,Si.y,qn.z,0,-qn.x,Yn.z,0,-Yn.x,Si.z,0,-Si.x,-qn.y,qn.x,0,-Yn.y,Yn.x,0,-Si.y,Si.x,0];return!cc(t,ns,is,ss,bo)||(t=[1,0,0,0,1,0,0,0,1],!cc(t,ns,is,ss,bo))?!1:(So.crossVectors(qn,Yn),t=[So.x,So.y,So.z],cc(t,ns,is,ss,bo))}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,un).distanceTo(e)}getBoundingSphere(e){return this.isEmpty()?e.makeEmpty():(this.getCenter(e.center),e.radius=this.getSize(un).length()*.5),e}intersect(e){return this.min.max(e.min),this.max.min(e.max),this.isEmpty()&&this.makeEmpty(),this}union(e){return this.min.min(e.min),this.max.max(e.max),this}applyMatrix4(e){return this.isEmpty()?this:(Cn[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(e),Cn[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(e),Cn[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(e),Cn[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(e),Cn[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(e),Cn[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(e),Cn[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(e),Cn[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(e),this.setFromPoints(Cn),this)}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}toJSON(){return{min:this.min.toArray(),max:this.max.toArray()}}fromJSON(e){return this.min.fromArray(e.min),this.max.fromArray(e.max),this}},Cn=[new D,new D,new D,new D,new D,new D,new D,new D],un=new D,Mo=new ti,ns=new D,is=new D,ss=new D,qn=new D,Yn=new D,Si=new D,or=new D,bo=new D,So=new D,wi=new D;Lm=new ti,ar=new D,hc=new D,ni=class{constructor(e=new D,t=-1){this.isSphere=!0,this.center=e,this.radius=t}set(e,t){return this.center.copy(e),this.radius=t,this}setFromPoints(e,t){let n=this.center;t!==void 0?n.copy(t):Lm.setFromPoints(e).getCenter(n);let s=0;for(let r=0,o=e.length;r<o;r++)s=Math.max(s,n.distanceToSquared(e[r]));return this.radius=Math.sqrt(s),this}copy(e){return this.center.copy(e.center),this.radius=e.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(e){return e.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(e){return e.distanceTo(this.center)-this.radius}intersectsSphere(e){let t=this.radius+e.radius;return e.center.distanceToSquared(this.center)<=t*t}intersectsBox(e){return e.intersectsSphere(this)}intersectsPlane(e){return Math.abs(e.distanceToPoint(this.center))<=this.radius}clampPoint(e,t){let n=this.center.distanceToSquared(e);return t.copy(e),n>this.radius*this.radius&&(t.sub(this.center).normalize(),t.multiplyScalar(this.radius).add(this.center)),t}getBoundingBox(e){return this.isEmpty()?(e.makeEmpty(),e):(e.set(this.center,this.center),e.expandByScalar(this.radius),e)}applyMatrix4(e){return this.center.applyMatrix4(e),this.radius=this.radius*e.getMaxScaleOnAxis(),this}translate(e){return this.center.add(e),this}expandByPoint(e){if(this.isEmpty())return this.center.copy(e),this.radius=0,this;ar.subVectors(e,this.center);let t=ar.lengthSq();if(t>this.radius*this.radius){let n=Math.sqrt(t),s=(n-this.radius)*.5;this.center.addScaledVector(ar,s/n),this.radius+=s}return this}union(e){return e.isEmpty()?this:this.isEmpty()?(this.copy(e),this):(this.center.equals(e.center)===!0?this.radius=Math.max(this.radius,e.radius):(hc.subVectors(e.center,this.center).setLength(e.radius),this.expandByPoint(ar.copy(e.center).add(hc)),this.expandByPoint(ar.copy(e.center).sub(hc))),this)}equals(e){return e.center.equals(this.center)&&e.radius===this.radius}clone(){return new this.constructor().copy(this)}toJSON(){return{radius:this.radius,center:this.center.toArray()}}fromJSON(e){return this.radius=e.radius,this.center.fromArray(e.center),this}},Rn=new D,uc=new D,wo=new D,$n=new D,dc=new D,Eo=new D,fc=new D,Un=class{constructor(e=new D,t=new D(0,0,-1)){this.origin=e,this.direction=t}set(e,t){return this.origin.copy(e),this.direction.copy(t),this}copy(e){return this.origin.copy(e.origin),this.direction.copy(e.direction),this}at(e,t){return t.copy(this.origin).addScaledVector(this.direction,e)}lookAt(e){return this.direction.copy(e).sub(this.origin).normalize(),this}recast(e){return this.origin.copy(this.at(e,Rn)),this}closestPointToPoint(e,t){t.subVectors(e,this.origin);let n=t.dot(this.direction);return n<0?t.copy(this.origin):t.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(e){return Math.sqrt(this.distanceSqToPoint(e))}distanceSqToPoint(e){let t=Rn.subVectors(e,this.origin).dot(this.direction);return t<0?this.origin.distanceToSquared(e):(Rn.copy(this.origin).addScaledVector(this.direction,t),Rn.distanceToSquared(e))}distanceSqToSegment(e,t,n,s){uc.copy(e).add(t).multiplyScalar(.5),wo.copy(t).sub(e).normalize(),$n.copy(this.origin).sub(uc);let r=e.distanceTo(t)*.5,o=-this.direction.dot(wo),a=$n.dot(this.direction),l=-$n.dot(wo),c=$n.lengthSq(),h=Math.abs(1-o*o),u,p,d,g;if(h>0)if(u=o*l-a,p=o*a-l,g=r*h,u>=0)if(p>=-g)if(p<=g){let _=1/h;u*=_,p*=_,d=u*(u+o*p+2*a)+p*(o*u+p+2*l)+c}else p=r,u=Math.max(0,-(o*p+a)),d=-u*u+p*(p+2*l)+c;else p=-r,u=Math.max(0,-(o*p+a)),d=-u*u+p*(p+2*l)+c;else p<=-g?(u=Math.max(0,-(-o*r+a)),p=u>0?-r:Math.min(Math.max(-r,-l),r),d=-u*u+p*(p+2*l)+c):p<=g?(u=0,p=Math.min(Math.max(-r,-l),r),d=p*(p+2*l)+c):(u=Math.max(0,-(o*r+a)),p=u>0?r:Math.min(Math.max(-r,-l),r),d=-u*u+p*(p+2*l)+c);else p=o>0?-r:r,u=Math.max(0,-(o*p+a)),d=-u*u+p*(p+2*l)+c;return n&&n.copy(this.origin).addScaledVector(this.direction,u),s&&s.copy(uc).addScaledVector(wo,p),d}intersectSphere(e,t){Rn.subVectors(e.center,this.origin);let n=Rn.dot(this.direction),s=Rn.dot(Rn)-n*n,r=e.radius*e.radius;if(s>r)return null;let o=Math.sqrt(r-s),a=n-o,l=n+o;return l<0?null:a<0?this.at(l,t):this.at(a,t)}intersectsSphere(e){return e.radius<0?!1:this.distanceSqToPoint(e.center)<=e.radius*e.radius}distanceToPlane(e){let t=e.normal.dot(this.direction);if(t===0)return e.distanceToPoint(this.origin)===0?0:null;let n=-(this.origin.dot(e.normal)+e.constant)/t;return n>=0?n:null}intersectPlane(e,t){let n=this.distanceToPlane(e);return n===null?null:this.at(n,t)}intersectsPlane(e){let t=e.distanceToPoint(this.origin);return t===0||e.normal.dot(this.direction)*t<0}intersectBox(e,t){let n,s,r,o,a,l,c=1/this.direction.x,h=1/this.direction.y,u=1/this.direction.z,p=this.origin;return c>=0?(n=(e.min.x-p.x)*c,s=(e.max.x-p.x)*c):(n=(e.max.x-p.x)*c,s=(e.min.x-p.x)*c),h>=0?(r=(e.min.y-p.y)*h,o=(e.max.y-p.y)*h):(r=(e.max.y-p.y)*h,o=(e.min.y-p.y)*h),n>o||r>s||((r>n||isNaN(n))&&(n=r),(o<s||isNaN(s))&&(s=o),u>=0?(a=(e.min.z-p.z)*u,l=(e.max.z-p.z)*u):(a=(e.max.z-p.z)*u,l=(e.min.z-p.z)*u),n>l||a>s)||((a>n||n!==n)&&(n=a),(l<s||s!==s)&&(s=l),s<0)?null:this.at(n>=0?n:s,t)}intersectsBox(e){return this.intersectBox(e,Rn)!==null}intersectTriangle(e,t,n,s,r){dc.subVectors(t,e),Eo.subVectors(n,e),fc.crossVectors(dc,Eo);let o=this.direction.dot(fc),a;if(o>0){if(s)return null;a=1}else if(o<0)a=-1,o=-o;else return null;$n.subVectors(this.origin,e);let l=a*this.direction.dot(Eo.crossVectors($n,Eo));if(l<0)return null;let c=a*this.direction.dot(dc.cross($n));if(c<0||l+c>o)return null;let h=-a*$n.dot(fc);return h<0?null:this.at(h/o,r)}applyMatrix4(e){return this.origin.applyMatrix4(e),this.direction.transformDirection(e),this}equals(e){return e.origin.equals(this.origin)&&e.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}},it=class i{constructor(e,t,n,s,r,o,a,l,c,h,u,p,d,g,_,m){i.prototype.isMatrix4=!0,this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],e!==void 0&&this.set(e,t,n,s,r,o,a,l,c,h,u,p,d,g,_,m)}set(e,t,n,s,r,o,a,l,c,h,u,p,d,g,_,m){let f=this.elements;return f[0]=e,f[4]=t,f[8]=n,f[12]=s,f[1]=r,f[5]=o,f[9]=a,f[13]=l,f[2]=c,f[6]=h,f[10]=u,f[14]=p,f[3]=d,f[7]=g,f[11]=_,f[15]=m,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new i().fromArray(this.elements)}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],t[9]=n[9],t[10]=n[10],t[11]=n[11],t[12]=n[12],t[13]=n[13],t[14]=n[14],t[15]=n[15],this}copyPosition(e){let t=this.elements,n=e.elements;return t[12]=n[12],t[13]=n[13],t[14]=n[14],this}setFromMatrix3(e){let t=e.elements;return this.set(t[0],t[3],t[6],0,t[1],t[4],t[7],0,t[2],t[5],t[8],0,0,0,0,1),this}extractBasis(e,t,n){return e.setFromMatrixColumn(this,0),t.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this}makeBasis(e,t,n){return this.set(e.x,t.x,n.x,0,e.y,t.y,n.y,0,e.z,t.z,n.z,0,0,0,0,1),this}extractRotation(e){let t=this.elements,n=e.elements,s=1/rs.setFromMatrixColumn(e,0).length(),r=1/rs.setFromMatrixColumn(e,1).length(),o=1/rs.setFromMatrixColumn(e,2).length();return t[0]=n[0]*s,t[1]=n[1]*s,t[2]=n[2]*s,t[3]=0,t[4]=n[4]*r,t[5]=n[5]*r,t[6]=n[6]*r,t[7]=0,t[8]=n[8]*o,t[9]=n[9]*o,t[10]=n[10]*o,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromEuler(e){let t=this.elements,n=e.x,s=e.y,r=e.z,o=Math.cos(n),a=Math.sin(n),l=Math.cos(s),c=Math.sin(s),h=Math.cos(r),u=Math.sin(r);if(e.order==="XYZ"){let p=o*h,d=o*u,g=a*h,_=a*u;t[0]=l*h,t[4]=-l*u,t[8]=c,t[1]=d+g*c,t[5]=p-_*c,t[9]=-a*l,t[2]=_-p*c,t[6]=g+d*c,t[10]=o*l}else if(e.order==="YXZ"){let p=l*h,d=l*u,g=c*h,_=c*u;t[0]=p+_*a,t[4]=g*a-d,t[8]=o*c,t[1]=o*u,t[5]=o*h,t[9]=-a,t[2]=d*a-g,t[6]=_+p*a,t[10]=o*l}else if(e.order==="ZXY"){let p=l*h,d=l*u,g=c*h,_=c*u;t[0]=p-_*a,t[4]=-o*u,t[8]=g+d*a,t[1]=d+g*a,t[5]=o*h,t[9]=_-p*a,t[2]=-o*c,t[6]=a,t[10]=o*l}else if(e.order==="ZYX"){let p=o*h,d=o*u,g=a*h,_=a*u;t[0]=l*h,t[4]=g*c-d,t[8]=p*c+_,t[1]=l*u,t[5]=_*c+p,t[9]=d*c-g,t[2]=-c,t[6]=a*l,t[10]=o*l}else if(e.order==="YZX"){let p=o*l,d=o*c,g=a*l,_=a*c;t[0]=l*h,t[4]=_-p*u,t[8]=g*u+d,t[1]=u,t[5]=o*h,t[9]=-a*h,t[2]=-c*h,t[6]=d*u+g,t[10]=p-_*u}else if(e.order==="XZY"){let p=o*l,d=o*c,g=a*l,_=a*c;t[0]=l*h,t[4]=-u,t[8]=c*h,t[1]=p*u+_,t[5]=o*h,t[9]=d*u-g,t[2]=g*u-d,t[6]=a*h,t[10]=_*u+p}return t[3]=0,t[7]=0,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromQuaternion(e){return this.compose(Dm,e,Nm)}lookAt(e,t,n){let s=this.elements;return Yt.subVectors(e,t),Yt.lengthSq()===0&&(Yt.z=1),Yt.normalize(),Zn.crossVectors(n,Yt),Zn.lengthSq()===0&&(Math.abs(n.z)===1?Yt.x+=1e-4:Yt.z+=1e-4,Yt.normalize(),Zn.crossVectors(n,Yt)),Zn.normalize(),To.crossVectors(Yt,Zn),s[0]=Zn.x,s[4]=To.x,s[8]=Yt.x,s[1]=Zn.y,s[5]=To.y,s[9]=Yt.y,s[2]=Zn.z,s[6]=To.z,s[10]=Yt.z,this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,s=t.elements,r=this.elements,o=n[0],a=n[4],l=n[8],c=n[12],h=n[1],u=n[5],p=n[9],d=n[13],g=n[2],_=n[6],m=n[10],f=n[14],w=n[3],M=n[7],v=n[11],A=n[15],I=s[0],C=s[4],P=s[8],S=s[12],x=s[1],T=s[5],z=s[9],O=s[13],X=s[2],K=s[6],k=s[10],te=s[14],W=s[3],se=s[7],re=s[11],pe=s[15];return r[0]=o*I+a*x+l*X+c*W,r[4]=o*C+a*T+l*K+c*se,r[8]=o*P+a*z+l*k+c*re,r[12]=o*S+a*O+l*te+c*pe,r[1]=h*I+u*x+p*X+d*W,r[5]=h*C+u*T+p*K+d*se,r[9]=h*P+u*z+p*k+d*re,r[13]=h*S+u*O+p*te+d*pe,r[2]=g*I+_*x+m*X+f*W,r[6]=g*C+_*T+m*K+f*se,r[10]=g*P+_*z+m*k+f*re,r[14]=g*S+_*O+m*te+f*pe,r[3]=w*I+M*x+v*X+A*W,r[7]=w*C+M*T+v*K+A*se,r[11]=w*P+M*z+v*k+A*re,r[15]=w*S+M*O+v*te+A*pe,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[4]*=e,t[8]*=e,t[12]*=e,t[1]*=e,t[5]*=e,t[9]*=e,t[13]*=e,t[2]*=e,t[6]*=e,t[10]*=e,t[14]*=e,t[3]*=e,t[7]*=e,t[11]*=e,t[15]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[4],s=e[8],r=e[12],o=e[1],a=e[5],l=e[9],c=e[13],h=e[2],u=e[6],p=e[10],d=e[14],g=e[3],_=e[7],m=e[11],f=e[15];return g*(+r*l*u-s*c*u-r*a*p+n*c*p+s*a*d-n*l*d)+_*(+t*l*d-t*c*p+r*o*p-s*o*d+s*c*h-r*l*h)+m*(+t*c*u-t*a*d-r*o*u+n*o*d+r*a*h-n*c*h)+f*(-s*a*h-t*l*u+t*a*p+s*o*u-n*o*p+n*l*h)}transpose(){let e=this.elements,t;return t=e[1],e[1]=e[4],e[4]=t,t=e[2],e[2]=e[8],e[8]=t,t=e[6],e[6]=e[9],e[9]=t,t=e[3],e[3]=e[12],e[12]=t,t=e[7],e[7]=e[13],e[13]=t,t=e[11],e[11]=e[14],e[14]=t,this}setPosition(e,t,n){let s=this.elements;return e.isVector3?(s[12]=e.x,s[13]=e.y,s[14]=e.z):(s[12]=e,s[13]=t,s[14]=n),this}invert(){let e=this.elements,t=e[0],n=e[1],s=e[2],r=e[3],o=e[4],a=e[5],l=e[6],c=e[7],h=e[8],u=e[9],p=e[10],d=e[11],g=e[12],_=e[13],m=e[14],f=e[15],w=u*m*c-_*p*c+_*l*d-a*m*d-u*l*f+a*p*f,M=g*p*c-h*m*c-g*l*d+o*m*d+h*l*f-o*p*f,v=h*_*c-g*u*c+g*a*d-o*_*d-h*a*f+o*u*f,A=g*u*l-h*_*l-g*a*p+o*_*p+h*a*m-o*u*m,I=t*w+n*M+s*v+r*A;if(I===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let C=1/I;return e[0]=w*C,e[1]=(_*p*r-u*m*r-_*s*d+n*m*d+u*s*f-n*p*f)*C,e[2]=(a*m*r-_*l*r+_*s*c-n*m*c-a*s*f+n*l*f)*C,e[3]=(u*l*r-a*p*r-u*s*c+n*p*c+a*s*d-n*l*d)*C,e[4]=M*C,e[5]=(h*m*r-g*p*r+g*s*d-t*m*d-h*s*f+t*p*f)*C,e[6]=(g*l*r-o*m*r-g*s*c+t*m*c+o*s*f-t*l*f)*C,e[7]=(o*p*r-h*l*r+h*s*c-t*p*c-o*s*d+t*l*d)*C,e[8]=v*C,e[9]=(g*u*r-h*_*r-g*n*d+t*_*d+h*n*f-t*u*f)*C,e[10]=(o*_*r-g*a*r+g*n*c-t*_*c-o*n*f+t*a*f)*C,e[11]=(h*a*r-o*u*r-h*n*c+t*u*c+o*n*d-t*a*d)*C,e[12]=A*C,e[13]=(h*_*s-g*u*s+g*n*p-t*_*p-h*n*m+t*u*m)*C,e[14]=(g*a*s-o*_*s-g*n*l+t*_*l+o*n*m-t*a*m)*C,e[15]=(o*u*s-h*a*s+h*n*l-t*u*l-o*n*p+t*a*p)*C,this}scale(e){let t=this.elements,n=e.x,s=e.y,r=e.z;return t[0]*=n,t[4]*=s,t[8]*=r,t[1]*=n,t[5]*=s,t[9]*=r,t[2]*=n,t[6]*=s,t[10]*=r,t[3]*=n,t[7]*=s,t[11]*=r,this}getMaxScaleOnAxis(){let e=this.elements,t=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],n=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],s=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];return Math.sqrt(Math.max(t,n,s))}makeTranslation(e,t,n){return e.isVector3?this.set(1,0,0,e.x,0,1,0,e.y,0,0,1,e.z,0,0,0,1):this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1),this}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1),this}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1),this}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(e,t){let n=Math.cos(t),s=Math.sin(t),r=1-n,o=e.x,a=e.y,l=e.z,c=r*o,h=r*a;return this.set(c*o+n,c*a-s*l,c*l+s*a,0,c*a+s*l,h*a+n,h*l-s*o,0,c*l-s*a,h*l+s*o,r*l*l+n,0,0,0,0,1),this}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1),this}makeShear(e,t,n,s,r,o){return this.set(1,n,r,0,e,1,o,0,t,s,1,0,0,0,0,1),this}compose(e,t,n){let s=this.elements,r=t._x,o=t._y,a=t._z,l=t._w,c=r+r,h=o+o,u=a+a,p=r*c,d=r*h,g=r*u,_=o*h,m=o*u,f=a*u,w=l*c,M=l*h,v=l*u,A=n.x,I=n.y,C=n.z;return s[0]=(1-(_+f))*A,s[1]=(d+v)*A,s[2]=(g-M)*A,s[3]=0,s[4]=(d-v)*I,s[5]=(1-(p+f))*I,s[6]=(m+w)*I,s[7]=0,s[8]=(g+M)*C,s[9]=(m-w)*C,s[10]=(1-(p+_))*C,s[11]=0,s[12]=e.x,s[13]=e.y,s[14]=e.z,s[15]=1,this}decompose(e,t,n){let s=this.elements,r=rs.set(s[0],s[1],s[2]).length(),o=rs.set(s[4],s[5],s[6]).length(),a=rs.set(s[8],s[9],s[10]).length();this.determinant()<0&&(r=-r),e.x=s[12],e.y=s[13],e.z=s[14],dn.copy(this);let c=1/r,h=1/o,u=1/a;return dn.elements[0]*=c,dn.elements[1]*=c,dn.elements[2]*=c,dn.elements[4]*=h,dn.elements[5]*=h,dn.elements[6]*=h,dn.elements[8]*=u,dn.elements[9]*=u,dn.elements[10]*=u,t.setFromRotationMatrix(dn),n.x=r,n.y=o,n.z=a,this}makePerspective(e,t,n,s,r,o,a=yn){let l=this.elements,c=2*r/(t-e),h=2*r/(n-s),u=(t+e)/(t-e),p=(n+s)/(n-s),d,g;if(a===yn)d=-(o+r)/(o-r),g=-2*o*r/(o-r);else if(a===yr)d=-o/(o-r),g=-o*r/(o-r);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+a);return l[0]=c,l[4]=0,l[8]=u,l[12]=0,l[1]=0,l[5]=h,l[9]=p,l[13]=0,l[2]=0,l[6]=0,l[10]=d,l[14]=g,l[3]=0,l[7]=0,l[11]=-1,l[15]=0,this}makeOrthographic(e,t,n,s,r,o,a=yn){let l=this.elements,c=1/(t-e),h=1/(n-s),u=1/(o-r),p=(t+e)*c,d=(n+s)*h,g,_;if(a===yn)g=(o+r)*u,_=-2*u;else if(a===yr)g=r*u,_=-1*u;else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+a);return l[0]=2*c,l[4]=0,l[8]=0,l[12]=-p,l[1]=0,l[5]=2*h,l[9]=0,l[13]=-d,l[2]=0,l[6]=0,l[10]=_,l[14]=-g,l[3]=0,l[7]=0,l[11]=0,l[15]=1,this}equals(e){let t=this.elements,n=e.elements;for(let s=0;s<16;s++)if(t[s]!==n[s])return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e[t+9]=n[9],e[t+10]=n[10],e[t+11]=n[11],e[t+12]=n[12],e[t+13]=n[13],e[t+14]=n[14],e[t+15]=n[15],e}},rs=new D,dn=new it,Dm=new D(0,0,0),Nm=new D(1,1,1),Zn=new D,To=new D,Yt=new D,qu=new it,Yu=new sn,on=class i{constructor(e=0,t=0,n=0,s=i.DEFAULT_ORDER){this.isEuler=!0,this._x=e,this._y=t,this._z=n,this._order=s}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get order(){return this._order}set order(e){this._order=e,this._onChangeCallback()}set(e,t,n,s=this._order){return this._x=e,this._y=t,this._z=n,this._order=s,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(e){return this._x=e._x,this._y=e._y,this._z=e._z,this._order=e._order,this._onChangeCallback(),this}setFromRotationMatrix(e,t=this._order,n=!0){let s=e.elements,r=s[0],o=s[4],a=s[8],l=s[1],c=s[5],h=s[9],u=s[2],p=s[6],d=s[10];switch(t){case"XYZ":this._y=Math.asin(ze(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(-h,d),this._z=Math.atan2(-o,r)):(this._x=Math.atan2(p,c),this._z=0);break;case"YXZ":this._x=Math.asin(-ze(h,-1,1)),Math.abs(h)<.9999999?(this._y=Math.atan2(a,d),this._z=Math.atan2(l,c)):(this._y=Math.atan2(-u,r),this._z=0);break;case"ZXY":this._x=Math.asin(ze(p,-1,1)),Math.abs(p)<.9999999?(this._y=Math.atan2(-u,d),this._z=Math.atan2(-o,c)):(this._y=0,this._z=Math.atan2(l,r));break;case"ZYX":this._y=Math.asin(-ze(u,-1,1)),Math.abs(u)<.9999999?(this._x=Math.atan2(p,d),this._z=Math.atan2(l,r)):(this._x=0,this._z=Math.atan2(-o,c));break;case"YZX":this._z=Math.asin(ze(l,-1,1)),Math.abs(l)<.9999999?(this._x=Math.atan2(-h,c),this._y=Math.atan2(-u,r)):(this._x=0,this._y=Math.atan2(a,d));break;case"XZY":this._z=Math.asin(-ze(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(p,c),this._y=Math.atan2(a,r)):(this._x=Math.atan2(-h,d),this._y=0);break;default:console.warn("THREE.Euler: .setFromRotationMatrix() encountered an unknown order: "+t)}return this._order=t,n===!0&&this._onChangeCallback(),this}setFromQuaternion(e,t,n){return qu.makeRotationFromQuaternion(e),this.setFromRotationMatrix(qu,t,n)}setFromVector3(e,t=this._order){return this.set(e.x,e.y,e.z,t)}reorder(e){return Yu.setFromEuler(this),this.setFromQuaternion(Yu,e)}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._order===this._order}fromArray(e){return this._x=e[0],this._y=e[1],this._z=e[2],e[3]!==void 0&&(this._order=e[3]),this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._order,e}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}};on.DEFAULT_ORDER="XYZ";xs=class{constructor(){this.mask=1}set(e){this.mask=(1<<e|0)>>>0}enable(e){this.mask|=1<<e|0}enableAll(){this.mask=-1}toggle(e){this.mask^=1<<e|0}disable(e){this.mask&=~(1<<e|0)}disableAll(){this.mask=0}test(e){return(this.mask&e.mask)!==0}isEnabled(e){return(this.mask&(1<<e|0))!==0}},Um=0,$u=new D,os=new sn,In=new it,Ao=new D,lr=new D,Fm=new D,Om=new sn,Zu=new D(1,0,0),ju=new D(0,1,0),Ku=new D(0,0,1),Ju={type:"added"},Bm={type:"removed"},as={type:"childadded",child:null},pc={type:"childremoved",child:null},wt=class i extends xn{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:Um++}),this.uuid=Bi(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=i.DEFAULT_UP.clone();let e=new D,t=new on,n=new sn,s=new D(1,1,1);function r(){n.setFromEuler(t,!1)}function o(){t.setFromQuaternion(n,void 0,!1)}t._onChange(r),n._onChange(o),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:e},rotation:{configurable:!0,enumerable:!0,value:t},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:s},modelViewMatrix:{value:new it},normalMatrix:{value:new Be}}),this.matrix=new it,this.matrixWorld=new it,this.matrixAutoUpdate=i.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=i.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new xs,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.customDepthMaterial=void 0,this.customDistanceMaterial=void 0,this.userData={}}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(e){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(e),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(e){return this.quaternion.premultiply(e),this}setRotationFromAxisAngle(e,t){this.quaternion.setFromAxisAngle(e,t)}setRotationFromEuler(e){this.quaternion.setFromEuler(e,!0)}setRotationFromMatrix(e){this.quaternion.setFromRotationMatrix(e)}setRotationFromQuaternion(e){this.quaternion.copy(e)}rotateOnAxis(e,t){return os.setFromAxisAngle(e,t),this.quaternion.multiply(os),this}rotateOnWorldAxis(e,t){return os.setFromAxisAngle(e,t),this.quaternion.premultiply(os),this}rotateX(e){return this.rotateOnAxis(Zu,e)}rotateY(e){return this.rotateOnAxis(ju,e)}rotateZ(e){return this.rotateOnAxis(Ku,e)}translateOnAxis(e,t){return $u.copy(e).applyQuaternion(this.quaternion),this.position.add($u.multiplyScalar(t)),this}translateX(e){return this.translateOnAxis(Zu,e)}translateY(e){return this.translateOnAxis(ju,e)}translateZ(e){return this.translateOnAxis(Ku,e)}localToWorld(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(this.matrixWorld)}worldToLocal(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(In.copy(this.matrixWorld).invert())}lookAt(e,t,n){e.isVector3?Ao.copy(e):Ao.set(e,t,n);let s=this.parent;this.updateWorldMatrix(!0,!1),lr.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?In.lookAt(lr,Ao,this.up):In.lookAt(Ao,lr,this.up),this.quaternion.setFromRotationMatrix(In),s&&(In.extractRotation(s.matrixWorld),os.setFromRotationMatrix(In),this.quaternion.premultiply(os.invert()))}add(e){if(arguments.length>1){for(let t=0;t<arguments.length;t++)this.add(arguments[t]);return this}return e===this?(console.error("THREE.Object3D.add: object can't be added as a child of itself.",e),this):(e&&e.isObject3D?(e.removeFromParent(),e.parent=this,this.children.push(e),e.dispatchEvent(Ju),as.child=e,this.dispatchEvent(as),as.child=null):console.error("THREE.Object3D.add: object not an instance of THREE.Object3D.",e),this)}remove(e){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let t=this.children.indexOf(e);return t!==-1&&(e.parent=null,this.children.splice(t,1),e.dispatchEvent(Bm),pc.child=e,this.dispatchEvent(pc),pc.child=null),this}removeFromParent(){let e=this.parent;return e!==null&&e.remove(this),this}clear(){return this.remove(...this.children)}attach(e){return this.updateWorldMatrix(!0,!1),In.copy(this.matrixWorld).invert(),e.parent!==null&&(e.parent.updateWorldMatrix(!0,!1),In.multiply(e.parent.matrixWorld)),e.applyMatrix4(In),e.removeFromParent(),e.parent=this,this.children.push(e),e.updateWorldMatrix(!1,!0),e.dispatchEvent(Ju),as.child=e,this.dispatchEvent(as),as.child=null,this}getObjectById(e){return this.getObjectByProperty("id",e)}getObjectByName(e){return this.getObjectByProperty("name",e)}getObjectByProperty(e,t){if(this[e]===t)return this;for(let n=0,s=this.children.length;n<s;n++){let o=this.children[n].getObjectByProperty(e,t);if(o!==void 0)return o}}getObjectsByProperty(e,t,n=[]){this[e]===t&&n.push(this);let s=this.children;for(let r=0,o=s.length;r<o;r++)s[r].getObjectsByProperty(e,t,n);return n}getWorldPosition(e){return this.updateWorldMatrix(!0,!1),e.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(lr,e,Fm),e}getWorldScale(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(lr,Om,e),e}getWorldDirection(e){this.updateWorldMatrix(!0,!1);let t=this.matrixWorld.elements;return e.set(t[8],t[9],t[10]).normalize()}raycast(){}traverse(e){e(this);let t=this.children;for(let n=0,s=t.length;n<s;n++)t[n].traverse(e)}traverseVisible(e){if(this.visible===!1)return;e(this);let t=this.children;for(let n=0,s=t.length;n<s;n++)t[n].traverseVisible(e)}traverseAncestors(e){let t=this.parent;t!==null&&(e(t),t.traverseAncestors(e))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale),this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(e){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||e)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,e=!0);let t=this.children;for(let n=0,s=t.length;n<s;n++)t[n].updateMatrixWorld(e)}updateWorldMatrix(e,t){let n=this.parent;if(e===!0&&n!==null&&n.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),t===!0){let s=this.children;for(let r=0,o=s.length;r<o;r++)s[r].updateWorldMatrix(!1,!0)}}toJSON(e){let t=e===void 0||typeof e=="string",n={};t&&(e={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.7,type:"Object",generator:"Object3D.toJSON"});let s={};s.uuid=this.uuid,s.type=this.type,this.name!==""&&(s.name=this.name),this.castShadow===!0&&(s.castShadow=!0),this.receiveShadow===!0&&(s.receiveShadow=!0),this.visible===!1&&(s.visible=!1),this.frustumCulled===!1&&(s.frustumCulled=!1),this.renderOrder!==0&&(s.renderOrder=this.renderOrder),Object.keys(this.userData).length>0&&(s.userData=this.userData),s.layers=this.layers.mask,s.matrix=this.matrix.toArray(),s.up=this.up.toArray(),this.matrixAutoUpdate===!1&&(s.matrixAutoUpdate=!1),this.isInstancedMesh&&(s.type="InstancedMesh",s.count=this.count,s.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(s.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(s.type="BatchedMesh",s.perObjectFrustumCulled=this.perObjectFrustumCulled,s.sortObjects=this.sortObjects,s.drawRanges=this._drawRanges,s.reservedRanges=this._reservedRanges,s.geometryInfo=this._geometryInfo.map(a=>({...a,boundingBox:a.boundingBox?a.boundingBox.toJSON():void 0,boundingSphere:a.boundingSphere?a.boundingSphere.toJSON():void 0})),s.instanceInfo=this._instanceInfo.map(a=>({...a})),s.availableInstanceIds=this._availableInstanceIds.slice(),s.availableGeometryIds=this._availableGeometryIds.slice(),s.nextIndexStart=this._nextIndexStart,s.nextVertexStart=this._nextVertexStart,s.geometryCount=this._geometryCount,s.maxInstanceCount=this._maxInstanceCount,s.maxVertexCount=this._maxVertexCount,s.maxIndexCount=this._maxIndexCount,s.geometryInitialized=this._geometryInitialized,s.matricesTexture=this._matricesTexture.toJSON(e),s.indirectTexture=this._indirectTexture.toJSON(e),this._colorsTexture!==null&&(s.colorsTexture=this._colorsTexture.toJSON(e)),this.boundingSphere!==null&&(s.boundingSphere=this.boundingSphere.toJSON()),this.boundingBox!==null&&(s.boundingBox=this.boundingBox.toJSON()));function r(a,l){return a[l.uuid]===void 0&&(a[l.uuid]=l.toJSON(e)),l.uuid}if(this.isScene)this.background&&(this.background.isColor?s.background=this.background.toJSON():this.background.isTexture&&(s.background=this.background.toJSON(e).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(s.environment=this.environment.toJSON(e).uuid);else if(this.isMesh||this.isLine||this.isPoints){s.geometry=r(e.geometries,this.geometry);let a=this.geometry.parameters;if(a!==void 0&&a.shapes!==void 0){let l=a.shapes;if(Array.isArray(l))for(let c=0,h=l.length;c<h;c++){let u=l[c];r(e.shapes,u)}else r(e.shapes,l)}}if(this.isSkinnedMesh&&(s.bindMode=this.bindMode,s.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(r(e.skeletons,this.skeleton),s.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){let a=[];for(let l=0,c=this.material.length;l<c;l++)a.push(r(e.materials,this.material[l]));s.material=a}else s.material=r(e.materials,this.material);if(this.children.length>0){s.children=[];for(let a=0;a<this.children.length;a++)s.children.push(this.children[a].toJSON(e).object)}if(this.animations.length>0){s.animations=[];for(let a=0;a<this.animations.length;a++){let l=this.animations[a];s.animations.push(r(e.animations,l))}}if(t){let a=o(e.geometries),l=o(e.materials),c=o(e.textures),h=o(e.images),u=o(e.shapes),p=o(e.skeletons),d=o(e.animations),g=o(e.nodes);a.length>0&&(n.geometries=a),l.length>0&&(n.materials=l),c.length>0&&(n.textures=c),h.length>0&&(n.images=h),u.length>0&&(n.shapes=u),p.length>0&&(n.skeletons=p),d.length>0&&(n.animations=d),g.length>0&&(n.nodes=g)}return n.object=s,n;function o(a){let l=[];for(let c in a){let h=a[c];delete h.metadata,l.push(h)}return l}}clone(e){return new this.constructor().copy(this,e)}copy(e,t=!0){if(this.name=e.name,this.up.copy(e.up),this.position.copy(e.position),this.rotation.order=e.rotation.order,this.quaternion.copy(e.quaternion),this.scale.copy(e.scale),this.matrix.copy(e.matrix),this.matrixWorld.copy(e.matrixWorld),this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrixWorldAutoUpdate=e.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=e.matrixWorldNeedsUpdate,this.layers.mask=e.layers.mask,this.visible=e.visible,this.castShadow=e.castShadow,this.receiveShadow=e.receiveShadow,this.frustumCulled=e.frustumCulled,this.renderOrder=e.renderOrder,this.animations=e.animations.slice(),this.userData=JSON.parse(JSON.stringify(e.userData)),t===!0)for(let n=0;n<e.children.length;n++){let s=e.children[n];this.add(s.clone())}return this}};wt.DEFAULT_UP=new D(0,1,0);wt.DEFAULT_MATRIX_AUTO_UPDATE=!0;wt.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;fn=new D,Pn=new D,mc=new D,Ln=new D,ls=new D,cs=new D,Qu=new D,gc=new D,_c=new D,yc=new D,xc=new pt,vc=new pt,Mc=new pt,Jn=class i{constructor(e=new D,t=new D,n=new D){this.a=e,this.b=t,this.c=n}static getNormal(e,t,n,s){s.subVectors(n,t),fn.subVectors(e,t),s.cross(fn);let r=s.lengthSq();return r>0?s.multiplyScalar(1/Math.sqrt(r)):s.set(0,0,0)}static getBarycoord(e,t,n,s,r){fn.subVectors(s,t),Pn.subVectors(n,t),mc.subVectors(e,t);let o=fn.dot(fn),a=fn.dot(Pn),l=fn.dot(mc),c=Pn.dot(Pn),h=Pn.dot(mc),u=o*c-a*a;if(u===0)return r.set(0,0,0),null;let p=1/u,d=(c*l-a*h)*p,g=(o*h-a*l)*p;return r.set(1-d-g,g,d)}static containsPoint(e,t,n,s){return this.getBarycoord(e,t,n,s,Ln)===null?!1:Ln.x>=0&&Ln.y>=0&&Ln.x+Ln.y<=1}static getInterpolation(e,t,n,s,r,o,a,l){return this.getBarycoord(e,t,n,s,Ln)===null?(l.x=0,l.y=0,"z"in l&&(l.z=0),"w"in l&&(l.w=0),null):(l.setScalar(0),l.addScaledVector(r,Ln.x),l.addScaledVector(o,Ln.y),l.addScaledVector(a,Ln.z),l)}static getInterpolatedAttribute(e,t,n,s,r,o){return xc.setScalar(0),vc.setScalar(0),Mc.setScalar(0),xc.fromBufferAttribute(e,t),vc.fromBufferAttribute(e,n),Mc.fromBufferAttribute(e,s),o.setScalar(0),o.addScaledVector(xc,r.x),o.addScaledVector(vc,r.y),o.addScaledVector(Mc,r.z),o}static isFrontFacing(e,t,n,s){return fn.subVectors(n,t),Pn.subVectors(e,t),fn.cross(Pn).dot(s)<0}set(e,t,n){return this.a.copy(e),this.b.copy(t),this.c.copy(n),this}setFromPointsAndIndices(e,t,n,s){return this.a.copy(e[t]),this.b.copy(e[n]),this.c.copy(e[s]),this}setFromAttributeAndIndices(e,t,n,s){return this.a.fromBufferAttribute(e,t),this.b.fromBufferAttribute(e,n),this.c.fromBufferAttribute(e,s),this}clone(){return new this.constructor().copy(this)}copy(e){return this.a.copy(e.a),this.b.copy(e.b),this.c.copy(e.c),this}getArea(){return fn.subVectors(this.c,this.b),Pn.subVectors(this.a,this.b),fn.cross(Pn).length()*.5}getMidpoint(e){return e.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(e){return i.getNormal(this.a,this.b,this.c,e)}getPlane(e){return e.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(e,t){return i.getBarycoord(e,this.a,this.b,this.c,t)}getInterpolation(e,t,n,s,r){return i.getInterpolation(e,this.a,this.b,this.c,t,n,s,r)}containsPoint(e){return i.containsPoint(e,this.a,this.b,this.c)}isFrontFacing(e){return i.isFrontFacing(this.a,this.b,this.c,e)}intersectsBox(e){return e.intersectsTriangle(this)}closestPointToPoint(e,t){let n=this.a,s=this.b,r=this.c,o,a;ls.subVectors(s,n),cs.subVectors(r,n),gc.subVectors(e,n);let l=ls.dot(gc),c=cs.dot(gc);if(l<=0&&c<=0)return t.copy(n);_c.subVectors(e,s);let h=ls.dot(_c),u=cs.dot(_c);if(h>=0&&u<=h)return t.copy(s);let p=l*u-h*c;if(p<=0&&l>=0&&h<=0)return o=l/(l-h),t.copy(n).addScaledVector(ls,o);yc.subVectors(e,r);let d=ls.dot(yc),g=cs.dot(yc);if(g>=0&&d<=g)return t.copy(r);let _=d*c-l*g;if(_<=0&&c>=0&&g<=0)return a=c/(c-g),t.copy(n).addScaledVector(cs,a);let m=h*g-d*u;if(m<=0&&u-h>=0&&d-g>=0)return Qu.subVectors(r,s),a=(u-h)/(u-h+(d-g)),t.copy(s).addScaledVector(Qu,a);let f=1/(m+_+p);return o=_*f,a=p*f,t.copy(n).addScaledVector(ls,o).addScaledVector(cs,a)}equals(e){return e.a.equals(this.a)&&e.b.equals(this.b)&&e.c.equals(this.c)}},df={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},jn={h:0,s:0,l:0},Co={h:0,s:0,l:0};Ne=class{constructor(e,t,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(e,t,n)}set(e,t,n){if(t===void 0&&n===void 0){let s=e;s&&s.isColor?this.copy(s):typeof s=="number"?this.setHex(s):typeof s=="string"&&this.setStyle(s)}else this.setRGB(e,t,n);return this}setScalar(e){return this.r=e,this.g=e,this.b=e,this}setHex(e,t=xt){return e=Math.floor(e),this.r=(e>>16&255)/255,this.g=(e>>8&255)/255,this.b=(e&255)/255,Ye.colorSpaceToWorking(this,t),this}setRGB(e,t,n,s=Ye.workingColorSpace){return this.r=e,this.g=t,this.b=n,Ye.colorSpaceToWorking(this,s),this}setHSL(e,t,n,s=Ye.workingColorSpace){if(e=oh(e,1),t=ze(t,0,1),n=ze(n,0,1),t===0)this.r=this.g=this.b=n;else{let r=n<=.5?n*(1+t):n+t-n*t,o=2*n-r;this.r=bc(o,r,e+1/3),this.g=bc(o,r,e),this.b=bc(o,r,e-1/3)}return Ye.colorSpaceToWorking(this,s),this}setStyle(e,t=xt){function n(r){r!==void 0&&parseFloat(r)<1&&console.warn("THREE.Color: Alpha component of "+e+" will be ignored.")}let s;if(s=/^(\w+)\(([^\)]*)\)/.exec(e)){let r,o=s[1],a=s[2];switch(o){case"rgb":case"rgba":if(r=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setRGB(Math.min(255,parseInt(r[1],10))/255,Math.min(255,parseInt(r[2],10))/255,Math.min(255,parseInt(r[3],10))/255,t);if(r=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setRGB(Math.min(100,parseInt(r[1],10))/100,Math.min(100,parseInt(r[2],10))/100,Math.min(100,parseInt(r[3],10))/100,t);break;case"hsl":case"hsla":if(r=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(r[4]),this.setHSL(parseFloat(r[1])/360,parseFloat(r[2])/100,parseFloat(r[3])/100,t);break;default:console.warn("THREE.Color: Unknown color model "+e)}}else if(s=/^\#([A-Fa-f\d]+)$/.exec(e)){let r=s[1],o=r.length;if(o===3)return this.setRGB(parseInt(r.charAt(0),16)/15,parseInt(r.charAt(1),16)/15,parseInt(r.charAt(2),16)/15,t);if(o===6)return this.setHex(parseInt(r,16),t);console.warn("THREE.Color: Invalid hex color "+e)}else if(e&&e.length>0)return this.setColorName(e,t);return this}setColorName(e,t=xt){let n=df[e.toLowerCase()];return n!==void 0?this.setHex(n,t):console.warn("THREE.Color: Unknown color "+e),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(e){return this.r=e.r,this.g=e.g,this.b=e.b,this}copySRGBToLinear(e){return this.r=Dn(e.r),this.g=Dn(e.g),this.b=Dn(e.b),this}copyLinearToSRGB(e){return this.r=ps(e.r),this.g=ps(e.g),this.b=ps(e.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(e=xt){return Ye.workingToColorSpace(At.copy(this),e),Math.round(ze(At.r*255,0,255))*65536+Math.round(ze(At.g*255,0,255))*256+Math.round(ze(At.b*255,0,255))}getHexString(e=xt){return("000000"+this.getHex(e).toString(16)).slice(-6)}getHSL(e,t=Ye.workingColorSpace){Ye.workingToColorSpace(At.copy(this),t);let n=At.r,s=At.g,r=At.b,o=Math.max(n,s,r),a=Math.min(n,s,r),l,c,h=(a+o)/2;if(a===o)l=0,c=0;else{let u=o-a;switch(c=h<=.5?u/(o+a):u/(2-o-a),o){case n:l=(s-r)/u+(s<r?6:0);break;case s:l=(r-n)/u+2;break;case r:l=(n-s)/u+4;break}l/=6}return e.h=l,e.s=c,e.l=h,e}getRGB(e,t=Ye.workingColorSpace){return Ye.workingToColorSpace(At.copy(this),t),e.r=At.r,e.g=At.g,e.b=At.b,e}getStyle(e=xt){Ye.workingToColorSpace(At.copy(this),e);let t=At.r,n=At.g,s=At.b;return e!==xt?`color(${e} ${t.toFixed(3)} ${n.toFixed(3)} ${s.toFixed(3)})`:`rgb(${Math.round(t*255)},${Math.round(n*255)},${Math.round(s*255)})`}offsetHSL(e,t,n){return this.getHSL(jn),this.setHSL(jn.h+e,jn.s+t,jn.l+n)}add(e){return this.r+=e.r,this.g+=e.g,this.b+=e.b,this}addColors(e,t){return this.r=e.r+t.r,this.g=e.g+t.g,this.b=e.b+t.b,this}addScalar(e){return this.r+=e,this.g+=e,this.b+=e,this}sub(e){return this.r=Math.max(0,this.r-e.r),this.g=Math.max(0,this.g-e.g),this.b=Math.max(0,this.b-e.b),this}multiply(e){return this.r*=e.r,this.g*=e.g,this.b*=e.b,this}multiplyScalar(e){return this.r*=e,this.g*=e,this.b*=e,this}lerp(e,t){return this.r+=(e.r-this.r)*t,this.g+=(e.g-this.g)*t,this.b+=(e.b-this.b)*t,this}lerpColors(e,t,n){return this.r=e.r+(t.r-e.r)*n,this.g=e.g+(t.g-e.g)*n,this.b=e.b+(t.b-e.b)*n,this}lerpHSL(e,t){this.getHSL(jn),e.getHSL(Co);let n=fr(jn.h,Co.h,t),s=fr(jn.s,Co.s,t),r=fr(jn.l,Co.l,t);return this.setHSL(n,s,r),this}setFromVector3(e){return this.r=e.x,this.g=e.y,this.b=e.z,this}applyMatrix3(e){let t=this.r,n=this.g,s=this.b,r=e.elements;return this.r=r[0]*t+r[3]*n+r[6]*s,this.g=r[1]*t+r[4]*n+r[7]*s,this.b=r[2]*t+r[5]*n+r[8]*s,this}equals(e){return e.r===this.r&&e.g===this.g&&e.b===this.b}fromArray(e,t=0){return this.r=e[t],this.g=e[t+1],this.b=e[t+2],this}toArray(e=[],t=0){return e[t]=this.r,e[t+1]=this.g,e[t+2]=this.b,e}fromBufferAttribute(e,t){return this.r=e.getX(t),this.g=e.getY(t),this.b=e.getZ(t),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}},At=new Ne;Ne.NAMES=df;km=0,pn=class extends xn{constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:km++}),this.uuid=Bi(),this.name="",this.type="Material",this.blending=Ci,this.side=Nn,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=Yo,this.blendDst=$o,this.blendEquation=ei,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new Ne(0,0,0),this.blendAlpha=0,this.depthFunc=Ri,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=Nc,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=Ai,this.stencilZFail=Ai,this.stencilZPass=Ai,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.allowOverride=!0,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(e){this._alphaTest>0!=e>0&&this.version++,this._alphaTest=e}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(e){if(e!==void 0)for(let t in e){let n=e[t];if(n===void 0){console.warn(`THREE.Material: parameter '${t}' has value of undefined.`);continue}let s=this[t];if(s===void 0){console.warn(`THREE.Material: '${t}' is not a property of THREE.${this.type}.`);continue}s&&s.isColor?s.set(n):s&&s.isVector3&&n&&n.isVector3?s.copy(n):this[t]=n}}toJSON(e){let t=e===void 0||typeof e=="string";t&&(e={textures:{},images:{}});let n={metadata:{version:4.7,type:"Material",generator:"Material.toJSON"}};n.uuid=this.uuid,n.type=this.type,this.name!==""&&(n.name=this.name),this.color&&this.color.isColor&&(n.color=this.color.getHex()),this.roughness!==void 0&&(n.roughness=this.roughness),this.metalness!==void 0&&(n.metalness=this.metalness),this.sheen!==void 0&&(n.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(n.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(n.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(n.emissive=this.emissive.getHex()),this.emissiveIntensity!==void 0&&this.emissiveIntensity!==1&&(n.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(n.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(n.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(n.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(n.shininess=this.shininess),this.clearcoat!==void 0&&(n.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(n.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(n.clearcoatMap=this.clearcoatMap.toJSON(e).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(e).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(e).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.dispersion!==void 0&&(n.dispersion=this.dispersion),this.iridescence!==void 0&&(n.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(n.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(n.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(n.iridescenceMap=this.iridescenceMap.toJSON(e).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(e).uuid),this.anisotropy!==void 0&&(n.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(n.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(n.anisotropyMap=this.anisotropyMap.toJSON(e).uuid),this.map&&this.map.isTexture&&(n.map=this.map.toJSON(e).uuid),this.matcap&&this.matcap.isTexture&&(n.matcap=this.matcap.toJSON(e).uuid),this.alphaMap&&this.alphaMap.isTexture&&(n.alphaMap=this.alphaMap.toJSON(e).uuid),this.lightMap&&this.lightMap.isTexture&&(n.lightMap=this.lightMap.toJSON(e).uuid,n.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(n.aoMap=this.aoMap.toJSON(e).uuid,n.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(n.bumpMap=this.bumpMap.toJSON(e).uuid,n.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(n.normalMap=this.normalMap.toJSON(e).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(n.displacementMap=this.displacementMap.toJSON(e).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(n.roughnessMap=this.roughnessMap.toJSON(e).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(n.metalnessMap=this.metalnessMap.toJSON(e).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(n.emissiveMap=this.emissiveMap.toJSON(e).uuid),this.specularMap&&this.specularMap.isTexture&&(n.specularMap=this.specularMap.toJSON(e).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(n.specularIntensityMap=this.specularIntensityMap.toJSON(e).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(n.specularColorMap=this.specularColorMap.toJSON(e).uuid),this.envMap&&this.envMap.isTexture&&(n.envMap=this.envMap.toJSON(e).uuid,this.combine!==void 0&&(n.combine=this.combine)),this.envMapRotation!==void 0&&(n.envMapRotation=this.envMapRotation.toArray()),this.envMapIntensity!==void 0&&(n.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(n.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(n.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(n.gradientMap=this.gradientMap.toJSON(e).uuid),this.transmission!==void 0&&(n.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(n.transmissionMap=this.transmissionMap.toJSON(e).uuid),this.thickness!==void 0&&(n.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(n.thicknessMap=this.thicknessMap.toJSON(e).uuid),this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0&&(n.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(n.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(n.size=this.size),this.shadowSide!==null&&(n.shadowSide=this.shadowSide),this.sizeAttenuation!==void 0&&(n.sizeAttenuation=this.sizeAttenuation),this.blending!==Ci&&(n.blending=this.blending),this.side!==Nn&&(n.side=this.side),this.vertexColors===!0&&(n.vertexColors=!0),this.opacity<1&&(n.opacity=this.opacity),this.transparent===!0&&(n.transparent=!0),this.blendSrc!==Yo&&(n.blendSrc=this.blendSrc),this.blendDst!==$o&&(n.blendDst=this.blendDst),this.blendEquation!==ei&&(n.blendEquation=this.blendEquation),this.blendSrcAlpha!==null&&(n.blendSrcAlpha=this.blendSrcAlpha),this.blendDstAlpha!==null&&(n.blendDstAlpha=this.blendDstAlpha),this.blendEquationAlpha!==null&&(n.blendEquationAlpha=this.blendEquationAlpha),this.blendColor&&this.blendColor.isColor&&(n.blendColor=this.blendColor.getHex()),this.blendAlpha!==0&&(n.blendAlpha=this.blendAlpha),this.depthFunc!==Ri&&(n.depthFunc=this.depthFunc),this.depthTest===!1&&(n.depthTest=this.depthTest),this.depthWrite===!1&&(n.depthWrite=this.depthWrite),this.colorWrite===!1&&(n.colorWrite=this.colorWrite),this.stencilWriteMask!==255&&(n.stencilWriteMask=this.stencilWriteMask),this.stencilFunc!==Nc&&(n.stencilFunc=this.stencilFunc),this.stencilRef!==0&&(n.stencilRef=this.stencilRef),this.stencilFuncMask!==255&&(n.stencilFuncMask=this.stencilFuncMask),this.stencilFail!==Ai&&(n.stencilFail=this.stencilFail),this.stencilZFail!==Ai&&(n.stencilZFail=this.stencilZFail),this.stencilZPass!==Ai&&(n.stencilZPass=this.stencilZPass),this.stencilWrite===!0&&(n.stencilWrite=this.stencilWrite),this.rotation!==void 0&&this.rotation!==0&&(n.rotation=this.rotation),this.polygonOffset===!0&&(n.polygonOffset=!0),this.polygonOffsetFactor!==0&&(n.polygonOffsetFactor=this.polygonOffsetFactor),this.polygonOffsetUnits!==0&&(n.polygonOffsetUnits=this.polygonOffsetUnits),this.linewidth!==void 0&&this.linewidth!==1&&(n.linewidth=this.linewidth),this.dashSize!==void 0&&(n.dashSize=this.dashSize),this.gapSize!==void 0&&(n.gapSize=this.gapSize),this.scale!==void 0&&(n.scale=this.scale),this.dithering===!0&&(n.dithering=!0),this.alphaTest>0&&(n.alphaTest=this.alphaTest),this.alphaHash===!0&&(n.alphaHash=!0),this.alphaToCoverage===!0&&(n.alphaToCoverage=!0),this.premultipliedAlpha===!0&&(n.premultipliedAlpha=!0),this.forceSinglePass===!0&&(n.forceSinglePass=!0),this.wireframe===!0&&(n.wireframe=!0),this.wireframeLinewidth>1&&(n.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!=="round"&&(n.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!=="round"&&(n.wireframeLinejoin=this.wireframeLinejoin),this.flatShading===!0&&(n.flatShading=!0),this.visible===!1&&(n.visible=!1),this.toneMapped===!1&&(n.toneMapped=!1),this.fog===!1&&(n.fog=!1),Object.keys(this.userData).length>0&&(n.userData=this.userData);function s(r){let o=[];for(let a in r){let l=r[a];delete l.metadata,o.push(l)}return o}if(t){let r=s(e.textures),o=s(e.images);r.length>0&&(n.textures=r),o.length>0&&(n.images=o)}return n}clone(){return new this.constructor().copy(this)}copy(e){this.name=e.name,this.blending=e.blending,this.side=e.side,this.vertexColors=e.vertexColors,this.opacity=e.opacity,this.transparent=e.transparent,this.blendSrc=e.blendSrc,this.blendDst=e.blendDst,this.blendEquation=e.blendEquation,this.blendSrcAlpha=e.blendSrcAlpha,this.blendDstAlpha=e.blendDstAlpha,this.blendEquationAlpha=e.blendEquationAlpha,this.blendColor.copy(e.blendColor),this.blendAlpha=e.blendAlpha,this.depthFunc=e.depthFunc,this.depthTest=e.depthTest,this.depthWrite=e.depthWrite,this.stencilWriteMask=e.stencilWriteMask,this.stencilFunc=e.stencilFunc,this.stencilRef=e.stencilRef,this.stencilFuncMask=e.stencilFuncMask,this.stencilFail=e.stencilFail,this.stencilZFail=e.stencilZFail,this.stencilZPass=e.stencilZPass,this.stencilWrite=e.stencilWrite;let t=e.clippingPlanes,n=null;if(t!==null){let s=t.length;n=new Array(s);for(let r=0;r!==s;++r)n[r]=t[r].clone()}return this.clippingPlanes=n,this.clipIntersection=e.clipIntersection,this.clipShadows=e.clipShadows,this.shadowSide=e.shadowSide,this.colorWrite=e.colorWrite,this.precision=e.precision,this.polygonOffset=e.polygonOffset,this.polygonOffsetFactor=e.polygonOffsetFactor,this.polygonOffsetUnits=e.polygonOffsetUnits,this.dithering=e.dithering,this.alphaTest=e.alphaTest,this.alphaHash=e.alphaHash,this.alphaToCoverage=e.alphaToCoverage,this.premultipliedAlpha=e.premultipliedAlpha,this.forceSinglePass=e.forceSinglePass,this.visible=e.visible,this.toneMapped=e.toneMapped,this.userData=JSON.parse(JSON.stringify(e.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(e){e===!0&&this.version++}},Vt=class extends pn{constructor(e){super(),this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new Ne(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new on,this.combine=Ia,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}},yt=new D,Ro=new ce,zm=0,Ke=class{constructor(e,t,n=!1){if(Array.isArray(e))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,Object.defineProperty(this,"id",{value:zm++}),this.name="",this.array=e,this.itemSize=t,this.count=e!==void 0?e.length/t:0,this.normalized=n,this.usage=Uc,this.updateRanges=[],this.gpuType=Mn,this.version=0}onUploadCallback(){}set needsUpdate(e){e===!0&&this.version++}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.name=e.name,this.array=new e.array.constructor(e.array),this.itemSize=e.itemSize,this.count=e.count,this.normalized=e.normalized,this.usage=e.usage,this.gpuType=e.gpuType,this}copyAt(e,t,n){e*=this.itemSize,n*=t.itemSize;for(let s=0,r=this.itemSize;s<r;s++)this.array[e+s]=t.array[n+s];return this}copyArray(e){return this.array.set(e),this}applyMatrix3(e){if(this.itemSize===2)for(let t=0,n=this.count;t<n;t++)Ro.fromBufferAttribute(this,t),Ro.applyMatrix3(e),this.setXY(t,Ro.x,Ro.y);else if(this.itemSize===3)for(let t=0,n=this.count;t<n;t++)yt.fromBufferAttribute(this,t),yt.applyMatrix3(e),this.setXYZ(t,yt.x,yt.y,yt.z);return this}applyMatrix4(e){for(let t=0,n=this.count;t<n;t++)yt.fromBufferAttribute(this,t),yt.applyMatrix4(e),this.setXYZ(t,yt.x,yt.y,yt.z);return this}applyNormalMatrix(e){for(let t=0,n=this.count;t<n;t++)yt.fromBufferAttribute(this,t),yt.applyNormalMatrix(e),this.setXYZ(t,yt.x,yt.y,yt.z);return this}transformDirection(e){for(let t=0,n=this.count;t<n;t++)yt.fromBufferAttribute(this,t),yt.transformDirection(e),this.setXYZ(t,yt.x,yt.y,yt.z);return this}set(e,t=0){return this.array.set(e,t),this}getComponent(e,t){let n=this.array[e*this.itemSize+t];return this.normalized&&(n=fs(n,this.array)),n}setComponent(e,t,n){return this.normalized&&(n=Nt(n,this.array)),this.array[e*this.itemSize+t]=n,this}getX(e){let t=this.array[e*this.itemSize];return this.normalized&&(t=fs(t,this.array)),t}setX(e,t){return this.normalized&&(t=Nt(t,this.array)),this.array[e*this.itemSize]=t,this}getY(e){let t=this.array[e*this.itemSize+1];return this.normalized&&(t=fs(t,this.array)),t}setY(e,t){return this.normalized&&(t=Nt(t,this.array)),this.array[e*this.itemSize+1]=t,this}getZ(e){let t=this.array[e*this.itemSize+2];return this.normalized&&(t=fs(t,this.array)),t}setZ(e,t){return this.normalized&&(t=Nt(t,this.array)),this.array[e*this.itemSize+2]=t,this}getW(e){let t=this.array[e*this.itemSize+3];return this.normalized&&(t=fs(t,this.array)),t}setW(e,t){return this.normalized&&(t=Nt(t,this.array)),this.array[e*this.itemSize+3]=t,this}setXY(e,t,n){return e*=this.itemSize,this.normalized&&(t=Nt(t,this.array),n=Nt(n,this.array)),this.array[e+0]=t,this.array[e+1]=n,this}setXYZ(e,t,n,s){return e*=this.itemSize,this.normalized&&(t=Nt(t,this.array),n=Nt(n,this.array),s=Nt(s,this.array)),this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=s,this}setXYZW(e,t,n,s,r){return e*=this.itemSize,this.normalized&&(t=Nt(t,this.array),n=Nt(n,this.array),s=Nt(s,this.array),r=Nt(r,this.array)),this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=s,this.array[e+3]=r,this}onUpload(e){return this.onUploadCallback=e,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let e={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return this.name!==""&&(e.name=this.name),this.usage!==Uc&&(e.usage=this.usage),e}},Mr=class extends Ke{constructor(e,t,n){super(new Uint16Array(e),t,n)}},br=class extends Ke{constructor(e,t,n){super(new Uint32Array(e),t,n)}},ft=class extends Ke{constructor(e,t,n){super(new Float32Array(e),t,n)}},Vm=0,en=new it,Sc=new wt,hs=new D,$t=new ti,cr=new ti,St=new D,lt=class i extends xn{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:Vm++}),this.uuid=Bi(),this.name="",this.type="BufferGeometry",this.index=null,this.indirect=null,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={}}getIndex(){return this.index}setIndex(e){return Array.isArray(e)?this.index=new(lh(e)?br:Mr)(e,1):this.index=e,this}setIndirect(e){return this.indirect=e,this}getIndirect(){return this.indirect}getAttribute(e){return this.attributes[e]}setAttribute(e,t){return this.attributes[e]=t,this}deleteAttribute(e){return delete this.attributes[e],this}hasAttribute(e){return this.attributes[e]!==void 0}addGroup(e,t,n=0){this.groups.push({start:e,count:t,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(e,t){this.drawRange.start=e,this.drawRange.count=t}applyMatrix4(e){let t=this.attributes.position;t!==void 0&&(t.applyMatrix4(e),t.needsUpdate=!0);let n=this.attributes.normal;if(n!==void 0){let r=new Be().getNormalMatrix(e);n.applyNormalMatrix(r),n.needsUpdate=!0}let s=this.attributes.tangent;return s!==void 0&&(s.transformDirection(e),s.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}applyQuaternion(e){return en.makeRotationFromQuaternion(e),this.applyMatrix4(en),this}rotateX(e){return en.makeRotationX(e),this.applyMatrix4(en),this}rotateY(e){return en.makeRotationY(e),this.applyMatrix4(en),this}rotateZ(e){return en.makeRotationZ(e),this.applyMatrix4(en),this}translate(e,t,n){return en.makeTranslation(e,t,n),this.applyMatrix4(en),this}scale(e,t,n){return en.makeScale(e,t,n),this.applyMatrix4(en),this}lookAt(e){return Sc.lookAt(e),Sc.updateMatrix(),this.applyMatrix4(Sc.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(hs).negate(),this.translate(hs.x,hs.y,hs.z),this}setFromPoints(e){let t=this.getAttribute("position");if(t===void 0){let n=[];for(let s=0,r=e.length;s<r;s++){let o=e[s];n.push(o.x,o.y,o.z||0)}this.setAttribute("position",new ft(n,3))}else{let n=Math.min(e.length,t.count);for(let s=0;s<n;s++){let r=e[s];t.setXYZ(s,r.x,r.y,r.z||0)}e.length>t.count&&console.warn("THREE.BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."),t.needsUpdate=!0}return this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new ti);let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){console.error("THREE.BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.",this),this.boundingBox.set(new D(-1/0,-1/0,-1/0),new D(1/0,1/0,1/0));return}if(e!==void 0){if(this.boundingBox.setFromBufferAttribute(e),t)for(let n=0,s=t.length;n<s;n++){let r=t[n];$t.setFromBufferAttribute(r),this.morphTargetsRelative?(St.addVectors(this.boundingBox.min,$t.min),this.boundingBox.expandByPoint(St),St.addVectors(this.boundingBox.max,$t.max),this.boundingBox.expandByPoint(St)):(this.boundingBox.expandByPoint($t.min),this.boundingBox.expandByPoint($t.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&console.error('THREE.BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new ni);let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){console.error("THREE.BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.",this),this.boundingSphere.set(new D,1/0);return}if(e){let n=this.boundingSphere.center;if($t.setFromBufferAttribute(e),t)for(let r=0,o=t.length;r<o;r++){let a=t[r];cr.setFromBufferAttribute(a),this.morphTargetsRelative?(St.addVectors($t.min,cr.min),$t.expandByPoint(St),St.addVectors($t.max,cr.max),$t.expandByPoint(St)):($t.expandByPoint(cr.min),$t.expandByPoint(cr.max))}$t.getCenter(n);let s=0;for(let r=0,o=e.count;r<o;r++)St.fromBufferAttribute(e,r),s=Math.max(s,n.distanceToSquared(St));if(t)for(let r=0,o=t.length;r<o;r++){let a=t[r],l=this.morphTargetsRelative;for(let c=0,h=a.count;c<h;c++)St.fromBufferAttribute(a,c),l&&(hs.fromBufferAttribute(e,c),St.add(hs)),s=Math.max(s,n.distanceToSquared(St))}this.boundingSphere.radius=Math.sqrt(s),isNaN(this.boundingSphere.radius)&&console.error('THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let e=this.index,t=this.attributes;if(e===null||t.position===void 0||t.normal===void 0||t.uv===void 0){console.error("THREE.BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=t.position,s=t.normal,r=t.uv;this.hasAttribute("tangent")===!1&&this.setAttribute("tangent",new Ke(new Float32Array(4*n.count),4));let o=this.getAttribute("tangent"),a=[],l=[];for(let P=0;P<n.count;P++)a[P]=new D,l[P]=new D;let c=new D,h=new D,u=new D,p=new ce,d=new ce,g=new ce,_=new D,m=new D;function f(P,S,x){c.fromBufferAttribute(n,P),h.fromBufferAttribute(n,S),u.fromBufferAttribute(n,x),p.fromBufferAttribute(r,P),d.fromBufferAttribute(r,S),g.fromBufferAttribute(r,x),h.sub(c),u.sub(c),d.sub(p),g.sub(p);let T=1/(d.x*g.y-g.x*d.y);isFinite(T)&&(_.copy(h).multiplyScalar(g.y).addScaledVector(u,-d.y).multiplyScalar(T),m.copy(u).multiplyScalar(d.x).addScaledVector(h,-g.x).multiplyScalar(T),a[P].add(_),a[S].add(_),a[x].add(_),l[P].add(m),l[S].add(m),l[x].add(m))}let w=this.groups;w.length===0&&(w=[{start:0,count:e.count}]);for(let P=0,S=w.length;P<S;++P){let x=w[P],T=x.start,z=x.count;for(let O=T,X=T+z;O<X;O+=3)f(e.getX(O+0),e.getX(O+1),e.getX(O+2))}let M=new D,v=new D,A=new D,I=new D;function C(P){A.fromBufferAttribute(s,P),I.copy(A);let S=a[P];M.copy(S),M.sub(A.multiplyScalar(A.dot(S))).normalize(),v.crossVectors(I,S);let T=v.dot(l[P])<0?-1:1;o.setXYZW(P,M.x,M.y,M.z,T)}for(let P=0,S=w.length;P<S;++P){let x=w[P],T=x.start,z=x.count;for(let O=T,X=T+z;O<X;O+=3)C(e.getX(O+0)),C(e.getX(O+1)),C(e.getX(O+2))}}computeVertexNormals(){let e=this.index,t=this.getAttribute("position");if(t!==void 0){let n=this.getAttribute("normal");if(n===void 0)n=new Ke(new Float32Array(t.count*3),3),this.setAttribute("normal",n);else for(let p=0,d=n.count;p<d;p++)n.setXYZ(p,0,0,0);let s=new D,r=new D,o=new D,a=new D,l=new D,c=new D,h=new D,u=new D;if(e)for(let p=0,d=e.count;p<d;p+=3){let g=e.getX(p+0),_=e.getX(p+1),m=e.getX(p+2);s.fromBufferAttribute(t,g),r.fromBufferAttribute(t,_),o.fromBufferAttribute(t,m),h.subVectors(o,r),u.subVectors(s,r),h.cross(u),a.fromBufferAttribute(n,g),l.fromBufferAttribute(n,_),c.fromBufferAttribute(n,m),a.add(h),l.add(h),c.add(h),n.setXYZ(g,a.x,a.y,a.z),n.setXYZ(_,l.x,l.y,l.z),n.setXYZ(m,c.x,c.y,c.z)}else for(let p=0,d=t.count;p<d;p+=3)s.fromBufferAttribute(t,p+0),r.fromBufferAttribute(t,p+1),o.fromBufferAttribute(t,p+2),h.subVectors(o,r),u.subVectors(s,r),h.cross(u),n.setXYZ(p+0,h.x,h.y,h.z),n.setXYZ(p+1,h.x,h.y,h.z),n.setXYZ(p+2,h.x,h.y,h.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let e=this.attributes.normal;for(let t=0,n=e.count;t<n;t++)St.fromBufferAttribute(e,t),St.normalize(),e.setXYZ(t,St.x,St.y,St.z)}toNonIndexed(){function e(a,l){let c=a.array,h=a.itemSize,u=a.normalized,p=new c.constructor(l.length*h),d=0,g=0;for(let _=0,m=l.length;_<m;_++){a.isInterleavedBufferAttribute?d=l[_]*a.data.stride+a.offset:d=l[_]*h;for(let f=0;f<h;f++)p[g++]=c[d++]}return new Ke(p,h,u)}if(this.index===null)return console.warn("THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let t=new i,n=this.index.array,s=this.attributes;for(let a in s){let l=s[a],c=e(l,n);t.setAttribute(a,c)}let r=this.morphAttributes;for(let a in r){let l=[],c=r[a];for(let h=0,u=c.length;h<u;h++){let p=c[h],d=e(p,n);l.push(d)}t.morphAttributes[a]=l}t.morphTargetsRelative=this.morphTargetsRelative;let o=this.groups;for(let a=0,l=o.length;a<l;a++){let c=o[a];t.addGroup(c.start,c.count,c.materialIndex)}return t}toJSON(){let e={metadata:{version:4.7,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(e.uuid=this.uuid,e.type=this.type,this.name!==""&&(e.name=this.name),Object.keys(this.userData).length>0&&(e.userData=this.userData),this.parameters!==void 0){let l=this.parameters;for(let c in l)l[c]!==void 0&&(e[c]=l[c]);return e}e.data={attributes:{}};let t=this.index;t!==null&&(e.data.index={type:t.array.constructor.name,array:Array.prototype.slice.call(t.array)});let n=this.attributes;for(let l in n){let c=n[l];e.data.attributes[l]=c.toJSON(e.data)}let s={},r=!1;for(let l in this.morphAttributes){let c=this.morphAttributes[l],h=[];for(let u=0,p=c.length;u<p;u++){let d=c[u];h.push(d.toJSON(e.data))}h.length>0&&(s[l]=h,r=!0)}r&&(e.data.morphAttributes=s,e.data.morphTargetsRelative=this.morphTargetsRelative);let o=this.groups;o.length>0&&(e.data.groups=JSON.parse(JSON.stringify(o)));let a=this.boundingSphere;return a!==null&&(e.data.boundingSphere=a.toJSON()),e}clone(){return new this.constructor().copy(this)}copy(e){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let t={};this.name=e.name;let n=e.index;n!==null&&this.setIndex(n.clone());let s=e.attributes;for(let c in s){let h=s[c];this.setAttribute(c,h.clone(t))}let r=e.morphAttributes;for(let c in r){let h=[],u=r[c];for(let p=0,d=u.length;p<d;p++)h.push(u[p].clone(t));this.morphAttributes[c]=h}this.morphTargetsRelative=e.morphTargetsRelative;let o=e.groups;for(let c=0,h=o.length;c<h;c++){let u=o[c];this.addGroup(u.start,u.count,u.materialIndex)}let a=e.boundingBox;a!==null&&(this.boundingBox=a.clone());let l=e.boundingSphere;return l!==null&&(this.boundingSphere=l.clone()),this.drawRange.start=e.drawRange.start,this.drawRange.count=e.drawRange.count,this.userData=e.userData,this}dispose(){this.dispatchEvent({type:"dispose"})}},ed=new it,Ei=new Un,Io=new ni,td=new D,Po=new D,Lo=new D,Do=new D,wc=new D,No=new D,nd=new D,Uo=new D,gt=class extends wt{constructor(e=new lt,t=new Vt){super(),this.isMesh=!0,this.type="Mesh",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.count=1,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),e.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=e.morphTargetInfluences.slice()),e.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},e.morphTargetDictionary)),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let s=t[n[0]];if(s!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=s.length;r<o;r++){let a=s[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}getVertexPosition(e,t){let n=this.geometry,s=n.attributes.position,r=n.morphAttributes.position,o=n.morphTargetsRelative;t.fromBufferAttribute(s,e);let a=this.morphTargetInfluences;if(r&&a){No.set(0,0,0);for(let l=0,c=r.length;l<c;l++){let h=a[l],u=r[l];h!==0&&(wc.fromBufferAttribute(u,e),o?No.addScaledVector(wc,h):No.addScaledVector(wc.sub(t),h))}t.add(No)}return t}raycast(e,t){let n=this.geometry,s=this.material,r=this.matrixWorld;s!==void 0&&(n.boundingSphere===null&&n.computeBoundingSphere(),Io.copy(n.boundingSphere),Io.applyMatrix4(r),Ei.copy(e.ray).recast(e.near),!(Io.containsPoint(Ei.origin)===!1&&(Ei.intersectSphere(Io,td)===null||Ei.origin.distanceToSquared(td)>(e.far-e.near)**2))&&(ed.copy(r).invert(),Ei.copy(e.ray).applyMatrix4(ed),!(n.boundingBox!==null&&Ei.intersectsBox(n.boundingBox)===!1)&&this._computeIntersections(e,t,Ei)))}_computeIntersections(e,t,n){let s,r=this.geometry,o=this.material,a=r.index,l=r.attributes.position,c=r.attributes.uv,h=r.attributes.uv1,u=r.attributes.normal,p=r.groups,d=r.drawRange;if(a!==null)if(Array.isArray(o))for(let g=0,_=p.length;g<_;g++){let m=p[g],f=o[m.materialIndex],w=Math.max(m.start,d.start),M=Math.min(a.count,Math.min(m.start+m.count,d.start+d.count));for(let v=w,A=M;v<A;v+=3){let I=a.getX(v),C=a.getX(v+1),P=a.getX(v+2);s=Fo(this,f,e,n,c,h,u,I,C,P),s&&(s.faceIndex=Math.floor(v/3),s.face.materialIndex=m.materialIndex,t.push(s))}}else{let g=Math.max(0,d.start),_=Math.min(a.count,d.start+d.count);for(let m=g,f=_;m<f;m+=3){let w=a.getX(m),M=a.getX(m+1),v=a.getX(m+2);s=Fo(this,o,e,n,c,h,u,w,M,v),s&&(s.faceIndex=Math.floor(m/3),t.push(s))}}else if(l!==void 0)if(Array.isArray(o))for(let g=0,_=p.length;g<_;g++){let m=p[g],f=o[m.materialIndex],w=Math.max(m.start,d.start),M=Math.min(l.count,Math.min(m.start+m.count,d.start+d.count));for(let v=w,A=M;v<A;v+=3){let I=v,C=v+1,P=v+2;s=Fo(this,f,e,n,c,h,u,I,C,P),s&&(s.faceIndex=Math.floor(v/3),s.face.materialIndex=m.materialIndex,t.push(s))}}else{let g=Math.max(0,d.start),_=Math.min(l.count,d.start+d.count);for(let m=g,f=_;m<f;m+=3){let w=m,M=m+1,v=m+2;s=Fo(this,o,e,n,c,h,u,w,M,v),s&&(s.faceIndex=Math.floor(m/3),t.push(s))}}}};vs=class i extends lt{constructor(e=1,t=1,n=1,s=1,r=1,o=1){super(),this.type="BoxGeometry",this.parameters={width:e,height:t,depth:n,widthSegments:s,heightSegments:r,depthSegments:o};let a=this;s=Math.floor(s),r=Math.floor(r),o=Math.floor(o);let l=[],c=[],h=[],u=[],p=0,d=0;g("z","y","x",-1,-1,n,t,e,o,r,0),g("z","y","x",1,-1,n,t,-e,o,r,1),g("x","z","y",1,1,e,n,t,s,o,2),g("x","z","y",1,-1,e,n,-t,s,o,3),g("x","y","z",1,-1,e,t,n,s,r,4),g("x","y","z",-1,-1,e,t,-n,s,r,5),this.setIndex(l),this.setAttribute("position",new ft(c,3)),this.setAttribute("normal",new ft(h,3)),this.setAttribute("uv",new ft(u,2));function g(_,m,f,w,M,v,A,I,C,P,S){let x=v/C,T=A/P,z=v/2,O=A/2,X=I/2,K=C+1,k=P+1,te=0,W=0,se=new D;for(let re=0;re<k;re++){let pe=re*T-O;for(let Ce=0;Ce<K;Ce++){let Xe=Ce*x-z;se[_]=Xe*w,se[m]=pe*M,se[f]=X,c.push(se.x,se.y,se.z),se[_]=0,se[m]=0,se[f]=I>0?1:-1,h.push(se.x,se.y,se.z),u.push(Ce/C),u.push(1-re/P),te+=1}}for(let re=0;re<P;re++)for(let pe=0;pe<C;pe++){let Ce=p+pe+K*re,Xe=p+pe+K*(re+1),Z=p+(pe+1)+K*(re+1),R=p+(pe+1)+K*re;l.push(Ce,Xe,R),l.push(Xe,Z,R),W+=6}a.addGroup(d,W,S),d+=W,p+=te}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.width,e.height,e.depth,e.widthSegments,e.heightSegments,e.depthSegments)}};ff={clone:ki,merge:Pt},Wm=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,Xm=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`,mn=class extends pn{constructor(e){super(),this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Wm,this.fragmentShader=Xm,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={clipCullDistance:!1,multiDraw:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,e!==void 0&&this.setValues(e)}copy(e){return super.copy(e),this.fragmentShader=e.fragmentShader,this.vertexShader=e.vertexShader,this.uniforms=ki(e.uniforms),this.uniformsGroups=Hm(e.uniformsGroups),this.defines=Object.assign({},e.defines),this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.fog=e.fog,this.lights=e.lights,this.clipping=e.clipping,this.extensions=Object.assign({},e.extensions),this.glslVersion=e.glslVersion,this}toJSON(e){let t=super.toJSON(e);t.glslVersion=this.glslVersion,t.uniforms={};for(let s in this.uniforms){let o=this.uniforms[s].value;o&&o.isTexture?t.uniforms[s]={type:"t",value:o.toJSON(e).uuid}:o&&o.isColor?t.uniforms[s]={type:"c",value:o.getHex()}:o&&o.isVector2?t.uniforms[s]={type:"v2",value:o.toArray()}:o&&o.isVector3?t.uniforms[s]={type:"v3",value:o.toArray()}:o&&o.isVector4?t.uniforms[s]={type:"v4",value:o.toArray()}:o&&o.isMatrix3?t.uniforms[s]={type:"m3",value:o.toArray()}:o&&o.isMatrix4?t.uniforms[s]={type:"m4",value:o.toArray()}:t.uniforms[s]={value:o}}Object.keys(this.defines).length>0&&(t.defines=this.defines),t.vertexShader=this.vertexShader,t.fragmentShader=this.fragmentShader,t.lights=this.lights,t.clipping=this.clipping;let n={};for(let s in this.extensions)this.extensions[s]===!0&&(n[s]=!0);return Object.keys(n).length>0&&(t.extensions=n),t}},Sr=class extends wt{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new it,this.projectionMatrix=new it,this.projectionMatrixInverse=new it,this.coordinateSystem=yn}copy(e,t){return super.copy(e,t),this.matrixWorldInverse.copy(e.matrixWorldInverse),this.projectionMatrix.copy(e.projectionMatrix),this.projectionMatrixInverse.copy(e.projectionMatrixInverse),this.coordinateSystem=e.coordinateSystem,this}getWorldDirection(e){return super.getWorldDirection(e).negate()}updateMatrixWorld(e){super.updateMatrixWorld(e),this.matrixWorldInverse.copy(this.matrixWorld).invert()}updateWorldMatrix(e,t){super.updateWorldMatrix(e,t),this.matrixWorldInverse.copy(this.matrixWorld).invert()}clone(){return new this.constructor().copy(this)}},Kn=new D,id=new ce,sd=new ce,Ct=class extends Sr{constructor(e=50,t=1,n=.1,s=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=e,this.zoom=1,this.near=n,this.far=s,this.focus=10,this.aspect=t,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.fov=e.fov,this.zoom=e.zoom,this.near=e.near,this.far=e.far,this.focus=e.focus,this.aspect=e.aspect,this.view=e.view===null?null:Object.assign({},e.view),this.filmGauge=e.filmGauge,this.filmOffset=e.filmOffset,this}setFocalLength(e){let t=.5*this.getFilmHeight()/e;this.fov=_s*2*Math.atan(t),this.updateProjectionMatrix()}getFocalLength(){let e=Math.tan(dr*.5*this.fov);return .5*this.getFilmHeight()/e}getEffectiveFOV(){return _s*2*Math.atan(Math.tan(dr*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}getViewBounds(e,t,n){Kn.set(-1,-1,.5).applyMatrix4(this.projectionMatrixInverse),t.set(Kn.x,Kn.y).multiplyScalar(-e/Kn.z),Kn.set(1,1,.5).applyMatrix4(this.projectionMatrixInverse),n.set(Kn.x,Kn.y).multiplyScalar(-e/Kn.z)}getViewSize(e,t){return this.getViewBounds(e,id,sd),t.subVectors(sd,id)}setViewOffset(e,t,n,s,r,o){this.aspect=e/t,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=s,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=this.near,t=e*Math.tan(dr*.5*this.fov)/this.zoom,n=2*t,s=this.aspect*n,r=-.5*s,o=this.view;if(this.view!==null&&this.view.enabled){let l=o.fullWidth,c=o.fullHeight;r+=o.offsetX*s/l,t-=o.offsetY*n/c,s*=o.width/l,n*=o.height/c}let a=this.filmOffset;a!==0&&(r+=e*a/this.getFilmWidth()),this.projectionMatrix.makePerspective(r,r+s,t,t-n,e,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);return t.object.fov=this.fov,t.object.zoom=this.zoom,t.object.near=this.near,t.object.far=this.far,t.object.focus=this.focus,t.object.aspect=this.aspect,this.view!==null&&(t.object.view=Object.assign({},this.view)),t.object.filmGauge=this.filmGauge,t.object.filmOffset=this.filmOffset,t}},us=-90,ds=1,ta=class extends wt{constructor(e,t,n){super(),this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let s=new Ct(us,ds,e,t);s.layers=this.layers,this.add(s);let r=new Ct(us,ds,e,t);r.layers=this.layers,this.add(r);let o=new Ct(us,ds,e,t);o.layers=this.layers,this.add(o);let a=new Ct(us,ds,e,t);a.layers=this.layers,this.add(a);let l=new Ct(us,ds,e,t);l.layers=this.layers,this.add(l);let c=new Ct(us,ds,e,t);c.layers=this.layers,this.add(c)}updateCoordinateSystem(){let e=this.coordinateSystem,t=this.children.concat(),[n,s,r,o,a,l]=t;for(let c of t)this.remove(c);if(e===yn)n.up.set(0,1,0),n.lookAt(1,0,0),s.up.set(0,1,0),s.lookAt(-1,0,0),r.up.set(0,0,-1),r.lookAt(0,1,0),o.up.set(0,0,1),o.lookAt(0,-1,0),a.up.set(0,1,0),a.lookAt(0,0,1),l.up.set(0,1,0),l.lookAt(0,0,-1);else if(e===yr)n.up.set(0,-1,0),n.lookAt(-1,0,0),s.up.set(0,-1,0),s.lookAt(1,0,0),r.up.set(0,0,1),r.lookAt(0,1,0),o.up.set(0,0,-1),o.lookAt(0,-1,0),a.up.set(0,-1,0),a.lookAt(0,0,1),l.up.set(0,-1,0),l.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+e);for(let c of t)this.add(c),c.updateMatrixWorld()}update(e,t){this.parent===null&&this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:s}=this;this.coordinateSystem!==e.coordinateSystem&&(this.coordinateSystem=e.coordinateSystem,this.updateCoordinateSystem());let[r,o,a,l,c,h]=this.children,u=e.getRenderTarget(),p=e.getActiveCubeFace(),d=e.getActiveMipmapLevel(),g=e.xr.enabled;e.xr.enabled=!1;let _=n.texture.generateMipmaps;n.texture.generateMipmaps=!1,e.setRenderTarget(n,0,s),e.render(t,r),e.setRenderTarget(n,1,s),e.render(t,o),e.setRenderTarget(n,2,s),e.render(t,a),e.setRenderTarget(n,3,s),e.render(t,l),e.setRenderTarget(n,4,s),e.render(t,c),n.texture.generateMipmaps=_,e.setRenderTarget(n,5,s),e.render(t,h),e.setRenderTarget(u,p,d),e.xr.enabled=g,n.texture.needsPMREMUpdate=!0}},wr=class extends Ut{constructor(e=[],t=Fi,n,s,r,o,a,l,c,h){super(e,t,n,s,r,o,a,l,c,h),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(e){this.image=e}},na=class extends rn{constructor(e=1,t={}){super(e,e,t),this.isWebGLCubeRenderTarget=!0;let n={width:e,height:e,depth:1},s=[n,n,n,n,n,n];this.texture=new wr(s),this._setTextureOptions(t),this.texture.isRenderTargetTexture=!0}fromEquirectangularTexture(e,t){this.texture.type=t.type,this.texture.colorSpace=t.colorSpace,this.texture.generateMipmaps=t.generateMipmaps,this.texture.minFilter=t.minFilter,this.texture.magFilter=t.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},s=new vs(5,5,5),r=new mn({name:"CubemapFromEquirect",uniforms:ki(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:Ft,blending:Bn});r.uniforms.tEquirect.value=t;let o=new gt(s,r),a=t.minFilter;return t.minFilter===ai&&(t.minFilter=Et),new ta(1,10,this).update(e,o),t.minFilter=a,o.geometry.dispose(),o.material.dispose(),this}clear(e,t=!0,n=!0,s=!0){let r=e.getRenderTarget();for(let o=0;o<6;o++)e.setRenderTarget(this,o),e.clear(t,n,s);e.setRenderTarget(r)}},nn=class extends wt{constructor(){super(),this.isGroup=!0,this.type="Group"}},qm={type:"move"},Ms=class{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new nn,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new nn,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new D,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new D),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new nn,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new D,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new D),this._grip}dispatchEvent(e){return this._targetRay!==null&&this._targetRay.dispatchEvent(e),this._grip!==null&&this._grip.dispatchEvent(e),this._hand!==null&&this._hand.dispatchEvent(e),this}connect(e){if(e&&e.hand){let t=this._hand;if(t)for(let n of e.hand.values())this._getHandJoint(t,n)}return this.dispatchEvent({type:"connected",data:e}),this}disconnect(e){return this.dispatchEvent({type:"disconnected",data:e}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(e,t,n){let s=null,r=null,o=null,a=this._targetRay,l=this._grip,c=this._hand;if(e&&t.session.visibilityState!=="visible-blurred"){if(c&&e.hand){o=!0;for(let _ of e.hand.values()){let m=t.getJointPose(_,n),f=this._getHandJoint(c,_);m!==null&&(f.matrix.fromArray(m.transform.matrix),f.matrix.decompose(f.position,f.rotation,f.scale),f.matrixWorldNeedsUpdate=!0,f.jointRadius=m.radius),f.visible=m!==null}let h=c.joints["index-finger-tip"],u=c.joints["thumb-tip"],p=h.position.distanceTo(u.position),d=.02,g=.005;c.inputState.pinching&&p>d+g?(c.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:e.handedness,target:this})):!c.inputState.pinching&&p<=d-g&&(c.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:e.handedness,target:this}))}else l!==null&&e.gripSpace&&(r=t.getPose(e.gripSpace,n),r!==null&&(l.matrix.fromArray(r.transform.matrix),l.matrix.decompose(l.position,l.rotation,l.scale),l.matrixWorldNeedsUpdate=!0,r.linearVelocity?(l.hasLinearVelocity=!0,l.linearVelocity.copy(r.linearVelocity)):l.hasLinearVelocity=!1,r.angularVelocity?(l.hasAngularVelocity=!0,l.angularVelocity.copy(r.angularVelocity)):l.hasAngularVelocity=!1));a!==null&&(s=t.getPose(e.targetRaySpace,n),s===null&&r!==null&&(s=r),s!==null&&(a.matrix.fromArray(s.transform.matrix),a.matrix.decompose(a.position,a.rotation,a.scale),a.matrixWorldNeedsUpdate=!0,s.linearVelocity?(a.hasLinearVelocity=!0,a.linearVelocity.copy(s.linearVelocity)):a.hasLinearVelocity=!1,s.angularVelocity?(a.hasAngularVelocity=!0,a.angularVelocity.copy(s.angularVelocity)):a.hasAngularVelocity=!1,this.dispatchEvent(qm)))}return a!==null&&(a.visible=s!==null),l!==null&&(l.visible=r!==null),c!==null&&(c.visible=o!==null),this}_getHandJoint(e,t){if(e.joints[t.jointName]===void 0){let n=new nn;n.matrixAutoUpdate=!1,n.visible=!1,e.joints[t.jointName]=n,e.add(n)}return e.joints[t.jointName]}},Er=class extends wt{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.backgroundRotation=new on,this.environmentIntensity=1,this.environmentRotation=new on,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(e,t){return super.copy(e,t),e.background!==null&&(this.background=e.background.clone()),e.environment!==null&&(this.environment=e.environment.clone()),e.fog!==null&&(this.fog=e.fog.clone()),this.backgroundBlurriness=e.backgroundBlurriness,this.backgroundIntensity=e.backgroundIntensity,this.backgroundRotation.copy(e.backgroundRotation),this.environmentIntensity=e.environmentIntensity,this.environmentRotation.copy(e.environmentRotation),e.overrideMaterial!==null&&(this.overrideMaterial=e.overrideMaterial.clone()),this.matrixAutoUpdate=e.matrixAutoUpdate,this}toJSON(e){let t=super.toJSON(e);return this.fog!==null&&(t.object.fog=this.fog.toJSON()),this.backgroundBlurriness>0&&(t.object.backgroundBlurriness=this.backgroundBlurriness),this.backgroundIntensity!==1&&(t.object.backgroundIntensity=this.backgroundIntensity),t.object.backgroundRotation=this.backgroundRotation.toArray(),this.environmentIntensity!==1&&(t.object.environmentIntensity=this.environmentIntensity),t.object.environmentRotation=this.environmentRotation.toArray(),t}},Li=class extends Ut{constructor(e=null,t=1,n=1,s,r,o,a,l,c=zt,h=zt,u,p){super(null,o,a,l,c,h,s,r,u,p),this.isDataTexture=!0,this.image={data:e,width:t,height:n},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}},Ec=new D,Ym=new D,$m=new Be,tn=class{constructor(e=new D(1,0,0),t=0){this.isPlane=!0,this.normal=e,this.constant=t}set(e,t){return this.normal.copy(e),this.constant=t,this}setComponents(e,t,n,s){return this.normal.set(e,t,n),this.constant=s,this}setFromNormalAndCoplanarPoint(e,t){return this.normal.copy(e),this.constant=-t.dot(this.normal),this}setFromCoplanarPoints(e,t,n){let s=Ec.subVectors(n,t).cross(Ym.subVectors(e,t)).normalize();return this.setFromNormalAndCoplanarPoint(s,e),this}copy(e){return this.normal.copy(e.normal),this.constant=e.constant,this}normalize(){let e=1/this.normal.length();return this.normal.multiplyScalar(e),this.constant*=e,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(e){return this.normal.dot(e)+this.constant}distanceToSphere(e){return this.distanceToPoint(e.center)-e.radius}projectPoint(e,t){return t.copy(e).addScaledVector(this.normal,-this.distanceToPoint(e))}intersectLine(e,t){let n=e.delta(Ec),s=this.normal.dot(n);if(s===0)return this.distanceToPoint(e.start)===0?t.copy(e.start):null;let r=-(e.start.dot(this.normal)+this.constant)/s;return r<0||r>1?null:t.copy(e.start).addScaledVector(n,r)}intersectsLine(e){let t=this.distanceToPoint(e.start),n=this.distanceToPoint(e.end);return t<0&&n>0||n<0&&t>0}intersectsBox(e){return e.intersectsPlane(this)}intersectsSphere(e){return e.intersectsPlane(this)}coplanarPoint(e){return e.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(e,t){let n=t||$m.getNormalMatrix(e),s=this.coplanarPoint(Ec).applyMatrix4(e),r=this.normal.applyMatrix3(n).normalize();return this.constant=-s.dot(r),this}translate(e){return this.constant-=e.dot(this.normal),this}equals(e){return e.normal.equals(this.normal)&&e.constant===this.constant}clone(){return new this.constructor().copy(this)}},Ti=new ni,Zm=new ce(.5,.5),Oo=new D,bs=class{constructor(e=new tn,t=new tn,n=new tn,s=new tn,r=new tn,o=new tn){this.planes=[e,t,n,s,r,o]}set(e,t,n,s,r,o){let a=this.planes;return a[0].copy(e),a[1].copy(t),a[2].copy(n),a[3].copy(s),a[4].copy(r),a[5].copy(o),this}copy(e){let t=this.planes;for(let n=0;n<6;n++)t[n].copy(e.planes[n]);return this}setFromProjectionMatrix(e,t=yn){let n=this.planes,s=e.elements,r=s[0],o=s[1],a=s[2],l=s[3],c=s[4],h=s[5],u=s[6],p=s[7],d=s[8],g=s[9],_=s[10],m=s[11],f=s[12],w=s[13],M=s[14],v=s[15];if(n[0].setComponents(l-r,p-c,m-d,v-f).normalize(),n[1].setComponents(l+r,p+c,m+d,v+f).normalize(),n[2].setComponents(l+o,p+h,m+g,v+w).normalize(),n[3].setComponents(l-o,p-h,m-g,v-w).normalize(),n[4].setComponents(l-a,p-u,m-_,v-M).normalize(),t===yn)n[5].setComponents(l+a,p+u,m+_,v+M).normalize();else if(t===yr)n[5].setComponents(a,u,_,M).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+t);return this}intersectsObject(e){if(e.boundingSphere!==void 0)e.boundingSphere===null&&e.computeBoundingSphere(),Ti.copy(e.boundingSphere).applyMatrix4(e.matrixWorld);else{let t=e.geometry;t.boundingSphere===null&&t.computeBoundingSphere(),Ti.copy(t.boundingSphere).applyMatrix4(e.matrixWorld)}return this.intersectsSphere(Ti)}intersectsSprite(e){Ti.center.set(0,0,0);let t=Zm.distanceTo(e.center);return Ti.radius=.7071067811865476+t,Ti.applyMatrix4(e.matrixWorld),this.intersectsSphere(Ti)}intersectsSphere(e){let t=this.planes,n=e.center,s=-e.radius;for(let r=0;r<6;r++)if(t[r].distanceToPoint(n)<s)return!1;return!0}intersectsBox(e){let t=this.planes;for(let n=0;n<6;n++){let s=t[n];if(Oo.x=s.normal.x>0?e.max.x:e.min.x,Oo.y=s.normal.y>0?e.max.y:e.min.y,Oo.z=s.normal.z>0?e.max.z:e.min.z,s.distanceToPoint(Oo)<0)return!1}return!0}containsPoint(e){let t=this.planes;for(let n=0;n<6;n++)if(t[n].distanceToPoint(e)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}},Gt=class extends pn{constructor(e){super(),this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new Ne(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.linewidth=e.linewidth,this.linecap=e.linecap,this.linejoin=e.linejoin,this.fog=e.fog,this}},ia=new D,sa=new D,rd=new it,hr=new Un,Bo=new ni,Tc=new D,od=new D,Tr=class extends wt{constructor(e=new lt,t=new Gt){super(),this.isLine=!0,this.type="Line",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[0];for(let s=1,r=t.count;s<r;s++)ia.fromBufferAttribute(t,s-1),sa.fromBufferAttribute(t,s),n[s]=n[s-1],n[s]+=ia.distanceTo(sa);e.setAttribute("lineDistance",new ft(n,1))}else console.warn("THREE.Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}raycast(e,t){let n=this.geometry,s=this.matrixWorld,r=e.params.Line.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),Bo.copy(n.boundingSphere),Bo.applyMatrix4(s),Bo.radius+=r,e.ray.intersectsSphere(Bo)===!1)return;rd.copy(s).invert(),hr.copy(e.ray).applyMatrix4(rd);let a=r/((this.scale.x+this.scale.y+this.scale.z)/3),l=a*a,c=this.isLineSegments?2:1,h=n.index,p=n.attributes.position;if(h!==null){let d=Math.max(0,o.start),g=Math.min(h.count,o.start+o.count);for(let _=d,m=g-1;_<m;_+=c){let f=h.getX(_),w=h.getX(_+1),M=ko(this,e,hr,l,f,w,_);M&&t.push(M)}if(this.isLineLoop){let _=h.getX(g-1),m=h.getX(d),f=ko(this,e,hr,l,_,m,g-1);f&&t.push(f)}}else{let d=Math.max(0,o.start),g=Math.min(p.count,o.start+o.count);for(let _=d,m=g-1;_<m;_+=c){let f=ko(this,e,hr,l,_,_+1,_);f&&t.push(f)}if(this.isLineLoop){let _=ko(this,e,hr,l,g-1,d,g-1);_&&t.push(_)}}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let s=t[n[0]];if(s!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=s.length;r<o;r++){let a=s[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}};ad=new D,ld=new D,Fn=class extends Tr{constructor(e,t){super(e,t),this.isLineSegments=!0,this.type="LineSegments"}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[];for(let s=0,r=t.count;s<r;s+=2)ad.fromBufferAttribute(t,s),ld.fromBufferAttribute(t,s+1),n[s]=s===0?0:n[s-1],n[s+1]=n[s]+ad.distanceTo(ld);e.setAttribute("lineDistance",new ft(n,1))}else console.warn("THREE.LineSegments.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}},Ss=class extends Tr{constructor(e,t){super(e,t),this.isLineLoop=!0,this.type="LineLoop"}},ws=class extends pn{constructor(e){super(),this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new Ne(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.size=e.size,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}},cd=new it,Fc=new Un,zo=new ni,Vo=new D,Ar=class extends wt{constructor(e=new lt,t=new ws){super(),this.isPoints=!0,this.type="Points",this.geometry=e,this.material=t,this.morphTargetDictionary=void 0,this.morphTargetInfluences=void 0,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}raycast(e,t){let n=this.geometry,s=this.matrixWorld,r=e.params.Points.threshold,o=n.drawRange;if(n.boundingSphere===null&&n.computeBoundingSphere(),zo.copy(n.boundingSphere),zo.applyMatrix4(s),zo.radius+=r,e.ray.intersectsSphere(zo)===!1)return;cd.copy(s).invert(),Fc.copy(e.ray).applyMatrix4(cd);let a=r/((this.scale.x+this.scale.y+this.scale.z)/3),l=a*a,c=n.index,u=n.attributes.position;if(c!==null){let p=Math.max(0,o.start),d=Math.min(c.count,o.start+o.count);for(let g=p,_=d;g<_;g++){let m=c.getX(g);Vo.fromBufferAttribute(u,m),hd(Vo,m,l,s,e,t,this)}}else{let p=Math.max(0,o.start),d=Math.min(u.count,o.start+o.count);for(let g=p,_=d;g<_;g++)Vo.fromBufferAttribute(u,g),hd(Vo,g,l,s,e,t,this)}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let s=t[n[0]];if(s!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=s.length;r<o;r++){let a=s[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}};Es=class extends Ut{constructor(e,t,n,s,r,o,a,l,c){super(e,t,n,s,r,o,a,l,c),this.isCanvasTexture=!0,this.needsUpdate=!0}},Cr=class extends Ut{constructor(e,t,n=li,s,r,o,a=zt,l=zt,c,h=gs,u=1){if(h!==gs&&h!==Ds)throw new Error("DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat");let p={width:e,height:t,depth:u};super(p,s,r,o,a,l,h,n,c),this.isDepthTexture=!0,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(e){return super.copy(e),this.source=new ys(Object.assign({},e.image)),this.compareFunction=e.compareFunction,this}toJSON(e){let t=super.toJSON(e);return this.compareFunction!==null&&(t.compareFunction=this.compareFunction),t}},Zt=class{constructor(){this.type="Curve",this.arcLengthDivisions=200,this.needsUpdate=!1,this.cacheArcLengths=null}getPoint(){console.warn("THREE.Curve: .getPoint() not implemented.")}getPointAt(e,t){let n=this.getUtoTmapping(e);return this.getPoint(n,t)}getPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));return t}getSpacedPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPointAt(n/e));return t}getLength(){let e=this.getLengths();return e[e.length-1]}getLengths(e=this.arcLengthDivisions){if(this.cacheArcLengths&&this.cacheArcLengths.length===e+1&&!this.needsUpdate)return this.cacheArcLengths;this.needsUpdate=!1;let t=[],n,s=this.getPoint(0),r=0;t.push(0);for(let o=1;o<=e;o++)n=this.getPoint(o/e),r+=n.distanceTo(s),t.push(r),s=n;return this.cacheArcLengths=t,t}updateArcLengths(){this.needsUpdate=!0,this.getLengths()}getUtoTmapping(e,t=null){let n=this.getLengths(),s=0,r=n.length,o;t?o=t:o=e*n[r-1];let a=0,l=r-1,c;for(;a<=l;)if(s=Math.floor(a+(l-a)/2),c=n[s]-o,c<0)a=s+1;else if(c>0)l=s-1;else{l=s;break}if(s=l,n[s]===o)return s/(r-1);let h=n[s],p=n[s+1]-h,d=(o-h)/p;return(s+d)/(r-1)}getTangent(e,t){let s=e-1e-4,r=e+1e-4;s<0&&(s=0),r>1&&(r=1);let o=this.getPoint(s),a=this.getPoint(r),l=t||(o.isVector2?new ce:new D);return l.copy(a).sub(o).normalize(),l}getTangentAt(e,t){let n=this.getUtoTmapping(e);return this.getTangent(n,t)}computeFrenetFrames(e,t=!1){let n=new D,s=[],r=[],o=[],a=new D,l=new it;for(let d=0;d<=e;d++){let g=d/e;s[d]=this.getTangentAt(g,new D)}r[0]=new D,o[0]=new D;let c=Number.MAX_VALUE,h=Math.abs(s[0].x),u=Math.abs(s[0].y),p=Math.abs(s[0].z);h<=c&&(c=h,n.set(1,0,0)),u<=c&&(c=u,n.set(0,1,0)),p<=c&&n.set(0,0,1),a.crossVectors(s[0],n).normalize(),r[0].crossVectors(s[0],a),o[0].crossVectors(s[0],r[0]);for(let d=1;d<=e;d++){if(r[d]=r[d-1].clone(),o[d]=o[d-1].clone(),a.crossVectors(s[d-1],s[d]),a.length()>Number.EPSILON){a.normalize();let g=Math.acos(ze(s[d-1].dot(s[d]),-1,1));r[d].applyMatrix4(l.makeRotationAxis(a,g))}o[d].crossVectors(s[d],r[d])}if(t===!0){let d=Math.acos(ze(r[0].dot(r[e]),-1,1));d/=e,s[0].dot(a.crossVectors(r[0],r[e]))>0&&(d=-d);for(let g=1;g<=e;g++)r[g].applyMatrix4(l.makeRotationAxis(s[g],d*g)),o[g].crossVectors(s[g],r[g])}return{tangents:s,normals:r,binormals:o}}clone(){return new this.constructor().copy(this)}copy(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}toJSON(){let e={metadata:{version:4.7,type:"Curve",generator:"Curve.toJSON"}};return e.arcLengthDivisions=this.arcLengthDivisions,e.type=this.type,e}fromJSON(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}},Ts=class extends Zt{constructor(e=0,t=0,n=1,s=1,r=0,o=Math.PI*2,a=!1,l=0){super(),this.isEllipseCurve=!0,this.type="EllipseCurve",this.aX=e,this.aY=t,this.xRadius=n,this.yRadius=s,this.aStartAngle=r,this.aEndAngle=o,this.aClockwise=a,this.aRotation=l}getPoint(e,t=new ce){let n=t,s=Math.PI*2,r=this.aEndAngle-this.aStartAngle,o=Math.abs(r)<Number.EPSILON;for(;r<0;)r+=s;for(;r>s;)r-=s;r<Number.EPSILON&&(o?r=0:r=s),this.aClockwise===!0&&!o&&(r===s?r=-s:r=r-s);let a=this.aStartAngle+e*r,l=this.aX+this.xRadius*Math.cos(a),c=this.aY+this.yRadius*Math.sin(a);if(this.aRotation!==0){let h=Math.cos(this.aRotation),u=Math.sin(this.aRotation),p=l-this.aX,d=c-this.aY;l=p*h-d*u+this.aX,c=p*u+d*h+this.aY}return n.set(l,c)}copy(e){return super.copy(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}toJSON(){let e=super.toJSON();return e.aX=this.aX,e.aY=this.aY,e.xRadius=this.xRadius,e.yRadius=this.yRadius,e.aStartAngle=this.aStartAngle,e.aEndAngle=this.aEndAngle,e.aClockwise=this.aClockwise,e.aRotation=this.aRotation,e}fromJSON(e){return super.fromJSON(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}},ra=class extends Ts{constructor(e,t,n,s,r,o){super(e,t,n,n,s,r,o),this.isArcCurve=!0,this.type="ArcCurve"}};Go=new D,Ac=new hh,Cc=new hh,Rc=new hh,oa=class extends Zt{constructor(e=[],t=!1,n="centripetal",s=.5){super(),this.isCatmullRomCurve3=!0,this.type="CatmullRomCurve3",this.points=e,this.closed=t,this.curveType=n,this.tension=s}getPoint(e,t=new D){let n=t,s=this.points,r=s.length,o=(r-(this.closed?0:1))*e,a=Math.floor(o),l=o-a;this.closed?a+=a>0?0:(Math.floor(Math.abs(a)/r)+1)*r:l===0&&a===r-1&&(a=r-2,l=1);let c,h;this.closed||a>0?c=s[(a-1)%r]:(Go.subVectors(s[0],s[1]).add(s[0]),c=Go);let u=s[a%r],p=s[(a+1)%r];if(this.closed||a+2<r?h=s[(a+2)%r]:(Go.subVectors(s[r-1],s[r-2]).add(s[r-1]),h=Go),this.curveType==="centripetal"||this.curveType==="chordal"){let d=this.curveType==="chordal"?.5:.25,g=Math.pow(c.distanceToSquared(u),d),_=Math.pow(u.distanceToSquared(p),d),m=Math.pow(p.distanceToSquared(h),d);_<1e-4&&(_=1),g<1e-4&&(g=_),m<1e-4&&(m=_),Ac.initNonuniformCatmullRom(c.x,u.x,p.x,h.x,g,_,m),Cc.initNonuniformCatmullRom(c.y,u.y,p.y,h.y,g,_,m),Rc.initNonuniformCatmullRom(c.z,u.z,p.z,h.z,g,_,m)}else this.curveType==="catmullrom"&&(Ac.initCatmullRom(c.x,u.x,p.x,h.x,this.tension),Cc.initCatmullRom(c.y,u.y,p.y,h.y,this.tension),Rc.initCatmullRom(c.z,u.z,p.z,h.z,this.tension));return n.set(Ac.calc(l),Cc.calc(l),Rc.calc(l)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let s=e.points[t];this.points.push(s.clone())}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let s=this.points[t];e.points.push(s.toArray())}return e.closed=this.closed,e.curveType=this.curveType,e.tension=this.tension,e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let s=e.points[t];this.points.push(new D().fromArray(s))}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}};Rr=class extends Zt{constructor(e=new ce,t=new ce,n=new ce,s=new ce){super(),this.isCubicBezierCurve=!0,this.type="CubicBezierCurve",this.v0=e,this.v1=t,this.v2=n,this.v3=s}getPoint(e,t=new ce){let n=t,s=this.v0,r=this.v1,o=this.v2,a=this.v3;return n.set(mr(e,s.x,r.x,o.x,a.x),mr(e,s.y,r.y,o.y,a.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}},aa=class extends Zt{constructor(e=new D,t=new D,n=new D,s=new D){super(),this.isCubicBezierCurve3=!0,this.type="CubicBezierCurve3",this.v0=e,this.v1=t,this.v2=n,this.v3=s}getPoint(e,t=new D){let n=t,s=this.v0,r=this.v1,o=this.v2,a=this.v3;return n.set(mr(e,s.x,r.x,o.x,a.x),mr(e,s.y,r.y,o.y,a.y),mr(e,s.z,r.z,o.z,a.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}},Ir=class extends Zt{constructor(e=new ce,t=new ce){super(),this.isLineCurve=!0,this.type="LineCurve",this.v1=e,this.v2=t}getPoint(e,t=new ce){let n=t;return e===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1)),n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new ce){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},la=class extends Zt{constructor(e=new D,t=new D){super(),this.isLineCurve3=!0,this.type="LineCurve3",this.v1=e,this.v2=t}getPoint(e,t=new D){let n=t;return e===1?n.copy(this.v2):(n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1)),n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new D){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},Pr=class extends Zt{constructor(e=new ce,t=new ce,n=new ce){super(),this.isQuadraticBezierCurve=!0,this.type="QuadraticBezierCurve",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new ce){let n=t,s=this.v0,r=this.v1,o=this.v2;return n.set(pr(e,s.x,r.x,o.x),pr(e,s.y,r.y,o.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},ca=class extends Zt{constructor(e=new D,t=new D,n=new D){super(),this.isQuadraticBezierCurve3=!0,this.type="QuadraticBezierCurve3",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new D){let n=t,s=this.v0,r=this.v1,o=this.v2;return n.set(pr(e,s.x,r.x,o.x),pr(e,s.y,r.y,o.y),pr(e,s.z,r.z,o.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}},Lr=class extends Zt{constructor(e=[]){super(),this.isSplineCurve=!0,this.type="SplineCurve",this.points=e}getPoint(e,t=new ce){let n=t,s=this.points,r=(s.length-1)*e,o=Math.floor(r),a=r-o,l=s[o===0?o:o-1],c=s[o],h=s[o>s.length-2?s.length-1:o+1],u=s[o>s.length-3?s.length-1:o+2];return n.set(ud(a,l.x,c.x,h.x,u.x),ud(a,l.y,c.y,h.y,u.y)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let s=e.points[t];this.points.push(s.clone())}return this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let s=this.points[t];e.points.push(s.toArray())}return e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let s=e.points[t];this.points.push(new ce().fromArray(s))}return this}},dd=Object.freeze({__proto__:null,ArcCurve:ra,CatmullRomCurve3:oa,CubicBezierCurve:Rr,CubicBezierCurve3:aa,EllipseCurve:Ts,LineCurve:Ir,LineCurve3:la,QuadraticBezierCurve:Pr,QuadraticBezierCurve3:ca,SplineCurve:Lr}),ha=class extends Zt{constructor(){super(),this.type="CurvePath",this.curves=[],this.autoClose=!1}add(e){this.curves.push(e)}closePath(){let e=this.curves[0].getPoint(0),t=this.curves[this.curves.length-1].getPoint(1);if(!e.equals(t)){let n=e.isVector2===!0?"LineCurve":"LineCurve3";this.curves.push(new dd[n](t,e))}return this}getPoint(e,t){let n=e*this.getLength(),s=this.getCurveLengths(),r=0;for(;r<s.length;){if(s[r]>=n){let o=s[r]-n,a=this.curves[r],l=a.getLength(),c=l===0?0:1-o/l;return a.getPointAt(c,t)}r++}return null}getLength(){let e=this.getCurveLengths();return e[e.length-1]}updateArcLengths(){this.needsUpdate=!0,this.cacheLengths=null,this.getCurveLengths()}getCurveLengths(){if(this.cacheLengths&&this.cacheLengths.length===this.curves.length)return this.cacheLengths;let e=[],t=0;for(let n=0,s=this.curves.length;n<s;n++)t+=this.curves[n].getLength(),e.push(t);return this.cacheLengths=e,e}getSpacedPoints(e=40){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));return this.autoClose&&t.push(t[0]),t}getPoints(e=12){let t=[],n;for(let s=0,r=this.curves;s<r.length;s++){let o=r[s],a=o.isEllipseCurve?e*2:o.isLineCurve||o.isLineCurve3?1:o.isSplineCurve?e*o.points.length:e,l=o.getPoints(a);for(let c=0;c<l.length;c++){let h=l[c];n&&n.equals(h)||(t.push(h),n=h)}}return this.autoClose&&t.length>1&&!t[t.length-1].equals(t[0])&&t.push(t[0]),t}copy(e){super.copy(e),this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let s=e.curves[t];this.curves.push(s.clone())}return this.autoClose=e.autoClose,this}toJSON(){let e=super.toJSON();e.autoClose=this.autoClose,e.curves=[];for(let t=0,n=this.curves.length;t<n;t++){let s=this.curves[t];e.curves.push(s.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.autoClose=e.autoClose,this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let s=e.curves[t];this.curves.push(new dd[s.type]().fromJSON(s))}return this}},Dr=class extends ha{constructor(e){super(),this.type="Path",this.currentPoint=new ce,e&&this.setFromPoints(e)}setFromPoints(e){this.moveTo(e[0].x,e[0].y);for(let t=1,n=e.length;t<n;t++)this.lineTo(e[t].x,e[t].y);return this}moveTo(e,t){return this.currentPoint.set(e,t),this}lineTo(e,t){let n=new Ir(this.currentPoint.clone(),new ce(e,t));return this.curves.push(n),this.currentPoint.set(e,t),this}quadraticCurveTo(e,t,n,s){let r=new Pr(this.currentPoint.clone(),new ce(e,t),new ce(n,s));return this.curves.push(r),this.currentPoint.set(n,s),this}bezierCurveTo(e,t,n,s,r,o){let a=new Rr(this.currentPoint.clone(),new ce(e,t),new ce(n,s),new ce(r,o));return this.curves.push(a),this.currentPoint.set(r,o),this}splineThru(e){let t=[this.currentPoint.clone()].concat(e),n=new Lr(t);return this.curves.push(n),this.currentPoint.copy(e[e.length-1]),this}arc(e,t,n,s,r,o){let a=this.currentPoint.x,l=this.currentPoint.y;return this.absarc(e+a,t+l,n,s,r,o),this}absarc(e,t,n,s,r,o){return this.absellipse(e,t,n,n,s,r,o),this}ellipse(e,t,n,s,r,o,a,l){let c=this.currentPoint.x,h=this.currentPoint.y;return this.absellipse(e+c,t+h,n,s,r,o,a,l),this}absellipse(e,t,n,s,r,o,a,l){let c=new Ts(e,t,n,s,r,o,a,l);if(this.curves.length>0){let u=c.getPoint(0);u.equals(this.currentPoint)||this.lineTo(u.x,u.y)}this.curves.push(c);let h=c.getPoint(1);return this.currentPoint.copy(h),this}copy(e){return super.copy(e),this.currentPoint.copy(e.currentPoint),this}toJSON(){let e=super.toJSON();return e.currentPoint=this.currentPoint.toArray(),e}fromJSON(e){return super.fromJSON(e),this.currentPoint.fromArray(e.currentPoint),this}},As=class extends Dr{constructor(e){super(e),this.uuid=Bi(),this.type="Shape",this.holes=[]}getPointsHoles(e){let t=[];for(let n=0,s=this.holes.length;n<s;n++)t[n]=this.holes[n].getPoints(e);return t}extractPoints(e){return{shape:this.getPoints(e),holes:this.getPointsHoles(e)}}copy(e){super.copy(e),this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let s=e.holes[t];this.holes.push(s.clone())}return this}toJSON(){let e=super.toJSON();e.uuid=this.uuid,e.holes=[];for(let t=0,n=this.holes.length;t<n;t++){let s=this.holes[t];e.holes.push(s.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.uuid=e.uuid,this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let s=e.holes[t];this.holes.push(new Dr().fromJSON(s))}return this}};kc=class{static triangulate(e,t,n=2){return ig(e,t,n)}},ms=class i{static area(e){let t=e.length,n=0;for(let s=t-1,r=0;r<t;s=r++)n+=e[s].x*e[r].y-e[r].x*e[s].y;return n*.5}static isClockWise(e){return i.area(e)<0}static triangulateShape(e,t){let n=[],s=[],r=[];pd(e),md(n,e);let o=e.length;t.forEach(pd);for(let l=0;l<t.length;l++)s.push(o),o+=t[l].length,md(n,t[l]);let a=kc.triangulate(n,s);for(let l=0;l<a.length;l+=3)r.push(a.slice(l,l+3));return r}};On=class i extends lt{constructor(e=1,t=1,n=1,s=1){super(),this.type="PlaneGeometry",this.parameters={width:e,height:t,widthSegments:n,heightSegments:s};let r=e/2,o=t/2,a=Math.floor(n),l=Math.floor(s),c=a+1,h=l+1,u=e/a,p=t/l,d=[],g=[],_=[],m=[];for(let f=0;f<h;f++){let w=f*p-o;for(let M=0;M<c;M++){let v=M*u-r;g.push(v,-w,0),_.push(0,0,1),m.push(M/a),m.push(1-f/l)}}for(let f=0;f<l;f++)for(let w=0;w<a;w++){let M=w+c*f,v=w+c*(f+1),A=w+1+c*(f+1),I=w+1+c*f;d.push(M,v,I),d.push(v,A,I)}this.setIndex(d),this.setAttribute("position",new ft(g,3)),this.setAttribute("normal",new ft(_,3)),this.setAttribute("uv",new ft(m,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.width,e.height,e.widthSegments,e.heightSegments)}},Or=class i extends lt{constructor(e=new As([new ce(0,.5),new ce(-.5,-.5),new ce(.5,-.5)]),t=12){super(),this.type="ShapeGeometry",this.parameters={shapes:e,curveSegments:t};let n=[],s=[],r=[],o=[],a=0,l=0;if(Array.isArray(e)===!1)c(e);else for(let h=0;h<e.length;h++)c(e[h]),this.addGroup(a,l,h),a+=l,l=0;this.setIndex(n),this.setAttribute("position",new ft(s,3)),this.setAttribute("normal",new ft(r,3)),this.setAttribute("uv",new ft(o,2));function c(h){let u=s.length/3,p=h.extractPoints(t),d=p.shape,g=p.holes;ms.isClockWise(d)===!1&&(d=d.reverse());for(let m=0,f=g.length;m<f;m++){let w=g[m];ms.isClockWise(w)===!0&&(g[m]=w.reverse())}let _=ms.triangulateShape(d,g);for(let m=0,f=g.length;m<f;m++){let w=g[m];d=d.concat(w)}for(let m=0,f=d.length;m<f;m++){let w=d[m];s.push(w.x,w.y,0),r.push(0,0,1),o.push(w.x,w.y)}for(let m=0,f=_.length;m<f;m++){let w=_[m],M=w[0]+u,v=w[1]+u,A=w[2]+u;n.push(M,v,A),l+=3}}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON(),t=this.parameters.shapes;return vg(t,e)}static fromJSON(e,t){let n=[];for(let s=0,r=e.shapes.length;s<r;s++){let o=t[e.shapes[s]];n.push(o)}return new i(n,e.curveSegments)}};Br=class i extends lt{constructor(e=1,t=32,n=16,s=0,r=Math.PI*2,o=0,a=Math.PI){super(),this.type="SphereGeometry",this.parameters={radius:e,widthSegments:t,heightSegments:n,phiStart:s,phiLength:r,thetaStart:o,thetaLength:a},t=Math.max(3,Math.floor(t)),n=Math.max(2,Math.floor(n));let l=Math.min(o+a,Math.PI),c=0,h=[],u=new D,p=new D,d=[],g=[],_=[],m=[];for(let f=0;f<=n;f++){let w=[],M=f/n,v=0;f===0&&o===0?v=.5/t:f===n&&l===Math.PI&&(v=-.5/t);for(let A=0;A<=t;A++){let I=A/t;u.x=-e*Math.cos(s+I*r)*Math.sin(o+M*a),u.y=e*Math.cos(o+M*a),u.z=e*Math.sin(s+I*r)*Math.sin(o+M*a),g.push(u.x,u.y,u.z),p.copy(u).normalize(),_.push(p.x,p.y,p.z),m.push(I+v,1-M),w.push(c++)}h.push(w)}for(let f=0;f<n;f++)for(let w=0;w<t;w++){let M=h[f][w+1],v=h[f][w],A=h[f+1][w],I=h[f+1][w+1];(f!==0||o>0)&&d.push(M,v,I),(f!==n-1||l<Math.PI)&&d.push(v,A,I)}this.setIndex(d),this.setAttribute("position",new ft(g,3)),this.setAttribute("normal",new ft(_,3)),this.setAttribute("uv",new ft(m,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new i(e.radius,e.widthSegments,e.heightSegments,e.phiStart,e.phiLength,e.thetaStart,e.thetaLength)}},kr=class extends pn{constructor(e){super(),this.isMeshStandardMaterial=!0,this.type="MeshStandardMaterial",this.defines={STANDARD:""},this.color=new Ne(16777215),this.roughness=1,this.metalness=0,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new Ne(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=dl,this.normalScale=new ce(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.roughnessMap=null,this.metalnessMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new on,this.envMapIntensity=1,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.defines={STANDARD:""},this.color.copy(e.color),this.roughness=e.roughness,this.metalness=e.metalness,this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.roughnessMap=e.roughnessMap,this.metalnessMap=e.metalnessMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.envMapIntensity=e.envMapIntensity,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}},zr=class extends pn{constructor(e){super(),this.isMeshLambertMaterial=!0,this.type="MeshLambertMaterial",this.color=new Ne(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new Ne(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=dl,this.normalScale=new ce(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new on,this.combine=Ia,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapRotation.copy(e.envMapRotation),this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}},ua=class extends pn{constructor(e){super(),this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=Kd,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(e)}copy(e){return super.copy(e),this.depthPacking=e.depthPacking,this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this}},da=class extends pn{constructor(e){super(),this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(e)}copy(e){return super.copy(e),this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this}};Ni=class{constructor(e,t,n,s){this.parameterPositions=e,this._cachedIndex=0,this.resultBuffer=s!==void 0?s:new t.constructor(n),this.sampleValues=t,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(e){let t=this.parameterPositions,n=this._cachedIndex,s=t[n],r=t[n-1];n:{e:{let o;t:{i:if(!(e<s)){for(let a=n+2;;){if(s===void 0){if(e<r)break i;return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===a)break;if(r=s,s=t[++n],e<s)break e}o=t.length;break t}if(!(e>=r)){let a=t[1];e<a&&(n=2,r=a);for(let l=n-2;;){if(r===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===l)break;if(s=r,r=t[--n-1],e>=r)break e}o=n,n=0;break t}break n}for(;n<o;){let a=n+o>>>1;e<t[a]?o=a:n=a+1}if(s=t[n],r=t[n-1],r===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(s===void 0)return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,r,s)}return this.interpolate_(n,r,e,s)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(e){let t=this.resultBuffer,n=this.sampleValues,s=this.valueSize,r=e*s;for(let o=0;o!==s;++o)t[o]=n[r+o];return t}interpolate_(){throw new Error("call to abstract method")}intervalChanged_(){}},fa=class extends Ni{constructor(e,t,n,s){super(e,t,n,s),this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:Pc,endingEnd:Pc}}intervalChanged_(e,t,n){let s=this.parameterPositions,r=e-2,o=e+1,a=s[r],l=s[o];if(a===void 0)switch(this.getSettings_().endingStart){case Lc:r=e,a=2*t-n;break;case Dc:r=s.length-2,a=t+s[r]-s[r+1];break;default:r=e,a=n}if(l===void 0)switch(this.getSettings_().endingEnd){case Lc:o=e,l=2*n-t;break;case Dc:o=1,l=n+s[1]-s[0];break;default:o=e-1,l=t}let c=(n-t)*.5,h=this.valueSize;this._weightPrev=c/(t-a),this._weightNext=c/(l-n),this._offsetPrev=r*h,this._offsetNext=o*h}interpolate_(e,t,n,s){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=e*a,c=l-a,h=this._offsetPrev,u=this._offsetNext,p=this._weightPrev,d=this._weightNext,g=(n-t)/(s-t),_=g*g,m=_*g,f=-p*m+2*p*_-p*g,w=(1+p)*m+(-1.5-2*p)*_+(-.5+p)*g+1,M=(-1-d)*m+(1.5+d)*_+.5*g,v=d*m-d*_;for(let A=0;A!==a;++A)r[A]=f*o[h+A]+w*o[c+A]+M*o[l+A]+v*o[u+A];return r}},pa=class extends Ni{constructor(e,t,n,s){super(e,t,n,s)}interpolate_(e,t,n,s){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=e*a,c=l-a,h=(n-t)/(s-t),u=1-h;for(let p=0;p!==a;++p)r[p]=o[c+p]*u+o[l+p]*h;return r}},ma=class extends Ni{constructor(e,t,n,s){super(e,t,n,s)}interpolate_(e){return this.copySampleValue_(e-1)}},jt=class{constructor(e,t,n,s){if(e===void 0)throw new Error("THREE.KeyframeTrack: track name is undefined");if(t===void 0||t.length===0)throw new Error("THREE.KeyframeTrack: no keyframes in track named "+e);this.name=e,this.times=Xo(t,this.TimeBufferType),this.values=Xo(n,this.ValueBufferType),this.setInterpolation(s||this.DefaultInterpolation)}static toJSON(e){let t=e.constructor,n;if(t.toJSON!==this.toJSON)n=t.toJSON(e);else{n={name:e.name,times:Xo(e.times,Array),values:Xo(e.values,Array)};let s=e.getInterpolation();s!==e.DefaultInterpolation&&(n.interpolation=s)}return n.type=e.ValueTypeName,n}InterpolantFactoryMethodDiscrete(e){return new ma(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodLinear(e){return new pa(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodSmooth(e){return new fa(this.times,this.values,this.getValueSize(),e)}setInterpolation(e){let t;switch(e){case gr:t=this.InterpolantFactoryMethodDiscrete;break;case Ko:t=this.InterpolantFactoryMethodLinear;break;case qo:t=this.InterpolantFactoryMethodSmooth;break}if(t===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(e!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw new Error(n);return console.warn("THREE.KeyframeTrack:",n),this}return this.createInterpolant=t,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return gr;case this.InterpolantFactoryMethodLinear:return Ko;case this.InterpolantFactoryMethodSmooth:return qo}}getValueSize(){return this.values.length/this.times.length}shift(e){if(e!==0){let t=this.times;for(let n=0,s=t.length;n!==s;++n)t[n]+=e}return this}scale(e){if(e!==1){let t=this.times;for(let n=0,s=t.length;n!==s;++n)t[n]*=e}return this}trim(e,t){let n=this.times,s=n.length,r=0,o=s-1;for(;r!==s&&n[r]<e;)++r;for(;o!==-1&&n[o]>t;)--o;if(++o,r!==0||o!==s){r>=o&&(o=Math.max(o,1),r=o-1);let a=this.getValueSize();this.times=n.slice(r,o),this.values=this.values.slice(r*a,o*a)}return this}validate(){let e=!0,t=this.getValueSize();t-Math.floor(t)!==0&&(console.error("THREE.KeyframeTrack: Invalid value size in track.",this),e=!1);let n=this.times,s=this.values,r=n.length;r===0&&(console.error("THREE.KeyframeTrack: Track is empty.",this),e=!1);let o=null;for(let a=0;a!==r;a++){let l=n[a];if(typeof l=="number"&&isNaN(l)){console.error("THREE.KeyframeTrack: Time is not a valid number.",this,a,l),e=!1;break}if(o!==null&&o>l){console.error("THREE.KeyframeTrack: Out of order keys.",this,a,l,o),e=!1;break}o=l}if(s!==void 0&&Mg(s))for(let a=0,l=s.length;a!==l;++a){let c=s[a];if(isNaN(c)){console.error("THREE.KeyframeTrack: Value is not a valid number.",this,a,c),e=!1;break}}return e}optimize(){let e=this.times.slice(),t=this.values.slice(),n=this.getValueSize(),s=this.getInterpolation()===qo,r=e.length-1,o=1;for(let a=1;a<r;++a){let l=!1,c=e[a],h=e[a+1];if(c!==h&&(a!==1||c!==e[0]))if(s)l=!0;else{let u=a*n,p=u-n,d=u+n;for(let g=0;g!==n;++g){let _=t[u+g];if(_!==t[p+g]||_!==t[d+g]){l=!0;break}}}if(l){if(a!==o){e[o]=e[a];let u=a*n,p=o*n;for(let d=0;d!==n;++d)t[p+d]=t[u+d]}++o}}if(r>0){e[o]=e[r];for(let a=r*n,l=o*n,c=0;c!==n;++c)t[l+c]=t[a+c];++o}return o!==e.length?(this.times=e.slice(0,o),this.values=t.slice(0,o*n)):(this.times=e,this.values=t),this}clone(){let e=this.times.slice(),t=this.values.slice(),n=this.constructor,s=new n(this.name,e,t);return s.createInterpolant=this.createInterpolant,s}};jt.prototype.ValueTypeName="";jt.prototype.TimeBufferType=Float32Array;jt.prototype.ValueBufferType=Float32Array;jt.prototype.DefaultInterpolation=Ko;ii=class extends jt{constructor(e,t,n){super(e,t,n)}};ii.prototype.ValueTypeName="bool";ii.prototype.ValueBufferType=Array;ii.prototype.DefaultInterpolation=gr;ii.prototype.InterpolantFactoryMethodLinear=void 0;ii.prototype.InterpolantFactoryMethodSmooth=void 0;ga=class extends jt{constructor(e,t,n,s){super(e,t,n,s)}};ga.prototype.ValueTypeName="color";_a=class extends jt{constructor(e,t,n,s){super(e,t,n,s)}};_a.prototype.ValueTypeName="number";ya=class extends Ni{constructor(e,t,n,s){super(e,t,n,s)}interpolate_(e,t,n,s){let r=this.resultBuffer,o=this.sampleValues,a=this.valueSize,l=(n-t)/(s-t),c=e*a;for(let h=c+a;c!==h;c+=4)sn.slerpFlat(r,0,o,c-a,o,c,l);return r}},Vr=class extends jt{constructor(e,t,n,s){super(e,t,n,s)}InterpolantFactoryMethodLinear(e){return new ya(this.times,this.values,this.getValueSize(),e)}};Vr.prototype.ValueTypeName="quaternion";Vr.prototype.InterpolantFactoryMethodSmooth=void 0;si=class extends jt{constructor(e,t,n){super(e,t,n)}};si.prototype.ValueTypeName="string";si.prototype.ValueBufferType=Array;si.prototype.DefaultInterpolation=gr;si.prototype.InterpolantFactoryMethodLinear=void 0;si.prototype.InterpolantFactoryMethodSmooth=void 0;xa=class extends jt{constructor(e,t,n,s){super(e,t,n,s)}};xa.prototype.ValueTypeName="vector";va=class{constructor(e,t,n){let s=this,r=!1,o=0,a=0,l,c=[];this.onStart=void 0,this.onLoad=e,this.onProgress=t,this.onError=n,this.itemStart=function(h){a++,r===!1&&s.onStart!==void 0&&s.onStart(h,o,a),r=!0},this.itemEnd=function(h){o++,s.onProgress!==void 0&&s.onProgress(h,o,a),o===a&&(r=!1,s.onLoad!==void 0&&s.onLoad())},this.itemError=function(h){s.onError!==void 0&&s.onError(h)},this.resolveURL=function(h){return l?l(h):h},this.setURLModifier=function(h){return l=h,this},this.addHandler=function(h,u){return c.push(h,u),this},this.removeHandler=function(h){let u=c.indexOf(h);return u!==-1&&c.splice(u,2),this},this.getHandler=function(h){for(let u=0,p=c.length;u<p;u+=2){let d=c[u],g=c[u+1];if(d.global&&(d.lastIndex=0),d.test(h))return g}return null}}},yf=new va,Ma=class{constructor(e){this.manager=e!==void 0?e:yf,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={}}load(){}loadAsync(e,t){let n=this;return new Promise(function(s,r){n.load(e,s,t,r)})}parse(){}setCrossOrigin(e){return this.crossOrigin=e,this}setWithCredentials(e){return this.withCredentials=e,this}setPath(e){return this.path=e,this}setResourcePath(e){return this.resourcePath=e,this}setRequestHeader(e){return this.requestHeader=e,this}};Ma.DEFAULT_MATERIAL_NAME="__DEFAULT";Gr=class extends wt{constructor(e,t=1){super(),this.isLight=!0,this.type="Light",this.color=new Ne(e),this.intensity=t}dispose(){}copy(e,t){return super.copy(e,t),this.color.copy(e.color),this.intensity=e.intensity,this}toJSON(e){let t=super.toJSON(e);return t.object.color=this.color.getHex(),t.object.intensity=this.intensity,this.groundColor!==void 0&&(t.object.groundColor=this.groundColor.getHex()),this.distance!==void 0&&(t.object.distance=this.distance),this.angle!==void 0&&(t.object.angle=this.angle),this.decay!==void 0&&(t.object.decay=this.decay),this.penumbra!==void 0&&(t.object.penumbra=this.penumbra),this.shadow!==void 0&&(t.object.shadow=this.shadow.toJSON()),this.target!==void 0&&(t.object.target=this.target.uuid),t}},Hr=class extends Gr{constructor(e,t,n){super(e,n),this.isHemisphereLight=!0,this.type="HemisphereLight",this.position.copy(wt.DEFAULT_UP),this.updateMatrix(),this.groundColor=new Ne(t)}copy(e,t){return super.copy(e,t),this.groundColor.copy(e.groundColor),this}},Ic=new it,gd=new D,_d=new D,zc=class{constructor(e){this.camera=e,this.intensity=1,this.bias=0,this.normalBias=0,this.radius=1,this.blurSamples=8,this.mapSize=new ce(512,512),this.mapType=Ot,this.map=null,this.mapPass=null,this.matrix=new it,this.autoUpdate=!0,this.needsUpdate=!1,this._frustum=new bs,this._frameExtents=new ce(1,1),this._viewportCount=1,this._viewports=[new pt(0,0,1,1)]}getViewportCount(){return this._viewportCount}getFrustum(){return this._frustum}updateMatrices(e){let t=this.camera,n=this.matrix;gd.setFromMatrixPosition(e.matrixWorld),t.position.copy(gd),_d.setFromMatrixPosition(e.target.matrixWorld),t.lookAt(_d),t.updateMatrixWorld(),Ic.multiplyMatrices(t.projectionMatrix,t.matrixWorldInverse),this._frustum.setFromProjectionMatrix(Ic),n.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1),n.multiply(Ic)}getViewport(e){return this._viewports[e]}getFrameExtents(){return this._frameExtents}dispose(){this.map&&this.map.dispose(),this.mapPass&&this.mapPass.dispose()}copy(e){return this.camera=e.camera.clone(),this.intensity=e.intensity,this.bias=e.bias,this.radius=e.radius,this.autoUpdate=e.autoUpdate,this.needsUpdate=e.needsUpdate,this.normalBias=e.normalBias,this.blurSamples=e.blurSamples,this.mapSize.copy(e.mapSize),this}clone(){return new this.constructor().copy(this)}toJSON(){let e={};return this.intensity!==1&&(e.intensity=this.intensity),this.bias!==0&&(e.bias=this.bias),this.normalBias!==0&&(e.normalBias=this.normalBias),this.radius!==1&&(e.radius=this.radius),(this.mapSize.x!==512||this.mapSize.y!==512)&&(e.mapSize=this.mapSize.toArray()),e.camera=this.camera.toJSON(!1).object,delete e.camera.matrix,e}},Ui=class extends Sr{constructor(e=-1,t=1,n=1,s=-1,r=.1,o=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=e,this.right=t,this.top=n,this.bottom=s,this.near=r,this.far=o,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.left=e.left,this.right=e.right,this.top=e.top,this.bottom=e.bottom,this.near=e.near,this.far=e.far,this.zoom=e.zoom,this.view=e.view===null?null:Object.assign({},e.view),this}setViewOffset(e,t,n,s,r,o){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=s,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){let e=(this.right-this.left)/(2*this.zoom),t=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,s=(this.top+this.bottom)/2,r=n-e,o=n+e,a=s+t,l=s-t;if(this.view!==null&&this.view.enabled){let c=(this.right-this.left)/this.view.fullWidth/this.zoom,h=(this.top-this.bottom)/this.view.fullHeight/this.zoom;r+=c*this.view.offsetX,o=r+c*this.view.width,a-=h*this.view.offsetY,l=a-h*this.view.height}this.projectionMatrix.makeOrthographic(r,o,a,l,this.near,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);return t.object.zoom=this.zoom,t.object.left=this.left,t.object.right=this.right,t.object.top=this.top,t.object.bottom=this.bottom,t.object.near=this.near,t.object.far=this.far,this.view!==null&&(t.object.view=Object.assign({},this.view)),t}},Vc=class extends zc{constructor(){super(new Ui(-5,5,5,-5,.5,500)),this.isDirectionalLightShadow=!0}},Wr=class extends Gr{constructor(e,t){super(e,t),this.isDirectionalLight=!0,this.type="DirectionalLight",this.position.copy(wt.DEFAULT_UP),this.updateMatrix(),this.target=new wt,this.shadow=new Vc}dispose(){this.shadow.dispose()}copy(e){return super.copy(e),this.target=e.target.clone(),this.shadow=e.shadow.clone(),this}},ba=class extends Ct{constructor(e=[]){super(),this.isArrayCamera=!0,this.isMultiViewCamera=!1,this.cameras=e}},uh="\\[\\]\\.:\\/",bg=new RegExp("["+uh+"]","g"),dh="[^"+uh+"]",Sg="[^"+uh.replace("\\.","")+"]",wg=/((?:WC+[\/:])*)/.source.replace("WC",dh),Eg=/(WCOD+)?/.source.replace("WCOD",Sg),Tg=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",dh),Ag=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",dh),Cg=new RegExp("^"+wg+Eg+Tg+Ag+"$"),Rg=["material","materials","bones","map"],Gc=class{constructor(e,t,n){let s=n||ot.parseTrackName(t);this._targetGroup=e,this._bindings=e.subscribe_(t,s)}getValue(e,t){this.bind();let n=this._targetGroup.nCachedObjects_,s=this._bindings[n];s!==void 0&&s.getValue(e,t)}setValue(e,t){let n=this._bindings;for(let s=this._targetGroup.nCachedObjects_,r=n.length;s!==r;++s)n[s].setValue(e,t)}bind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].bind()}unbind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].unbind()}},ot=class i{constructor(e,t,n){this.path=t,this.parsedPath=n||i.parseTrackName(t),this.node=i.findNode(e,this.parsedPath.nodeName),this.rootNode=e,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(e,t,n){return e&&e.isAnimationObjectGroup?new i.Composite(e,t,n):new i(e,t,n)}static sanitizeNodeName(e){return e.replace(/\s/g,"_").replace(bg,"")}static parseTrackName(e){let t=Cg.exec(e);if(t===null)throw new Error("PropertyBinding: Cannot parse trackName: "+e);let n={nodeName:t[2],objectName:t[3],objectIndex:t[4],propertyName:t[5],propertyIndex:t[6]},s=n.nodeName&&n.nodeName.lastIndexOf(".");if(s!==void 0&&s!==-1){let r=n.nodeName.substring(s+1);Rg.indexOf(r)!==-1&&(n.nodeName=n.nodeName.substring(0,s),n.objectName=r)}if(n.propertyName===null||n.propertyName.length===0)throw new Error("PropertyBinding: can not parse propertyName from trackName: "+e);return n}static findNode(e,t){if(t===void 0||t===""||t==="."||t===-1||t===e.name||t===e.uuid)return e;if(e.skeleton){let n=e.skeleton.getBoneByName(t);if(n!==void 0)return n}if(e.children){let n=function(r){for(let o=0;o<r.length;o++){let a=r[o];if(a.name===t||a.uuid===t)return a;let l=n(a.children);if(l)return l}return null},s=n(e.children);if(s)return s}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(e,t){e[t]=this.targetObject[this.propertyName]}_getValue_array(e,t){let n=this.resolvedProperty;for(let s=0,r=n.length;s!==r;++s)e[t++]=n[s]}_getValue_arrayElement(e,t){e[t]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(e,t){this.resolvedProperty.toArray(e,t)}_setValue_direct(e,t){this.targetObject[this.propertyName]=e[t]}_setValue_direct_setNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(e,t){let n=this.resolvedProperty;for(let s=0,r=n.length;s!==r;++s)n[s]=e[t++]}_setValue_array_setNeedsUpdate(e,t){let n=this.resolvedProperty;for(let s=0,r=n.length;s!==r;++s)n[s]=e[t++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(e,t){let n=this.resolvedProperty;for(let s=0,r=n.length;s!==r;++s)n[s]=e[t++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(e,t){this.resolvedProperty[this.propertyIndex]=e[t]}_setValue_arrayElement_setNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(e,t){this.resolvedProperty.fromArray(e,t)}_setValue_fromArray_setNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(e,t){this.bind(),this.getValue(e,t)}_setValue_unbound(e,t){this.bind(),this.setValue(e,t)}bind(){let e=this.node,t=this.parsedPath,n=t.objectName,s=t.propertyName,r=t.propertyIndex;if(e||(e=i.findNode(this.rootNode,t.nodeName),this.node=e),this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!e){console.warn("THREE.PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let c=t.objectIndex;switch(n){case"materials":if(!e.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.materials){console.error("THREE.PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}e=e.material.materials;break;case"bones":if(!e.skeleton){console.error("THREE.PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}e=e.skeleton.bones;for(let h=0;h<e.length;h++)if(e[h].name===c){c=h;break}break;case"map":if("map"in e){e=e.map;break}if(!e.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.map){console.error("THREE.PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}e=e.material.map;break;default:if(e[n]===void 0){console.error("THREE.PropertyBinding: Can not bind to objectName of node undefined.",this);return}e=e[n]}if(c!==void 0){if(e[c]===void 0){console.error("THREE.PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,e);return}e=e[c]}}let o=e[s];if(o===void 0){let c=t.nodeName;console.error("THREE.PropertyBinding: Trying to update property for track: "+c+"."+s+" but it wasn't found.",e);return}let a=this.Versioning.None;this.targetObject=e,e.isMaterial===!0?a=this.Versioning.NeedsUpdate:e.isObject3D===!0&&(a=this.Versioning.MatrixWorldNeedsUpdate);let l=this.BindingType.Direct;if(r!==void 0){if(s==="morphTargetInfluences"){if(!e.geometry){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!e.geometry.morphAttributes){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}e.morphTargetDictionary[r]!==void 0&&(r=e.morphTargetDictionary[r])}l=this.BindingType.ArrayElement,this.resolvedProperty=o,this.propertyIndex=r}else o.fromArray!==void 0&&o.toArray!==void 0?(l=this.BindingType.HasFromToArray,this.resolvedProperty=o):Array.isArray(o)?(l=this.BindingType.EntireArray,this.resolvedProperty=o):this.propertyName=s;this.getValue=this.GetterByBindingType[l],this.setValue=this.SetterByBindingTypeAndVersioning[l][a]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}};ot.Composite=Gc;ot.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};ot.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};ot.prototype.GetterByBindingType=[ot.prototype._getValue_direct,ot.prototype._getValue_array,ot.prototype._getValue_arrayElement,ot.prototype._getValue_toArray];ot.prototype.SetterByBindingTypeAndVersioning=[[ot.prototype._setValue_direct,ot.prototype._setValue_direct_setNeedsUpdate,ot.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[ot.prototype._setValue_array,ot.prototype._setValue_array_setNeedsUpdate,ot.prototype._setValue_array_setMatrixWorldNeedsUpdate],[ot.prototype._setValue_arrayElement,ot.prototype._setValue_arrayElement_setNeedsUpdate,ot.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[ot.prototype._setValue_fromArray,ot.prototype._setValue_fromArray_setNeedsUpdate,ot.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];KM=new Float32Array(1),yd=new it,Xr=class{constructor(e,t,n=0,s=1/0){this.ray=new Un(e,t),this.near=n,this.far=s,this.camera=null,this.layers=new xs,this.params={Mesh:{},Line:{threshold:1},LOD:{},Points:{threshold:1},Sprite:{}}}set(e,t){this.ray.set(e,t)}setFromCamera(e,t){t.isPerspectiveCamera?(this.ray.origin.setFromMatrixPosition(t.matrixWorld),this.ray.direction.set(e.x,e.y,.5).unproject(t).sub(this.ray.origin).normalize(),this.camera=t):t.isOrthographicCamera?(this.ray.origin.set(e.x,e.y,(t.near+t.far)/(t.near-t.far)).unproject(t),this.ray.direction.set(0,0,-1).transformDirection(t.matrixWorld),this.camera=t):console.error("THREE.Raycaster: Unsupported camera type: "+t.type)}setFromXRController(e){return yd.identity().extractRotation(e.matrixWorld),this.ray.origin.setFromMatrixPosition(e.matrixWorld),this.ray.direction.set(0,0,-1).applyMatrix4(yd),this}intersectObject(e,t=!0,n=[]){return Hc(e,this,n,t),n.sort(xd),n}intersectObjects(e,t=!0,n=[]){for(let s=0,r=e.length;s<r;s++)Hc(e[s],this,n,t);return n.sort(xd),n}};Rs=class{constructor(e=1,t=0,n=0){this.radius=e,this.phi=t,this.theta=n}set(e,t,n){return this.radius=e,this.phi=t,this.theta=n,this}copy(e){return this.radius=e.radius,this.phi=e.phi,this.theta=e.theta,this}makeSafe(){return this.phi=ze(this.phi,1e-6,Math.PI-1e-6),this}setFromVector3(e){return this.setFromCartesianCoords(e.x,e.y,e.z)}setFromCartesianCoords(e,t,n){return this.radius=Math.sqrt(e*e+t*t+n*n),this.radius===0?(this.theta=0,this.phi=0):(this.theta=Math.atan2(e,n),this.phi=Math.acos(ze(t/this.radius,-1,1))),this}clone(){return new this.constructor().copy(this)}},qr=class extends xn{constructor(e,t=null){super(),this.object=e,this.domElement=t,this.enabled=!0,this.state=-1,this.keys={},this.mouseButtons={LEFT:null,MIDDLE:null,RIGHT:null},this.touches={ONE:null,TWO:null}}connect(e){if(e===void 0){console.warn("THREE.Controls: connect() now requires an element.");return}this.domElement!==null&&this.disconnect(),this.domElement=e}disconnect(){}dispose(){}update(){}};typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"178"}}));typeof window<"u"&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__="178")});function Gf(){let i=null,e=!1,t=null,n=null;function s(r,o){t(r,o),n=i.requestAnimationFrame(s)}return{start:function(){e!==!0&&t!==null&&(n=i.requestAnimationFrame(s),e=!0)},stop:function(){i.cancelAnimationFrame(n),e=!1},setAnimationLoop:function(r){t=r},setContext:function(r){i=r}}}function Lg(i){let e=new WeakMap;function t(a,l){let c=a.array,h=a.usage,u=c.byteLength,p=i.createBuffer();i.bindBuffer(l,p),i.bufferData(l,c,h),a.onUploadCallback();let d;if(c instanceof Float32Array)d=i.FLOAT;else if(typeof Float16Array<"u"&&c instanceof Float16Array)d=i.HALF_FLOAT;else if(c instanceof Uint16Array)a.isFloat16BufferAttribute?d=i.HALF_FLOAT:d=i.UNSIGNED_SHORT;else if(c instanceof Int16Array)d=i.SHORT;else if(c instanceof Uint32Array)d=i.UNSIGNED_INT;else if(c instanceof Int32Array)d=i.INT;else if(c instanceof Int8Array)d=i.BYTE;else if(c instanceof Uint8Array)d=i.UNSIGNED_BYTE;else if(c instanceof Uint8ClampedArray)d=i.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+c);return{buffer:p,type:d,bytesPerElement:c.BYTES_PER_ELEMENT,version:a.version,size:u}}function n(a,l,c){let h=l.array,u=l.updateRanges;if(i.bindBuffer(c,a),u.length===0)i.bufferSubData(c,0,h);else{u.sort((d,g)=>d.start-g.start);let p=0;for(let d=1;d<u.length;d++){let g=u[p],_=u[d];_.start<=g.start+g.count+1?g.count=Math.max(g.count,_.start+_.count-g.start):(++p,u[p]=_)}u.length=p+1;for(let d=0,g=u.length;d<g;d++){let _=u[d];i.bufferSubData(c,_.start*h.BYTES_PER_ELEMENT,h,_.start,_.count)}l.clearUpdateRanges()}l.onUploadCallback()}function s(a){return a.isInterleavedBufferAttribute&&(a=a.data),e.get(a)}function r(a){a.isInterleavedBufferAttribute&&(a=a.data);let l=e.get(a);l&&(i.deleteBuffer(l.buffer),e.delete(a))}function o(a,l){if(a.isInterleavedBufferAttribute&&(a=a.data),a.isGLBufferAttribute){let h=e.get(a);(!h||h.version<a.version)&&e.set(a,{buffer:a.buffer,type:a.type,bytesPerElement:a.elementSize,version:a.version});return}let c=e.get(a);if(c===void 0)e.set(a,t(a,l));else if(c.version<a.version){if(c.size!==a.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");n(c.buffer,a,l),c.version=a.version}}return{get:s,remove:r,update:o}}function fx(i,e,t,n,s,r,o){let a=new Ne(0),l=r===!0?0:1,c,h,u=null,p=0,d=null;function g(M){let v=M.isScene===!0?M.background:null;return v&&v.isTexture&&(v=(M.backgroundBlurriness>0?t:e).get(v)),v}function _(M){let v=!1,A=g(M);A===null?f(a,l):A&&A.isColor&&(f(A,1),v=!0);let I=i.xr.getEnvironmentBlendMode();I==="additive"?n.buffers.color.setClear(0,0,0,1,o):I==="alpha-blend"&&n.buffers.color.setClear(0,0,0,0,o),(i.autoClear||v)&&(n.buffers.depth.setTest(!0),n.buffers.depth.setMask(!0),n.buffers.color.setMask(!0),i.clear(i.autoClearColor,i.autoClearDepth,i.autoClearStencil))}function m(M,v){let A=g(v);A&&(A.isCubeTexture||A.mapping===Yr)?(h===void 0&&(h=new gt(new vs(1,1,1),new mn({name:"BackgroundCubeMaterial",uniforms:ki(bn.backgroundCube.uniforms),vertexShader:bn.backgroundCube.vertexShader,fragmentShader:bn.backgroundCube.fragmentShader,side:Ft,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),h.geometry.deleteAttribute("normal"),h.geometry.deleteAttribute("uv"),h.onBeforeRender=function(I,C,P){this.matrixWorld.copyPosition(P.matrixWorld)},Object.defineProperty(h.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),s.update(h)),zi.copy(v.backgroundRotation),zi.x*=-1,zi.y*=-1,zi.z*=-1,A.isCubeTexture&&A.isRenderTargetTexture===!1&&(zi.y*=-1,zi.z*=-1),h.material.uniforms.envMap.value=A,h.material.uniforms.flipEnvMap.value=A.isCubeTexture&&A.isRenderTargetTexture===!1?-1:1,h.material.uniforms.backgroundBlurriness.value=v.backgroundBlurriness,h.material.uniforms.backgroundIntensity.value=v.backgroundIntensity,h.material.uniforms.backgroundRotation.value.setFromMatrix4(dx.makeRotationFromEuler(zi)),h.material.toneMapped=Ye.getTransfer(A.colorSpace)!==Qe,(u!==A||p!==A.version||d!==i.toneMapping)&&(h.material.needsUpdate=!0,u=A,p=A.version,d=i.toneMapping),h.layers.enableAll(),M.unshift(h,h.geometry,h.material,0,0,null)):A&&A.isTexture&&(c===void 0&&(c=new gt(new On(2,2),new mn({name:"BackgroundMaterial",uniforms:ki(bn.background.uniforms),vertexShader:bn.background.vertexShader,fragmentShader:bn.background.fragmentShader,side:Nn,depthTest:!1,depthWrite:!1,fog:!1,allowOverride:!1})),c.geometry.deleteAttribute("normal"),Object.defineProperty(c.material,"map",{get:function(){return this.uniforms.t2D.value}}),s.update(c)),c.material.uniforms.t2D.value=A,c.material.uniforms.backgroundIntensity.value=v.backgroundIntensity,c.material.toneMapped=Ye.getTransfer(A.colorSpace)!==Qe,A.matrixAutoUpdate===!0&&A.updateMatrix(),c.material.uniforms.uvTransform.value.copy(A.matrix),(u!==A||p!==A.version||d!==i.toneMapping)&&(c.material.needsUpdate=!0,u=A,p=A.version,d=i.toneMapping),c.layers.enableAll(),M.unshift(c,c.geometry,c.material,0,0,null))}function f(M,v){M.getRGB(fl,ch(i)),n.buffers.color.setClear(fl.r,fl.g,fl.b,v,o)}function w(){h!==void 0&&(h.geometry.dispose(),h.material.dispose(),h=void 0),c!==void 0&&(c.geometry.dispose(),c.material.dispose(),c=void 0)}return{getClearColor:function(){return a},setClearColor:function(M,v=1){a.set(M),l=v,f(a,l)},getClearAlpha:function(){return l},setClearAlpha:function(M){l=M,f(a,l)},render:_,addToRenderList:m,dispose:w}}function px(i,e){let t=i.getParameter(i.MAX_VERTEX_ATTRIBS),n={},s=p(null),r=s,o=!1;function a(x,T,z,O,X){let K=!1,k=u(O,z,T);r!==k&&(r=k,c(r.object)),K=d(x,O,z,X),K&&g(x,O,z,X),X!==null&&e.update(X,i.ELEMENT_ARRAY_BUFFER),(K||o)&&(o=!1,v(x,T,z,O),X!==null&&i.bindBuffer(i.ELEMENT_ARRAY_BUFFER,e.get(X).buffer))}function l(){return i.createVertexArray()}function c(x){return i.bindVertexArray(x)}function h(x){return i.deleteVertexArray(x)}function u(x,T,z){let O=z.wireframe===!0,X=n[x.id];X===void 0&&(X={},n[x.id]=X);let K=X[T.id];K===void 0&&(K={},X[T.id]=K);let k=K[O];return k===void 0&&(k=p(l()),K[O]=k),k}function p(x){let T=[],z=[],O=[];for(let X=0;X<t;X++)T[X]=0,z[X]=0,O[X]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:T,enabledAttributes:z,attributeDivisors:O,object:x,attributes:{},index:null}}function d(x,T,z,O){let X=r.attributes,K=T.attributes,k=0,te=z.getAttributes();for(let W in te)if(te[W].location>=0){let re=X[W],pe=K[W];if(pe===void 0&&(W==="instanceMatrix"&&x.instanceMatrix&&(pe=x.instanceMatrix),W==="instanceColor"&&x.instanceColor&&(pe=x.instanceColor)),re===void 0||re.attribute!==pe||pe&&re.data!==pe.data)return!0;k++}return r.attributesNum!==k||r.index!==O}function g(x,T,z,O){let X={},K=T.attributes,k=0,te=z.getAttributes();for(let W in te)if(te[W].location>=0){let re=K[W];re===void 0&&(W==="instanceMatrix"&&x.instanceMatrix&&(re=x.instanceMatrix),W==="instanceColor"&&x.instanceColor&&(re=x.instanceColor));let pe={};pe.attribute=re,re&&re.data&&(pe.data=re.data),X[W]=pe,k++}r.attributes=X,r.attributesNum=k,r.index=O}function _(){let x=r.newAttributes;for(let T=0,z=x.length;T<z;T++)x[T]=0}function m(x){f(x,0)}function f(x,T){let z=r.newAttributes,O=r.enabledAttributes,X=r.attributeDivisors;z[x]=1,O[x]===0&&(i.enableVertexAttribArray(x),O[x]=1),X[x]!==T&&(i.vertexAttribDivisor(x,T),X[x]=T)}function w(){let x=r.newAttributes,T=r.enabledAttributes;for(let z=0,O=T.length;z<O;z++)T[z]!==x[z]&&(i.disableVertexAttribArray(z),T[z]=0)}function M(x,T,z,O,X,K,k){k===!0?i.vertexAttribIPointer(x,T,z,X,K):i.vertexAttribPointer(x,T,z,O,X,K)}function v(x,T,z,O){_();let X=O.attributes,K=z.getAttributes(),k=T.defaultAttributeValues;for(let te in K){let W=K[te];if(W.location>=0){let se=X[te];if(se===void 0&&(te==="instanceMatrix"&&x.instanceMatrix&&(se=x.instanceMatrix),te==="instanceColor"&&x.instanceColor&&(se=x.instanceColor)),se!==void 0){let re=se.normalized,pe=se.itemSize,Ce=e.get(se);if(Ce===void 0)continue;let Xe=Ce.buffer,Z=Ce.type,R=Ce.bytesPerElement,H=Z===i.INT||Z===i.UNSIGNED_INT||se.gpuType===Na;if(se.isInterleavedBufferAttribute){let q=se.data,de=q.stride,Re=se.offset;if(q.isInstancedInterleavedBuffer){for(let fe=0;fe<W.locationSize;fe++)f(W.location+fe,q.meshPerAttribute);x.isInstancedMesh!==!0&&O._maxInstanceCount===void 0&&(O._maxInstanceCount=q.meshPerAttribute*q.count)}else for(let fe=0;fe<W.locationSize;fe++)m(W.location+fe);i.bindBuffer(i.ARRAY_BUFFER,Xe);for(let fe=0;fe<W.locationSize;fe++)M(W.location+fe,pe/W.locationSize,Z,re,de*R,(Re+pe/W.locationSize*fe)*R,H)}else{if(se.isInstancedBufferAttribute){for(let q=0;q<W.locationSize;q++)f(W.location+q,se.meshPerAttribute);x.isInstancedMesh!==!0&&O._maxInstanceCount===void 0&&(O._maxInstanceCount=se.meshPerAttribute*se.count)}else for(let q=0;q<W.locationSize;q++)m(W.location+q);i.bindBuffer(i.ARRAY_BUFFER,Xe);for(let q=0;q<W.locationSize;q++)M(W.location+q,pe/W.locationSize,Z,re,pe*R,pe/W.locationSize*q*R,H)}}else if(k!==void 0){let re=k[te];if(re!==void 0)switch(re.length){case 2:i.vertexAttrib2fv(W.location,re);break;case 3:i.vertexAttrib3fv(W.location,re);break;case 4:i.vertexAttrib4fv(W.location,re);break;default:i.vertexAttrib1fv(W.location,re)}}}}w()}function A(){P();for(let x in n){let T=n[x];for(let z in T){let O=T[z];for(let X in O)h(O[X].object),delete O[X];delete T[z]}delete n[x]}}function I(x){if(n[x.id]===void 0)return;let T=n[x.id];for(let z in T){let O=T[z];for(let X in O)h(O[X].object),delete O[X];delete T[z]}delete n[x.id]}function C(x){for(let T in n){let z=n[T];if(z[x.id]===void 0)continue;let O=z[x.id];for(let X in O)h(O[X].object),delete O[X];delete z[x.id]}}function P(){S(),o=!0,r!==s&&(r=s,c(r.object))}function S(){s.geometry=null,s.program=null,s.wireframe=!1}return{setup:a,reset:P,resetDefaultState:S,dispose:A,releaseStatesOfGeometry:I,releaseStatesOfProgram:C,initAttributes:_,enableAttribute:m,disableUnusedAttributes:w}}function mx(i,e,t){let n;function s(c){n=c}function r(c,h){i.drawArrays(n,c,h),t.update(h,n,1)}function o(c,h,u){u!==0&&(i.drawArraysInstanced(n,c,h,u),t.update(h,n,u))}function a(c,h,u){if(u===0)return;e.get("WEBGL_multi_draw").multiDrawArraysWEBGL(n,c,0,h,0,u);let d=0;for(let g=0;g<u;g++)d+=h[g];t.update(d,n,1)}function l(c,h,u,p){if(u===0)return;let d=e.get("WEBGL_multi_draw");if(d===null)for(let g=0;g<c.length;g++)o(c[g],h[g],p[g]);else{d.multiDrawArraysInstancedWEBGL(n,c,0,h,0,p,0,u);let g=0;for(let _=0;_<u;_++)g+=h[_]*p[_];t.update(g,n,1)}}this.setMode=s,this.render=r,this.renderInstances=o,this.renderMultiDraw=a,this.renderMultiDrawInstances=l}function gx(i,e,t,n){let s;function r(){if(s!==void 0)return s;if(e.has("EXT_texture_filter_anisotropic")===!0){let C=e.get("EXT_texture_filter_anisotropic");s=i.getParameter(C.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else s=0;return s}function o(C){return!(C!==It&&n.convert(C)!==i.getParameter(i.IMPLEMENTATION_COLOR_READ_FORMAT))}function a(C){let P=C===Ps&&(e.has("EXT_color_buffer_half_float")||e.has("EXT_color_buffer_float"));return!(C!==Ot&&n.convert(C)!==i.getParameter(i.IMPLEMENTATION_COLOR_READ_TYPE)&&C!==Mn&&!P)}function l(C){if(C==="highp"){if(i.getShaderPrecisionFormat(i.VERTEX_SHADER,i.HIGH_FLOAT).precision>0&&i.getShaderPrecisionFormat(i.FRAGMENT_SHADER,i.HIGH_FLOAT).precision>0)return"highp";C="mediump"}return C==="mediump"&&i.getShaderPrecisionFormat(i.VERTEX_SHADER,i.MEDIUM_FLOAT).precision>0&&i.getShaderPrecisionFormat(i.FRAGMENT_SHADER,i.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let c=t.precision!==void 0?t.precision:"highp",h=l(c);h!==c&&(console.warn("THREE.WebGLRenderer:",c,"not supported, using",h,"instead."),c=h);let u=t.logarithmicDepthBuffer===!0,p=t.reverseDepthBuffer===!0&&e.has("EXT_clip_control"),d=i.getParameter(i.MAX_TEXTURE_IMAGE_UNITS),g=i.getParameter(i.MAX_VERTEX_TEXTURE_IMAGE_UNITS),_=i.getParameter(i.MAX_TEXTURE_SIZE),m=i.getParameter(i.MAX_CUBE_MAP_TEXTURE_SIZE),f=i.getParameter(i.MAX_VERTEX_ATTRIBS),w=i.getParameter(i.MAX_VERTEX_UNIFORM_VECTORS),M=i.getParameter(i.MAX_VARYING_VECTORS),v=i.getParameter(i.MAX_FRAGMENT_UNIFORM_VECTORS),A=g>0,I=i.getParameter(i.MAX_SAMPLES);return{isWebGL2:!0,getMaxAnisotropy:r,getMaxPrecision:l,textureFormatReadable:o,textureTypeReadable:a,precision:c,logarithmicDepthBuffer:u,reverseDepthBuffer:p,maxTextures:d,maxVertexTextures:g,maxTextureSize:_,maxCubemapSize:m,maxAttributes:f,maxVertexUniforms:w,maxVaryings:M,maxFragmentUniforms:v,vertexTextures:A,maxSamples:I}}function _x(i){let e=this,t=null,n=0,s=!1,r=!1,o=new tn,a=new Be,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(u,p){let d=u.length!==0||p||n!==0||s;return s=p,n=u.length,d},this.beginShadows=function(){r=!0,h(null)},this.endShadows=function(){r=!1},this.setGlobalState=function(u,p){t=h(u,p,0)},this.setState=function(u,p,d){let g=u.clippingPlanes,_=u.clipIntersection,m=u.clipShadows,f=i.get(u);if(!s||g===null||g.length===0||r&&!m)r?h(null):c();else{let w=r?0:n,M=w*4,v=f.clippingState||null;l.value=v,v=h(g,p,M,d);for(let A=0;A!==M;++A)v[A]=t[A];f.clippingState=v,this.numIntersection=_?this.numPlanes:0,this.numPlanes+=w}};function c(){l.value!==t&&(l.value=t,l.needsUpdate=n>0),e.numPlanes=n,e.numIntersection=0}function h(u,p,d,g){let _=u!==null?u.length:0,m=null;if(_!==0){if(m=l.value,g!==!0||m===null){let f=d+_*4,w=p.matrixWorldInverse;a.getNormalMatrix(w),(m===null||m.length<f)&&(m=new Float32Array(f));for(let M=0,v=d;M!==_;++M,v+=4)o.copy(u[M]).applyMatrix4(w,a),o.normal.toArray(m,v),m[v+3]=o.constant}l.value=m,l.needsUpdate=!0}return e.numPlanes=_,e.numIntersection=0,m}}function yx(i){let e=new WeakMap;function t(o,a){return a===Pa?o.mapping=Fi:a===La&&(o.mapping=Oi),o}function n(o){if(o&&o.isTexture){let a=o.mapping;if(a===Pa||a===La)if(e.has(o)){let l=e.get(o).texture;return t(l,o.mapping)}else{let l=o.image;if(l&&l.height>0){let c=new na(l.height);return c.fromEquirectangularTexture(i,o),e.set(o,c),o.addEventListener("dispose",s),t(c.texture,o.mapping)}else return null}}return o}function s(o){let a=o.target;a.removeEventListener("dispose",s);let l=e.get(a);l!==void 0&&(e.delete(a),l.dispose())}function r(){e=new WeakMap}return{get:n,dispose:r}}function vx(i){let e=[],t=[],n=[],s=i,r=i-Us+1+xf.length;for(let o=0;o<r;o++){let a=Math.pow(2,s);t.push(a);let l=1/a;o>i-Us?l=xf[o-i+Us-1]:o===0&&(l=0),n.push(l);let c=1/(a-2),h=-c,u=1+c,p=[h,h,u,h,u,u,h,h,u,u,h,u],d=6,g=6,_=3,m=2,f=1,w=new Float32Array(_*g*d),M=new Float32Array(m*g*d),v=new Float32Array(f*g*d);for(let I=0;I<d;I++){let C=I%3*2/3-1,P=I>2?0:-1,S=[C,P,0,C+2/3,P,0,C+2/3,P+1,0,C,P,0,C+2/3,P+1,0,C,P+1,0];w.set(S,_*g*I),M.set(p,m*g*I);let x=[I,I,I,I,I,I];v.set(x,f*g*I)}let A=new lt;A.setAttribute("position",new Ke(w,_)),A.setAttribute("uv",new Ke(M,m)),A.setAttribute("faceIndex",new Ke(v,f)),e.push(A),s>Us&&s--}return{lodPlanes:e,sizeLods:t,sigmas:n}}function bf(i,e,t){let n=new rn(i,e,t);return n.texture.mapping=Yr,n.texture.name="PMREM.cubeUv",n.scissorTest=!0,n}function pl(i,e,t,n,s){i.viewport.set(e,t,n,s),i.scissor.set(e,t,n,s)}function Mx(i,e,t){let n=new Float32Array(Hi),s=new D(0,1,0);return new mn({name:"SphericalGaussianBlur",defines:{n:Hi,CUBEUV_TEXEL_WIDTH:1/e,CUBEUV_TEXEL_HEIGHT:1/t,CUBEUV_MAX_MIP:`${i}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:n},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:s}},vertexShader:Rh(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:Bn,depthTest:!1,depthWrite:!1})}function Sf(){return new mn({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:Rh(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:Bn,depthTest:!1,depthWrite:!1})}function wf(){return new mn({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Rh(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:Bn,depthTest:!1,depthWrite:!1})}function Rh(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}function bx(i){let e=new WeakMap,t=null;function n(a){if(a&&a.isTexture){let l=a.mapping,c=l===Pa||l===La,h=l===Fi||l===Oi;if(c||h){let u=e.get(a),p=u!==void 0?u.texture.pmremVersion:0;if(a.isRenderTargetTexture&&a.pmremVersion!==p)return t===null&&(t=new gl(i)),u=c?t.fromEquirectangular(a,u):t.fromCubemap(a,u),u.texture.pmremVersion=a.pmremVersion,e.set(a,u),u.texture;if(u!==void 0)return u.texture;{let d=a.image;return c&&d&&d.height>0||h&&d&&s(d)?(t===null&&(t=new gl(i)),u=c?t.fromEquirectangular(a):t.fromCubemap(a),u.texture.pmremVersion=a.pmremVersion,e.set(a,u),a.addEventListener("dispose",r),u.texture):null}}}return a}function s(a){let l=0,c=6;for(let h=0;h<c;h++)a[h]!==void 0&&l++;return l===c}function r(a){let l=a.target;l.removeEventListener("dispose",r);let c=e.get(l);c!==void 0&&(e.delete(l),c.dispose())}function o(){e=new WeakMap,t!==null&&(t.dispose(),t=null)}return{get:n,dispose:o}}function Sx(i){let e={};function t(n){if(e[n]!==void 0)return e[n];let s;switch(n){case"WEBGL_depth_texture":s=i.getExtension("WEBGL_depth_texture")||i.getExtension("MOZ_WEBGL_depth_texture")||i.getExtension("WEBKIT_WEBGL_depth_texture");break;case"EXT_texture_filter_anisotropic":s=i.getExtension("EXT_texture_filter_anisotropic")||i.getExtension("MOZ_EXT_texture_filter_anisotropic")||i.getExtension("WEBKIT_EXT_texture_filter_anisotropic");break;case"WEBGL_compressed_texture_s3tc":s=i.getExtension("WEBGL_compressed_texture_s3tc")||i.getExtension("MOZ_WEBGL_compressed_texture_s3tc")||i.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc");break;case"WEBGL_compressed_texture_pvrtc":s=i.getExtension("WEBGL_compressed_texture_pvrtc")||i.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc");break;default:s=i.getExtension(n)}return e[n]=s,s}return{has:function(n){return t(n)!==null},init:function(){t("EXT_color_buffer_float"),t("WEBGL_clip_cull_distance"),t("OES_texture_float_linear"),t("EXT_color_buffer_half_float"),t("WEBGL_multisampled_render_to_texture"),t("WEBGL_render_shared_exponent")},get:function(n){let s=t(n);return s===null&&Pi("THREE.WebGLRenderer: "+n+" extension not supported."),s}}}function wx(i,e,t,n){let s={},r=new WeakMap;function o(u){let p=u.target;p.index!==null&&e.remove(p.index);for(let g in p.attributes)e.remove(p.attributes[g]);p.removeEventListener("dispose",o),delete s[p.id];let d=r.get(p);d&&(e.remove(d),r.delete(p)),n.releaseStatesOfGeometry(p),p.isInstancedBufferGeometry===!0&&delete p._maxInstanceCount,t.memory.geometries--}function a(u,p){return s[p.id]===!0||(p.addEventListener("dispose",o),s[p.id]=!0,t.memory.geometries++),p}function l(u){let p=u.attributes;for(let d in p)e.update(p[d],i.ARRAY_BUFFER)}function c(u){let p=[],d=u.index,g=u.attributes.position,_=0;if(d!==null){let w=d.array;_=d.version;for(let M=0,v=w.length;M<v;M+=3){let A=w[M+0],I=w[M+1],C=w[M+2];p.push(A,I,I,C,C,A)}}else if(g!==void 0){let w=g.array;_=g.version;for(let M=0,v=w.length/3-1;M<v;M+=3){let A=M+0,I=M+1,C=M+2;p.push(A,I,I,C,C,A)}}else return;let m=new(lh(p)?br:Mr)(p,1);m.version=_;let f=r.get(u);f&&e.remove(f),r.set(u,m)}function h(u){let p=r.get(u);if(p){let d=u.index;d!==null&&p.version<d.version&&c(u)}else c(u);return r.get(u)}return{get:a,update:l,getWireframeAttribute:h}}function Ex(i,e,t){let n;function s(p){n=p}let r,o;function a(p){r=p.type,o=p.bytesPerElement}function l(p,d){i.drawElements(n,d,r,p*o),t.update(d,n,1)}function c(p,d,g){g!==0&&(i.drawElementsInstanced(n,d,r,p*o,g),t.update(d,n,g))}function h(p,d,g){if(g===0)return;e.get("WEBGL_multi_draw").multiDrawElementsWEBGL(n,d,0,r,p,0,g);let m=0;for(let f=0;f<g;f++)m+=d[f];t.update(m,n,1)}function u(p,d,g,_){if(g===0)return;let m=e.get("WEBGL_multi_draw");if(m===null)for(let f=0;f<p.length;f++)c(p[f]/o,d[f],_[f]);else{m.multiDrawElementsInstancedWEBGL(n,d,0,r,p,0,_,0,g);let f=0;for(let w=0;w<g;w++)f+=d[w]*_[w];t.update(f,n,1)}}this.setMode=s,this.setIndex=a,this.render=l,this.renderInstances=c,this.renderMultiDraw=h,this.renderMultiDrawInstances=u}function Tx(i){let e={geometries:0,textures:0},t={frame:0,calls:0,triangles:0,points:0,lines:0};function n(r,o,a){switch(t.calls++,o){case i.TRIANGLES:t.triangles+=a*(r/3);break;case i.LINES:t.lines+=a*(r/2);break;case i.LINE_STRIP:t.lines+=a*(r-1);break;case i.LINE_LOOP:t.lines+=a*r;break;case i.POINTS:t.points+=a*r;break;default:console.error("THREE.WebGLInfo: Unknown draw mode:",o);break}}function s(){t.calls=0,t.triangles=0,t.points=0,t.lines=0}return{memory:e,render:t,programs:null,autoReset:!0,reset:s,update:n}}function Ax(i,e,t){let n=new WeakMap,s=new pt;function r(o,a,l){let c=o.morphTargetInfluences,h=a.morphAttributes.position||a.morphAttributes.normal||a.morphAttributes.color,u=h!==void 0?h.length:0,p=n.get(a);if(p===void 0||p.count!==u){let S=function(){C.dispose(),n.delete(a),a.removeEventListener("dispose",S)};p!==void 0&&p.texture.dispose();let d=a.morphAttributes.position!==void 0,g=a.morphAttributes.normal!==void 0,_=a.morphAttributes.color!==void 0,m=a.morphAttributes.position||[],f=a.morphAttributes.normal||[],w=a.morphAttributes.color||[],M=0;d===!0&&(M=1),g===!0&&(M=2),_===!0&&(M=3);let v=a.attributes.position.count*M,A=1;v>e.maxTextureSize&&(A=Math.ceil(v/e.maxTextureSize),v=e.maxTextureSize);let I=new Float32Array(v*A*4*u),C=new vr(I,v,A,u);C.type=Mn,C.needsUpdate=!0;let P=M*4;for(let x=0;x<u;x++){let T=m[x],z=f[x],O=w[x],X=v*A*4*x;for(let K=0;K<T.count;K++){let k=K*P;d===!0&&(s.fromBufferAttribute(T,K),I[X+k+0]=s.x,I[X+k+1]=s.y,I[X+k+2]=s.z,I[X+k+3]=0),g===!0&&(s.fromBufferAttribute(z,K),I[X+k+4]=s.x,I[X+k+5]=s.y,I[X+k+6]=s.z,I[X+k+7]=0),_===!0&&(s.fromBufferAttribute(O,K),I[X+k+8]=s.x,I[X+k+9]=s.y,I[X+k+10]=s.z,I[X+k+11]=O.itemSize===4?s.w:1)}}p={count:u,texture:C,size:new ce(v,A)},n.set(a,p),a.addEventListener("dispose",S)}if(o.isInstancedMesh===!0&&o.morphTexture!==null)l.getUniforms().setValue(i,"morphTexture",o.morphTexture,t);else{let d=0;for(let _=0;_<c.length;_++)d+=c[_];let g=a.morphTargetsRelative?1:1-d;l.getUniforms().setValue(i,"morphTargetBaseInfluence",g),l.getUniforms().setValue(i,"morphTargetInfluences",c)}l.getUniforms().setValue(i,"morphTargetsTexture",p.texture,t),l.getUniforms().setValue(i,"morphTargetsTextureSize",p.size)}return{update:r}}function Cx(i,e,t,n){let s=new WeakMap;function r(l){let c=n.render.frame,h=l.geometry,u=e.get(l,h);if(s.get(u)!==c&&(e.update(u),s.set(u,c)),l.isInstancedMesh&&(l.hasEventListener("dispose",a)===!1&&l.addEventListener("dispose",a),s.get(l)!==c&&(t.update(l.instanceMatrix,i.ARRAY_BUFFER),l.instanceColor!==null&&t.update(l.instanceColor,i.ARRAY_BUFFER),s.set(l,c))),l.isSkinnedMesh){let p=l.skeleton;s.get(p)!==c&&(p.update(),s.set(p,c))}return u}function o(){s=new WeakMap}function a(l){let c=l.target;c.removeEventListener("dispose",a),t.remove(c.instanceMatrix),c.instanceColor!==null&&t.remove(c.instanceColor)}return{update:r,dispose:o}}function Os(i,e,t){let n=i[0];if(n<=0||n>0)return i;let s=e*t,r=Tf[s];if(r===void 0&&(r=new Float32Array(s),Tf[s]=r),e!==0){n.toArray(r,0);for(let o=1,a=0;o!==e;++o)a+=t,i[o].toArray(r,a)}return r}function vt(i,e){if(i.length!==e.length)return!1;for(let t=0,n=i.length;t<n;t++)if(i[t]!==e[t])return!1;return!0}function Mt(i,e){for(let t=0,n=e.length;t<n;t++)i[t]=e[t]}function yl(i,e){let t=Af[e];t===void 0&&(t=new Int32Array(e),Af[e]=t);for(let n=0;n!==e;++n)t[n]=i.allocateTextureUnit();return t}function Rx(i,e){let t=this.cache;t[0]!==e&&(i.uniform1f(this.addr,e),t[0]=e)}function Ix(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2f(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(vt(t,e))return;i.uniform2fv(this.addr,e),Mt(t,e)}}function Px(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3f(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else if(e.r!==void 0)(t[0]!==e.r||t[1]!==e.g||t[2]!==e.b)&&(i.uniform3f(this.addr,e.r,e.g,e.b),t[0]=e.r,t[1]=e.g,t[2]=e.b);else{if(vt(t,e))return;i.uniform3fv(this.addr,e),Mt(t,e)}}function Lx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4f(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(vt(t,e))return;i.uniform4fv(this.addr,e),Mt(t,e)}}function Dx(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(vt(t,e))return;i.uniformMatrix2fv(this.addr,!1,e),Mt(t,e)}else{if(vt(t,n))return;If.set(n),i.uniformMatrix2fv(this.addr,!1,If),Mt(t,n)}}function Nx(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(vt(t,e))return;i.uniformMatrix3fv(this.addr,!1,e),Mt(t,e)}else{if(vt(t,n))return;Rf.set(n),i.uniformMatrix3fv(this.addr,!1,Rf),Mt(t,n)}}function Ux(i,e){let t=this.cache,n=e.elements;if(n===void 0){if(vt(t,e))return;i.uniformMatrix4fv(this.addr,!1,e),Mt(t,e)}else{if(vt(t,n))return;Cf.set(n),i.uniformMatrix4fv(this.addr,!1,Cf),Mt(t,n)}}function Fx(i,e){let t=this.cache;t[0]!==e&&(i.uniform1i(this.addr,e),t[0]=e)}function Ox(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2i(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(vt(t,e))return;i.uniform2iv(this.addr,e),Mt(t,e)}}function Bx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3i(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if(vt(t,e))return;i.uniform3iv(this.addr,e),Mt(t,e)}}function kx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4i(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(vt(t,e))return;i.uniform4iv(this.addr,e),Mt(t,e)}}function zx(i,e){let t=this.cache;t[0]!==e&&(i.uniform1ui(this.addr,e),t[0]=e)}function Vx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y)&&(i.uniform2ui(this.addr,e.x,e.y),t[0]=e.x,t[1]=e.y);else{if(vt(t,e))return;i.uniform2uiv(this.addr,e),Mt(t,e)}}function Gx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z)&&(i.uniform3ui(this.addr,e.x,e.y,e.z),t[0]=e.x,t[1]=e.y,t[2]=e.z);else{if(vt(t,e))return;i.uniform3uiv(this.addr,e),Mt(t,e)}}function Hx(i,e){let t=this.cache;if(e.x!==void 0)(t[0]!==e.x||t[1]!==e.y||t[2]!==e.z||t[3]!==e.w)&&(i.uniform4ui(this.addr,e.x,e.y,e.z,e.w),t[0]=e.x,t[1]=e.y,t[2]=e.z,t[3]=e.w);else{if(vt(t,e))return;i.uniform4uiv(this.addr,e),Mt(t,e)}}function Wx(i,e,t){let n=this.cache,s=t.allocateTextureUnit();n[0]!==s&&(i.uniform1i(this.addr,s),n[0]=s);let r;this.type===i.SAMPLER_2D_SHADOW?(Ef.compareFunction=sh,r=Ef):r=Hf,t.setTexture2D(e||r,s)}function Xx(i,e,t){let n=this.cache,s=t.allocateTextureUnit();n[0]!==s&&(i.uniform1i(this.addr,s),n[0]=s),t.setTexture3D(e||Xf,s)}function qx(i,e,t){let n=this.cache,s=t.allocateTextureUnit();n[0]!==s&&(i.uniform1i(this.addr,s),n[0]=s),t.setTextureCube(e||qf,s)}function Yx(i,e,t){let n=this.cache,s=t.allocateTextureUnit();n[0]!==s&&(i.uniform1i(this.addr,s),n[0]=s),t.setTexture2DArray(e||Wf,s)}function $x(i){switch(i){case 5126:return Rx;case 35664:return Ix;case 35665:return Px;case 35666:return Lx;case 35674:return Dx;case 35675:return Nx;case 35676:return Ux;case 5124:case 35670:return Fx;case 35667:case 35671:return Ox;case 35668:case 35672:return Bx;case 35669:case 35673:return kx;case 5125:return zx;case 36294:return Vx;case 36295:return Gx;case 36296:return Hx;case 35678:case 36198:case 36298:case 36306:case 35682:return Wx;case 35679:case 36299:case 36307:return Xx;case 35680:case 36300:case 36308:case 36293:return qx;case 36289:case 36303:case 36311:case 36292:return Yx}}function Zx(i,e){i.uniform1fv(this.addr,e)}function jx(i,e){let t=Os(e,this.size,2);i.uniform2fv(this.addr,t)}function Kx(i,e){let t=Os(e,this.size,3);i.uniform3fv(this.addr,t)}function Jx(i,e){let t=Os(e,this.size,4);i.uniform4fv(this.addr,t)}function Qx(i,e){let t=Os(e,this.size,4);i.uniformMatrix2fv(this.addr,!1,t)}function e0(i,e){let t=Os(e,this.size,9);i.uniformMatrix3fv(this.addr,!1,t)}function t0(i,e){let t=Os(e,this.size,16);i.uniformMatrix4fv(this.addr,!1,t)}function n0(i,e){i.uniform1iv(this.addr,e)}function i0(i,e){i.uniform2iv(this.addr,e)}function s0(i,e){i.uniform3iv(this.addr,e)}function r0(i,e){i.uniform4iv(this.addr,e)}function o0(i,e){i.uniform1uiv(this.addr,e)}function a0(i,e){i.uniform2uiv(this.addr,e)}function l0(i,e){i.uniform3uiv(this.addr,e)}function c0(i,e){i.uniform4uiv(this.addr,e)}function h0(i,e,t){let n=this.cache,s=e.length,r=yl(t,s);vt(n,r)||(i.uniform1iv(this.addr,r),Mt(n,r));for(let o=0;o!==s;++o)t.setTexture2D(e[o]||Hf,r[o])}function u0(i,e,t){let n=this.cache,s=e.length,r=yl(t,s);vt(n,r)||(i.uniform1iv(this.addr,r),Mt(n,r));for(let o=0;o!==s;++o)t.setTexture3D(e[o]||Xf,r[o])}function d0(i,e,t){let n=this.cache,s=e.length,r=yl(t,s);vt(n,r)||(i.uniform1iv(this.addr,r),Mt(n,r));for(let o=0;o!==s;++o)t.setTextureCube(e[o]||qf,r[o])}function f0(i,e,t){let n=this.cache,s=e.length,r=yl(t,s);vt(n,r)||(i.uniform1iv(this.addr,r),Mt(n,r));for(let o=0;o!==s;++o)t.setTexture2DArray(e[o]||Wf,r[o])}function p0(i){switch(i){case 5126:return Zx;case 35664:return jx;case 35665:return Kx;case 35666:return Jx;case 35674:return Qx;case 35675:return e0;case 35676:return t0;case 5124:case 35670:return n0;case 35667:case 35671:return i0;case 35668:case 35672:return s0;case 35669:case 35673:return r0;case 5125:return o0;case 36294:return a0;case 36295:return l0;case 36296:return c0;case 35678:case 36198:case 36298:case 36306:case 35682:return h0;case 35679:case 36299:case 36307:return u0;case 35680:case 36300:case 36308:case 36293:return d0;case 36289:case 36303:case 36311:case 36292:return f0}}function Pf(i,e){i.seq.push(e),i.map[e.id]=e}function m0(i,e,t){let n=i.name,s=n.length;for(vh.lastIndex=0;;){let r=vh.exec(n),o=vh.lastIndex,a=r[1],l=r[2]==="]",c=r[3];if(l&&(a=a|0),c===void 0||c==="["&&o+2===s){Pf(t,c===void 0?new Mh(a,i,e):new bh(a,i,e));break}else{let u=t.map[a];u===void 0&&(u=new Sh(a),Pf(t,u)),t=u}}}function Lf(i,e,t){let n=i.createShader(e);return i.shaderSource(n,t),i.compileShader(n),n}function y0(i,e){let t=i.split(`
`),n=[],s=Math.max(e-6,0),r=Math.min(e+6,t.length);for(let o=s;o<r;o++){let a=o+1;n.push(`${a===e?">":" "} ${a}: ${t[o]}`)}return n.join(`
`)}function x0(i){Ye._getMatrix(Df,Ye.workingColorSpace,i);let e=`mat3( ${Df.elements.map(t=>t.toFixed(4))} )`;switch(Ye.getTransfer(i)){case _r:return[e,"LinearTransferOETF"];case Qe:return[e,"sRGBTransferOETF"];default:return console.warn("THREE.WebGLProgram: Unsupported color space: ",i),[e,"LinearTransferOETF"]}}function Nf(i,e,t){let n=i.getShaderParameter(e,i.COMPILE_STATUS),s=i.getShaderInfoLog(e).trim();if(n&&s==="")return"";let r=/ERROR: 0:(\d+)/.exec(s);if(r){let o=parseInt(r[1]);return t.toUpperCase()+`

`+s+`

`+y0(i.getShaderSource(e),o)}else return s}function v0(i,e){let t=x0(e);return[`vec4 ${i}( vec4 value ) {`,`	return ${t[1]}( vec4( value.rgb * ${t[0]}, value.a ) );`,"}"].join(`
`)}function M0(i,e){let t;switch(e){case Hd:t="Linear";break;case Wd:t="Reinhard";break;case Xd:t="Cineon";break;case qd:t="ACESFilmic";break;case $d:t="AgX";break;case Zd:t="Neutral";break;case Yd:t="Custom";break;default:console.warn("THREE.WebGLProgram: Unsupported toneMapping:",e),t="Linear"}return"vec3 "+i+"( vec3 color ) { return "+t+"ToneMapping( color ); }"}function b0(){Ye.getLuminanceCoefficients(ml);let i=ml.x.toFixed(4),e=ml.y.toFixed(4),t=ml.z.toFixed(4);return["float luminance( const in vec3 rgb ) {",`	const vec3 weights = vec3( ${i}, ${e}, ${t} );`,"	return dot( weights, rgb );","}"].join(`
`)}function S0(i){return[i.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":"",i.extensionMultiDraw?"#extension GL_ANGLE_multi_draw : require":""].filter(eo).join(`
`)}function w0(i){let e=[];for(let t in i){let n=i[t];n!==!1&&e.push("#define "+t+" "+n)}return e.join(`
`)}function E0(i,e){let t={},n=i.getProgramParameter(e,i.ACTIVE_ATTRIBUTES);for(let s=0;s<n;s++){let r=i.getActiveAttrib(e,s),o=r.name,a=1;r.type===i.FLOAT_MAT2&&(a=2),r.type===i.FLOAT_MAT3&&(a=3),r.type===i.FLOAT_MAT4&&(a=4),t[o]={type:r.type,location:i.getAttribLocation(e,o),locationSize:a}}return t}function eo(i){return i!==""}function Uf(i,e){let t=e.numSpotLightShadows+e.numSpotLightMaps-e.numSpotLightShadowsWithMaps;return i.replace(/NUM_DIR_LIGHTS/g,e.numDirLights).replace(/NUM_SPOT_LIGHTS/g,e.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,e.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,t).replace(/NUM_RECT_AREA_LIGHTS/g,e.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,e.numPointLights).replace(/NUM_HEMI_LIGHTS/g,e.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,e.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,e.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,e.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,e.numPointLightShadows)}function Ff(i,e){return i.replace(/NUM_CLIPPING_PLANES/g,e.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,e.numClippingPlanes-e.numClipIntersection)}function wh(i){return i.replace(T0,C0)}function C0(i,e){let t=Ve[e];if(t===void 0){let n=A0.get(e);if(n!==void 0)t=Ve[n],console.warn('THREE.WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',e,n);else throw new Error("Can not resolve #include <"+e+">")}return wh(t)}function Of(i){return i.replace(R0,I0)}function I0(i,e,t,n){let s="";for(let r=parseInt(e);r<parseInt(t);r++)s+=n.replace(/\[\s*i\s*\]/g,"[ "+r+" ]").replace(/UNROLLED_LOOP_INDEX/g,r);return s}function Bf(i){let e=`precision ${i.precision} float;
	precision ${i.precision} int;
	precision ${i.precision} sampler2D;
	precision ${i.precision} samplerCube;
	precision ${i.precision} sampler3D;
	precision ${i.precision} sampler2DArray;
	precision ${i.precision} sampler2DShadow;
	precision ${i.precision} samplerCubeShadow;
	precision ${i.precision} sampler2DArrayShadow;
	precision ${i.precision} isampler2D;
	precision ${i.precision} isampler3D;
	precision ${i.precision} isamplerCube;
	precision ${i.precision} isampler2DArray;
	precision ${i.precision} usampler2D;
	precision ${i.precision} usampler3D;
	precision ${i.precision} usamplerCube;
	precision ${i.precision} usampler2DArray;
	`;return i.precision==="highp"?e+=`
#define HIGH_PRECISION`:i.precision==="mediump"?e+=`
#define MEDIUM_PRECISION`:i.precision==="lowp"&&(e+=`
#define LOW_PRECISION`),e}function P0(i){let e="SHADOWMAP_TYPE_BASIC";return i.shadowMapType===Xc?e="SHADOWMAP_TYPE_PCF":i.shadowMapType===bd?e="SHADOWMAP_TYPE_PCF_SOFT":i.shadowMapType===vn&&(e="SHADOWMAP_TYPE_VSM"),e}function L0(i){let e="ENVMAP_TYPE_CUBE";if(i.envMap)switch(i.envMapMode){case Fi:case Oi:e="ENVMAP_TYPE_CUBE";break;case Yr:e="ENVMAP_TYPE_CUBE_UV";break}return e}function D0(i){let e="ENVMAP_MODE_REFLECTION";return i.envMap&&i.envMapMode===Oi&&(e="ENVMAP_MODE_REFRACTION"),e}function N0(i){let e="ENVMAP_BLENDING_NONE";if(i.envMap)switch(i.combine){case Ia:e="ENVMAP_BLENDING_MULTIPLY";break;case Vd:e="ENVMAP_BLENDING_MIX";break;case Gd:e="ENVMAP_BLENDING_ADD";break}return e}function U0(i){let e=i.envMapCubeUVHeight;if(e===null)return null;let t=Math.log2(e)-2,n=1/e;return{texelWidth:1/(3*Math.max(Math.pow(2,t),112)),texelHeight:n,maxMip:t}}function F0(i,e,t,n){let s=i.getContext(),r=t.defines,o=t.vertexShader,a=t.fragmentShader,l=P0(t),c=L0(t),h=D0(t),u=N0(t),p=U0(t),d=S0(t),g=w0(r),_=s.createProgram(),m,f,w=t.glslVersion?"#version "+t.glslVersion+`
`:"";t.isRawShaderMaterial?(m=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,g].filter(eo).join(`
`),m.length>0&&(m+=`
`),f=["#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,g].filter(eo).join(`
`),f.length>0&&(f+=`
`)):(m=[Bf(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,g,t.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",t.batching?"#define USE_BATCHING":"",t.batchingColor?"#define USE_BATCHING_COLOR":"",t.instancing?"#define USE_INSTANCING":"",t.instancingColor?"#define USE_INSTANCING_COLOR":"",t.instancingMorph?"#define USE_INSTANCING_MORPH":"",t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.map?"#define USE_MAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+h:"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.displacementMap?"#define USE_DISPLACEMENTMAP":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.mapUv?"#define MAP_UV "+t.mapUv:"",t.alphaMapUv?"#define ALPHAMAP_UV "+t.alphaMapUv:"",t.lightMapUv?"#define LIGHTMAP_UV "+t.lightMapUv:"",t.aoMapUv?"#define AOMAP_UV "+t.aoMapUv:"",t.emissiveMapUv?"#define EMISSIVEMAP_UV "+t.emissiveMapUv:"",t.bumpMapUv?"#define BUMPMAP_UV "+t.bumpMapUv:"",t.normalMapUv?"#define NORMALMAP_UV "+t.normalMapUv:"",t.displacementMapUv?"#define DISPLACEMENTMAP_UV "+t.displacementMapUv:"",t.metalnessMapUv?"#define METALNESSMAP_UV "+t.metalnessMapUv:"",t.roughnessMapUv?"#define ROUGHNESSMAP_UV "+t.roughnessMapUv:"",t.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+t.anisotropyMapUv:"",t.clearcoatMapUv?"#define CLEARCOATMAP_UV "+t.clearcoatMapUv:"",t.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+t.clearcoatNormalMapUv:"",t.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+t.clearcoatRoughnessMapUv:"",t.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+t.iridescenceMapUv:"",t.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+t.iridescenceThicknessMapUv:"",t.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+t.sheenColorMapUv:"",t.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+t.sheenRoughnessMapUv:"",t.specularMapUv?"#define SPECULARMAP_UV "+t.specularMapUv:"",t.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+t.specularColorMapUv:"",t.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+t.specularIntensityMapUv:"",t.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+t.transmissionMapUv:"",t.thicknessMapUv?"#define THICKNESSMAP_UV "+t.thicknessMapUv:"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexColors?"#define USE_COLOR":"",t.vertexAlphas?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.flatShading?"#define FLAT_SHADED":"",t.skinning?"#define USE_SKINNING":"",t.morphTargets?"#define USE_MORPHTARGETS":"",t.morphNormals&&t.flatShading===!1?"#define USE_MORPHNORMALS":"",t.morphColors?"#define USE_MORPHCOLORS":"",t.morphTargetsCount>0?"#define MORPHTARGETS_TEXTURE_STRIDE "+t.morphTextureStride:"",t.morphTargetsCount>0?"#define MORPHTARGETS_COUNT "+t.morphTargetsCount:"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.sizeAttenuation?"#define USE_SIZEATTENUATION":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",t.reverseDepthBuffer?"#define USE_REVERSEDEPTHBUF":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","#ifdef USE_INSTANCING_MORPH","	uniform sampler2D morphTexture;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(eo).join(`
`),f=[Bf(t),"#define SHADER_TYPE "+t.shaderType,"#define SHADER_NAME "+t.shaderName,g,t.useFog&&t.fog?"#define USE_FOG":"",t.useFog&&t.fogExp2?"#define FOG_EXP2":"",t.alphaToCoverage?"#define ALPHA_TO_COVERAGE":"",t.map?"#define USE_MAP":"",t.matcap?"#define USE_MATCAP":"",t.envMap?"#define USE_ENVMAP":"",t.envMap?"#define "+c:"",t.envMap?"#define "+h:"",t.envMap?"#define "+u:"",p?"#define CUBEUV_TEXEL_WIDTH "+p.texelWidth:"",p?"#define CUBEUV_TEXEL_HEIGHT "+p.texelHeight:"",p?"#define CUBEUV_MAX_MIP "+p.maxMip+".0":"",t.lightMap?"#define USE_LIGHTMAP":"",t.aoMap?"#define USE_AOMAP":"",t.bumpMap?"#define USE_BUMPMAP":"",t.normalMap?"#define USE_NORMALMAP":"",t.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",t.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",t.emissiveMap?"#define USE_EMISSIVEMAP":"",t.anisotropy?"#define USE_ANISOTROPY":"",t.anisotropyMap?"#define USE_ANISOTROPYMAP":"",t.clearcoat?"#define USE_CLEARCOAT":"",t.clearcoatMap?"#define USE_CLEARCOATMAP":"",t.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",t.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",t.dispersion?"#define USE_DISPERSION":"",t.iridescence?"#define USE_IRIDESCENCE":"",t.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",t.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",t.specularMap?"#define USE_SPECULARMAP":"",t.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",t.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",t.roughnessMap?"#define USE_ROUGHNESSMAP":"",t.metalnessMap?"#define USE_METALNESSMAP":"",t.alphaMap?"#define USE_ALPHAMAP":"",t.alphaTest?"#define USE_ALPHATEST":"",t.alphaHash?"#define USE_ALPHAHASH":"",t.sheen?"#define USE_SHEEN":"",t.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",t.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",t.transmission?"#define USE_TRANSMISSION":"",t.transmissionMap?"#define USE_TRANSMISSIONMAP":"",t.thicknessMap?"#define USE_THICKNESSMAP":"",t.vertexTangents&&t.flatShading===!1?"#define USE_TANGENT":"",t.vertexColors||t.instancingColor||t.batchingColor?"#define USE_COLOR":"",t.vertexAlphas?"#define USE_COLOR_ALPHA":"",t.vertexUv1s?"#define USE_UV1":"",t.vertexUv2s?"#define USE_UV2":"",t.vertexUv3s?"#define USE_UV3":"",t.pointsUvs?"#define USE_POINTS_UV":"",t.gradientMap?"#define USE_GRADIENTMAP":"",t.flatShading?"#define FLAT_SHADED":"",t.doubleSided?"#define DOUBLE_SIDED":"",t.flipSided?"#define FLIP_SIDED":"",t.shadowMapEnabled?"#define USE_SHADOWMAP":"",t.shadowMapEnabled?"#define "+l:"",t.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",t.numLightProbes>0?"#define USE_LIGHT_PROBES":"",t.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",t.decodeVideoTextureEmissive?"#define DECODE_VIDEO_TEXTURE_EMISSIVE":"",t.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",t.reverseDepthBuffer?"#define USE_REVERSEDEPTHBUF":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",t.toneMapping!==kn?"#define TONE_MAPPING":"",t.toneMapping!==kn?Ve.tonemapping_pars_fragment:"",t.toneMapping!==kn?M0("toneMapping",t.toneMapping):"",t.dithering?"#define DITHERING":"",t.opaque?"#define OPAQUE":"",Ve.colorspace_pars_fragment,v0("linearToOutputTexel",t.outputColorSpace),b0(),t.useDepthPacking?"#define DEPTH_PACKING "+t.depthPacking:"",`
`].filter(eo).join(`
`)),o=wh(o),o=Uf(o,t),o=Ff(o,t),a=wh(a),a=Uf(a,t),a=Ff(a,t),o=Of(o),a=Of(a),t.isRawShaderMaterial!==!0&&(w=`#version 300 es
`,m=[d,"#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+m,f=["#define varying in",t.glslVersion===rh?"":"layout(location = 0) out highp vec4 pc_fragColor;",t.glslVersion===rh?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+f);let M=w+m+o,v=w+f+a,A=Lf(s,s.VERTEX_SHADER,M),I=Lf(s,s.FRAGMENT_SHADER,v);s.attachShader(_,A),s.attachShader(_,I),t.index0AttributeName!==void 0?s.bindAttribLocation(_,0,t.index0AttributeName):t.morphTargets===!0&&s.bindAttribLocation(_,0,"position"),s.linkProgram(_);function C(T){if(i.debug.checkShaderErrors){let z=s.getProgramInfoLog(_).trim(),O=s.getShaderInfoLog(A).trim(),X=s.getShaderInfoLog(I).trim(),K=!0,k=!0;if(s.getProgramParameter(_,s.LINK_STATUS)===!1)if(K=!1,typeof i.debug.onShaderError=="function")i.debug.onShaderError(s,_,A,I);else{let te=Nf(s,A,"vertex"),W=Nf(s,I,"fragment");console.error("THREE.WebGLProgram: Shader Error "+s.getError()+" - VALIDATE_STATUS "+s.getProgramParameter(_,s.VALIDATE_STATUS)+`

Material Name: `+T.name+`
Material Type: `+T.type+`

Program Info Log: `+z+`
`+te+`
`+W)}else z!==""?console.warn("THREE.WebGLProgram: Program Info Log:",z):(O===""||X==="")&&(k=!1);k&&(T.diagnostics={runnable:K,programLog:z,vertexShader:{log:O,prefix:m},fragmentShader:{log:X,prefix:f}})}s.deleteShader(A),s.deleteShader(I),P=new Fs(s,_),S=E0(s,_)}let P;this.getUniforms=function(){return P===void 0&&C(this),P};let S;this.getAttributes=function(){return S===void 0&&C(this),S};let x=t.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return x===!1&&(x=s.getProgramParameter(_,g0)),x},this.destroy=function(){n.releaseStatesOfProgram(this),s.deleteProgram(_),this.program=void 0},this.type=t.shaderType,this.name=t.shaderName,this.id=_0++,this.cacheKey=e,this.usedTimes=1,this.program=_,this.vertexShader=A,this.fragmentShader=I,this}function B0(i,e,t,n,s,r,o){let a=new xs,l=new Eh,c=new Set,h=[],u=s.logarithmicDepthBuffer,p=s.vertexTextures,d=s.precision,g={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distanceRGBA",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function _(S){return c.add(S),S===0?"uv":`uv${S}`}function m(S,x,T,z,O){let X=z.fog,K=O.geometry,k=S.isMeshStandardMaterial?z.environment:null,te=(S.isMeshStandardMaterial?t:e).get(S.envMap||k),W=te&&te.mapping===Yr?te.image.height:null,se=g[S.type];S.precision!==null&&(d=s.getMaxPrecision(S.precision),d!==S.precision&&console.warn("THREE.WebGLProgram.getParameters:",S.precision,"not supported, using",d,"instead."));let re=K.morphAttributes.position||K.morphAttributes.normal||K.morphAttributes.color,pe=re!==void 0?re.length:0,Ce=0;K.morphAttributes.position!==void 0&&(Ce=1),K.morphAttributes.normal!==void 0&&(Ce=2),K.morphAttributes.color!==void 0&&(Ce=3);let Xe,Z,R,H;if(se){let Je=bn[se];Xe=Je.vertexShader,Z=Je.fragmentShader}else Xe=S.vertexShader,Z=S.fragmentShader,l.update(S),R=l.getVertexShaderID(S),H=l.getFragmentShaderID(S);let q=i.getRenderTarget(),de=i.state.buffers.depth.getReversed(),Re=O.isInstancedMesh===!0,fe=O.isBatchedMesh===!0,xe=!!S.map,je=!!S.matcap,Ge=!!te,L=!!S.aoMap,_t=!!S.lightMap,qe=!!S.bumpMap,$e=!!S.normalMap,me=!!S.displacementMap,ke=!!S.emissiveMap,Se=!!S.metalnessMap,Ue=!!S.roughnessMap,ct=S.anisotropy>0,E=S.clearcoat>0,y=S.dispersion>0,B=S.iridescence>0,Y=S.sheen>0,J=S.transmission>0,$=ct&&!!S.anisotropyMap,we=E&&!!S.clearcoatMap,le=E&&!!S.clearcoatNormalMap,be=E&&!!S.clearcoatRoughnessMap,Ee=B&&!!S.iridescenceMap,Q=B&&!!S.iridescenceThicknessMap,ge=Y&&!!S.sheenColorMap,Pe=Y&&!!S.sheenRoughnessMap,Ie=!!S.specularMap,oe=!!S.specularColorMap,Fe=!!S.specularIntensityMap,N=J&&!!S.transmissionMap,he=J&&!!S.thicknessMap,ee=!!S.gradientMap,ye=!!S.alphaMap,ne=S.alphaTest>0,j=!!S.alphaHash,ve=!!S.extensions,Oe=kn;S.toneMapped&&(q===null||q.isXRRenderTarget===!0)&&(Oe=i.toneMapping);let st={shaderID:se,shaderType:S.type,shaderName:S.name,vertexShader:Xe,fragmentShader:Z,defines:S.defines,customVertexShaderID:R,customFragmentShaderID:H,isRawShaderMaterial:S.isRawShaderMaterial===!0,glslVersion:S.glslVersion,precision:d,batching:fe,batchingColor:fe&&O._colorsTexture!==null,instancing:Re,instancingColor:Re&&O.instanceColor!==null,instancingMorph:Re&&O.morphTexture!==null,supportsVertexTextures:p,outputColorSpace:q===null?i.outputColorSpace:q.isXRRenderTarget===!0?q.texture.colorSpace:Ii,alphaToCoverage:!!S.alphaToCoverage,map:xe,matcap:je,envMap:Ge,envMapMode:Ge&&te.mapping,envMapCubeUVHeight:W,aoMap:L,lightMap:_t,bumpMap:qe,normalMap:$e,displacementMap:p&&me,emissiveMap:ke,normalMapObjectSpace:$e&&S.normalMapType===Qd,normalMapTangentSpace:$e&&S.normalMapType===dl,metalnessMap:Se,roughnessMap:Ue,anisotropy:ct,anisotropyMap:$,clearcoat:E,clearcoatMap:we,clearcoatNormalMap:le,clearcoatRoughnessMap:be,dispersion:y,iridescence:B,iridescenceMap:Ee,iridescenceThicknessMap:Q,sheen:Y,sheenColorMap:ge,sheenRoughnessMap:Pe,specularMap:Ie,specularColorMap:oe,specularIntensityMap:Fe,transmission:J,transmissionMap:N,thicknessMap:he,gradientMap:ee,opaque:S.transparent===!1&&S.blending===Ci&&S.alphaToCoverage===!1,alphaMap:ye,alphaTest:ne,alphaHash:j,combine:S.combine,mapUv:xe&&_(S.map.channel),aoMapUv:L&&_(S.aoMap.channel),lightMapUv:_t&&_(S.lightMap.channel),bumpMapUv:qe&&_(S.bumpMap.channel),normalMapUv:$e&&_(S.normalMap.channel),displacementMapUv:me&&_(S.displacementMap.channel),emissiveMapUv:ke&&_(S.emissiveMap.channel),metalnessMapUv:Se&&_(S.metalnessMap.channel),roughnessMapUv:Ue&&_(S.roughnessMap.channel),anisotropyMapUv:$&&_(S.anisotropyMap.channel),clearcoatMapUv:we&&_(S.clearcoatMap.channel),clearcoatNormalMapUv:le&&_(S.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:be&&_(S.clearcoatRoughnessMap.channel),iridescenceMapUv:Ee&&_(S.iridescenceMap.channel),iridescenceThicknessMapUv:Q&&_(S.iridescenceThicknessMap.channel),sheenColorMapUv:ge&&_(S.sheenColorMap.channel),sheenRoughnessMapUv:Pe&&_(S.sheenRoughnessMap.channel),specularMapUv:Ie&&_(S.specularMap.channel),specularColorMapUv:oe&&_(S.specularColorMap.channel),specularIntensityMapUv:Fe&&_(S.specularIntensityMap.channel),transmissionMapUv:N&&_(S.transmissionMap.channel),thicknessMapUv:he&&_(S.thicknessMap.channel),alphaMapUv:ye&&_(S.alphaMap.channel),vertexTangents:!!K.attributes.tangent&&($e||ct),vertexColors:S.vertexColors,vertexAlphas:S.vertexColors===!0&&!!K.attributes.color&&K.attributes.color.itemSize===4,pointsUvs:O.isPoints===!0&&!!K.attributes.uv&&(xe||ye),fog:!!X,useFog:S.fog===!0,fogExp2:!!X&&X.isFogExp2,flatShading:S.flatShading===!0&&S.wireframe===!1,sizeAttenuation:S.sizeAttenuation===!0,logarithmicDepthBuffer:u,reverseDepthBuffer:de,skinning:O.isSkinnedMesh===!0,morphTargets:K.morphAttributes.position!==void 0,morphNormals:K.morphAttributes.normal!==void 0,morphColors:K.morphAttributes.color!==void 0,morphTargetsCount:pe,morphTextureStride:Ce,numDirLights:x.directional.length,numPointLights:x.point.length,numSpotLights:x.spot.length,numSpotLightMaps:x.spotLightMap.length,numRectAreaLights:x.rectArea.length,numHemiLights:x.hemi.length,numDirLightShadows:x.directionalShadowMap.length,numPointLightShadows:x.pointShadowMap.length,numSpotLightShadows:x.spotShadowMap.length,numSpotLightShadowsWithMaps:x.numSpotLightShadowsWithMaps,numLightProbes:x.numLightProbes,numClippingPlanes:o.numPlanes,numClipIntersection:o.numIntersection,dithering:S.dithering,shadowMapEnabled:i.shadowMap.enabled&&T.length>0,shadowMapType:i.shadowMap.type,toneMapping:Oe,decodeVideoTexture:xe&&S.map.isVideoTexture===!0&&Ye.getTransfer(S.map.colorSpace)===Qe,decodeVideoTextureEmissive:ke&&S.emissiveMap.isVideoTexture===!0&&Ye.getTransfer(S.emissiveMap.colorSpace)===Qe,premultipliedAlpha:S.premultipliedAlpha,doubleSided:S.side===Rt,flipSided:S.side===Ft,useDepthPacking:S.depthPacking>=0,depthPacking:S.depthPacking||0,index0AttributeName:S.index0AttributeName,extensionClipCullDistance:ve&&S.extensions.clipCullDistance===!0&&n.has("WEBGL_clip_cull_distance"),extensionMultiDraw:(ve&&S.extensions.multiDraw===!0||fe)&&n.has("WEBGL_multi_draw"),rendererExtensionParallelShaderCompile:n.has("KHR_parallel_shader_compile"),customProgramCacheKey:S.customProgramCacheKey()};return st.vertexUv1s=c.has(1),st.vertexUv2s=c.has(2),st.vertexUv3s=c.has(3),c.clear(),st}function f(S){let x=[];if(S.shaderID?x.push(S.shaderID):(x.push(S.customVertexShaderID),x.push(S.customFragmentShaderID)),S.defines!==void 0)for(let T in S.defines)x.push(T),x.push(S.defines[T]);return S.isRawShaderMaterial===!1&&(w(x,S),M(x,S),x.push(i.outputColorSpace)),x.push(S.customProgramCacheKey),x.join()}function w(S,x){S.push(x.precision),S.push(x.outputColorSpace),S.push(x.envMapMode),S.push(x.envMapCubeUVHeight),S.push(x.mapUv),S.push(x.alphaMapUv),S.push(x.lightMapUv),S.push(x.aoMapUv),S.push(x.bumpMapUv),S.push(x.normalMapUv),S.push(x.displacementMapUv),S.push(x.emissiveMapUv),S.push(x.metalnessMapUv),S.push(x.roughnessMapUv),S.push(x.anisotropyMapUv),S.push(x.clearcoatMapUv),S.push(x.clearcoatNormalMapUv),S.push(x.clearcoatRoughnessMapUv),S.push(x.iridescenceMapUv),S.push(x.iridescenceThicknessMapUv),S.push(x.sheenColorMapUv),S.push(x.sheenRoughnessMapUv),S.push(x.specularMapUv),S.push(x.specularColorMapUv),S.push(x.specularIntensityMapUv),S.push(x.transmissionMapUv),S.push(x.thicknessMapUv),S.push(x.combine),S.push(x.fogExp2),S.push(x.sizeAttenuation),S.push(x.morphTargetsCount),S.push(x.morphAttributeCount),S.push(x.numDirLights),S.push(x.numPointLights),S.push(x.numSpotLights),S.push(x.numSpotLightMaps),S.push(x.numHemiLights),S.push(x.numRectAreaLights),S.push(x.numDirLightShadows),S.push(x.numPointLightShadows),S.push(x.numSpotLightShadows),S.push(x.numSpotLightShadowsWithMaps),S.push(x.numLightProbes),S.push(x.shadowMapType),S.push(x.toneMapping),S.push(x.numClippingPlanes),S.push(x.numClipIntersection),S.push(x.depthPacking)}function M(S,x){a.disableAll(),x.supportsVertexTextures&&a.enable(0),x.instancing&&a.enable(1),x.instancingColor&&a.enable(2),x.instancingMorph&&a.enable(3),x.matcap&&a.enable(4),x.envMap&&a.enable(5),x.normalMapObjectSpace&&a.enable(6),x.normalMapTangentSpace&&a.enable(7),x.clearcoat&&a.enable(8),x.iridescence&&a.enable(9),x.alphaTest&&a.enable(10),x.vertexColors&&a.enable(11),x.vertexAlphas&&a.enable(12),x.vertexUv1s&&a.enable(13),x.vertexUv2s&&a.enable(14),x.vertexUv3s&&a.enable(15),x.vertexTangents&&a.enable(16),x.anisotropy&&a.enable(17),x.alphaHash&&a.enable(18),x.batching&&a.enable(19),x.dispersion&&a.enable(20),x.batchingColor&&a.enable(21),x.gradientMap&&a.enable(22),S.push(a.mask),a.disableAll(),x.fog&&a.enable(0),x.useFog&&a.enable(1),x.flatShading&&a.enable(2),x.logarithmicDepthBuffer&&a.enable(3),x.reverseDepthBuffer&&a.enable(4),x.skinning&&a.enable(5),x.morphTargets&&a.enable(6),x.morphNormals&&a.enable(7),x.morphColors&&a.enable(8),x.premultipliedAlpha&&a.enable(9),x.shadowMapEnabled&&a.enable(10),x.doubleSided&&a.enable(11),x.flipSided&&a.enable(12),x.useDepthPacking&&a.enable(13),x.dithering&&a.enable(14),x.transmission&&a.enable(15),x.sheen&&a.enable(16),x.opaque&&a.enable(17),x.pointsUvs&&a.enable(18),x.decodeVideoTexture&&a.enable(19),x.decodeVideoTextureEmissive&&a.enable(20),x.alphaToCoverage&&a.enable(21),S.push(a.mask)}function v(S){let x=g[S.type],T;if(x){let z=bn[x];T=ff.clone(z.uniforms)}else T=S.uniforms;return T}function A(S,x){let T;for(let z=0,O=h.length;z<O;z++){let X=h[z];if(X.cacheKey===x){T=X,++T.usedTimes;break}}return T===void 0&&(T=new F0(i,x,S,r),h.push(T)),T}function I(S){if(--S.usedTimes===0){let x=h.indexOf(S);h[x]=h[h.length-1],h.pop(),S.destroy()}}function C(S){l.remove(S)}function P(){l.dispose()}return{getParameters:m,getProgramCacheKey:f,getUniforms:v,acquireProgram:A,releaseProgram:I,releaseShaderCache:C,programs:h,dispose:P}}function k0(){let i=new WeakMap;function e(o){return i.has(o)}function t(o){let a=i.get(o);return a===void 0&&(a={},i.set(o,a)),a}function n(o){i.delete(o)}function s(o,a,l){i.get(o)[a]=l}function r(){i=new WeakMap}return{has:e,get:t,remove:n,update:s,dispose:r}}function z0(i,e){return i.groupOrder!==e.groupOrder?i.groupOrder-e.groupOrder:i.renderOrder!==e.renderOrder?i.renderOrder-e.renderOrder:i.material.id!==e.material.id?i.material.id-e.material.id:i.z!==e.z?i.z-e.z:i.id-e.id}function kf(i,e){return i.groupOrder!==e.groupOrder?i.groupOrder-e.groupOrder:i.renderOrder!==e.renderOrder?i.renderOrder-e.renderOrder:i.z!==e.z?e.z-i.z:i.id-e.id}function zf(){let i=[],e=0,t=[],n=[],s=[];function r(){e=0,t.length=0,n.length=0,s.length=0}function o(u,p,d,g,_,m){let f=i[e];return f===void 0?(f={id:u.id,object:u,geometry:p,material:d,groupOrder:g,renderOrder:u.renderOrder,z:_,group:m},i[e]=f):(f.id=u.id,f.object=u,f.geometry=p,f.material=d,f.groupOrder=g,f.renderOrder=u.renderOrder,f.z=_,f.group=m),e++,f}function a(u,p,d,g,_,m){let f=o(u,p,d,g,_,m);d.transmission>0?n.push(f):d.transparent===!0?s.push(f):t.push(f)}function l(u,p,d,g,_,m){let f=o(u,p,d,g,_,m);d.transmission>0?n.unshift(f):d.transparent===!0?s.unshift(f):t.unshift(f)}function c(u,p){t.length>1&&t.sort(u||z0),n.length>1&&n.sort(p||kf),s.length>1&&s.sort(p||kf)}function h(){for(let u=e,p=i.length;u<p;u++){let d=i[u];if(d.id===null)break;d.id=null,d.object=null,d.geometry=null,d.material=null,d.group=null}}return{opaque:t,transmissive:n,transparent:s,init:r,push:a,unshift:l,finish:h,sort:c}}function V0(){let i=new WeakMap;function e(n,s){let r=i.get(n),o;return r===void 0?(o=new zf,i.set(n,[o])):s>=r.length?(o=new zf,r.push(o)):o=r[s],o}function t(){i=new WeakMap}return{get:e,dispose:t}}function G0(){let i={};return{get:function(e){if(i[e.id]!==void 0)return i[e.id];let t;switch(e.type){case"DirectionalLight":t={direction:new D,color:new Ne};break;case"SpotLight":t={position:new D,direction:new D,color:new Ne,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":t={position:new D,color:new Ne,distance:0,decay:0};break;case"HemisphereLight":t={direction:new D,skyColor:new Ne,groundColor:new Ne};break;case"RectAreaLight":t={color:new Ne,position:new D,halfWidth:new D,halfHeight:new D};break}return i[e.id]=t,t}}}function H0(){let i={};return{get:function(e){if(i[e.id]!==void 0)return i[e.id];let t;switch(e.type){case"DirectionalLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new ce};break;case"SpotLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new ce};break;case"PointLight":t={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new ce,shadowCameraNear:1,shadowCameraFar:1e3};break}return i[e.id]=t,t}}}function X0(i,e){return(e.castShadow?2:0)-(i.castShadow?2:0)+(e.map?1:0)-(i.map?1:0)}function q0(i){let e=new G0,t=H0(),n={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let c=0;c<9;c++)n.probe.push(new D);let s=new D,r=new it,o=new it;function a(c){let h=0,u=0,p=0;for(let S=0;S<9;S++)n.probe[S].set(0,0,0);let d=0,g=0,_=0,m=0,f=0,w=0,M=0,v=0,A=0,I=0,C=0;c.sort(X0);for(let S=0,x=c.length;S<x;S++){let T=c[S],z=T.color,O=T.intensity,X=T.distance,K=T.shadow&&T.shadow.map?T.shadow.map.texture:null;if(T.isAmbientLight)h+=z.r*O,u+=z.g*O,p+=z.b*O;else if(T.isLightProbe){for(let k=0;k<9;k++)n.probe[k].addScaledVector(T.sh.coefficients[k],O);C++}else if(T.isDirectionalLight){let k=e.get(T);if(k.color.copy(T.color).multiplyScalar(T.intensity),T.castShadow){let te=T.shadow,W=t.get(T);W.shadowIntensity=te.intensity,W.shadowBias=te.bias,W.shadowNormalBias=te.normalBias,W.shadowRadius=te.radius,W.shadowMapSize=te.mapSize,n.directionalShadow[d]=W,n.directionalShadowMap[d]=K,n.directionalShadowMatrix[d]=T.shadow.matrix,w++}n.directional[d]=k,d++}else if(T.isSpotLight){let k=e.get(T);k.position.setFromMatrixPosition(T.matrixWorld),k.color.copy(z).multiplyScalar(O),k.distance=X,k.coneCos=Math.cos(T.angle),k.penumbraCos=Math.cos(T.angle*(1-T.penumbra)),k.decay=T.decay,n.spot[_]=k;let te=T.shadow;if(T.map&&(n.spotLightMap[A]=T.map,A++,te.updateMatrices(T),T.castShadow&&I++),n.spotLightMatrix[_]=te.matrix,T.castShadow){let W=t.get(T);W.shadowIntensity=te.intensity,W.shadowBias=te.bias,W.shadowNormalBias=te.normalBias,W.shadowRadius=te.radius,W.shadowMapSize=te.mapSize,n.spotShadow[_]=W,n.spotShadowMap[_]=K,v++}_++}else if(T.isRectAreaLight){let k=e.get(T);k.color.copy(z).multiplyScalar(O),k.halfWidth.set(T.width*.5,0,0),k.halfHeight.set(0,T.height*.5,0),n.rectArea[m]=k,m++}else if(T.isPointLight){let k=e.get(T);if(k.color.copy(T.color).multiplyScalar(T.intensity),k.distance=T.distance,k.decay=T.decay,T.castShadow){let te=T.shadow,W=t.get(T);W.shadowIntensity=te.intensity,W.shadowBias=te.bias,W.shadowNormalBias=te.normalBias,W.shadowRadius=te.radius,W.shadowMapSize=te.mapSize,W.shadowCameraNear=te.camera.near,W.shadowCameraFar=te.camera.far,n.pointShadow[g]=W,n.pointShadowMap[g]=K,n.pointShadowMatrix[g]=T.shadow.matrix,M++}n.point[g]=k,g++}else if(T.isHemisphereLight){let k=e.get(T);k.skyColor.copy(T.color).multiplyScalar(O),k.groundColor.copy(T.groundColor).multiplyScalar(O),n.hemi[f]=k,f++}}m>0&&(i.has("OES_texture_float_linear")===!0?(n.rectAreaLTC1=ae.LTC_FLOAT_1,n.rectAreaLTC2=ae.LTC_FLOAT_2):(n.rectAreaLTC1=ae.LTC_HALF_1,n.rectAreaLTC2=ae.LTC_HALF_2)),n.ambient[0]=h,n.ambient[1]=u,n.ambient[2]=p;let P=n.hash;(P.directionalLength!==d||P.pointLength!==g||P.spotLength!==_||P.rectAreaLength!==m||P.hemiLength!==f||P.numDirectionalShadows!==w||P.numPointShadows!==M||P.numSpotShadows!==v||P.numSpotMaps!==A||P.numLightProbes!==C)&&(n.directional.length=d,n.spot.length=_,n.rectArea.length=m,n.point.length=g,n.hemi.length=f,n.directionalShadow.length=w,n.directionalShadowMap.length=w,n.pointShadow.length=M,n.pointShadowMap.length=M,n.spotShadow.length=v,n.spotShadowMap.length=v,n.directionalShadowMatrix.length=w,n.pointShadowMatrix.length=M,n.spotLightMatrix.length=v+A-I,n.spotLightMap.length=A,n.numSpotLightShadowsWithMaps=I,n.numLightProbes=C,P.directionalLength=d,P.pointLength=g,P.spotLength=_,P.rectAreaLength=m,P.hemiLength=f,P.numDirectionalShadows=w,P.numPointShadows=M,P.numSpotShadows=v,P.numSpotMaps=A,P.numLightProbes=C,n.version=W0++)}function l(c,h){let u=0,p=0,d=0,g=0,_=0,m=h.matrixWorldInverse;for(let f=0,w=c.length;f<w;f++){let M=c[f];if(M.isDirectionalLight){let v=n.directional[u];v.direction.setFromMatrixPosition(M.matrixWorld),s.setFromMatrixPosition(M.target.matrixWorld),v.direction.sub(s),v.direction.transformDirection(m),u++}else if(M.isSpotLight){let v=n.spot[d];v.position.setFromMatrixPosition(M.matrixWorld),v.position.applyMatrix4(m),v.direction.setFromMatrixPosition(M.matrixWorld),s.setFromMatrixPosition(M.target.matrixWorld),v.direction.sub(s),v.direction.transformDirection(m),d++}else if(M.isRectAreaLight){let v=n.rectArea[g];v.position.setFromMatrixPosition(M.matrixWorld),v.position.applyMatrix4(m),o.identity(),r.copy(M.matrixWorld),r.premultiply(m),o.extractRotation(r),v.halfWidth.set(M.width*.5,0,0),v.halfHeight.set(0,M.height*.5,0),v.halfWidth.applyMatrix4(o),v.halfHeight.applyMatrix4(o),g++}else if(M.isPointLight){let v=n.point[p];v.position.setFromMatrixPosition(M.matrixWorld),v.position.applyMatrix4(m),p++}else if(M.isHemisphereLight){let v=n.hemi[_];v.direction.setFromMatrixPosition(M.matrixWorld),v.direction.transformDirection(m),_++}}}return{setup:a,setupView:l,state:n}}function Vf(i){let e=new q0(i),t=[],n=[];function s(h){c.camera=h,t.length=0,n.length=0}function r(h){t.push(h)}function o(h){n.push(h)}function a(){e.setup(t)}function l(h){e.setupView(t,h)}let c={lightsArray:t,shadowsArray:n,camera:null,lights:e,transmissionRenderTarget:{}};return{init:s,state:c,setupLights:a,setupLightsView:l,pushLight:r,pushShadow:o}}function Y0(i){let e=new WeakMap;function t(s,r=0){let o=e.get(s),a;return o===void 0?(a=new Vf(i),e.set(s,[a])):r>=o.length?(a=new Vf(i),o.push(a)):a=o[r],a}function n(){e=new WeakMap}return{get:t,dispose:n}}function j0(i,e,t){let n=new bs,s=new ce,r=new ce,o=new pt,a=new ua({depthPacking:Jd}),l=new da,c={},h=t.maxTextureSize,u={[Nn]:Ft,[Ft]:Nn,[Rt]:Rt},p=new mn({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new ce},radius:{value:4}},vertexShader:$0,fragmentShader:Z0}),d=p.clone();d.defines.HORIZONTAL_PASS=1;let g=new lt;g.setAttribute("position",new Ke(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));let _=new gt(g,p),m=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=Xc;let f=this.type;this.render=function(I,C,P){if(m.enabled===!1||m.autoUpdate===!1&&m.needsUpdate===!1||I.length===0)return;let S=i.getRenderTarget(),x=i.getActiveCubeFace(),T=i.getActiveMipmapLevel(),z=i.state;z.setBlending(Bn),z.buffers.color.setClear(1,1,1,1),z.buffers.depth.setTest(!0),z.setScissorTest(!1);let O=f!==vn&&this.type===vn,X=f===vn&&this.type!==vn;for(let K=0,k=I.length;K<k;K++){let te=I[K],W=te.shadow;if(W===void 0){console.warn("THREE.WebGLShadowMap:",te,"has no shadow.");continue}if(W.autoUpdate===!1&&W.needsUpdate===!1)continue;s.copy(W.mapSize);let se=W.getFrameExtents();if(s.multiply(se),r.copy(W.mapSize),(s.x>h||s.y>h)&&(s.x>h&&(r.x=Math.floor(h/se.x),s.x=r.x*se.x,W.mapSize.x=r.x),s.y>h&&(r.y=Math.floor(h/se.y),s.y=r.y*se.y,W.mapSize.y=r.y)),W.map===null||O===!0||X===!0){let pe=this.type!==vn?{minFilter:zt,magFilter:zt}:{};W.map!==null&&W.map.dispose(),W.map=new rn(s.x,s.y,pe),W.map.texture.name=te.name+".shadowMap",W.camera.updateProjectionMatrix()}i.setRenderTarget(W.map),i.clear();let re=W.getViewportCount();for(let pe=0;pe<re;pe++){let Ce=W.getViewport(pe);o.set(r.x*Ce.x,r.y*Ce.y,r.x*Ce.z,r.y*Ce.w),z.viewport(o),W.updateMatrices(te,pe),n=W.getFrustum(),v(C,P,W.camera,te,this.type)}W.isPointLightShadow!==!0&&this.type===vn&&w(W,P),W.needsUpdate=!1}f=this.type,m.needsUpdate=!1,i.setRenderTarget(S,x,T)};function w(I,C){let P=e.update(_);p.defines.VSM_SAMPLES!==I.blurSamples&&(p.defines.VSM_SAMPLES=I.blurSamples,d.defines.VSM_SAMPLES=I.blurSamples,p.needsUpdate=!0,d.needsUpdate=!0),I.mapPass===null&&(I.mapPass=new rn(s.x,s.y)),p.uniforms.shadow_pass.value=I.map.texture,p.uniforms.resolution.value=I.mapSize,p.uniforms.radius.value=I.radius,i.setRenderTarget(I.mapPass),i.clear(),i.renderBufferDirect(C,null,P,p,_,null),d.uniforms.shadow_pass.value=I.mapPass.texture,d.uniforms.resolution.value=I.mapSize,d.uniforms.radius.value=I.radius,i.setRenderTarget(I.map),i.clear(),i.renderBufferDirect(C,null,P,d,_,null)}function M(I,C,P,S){let x=null,T=P.isPointLight===!0?I.customDistanceMaterial:I.customDepthMaterial;if(T!==void 0)x=T;else if(x=P.isPointLight===!0?l:a,i.localClippingEnabled&&C.clipShadows===!0&&Array.isArray(C.clippingPlanes)&&C.clippingPlanes.length!==0||C.displacementMap&&C.displacementScale!==0||C.alphaMap&&C.alphaTest>0||C.map&&C.alphaTest>0||C.alphaToCoverage===!0){let z=x.uuid,O=C.uuid,X=c[z];X===void 0&&(X={},c[z]=X);let K=X[O];K===void 0&&(K=x.clone(),X[O]=K,C.addEventListener("dispose",A)),x=K}if(x.visible=C.visible,x.wireframe=C.wireframe,S===vn?x.side=C.shadowSide!==null?C.shadowSide:C.side:x.side=C.shadowSide!==null?C.shadowSide:u[C.side],x.alphaMap=C.alphaMap,x.alphaTest=C.alphaToCoverage===!0?.5:C.alphaTest,x.map=C.map,x.clipShadows=C.clipShadows,x.clippingPlanes=C.clippingPlanes,x.clipIntersection=C.clipIntersection,x.displacementMap=C.displacementMap,x.displacementScale=C.displacementScale,x.displacementBias=C.displacementBias,x.wireframeLinewidth=C.wireframeLinewidth,x.linewidth=C.linewidth,P.isPointLight===!0&&x.isMeshDistanceMaterial===!0){let z=i.properties.get(x);z.light=P}return x}function v(I,C,P,S,x){if(I.visible===!1)return;if(I.layers.test(C.layers)&&(I.isMesh||I.isLine||I.isPoints)&&(I.castShadow||I.receiveShadow&&x===vn)&&(!I.frustumCulled||n.intersectsObject(I))){I.modelViewMatrix.multiplyMatrices(P.matrixWorldInverse,I.matrixWorld);let O=e.update(I),X=I.material;if(Array.isArray(X)){let K=O.groups;for(let k=0,te=K.length;k<te;k++){let W=K[k],se=X[W.materialIndex];if(se&&se.visible){let re=M(I,se,S,x);I.onBeforeShadow(i,I,C,P,O,re,W),i.renderBufferDirect(P,null,O,re,I,W),I.onAfterShadow(i,I,C,P,O,re,W)}}}else if(X.visible){let K=M(I,X,S,x);I.onBeforeShadow(i,I,C,P,O,K,null),i.renderBufferDirect(P,null,O,K,I,null),I.onAfterShadow(i,I,C,P,O,K,null)}}let z=I.children;for(let O=0,X=z.length;O<X;O++)v(z[O],C,P,S,x)}function A(I){I.target.removeEventListener("dispose",A);for(let P in c){let S=c[P],x=I.target.uuid;x in S&&(S[x].dispose(),delete S[x])}}}function J0(i,e){function t(){let N=!1,he=new pt,ee=null,ye=new pt(0,0,0,0);return{setMask:function(ne){ee!==ne&&!N&&(i.colorMask(ne,ne,ne,ne),ee=ne)},setLocked:function(ne){N=ne},setClear:function(ne,j,ve,Oe,st){st===!0&&(ne*=Oe,j*=Oe,ve*=Oe),he.set(ne,j,ve,Oe),ye.equals(he)===!1&&(i.clearColor(ne,j,ve,Oe),ye.copy(he))},reset:function(){N=!1,ee=null,ye.set(-1,0,0,0)}}}function n(){let N=!1,he=!1,ee=null,ye=null,ne=null;return{setReversed:function(j){if(he!==j){let ve=e.get("EXT_clip_control");j?ve.clipControlEXT(ve.LOWER_LEFT_EXT,ve.ZERO_TO_ONE_EXT):ve.clipControlEXT(ve.LOWER_LEFT_EXT,ve.NEGATIVE_ONE_TO_ONE_EXT),he=j;let Oe=ne;ne=null,this.setClear(Oe)}},getReversed:function(){return he},setTest:function(j){j?q(i.DEPTH_TEST):de(i.DEPTH_TEST)},setMask:function(j){ee!==j&&!N&&(i.depthMask(j),ee=j)},setFunc:function(j){if(he&&(j=K0[j]),ye!==j){switch(j){case Sa:i.depthFunc(i.NEVER);break;case wa:i.depthFunc(i.ALWAYS);break;case Ea:i.depthFunc(i.LESS);break;case Ri:i.depthFunc(i.LEQUAL);break;case Ta:i.depthFunc(i.EQUAL);break;case Aa:i.depthFunc(i.GEQUAL);break;case Ca:i.depthFunc(i.GREATER);break;case Ra:i.depthFunc(i.NOTEQUAL);break;default:i.depthFunc(i.LEQUAL)}ye=j}},setLocked:function(j){N=j},setClear:function(j){ne!==j&&(he&&(j=1-j),i.clearDepth(j),ne=j)},reset:function(){N=!1,ee=null,ye=null,ne=null,he=!1}}}function s(){let N=!1,he=null,ee=null,ye=null,ne=null,j=null,ve=null,Oe=null,st=null;return{setTest:function(Je){N||(Je?q(i.STENCIL_TEST):de(i.STENCIL_TEST))},setMask:function(Je){he!==Je&&!N&&(i.stencilMask(Je),he=Je)},setFunc:function(Je,ln,Sn){(ee!==Je||ye!==ln||ne!==Sn)&&(i.stencilFunc(Je,ln,Sn),ee=Je,ye=ln,ne=Sn)},setOp:function(Je,ln,Sn){(j!==Je||ve!==ln||Oe!==Sn)&&(i.stencilOp(Je,ln,Sn),j=Je,ve=ln,Oe=Sn)},setLocked:function(Je){N=Je},setClear:function(Je){st!==Je&&(i.clearStencil(Je),st=Je)},reset:function(){N=!1,he=null,ee=null,ye=null,ne=null,j=null,ve=null,Oe=null,st=null}}}let r=new t,o=new n,a=new s,l=new WeakMap,c=new WeakMap,h={},u={},p=new WeakMap,d=[],g=null,_=!1,m=null,f=null,w=null,M=null,v=null,A=null,I=null,C=new Ne(0,0,0),P=0,S=!1,x=null,T=null,z=null,O=null,X=null,K=i.getParameter(i.MAX_COMBINED_TEXTURE_IMAGE_UNITS),k=!1,te=0,W=i.getParameter(i.VERSION);W.indexOf("WebGL")!==-1?(te=parseFloat(/^WebGL (\d)/.exec(W)[1]),k=te>=1):W.indexOf("OpenGL ES")!==-1&&(te=parseFloat(/^OpenGL ES (\d)/.exec(W)[1]),k=te>=2);let se=null,re={},pe=i.getParameter(i.SCISSOR_BOX),Ce=i.getParameter(i.VIEWPORT),Xe=new pt().fromArray(pe),Z=new pt().fromArray(Ce);function R(N,he,ee,ye){let ne=new Uint8Array(4),j=i.createTexture();i.bindTexture(N,j),i.texParameteri(N,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(N,i.TEXTURE_MAG_FILTER,i.NEAREST);for(let ve=0;ve<ee;ve++)N===i.TEXTURE_3D||N===i.TEXTURE_2D_ARRAY?i.texImage3D(he,0,i.RGBA,1,1,ye,0,i.RGBA,i.UNSIGNED_BYTE,ne):i.texImage2D(he+ve,0,i.RGBA,1,1,0,i.RGBA,i.UNSIGNED_BYTE,ne);return j}let H={};H[i.TEXTURE_2D]=R(i.TEXTURE_2D,i.TEXTURE_2D,1),H[i.TEXTURE_CUBE_MAP]=R(i.TEXTURE_CUBE_MAP,i.TEXTURE_CUBE_MAP_POSITIVE_X,6),H[i.TEXTURE_2D_ARRAY]=R(i.TEXTURE_2D_ARRAY,i.TEXTURE_2D_ARRAY,1,1),H[i.TEXTURE_3D]=R(i.TEXTURE_3D,i.TEXTURE_3D,1,1),r.setClear(0,0,0,1),o.setClear(1),a.setClear(0),q(i.DEPTH_TEST),o.setFunc(Ri),qe(!1),$e(Wc),q(i.CULL_FACE),L(Bn);function q(N){h[N]!==!0&&(i.enable(N),h[N]=!0)}function de(N){h[N]!==!1&&(i.disable(N),h[N]=!1)}function Re(N,he){return u[N]!==he?(i.bindFramebuffer(N,he),u[N]=he,N===i.DRAW_FRAMEBUFFER&&(u[i.FRAMEBUFFER]=he),N===i.FRAMEBUFFER&&(u[i.DRAW_FRAMEBUFFER]=he),!0):!1}function fe(N,he){let ee=d,ye=!1;if(N){ee=p.get(he),ee===void 0&&(ee=[],p.set(he,ee));let ne=N.textures;if(ee.length!==ne.length||ee[0]!==i.COLOR_ATTACHMENT0){for(let j=0,ve=ne.length;j<ve;j++)ee[j]=i.COLOR_ATTACHMENT0+j;ee.length=ne.length,ye=!0}}else ee[0]!==i.BACK&&(ee[0]=i.BACK,ye=!0);ye&&i.drawBuffers(ee)}function xe(N){return g!==N?(i.useProgram(N),g=N,!0):!1}let je={[ei]:i.FUNC_ADD,[wd]:i.FUNC_SUBTRACT,[Ed]:i.FUNC_REVERSE_SUBTRACT};je[Td]=i.MIN,je[Ad]=i.MAX;let Ge={[Cd]:i.ZERO,[Rd]:i.ONE,[Id]:i.SRC_COLOR,[Yo]:i.SRC_ALPHA,[Fd]:i.SRC_ALPHA_SATURATE,[Nd]:i.DST_COLOR,[Ld]:i.DST_ALPHA,[Pd]:i.ONE_MINUS_SRC_COLOR,[$o]:i.ONE_MINUS_SRC_ALPHA,[Ud]:i.ONE_MINUS_DST_COLOR,[Dd]:i.ONE_MINUS_DST_ALPHA,[Od]:i.CONSTANT_COLOR,[Bd]:i.ONE_MINUS_CONSTANT_COLOR,[kd]:i.CONSTANT_ALPHA,[zd]:i.ONE_MINUS_CONSTANT_ALPHA};function L(N,he,ee,ye,ne,j,ve,Oe,st,Je){if(N===Bn){_===!0&&(de(i.BLEND),_=!1);return}if(_===!1&&(q(i.BLEND),_=!0),N!==Sd){if(N!==m||Je!==S){if((f!==ei||v!==ei)&&(i.blendEquation(i.FUNC_ADD),f=ei,v=ei),Je)switch(N){case Ci:i.blendFuncSeparate(i.ONE,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA);break;case qc:i.blendFunc(i.ONE,i.ONE);break;case Yc:i.blendFuncSeparate(i.ZERO,i.ONE_MINUS_SRC_COLOR,i.ZERO,i.ONE);break;case $c:i.blendFuncSeparate(i.DST_COLOR,i.ONE_MINUS_SRC_ALPHA,i.ZERO,i.ONE);break;default:console.error("THREE.WebGLState: Invalid blending: ",N);break}else switch(N){case Ci:i.blendFuncSeparate(i.SRC_ALPHA,i.ONE_MINUS_SRC_ALPHA,i.ONE,i.ONE_MINUS_SRC_ALPHA);break;case qc:i.blendFuncSeparate(i.SRC_ALPHA,i.ONE,i.ONE,i.ONE);break;case Yc:console.error("THREE.WebGLState: SubtractiveBlending requires material.premultipliedAlpha = true");break;case $c:console.error("THREE.WebGLState: MultiplyBlending requires material.premultipliedAlpha = true");break;default:console.error("THREE.WebGLState: Invalid blending: ",N);break}w=null,M=null,A=null,I=null,C.set(0,0,0),P=0,m=N,S=Je}return}ne=ne||he,j=j||ee,ve=ve||ye,(he!==f||ne!==v)&&(i.blendEquationSeparate(je[he],je[ne]),f=he,v=ne),(ee!==w||ye!==M||j!==A||ve!==I)&&(i.blendFuncSeparate(Ge[ee],Ge[ye],Ge[j],Ge[ve]),w=ee,M=ye,A=j,I=ve),(Oe.equals(C)===!1||st!==P)&&(i.blendColor(Oe.r,Oe.g,Oe.b,st),C.copy(Oe),P=st),m=N,S=!1}function _t(N,he){N.side===Rt?de(i.CULL_FACE):q(i.CULL_FACE);let ee=N.side===Ft;he&&(ee=!ee),qe(ee),N.blending===Ci&&N.transparent===!1?L(Bn):L(N.blending,N.blendEquation,N.blendSrc,N.blendDst,N.blendEquationAlpha,N.blendSrcAlpha,N.blendDstAlpha,N.blendColor,N.blendAlpha,N.premultipliedAlpha),o.setFunc(N.depthFunc),o.setTest(N.depthTest),o.setMask(N.depthWrite),r.setMask(N.colorWrite);let ye=N.stencilWrite;a.setTest(ye),ye&&(a.setMask(N.stencilWriteMask),a.setFunc(N.stencilFunc,N.stencilRef,N.stencilFuncMask),a.setOp(N.stencilFail,N.stencilZFail,N.stencilZPass)),ke(N.polygonOffset,N.polygonOffsetFactor,N.polygonOffsetUnits),N.alphaToCoverage===!0?q(i.SAMPLE_ALPHA_TO_COVERAGE):de(i.SAMPLE_ALPHA_TO_COVERAGE)}function qe(N){x!==N&&(N?i.frontFace(i.CW):i.frontFace(i.CCW),x=N)}function $e(N){N!==vd?(q(i.CULL_FACE),N!==T&&(N===Wc?i.cullFace(i.BACK):N===Md?i.cullFace(i.FRONT):i.cullFace(i.FRONT_AND_BACK))):de(i.CULL_FACE),T=N}function me(N){N!==z&&(k&&i.lineWidth(N),z=N)}function ke(N,he,ee){N?(q(i.POLYGON_OFFSET_FILL),(O!==he||X!==ee)&&(i.polygonOffset(he,ee),O=he,X=ee)):de(i.POLYGON_OFFSET_FILL)}function Se(N){N?q(i.SCISSOR_TEST):de(i.SCISSOR_TEST)}function Ue(N){N===void 0&&(N=i.TEXTURE0+K-1),se!==N&&(i.activeTexture(N),se=N)}function ct(N,he,ee){ee===void 0&&(se===null?ee=i.TEXTURE0+K-1:ee=se);let ye=re[ee];ye===void 0&&(ye={type:void 0,texture:void 0},re[ee]=ye),(ye.type!==N||ye.texture!==he)&&(se!==ee&&(i.activeTexture(ee),se=ee),i.bindTexture(N,he||H[N]),ye.type=N,ye.texture=he)}function E(){let N=re[se];N!==void 0&&N.type!==void 0&&(i.bindTexture(N.type,null),N.type=void 0,N.texture=void 0)}function y(){try{i.compressedTexImage2D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function B(){try{i.compressedTexImage3D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Y(){try{i.texSubImage2D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function J(){try{i.texSubImage3D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function $(){try{i.compressedTexSubImage2D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function we(){try{i.compressedTexSubImage3D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function le(){try{i.texStorage2D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function be(){try{i.texStorage3D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Ee(){try{i.texImage2D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Q(){try{i.texImage3D(...arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function ge(N){Xe.equals(N)===!1&&(i.scissor(N.x,N.y,N.z,N.w),Xe.copy(N))}function Pe(N){Z.equals(N)===!1&&(i.viewport(N.x,N.y,N.z,N.w),Z.copy(N))}function Ie(N,he){let ee=c.get(he);ee===void 0&&(ee=new WeakMap,c.set(he,ee));let ye=ee.get(N);ye===void 0&&(ye=i.getUniformBlockIndex(he,N.name),ee.set(N,ye))}function oe(N,he){let ye=c.get(he).get(N);l.get(he)!==ye&&(i.uniformBlockBinding(he,ye,N.__bindingPointIndex),l.set(he,ye))}function Fe(){i.disable(i.BLEND),i.disable(i.CULL_FACE),i.disable(i.DEPTH_TEST),i.disable(i.POLYGON_OFFSET_FILL),i.disable(i.SCISSOR_TEST),i.disable(i.STENCIL_TEST),i.disable(i.SAMPLE_ALPHA_TO_COVERAGE),i.blendEquation(i.FUNC_ADD),i.blendFunc(i.ONE,i.ZERO),i.blendFuncSeparate(i.ONE,i.ZERO,i.ONE,i.ZERO),i.blendColor(0,0,0,0),i.colorMask(!0,!0,!0,!0),i.clearColor(0,0,0,0),i.depthMask(!0),i.depthFunc(i.LESS),o.setReversed(!1),i.clearDepth(1),i.stencilMask(4294967295),i.stencilFunc(i.ALWAYS,0,4294967295),i.stencilOp(i.KEEP,i.KEEP,i.KEEP),i.clearStencil(0),i.cullFace(i.BACK),i.frontFace(i.CCW),i.polygonOffset(0,0),i.activeTexture(i.TEXTURE0),i.bindFramebuffer(i.FRAMEBUFFER,null),i.bindFramebuffer(i.DRAW_FRAMEBUFFER,null),i.bindFramebuffer(i.READ_FRAMEBUFFER,null),i.useProgram(null),i.lineWidth(1),i.scissor(0,0,i.canvas.width,i.canvas.height),i.viewport(0,0,i.canvas.width,i.canvas.height),h={},se=null,re={},u={},p=new WeakMap,d=[],g=null,_=!1,m=null,f=null,w=null,M=null,v=null,A=null,I=null,C=new Ne(0,0,0),P=0,S=!1,x=null,T=null,z=null,O=null,X=null,Xe.set(0,0,i.canvas.width,i.canvas.height),Z.set(0,0,i.canvas.width,i.canvas.height),r.reset(),o.reset(),a.reset()}return{buffers:{color:r,depth:o,stencil:a},enable:q,disable:de,bindFramebuffer:Re,drawBuffers:fe,useProgram:xe,setBlending:L,setMaterial:_t,setFlipSided:qe,setCullFace:$e,setLineWidth:me,setPolygonOffset:ke,setScissorTest:Se,activeTexture:Ue,bindTexture:ct,unbindTexture:E,compressedTexImage2D:y,compressedTexImage3D:B,texImage2D:Ee,texImage3D:Q,updateUBOMapping:Ie,uniformBlockBinding:oe,texStorage2D:le,texStorage3D:be,texSubImage2D:Y,texSubImage3D:J,compressedTexSubImage2D:$,compressedTexSubImage3D:we,scissor:ge,viewport:Pe,reset:Fe}}function Q0(i,e,t,n,s,r,o){let a=e.has("WEBGL_multisampled_render_to_texture")?e.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),c=new ce,h=new WeakMap,u,p=new WeakMap,d=!1;try{d=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function g(E,y){return d?new OffscreenCanvas(E,y):xr("canvas")}function _(E,y,B){let Y=1,J=ct(E);if((J.width>B||J.height>B)&&(Y=B/Math.max(J.width,J.height)),Y<1)if(typeof HTMLImageElement<"u"&&E instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&E instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&E instanceof ImageBitmap||typeof VideoFrame<"u"&&E instanceof VideoFrame){let $=Math.floor(Y*J.width),we=Math.floor(Y*J.height);u===void 0&&(u=g($,we));let le=y?g($,we):u;return le.width=$,le.height=we,le.getContext("2d").drawImage(E,0,0,$,we),console.warn("THREE.WebGLRenderer: Texture has been resized from ("+J.width+"x"+J.height+") to ("+$+"x"+we+")."),le}else return"data"in E&&console.warn("THREE.WebGLRenderer: Image in DataTexture is too big ("+J.width+"x"+J.height+")."),E;return E}function m(E){return E.generateMipmaps}function f(E){i.generateMipmap(E)}function w(E){return E.isWebGLCubeRenderTarget?i.TEXTURE_CUBE_MAP:E.isWebGL3DRenderTarget?i.TEXTURE_3D:E.isWebGLArrayRenderTarget||E.isCompressedArrayTexture?i.TEXTURE_2D_ARRAY:i.TEXTURE_2D}function M(E,y,B,Y,J=!1){if(E!==null){if(i[E]!==void 0)return i[E];console.warn("THREE.WebGLRenderer: Attempt to use non-existing WebGL internal format '"+E+"'")}let $=y;if(y===i.RED&&(B===i.FLOAT&&($=i.R32F),B===i.HALF_FLOAT&&($=i.R16F),B===i.UNSIGNED_BYTE&&($=i.R8)),y===i.RED_INTEGER&&(B===i.UNSIGNED_BYTE&&($=i.R8UI),B===i.UNSIGNED_SHORT&&($=i.R16UI),B===i.UNSIGNED_INT&&($=i.R32UI),B===i.BYTE&&($=i.R8I),B===i.SHORT&&($=i.R16I),B===i.INT&&($=i.R32I)),y===i.RG&&(B===i.FLOAT&&($=i.RG32F),B===i.HALF_FLOAT&&($=i.RG16F),B===i.UNSIGNED_BYTE&&($=i.RG8)),y===i.RG_INTEGER&&(B===i.UNSIGNED_BYTE&&($=i.RG8UI),B===i.UNSIGNED_SHORT&&($=i.RG16UI),B===i.UNSIGNED_INT&&($=i.RG32UI),B===i.BYTE&&($=i.RG8I),B===i.SHORT&&($=i.RG16I),B===i.INT&&($=i.RG32I)),y===i.RGB_INTEGER&&(B===i.UNSIGNED_BYTE&&($=i.RGB8UI),B===i.UNSIGNED_SHORT&&($=i.RGB16UI),B===i.UNSIGNED_INT&&($=i.RGB32UI),B===i.BYTE&&($=i.RGB8I),B===i.SHORT&&($=i.RGB16I),B===i.INT&&($=i.RGB32I)),y===i.RGBA_INTEGER&&(B===i.UNSIGNED_BYTE&&($=i.RGBA8UI),B===i.UNSIGNED_SHORT&&($=i.RGBA16UI),B===i.UNSIGNED_INT&&($=i.RGBA32UI),B===i.BYTE&&($=i.RGBA8I),B===i.SHORT&&($=i.RGBA16I),B===i.INT&&($=i.RGBA32I)),y===i.RGB&&B===i.UNSIGNED_INT_5_9_9_9_REV&&($=i.RGB9_E5),y===i.RGBA){let we=J?_r:Ye.getTransfer(Y);B===i.FLOAT&&($=i.RGBA32F),B===i.HALF_FLOAT&&($=i.RGBA16F),B===i.UNSIGNED_BYTE&&($=we===Qe?i.SRGB8_ALPHA8:i.RGBA8),B===i.UNSIGNED_SHORT_4_4_4_4&&($=i.RGBA4),B===i.UNSIGNED_SHORT_5_5_5_1&&($=i.RGB5_A1)}return($===i.R16F||$===i.R32F||$===i.RG16F||$===i.RG32F||$===i.RGBA16F||$===i.RGBA32F)&&e.get("EXT_color_buffer_float"),$}function v(E,y){let B;return E?y===null||y===li||y===Ls?B=i.DEPTH24_STENCIL8:y===Mn?B=i.DEPTH32F_STENCIL8:y===Is&&(B=i.DEPTH24_STENCIL8,console.warn("DepthTexture: 16 bit depth attachment is not supported with stencil. Using 24-bit attachment.")):y===null||y===li||y===Ls?B=i.DEPTH_COMPONENT24:y===Mn?B=i.DEPTH_COMPONENT32F:y===Is&&(B=i.DEPTH_COMPONENT16),B}function A(E,y){return m(E)===!0||E.isFramebufferTexture&&E.minFilter!==zt&&E.minFilter!==Et?Math.log2(Math.max(y.width,y.height))+1:E.mipmaps!==void 0&&E.mipmaps.length>0?E.mipmaps.length:E.isCompressedTexture&&Array.isArray(E.image)?y.mipmaps.length:1}function I(E){let y=E.target;y.removeEventListener("dispose",I),P(y),y.isVideoTexture&&h.delete(y)}function C(E){let y=E.target;y.removeEventListener("dispose",C),x(y)}function P(E){let y=n.get(E);if(y.__webglInit===void 0)return;let B=E.source,Y=p.get(B);if(Y){let J=Y[y.__cacheKey];J.usedTimes--,J.usedTimes===0&&S(E),Object.keys(Y).length===0&&p.delete(B)}n.remove(E)}function S(E){let y=n.get(E);i.deleteTexture(y.__webglTexture);let B=E.source,Y=p.get(B);delete Y[y.__cacheKey],o.memory.textures--}function x(E){let y=n.get(E);if(E.depthTexture&&(E.depthTexture.dispose(),n.remove(E.depthTexture)),E.isWebGLCubeRenderTarget)for(let Y=0;Y<6;Y++){if(Array.isArray(y.__webglFramebuffer[Y]))for(let J=0;J<y.__webglFramebuffer[Y].length;J++)i.deleteFramebuffer(y.__webglFramebuffer[Y][J]);else i.deleteFramebuffer(y.__webglFramebuffer[Y]);y.__webglDepthbuffer&&i.deleteRenderbuffer(y.__webglDepthbuffer[Y])}else{if(Array.isArray(y.__webglFramebuffer))for(let Y=0;Y<y.__webglFramebuffer.length;Y++)i.deleteFramebuffer(y.__webglFramebuffer[Y]);else i.deleteFramebuffer(y.__webglFramebuffer);if(y.__webglDepthbuffer&&i.deleteRenderbuffer(y.__webglDepthbuffer),y.__webglMultisampledFramebuffer&&i.deleteFramebuffer(y.__webglMultisampledFramebuffer),y.__webglColorRenderbuffer)for(let Y=0;Y<y.__webglColorRenderbuffer.length;Y++)y.__webglColorRenderbuffer[Y]&&i.deleteRenderbuffer(y.__webglColorRenderbuffer[Y]);y.__webglDepthRenderbuffer&&i.deleteRenderbuffer(y.__webglDepthRenderbuffer)}let B=E.textures;for(let Y=0,J=B.length;Y<J;Y++){let $=n.get(B[Y]);$.__webglTexture&&(i.deleteTexture($.__webglTexture),o.memory.textures--),n.remove(B[Y])}n.remove(E)}let T=0;function z(){T=0}function O(){let E=T;return E>=s.maxTextures&&console.warn("THREE.WebGLTextures: Trying to use "+E+" texture units while this GPU supports only "+s.maxTextures),T+=1,E}function X(E){let y=[];return y.push(E.wrapS),y.push(E.wrapT),y.push(E.wrapR||0),y.push(E.magFilter),y.push(E.minFilter),y.push(E.anisotropy),y.push(E.internalFormat),y.push(E.format),y.push(E.type),y.push(E.generateMipmaps),y.push(E.premultiplyAlpha),y.push(E.flipY),y.push(E.unpackAlignment),y.push(E.colorSpace),y.join()}function K(E,y){let B=n.get(E);if(E.isVideoTexture&&Se(E),E.isRenderTargetTexture===!1&&E.version>0&&B.__version!==E.version){let Y=E.image;if(Y===null)console.warn("THREE.WebGLRenderer: Texture marked for update but no image data found.");else if(Y.complete===!1)console.warn("THREE.WebGLRenderer: Texture marked for update but image is incomplete");else{H(B,E,y);return}}t.bindTexture(i.TEXTURE_2D,B.__webglTexture,i.TEXTURE0+y)}function k(E,y){let B=n.get(E);if(E.version>0&&B.__version!==E.version){H(B,E,y);return}t.bindTexture(i.TEXTURE_2D_ARRAY,B.__webglTexture,i.TEXTURE0+y)}function te(E,y){let B=n.get(E);if(E.version>0&&B.__version!==E.version){H(B,E,y);return}t.bindTexture(i.TEXTURE_3D,B.__webglTexture,i.TEXTURE0+y)}function W(E,y){let B=n.get(E);if(E.version>0&&B.__version!==E.version){q(B,E,y);return}t.bindTexture(i.TEXTURE_CUBE_MAP,B.__webglTexture,i.TEXTURE0+y)}let se={[Zo]:i.REPEAT,[Qn]:i.CLAMP_TO_EDGE,[jo]:i.MIRRORED_REPEAT},re={[zt]:i.NEAREST,[jd]:i.NEAREST_MIPMAP_NEAREST,[$r]:i.NEAREST_MIPMAP_LINEAR,[Et]:i.LINEAR,[Da]:i.LINEAR_MIPMAP_NEAREST,[ai]:i.LINEAR_MIPMAP_LINEAR},pe={[ef]:i.NEVER,[af]:i.ALWAYS,[tf]:i.LESS,[sh]:i.LEQUAL,[nf]:i.EQUAL,[of]:i.GEQUAL,[sf]:i.GREATER,[rf]:i.NOTEQUAL};function Ce(E,y){if(y.type===Mn&&e.has("OES_texture_float_linear")===!1&&(y.magFilter===Et||y.magFilter===Da||y.magFilter===$r||y.magFilter===ai||y.minFilter===Et||y.minFilter===Da||y.minFilter===$r||y.minFilter===ai)&&console.warn("THREE.WebGLRenderer: Unable to use linear filtering with floating point textures. OES_texture_float_linear not supported on this device."),i.texParameteri(E,i.TEXTURE_WRAP_S,se[y.wrapS]),i.texParameteri(E,i.TEXTURE_WRAP_T,se[y.wrapT]),(E===i.TEXTURE_3D||E===i.TEXTURE_2D_ARRAY)&&i.texParameteri(E,i.TEXTURE_WRAP_R,se[y.wrapR]),i.texParameteri(E,i.TEXTURE_MAG_FILTER,re[y.magFilter]),i.texParameteri(E,i.TEXTURE_MIN_FILTER,re[y.minFilter]),y.compareFunction&&(i.texParameteri(E,i.TEXTURE_COMPARE_MODE,i.COMPARE_REF_TO_TEXTURE),i.texParameteri(E,i.TEXTURE_COMPARE_FUNC,pe[y.compareFunction])),e.has("EXT_texture_filter_anisotropic")===!0){if(y.magFilter===zt||y.minFilter!==$r&&y.minFilter!==ai||y.type===Mn&&e.has("OES_texture_float_linear")===!1)return;if(y.anisotropy>1||n.get(y).__currentAnisotropy){let B=e.get("EXT_texture_filter_anisotropic");i.texParameterf(E,B.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(y.anisotropy,s.getMaxAnisotropy())),n.get(y).__currentAnisotropy=y.anisotropy}}}function Xe(E,y){let B=!1;E.__webglInit===void 0&&(E.__webglInit=!0,y.addEventListener("dispose",I));let Y=y.source,J=p.get(Y);J===void 0&&(J={},p.set(Y,J));let $=X(y);if($!==E.__cacheKey){J[$]===void 0&&(J[$]={texture:i.createTexture(),usedTimes:0},o.memory.textures++,B=!0),J[$].usedTimes++;let we=J[E.__cacheKey];we!==void 0&&(J[E.__cacheKey].usedTimes--,we.usedTimes===0&&S(y)),E.__cacheKey=$,E.__webglTexture=J[$].texture}return B}function Z(E,y,B){return Math.floor(Math.floor(E/B)/y)}function R(E,y,B,Y){let $=E.updateRanges;if($.length===0)t.texSubImage2D(i.TEXTURE_2D,0,0,0,y.width,y.height,B,Y,y.data);else{$.sort((Q,ge)=>Q.start-ge.start);let we=0;for(let Q=1;Q<$.length;Q++){let ge=$[we],Pe=$[Q],Ie=ge.start+ge.count,oe=Z(Pe.start,y.width,4),Fe=Z(ge.start,y.width,4);Pe.start<=Ie+1&&oe===Fe&&Z(Pe.start+Pe.count-1,y.width,4)===oe?ge.count=Math.max(ge.count,Pe.start+Pe.count-ge.start):(++we,$[we]=Pe)}$.length=we+1;let le=i.getParameter(i.UNPACK_ROW_LENGTH),be=i.getParameter(i.UNPACK_SKIP_PIXELS),Ee=i.getParameter(i.UNPACK_SKIP_ROWS);i.pixelStorei(i.UNPACK_ROW_LENGTH,y.width);for(let Q=0,ge=$.length;Q<ge;Q++){let Pe=$[Q],Ie=Math.floor(Pe.start/4),oe=Math.ceil(Pe.count/4),Fe=Ie%y.width,N=Math.floor(Ie/y.width),he=oe,ee=1;i.pixelStorei(i.UNPACK_SKIP_PIXELS,Fe),i.pixelStorei(i.UNPACK_SKIP_ROWS,N),t.texSubImage2D(i.TEXTURE_2D,0,Fe,N,he,ee,B,Y,y.data)}E.clearUpdateRanges(),i.pixelStorei(i.UNPACK_ROW_LENGTH,le),i.pixelStorei(i.UNPACK_SKIP_PIXELS,be),i.pixelStorei(i.UNPACK_SKIP_ROWS,Ee)}}function H(E,y,B){let Y=i.TEXTURE_2D;(y.isDataArrayTexture||y.isCompressedArrayTexture)&&(Y=i.TEXTURE_2D_ARRAY),y.isData3DTexture&&(Y=i.TEXTURE_3D);let J=Xe(E,y),$=y.source;t.bindTexture(Y,E.__webglTexture,i.TEXTURE0+B);let we=n.get($);if($.version!==we.__version||J===!0){t.activeTexture(i.TEXTURE0+B);let le=Ye.getPrimaries(Ye.workingColorSpace),be=y.colorSpace===zn?null:Ye.getPrimaries(y.colorSpace),Ee=y.colorSpace===zn||le===be?i.NONE:i.BROWSER_DEFAULT_WEBGL;i.pixelStorei(i.UNPACK_FLIP_Y_WEBGL,y.flipY),i.pixelStorei(i.UNPACK_PREMULTIPLY_ALPHA_WEBGL,y.premultiplyAlpha),i.pixelStorei(i.UNPACK_ALIGNMENT,y.unpackAlignment),i.pixelStorei(i.UNPACK_COLORSPACE_CONVERSION_WEBGL,Ee);let Q=_(y.image,!1,s.maxTextureSize);Q=Ue(y,Q);let ge=r.convert(y.format,y.colorSpace),Pe=r.convert(y.type),Ie=M(y.internalFormat,ge,Pe,y.colorSpace,y.isVideoTexture);Ce(Y,y);let oe,Fe=y.mipmaps,N=y.isVideoTexture!==!0,he=we.__version===void 0||J===!0,ee=$.dataReady,ye=A(y,Q);if(y.isDepthTexture)Ie=v(y.format===Ds,y.type),he&&(N?t.texStorage2D(i.TEXTURE_2D,1,Ie,Q.width,Q.height):t.texImage2D(i.TEXTURE_2D,0,Ie,Q.width,Q.height,0,ge,Pe,null));else if(y.isDataTexture)if(Fe.length>0){N&&he&&t.texStorage2D(i.TEXTURE_2D,ye,Ie,Fe[0].width,Fe[0].height);for(let ne=0,j=Fe.length;ne<j;ne++)oe=Fe[ne],N?ee&&t.texSubImage2D(i.TEXTURE_2D,ne,0,0,oe.width,oe.height,ge,Pe,oe.data):t.texImage2D(i.TEXTURE_2D,ne,Ie,oe.width,oe.height,0,ge,Pe,oe.data);y.generateMipmaps=!1}else N?(he&&t.texStorage2D(i.TEXTURE_2D,ye,Ie,Q.width,Q.height),ee&&R(y,Q,ge,Pe)):t.texImage2D(i.TEXTURE_2D,0,Ie,Q.width,Q.height,0,ge,Pe,Q.data);else if(y.isCompressedTexture)if(y.isCompressedArrayTexture){N&&he&&t.texStorage3D(i.TEXTURE_2D_ARRAY,ye,Ie,Fe[0].width,Fe[0].height,Q.depth);for(let ne=0,j=Fe.length;ne<j;ne++)if(oe=Fe[ne],y.format!==It)if(ge!==null)if(N){if(ee)if(y.layerUpdates.size>0){let ve=fh(oe.width,oe.height,y.format,y.type);for(let Oe of y.layerUpdates){let st=oe.data.subarray(Oe*ve/oe.data.BYTES_PER_ELEMENT,(Oe+1)*ve/oe.data.BYTES_PER_ELEMENT);t.compressedTexSubImage3D(i.TEXTURE_2D_ARRAY,ne,0,0,Oe,oe.width,oe.height,1,ge,st)}y.clearLayerUpdates()}else t.compressedTexSubImage3D(i.TEXTURE_2D_ARRAY,ne,0,0,0,oe.width,oe.height,Q.depth,ge,oe.data)}else t.compressedTexImage3D(i.TEXTURE_2D_ARRAY,ne,Ie,oe.width,oe.height,Q.depth,0,oe.data,0,0);else console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else N?ee&&t.texSubImage3D(i.TEXTURE_2D_ARRAY,ne,0,0,0,oe.width,oe.height,Q.depth,ge,Pe,oe.data):t.texImage3D(i.TEXTURE_2D_ARRAY,ne,Ie,oe.width,oe.height,Q.depth,0,ge,Pe,oe.data)}else{N&&he&&t.texStorage2D(i.TEXTURE_2D,ye,Ie,Fe[0].width,Fe[0].height);for(let ne=0,j=Fe.length;ne<j;ne++)oe=Fe[ne],y.format!==It?ge!==null?N?ee&&t.compressedTexSubImage2D(i.TEXTURE_2D,ne,0,0,oe.width,oe.height,ge,oe.data):t.compressedTexImage2D(i.TEXTURE_2D,ne,Ie,oe.width,oe.height,0,oe.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):N?ee&&t.texSubImage2D(i.TEXTURE_2D,ne,0,0,oe.width,oe.height,ge,Pe,oe.data):t.texImage2D(i.TEXTURE_2D,ne,Ie,oe.width,oe.height,0,ge,Pe,oe.data)}else if(y.isDataArrayTexture)if(N){if(he&&t.texStorage3D(i.TEXTURE_2D_ARRAY,ye,Ie,Q.width,Q.height,Q.depth),ee)if(y.layerUpdates.size>0){let ne=fh(Q.width,Q.height,y.format,y.type);for(let j of y.layerUpdates){let ve=Q.data.subarray(j*ne/Q.data.BYTES_PER_ELEMENT,(j+1)*ne/Q.data.BYTES_PER_ELEMENT);t.texSubImage3D(i.TEXTURE_2D_ARRAY,0,0,0,j,Q.width,Q.height,1,ge,Pe,ve)}y.clearLayerUpdates()}else t.texSubImage3D(i.TEXTURE_2D_ARRAY,0,0,0,0,Q.width,Q.height,Q.depth,ge,Pe,Q.data)}else t.texImage3D(i.TEXTURE_2D_ARRAY,0,Ie,Q.width,Q.height,Q.depth,0,ge,Pe,Q.data);else if(y.isData3DTexture)N?(he&&t.texStorage3D(i.TEXTURE_3D,ye,Ie,Q.width,Q.height,Q.depth),ee&&t.texSubImage3D(i.TEXTURE_3D,0,0,0,0,Q.width,Q.height,Q.depth,ge,Pe,Q.data)):t.texImage3D(i.TEXTURE_3D,0,Ie,Q.width,Q.height,Q.depth,0,ge,Pe,Q.data);else if(y.isFramebufferTexture){if(he)if(N)t.texStorage2D(i.TEXTURE_2D,ye,Ie,Q.width,Q.height);else{let ne=Q.width,j=Q.height;for(let ve=0;ve<ye;ve++)t.texImage2D(i.TEXTURE_2D,ve,Ie,ne,j,0,ge,Pe,null),ne>>=1,j>>=1}}else if(Fe.length>0){if(N&&he){let ne=ct(Fe[0]);t.texStorage2D(i.TEXTURE_2D,ye,Ie,ne.width,ne.height)}for(let ne=0,j=Fe.length;ne<j;ne++)oe=Fe[ne],N?ee&&t.texSubImage2D(i.TEXTURE_2D,ne,0,0,ge,Pe,oe):t.texImage2D(i.TEXTURE_2D,ne,Ie,ge,Pe,oe);y.generateMipmaps=!1}else if(N){if(he){let ne=ct(Q);t.texStorage2D(i.TEXTURE_2D,ye,Ie,ne.width,ne.height)}ee&&t.texSubImage2D(i.TEXTURE_2D,0,0,0,ge,Pe,Q)}else t.texImage2D(i.TEXTURE_2D,0,Ie,ge,Pe,Q);m(y)&&f(Y),we.__version=$.version,y.onUpdate&&y.onUpdate(y)}E.__version=y.version}function q(E,y,B){if(y.image.length!==6)return;let Y=Xe(E,y),J=y.source;t.bindTexture(i.TEXTURE_CUBE_MAP,E.__webglTexture,i.TEXTURE0+B);let $=n.get(J);if(J.version!==$.__version||Y===!0){t.activeTexture(i.TEXTURE0+B);let we=Ye.getPrimaries(Ye.workingColorSpace),le=y.colorSpace===zn?null:Ye.getPrimaries(y.colorSpace),be=y.colorSpace===zn||we===le?i.NONE:i.BROWSER_DEFAULT_WEBGL;i.pixelStorei(i.UNPACK_FLIP_Y_WEBGL,y.flipY),i.pixelStorei(i.UNPACK_PREMULTIPLY_ALPHA_WEBGL,y.premultiplyAlpha),i.pixelStorei(i.UNPACK_ALIGNMENT,y.unpackAlignment),i.pixelStorei(i.UNPACK_COLORSPACE_CONVERSION_WEBGL,be);let Ee=y.isCompressedTexture||y.image[0].isCompressedTexture,Q=y.image[0]&&y.image[0].isDataTexture,ge=[];for(let j=0;j<6;j++)!Ee&&!Q?ge[j]=_(y.image[j],!0,s.maxCubemapSize):ge[j]=Q?y.image[j].image:y.image[j],ge[j]=Ue(y,ge[j]);let Pe=ge[0],Ie=r.convert(y.format,y.colorSpace),oe=r.convert(y.type),Fe=M(y.internalFormat,Ie,oe,y.colorSpace),N=y.isVideoTexture!==!0,he=$.__version===void 0||Y===!0,ee=J.dataReady,ye=A(y,Pe);Ce(i.TEXTURE_CUBE_MAP,y);let ne;if(Ee){N&&he&&t.texStorage2D(i.TEXTURE_CUBE_MAP,ye,Fe,Pe.width,Pe.height);for(let j=0;j<6;j++){ne=ge[j].mipmaps;for(let ve=0;ve<ne.length;ve++){let Oe=ne[ve];y.format!==It?Ie!==null?N?ee&&t.compressedTexSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve,0,0,Oe.width,Oe.height,Ie,Oe.data):t.compressedTexImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve,Fe,Oe.width,Oe.height,0,Oe.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):N?ee&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve,0,0,Oe.width,Oe.height,Ie,oe,Oe.data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve,Fe,Oe.width,Oe.height,0,Ie,oe,Oe.data)}}}else{if(ne=y.mipmaps,N&&he){ne.length>0&&ye++;let j=ct(ge[0]);t.texStorage2D(i.TEXTURE_CUBE_MAP,ye,Fe,j.width,j.height)}for(let j=0;j<6;j++)if(Q){N?ee&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,0,0,0,ge[j].width,ge[j].height,Ie,oe,ge[j].data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,0,Fe,ge[j].width,ge[j].height,0,Ie,oe,ge[j].data);for(let ve=0;ve<ne.length;ve++){let st=ne[ve].image[j].image;N?ee&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve+1,0,0,st.width,st.height,Ie,oe,st.data):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve+1,Fe,st.width,st.height,0,Ie,oe,st.data)}}else{N?ee&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,0,0,0,Ie,oe,ge[j]):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,0,Fe,Ie,oe,ge[j]);for(let ve=0;ve<ne.length;ve++){let Oe=ne[ve];N?ee&&t.texSubImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve+1,0,0,Ie,oe,Oe.image[j]):t.texImage2D(i.TEXTURE_CUBE_MAP_POSITIVE_X+j,ve+1,Fe,Ie,oe,Oe.image[j])}}}m(y)&&f(i.TEXTURE_CUBE_MAP),$.__version=J.version,y.onUpdate&&y.onUpdate(y)}E.__version=y.version}function de(E,y,B,Y,J,$){let we=r.convert(B.format,B.colorSpace),le=r.convert(B.type),be=M(B.internalFormat,we,le,B.colorSpace),Ee=n.get(y),Q=n.get(B);if(Q.__renderTarget=y,!Ee.__hasExternalTextures){let ge=Math.max(1,y.width>>$),Pe=Math.max(1,y.height>>$);J===i.TEXTURE_3D||J===i.TEXTURE_2D_ARRAY?t.texImage3D(J,$,be,ge,Pe,y.depth,0,we,le,null):t.texImage2D(J,$,be,ge,Pe,0,we,le,null)}t.bindFramebuffer(i.FRAMEBUFFER,E),ke(y)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,Y,J,Q.__webglTexture,0,me(y)):(J===i.TEXTURE_2D||J>=i.TEXTURE_CUBE_MAP_POSITIVE_X&&J<=i.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&i.framebufferTexture2D(i.FRAMEBUFFER,Y,J,Q.__webglTexture,$),t.bindFramebuffer(i.FRAMEBUFFER,null)}function Re(E,y,B){if(i.bindRenderbuffer(i.RENDERBUFFER,E),y.depthBuffer){let Y=y.depthTexture,J=Y&&Y.isDepthTexture?Y.type:null,$=v(y.stencilBuffer,J),we=y.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,le=me(y);ke(y)?a.renderbufferStorageMultisampleEXT(i.RENDERBUFFER,le,$,y.width,y.height):B?i.renderbufferStorageMultisample(i.RENDERBUFFER,le,$,y.width,y.height):i.renderbufferStorage(i.RENDERBUFFER,$,y.width,y.height),i.framebufferRenderbuffer(i.FRAMEBUFFER,we,i.RENDERBUFFER,E)}else{let Y=y.textures;for(let J=0;J<Y.length;J++){let $=Y[J],we=r.convert($.format,$.colorSpace),le=r.convert($.type),be=M($.internalFormat,we,le,$.colorSpace),Ee=me(y);B&&ke(y)===!1?i.renderbufferStorageMultisample(i.RENDERBUFFER,Ee,be,y.width,y.height):ke(y)?a.renderbufferStorageMultisampleEXT(i.RENDERBUFFER,Ee,be,y.width,y.height):i.renderbufferStorage(i.RENDERBUFFER,be,y.width,y.height)}}i.bindRenderbuffer(i.RENDERBUFFER,null)}function fe(E,y){if(y&&y.isWebGLCubeRenderTarget)throw new Error("Depth Texture with cube render targets is not supported");if(t.bindFramebuffer(i.FRAMEBUFFER,E),!(y.depthTexture&&y.depthTexture.isDepthTexture))throw new Error("renderTarget.depthTexture must be an instance of THREE.DepthTexture");let Y=n.get(y.depthTexture);Y.__renderTarget=y,(!Y.__webglTexture||y.depthTexture.image.width!==y.width||y.depthTexture.image.height!==y.height)&&(y.depthTexture.image.width=y.width,y.depthTexture.image.height=y.height,y.depthTexture.needsUpdate=!0),K(y.depthTexture,0);let J=Y.__webglTexture,$=me(y);if(y.depthTexture.format===gs)ke(y)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,i.DEPTH_ATTACHMENT,i.TEXTURE_2D,J,0,$):i.framebufferTexture2D(i.FRAMEBUFFER,i.DEPTH_ATTACHMENT,i.TEXTURE_2D,J,0);else if(y.depthTexture.format===Ds)ke(y)?a.framebufferTexture2DMultisampleEXT(i.FRAMEBUFFER,i.DEPTH_STENCIL_ATTACHMENT,i.TEXTURE_2D,J,0,$):i.framebufferTexture2D(i.FRAMEBUFFER,i.DEPTH_STENCIL_ATTACHMENT,i.TEXTURE_2D,J,0);else throw new Error("Unknown depthTexture format")}function xe(E){let y=n.get(E),B=E.isWebGLCubeRenderTarget===!0;if(y.__boundDepthTexture!==E.depthTexture){let Y=E.depthTexture;if(y.__depthDisposeCallback&&y.__depthDisposeCallback(),Y){let J=()=>{delete y.__boundDepthTexture,delete y.__depthDisposeCallback,Y.removeEventListener("dispose",J)};Y.addEventListener("dispose",J),y.__depthDisposeCallback=J}y.__boundDepthTexture=Y}if(E.depthTexture&&!y.__autoAllocateDepthBuffer){if(B)throw new Error("target.depthTexture not supported in Cube render targets");let Y=E.texture.mipmaps;Y&&Y.length>0?fe(y.__webglFramebuffer[0],E):fe(y.__webglFramebuffer,E)}else if(B){y.__webglDepthbuffer=[];for(let Y=0;Y<6;Y++)if(t.bindFramebuffer(i.FRAMEBUFFER,y.__webglFramebuffer[Y]),y.__webglDepthbuffer[Y]===void 0)y.__webglDepthbuffer[Y]=i.createRenderbuffer(),Re(y.__webglDepthbuffer[Y],E,!1);else{let J=E.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,$=y.__webglDepthbuffer[Y];i.bindRenderbuffer(i.RENDERBUFFER,$),i.framebufferRenderbuffer(i.FRAMEBUFFER,J,i.RENDERBUFFER,$)}}else{let Y=E.texture.mipmaps;if(Y&&Y.length>0?t.bindFramebuffer(i.FRAMEBUFFER,y.__webglFramebuffer[0]):t.bindFramebuffer(i.FRAMEBUFFER,y.__webglFramebuffer),y.__webglDepthbuffer===void 0)y.__webglDepthbuffer=i.createRenderbuffer(),Re(y.__webglDepthbuffer,E,!1);else{let J=E.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,$=y.__webglDepthbuffer;i.bindRenderbuffer(i.RENDERBUFFER,$),i.framebufferRenderbuffer(i.FRAMEBUFFER,J,i.RENDERBUFFER,$)}}t.bindFramebuffer(i.FRAMEBUFFER,null)}function je(E,y,B){let Y=n.get(E);y!==void 0&&de(Y.__webglFramebuffer,E,E.texture,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,0),B!==void 0&&xe(E)}function Ge(E){let y=E.texture,B=n.get(E),Y=n.get(y);E.addEventListener("dispose",C);let J=E.textures,$=E.isWebGLCubeRenderTarget===!0,we=J.length>1;if(we||(Y.__webglTexture===void 0&&(Y.__webglTexture=i.createTexture()),Y.__version=y.version,o.memory.textures++),$){B.__webglFramebuffer=[];for(let le=0;le<6;le++)if(y.mipmaps&&y.mipmaps.length>0){B.__webglFramebuffer[le]=[];for(let be=0;be<y.mipmaps.length;be++)B.__webglFramebuffer[le][be]=i.createFramebuffer()}else B.__webglFramebuffer[le]=i.createFramebuffer()}else{if(y.mipmaps&&y.mipmaps.length>0){B.__webglFramebuffer=[];for(let le=0;le<y.mipmaps.length;le++)B.__webglFramebuffer[le]=i.createFramebuffer()}else B.__webglFramebuffer=i.createFramebuffer();if(we)for(let le=0,be=J.length;le<be;le++){let Ee=n.get(J[le]);Ee.__webglTexture===void 0&&(Ee.__webglTexture=i.createTexture(),o.memory.textures++)}if(E.samples>0&&ke(E)===!1){B.__webglMultisampledFramebuffer=i.createFramebuffer(),B.__webglColorRenderbuffer=[],t.bindFramebuffer(i.FRAMEBUFFER,B.__webglMultisampledFramebuffer);for(let le=0;le<J.length;le++){let be=J[le];B.__webglColorRenderbuffer[le]=i.createRenderbuffer(),i.bindRenderbuffer(i.RENDERBUFFER,B.__webglColorRenderbuffer[le]);let Ee=r.convert(be.format,be.colorSpace),Q=r.convert(be.type),ge=M(be.internalFormat,Ee,Q,be.colorSpace,E.isXRRenderTarget===!0),Pe=me(E);i.renderbufferStorageMultisample(i.RENDERBUFFER,Pe,ge,E.width,E.height),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+le,i.RENDERBUFFER,B.__webglColorRenderbuffer[le])}i.bindRenderbuffer(i.RENDERBUFFER,null),E.depthBuffer&&(B.__webglDepthRenderbuffer=i.createRenderbuffer(),Re(B.__webglDepthRenderbuffer,E,!0)),t.bindFramebuffer(i.FRAMEBUFFER,null)}}if($){t.bindTexture(i.TEXTURE_CUBE_MAP,Y.__webglTexture),Ce(i.TEXTURE_CUBE_MAP,y);for(let le=0;le<6;le++)if(y.mipmaps&&y.mipmaps.length>0)for(let be=0;be<y.mipmaps.length;be++)de(B.__webglFramebuffer[le][be],E,y,i.COLOR_ATTACHMENT0,i.TEXTURE_CUBE_MAP_POSITIVE_X+le,be);else de(B.__webglFramebuffer[le],E,y,i.COLOR_ATTACHMENT0,i.TEXTURE_CUBE_MAP_POSITIVE_X+le,0);m(y)&&f(i.TEXTURE_CUBE_MAP),t.unbindTexture()}else if(we){for(let le=0,be=J.length;le<be;le++){let Ee=J[le],Q=n.get(Ee);t.bindTexture(i.TEXTURE_2D,Q.__webglTexture),Ce(i.TEXTURE_2D,Ee),de(B.__webglFramebuffer,E,Ee,i.COLOR_ATTACHMENT0+le,i.TEXTURE_2D,0),m(Ee)&&f(i.TEXTURE_2D)}t.unbindTexture()}else{let le=i.TEXTURE_2D;if((E.isWebGL3DRenderTarget||E.isWebGLArrayRenderTarget)&&(le=E.isWebGL3DRenderTarget?i.TEXTURE_3D:i.TEXTURE_2D_ARRAY),t.bindTexture(le,Y.__webglTexture),Ce(le,y),y.mipmaps&&y.mipmaps.length>0)for(let be=0;be<y.mipmaps.length;be++)de(B.__webglFramebuffer[be],E,y,i.COLOR_ATTACHMENT0,le,be);else de(B.__webglFramebuffer,E,y,i.COLOR_ATTACHMENT0,le,0);m(y)&&f(le),t.unbindTexture()}E.depthBuffer&&xe(E)}function L(E){let y=E.textures;for(let B=0,Y=y.length;B<Y;B++){let J=y[B];if(m(J)){let $=w(E),we=n.get(J).__webglTexture;t.bindTexture($,we),f($),t.unbindTexture()}}}let _t=[],qe=[];function $e(E){if(E.samples>0){if(ke(E)===!1){let y=E.textures,B=E.width,Y=E.height,J=i.COLOR_BUFFER_BIT,$=E.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT,we=n.get(E),le=y.length>1;if(le)for(let Ee=0;Ee<y.length;Ee++)t.bindFramebuffer(i.FRAMEBUFFER,we.__webglMultisampledFramebuffer),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+Ee,i.RENDERBUFFER,null),t.bindFramebuffer(i.FRAMEBUFFER,we.__webglFramebuffer),i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0+Ee,i.TEXTURE_2D,null,0);t.bindFramebuffer(i.READ_FRAMEBUFFER,we.__webglMultisampledFramebuffer);let be=E.texture.mipmaps;be&&be.length>0?t.bindFramebuffer(i.DRAW_FRAMEBUFFER,we.__webglFramebuffer[0]):t.bindFramebuffer(i.DRAW_FRAMEBUFFER,we.__webglFramebuffer);for(let Ee=0;Ee<y.length;Ee++){if(E.resolveDepthBuffer&&(E.depthBuffer&&(J|=i.DEPTH_BUFFER_BIT),E.stencilBuffer&&E.resolveStencilBuffer&&(J|=i.STENCIL_BUFFER_BIT)),le){i.framebufferRenderbuffer(i.READ_FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.RENDERBUFFER,we.__webglColorRenderbuffer[Ee]);let Q=n.get(y[Ee]).__webglTexture;i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0,i.TEXTURE_2D,Q,0)}i.blitFramebuffer(0,0,B,Y,0,0,B,Y,J,i.NEAREST),l===!0&&(_t.length=0,qe.length=0,_t.push(i.COLOR_ATTACHMENT0+Ee),E.depthBuffer&&E.resolveDepthBuffer===!1&&(_t.push($),qe.push($),i.invalidateFramebuffer(i.DRAW_FRAMEBUFFER,qe)),i.invalidateFramebuffer(i.READ_FRAMEBUFFER,_t))}if(t.bindFramebuffer(i.READ_FRAMEBUFFER,null),t.bindFramebuffer(i.DRAW_FRAMEBUFFER,null),le)for(let Ee=0;Ee<y.length;Ee++){t.bindFramebuffer(i.FRAMEBUFFER,we.__webglMultisampledFramebuffer),i.framebufferRenderbuffer(i.FRAMEBUFFER,i.COLOR_ATTACHMENT0+Ee,i.RENDERBUFFER,we.__webglColorRenderbuffer[Ee]);let Q=n.get(y[Ee]).__webglTexture;t.bindFramebuffer(i.FRAMEBUFFER,we.__webglFramebuffer),i.framebufferTexture2D(i.DRAW_FRAMEBUFFER,i.COLOR_ATTACHMENT0+Ee,i.TEXTURE_2D,Q,0)}t.bindFramebuffer(i.DRAW_FRAMEBUFFER,we.__webglMultisampledFramebuffer)}else if(E.depthBuffer&&E.resolveDepthBuffer===!1&&l){let y=E.stencilBuffer?i.DEPTH_STENCIL_ATTACHMENT:i.DEPTH_ATTACHMENT;i.invalidateFramebuffer(i.DRAW_FRAMEBUFFER,[y])}}}function me(E){return Math.min(s.maxSamples,E.samples)}function ke(E){let y=n.get(E);return E.samples>0&&e.has("WEBGL_multisampled_render_to_texture")===!0&&y.__useRenderToTexture!==!1}function Se(E){let y=o.render.frame;h.get(E)!==y&&(h.set(E,y),E.update())}function Ue(E,y){let B=E.colorSpace,Y=E.format,J=E.type;return E.isCompressedTexture===!0||E.isVideoTexture===!0||B!==Ii&&B!==zn&&(Ye.getTransfer(B)===Qe?(Y!==It||J!==Ot)&&console.warn("THREE.WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):console.error("THREE.WebGLTextures: Unsupported texture color space:",B)),y}function ct(E){return typeof HTMLImageElement<"u"&&E instanceof HTMLImageElement?(c.width=E.naturalWidth||E.width,c.height=E.naturalHeight||E.height):typeof VideoFrame<"u"&&E instanceof VideoFrame?(c.width=E.displayWidth,c.height=E.displayHeight):(c.width=E.width,c.height=E.height),c}this.allocateTextureUnit=O,this.resetTextureUnits=z,this.setTexture2D=K,this.setTexture2DArray=k,this.setTexture3D=te,this.setTextureCube=W,this.rebindTextures=je,this.setupRenderTarget=Ge,this.updateRenderTargetMipmap=L,this.updateMultisampleRenderTarget=$e,this.setupDepthRenderbuffer=xe,this.setupFrameBufferTexture=de,this.useMultisampledRTT=ke}function ev(i,e){function t(n,s=zn){let r,o=Ye.getTransfer(s);if(n===Ot)return i.UNSIGNED_BYTE;if(n===Ua)return i.UNSIGNED_SHORT_4_4_4_4;if(n===Fa)return i.UNSIGNED_SHORT_5_5_5_1;if(n===Jc)return i.UNSIGNED_INT_5_9_9_9_REV;if(n===jc)return i.BYTE;if(n===Kc)return i.SHORT;if(n===Is)return i.UNSIGNED_SHORT;if(n===Na)return i.INT;if(n===li)return i.UNSIGNED_INT;if(n===Mn)return i.FLOAT;if(n===Ps)return i.HALF_FLOAT;if(n===Qc)return i.ALPHA;if(n===eh)return i.RGB;if(n===It)return i.RGBA;if(n===gs)return i.DEPTH_COMPONENT;if(n===Ds)return i.DEPTH_STENCIL;if(n===th)return i.RED;if(n===Oa)return i.RED_INTEGER;if(n===nh)return i.RG;if(n===Ba)return i.RG_INTEGER;if(n===ka)return i.RGBA_INTEGER;if(n===Zr||n===jr||n===Kr||n===Jr)if(o===Qe)if(r=e.get("WEBGL_compressed_texture_s3tc_srgb"),r!==null){if(n===Zr)return r.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(n===jr)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(n===Kr)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(n===Jr)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(r=e.get("WEBGL_compressed_texture_s3tc"),r!==null){if(n===Zr)return r.COMPRESSED_RGB_S3TC_DXT1_EXT;if(n===jr)return r.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(n===Kr)return r.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(n===Jr)return r.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(n===za||n===Va||n===Ga||n===Ha)if(r=e.get("WEBGL_compressed_texture_pvrtc"),r!==null){if(n===za)return r.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(n===Va)return r.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(n===Ga)return r.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(n===Ha)return r.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(n===Wa||n===Xa||n===qa)if(r=e.get("WEBGL_compressed_texture_etc"),r!==null){if(n===Wa||n===Xa)return o===Qe?r.COMPRESSED_SRGB8_ETC2:r.COMPRESSED_RGB8_ETC2;if(n===qa)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:r.COMPRESSED_RGBA8_ETC2_EAC}else return null;if(n===Ya||n===$a||n===Za||n===ja||n===Ka||n===Ja||n===Qa||n===el||n===tl||n===nl||n===il||n===sl||n===rl||n===ol)if(r=e.get("WEBGL_compressed_texture_astc"),r!==null){if(n===Ya)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:r.COMPRESSED_RGBA_ASTC_4x4_KHR;if(n===$a)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:r.COMPRESSED_RGBA_ASTC_5x4_KHR;if(n===Za)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:r.COMPRESSED_RGBA_ASTC_5x5_KHR;if(n===ja)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:r.COMPRESSED_RGBA_ASTC_6x5_KHR;if(n===Ka)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:r.COMPRESSED_RGBA_ASTC_6x6_KHR;if(n===Ja)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:r.COMPRESSED_RGBA_ASTC_8x5_KHR;if(n===Qa)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:r.COMPRESSED_RGBA_ASTC_8x6_KHR;if(n===el)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:r.COMPRESSED_RGBA_ASTC_8x8_KHR;if(n===tl)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:r.COMPRESSED_RGBA_ASTC_10x5_KHR;if(n===nl)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:r.COMPRESSED_RGBA_ASTC_10x6_KHR;if(n===il)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:r.COMPRESSED_RGBA_ASTC_10x8_KHR;if(n===sl)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:r.COMPRESSED_RGBA_ASTC_10x10_KHR;if(n===rl)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:r.COMPRESSED_RGBA_ASTC_12x10_KHR;if(n===ol)return o===Qe?r.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:r.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(n===Qr||n===al||n===ll)if(r=e.get("EXT_texture_compression_bptc"),r!==null){if(n===Qr)return o===Qe?r.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:r.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(n===al)return r.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(n===ll)return r.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(n===ih||n===cl||n===hl||n===ul)if(r=e.get("EXT_texture_compression_rgtc"),r!==null){if(n===Qr)return r.COMPRESSED_RED_RGTC1_EXT;if(n===cl)return r.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(n===hl)return r.COMPRESSED_RED_GREEN_RGTC2_EXT;if(n===ul)return r.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return n===Ls?i.UNSIGNED_INT_24_8:i[n]!==void 0?i[n]:null}return{convert:t}}function sv(i,e){function t(m,f){m.matrixAutoUpdate===!0&&m.updateMatrix(),f.value.copy(m.matrix)}function n(m,f){f.color.getRGB(m.fogColor.value,ch(i)),f.isFog?(m.fogNear.value=f.near,m.fogFar.value=f.far):f.isFogExp2&&(m.fogDensity.value=f.density)}function s(m,f,w,M,v){f.isMeshBasicMaterial||f.isMeshLambertMaterial?r(m,f):f.isMeshToonMaterial?(r(m,f),u(m,f)):f.isMeshPhongMaterial?(r(m,f),h(m,f)):f.isMeshStandardMaterial?(r(m,f),p(m,f),f.isMeshPhysicalMaterial&&d(m,f,v)):f.isMeshMatcapMaterial?(r(m,f),g(m,f)):f.isMeshDepthMaterial?r(m,f):f.isMeshDistanceMaterial?(r(m,f),_(m,f)):f.isMeshNormalMaterial?r(m,f):f.isLineBasicMaterial?(o(m,f),f.isLineDashedMaterial&&a(m,f)):f.isPointsMaterial?l(m,f,w,M):f.isSpriteMaterial?c(m,f):f.isShadowMaterial?(m.color.value.copy(f.color),m.opacity.value=f.opacity):f.isShaderMaterial&&(f.uniformsNeedUpdate=!1)}function r(m,f){m.opacity.value=f.opacity,f.color&&m.diffuse.value.copy(f.color),f.emissive&&m.emissive.value.copy(f.emissive).multiplyScalar(f.emissiveIntensity),f.map&&(m.map.value=f.map,t(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,t(f.alphaMap,m.alphaMapTransform)),f.bumpMap&&(m.bumpMap.value=f.bumpMap,t(f.bumpMap,m.bumpMapTransform),m.bumpScale.value=f.bumpScale,f.side===Ft&&(m.bumpScale.value*=-1)),f.normalMap&&(m.normalMap.value=f.normalMap,t(f.normalMap,m.normalMapTransform),m.normalScale.value.copy(f.normalScale),f.side===Ft&&m.normalScale.value.negate()),f.displacementMap&&(m.displacementMap.value=f.displacementMap,t(f.displacementMap,m.displacementMapTransform),m.displacementScale.value=f.displacementScale,m.displacementBias.value=f.displacementBias),f.emissiveMap&&(m.emissiveMap.value=f.emissiveMap,t(f.emissiveMap,m.emissiveMapTransform)),f.specularMap&&(m.specularMap.value=f.specularMap,t(f.specularMap,m.specularMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest);let w=e.get(f),M=w.envMap,v=w.envMapRotation;M&&(m.envMap.value=M,Vi.copy(v),Vi.x*=-1,Vi.y*=-1,Vi.z*=-1,M.isCubeTexture&&M.isRenderTargetTexture===!1&&(Vi.y*=-1,Vi.z*=-1),m.envMapRotation.value.setFromMatrix4(iv.makeRotationFromEuler(Vi)),m.flipEnvMap.value=M.isCubeTexture&&M.isRenderTargetTexture===!1?-1:1,m.reflectivity.value=f.reflectivity,m.ior.value=f.ior,m.refractionRatio.value=f.refractionRatio),f.lightMap&&(m.lightMap.value=f.lightMap,m.lightMapIntensity.value=f.lightMapIntensity,t(f.lightMap,m.lightMapTransform)),f.aoMap&&(m.aoMap.value=f.aoMap,m.aoMapIntensity.value=f.aoMapIntensity,t(f.aoMap,m.aoMapTransform))}function o(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,f.map&&(m.map.value=f.map,t(f.map,m.mapTransform))}function a(m,f){m.dashSize.value=f.dashSize,m.totalSize.value=f.dashSize+f.gapSize,m.scale.value=f.scale}function l(m,f,w,M){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.size.value=f.size*w,m.scale.value=M*.5,f.map&&(m.map.value=f.map,t(f.map,m.uvTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,t(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function c(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.rotation.value=f.rotation,f.map&&(m.map.value=f.map,t(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,t(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function h(m,f){m.specular.value.copy(f.specular),m.shininess.value=Math.max(f.shininess,1e-4)}function u(m,f){f.gradientMap&&(m.gradientMap.value=f.gradientMap)}function p(m,f){m.metalness.value=f.metalness,f.metalnessMap&&(m.metalnessMap.value=f.metalnessMap,t(f.metalnessMap,m.metalnessMapTransform)),m.roughness.value=f.roughness,f.roughnessMap&&(m.roughnessMap.value=f.roughnessMap,t(f.roughnessMap,m.roughnessMapTransform)),f.envMap&&(m.envMapIntensity.value=f.envMapIntensity)}function d(m,f,w){m.ior.value=f.ior,f.sheen>0&&(m.sheenColor.value.copy(f.sheenColor).multiplyScalar(f.sheen),m.sheenRoughness.value=f.sheenRoughness,f.sheenColorMap&&(m.sheenColorMap.value=f.sheenColorMap,t(f.sheenColorMap,m.sheenColorMapTransform)),f.sheenRoughnessMap&&(m.sheenRoughnessMap.value=f.sheenRoughnessMap,t(f.sheenRoughnessMap,m.sheenRoughnessMapTransform))),f.clearcoat>0&&(m.clearcoat.value=f.clearcoat,m.clearcoatRoughness.value=f.clearcoatRoughness,f.clearcoatMap&&(m.clearcoatMap.value=f.clearcoatMap,t(f.clearcoatMap,m.clearcoatMapTransform)),f.clearcoatRoughnessMap&&(m.clearcoatRoughnessMap.value=f.clearcoatRoughnessMap,t(f.clearcoatRoughnessMap,m.clearcoatRoughnessMapTransform)),f.clearcoatNormalMap&&(m.clearcoatNormalMap.value=f.clearcoatNormalMap,t(f.clearcoatNormalMap,m.clearcoatNormalMapTransform),m.clearcoatNormalScale.value.copy(f.clearcoatNormalScale),f.side===Ft&&m.clearcoatNormalScale.value.negate())),f.dispersion>0&&(m.dispersion.value=f.dispersion),f.iridescence>0&&(m.iridescence.value=f.iridescence,m.iridescenceIOR.value=f.iridescenceIOR,m.iridescenceThicknessMinimum.value=f.iridescenceThicknessRange[0],m.iridescenceThicknessMaximum.value=f.iridescenceThicknessRange[1],f.iridescenceMap&&(m.iridescenceMap.value=f.iridescenceMap,t(f.iridescenceMap,m.iridescenceMapTransform)),f.iridescenceThicknessMap&&(m.iridescenceThicknessMap.value=f.iridescenceThicknessMap,t(f.iridescenceThicknessMap,m.iridescenceThicknessMapTransform))),f.transmission>0&&(m.transmission.value=f.transmission,m.transmissionSamplerMap.value=w.texture,m.transmissionSamplerSize.value.set(w.width,w.height),f.transmissionMap&&(m.transmissionMap.value=f.transmissionMap,t(f.transmissionMap,m.transmissionMapTransform)),m.thickness.value=f.thickness,f.thicknessMap&&(m.thicknessMap.value=f.thicknessMap,t(f.thicknessMap,m.thicknessMapTransform)),m.attenuationDistance.value=f.attenuationDistance,m.attenuationColor.value.copy(f.attenuationColor)),f.anisotropy>0&&(m.anisotropyVector.value.set(f.anisotropy*Math.cos(f.anisotropyRotation),f.anisotropy*Math.sin(f.anisotropyRotation)),f.anisotropyMap&&(m.anisotropyMap.value=f.anisotropyMap,t(f.anisotropyMap,m.anisotropyMapTransform))),m.specularIntensity.value=f.specularIntensity,m.specularColor.value.copy(f.specularColor),f.specularColorMap&&(m.specularColorMap.value=f.specularColorMap,t(f.specularColorMap,m.specularColorMapTransform)),f.specularIntensityMap&&(m.specularIntensityMap.value=f.specularIntensityMap,t(f.specularIntensityMap,m.specularIntensityMapTransform))}function g(m,f){f.matcap&&(m.matcap.value=f.matcap)}function _(m,f){let w=e.get(f).light;m.referencePosition.value.setFromMatrixPosition(w.matrixWorld),m.nearDistance.value=w.shadow.camera.near,m.farDistance.value=w.shadow.camera.far}return{refreshFogUniforms:n,refreshMaterialUniforms:s}}function rv(i,e,t,n){let s={},r={},o=[],a=i.getParameter(i.MAX_UNIFORM_BUFFER_BINDINGS);function l(w,M){let v=M.program;n.uniformBlockBinding(w,v)}function c(w,M){let v=s[w.id];v===void 0&&(g(w),v=h(w),s[w.id]=v,w.addEventListener("dispose",m));let A=M.program;n.updateUBOMapping(w,A);let I=e.render.frame;r[w.id]!==I&&(p(w),r[w.id]=I)}function h(w){let M=u();w.__bindingPointIndex=M;let v=i.createBuffer(),A=w.__size,I=w.usage;return i.bindBuffer(i.UNIFORM_BUFFER,v),i.bufferData(i.UNIFORM_BUFFER,A,I),i.bindBuffer(i.UNIFORM_BUFFER,null),i.bindBufferBase(i.UNIFORM_BUFFER,M,v),v}function u(){for(let w=0;w<a;w++)if(o.indexOf(w)===-1)return o.push(w),w;return console.error("THREE.WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function p(w){let M=s[w.id],v=w.uniforms,A=w.__cache;i.bindBuffer(i.UNIFORM_BUFFER,M);for(let I=0,C=v.length;I<C;I++){let P=Array.isArray(v[I])?v[I]:[v[I]];for(let S=0,x=P.length;S<x;S++){let T=P[S];if(d(T,I,S,A)===!0){let z=T.__offset,O=Array.isArray(T.value)?T.value:[T.value],X=0;for(let K=0;K<O.length;K++){let k=O[K],te=_(k);typeof k=="number"||typeof k=="boolean"?(T.__data[0]=k,i.bufferSubData(i.UNIFORM_BUFFER,z+X,T.__data)):k.isMatrix3?(T.__data[0]=k.elements[0],T.__data[1]=k.elements[1],T.__data[2]=k.elements[2],T.__data[3]=0,T.__data[4]=k.elements[3],T.__data[5]=k.elements[4],T.__data[6]=k.elements[5],T.__data[7]=0,T.__data[8]=k.elements[6],T.__data[9]=k.elements[7],T.__data[10]=k.elements[8],T.__data[11]=0):(k.toArray(T.__data,X),X+=te.storage/Float32Array.BYTES_PER_ELEMENT)}i.bufferSubData(i.UNIFORM_BUFFER,z,T.__data)}}}i.bindBuffer(i.UNIFORM_BUFFER,null)}function d(w,M,v,A){let I=w.value,C=M+"_"+v;if(A[C]===void 0)return typeof I=="number"||typeof I=="boolean"?A[C]=I:A[C]=I.clone(),!0;{let P=A[C];if(typeof I=="number"||typeof I=="boolean"){if(P!==I)return A[C]=I,!0}else if(P.equals(I)===!1)return P.copy(I),!0}return!1}function g(w){let M=w.uniforms,v=0,A=16;for(let C=0,P=M.length;C<P;C++){let S=Array.isArray(M[C])?M[C]:[M[C]];for(let x=0,T=S.length;x<T;x++){let z=S[x],O=Array.isArray(z.value)?z.value:[z.value];for(let X=0,K=O.length;X<K;X++){let k=O[X],te=_(k),W=v%A,se=W%te.boundary,re=W+se;v+=se,re!==0&&A-re<te.storage&&(v+=A-re),z.__data=new Float32Array(te.storage/Float32Array.BYTES_PER_ELEMENT),z.__offset=v,v+=te.storage}}}let I=v%A;return I>0&&(v+=A-I),w.__size=v,w.__cache={},this}function _(w){let M={boundary:0,storage:0};return typeof w=="number"||typeof w=="boolean"?(M.boundary=4,M.storage=4):w.isVector2?(M.boundary=8,M.storage=8):w.isVector3||w.isColor?(M.boundary=16,M.storage=12):w.isVector4?(M.boundary=16,M.storage=16):w.isMatrix3?(M.boundary=48,M.storage=48):w.isMatrix4?(M.boundary=64,M.storage=64):w.isTexture?console.warn("THREE.WebGLRenderer: Texture samplers can not be part of an uniforms group."):console.warn("THREE.WebGLRenderer: Unsupported uniform value type.",w),M}function m(w){let M=w.target;M.removeEventListener("dispose",m);let v=o.indexOf(M.__bindingPointIndex);o.splice(v,1),i.deleteBuffer(s[M.id]),delete s[M.id],delete r[M.id]}function f(){for(let w in s)i.deleteBuffer(s[w]);o=[],s={},r={}}return{bind:l,update:c,dispose:f}}var Dg,Ng,Ug,Fg,Og,Bg,kg,zg,Vg,Gg,Hg,Wg,Xg,qg,Yg,$g,Zg,jg,Kg,Jg,Qg,e_,t_,n_,i_,s_,r_,o_,a_,l_,c_,h_,u_,d_,f_,p_,m_,g_,__,y_,x_,v_,M_,b_,S_,w_,E_,T_,A_,C_,R_,I_,P_,L_,D_,N_,U_,F_,O_,B_,k_,z_,V_,G_,H_,W_,X_,q_,Y_,$_,Z_,j_,K_,J_,Q_,ey,ty,ny,iy,sy,ry,oy,ay,ly,cy,hy,uy,dy,fy,py,my,gy,_y,yy,xy,vy,My,by,Sy,wy,Ey,Ty,Ay,Cy,Ry,Iy,Py,Ly,Dy,Ny,Uy,Fy,Oy,By,ky,zy,Vy,Gy,Hy,Wy,Xy,qy,Yy,$y,Zy,jy,Ky,Jy,Qy,ex,tx,nx,ix,sx,rx,ox,ax,lx,cx,hx,ux,Ve,ae,bn,fl,zi,dx,Us,xf,Hi,mh,vf,gh,_h,yh,xh,Gi,Ns,Mf,xx,gl,Hf,Ef,Wf,Xf,qf,Tf,Af,Cf,Rf,If,Mh,bh,Sh,vh,Fs,g0,_0,Df,ml,T0,A0,R0,O0,Eh,Th,W0,$0,Z0,K0,tv,nv,Ah,Ch,Vi,iv,_l,ci=He(()=>{ph();ph();Dg=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,Ng=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,Ug=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,Fg=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,Og=`#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = smoothstep( alphaTest, alphaTest + fwidth( diffuseColor.a ), diffuseColor.a );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`,Bg=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,kg=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,zg=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,Vg=`#ifdef USE_BATCHING
	#if ! defined( GL_ANGLE_multi_draw )
	#define gl_DrawID _gl_DrawID
	uniform int _gl_DrawID;
	#endif
	uniform highp sampler2D batchingTexture;
	uniform highp usampler2D batchingIdTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
	float getIndirectIndex( const in int i ) {
		int size = textureSize( batchingIdTexture, 0 ).x;
		int x = i % size;
		int y = i / size;
		return float( texelFetch( batchingIdTexture, ivec2( x, y ), 0 ).r );
	}
#endif
#ifdef USE_BATCHING_COLOR
	uniform sampler2D batchingColorTexture;
	vec3 getBatchingColor( const in float i ) {
		int size = textureSize( batchingColorTexture, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( batchingColorTexture, ivec2( x, y ), 0 ).rgb;
	}
#endif`,Gg=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
#endif`,Hg=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,Wg=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,Xg=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,qg=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,Yg=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,$g=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#ifdef ALPHA_TO_COVERAGE
		float distanceToPlane, distanceGradient;
		float clipOpacity = 1.0;
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
			distanceGradient = fwidth( distanceToPlane ) / 2.0;
			clipOpacity *= smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			if ( clipOpacity == 0.0 ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			float unionClipOpacity = 1.0;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
				distanceGradient = fwidth( distanceToPlane ) / 2.0;
				unionClipOpacity *= 1.0 - smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			}
			#pragma unroll_loop_end
			clipOpacity *= 1.0 - unionClipOpacity;
		#endif
		diffuseColor.a *= clipOpacity;
		if ( diffuseColor.a == 0.0 ) discard;
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			bool clipped = true;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
			}
			#pragma unroll_loop_end
			if ( clipped ) discard;
		#endif
	#endif
#endif`,Zg=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,jg=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,Kg=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,Jg=`#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif`,Qg=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR )
	varying vec3 vColor;
#endif`,e_=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	varying vec3 vColor;
#endif`,t_=`#if defined( USE_COLOR_ALPHA )
	vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
	vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.xyz *= instanceColor.xyz;
#endif
#ifdef USE_BATCHING_COLOR
	vec3 batchingColor = getBatchingColor( getIndirectIndex( gl_DrawID ) );
	vColor.xyz *= batchingColor.xyz;
#endif`,n_=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
}
mat3 transposeMat3( const in mat3 m ) {
	mat3 tmp;
	tmp[ 0 ] = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x );
	tmp[ 1 ] = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y );
	tmp[ 2 ] = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z );
	return tmp;
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,i_=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,s_=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
	#ifdef FLIP_SIDED
		transformedTangent = - transformedTangent;
	#endif
#endif`,r_=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,o_=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,a_=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,l_=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,c_="gl_FragColor = linearToOutputTexel( gl_FragColor );",h_=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}`,u_=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, envMapRotation * vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );
	#else
		vec4 envColor = vec4( 0.0 );
	#endif
	#ifdef ENVMAP_BLENDING_MULTIPLY
		outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_MIX )
		outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_ADD )
		outgoingLight += envColor.xyz * specularStrength * reflectivity;
	#endif
#endif`,d_=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform float flipEnvMap;
	uniform mat3 envMapRotation;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
	
#endif`,f_=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,p_=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,m_=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,g_=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,__=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,y_=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,x_=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,v_=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,M_=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,b_=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,S_=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,w_=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif`,E_=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
			reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,T_=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,A_=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,C_=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,R_=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,I_=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = mix( min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_DISPERSION
	material.dispersion = dispersion;
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.07, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,P_=`struct PhysicalMaterial {
	vec3 diffuseColor;
	float roughness;
	vec3 specularColor;
	float specularF90;
	float dispersion;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		float v = 0.5 / ( gv + gl );
		return saturate(v);
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColor;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transposeMat3( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float a = roughness < 0.25 ? -339.2 * r2 + 161.4 * roughness - 25.9 : -8.48 * r2 + 14.3 * roughness - 9.95;
	float b = roughness < 0.25 ? 44.0 * r2 - 23.7 * roughness + 3.26 : 1.97 * r2 - 3.27 * roughness + 0.72;
	float DG = exp( a * dotNV + b ) + ( roughness < 0.25 ? 0.0 : 0.1 * ( roughness - 0.25 ) );
	return saturate( DG * RECIPROCAL_PI );
}
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
	#endif
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnel, material.roughness, singleScattering, multiScattering );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScattering, multiScattering );
	#endif
	vec3 totalScattering = singleScattering + multiScattering;
	vec3 diffuse = material.diffuseColor * ( 1.0 - max( max( totalScattering.r, totalScattering.g ), totalScattering.b ) );
	reflectedLight.indirectSpecular += radiance * singleScattering;
	reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;
	reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,L_=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,D_=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance += getIBLIrradiance( geometryNormal );
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,N_=`#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,U_=`#if defined( USE_LOGDEPTHBUF )
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,F_=`#if defined( USE_LOGDEPTHBUF )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,O_=`#ifdef USE_LOGDEPTHBUF
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,B_=`#ifdef USE_LOGDEPTHBUF
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif`,k_=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,z_=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,V_=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,G_=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,H_=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,W_=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,X_=`#ifdef USE_INSTANCING_MORPH
	float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	float morphTargetBaseInfluence = texelFetch( morphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		morphTargetInfluences[i] =  texelFetch( morphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
	}
#endif`,q_=`#if defined( USE_MORPHCOLORS )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,Y_=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,$_=`#ifdef USE_MORPHTARGETS
	#ifndef USE_INSTANCING_MORPH
		uniform float morphTargetBaseInfluence;
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	#endif
	uniform sampler2DArray morphTargetsTexture;
	uniform ivec2 morphTargetsTextureSize;
	vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
		int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
		int y = texelIndex / morphTargetsTextureSize.x;
		int x = texelIndex - y * morphTargetsTextureSize.x;
		ivec3 morphUV = ivec3( x, y, morphTargetIndex );
		return texelFetch( morphTargetsTexture, morphUV, 0 );
	}
#endif`,Z_=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,j_=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,K_=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,J_=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,Q_=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,ey=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif`,ty=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,ny=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,iy=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,sy=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,ry=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,oy=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,ay=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;const float ShiftRight8 = 1. / 256.;
const float Inv255 = 1. / 255.;
const vec4 PackFactors = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 );
const vec2 UnpackFactors2 = vec2( UnpackDownscale, 1.0 / PackFactors.g );
const vec3 UnpackFactors3 = vec3( UnpackDownscale / PackFactors.rg, 1.0 / PackFactors.b );
const vec4 UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
vec4 packDepthToRGBA( const in float v ) {
	if( v <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( v >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	float vuf;
	float af = modf( v * PackFactors.a, vuf );
	float bf = modf( vuf * ShiftRight8, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );
}
vec3 packDepthToRGB( const in float v ) {
	if( v <= 0.0 )
		return vec3( 0., 0., 0. );
	if( v >= 1.0 )
		return vec3( 1., 1., 1. );
	float vuf;
	float bf = modf( v * PackFactors.b, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec3( vuf * Inv255, gf * PackUpscale, bf );
}
vec2 packDepthToRG( const in float v ) {
	if( v <= 0.0 )
		return vec2( 0., 0. );
	if( v >= 1.0 )
		return vec2( 1., 1. );
	float vuf;
	float gf = modf( v * 256., vuf );
	return vec2( vuf * Inv255, gf );
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors4 );
}
float unpackRGBToDepth( const in vec3 v ) {
	return dot( v, UnpackFactors3 );
}
float unpackRGToDepth( const in vec2 v ) {
	return v.r * UnpackFactors2.r + v.g * UnpackFactors2.g;
}
vec4 pack2HalfToRGBA( const in vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( const in vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return depth * ( near - far ) - near;
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return ( near * far ) / ( ( far - near ) * depth - far );
}`,ly=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,cy=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,hy=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,uy=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,dy=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,fy=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,py=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform sampler2D pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
		return step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
	}
	vec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {
		return unpackRGBATo2Half( texture2D( shadow, uv ) );
	}
	float VSMShadow (sampler2D shadow, vec2 uv, float compare ){
		float occlusion = 1.0;
		vec2 distribution = texture2DDistribution( shadow, uv );
		float hard_shadow = step( compare , distribution.x );
		if (hard_shadow != 1.0 ) {
			float distance = compare - distribution.x ;
			float variance = max( 0.00000, distribution.y * distribution.y );
			float softness_probability = variance / (variance + distance * distance );			softness_probability = clamp( ( softness_probability - 0.3 ) / ( 0.95 - 0.3 ), 0.0, 1.0 );			occlusion = clamp( max( hard_shadow, softness_probability ), 0.0, 1.0 );
		}
		return occlusion;
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
		if ( frustumTest ) {
		#if defined( SHADOWMAP_TYPE_PCF )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx0 = - texelSize.x * shadowRadius;
			float dy0 = - texelSize.y * shadowRadius;
			float dx1 = + texelSize.x * shadowRadius;
			float dy1 = + texelSize.y * shadowRadius;
			float dx2 = dx0 / 2.0;
			float dy2 = dy0 / 2.0;
			float dx3 = dx1 / 2.0;
			float dy3 = dy1 / 2.0;
			shadow = (
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
			) * ( 1.0 / 17.0 );
		#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx = texelSize.x;
			float dy = texelSize.y;
			vec2 uv = shadowCoord.xy;
			vec2 f = fract( uv * shadowMapSize + 0.5 );
			uv -= f * texelSize;
			shadow = (
				texture2DCompare( shadowMap, uv, shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( dx, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( 0.0, dy ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, 0.0 ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 0.0 ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, dy ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( 0.0, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 0.0, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( texture2DCompare( shadowMap, uv + vec2( dx, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( dx, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( mix( texture2DCompare( shadowMap, uv + vec2( -dx, -dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, -dy ), shadowCoord.z ),
						  f.x ),
					 mix( texture2DCompare( shadowMap, uv + vec2( -dx, 2.0 * dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 2.0 * dy ), shadowCoord.z ),
						  f.x ),
					 f.y )
			) * ( 1.0 / 9.0 );
		#elif defined( SHADOWMAP_TYPE_VSM )
			shadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );
		#else
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		#endif
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	vec2 cubeToUV( vec3 v, float texelSizeY ) {
		vec3 absV = abs( v );
		float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
		absV *= scaleToCube;
		v *= scaleToCube * ( 1.0 - 2.0 * texelSizeY );
		vec2 planar = v.xy;
		float almostATexel = 1.5 * texelSizeY;
		float almostOne = 1.0 - almostATexel;
		if ( absV.z >= almostOne ) {
			if ( v.z > 0.0 )
				planar.x = 4.0 - v.x;
		} else if ( absV.x >= almostOne ) {
			float signX = sign( v.x );
			planar.x = v.z * signX + 2.0 * signX;
		} else if ( absV.y >= almostOne ) {
			float signY = sign( v.y );
			planar.x = v.x + 2.0 * signY + 2.0;
			planar.y = v.z * signY - 2.0;
		}
		return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
	}
	float getPointShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		
		float lightToPositionLength = length( lightToPosition );
		if ( lightToPositionLength - shadowCameraFar <= 0.0 && lightToPositionLength - shadowCameraNear >= 0.0 ) {
			float dp = ( lightToPositionLength - shadowCameraNear ) / ( shadowCameraFar - shadowCameraNear );			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			vec2 texelSize = vec2( 1.0 ) / ( shadowMapSize * vec2( 4.0, 2.0 ) );
			#if defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_PCF_SOFT ) || defined( SHADOWMAP_TYPE_VSM )
				vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;
				shadow = (
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxx, texelSize.y ), dp )
				) * ( 1.0 / 9.0 );
			#else
				shadow = texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp );
			#endif
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
#endif`,my=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,gy=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,_y=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowIntensity, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,yy=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,xy=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,vy=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,My=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,by=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,Sy=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,wy=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,Ey=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 CineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	color = clamp( color, 0.0, 1.0 );
	return color;
}
vec3 NeutralToneMapping( vec3 color ) {
	const float StartCompression = 0.8 - 0.04;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,Ty=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,Ay=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec4 transmittedLight;
		vec3 transmittance;
		#ifdef USE_DISPERSION
			float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
			vec3 iors = vec3( ior - halfSpread, ior, ior + halfSpread );
			for ( int i = 0; i < 3; i ++ ) {
				vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
				vec3 refractedRayExit = position + transmissionRay;
				vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
				vec2 refractionCoords = ndcPos.xy / ndcPos.w;
				refractionCoords += 1.0;
				refractionCoords /= 2.0;
				vec4 transmissionSample = getTransmissionSample( refractionCoords, roughness, iors[ i ] );
				transmittedLight[ i ] = transmissionSample[ i ];
				transmittedLight.a += transmissionSample.a;
				transmittance[ i ] = diffuseColor[ i ] * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance )[ i ];
			}
			transmittedLight.a /= 3.0;
		#else
			vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
			vec3 refractedRayExit = position + transmissionRay;
			vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
			vec2 refractionCoords = ndcPos.xy / ndcPos.w;
			refractionCoords += 1.0;
			refractionCoords /= 2.0;
			transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
			transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		#endif
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Cy=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Ry=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Iy=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,Py=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,Ly=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,Dy=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Ny=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Uy=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float flipEnvMap;
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
uniform mat3 backgroundRotation;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, backgroundRotation * vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, backgroundRotation * vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Fy=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Oy=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,By=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,ky=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#elif DEPTH_PACKING == 3202
		gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );
	#elif DEPTH_PACKING == 3203
		gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );
	#endif
}`,zy=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,Vy=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main () {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = packDepthToRGBA( dist );
}`,Gy=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,Hy=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Wy=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,Xy=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,qy=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,Yy=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,$y=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,Zy=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,jy=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,Ky=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Jy=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,Qy=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <packing>
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 0.0, 0.0, 0.0, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( packNormalToRGB( normal ), diffuseColor.a );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,ex=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,tx=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,nx=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,ix=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_DISPERSION
	uniform float dispersion;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );
		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;
	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,sx=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,rx=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,ox=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,ax=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,lx=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,cx=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,hx=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix[ 3 ];
	vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,ux=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Ve={alphahash_fragment:Dg,alphahash_pars_fragment:Ng,alphamap_fragment:Ug,alphamap_pars_fragment:Fg,alphatest_fragment:Og,alphatest_pars_fragment:Bg,aomap_fragment:kg,aomap_pars_fragment:zg,batching_pars_vertex:Vg,batching_vertex:Gg,begin_vertex:Hg,beginnormal_vertex:Wg,bsdfs:Xg,iridescence_fragment:qg,bumpmap_pars_fragment:Yg,clipping_planes_fragment:$g,clipping_planes_pars_fragment:Zg,clipping_planes_pars_vertex:jg,clipping_planes_vertex:Kg,color_fragment:Jg,color_pars_fragment:Qg,color_pars_vertex:e_,color_vertex:t_,common:n_,cube_uv_reflection_fragment:i_,defaultnormal_vertex:s_,displacementmap_pars_vertex:r_,displacementmap_vertex:o_,emissivemap_fragment:a_,emissivemap_pars_fragment:l_,colorspace_fragment:c_,colorspace_pars_fragment:h_,envmap_fragment:u_,envmap_common_pars_fragment:d_,envmap_pars_fragment:f_,envmap_pars_vertex:p_,envmap_physical_pars_fragment:E_,envmap_vertex:m_,fog_vertex:g_,fog_pars_vertex:__,fog_fragment:y_,fog_pars_fragment:x_,gradientmap_pars_fragment:v_,lightmap_pars_fragment:M_,lights_lambert_fragment:b_,lights_lambert_pars_fragment:S_,lights_pars_begin:w_,lights_toon_fragment:T_,lights_toon_pars_fragment:A_,lights_phong_fragment:C_,lights_phong_pars_fragment:R_,lights_physical_fragment:I_,lights_physical_pars_fragment:P_,lights_fragment_begin:L_,lights_fragment_maps:D_,lights_fragment_end:N_,logdepthbuf_fragment:U_,logdepthbuf_pars_fragment:F_,logdepthbuf_pars_vertex:O_,logdepthbuf_vertex:B_,map_fragment:k_,map_pars_fragment:z_,map_particle_fragment:V_,map_particle_pars_fragment:G_,metalnessmap_fragment:H_,metalnessmap_pars_fragment:W_,morphinstance_vertex:X_,morphcolor_vertex:q_,morphnormal_vertex:Y_,morphtarget_pars_vertex:$_,morphtarget_vertex:Z_,normal_fragment_begin:j_,normal_fragment_maps:K_,normal_pars_fragment:J_,normal_pars_vertex:Q_,normal_vertex:ey,normalmap_pars_fragment:ty,clearcoat_normal_fragment_begin:ny,clearcoat_normal_fragment_maps:iy,clearcoat_pars_fragment:sy,iridescence_pars_fragment:ry,opaque_fragment:oy,packing:ay,premultiplied_alpha_fragment:ly,project_vertex:cy,dithering_fragment:hy,dithering_pars_fragment:uy,roughnessmap_fragment:dy,roughnessmap_pars_fragment:fy,shadowmap_pars_fragment:py,shadowmap_pars_vertex:my,shadowmap_vertex:gy,shadowmask_pars_fragment:_y,skinbase_vertex:yy,skinning_pars_vertex:xy,skinning_vertex:vy,skinnormal_vertex:My,specularmap_fragment:by,specularmap_pars_fragment:Sy,tonemapping_fragment:wy,tonemapping_pars_fragment:Ey,transmission_fragment:Ty,transmission_pars_fragment:Ay,uv_pars_fragment:Cy,uv_pars_vertex:Ry,uv_vertex:Iy,worldpos_vertex:Py,background_vert:Ly,background_frag:Dy,backgroundCube_vert:Ny,backgroundCube_frag:Uy,cube_vert:Fy,cube_frag:Oy,depth_vert:By,depth_frag:ky,distanceRGBA_vert:zy,distanceRGBA_frag:Vy,equirect_vert:Gy,equirect_frag:Hy,linedashed_vert:Wy,linedashed_frag:Xy,meshbasic_vert:qy,meshbasic_frag:Yy,meshlambert_vert:$y,meshlambert_frag:Zy,meshmatcap_vert:jy,meshmatcap_frag:Ky,meshnormal_vert:Jy,meshnormal_frag:Qy,meshphong_vert:ex,meshphong_frag:tx,meshphysical_vert:nx,meshphysical_frag:ix,meshtoon_vert:sx,meshtoon_frag:rx,points_vert:ox,points_frag:ax,shadow_vert:lx,shadow_frag:cx,sprite_vert:hx,sprite_frag:ux},ae={common:{diffuse:{value:new Ne(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new Be},alphaMap:{value:null},alphaMapTransform:{value:new Be},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new Be}},envmap:{envMap:{value:null},envMapRotation:{value:new Be},flipEnvMap:{value:-1},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new Be}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new Be}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new Be},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new Be},normalScale:{value:new ce(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new Be},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new Be}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new Be}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new Be}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new Ne(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMap:{value:[]},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotShadowMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMap:{value:[]},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null}},points:{diffuse:{value:new Ne(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new Be},alphaTest:{value:0},uvTransform:{value:new Be}},sprite:{diffuse:{value:new Ne(16777215)},opacity:{value:1},center:{value:new ce(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new Be},alphaMap:{value:null},alphaMapTransform:{value:new Be},alphaTest:{value:0}}},bn={basic:{uniforms:Pt([ae.common,ae.specularmap,ae.envmap,ae.aomap,ae.lightmap,ae.fog]),vertexShader:Ve.meshbasic_vert,fragmentShader:Ve.meshbasic_frag},lambert:{uniforms:Pt([ae.common,ae.specularmap,ae.envmap,ae.aomap,ae.lightmap,ae.emissivemap,ae.bumpmap,ae.normalmap,ae.displacementmap,ae.fog,ae.lights,{emissive:{value:new Ne(0)}}]),vertexShader:Ve.meshlambert_vert,fragmentShader:Ve.meshlambert_frag},phong:{uniforms:Pt([ae.common,ae.specularmap,ae.envmap,ae.aomap,ae.lightmap,ae.emissivemap,ae.bumpmap,ae.normalmap,ae.displacementmap,ae.fog,ae.lights,{emissive:{value:new Ne(0)},specular:{value:new Ne(1118481)},shininess:{value:30}}]),vertexShader:Ve.meshphong_vert,fragmentShader:Ve.meshphong_frag},standard:{uniforms:Pt([ae.common,ae.envmap,ae.aomap,ae.lightmap,ae.emissivemap,ae.bumpmap,ae.normalmap,ae.displacementmap,ae.roughnessmap,ae.metalnessmap,ae.fog,ae.lights,{emissive:{value:new Ne(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:Ve.meshphysical_vert,fragmentShader:Ve.meshphysical_frag},toon:{uniforms:Pt([ae.common,ae.aomap,ae.lightmap,ae.emissivemap,ae.bumpmap,ae.normalmap,ae.displacementmap,ae.gradientmap,ae.fog,ae.lights,{emissive:{value:new Ne(0)}}]),vertexShader:Ve.meshtoon_vert,fragmentShader:Ve.meshtoon_frag},matcap:{uniforms:Pt([ae.common,ae.bumpmap,ae.normalmap,ae.displacementmap,ae.fog,{matcap:{value:null}}]),vertexShader:Ve.meshmatcap_vert,fragmentShader:Ve.meshmatcap_frag},points:{uniforms:Pt([ae.points,ae.fog]),vertexShader:Ve.points_vert,fragmentShader:Ve.points_frag},dashed:{uniforms:Pt([ae.common,ae.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:Ve.linedashed_vert,fragmentShader:Ve.linedashed_frag},depth:{uniforms:Pt([ae.common,ae.displacementmap]),vertexShader:Ve.depth_vert,fragmentShader:Ve.depth_frag},normal:{uniforms:Pt([ae.common,ae.bumpmap,ae.normalmap,ae.displacementmap,{opacity:{value:1}}]),vertexShader:Ve.meshnormal_vert,fragmentShader:Ve.meshnormal_frag},sprite:{uniforms:Pt([ae.sprite,ae.fog]),vertexShader:Ve.sprite_vert,fragmentShader:Ve.sprite_frag},background:{uniforms:{uvTransform:{value:new Be},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:Ve.background_vert,fragmentShader:Ve.background_frag},backgroundCube:{uniforms:{envMap:{value:null},flipEnvMap:{value:-1},backgroundBlurriness:{value:0},backgroundIntensity:{value:1},backgroundRotation:{value:new Be}},vertexShader:Ve.backgroundCube_vert,fragmentShader:Ve.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:Ve.cube_vert,fragmentShader:Ve.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:Ve.equirect_vert,fragmentShader:Ve.equirect_frag},distanceRGBA:{uniforms:Pt([ae.common,ae.displacementmap,{referencePosition:{value:new D},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:Ve.distanceRGBA_vert,fragmentShader:Ve.distanceRGBA_frag},shadow:{uniforms:Pt([ae.lights,ae.fog,{color:{value:new Ne(0)},opacity:{value:1}}]),vertexShader:Ve.shadow_vert,fragmentShader:Ve.shadow_frag}};bn.physical={uniforms:Pt([bn.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new Be},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new Be},clearcoatNormalScale:{value:new ce(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new Be},dispersion:{value:0},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new Be},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new Be},sheen:{value:0},sheenColor:{value:new Ne(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new Be},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new Be},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new Be},transmissionSamplerSize:{value:new ce},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new Be},attenuationDistance:{value:0},attenuationColor:{value:new Ne(0)},specularColor:{value:new Ne(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new Be},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new Be},anisotropyVector:{value:new ce},anisotropyMap:{value:null},anisotropyMapTransform:{value:new Be}}]),vertexShader:Ve.meshphysical_vert,fragmentShader:Ve.meshphysical_frag};fl={r:0,b:0,g:0},zi=new on,dx=new it;Us=4,xf=[.125,.215,.35,.446,.526,.582],Hi=20,mh=new Ui,vf=new Ne,gh=null,_h=0,yh=0,xh=!1,Gi=(1+Math.sqrt(5))/2,Ns=1/Gi,Mf=[new D(-Gi,Ns,0),new D(Gi,Ns,0),new D(-Ns,0,Gi),new D(Ns,0,Gi),new D(0,Gi,-Ns),new D(0,Gi,Ns),new D(-1,1,-1),new D(1,1,-1),new D(-1,1,1),new D(1,1,1)],xx=new D,gl=class{constructor(e){this._renderer=e,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._lodPlanes=[],this._sizeLods=[],this._sigmas=[],this._blurMaterial=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._compileMaterial(this._blurMaterial)}fromScene(e,t=0,n=.1,s=100,r={}){let{size:o=256,position:a=xx}=r;gh=this._renderer.getRenderTarget(),_h=this._renderer.getActiveCubeFace(),yh=this._renderer.getActiveMipmapLevel(),xh=this._renderer.xr.enabled,this._renderer.xr.enabled=!1,this._setSize(o);let l=this._allocateTargets();return l.depthBuffer=!0,this._sceneToCubeUV(e,n,s,l,a),t>0&&this._blur(l,0,0,t),this._applyPMREM(l),this._cleanup(l),l}fromEquirectangular(e,t=null){return this._fromTexture(e,t)}fromCubemap(e,t=null){return this._fromTexture(e,t)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=wf(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=Sf(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose()}_setSize(e){this._lodMax=Math.floor(Math.log2(e)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let e=0;e<this._lodPlanes.length;e++)this._lodPlanes[e].dispose()}_cleanup(e){this._renderer.setRenderTarget(gh,_h,yh),this._renderer.xr.enabled=xh,e.scissorTest=!1,pl(e,0,0,e.width,e.height)}_fromTexture(e,t){e.mapping===Fi||e.mapping===Oi?this._setSize(e.image.length===0?16:e.image[0].width||e.image[0].image.width):this._setSize(e.image.width/4),gh=this._renderer.getRenderTarget(),_h=this._renderer.getActiveCubeFace(),yh=this._renderer.getActiveMipmapLevel(),xh=this._renderer.xr.enabled,this._renderer.xr.enabled=!1;let n=t||this._allocateTargets();return this._textureToCubeUV(e,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let e=3*Math.max(this._cubeSize,112),t=4*this._cubeSize,n={magFilter:Et,minFilter:Et,generateMipmaps:!1,type:Ps,format:It,colorSpace:Ii,depthBuffer:!1},s=bf(e,t,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==e||this._pingPongRenderTarget.height!==t){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=bf(e,t,n);let{_lodMax:r}=this;({sizeLods:this._sizeLods,lodPlanes:this._lodPlanes,sigmas:this._sigmas}=vx(r)),this._blurMaterial=Mx(r,e,t)}return s}_compileMaterial(e){let t=new gt(this._lodPlanes[0],e);this._renderer.compile(t,mh)}_sceneToCubeUV(e,t,n,s,r){let l=new Ct(90,1,t,n),c=[1,-1,1,1,1,1],h=[1,1,1,-1,-1,-1],u=this._renderer,p=u.autoClear,d=u.toneMapping;u.getClearColor(vf),u.toneMapping=kn,u.autoClear=!1;let g=new Vt({name:"PMREM.Background",side:Ft,depthWrite:!1,depthTest:!1}),_=new gt(new vs,g),m=!1,f=e.background;f?f.isColor&&(g.color.copy(f),e.background=null,m=!0):(g.color.copy(vf),m=!0);for(let w=0;w<6;w++){let M=w%3;M===0?(l.up.set(0,c[w],0),l.position.set(r.x,r.y,r.z),l.lookAt(r.x+h[w],r.y,r.z)):M===1?(l.up.set(0,0,c[w]),l.position.set(r.x,r.y,r.z),l.lookAt(r.x,r.y+h[w],r.z)):(l.up.set(0,c[w],0),l.position.set(r.x,r.y,r.z),l.lookAt(r.x,r.y,r.z+h[w]));let v=this._cubeSize;pl(s,M*v,w>2?v:0,v,v),u.setRenderTarget(s),m&&u.render(_,l),u.render(e,l)}_.geometry.dispose(),_.material.dispose(),u.toneMapping=d,u.autoClear=p,e.background=f}_textureToCubeUV(e,t){let n=this._renderer,s=e.mapping===Fi||e.mapping===Oi;s?(this._cubemapMaterial===null&&(this._cubemapMaterial=wf()),this._cubemapMaterial.uniforms.flipEnvMap.value=e.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=Sf());let r=s?this._cubemapMaterial:this._equirectMaterial,o=new gt(this._lodPlanes[0],r),a=r.uniforms;a.envMap.value=e;let l=this._cubeSize;pl(t,0,0,3*l,2*l),n.setRenderTarget(t),n.render(o,mh)}_applyPMREM(e){let t=this._renderer,n=t.autoClear;t.autoClear=!1;let s=this._lodPlanes.length;for(let r=1;r<s;r++){let o=Math.sqrt(this._sigmas[r]*this._sigmas[r]-this._sigmas[r-1]*this._sigmas[r-1]),a=Mf[(s-r-1)%Mf.length];this._blur(e,r-1,r,o,a)}t.autoClear=n}_blur(e,t,n,s,r){let o=this._pingPongRenderTarget;this._halfBlur(e,o,t,n,s,"latitudinal",r),this._halfBlur(o,e,n,n,s,"longitudinal",r)}_halfBlur(e,t,n,s,r,o,a){let l=this._renderer,c=this._blurMaterial;o!=="latitudinal"&&o!=="longitudinal"&&console.error("blur direction must be either latitudinal or longitudinal!");let h=3,u=new gt(this._lodPlanes[s],c),p=c.uniforms,d=this._sizeLods[n]-1,g=isFinite(r)?Math.PI/(2*d):2*Math.PI/(2*Hi-1),_=r/g,m=isFinite(r)?1+Math.floor(h*_):Hi;m>Hi&&console.warn(`sigmaRadians, ${r}, is too large and will clip, as it requested ${m} samples when the maximum is set to ${Hi}`);let f=[],w=0;for(let C=0;C<Hi;++C){let P=C/_,S=Math.exp(-P*P/2);f.push(S),C===0?w+=S:C<m&&(w+=2*S)}for(let C=0;C<f.length;C++)f[C]=f[C]/w;p.envMap.value=e.texture,p.samples.value=m,p.weights.value=f,p.latitudinal.value=o==="latitudinal",a&&(p.poleAxis.value=a);let{_lodMax:M}=this;p.dTheta.value=g,p.mipInt.value=M-n;let v=this._sizeLods[s],A=3*v*(s>M-Us?s-M+Us:0),I=4*(this._cubeSize-v);pl(t,A,I,3*v,2*v),l.setRenderTarget(t),l.render(u,mh)}};Hf=new Ut,Ef=new Cr(1,1),Wf=new vr,Xf=new ea,qf=new wr,Tf=[],Af=[],Cf=new Float32Array(16),Rf=new Float32Array(9),If=new Float32Array(4);Mh=class{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.setValue=$x(t.type)}},bh=class{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.size=t.size,this.setValue=p0(t.type)}},Sh=class{constructor(e){this.id=e,this.seq=[],this.map={}}setValue(e,t,n){let s=this.seq;for(let r=0,o=s.length;r!==o;++r){let a=s[r];a.setValue(e,t[a.id],n)}}},vh=/(\w+)(\])?(\[|\.)?/g;Fs=class{constructor(e,t){this.seq=[],this.map={};let n=e.getProgramParameter(t,e.ACTIVE_UNIFORMS);for(let s=0;s<n;++s){let r=e.getActiveUniform(t,s),o=e.getUniformLocation(t,r.name);m0(r,o,this)}}setValue(e,t,n,s){let r=this.map[t];r!==void 0&&r.setValue(e,n,s)}setOptional(e,t,n){let s=t[n];s!==void 0&&this.setValue(e,n,s)}static upload(e,t,n,s){for(let r=0,o=t.length;r!==o;++r){let a=t[r],l=n[a.id];l.needsUpdate!==!1&&a.setValue(e,l.value,s)}}static seqWithValue(e,t){let n=[];for(let s=0,r=e.length;s!==r;++s){let o=e[s];o.id in t&&n.push(o)}return n}};g0=37297,_0=0;Df=new Be;ml=new D;T0=/^[ \t]*#include +<([\w\d./]+)>/gm;A0=new Map;R0=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;O0=0,Eh=class{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(e){let t=e.vertexShader,n=e.fragmentShader,s=this._getShaderStage(t),r=this._getShaderStage(n),o=this._getShaderCacheForMaterial(e);return o.has(s)===!1&&(o.add(s),s.usedTimes++),o.has(r)===!1&&(o.add(r),r.usedTimes++),this}remove(e){let t=this.materialCache.get(e);for(let n of t)n.usedTimes--,n.usedTimes===0&&this.shaderCache.delete(n.code);return this.materialCache.delete(e),this}getVertexShaderID(e){return this._getShaderStage(e.vertexShader).id}getFragmentShaderID(e){return this._getShaderStage(e.fragmentShader).id}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(e){let t=this.materialCache,n=t.get(e);return n===void 0&&(n=new Set,t.set(e,n)),n}_getShaderStage(e){let t=this.shaderCache,n=t.get(e);return n===void 0&&(n=new Th(e),t.set(e,n)),n}},Th=class{constructor(e){this.id=O0++,this.code=e,this.usedTimes=0}};W0=0;$0=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,Z0=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
#include <packing>
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = unpackRGBATo2Half( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ) );
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = unpackRGBAToDepth( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ) );
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( squared_mean - mean * mean );
	gl_FragColor = pack2HalfToRGBA( vec2( mean, std_dev ) );
}`;K0={[Sa]:wa,[Ea]:Ca,[Ta]:Ra,[Ri]:Aa,[wa]:Sa,[Ca]:Ea,[Ra]:Ta,[Aa]:Ri};tv=`
void main() {

	gl_Position = vec4( position, 1.0 );

}`,nv=`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );

	if ( coord.x >= 1.0 ) {

		gl_FragDepth = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;

	} else {

		gl_FragDepth = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	}

}`,Ah=class{constructor(){this.texture=null,this.mesh=null,this.depthNear=0,this.depthFar=0}init(e,t,n){if(this.texture===null){let s=new Ut,r=e.properties.get(s);r.__webglTexture=t.texture,(t.depthNear!==n.depthNear||t.depthFar!==n.depthFar)&&(this.depthNear=t.depthNear,this.depthFar=t.depthFar),this.texture=s}}getMesh(e){if(this.texture!==null&&this.mesh===null){let t=e.cameras[0].viewport,n=new mn({vertexShader:tv,fragmentShader:nv,uniforms:{depthColor:{value:this.texture},depthWidth:{value:t.z},depthHeight:{value:t.w}}});this.mesh=new gt(new On(20,20),n)}return this.mesh}reset(){this.texture=null,this.mesh=null}getDepthTexture(){return this.texture}},Ch=class extends xn{constructor(e,t){super();let n=this,s=null,r=1,o=null,a="local-floor",l=1,c=null,h=null,u=null,p=null,d=null,g=null,_=new Ah,m=t.getContextAttributes(),f=null,w=null,M=[],v=[],A=new ce,I=null,C=new Ct;C.viewport=new pt;let P=new Ct;P.viewport=new pt;let S=[C,P],x=new ba,T=null,z=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(Z){let R=M[Z];return R===void 0&&(R=new Ms,M[Z]=R),R.getTargetRaySpace()},this.getControllerGrip=function(Z){let R=M[Z];return R===void 0&&(R=new Ms,M[Z]=R),R.getGripSpace()},this.getHand=function(Z){let R=M[Z];return R===void 0&&(R=new Ms,M[Z]=R),R.getHandSpace()};function O(Z){let R=v.indexOf(Z.inputSource);if(R===-1)return;let H=M[R];H!==void 0&&(H.update(Z.inputSource,Z.frame,c||o),H.dispatchEvent({type:Z.type,data:Z.inputSource}))}function X(){s.removeEventListener("select",O),s.removeEventListener("selectstart",O),s.removeEventListener("selectend",O),s.removeEventListener("squeeze",O),s.removeEventListener("squeezestart",O),s.removeEventListener("squeezeend",O),s.removeEventListener("end",X),s.removeEventListener("inputsourceschange",K);for(let Z=0;Z<M.length;Z++){let R=v[Z];R!==null&&(v[Z]=null,M[Z].disconnect(R))}T=null,z=null,_.reset(),e.setRenderTarget(f),d=null,p=null,u=null,s=null,w=null,Xe.stop(),n.isPresenting=!1,e.setPixelRatio(I),e.setSize(A.width,A.height,!1),n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(Z){r=Z,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(Z){a=Z,n.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return c||o},this.setReferenceSpace=function(Z){c=Z},this.getBaseLayer=function(){return p!==null?p:d},this.getBinding=function(){return u},this.getFrame=function(){return g},this.getSession=function(){return s},this.setSession=async function(Z){if(s=Z,s!==null){if(f=e.getRenderTarget(),s.addEventListener("select",O),s.addEventListener("selectstart",O),s.addEventListener("selectend",O),s.addEventListener("squeeze",O),s.addEventListener("squeezestart",O),s.addEventListener("squeezeend",O),s.addEventListener("end",X),s.addEventListener("inputsourceschange",K),m.xrCompatible!==!0&&await t.makeXRCompatible(),I=e.getPixelRatio(),e.getSize(A),typeof XRWebGLBinding<"u"&&"createProjectionLayer"in XRWebGLBinding.prototype){let H=null,q=null,de=null;m.depth&&(de=m.stencil?t.DEPTH24_STENCIL8:t.DEPTH_COMPONENT24,H=m.stencil?Ds:gs,q=m.stencil?Ls:li);let Re={colorFormat:t.RGBA8,depthFormat:de,scaleFactor:r};u=new XRWebGLBinding(s,t),p=u.createProjectionLayer(Re),s.updateRenderState({layers:[p]}),e.setPixelRatio(1),e.setSize(p.textureWidth,p.textureHeight,!1),w=new rn(p.textureWidth,p.textureHeight,{format:It,type:Ot,depthTexture:new Cr(p.textureWidth,p.textureHeight,q,void 0,void 0,void 0,void 0,void 0,void 0,H),stencilBuffer:m.stencil,colorSpace:e.outputColorSpace,samples:m.antialias?4:0,resolveDepthBuffer:p.ignoreDepthValues===!1,resolveStencilBuffer:p.ignoreDepthValues===!1})}else{let H={antialias:m.antialias,alpha:!0,depth:m.depth,stencil:m.stencil,framebufferScaleFactor:r};d=new XRWebGLLayer(s,t,H),s.updateRenderState({baseLayer:d}),e.setPixelRatio(1),e.setSize(d.framebufferWidth,d.framebufferHeight,!1),w=new rn(d.framebufferWidth,d.framebufferHeight,{format:It,type:Ot,colorSpace:e.outputColorSpace,stencilBuffer:m.stencil,resolveDepthBuffer:d.ignoreDepthValues===!1,resolveStencilBuffer:d.ignoreDepthValues===!1})}w.isXRRenderTarget=!0,this.setFoveation(l),c=null,o=await s.requestReferenceSpace(a),Xe.setContext(s),Xe.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(s!==null)return s.environmentBlendMode},this.getDepthTexture=function(){return _.getDepthTexture()};function K(Z){for(let R=0;R<Z.removed.length;R++){let H=Z.removed[R],q=v.indexOf(H);q>=0&&(v[q]=null,M[q].disconnect(H))}for(let R=0;R<Z.added.length;R++){let H=Z.added[R],q=v.indexOf(H);if(q===-1){for(let Re=0;Re<M.length;Re++)if(Re>=v.length){v.push(H),q=Re;break}else if(v[Re]===null){v[Re]=H,q=Re;break}if(q===-1)break}let de=M[q];de&&de.connect(H)}}let k=new D,te=new D;function W(Z,R,H){k.setFromMatrixPosition(R.matrixWorld),te.setFromMatrixPosition(H.matrixWorld);let q=k.distanceTo(te),de=R.projectionMatrix.elements,Re=H.projectionMatrix.elements,fe=de[14]/(de[10]-1),xe=de[14]/(de[10]+1),je=(de[9]+1)/de[5],Ge=(de[9]-1)/de[5],L=(de[8]-1)/de[0],_t=(Re[8]+1)/Re[0],qe=fe*L,$e=fe*_t,me=q/(-L+_t),ke=me*-L;if(R.matrixWorld.decompose(Z.position,Z.quaternion,Z.scale),Z.translateX(ke),Z.translateZ(me),Z.matrixWorld.compose(Z.position,Z.quaternion,Z.scale),Z.matrixWorldInverse.copy(Z.matrixWorld).invert(),de[10]===-1)Z.projectionMatrix.copy(R.projectionMatrix),Z.projectionMatrixInverse.copy(R.projectionMatrixInverse);else{let Se=fe+me,Ue=xe+me,ct=qe-ke,E=$e+(q-ke),y=je*xe/Ue*Se,B=Ge*xe/Ue*Se;Z.projectionMatrix.makePerspective(ct,E,y,B,Se,Ue),Z.projectionMatrixInverse.copy(Z.projectionMatrix).invert()}}function se(Z,R){R===null?Z.matrixWorld.copy(Z.matrix):Z.matrixWorld.multiplyMatrices(R.matrixWorld,Z.matrix),Z.matrixWorldInverse.copy(Z.matrixWorld).invert()}this.updateCamera=function(Z){if(s===null)return;let R=Z.near,H=Z.far;_.texture!==null&&(_.depthNear>0&&(R=_.depthNear),_.depthFar>0&&(H=_.depthFar)),x.near=P.near=C.near=R,x.far=P.far=C.far=H,(T!==x.near||z!==x.far)&&(s.updateRenderState({depthNear:x.near,depthFar:x.far}),T=x.near,z=x.far),C.layers.mask=Z.layers.mask|2,P.layers.mask=Z.layers.mask|4,x.layers.mask=C.layers.mask|P.layers.mask;let q=Z.parent,de=x.cameras;se(x,q);for(let Re=0;Re<de.length;Re++)se(de[Re],q);de.length===2?W(x,C,P):x.projectionMatrix.copy(C.projectionMatrix),re(Z,x,q)};function re(Z,R,H){H===null?Z.matrix.copy(R.matrixWorld):(Z.matrix.copy(H.matrixWorld),Z.matrix.invert(),Z.matrix.multiply(R.matrixWorld)),Z.matrix.decompose(Z.position,Z.quaternion,Z.scale),Z.updateMatrixWorld(!0),Z.projectionMatrix.copy(R.projectionMatrix),Z.projectionMatrixInverse.copy(R.projectionMatrixInverse),Z.isPerspectiveCamera&&(Z.fov=_s*2*Math.atan(1/Z.projectionMatrix.elements[5]),Z.zoom=1)}this.getCamera=function(){return x},this.getFoveation=function(){if(!(p===null&&d===null))return l},this.setFoveation=function(Z){l=Z,p!==null&&(p.fixedFoveation=Z),d!==null&&d.fixedFoveation!==void 0&&(d.fixedFoveation=Z)},this.hasDepthSensing=function(){return _.texture!==null},this.getDepthSensingMesh=function(){return _.getMesh(x)};let pe=null;function Ce(Z,R){if(h=R.getViewerPose(c||o),g=R,h!==null){let H=h.views;d!==null&&(e.setRenderTargetFramebuffer(w,d.framebuffer),e.setRenderTarget(w));let q=!1;H.length!==x.cameras.length&&(x.cameras.length=0,q=!0);for(let fe=0;fe<H.length;fe++){let xe=H[fe],je=null;if(d!==null)je=d.getViewport(xe);else{let L=u.getViewSubImage(p,xe);je=L.viewport,fe===0&&(e.setRenderTargetTextures(w,L.colorTexture,L.depthStencilTexture),e.setRenderTarget(w))}let Ge=S[fe];Ge===void 0&&(Ge=new Ct,Ge.layers.enable(fe),Ge.viewport=new pt,S[fe]=Ge),Ge.matrix.fromArray(xe.transform.matrix),Ge.matrix.decompose(Ge.position,Ge.quaternion,Ge.scale),Ge.projectionMatrix.fromArray(xe.projectionMatrix),Ge.projectionMatrixInverse.copy(Ge.projectionMatrix).invert(),Ge.viewport.set(je.x,je.y,je.width,je.height),fe===0&&(x.matrix.copy(Ge.matrix),x.matrix.decompose(x.position,x.quaternion,x.scale)),q===!0&&x.cameras.push(Ge)}let de=s.enabledFeatures;if(de&&de.includes("depth-sensing")&&s.depthUsage=="gpu-optimized"&&u){let fe=u.getDepthInformation(H[0]);fe&&fe.isValid&&fe.texture&&_.init(e,fe,s.renderState)}}for(let H=0;H<M.length;H++){let q=v[H],de=M[H];q!==null&&de!==void 0&&de.update(q,R,c||o)}pe&&pe(Z,R),R.detectedPlanes&&n.dispatchEvent({type:"planesdetected",data:R}),g=null}let Xe=new Gf;Xe.setAnimationLoop(Ce),this.setAnimationLoop=function(Z){pe=Z},this.dispose=function(){}}},Vi=new on,iv=new it;_l=class{constructor(e={}){let{canvas:t=lf(),context:n=null,depth:s=!0,stencil:r=!1,alpha:o=!1,antialias:a=!1,premultipliedAlpha:l=!0,preserveDrawingBuffer:c=!1,powerPreference:h="default",failIfMajorPerformanceCaveat:u=!1,reverseDepthBuffer:p=!1}=e;this.isWebGLRenderer=!0;let d;if(n!==null){if(typeof WebGLRenderingContext<"u"&&n instanceof WebGLRenderingContext)throw new Error("THREE.WebGLRenderer: WebGL 1 is not supported since r163.");d=n.getContextAttributes().alpha}else d=o;let g=new Uint32Array(4),_=new Int32Array(4),m=null,f=null,w=[],M=[];this.domElement=t,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this.toneMapping=kn,this.toneMappingExposure=1,this.transmissionResolutionScale=1;let v=this,A=!1;this._outputColorSpace=xt;let I=0,C=0,P=null,S=-1,x=null,T=new pt,z=new pt,O=null,X=new Ne(0),K=0,k=t.width,te=t.height,W=1,se=null,re=null,pe=new pt(0,0,k,te),Ce=new pt(0,0,k,te),Xe=!1,Z=new bs,R=!1,H=!1,q=new it,de=new it,Re=new D,fe=new pt,xe={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0},je=!1;function Ge(){return P===null?W:1}let L=n;function _t(b,U){return t.getContext(b,U)}try{let b={alpha:!0,depth:s,stencil:r,antialias:a,premultipliedAlpha:l,preserveDrawingBuffer:c,powerPreference:h,failIfMajorPerformanceCaveat:u};if("setAttribute"in t&&t.setAttribute("data-engine",`three.js r${"178"}`),t.addEventListener("webglcontextlost",ye,!1),t.addEventListener("webglcontextrestored",ne,!1),t.addEventListener("webglcontextcreationerror",j,!1),L===null){let U="webgl2";if(L=_t(U,b),L===null)throw _t(U)?new Error("Error creating WebGL context with your selected attributes."):new Error("Error creating WebGL context.")}}catch(b){throw console.error("THREE.WebGLRenderer: "+b.message),b}let qe,$e,me,ke,Se,Ue,ct,E,y,B,Y,J,$,we,le,be,Ee,Q,ge,Pe,Ie,oe,Fe,N;function he(){qe=new Sx(L),qe.init(),oe=new ev(L,qe),$e=new gx(L,qe,e,oe),me=new J0(L,qe),$e.reverseDepthBuffer&&p&&me.buffers.depth.setReversed(!0),ke=new Tx(L),Se=new k0,Ue=new Q0(L,qe,me,Se,$e,oe,ke),ct=new yx(v),E=new bx(v),y=new Lg(L),Fe=new px(L,y),B=new wx(L,y,ke,Fe),Y=new Cx(L,B,y,ke),ge=new Ax(L,$e,Ue),be=new _x(Se),J=new B0(v,ct,E,qe,$e,Fe,be),$=new sv(v,Se),we=new V0,le=new Y0(qe),Q=new fx(v,ct,E,me,Y,d,l),Ee=new j0(v,Y,$e),N=new rv(L,ke,$e,me),Pe=new mx(L,qe,ke),Ie=new Ex(L,qe,ke),ke.programs=J.programs,v.capabilities=$e,v.extensions=qe,v.properties=Se,v.renderLists=we,v.shadowMap=Ee,v.state=me,v.info=ke}he();let ee=new Ch(v,L);this.xr=ee,this.getContext=function(){return L},this.getContextAttributes=function(){return L.getContextAttributes()},this.forceContextLoss=function(){let b=qe.get("WEBGL_lose_context");b&&b.loseContext()},this.forceContextRestore=function(){let b=qe.get("WEBGL_lose_context");b&&b.restoreContext()},this.getPixelRatio=function(){return W},this.setPixelRatio=function(b){b!==void 0&&(W=b,this.setSize(k,te,!1))},this.getSize=function(b){return b.set(k,te)},this.setSize=function(b,U,V=!0){if(ee.isPresenting){console.warn("THREE.WebGLRenderer: Can't change size while VR device is presenting.");return}k=b,te=U,t.width=Math.floor(b*W),t.height=Math.floor(U*W),V===!0&&(t.style.width=b+"px",t.style.height=U+"px"),this.setViewport(0,0,b,U)},this.getDrawingBufferSize=function(b){return b.set(k*W,te*W).floor()},this.setDrawingBufferSize=function(b,U,V){k=b,te=U,W=V,t.width=Math.floor(b*V),t.height=Math.floor(U*V),this.setViewport(0,0,b,U)},this.getCurrentViewport=function(b){return b.copy(T)},this.getViewport=function(b){return b.copy(pe)},this.setViewport=function(b,U,V,G){b.isVector4?pe.set(b.x,b.y,b.z,b.w):pe.set(b,U,V,G),me.viewport(T.copy(pe).multiplyScalar(W).round())},this.getScissor=function(b){return b.copy(Ce)},this.setScissor=function(b,U,V,G){b.isVector4?Ce.set(b.x,b.y,b.z,b.w):Ce.set(b,U,V,G),me.scissor(z.copy(Ce).multiplyScalar(W).round())},this.getScissorTest=function(){return Xe},this.setScissorTest=function(b){me.setScissorTest(Xe=b)},this.setOpaqueSort=function(b){se=b},this.setTransparentSort=function(b){re=b},this.getClearColor=function(b){return b.copy(Q.getClearColor())},this.setClearColor=function(){Q.setClearColor(...arguments)},this.getClearAlpha=function(){return Q.getClearAlpha()},this.setClearAlpha=function(){Q.setClearAlpha(...arguments)},this.clear=function(b=!0,U=!0,V=!0){let G=0;if(b){let F=!1;if(P!==null){let ie=P.texture.format;F=ie===ka||ie===Ba||ie===Oa}if(F){let ie=P.texture.type,ue=ie===Ot||ie===li||ie===Is||ie===Ls||ie===Ua||ie===Fa,Me=Q.getClearColor(),_e=Q.getClearAlpha(),Le=Me.r,De=Me.g,Te=Me.b;ue?(g[0]=Le,g[1]=De,g[2]=Te,g[3]=_e,L.clearBufferuiv(L.COLOR,0,g)):(_[0]=Le,_[1]=De,_[2]=Te,_[3]=_e,L.clearBufferiv(L.COLOR,0,_))}else G|=L.COLOR_BUFFER_BIT}U&&(G|=L.DEPTH_BUFFER_BIT),V&&(G|=L.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),L.clear(G)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.dispose=function(){t.removeEventListener("webglcontextlost",ye,!1),t.removeEventListener("webglcontextrestored",ne,!1),t.removeEventListener("webglcontextcreationerror",j,!1),Q.dispose(),we.dispose(),le.dispose(),Se.dispose(),ct.dispose(),E.dispose(),Y.dispose(),Fe.dispose(),N.dispose(),J.dispose(),ee.dispose(),ee.removeEventListener("sessionstart",Jh),ee.removeEventListener("sessionend",Qh),ui.stop()};function ye(b){b.preventDefault(),console.log("THREE.WebGLRenderer: Context Lost."),A=!0}function ne(){console.log("THREE.WebGLRenderer: Context Restored."),A=!1;let b=ke.autoReset,U=Ee.enabled,V=Ee.autoUpdate,G=Ee.needsUpdate,F=Ee.type;he(),ke.autoReset=b,Ee.enabled=U,Ee.autoUpdate=V,Ee.needsUpdate=G,Ee.type=F}function j(b){console.error("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ",b.statusMessage)}function ve(b){let U=b.target;U.removeEventListener("dispose",ve),Oe(U)}function Oe(b){st(b),Se.remove(b)}function st(b){let U=Se.get(b).programs;U!==void 0&&(U.forEach(function(V){J.releaseProgram(V)}),b.isShaderMaterial&&J.releaseShaderCache(b))}this.renderBufferDirect=function(b,U,V,G,F,ie){U===null&&(U=xe);let ue=F.isMesh&&F.matrixWorld.determinant()<0,Me=Ap(b,U,V,G,F);me.setMaterial(G,ue);let _e=V.index,Le=1;if(G.wireframe===!0){if(_e=B.getWireframeAttribute(V),_e===void 0)return;Le=2}let De=V.drawRange,Te=V.attributes.position,We=De.start*Le,et=(De.start+De.count)*Le;ie!==null&&(We=Math.max(We,ie.start*Le),et=Math.min(et,(ie.start+ie.count)*Le)),_e!==null?(We=Math.max(We,0),et=Math.min(et,_e.count)):Te!=null&&(We=Math.max(We,0),et=Math.min(et,Te.count));let mt=et-We;if(mt<0||mt===1/0)return;Fe.setup(F,G,Me,V,_e);let rt,nt=Pe;if(_e!==null&&(rt=y.get(_e),nt=Ie,nt.setIndex(rt)),F.isMesh)G.wireframe===!0?(me.setLineWidth(G.wireframeLinewidth*Ge()),nt.setMode(L.LINES)):nt.setMode(L.TRIANGLES);else if(F.isLine){let Ae=G.linewidth;Ae===void 0&&(Ae=1),me.setLineWidth(Ae*Ge()),F.isLineSegments?nt.setMode(L.LINES):F.isLineLoop?nt.setMode(L.LINE_LOOP):nt.setMode(L.LINE_STRIP)}else F.isPoints?nt.setMode(L.POINTS):F.isSprite&&nt.setMode(L.TRIANGLES);if(F.isBatchedMesh)if(F._multiDrawInstances!==null)Pi("THREE.WebGLRenderer: renderMultiDrawInstances has been deprecated and will be removed in r184. Append to renderMultiDraw arguments and use indirection."),nt.renderMultiDrawInstances(F._multiDrawStarts,F._multiDrawCounts,F._multiDrawCount,F._multiDrawInstances);else if(qe.get("WEBGL_multi_draw"))nt.renderMultiDraw(F._multiDrawStarts,F._multiDrawCounts,F._multiDrawCount);else{let Ae=F._multiDrawStarts,ht=F._multiDrawCounts,Ze=F._multiDrawCount,Wt=_e?y.get(_e).bytesPerElement:1,Yi=Se.get(G).currentProgram.getUniforms();for(let Xt=0;Xt<Ze;Xt++)Yi.setValue(L,"_gl_DrawID",Xt),nt.render(Ae[Xt]/Wt,ht[Xt])}else if(F.isInstancedMesh)nt.renderInstances(We,mt,F.count);else if(V.isInstancedBufferGeometry){let Ae=V._maxInstanceCount!==void 0?V._maxInstanceCount:1/0,ht=Math.min(V.instanceCount,Ae);nt.renderInstances(We,mt,ht)}else nt.render(We,mt)};function Je(b,U,V){b.transparent===!0&&b.side===Rt&&b.forceSinglePass===!1?(b.side=Ft,b.needsUpdate=!0,ro(b,U,V),b.side=Nn,b.needsUpdate=!0,ro(b,U,V),b.side=Rt):ro(b,U,V)}this.compile=function(b,U,V=null){V===null&&(V=b),f=le.get(V),f.init(U),M.push(f),V.traverseVisible(function(F){F.isLight&&F.layers.test(U.layers)&&(f.pushLight(F),F.castShadow&&f.pushShadow(F))}),b!==V&&b.traverseVisible(function(F){F.isLight&&F.layers.test(U.layers)&&(f.pushLight(F),F.castShadow&&f.pushShadow(F))}),f.setupLights();let G=new Set;return b.traverse(function(F){if(!(F.isMesh||F.isPoints||F.isLine||F.isSprite))return;let ie=F.material;if(ie)if(Array.isArray(ie))for(let ue=0;ue<ie.length;ue++){let Me=ie[ue];Je(Me,V,F),G.add(Me)}else Je(ie,V,F),G.add(ie)}),f=M.pop(),G},this.compileAsync=function(b,U,V=null){let G=this.compile(b,U,V);return new Promise(F=>{function ie(){if(G.forEach(function(ue){Se.get(ue).currentProgram.isReady()&&G.delete(ue)}),G.size===0){F(b);return}setTimeout(ie,10)}qe.get("KHR_parallel_shader_compile")!==null?ie():setTimeout(ie,10)})};let ln=null;function Sn(b){ln&&ln(b)}function Jh(){ui.stop()}function Qh(){ui.start()}let ui=new Gf;ui.setAnimationLoop(Sn),typeof self<"u"&&ui.setContext(self),this.setAnimationLoop=function(b){ln=b,ee.setAnimationLoop(b),b===null?ui.stop():ui.start()},ee.addEventListener("sessionstart",Jh),ee.addEventListener("sessionend",Qh),this.render=function(b,U){if(U!==void 0&&U.isCamera!==!0){console.error("THREE.WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(A===!0)return;if(b.matrixWorldAutoUpdate===!0&&b.updateMatrixWorld(),U.parent===null&&U.matrixWorldAutoUpdate===!0&&U.updateMatrixWorld(),ee.enabled===!0&&ee.isPresenting===!0&&(ee.cameraAutoUpdate===!0&&ee.updateCamera(U),U=ee.getCamera()),b.isScene===!0&&b.onBeforeRender(v,b,U,P),f=le.get(b,M.length),f.init(U),M.push(f),de.multiplyMatrices(U.projectionMatrix,U.matrixWorldInverse),Z.setFromProjectionMatrix(de),H=this.localClippingEnabled,R=be.init(this.clippingPlanes,H),m=we.get(b,w.length),m.init(),w.push(m),ee.enabled===!0&&ee.isPresenting===!0){let ie=v.xr.getDepthSensingMesh();ie!==null&&kl(ie,U,-1/0,v.sortObjects)}kl(b,U,0,v.sortObjects),m.finish(),v.sortObjects===!0&&m.sort(se,re),je=ee.enabled===!1||ee.isPresenting===!1||ee.hasDepthSensing()===!1,je&&Q.addToRenderList(m,b),this.info.render.frame++,R===!0&&be.beginShadows();let V=f.state.shadowsArray;Ee.render(V,b,U),R===!0&&be.endShadows(),this.info.autoReset===!0&&this.info.reset();let G=m.opaque,F=m.transmissive;if(f.setupLights(),U.isArrayCamera){let ie=U.cameras;if(F.length>0)for(let ue=0,Me=ie.length;ue<Me;ue++){let _e=ie[ue];tu(G,F,b,_e)}je&&Q.render(b);for(let ue=0,Me=ie.length;ue<Me;ue++){let _e=ie[ue];eu(m,b,_e,_e.viewport)}}else F.length>0&&tu(G,F,b,U),je&&Q.render(b),eu(m,b,U);P!==null&&C===0&&(Ue.updateMultisampleRenderTarget(P),Ue.updateRenderTargetMipmap(P)),b.isScene===!0&&b.onAfterRender(v,b,U),Fe.resetDefaultState(),S=-1,x=null,M.pop(),M.length>0?(f=M[M.length-1],R===!0&&be.setGlobalState(v.clippingPlanes,f.state.camera)):f=null,w.pop(),w.length>0?m=w[w.length-1]:m=null};function kl(b,U,V,G){if(b.visible===!1)return;if(b.layers.test(U.layers)){if(b.isGroup)V=b.renderOrder;else if(b.isLOD)b.autoUpdate===!0&&b.update(U);else if(b.isLight)f.pushLight(b),b.castShadow&&f.pushShadow(b);else if(b.isSprite){if(!b.frustumCulled||Z.intersectsSprite(b)){G&&fe.setFromMatrixPosition(b.matrixWorld).applyMatrix4(de);let ue=Y.update(b),Me=b.material;Me.visible&&m.push(b,ue,Me,V,fe.z,null)}}else if((b.isMesh||b.isLine||b.isPoints)&&(!b.frustumCulled||Z.intersectsObject(b))){let ue=Y.update(b),Me=b.material;if(G&&(b.boundingSphere!==void 0?(b.boundingSphere===null&&b.computeBoundingSphere(),fe.copy(b.boundingSphere.center)):(ue.boundingSphere===null&&ue.computeBoundingSphere(),fe.copy(ue.boundingSphere.center)),fe.applyMatrix4(b.matrixWorld).applyMatrix4(de)),Array.isArray(Me)){let _e=ue.groups;for(let Le=0,De=_e.length;Le<De;Le++){let Te=_e[Le],We=Me[Te.materialIndex];We&&We.visible&&m.push(b,ue,We,V,fe.z,Te)}}else Me.visible&&m.push(b,ue,Me,V,fe.z,null)}}let ie=b.children;for(let ue=0,Me=ie.length;ue<Me;ue++)kl(ie[ue],U,V,G)}function eu(b,U,V,G){let F=b.opaque,ie=b.transmissive,ue=b.transparent;f.setupLightsView(V),R===!0&&be.setGlobalState(v.clippingPlanes,V),G&&me.viewport(T.copy(G)),F.length>0&&so(F,U,V),ie.length>0&&so(ie,U,V),ue.length>0&&so(ue,U,V),me.buffers.depth.setTest(!0),me.buffers.depth.setMask(!0),me.buffers.color.setMask(!0),me.setPolygonOffset(!1)}function tu(b,U,V,G){if((V.isScene===!0?V.overrideMaterial:null)!==null)return;f.state.transmissionRenderTarget[G.id]===void 0&&(f.state.transmissionRenderTarget[G.id]=new rn(1,1,{generateMipmaps:!0,type:qe.has("EXT_color_buffer_half_float")||qe.has("EXT_color_buffer_float")?Ps:Ot,minFilter:ai,samples:4,stencilBuffer:r,resolveDepthBuffer:!1,resolveStencilBuffer:!1,colorSpace:Ye.workingColorSpace}));let ie=f.state.transmissionRenderTarget[G.id],ue=G.viewport||T;ie.setSize(ue.z*v.transmissionResolutionScale,ue.w*v.transmissionResolutionScale);let Me=v.getRenderTarget(),_e=v.getActiveCubeFace(),Le=v.getActiveMipmapLevel();v.setRenderTarget(ie),v.getClearColor(X),K=v.getClearAlpha(),K<1&&v.setClearColor(16777215,.5),v.clear(),je&&Q.render(V);let De=v.toneMapping;v.toneMapping=kn;let Te=G.viewport;if(G.viewport!==void 0&&(G.viewport=void 0),f.setupLightsView(G),R===!0&&be.setGlobalState(v.clippingPlanes,G),so(b,V,G),Ue.updateMultisampleRenderTarget(ie),Ue.updateRenderTargetMipmap(ie),qe.has("WEBGL_multisampled_render_to_texture")===!1){let We=!1;for(let et=0,mt=U.length;et<mt;et++){let rt=U[et],nt=rt.object,Ae=rt.geometry,ht=rt.material,Ze=rt.group;if(ht.side===Rt&&nt.layers.test(G.layers)){let Wt=ht.side;ht.side=Ft,ht.needsUpdate=!0,nu(nt,V,G,Ae,ht,Ze),ht.side=Wt,ht.needsUpdate=!0,We=!0}}We===!0&&(Ue.updateMultisampleRenderTarget(ie),Ue.updateRenderTargetMipmap(ie))}v.setRenderTarget(Me,_e,Le),v.setClearColor(X,K),Te!==void 0&&(G.viewport=Te),v.toneMapping=De}function so(b,U,V){let G=U.isScene===!0?U.overrideMaterial:null;for(let F=0,ie=b.length;F<ie;F++){let ue=b[F],Me=ue.object,_e=ue.geometry,Le=ue.group,De=ue.material;De.allowOverride===!0&&G!==null&&(De=G),Me.layers.test(V.layers)&&nu(Me,U,V,_e,De,Le)}}function nu(b,U,V,G,F,ie){b.onBeforeRender(v,U,V,G,F,ie),b.modelViewMatrix.multiplyMatrices(V.matrixWorldInverse,b.matrixWorld),b.normalMatrix.getNormalMatrix(b.modelViewMatrix),F.onBeforeRender(v,U,V,G,b,ie),F.transparent===!0&&F.side===Rt&&F.forceSinglePass===!1?(F.side=Ft,F.needsUpdate=!0,v.renderBufferDirect(V,U,G,F,b,ie),F.side=Nn,F.needsUpdate=!0,v.renderBufferDirect(V,U,G,F,b,ie),F.side=Rt):v.renderBufferDirect(V,U,G,F,b,ie),b.onAfterRender(v,U,V,G,F,ie)}function ro(b,U,V){U.isScene!==!0&&(U=xe);let G=Se.get(b),F=f.state.lights,ie=f.state.shadowsArray,ue=F.state.version,Me=J.getParameters(b,F.state,ie,U,V),_e=J.getProgramCacheKey(Me),Le=G.programs;G.environment=b.isMeshStandardMaterial?U.environment:null,G.fog=U.fog,G.envMap=(b.isMeshStandardMaterial?E:ct).get(b.envMap||G.environment),G.envMapRotation=G.environment!==null&&b.envMap===null?U.environmentRotation:b.envMapRotation,Le===void 0&&(b.addEventListener("dispose",ve),Le=new Map,G.programs=Le);let De=Le.get(_e);if(De!==void 0){if(G.currentProgram===De&&G.lightsStateVersion===ue)return su(b,Me),De}else Me.uniforms=J.getUniforms(b),b.onBeforeCompile(Me,v),De=J.acquireProgram(Me,_e),Le.set(_e,De),G.uniforms=Me.uniforms;let Te=G.uniforms;return(!b.isShaderMaterial&&!b.isRawShaderMaterial||b.clipping===!0)&&(Te.clippingPlanes=be.uniform),su(b,Me),G.needsLights=Rp(b),G.lightsStateVersion=ue,G.needsLights&&(Te.ambientLightColor.value=F.state.ambient,Te.lightProbe.value=F.state.probe,Te.directionalLights.value=F.state.directional,Te.directionalLightShadows.value=F.state.directionalShadow,Te.spotLights.value=F.state.spot,Te.spotLightShadows.value=F.state.spotShadow,Te.rectAreaLights.value=F.state.rectArea,Te.ltc_1.value=F.state.rectAreaLTC1,Te.ltc_2.value=F.state.rectAreaLTC2,Te.pointLights.value=F.state.point,Te.pointLightShadows.value=F.state.pointShadow,Te.hemisphereLights.value=F.state.hemi,Te.directionalShadowMap.value=F.state.directionalShadowMap,Te.directionalShadowMatrix.value=F.state.directionalShadowMatrix,Te.spotShadowMap.value=F.state.spotShadowMap,Te.spotLightMatrix.value=F.state.spotLightMatrix,Te.spotLightMap.value=F.state.spotLightMap,Te.pointShadowMap.value=F.state.pointShadowMap,Te.pointShadowMatrix.value=F.state.pointShadowMatrix),G.currentProgram=De,G.uniformsList=null,De}function iu(b){if(b.uniformsList===null){let U=b.currentProgram.getUniforms();b.uniformsList=Fs.seqWithValue(U.seq,b.uniforms)}return b.uniformsList}function su(b,U){let V=Se.get(b);V.outputColorSpace=U.outputColorSpace,V.batching=U.batching,V.batchingColor=U.batchingColor,V.instancing=U.instancing,V.instancingColor=U.instancingColor,V.instancingMorph=U.instancingMorph,V.skinning=U.skinning,V.morphTargets=U.morphTargets,V.morphNormals=U.morphNormals,V.morphColors=U.morphColors,V.morphTargetsCount=U.morphTargetsCount,V.numClippingPlanes=U.numClippingPlanes,V.numIntersection=U.numClipIntersection,V.vertexAlphas=U.vertexAlphas,V.vertexTangents=U.vertexTangents,V.toneMapping=U.toneMapping}function Ap(b,U,V,G,F){U.isScene!==!0&&(U=xe),Ue.resetTextureUnits();let ie=U.fog,ue=G.isMeshStandardMaterial?U.environment:null,Me=P===null?v.outputColorSpace:P.isXRRenderTarget===!0?P.texture.colorSpace:Ii,_e=(G.isMeshStandardMaterial?E:ct).get(G.envMap||ue),Le=G.vertexColors===!0&&!!V.attributes.color&&V.attributes.color.itemSize===4,De=!!V.attributes.tangent&&(!!G.normalMap||G.anisotropy>0),Te=!!V.morphAttributes.position,We=!!V.morphAttributes.normal,et=!!V.morphAttributes.color,mt=kn;G.toneMapped&&(P===null||P.isXRRenderTarget===!0)&&(mt=v.toneMapping);let rt=V.morphAttributes.position||V.morphAttributes.normal||V.morphAttributes.color,nt=rt!==void 0?rt.length:0,Ae=Se.get(G),ht=f.state.lights;if(R===!0&&(H===!0||b!==x)){let Dt=b===x&&G.id===S;be.setState(G,b,Dt)}let Ze=!1;G.version===Ae.__version?(Ae.needsLights&&Ae.lightsStateVersion!==ht.state.version||Ae.outputColorSpace!==Me||F.isBatchedMesh&&Ae.batching===!1||!F.isBatchedMesh&&Ae.batching===!0||F.isBatchedMesh&&Ae.batchingColor===!0&&F.colorTexture===null||F.isBatchedMesh&&Ae.batchingColor===!1&&F.colorTexture!==null||F.isInstancedMesh&&Ae.instancing===!1||!F.isInstancedMesh&&Ae.instancing===!0||F.isSkinnedMesh&&Ae.skinning===!1||!F.isSkinnedMesh&&Ae.skinning===!0||F.isInstancedMesh&&Ae.instancingColor===!0&&F.instanceColor===null||F.isInstancedMesh&&Ae.instancingColor===!1&&F.instanceColor!==null||F.isInstancedMesh&&Ae.instancingMorph===!0&&F.morphTexture===null||F.isInstancedMesh&&Ae.instancingMorph===!1&&F.morphTexture!==null||Ae.envMap!==_e||G.fog===!0&&Ae.fog!==ie||Ae.numClippingPlanes!==void 0&&(Ae.numClippingPlanes!==be.numPlanes||Ae.numIntersection!==be.numIntersection)||Ae.vertexAlphas!==Le||Ae.vertexTangents!==De||Ae.morphTargets!==Te||Ae.morphNormals!==We||Ae.morphColors!==et||Ae.toneMapping!==mt||Ae.morphTargetsCount!==nt)&&(Ze=!0):(Ze=!0,Ae.__version=G.version);let Wt=Ae.currentProgram;Ze===!0&&(Wt=ro(G,U,F));let Yi=!1,Xt=!1,Gs=!1,at=Wt.getUniforms(),Kt=Ae.uniforms;if(me.useProgram(Wt.program)&&(Yi=!0,Xt=!0,Gs=!0),G.id!==S&&(S=G.id,Xt=!0),Yi||x!==b){me.buffers.depth.getReversed()?(q.copy(b.projectionMatrix),hf(q),uf(q),at.setValue(L,"projectionMatrix",q)):at.setValue(L,"projectionMatrix",b.projectionMatrix),at.setValue(L,"viewMatrix",b.matrixWorldInverse);let Bt=at.map.cameraPosition;Bt!==void 0&&Bt.setValue(L,Re.setFromMatrixPosition(b.matrixWorld)),$e.logarithmicDepthBuffer&&at.setValue(L,"logDepthBufFC",2/(Math.log(b.far+1)/Math.LN2)),(G.isMeshPhongMaterial||G.isMeshToonMaterial||G.isMeshLambertMaterial||G.isMeshBasicMaterial||G.isMeshStandardMaterial||G.isShaderMaterial)&&at.setValue(L,"isOrthographic",b.isOrthographicCamera===!0),x!==b&&(x=b,Xt=!0,Gs=!0)}if(F.isSkinnedMesh){at.setOptional(L,F,"bindMatrix"),at.setOptional(L,F,"bindMatrixInverse");let Dt=F.skeleton;Dt&&(Dt.boneTexture===null&&Dt.computeBoneTexture(),at.setValue(L,"boneTexture",Dt.boneTexture,Ue))}F.isBatchedMesh&&(at.setOptional(L,F,"batchingTexture"),at.setValue(L,"batchingTexture",F._matricesTexture,Ue),at.setOptional(L,F,"batchingIdTexture"),at.setValue(L,"batchingIdTexture",F._indirectTexture,Ue),at.setOptional(L,F,"batchingColorTexture"),F._colorsTexture!==null&&at.setValue(L,"batchingColorTexture",F._colorsTexture,Ue));let Jt=V.morphAttributes;if((Jt.position!==void 0||Jt.normal!==void 0||Jt.color!==void 0)&&ge.update(F,V,Wt),(Xt||Ae.receiveShadow!==F.receiveShadow)&&(Ae.receiveShadow=F.receiveShadow,at.setValue(L,"receiveShadow",F.receiveShadow)),G.isMeshGouraudMaterial&&G.envMap!==null&&(Kt.envMap.value=_e,Kt.flipEnvMap.value=_e.isCubeTexture&&_e.isRenderTargetTexture===!1?-1:1),G.isMeshStandardMaterial&&G.envMap===null&&U.environment!==null&&(Kt.envMapIntensity.value=U.environmentIntensity),Xt&&(at.setValue(L,"toneMappingExposure",v.toneMappingExposure),Ae.needsLights&&Cp(Kt,Gs),ie&&G.fog===!0&&$.refreshFogUniforms(Kt,ie),$.refreshMaterialUniforms(Kt,G,W,te,f.state.transmissionRenderTarget[b.id]),Fs.upload(L,iu(Ae),Kt,Ue)),G.isShaderMaterial&&G.uniformsNeedUpdate===!0&&(Fs.upload(L,iu(Ae),Kt,Ue),G.uniformsNeedUpdate=!1),G.isSpriteMaterial&&at.setValue(L,"center",F.center),at.setValue(L,"modelViewMatrix",F.modelViewMatrix),at.setValue(L,"normalMatrix",F.normalMatrix),at.setValue(L,"modelMatrix",F.matrixWorld),G.isShaderMaterial||G.isRawShaderMaterial){let Dt=G.uniformsGroups;for(let Bt=0,zl=Dt.length;Bt<zl;Bt++){let di=Dt[Bt];N.update(di,Wt),N.bind(di,Wt)}}return Wt}function Cp(b,U){b.ambientLightColor.needsUpdate=U,b.lightProbe.needsUpdate=U,b.directionalLights.needsUpdate=U,b.directionalLightShadows.needsUpdate=U,b.pointLights.needsUpdate=U,b.pointLightShadows.needsUpdate=U,b.spotLights.needsUpdate=U,b.spotLightShadows.needsUpdate=U,b.rectAreaLights.needsUpdate=U,b.hemisphereLights.needsUpdate=U}function Rp(b){return b.isMeshLambertMaterial||b.isMeshToonMaterial||b.isMeshPhongMaterial||b.isMeshStandardMaterial||b.isShadowMaterial||b.isShaderMaterial&&b.lights===!0}this.getActiveCubeFace=function(){return I},this.getActiveMipmapLevel=function(){return C},this.getRenderTarget=function(){return P},this.setRenderTargetTextures=function(b,U,V){let G=Se.get(b);G.__autoAllocateDepthBuffer=b.resolveDepthBuffer===!1,G.__autoAllocateDepthBuffer===!1&&(G.__useRenderToTexture=!1),Se.get(b.texture).__webglTexture=U,Se.get(b.depthTexture).__webglTexture=G.__autoAllocateDepthBuffer?void 0:V,G.__hasExternalTextures=!0},this.setRenderTargetFramebuffer=function(b,U){let V=Se.get(b);V.__webglFramebuffer=U,V.__useDefaultFramebuffer=U===void 0};let Ip=L.createFramebuffer();this.setRenderTarget=function(b,U=0,V=0){P=b,I=U,C=V;let G=!0,F=null,ie=!1,ue=!1;if(b){let _e=Se.get(b);if(_e.__useDefaultFramebuffer!==void 0)me.bindFramebuffer(L.FRAMEBUFFER,null),G=!1;else if(_e.__webglFramebuffer===void 0)Ue.setupRenderTarget(b);else if(_e.__hasExternalTextures)Ue.rebindTextures(b,Se.get(b.texture).__webglTexture,Se.get(b.depthTexture).__webglTexture);else if(b.depthBuffer){let Te=b.depthTexture;if(_e.__boundDepthTexture!==Te){if(Te!==null&&Se.has(Te)&&(b.width!==Te.image.width||b.height!==Te.image.height))throw new Error("WebGLRenderTarget: Attached DepthTexture is initialized to the incorrect size.");Ue.setupDepthRenderbuffer(b)}}let Le=b.texture;(Le.isData3DTexture||Le.isDataArrayTexture||Le.isCompressedArrayTexture)&&(ue=!0);let De=Se.get(b).__webglFramebuffer;b.isWebGLCubeRenderTarget?(Array.isArray(De[U])?F=De[U][V]:F=De[U],ie=!0):b.samples>0&&Ue.useMultisampledRTT(b)===!1?F=Se.get(b).__webglMultisampledFramebuffer:Array.isArray(De)?F=De[V]:F=De,T.copy(b.viewport),z.copy(b.scissor),O=b.scissorTest}else T.copy(pe).multiplyScalar(W).floor(),z.copy(Ce).multiplyScalar(W).floor(),O=Xe;if(V!==0&&(F=Ip),me.bindFramebuffer(L.FRAMEBUFFER,F)&&G&&me.drawBuffers(b,F),me.viewport(T),me.scissor(z),me.setScissorTest(O),ie){let _e=Se.get(b.texture);L.framebufferTexture2D(L.FRAMEBUFFER,L.COLOR_ATTACHMENT0,L.TEXTURE_CUBE_MAP_POSITIVE_X+U,_e.__webglTexture,V)}else if(ue){let _e=Se.get(b.texture),Le=U;L.framebufferTextureLayer(L.FRAMEBUFFER,L.COLOR_ATTACHMENT0,_e.__webglTexture,V,Le)}else if(b!==null&&V!==0){let _e=Se.get(b.texture);L.framebufferTexture2D(L.FRAMEBUFFER,L.COLOR_ATTACHMENT0,L.TEXTURE_2D,_e.__webglTexture,V)}S=-1},this.readRenderTargetPixels=function(b,U,V,G,F,ie,ue,Me=0){if(!(b&&b.isWebGLRenderTarget)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let _e=Se.get(b).__webglFramebuffer;if(b.isWebGLCubeRenderTarget&&ue!==void 0&&(_e=_e[ue]),_e){me.bindFramebuffer(L.FRAMEBUFFER,_e);try{let Le=b.textures[Me],De=Le.format,Te=Le.type;if(!$e.textureFormatReadable(De)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}if(!$e.textureTypeReadable(Te)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}U>=0&&U<=b.width-G&&V>=0&&V<=b.height-F&&(b.textures.length>1&&L.readBuffer(L.COLOR_ATTACHMENT0+Me),L.readPixels(U,V,G,F,oe.convert(De),oe.convert(Te),ie))}finally{let Le=P!==null?Se.get(P).__webglFramebuffer:null;me.bindFramebuffer(L.FRAMEBUFFER,Le)}}},this.readRenderTargetPixelsAsync=async function(b,U,V,G,F,ie,ue,Me=0){if(!(b&&b.isWebGLRenderTarget))throw new Error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");let _e=Se.get(b).__webglFramebuffer;if(b.isWebGLCubeRenderTarget&&ue!==void 0&&(_e=_e[ue]),_e)if(U>=0&&U<=b.width-G&&V>=0&&V<=b.height-F){me.bindFramebuffer(L.FRAMEBUFFER,_e);let Le=b.textures[Me],De=Le.format,Te=Le.type;if(!$e.textureFormatReadable(De))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in RGBA or implementation defined format.");if(!$e.textureTypeReadable(Te))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in UnsignedByteType or implementation defined type.");let We=L.createBuffer();L.bindBuffer(L.PIXEL_PACK_BUFFER,We),L.bufferData(L.PIXEL_PACK_BUFFER,ie.byteLength,L.STREAM_READ),b.textures.length>1&&L.readBuffer(L.COLOR_ATTACHMENT0+Me),L.readPixels(U,V,G,F,oe.convert(De),oe.convert(Te),0);let et=P!==null?Se.get(P).__webglFramebuffer:null;me.bindFramebuffer(L.FRAMEBUFFER,et);let mt=L.fenceSync(L.SYNC_GPU_COMMANDS_COMPLETE,0);return L.flush(),await cf(L,mt,4),L.bindBuffer(L.PIXEL_PACK_BUFFER,We),L.getBufferSubData(L.PIXEL_PACK_BUFFER,0,ie),L.deleteBuffer(We),L.deleteSync(mt),ie}else throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: requested read bounds are out of range.")},this.copyFramebufferToTexture=function(b,U=null,V=0){let G=Math.pow(2,-V),F=Math.floor(b.image.width*G),ie=Math.floor(b.image.height*G),ue=U!==null?U.x:0,Me=U!==null?U.y:0;Ue.setTexture2D(b,0),L.copyTexSubImage2D(L.TEXTURE_2D,V,0,0,ue,Me,F,ie),me.unbindTexture()};let Pp=L.createFramebuffer(),Lp=L.createFramebuffer();this.copyTextureToTexture=function(b,U,V=null,G=null,F=0,ie=null){ie===null&&(F!==0?(Pi("WebGLRenderer: copyTextureToTexture function signature has changed to support src and dst mipmap levels."),ie=F,F=0):ie=0);let ue,Me,_e,Le,De,Te,We,et,mt,rt=b.isCompressedTexture?b.mipmaps[ie]:b.image;if(V!==null)ue=V.max.x-V.min.x,Me=V.max.y-V.min.y,_e=V.isBox3?V.max.z-V.min.z:1,Le=V.min.x,De=V.min.y,Te=V.isBox3?V.min.z:0;else{let Jt=Math.pow(2,-F);ue=Math.floor(rt.width*Jt),Me=Math.floor(rt.height*Jt),b.isDataArrayTexture?_e=rt.depth:b.isData3DTexture?_e=Math.floor(rt.depth*Jt):_e=1,Le=0,De=0,Te=0}G!==null?(We=G.x,et=G.y,mt=G.z):(We=0,et=0,mt=0);let nt=oe.convert(U.format),Ae=oe.convert(U.type),ht;U.isData3DTexture?(Ue.setTexture3D(U,0),ht=L.TEXTURE_3D):U.isDataArrayTexture||U.isCompressedArrayTexture?(Ue.setTexture2DArray(U,0),ht=L.TEXTURE_2D_ARRAY):(Ue.setTexture2D(U,0),ht=L.TEXTURE_2D),L.pixelStorei(L.UNPACK_FLIP_Y_WEBGL,U.flipY),L.pixelStorei(L.UNPACK_PREMULTIPLY_ALPHA_WEBGL,U.premultiplyAlpha),L.pixelStorei(L.UNPACK_ALIGNMENT,U.unpackAlignment);let Ze=L.getParameter(L.UNPACK_ROW_LENGTH),Wt=L.getParameter(L.UNPACK_IMAGE_HEIGHT),Yi=L.getParameter(L.UNPACK_SKIP_PIXELS),Xt=L.getParameter(L.UNPACK_SKIP_ROWS),Gs=L.getParameter(L.UNPACK_SKIP_IMAGES);L.pixelStorei(L.UNPACK_ROW_LENGTH,rt.width),L.pixelStorei(L.UNPACK_IMAGE_HEIGHT,rt.height),L.pixelStorei(L.UNPACK_SKIP_PIXELS,Le),L.pixelStorei(L.UNPACK_SKIP_ROWS,De),L.pixelStorei(L.UNPACK_SKIP_IMAGES,Te);let at=b.isDataArrayTexture||b.isData3DTexture,Kt=U.isDataArrayTexture||U.isData3DTexture;if(b.isDepthTexture){let Jt=Se.get(b),Dt=Se.get(U),Bt=Se.get(Jt.__renderTarget),zl=Se.get(Dt.__renderTarget);me.bindFramebuffer(L.READ_FRAMEBUFFER,Bt.__webglFramebuffer),me.bindFramebuffer(L.DRAW_FRAMEBUFFER,zl.__webglFramebuffer);for(let di=0;di<_e;di++)at&&(L.framebufferTextureLayer(L.READ_FRAMEBUFFER,L.COLOR_ATTACHMENT0,Se.get(b).__webglTexture,F,Te+di),L.framebufferTextureLayer(L.DRAW_FRAMEBUFFER,L.COLOR_ATTACHMENT0,Se.get(U).__webglTexture,ie,mt+di)),L.blitFramebuffer(Le,De,ue,Me,We,et,ue,Me,L.DEPTH_BUFFER_BIT,L.NEAREST);me.bindFramebuffer(L.READ_FRAMEBUFFER,null),me.bindFramebuffer(L.DRAW_FRAMEBUFFER,null)}else if(F!==0||b.isRenderTargetTexture||Se.has(b)){let Jt=Se.get(b),Dt=Se.get(U);me.bindFramebuffer(L.READ_FRAMEBUFFER,Pp),me.bindFramebuffer(L.DRAW_FRAMEBUFFER,Lp);for(let Bt=0;Bt<_e;Bt++)at?L.framebufferTextureLayer(L.READ_FRAMEBUFFER,L.COLOR_ATTACHMENT0,Jt.__webglTexture,F,Te+Bt):L.framebufferTexture2D(L.READ_FRAMEBUFFER,L.COLOR_ATTACHMENT0,L.TEXTURE_2D,Jt.__webglTexture,F),Kt?L.framebufferTextureLayer(L.DRAW_FRAMEBUFFER,L.COLOR_ATTACHMENT0,Dt.__webglTexture,ie,mt+Bt):L.framebufferTexture2D(L.DRAW_FRAMEBUFFER,L.COLOR_ATTACHMENT0,L.TEXTURE_2D,Dt.__webglTexture,ie),F!==0?L.blitFramebuffer(Le,De,ue,Me,We,et,ue,Me,L.COLOR_BUFFER_BIT,L.NEAREST):Kt?L.copyTexSubImage3D(ht,ie,We,et,mt+Bt,Le,De,ue,Me):L.copyTexSubImage2D(ht,ie,We,et,Le,De,ue,Me);me.bindFramebuffer(L.READ_FRAMEBUFFER,null),me.bindFramebuffer(L.DRAW_FRAMEBUFFER,null)}else Kt?b.isDataTexture||b.isData3DTexture?L.texSubImage3D(ht,ie,We,et,mt,ue,Me,_e,nt,Ae,rt.data):U.isCompressedArrayTexture?L.compressedTexSubImage3D(ht,ie,We,et,mt,ue,Me,_e,nt,rt.data):L.texSubImage3D(ht,ie,We,et,mt,ue,Me,_e,nt,Ae,rt):b.isDataTexture?L.texSubImage2D(L.TEXTURE_2D,ie,We,et,ue,Me,nt,Ae,rt.data):b.isCompressedTexture?L.compressedTexSubImage2D(L.TEXTURE_2D,ie,We,et,rt.width,rt.height,nt,rt.data):L.texSubImage2D(L.TEXTURE_2D,ie,We,et,ue,Me,nt,Ae,rt);L.pixelStorei(L.UNPACK_ROW_LENGTH,Ze),L.pixelStorei(L.UNPACK_IMAGE_HEIGHT,Wt),L.pixelStorei(L.UNPACK_SKIP_PIXELS,Yi),L.pixelStorei(L.UNPACK_SKIP_ROWS,Xt),L.pixelStorei(L.UNPACK_SKIP_IMAGES,Gs),ie===0&&U.generateMipmaps&&L.generateMipmap(ht),me.unbindTexture()},this.copyTextureToTexture3D=function(b,U,V=null,G=null,F=0){return Pi('WebGLRenderer: copyTextureToTexture3D function has been deprecated. Use "copyTextureToTexture" instead.'),this.copyTextureToTexture(b,U,V,G,F)},this.initRenderTarget=function(b){Se.get(b).__webglFramebuffer===void 0&&Ue.setupRenderTarget(b)},this.initTexture=function(b){b.isCubeTexture?Ue.setTextureCube(b,0):b.isData3DTexture?Ue.setTexture3D(b,0):b.isDataArrayTexture||b.isCompressedArrayTexture?Ue.setTexture2DArray(b,0):Ue.setTexture2D(b,0),me.unbindTexture()},this.resetState=function(){I=0,C=0,P=null,me.reset(),Fe.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return yn}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(e){this._outputColorSpace=e;let t=this.getContext();t.drawingBufferColorSpace=Ye._getDrawingBufferColorSpace(e),t.unpackColorSpace=Ye._getUnpackColorSpace()}}});function Wi(i,e,t=1){let n=new lt;n.setAttribute("position",new ft(i,3));let s=new Gt({color:e,transparent:t<1,opacity:t});return new Fn(n,s)}function Xi(i){i.traverse(e=>{let t=e;t.geometry?.dispose();let n=t.material===void 0?[]:Array.isArray(t.material)?t.material:[t.material];for(let s of n)s.map?.dispose(),s.dispose()})}function Bs(i,e){yi(i);let t=new nn;t.name="buildVolume";let n=e?.gridColor??4491332,s=e?.gridOpacity??.35,r=e?.boxColor??8947848,o=e?.boxOpacity??.5,a=i.grid??10,l=i.min?.x??0,c=i.min?.y??0,h=l+i.x,u=c+i.y,p=e?.gridMajor,d=e?.bedOutline!==void 0,g=0;if(p!==void 0){if(!(Number.isFinite(p.every)&&p.every>0))throw new RangeError(`gridMajor.every must be a positive number (got ${String(p.every)})`);g=Math.max(1,Math.round(p.every/a))}let _=P=>P%g===0?"major":"minor",m=(P,S,x)=>d&&(Math.abs(P-S)<1e-6||Math.abs(P-x)<1e-6),f=cv(i),w=e?.bedSurface;if(w&&w.mode==="solid"){if((w.thickness??0)>0){let P=f??[{x:l,y:c},{x:h,y:c},{x:h,y:u},{x:l,y:u}];t.add(av(P,w))}t.add(f?fv(f,w):lv(l,c,h,u,w))}if(f){let P=jf(l,c,h,u,a,f,_,"minor",d);if(t.add(Wi(P,n,s)),p!==void 0){let x=jf(l,c,h,u,a,f,_,"major",d);t.add($f(x,p.color??n,p.opacity,"gridMajor"))}let S=e?.bedOutline;t.add(S!==void 0?Ih(f,S.color??n,S.opacity,Yf,!0):Ih(f,n,Math.min(1,s+.3)))}else{let P=[],S=[],x=0;for(let z=0,O=l;z<=En&&O<=h+1e-6;z++,O+=a){let X=_(x++);m(O,l,h)||(X==="major"?S:P).push(O,c,0,O,u,0)}x=0;for(let z=0,O=c;z<=En&&O<=u+1e-6;z++,O+=a){let X=_(x++);m(O,c,u)||(X==="major"?S:P).push(l,O,0,h,O,0)}t.add(Wi(P,n,s)),p!==void 0&&t.add($f(S,p.color??n,p.opacity,"gridMajor"));let T=e?.bedOutline;if(T!==void 0){let z=[{x:l,y:c},{x:h,y:c},{x:h,y:u},{x:l,y:u}];t.add(Ih(z,T.color??n,T.opacity,Yf,!0))}}let M=i.z,v=[],A=[[l,c],[h,c],[h,u],[l,u]];for(let P=0;P<4;P++){let[S,x]=A[P],[T,z]=A[(P+1)%4];d||v.push(S,x,0,T,z,0),v.push(S,x,M,T,z,M),v.push(S,x,0,S,x,M)}let I=Wi(v,r,o);I.name="volumeCage",I.visible=e?.showCage??!0,t.add(I);for(let P of i.excludedRegions??[]){let S=pv(P);S&&t.add(S)}let C=Math.max(2,a/2);return t.add(Wi([0,0,0,C,0,0],13386820)),t.add(Wi([0,0,0,0,C,0],4508740)),t.add(Wi([0,0,0,0,0,C],4474060)),t}function $f(i,e,t,n){let s=Wi(i,e,t);return s.name=n,s}function av(i,e){let n=-.05-(e.thickness??0),s=[];for(let l=0;l<i.length;l++){let c=i[l],h=i[(l+1)%i.length];s.push(c.x,c.y,-.05,h.x,h.y,-.05,h.x,h.y,n),s.push(c.x,c.y,-.05,h.x,h.y,n,c.x,c.y,n)}let r=new lt;r.setAttribute("position",new ft(s,3));let o=new Vt({color:e.edgeColor??e.color??2764602,opacity:e.opacity??1,transparent:(e.opacity??1)<1,side:Rt,depthWrite:!1}),a=new gt(r,o);return a.name="bedSurfaceEdge",a.renderOrder=ov,a}function lv(i,e,t,n,s){let r=t-i,o=n-e,a=new On(r,o);a.translate(i+r/2,e+o/2,-.05);let l=new Vt({color:s.color??2764602,opacity:s.opacity??1,transparent:(s.opacity??1)<1,side:Rt,depthWrite:!1});if(s.texture){let h=new Es(s.texture);h.colorSpace=xt,l.map=h,l.needsUpdate=!0}let c=new gt(a,l);return c.name="bedSurface",c.renderOrder=Kf,c}function cv(i){let e=i.shape;if(!e||e.kind==="rect")return null;if(e.kind==="circular"){let t=e.diameter/2,n=[];for(let s=0;s<Zf;s++){let r=s/Zf*Math.PI*2;n.push({x:e.center.x+t*Math.cos(r),y:e.center.y+t*Math.sin(r)})}return n}return e.points.length<3?null:e.points.map(t=>({x:t.x,y:t.y}))}function hv(i,e,t){for(let n=0,s=t.length-1;n<t.length;s=n++){let r=t[s].x,o=t[s].y,a=t[n].x-r,l=t[n].y-o,c=a*a+l*l,h=Math.max(0,Math.min(1,((i-r)*a+(e-o)*l)/c));if(Math.hypot(i-(r+a*h),e-(o+l*h))<1e-6)return!0}return!1}function uv(i,e,t){let n=!1;for(let s=0,r=t.length-1;s<t.length;r=s++){let o=t[s].x,a=t[s].y,l=t[r].x,c=t[r].y;a>e!=c>e&&i<(l-o)*(e-a)/(c-a)+o&&(n=!n)}return n}function jf(i,e,t,n,s,r,o,a,l){let c=[],h=(p,d,g,_)=>{let m=[0,1];for(let f=0,w=r.length-1;f<r.length;w=f++){let M=dv(p,d,g,_,r[w].x,r[w].y,r[f].x,r[f].y);M!==null&&m.push(M)}m.sort((f,w)=>f-w);for(let f=0;f+1<m.length;f++){let w=m[f],M=m[f+1];if(M-w<1e-9)continue;let v=(w+M)/2,A=p+(g-p)*v,I=d+(_-d)*v;l&&hv(A,I,r)||uv(A,I,r)&&c.push(p+(g-p)*w,d+(_-d)*w,0,p+(g-p)*M,d+(_-d)*M,0)}},u=0;for(let p=0,d=i;p<=En&&d<=t+1e-6;p++,d+=s)o(u++)===a&&h(d,e,d,n);u=0;for(let p=0,d=e;p<=En&&d<=n+1e-6;p++,d+=s)o(u++)===a&&h(i,d,t,d);return c}function dv(i,e,t,n,s,r,o,a){let l=t-i,c=n-e,h=o-s,u=a-r,p=l*u-c*h;if(Math.abs(p)<1e-12)return null;let d=((s-i)*u-(r-e)*h)/p,g=((s-i)*c-(r-e)*l)/p;return d<=0||d>=1||g<0||g>1?null:d}function fv(i,e){let t=new As;t.moveTo(i[0].x,i[0].y);for(let o=1;o<i.length;o++)t.lineTo(i[o].x,i[o].y);t.closePath();let n=new Or(t);n.translate(0,0,-.05);let s=new Vt({color:e.color??2764602,opacity:e.opacity??1,transparent:(e.opacity??1)<1,side:Rt,depthWrite:!1});if(e.texture){let o=new Es(e.texture);o.colorSpace=xt,s.map=o,s.needsUpdate=!0}let r=new gt(n,s);return r.name="bedSurface",r.renderOrder=Kf,r}function Ih(i,e,t,n=0,s=!1){let r=[];for(let c of i)r.push(c.x,c.y,.01);let o=new lt;o.setAttribute("position",new ft(r,3));let a=new Gt({color:e,transparent:s||t<1,opacity:t}),l=new Ss(o,a);return l.name="bedOutline",l.renderOrder=n,l}function pv(i){let e=[];if(i.kind==="rect"){let[s,r]=i.points;if(!s||!r)return null;e.push(s.x,s.y,.02,r.x,s.y,.02,r.x,r.y,.02,s.x,r.y,.02)}else{if(i.points.length<3)return null;for(let s of i.points)e.push(s.x,s.y,.02)}let t=new lt;t.setAttribute("position",new ft(e,3));let n=new Ss(t,new Gt({color:13666858,transparent:!0,opacity:.9}));return n.name="excludedRegion",n}var ov,Kf,Yf,Zf,Ph=He(()=>{ci();_n();ov=-2,Kf=-1,Yf=1;Zf=96});function xl(i,e){return{gridColor:i.gridColor,gridOpacity:i.gridOpacity,boxColor:i.bedColor,boxOpacity:i.bedOpacity,bedSurface:i.bedSurface,showCage:e,...i.gridMajor!==void 0?{gridMajor:i.gridMajor}:{},...i.bedOutline!==void 0?{bedOutline:i.bedOutline}:{}}}var Lh=He(()=>{});function Jf(i){let e=new Ne(i).getHex();return[e>>16&255,e>>8&255,e&255]}function Ml(i){let e=Jf(i.bottom),t=Jf(i.top),n=new Uint8Array(vl*4);for(let r=0;r<vl;r++){let o=r/(vl-1);for(let a=0;a<3;a++)n[r*4+a]=Math.round(e[a]+(t[a]-e[a])*o);n[r*4+3]=255}let s=new Li(n,1,vl,It,Ot);return s.colorSpace=xt,s.magFilter=Et,s.minFilter=Et,s.generateMipmaps=!1,s.needsUpdate=!0,{texture:s,dispose:()=>s.dispose()}}var vl,Dh=He(()=>{ci();vl=256});function mv(){let i=new Uint8Array(hi*hi*4),e=(hi-1)/2;for(let n=0;n<hi;n++)for(let s=0;s<hi;s++){let o=1-Math.min(1,Math.hypot(s-e,n-e)/e),a=(n*hi+s)*4;i[a+3]=Math.round(255*o*o*(3-2*o))}let t=new Li(i,hi,hi,It,Ot);return t.magFilter=Et,t.minFilter=Et,t.generateMipmaps=!1,t.needsUpdate=!0,t}function bl(i,e){if(!(e>=0&&e<=1))throw new RangeError(`contactShadow opacity must be a number in [0,1] (got ${String(e)})`);if(i===null)return null;let t=i.max.x-i.min.x,n=i.max.y-i.min.y;if(!(t>0&&n>0&&t<1/0&&n<1/0))return null;let s=i.min.x+t/2,r=i.min.y+n/2,o=new On(t*Qf,n*Qf);o.translate(s,r,Nh);let a=new Vt({color:0,map:mv(),transparent:!0,opacity:e,side:Rt,depthWrite:!1}),l=new gt(o,a);return l.name="contactShadow",l.renderOrder=-.5,l}var hi,Qf,Nh,Uh=He(()=>{ci();hi=64,Qf=1.4,Nh=-.04});function ep(i){return typeof i.setRenderTarget=="function"&&typeof i.readRenderTargetPixels=="function"}function Sl(i,e={}){return new _l({canvas:i,antialias:e.antialias??!0,preserveDrawingBuffer:e.preserveDrawingBuffer??!1,alpha:e.alpha??!1})}function wl(i,e,t=50){kt(t);let n=new D(i.x,i.z,-i.y),s=e*1.25,r=qi(t),o=new D(n.x-e*1.2*r,n.y+e*1.6*r,n.z+e*1.8*r);return{target:n,position:o,viewHalfHeight:s}}function qi(i){let e=i/2*Math.PI/180,t=25*Math.PI/180;return Math.max(Math.tan(t)/Math.tan(e),Math.sin(t)/Math.sin(e))}function tp(i,e){return kt(i),kt(e),Math.tan(i/2*Math.PI/180)/Math.tan(e/2*Math.PI/180)}var El,Tl=He(()=>{ci();_n();_n();El=2});function to(i){if(i==null)return"unknown";let e=i.toLowerCase();for(let t of gv)if(e.includes(t))return"software";for(let t of _v)if(e.includes(t))return"hardware";return"unknown"}function np(i){try{let e=i.getExtension("WEBGL_debug_renderer_info");if(e===null)return{capability:"unknown",rawRenderer:null};let t=i.getParameter(e.UNMASKED_RENDERER_WEBGL);return typeof t!="string"||t.length===0?{capability:"unknown",rawRenderer:null}:{capability:to(t),rawRenderer:t}}catch{return{capability:"unknown",rawRenderer:null}}}function ip(i,e){return i==="software"||i==="hardware"?i:e==="hardware"?"hardware":"software"}var gv,_v,Fh=He(()=>{gv=["swiftshader","llvmpipe","basic render driver","software rasterizer","microsoft basic render","softpipe","lavapipe"],_v=["nvidia","geforce","quadro","radeon","amd ","intel","apple","adreno","mali","powervr","mesa","iris","metal","directx","d3d11","vega","rtx","gtx"]});function Al(i){try{let e=i,t=e.getContext?.(),n=e.capabilities?.isWebGL2===!0?2:e.capabilities?.isWebGL2===!1?1:null,s=t.getExtension("WEBGL_debug_renderer_info");if(s==null)return{webglVersion:n,capability:"unknown",gpuRenderer:null,gpuVendor:null};let r=t.getParameter(s.UNMASKED_RENDERER_WEBGL),o=t.getParameter(s.UNMASKED_VENDOR_WEBGL),a=typeof r=="string"&&r.length>0?r:null,l=typeof o=="string"&&o.length>0?o:null;return{webglVersion:n,capability:to(a),gpuRenderer:a,gpuVendor:l}}catch{return Oh}}var Oh,Bh=He(()=>{Fh();Oh={webglVersion:null,capability:"unknown",gpuRenderer:null,gpuVendor:null}});function sp(){return new Worker(new URL("./vendor-gcode-geo-worker.js",import.meta.url))}function Cl(i,e=8){let t=typeof i=="number"&&Number.isFinite(i)?Math.floor(i):2;return Math.max(1,Math.min(e,t-1))}var ks,kh=He(()=>{ks=class{size;workers=[];current=new Map;disposed=!1;epoch=0;wireSeq=0;constructor(e,t){this.size=e;for(let n=0;n<Math.max(1,e);n++){let s=t();s.onmessage=o=>{let a=this.current.get(s);a===void 0||o.data.id!==a.wireId||(this.current.delete(s),"error"in o.data?a.reject(new Error(o.data.error)):a.resolve({...o.data,id:a.callerId}))};let r=o=>{let a=this.current.get(s);this.current.delete(s),a?.reject(o instanceof Error?o:new Error(String(o)))};s.onerror=r,s.onmessageerror=r,this.workers.push(s)}}dispatch(e,t){return new Promise((n,s)=>{let r=++this.wireSeq;this.current.set(e,{wireId:r,callerId:t.id,resolve:n,reject:s}),e.postMessage({...t,id:r},[t.positions])})}async buildStreaming(e,t){let n=++this.epoch;for(let l of this.current.values())l.reject(new Error("E_POOL_SUPERSEDED: a newer geometry build took over"));this.current.clear();let s=0,r=!1,o=()=>!this.disposed&&n===this.epoch&&!r,a=async l=>{for(;o();){let c=s++;if(c>=e.length)return;let h;try{h=await this.dispatch(l,e[c])}catch(u){if(this.disposed||n!==this.epoch)return;throw r=!0,u}if(!o())return;t(c,h)}};await Promise.all(this.workers.map(l=>a(l)))}async buildAll(e){let t=new Array(e.length).fill(null);return await this.buildStreaming(e,(n,s)=>{t[n]=s}),t}dispose(){this.disposed=!0;for(let e of this.current.values())e.reject(new Error("E_POOL_DISPOSED: geometry pool disposed mid-build"));this.current.clear();for(let e of this.workers)e.terminate();this.workers.length=0}}});function zh(i,e,t){return i*(e+1)*445/1e6*(t==="software"?3:1)}var rp,op,ap=He(()=>{rp=250,op=250});function xv(i){this.enabled!==!1&&(this._pointers.length===0&&(this.domElement.setPointerCapture(i.pointerId),this.domElement.addEventListener("pointermove",this._onPointerMove),this.domElement.addEventListener("pointerup",this._onPointerUp)),!this._isTrackingPointer(i)&&(this._addPointer(i),i.pointerType==="touch"?this._onTouchStart(i):this._onMouseDown(i)))}function vv(i){this.enabled!==!1&&(i.pointerType==="touch"?this._onTouchMove(i):this._onMouseMove(i))}function Mv(i){switch(this._removePointer(i),this._pointers.length){case 0:this.domElement.releasePointerCapture(i.pointerId),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.dispatchEvent(hp),this.state=tt.NONE;break;case 1:let e=this._pointers[0],t=this._pointerPositions[e];this._onTouchStart({pointerId:e,pageX:t.x,pageY:t.y});break}}function bv(i){let e;switch(i.button){case 0:e=this.mouseButtons.LEFT;break;case 1:e=this.mouseButtons.MIDDLE;break;case 2:e=this.mouseButtons.RIGHT;break;default:e=-1}switch(e){case ri.DOLLY:if(this.enableZoom===!1)return;this._handleMouseDownDolly(i),this.state=tt.DOLLY;break;case ri.ROTATE:if(i.ctrlKey||i.metaKey||i.shiftKey){if(this.enablePan===!1)return;this._handleMouseDownPan(i),this.state=tt.PAN}else{if(this.enableRotate===!1)return;this._handleMouseDownRotate(i),this.state=tt.ROTATE}break;case ri.PAN:if(i.ctrlKey||i.metaKey||i.shiftKey){if(this.enableRotate===!1)return;this._handleMouseDownRotate(i),this.state=tt.ROTATE}else{if(this.enablePan===!1)return;this._handleMouseDownPan(i),this.state=tt.PAN}break;default:this.state=tt.NONE}this.state!==tt.NONE&&this.dispatchEvent(Gh)}function Sv(i){switch(this.state){case tt.ROTATE:if(this.enableRotate===!1)return;this._handleMouseMoveRotate(i);break;case tt.DOLLY:if(this.enableZoom===!1)return;this._handleMouseMoveDolly(i);break;case tt.PAN:if(this.enablePan===!1)return;this._handleMouseMovePan(i);break}}function wv(i){this.enabled===!1||this.enableZoom===!1||this.state!==tt.NONE||(i.preventDefault(),this.dispatchEvent(Gh),this._handleMouseWheel(this._customWheelEvent(i)),this.dispatchEvent(hp))}function Ev(i){this.enabled!==!1&&this._handleKeyDown(i)}function Tv(i){switch(this._trackPointer(i),this._pointers.length){case 1:switch(this.touches.ONE){case oi.ROTATE:if(this.enableRotate===!1)return;this._handleTouchStartRotate(i),this.state=tt.TOUCH_ROTATE;break;case oi.PAN:if(this.enablePan===!1)return;this._handleTouchStartPan(i),this.state=tt.TOUCH_PAN;break;default:this.state=tt.NONE}break;case 2:switch(this.touches.TWO){case oi.DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchStartDollyPan(i),this.state=tt.TOUCH_DOLLY_PAN;break;case oi.DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchStartDollyRotate(i),this.state=tt.TOUCH_DOLLY_ROTATE;break;default:this.state=tt.NONE}break;default:this.state=tt.NONE}this.state!==tt.NONE&&this.dispatchEvent(Gh)}function Av(i){switch(this._trackPointer(i),this.state){case tt.TOUCH_ROTATE:if(this.enableRotate===!1)return;this._handleTouchMoveRotate(i),this.update();break;case tt.TOUCH_PAN:if(this.enablePan===!1)return;this._handleTouchMovePan(i),this.update();break;case tt.TOUCH_DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchMoveDollyPan(i),this.update();break;case tt.TOUCH_DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchMoveDollyRotate(i),this.update();break;default:this.state=tt.NONE}}function Cv(i){this.enabled!==!1&&i.preventDefault()}function Rv(i){i.key==="Control"&&(this._controlActive=!0,this.domElement.getRootNode().addEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}function Iv(i){i.key==="Control"&&(this._controlActive=!1,this.domElement.getRootNode().removeEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}var lp,Gh,hp,Rl,cp,yv,bt,Ht,tt,Vh,Il,up=He(()=>{ci();lp={type:"change"},Gh={type:"start"},hp={type:"end"},Rl=new Un,cp=new tn,yv=Math.cos(70*ah.DEG2RAD),bt=new D,Ht=2*Math.PI,tt={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,TOUCH_ROTATE:3,TOUCH_PAN:4,TOUCH_DOLLY_PAN:5,TOUCH_DOLLY_ROTATE:6},Vh=1e-6,Il=class extends qr{constructor(e,t=null){super(e,t),this.state=tt.NONE,this.target=new D,this.cursor=new D,this.minDistance=0,this.maxDistance=1/0,this.minZoom=0,this.maxZoom=1/0,this.minTargetRadius=0,this.maxTargetRadius=1/0,this.minPolarAngle=0,this.maxPolarAngle=Math.PI,this.minAzimuthAngle=-1/0,this.maxAzimuthAngle=1/0,this.enableDamping=!1,this.dampingFactor=.05,this.enableZoom=!0,this.zoomSpeed=1,this.enableRotate=!0,this.rotateSpeed=1,this.keyRotateSpeed=1,this.enablePan=!0,this.panSpeed=1,this.screenSpacePanning=!0,this.keyPanSpeed=7,this.zoomToCursor=!1,this.autoRotate=!1,this.autoRotateSpeed=2,this.keys={LEFT:"ArrowLeft",UP:"ArrowUp",RIGHT:"ArrowRight",BOTTOM:"ArrowDown"},this.mouseButtons={LEFT:ri.ROTATE,MIDDLE:ri.DOLLY,RIGHT:ri.PAN},this.touches={ONE:oi.ROTATE,TWO:oi.DOLLY_PAN},this.target0=this.target.clone(),this.position0=this.object.position.clone(),this.zoom0=this.object.zoom,this._domElementKeyEvents=null,this._lastPosition=new D,this._lastQuaternion=new sn,this._lastTargetPosition=new D,this._quat=new sn().setFromUnitVectors(e.up,new D(0,1,0)),this._quatInverse=this._quat.clone().invert(),this._spherical=new Rs,this._sphericalDelta=new Rs,this._scale=1,this._panOffset=new D,this._rotateStart=new ce,this._rotateEnd=new ce,this._rotateDelta=new ce,this._panStart=new ce,this._panEnd=new ce,this._panDelta=new ce,this._dollyStart=new ce,this._dollyEnd=new ce,this._dollyDelta=new ce,this._dollyDirection=new D,this._mouse=new ce,this._performCursorZoom=!1,this._pointers=[],this._pointerPositions={},this._controlActive=!1,this._onPointerMove=vv.bind(this),this._onPointerDown=xv.bind(this),this._onPointerUp=Mv.bind(this),this._onContextMenu=Cv.bind(this),this._onMouseWheel=wv.bind(this),this._onKeyDown=Ev.bind(this),this._onTouchStart=Tv.bind(this),this._onTouchMove=Av.bind(this),this._onMouseDown=bv.bind(this),this._onMouseMove=Sv.bind(this),this._interceptControlDown=Rv.bind(this),this._interceptControlUp=Iv.bind(this),this.domElement!==null&&this.connect(this.domElement),this.update()}connect(e){super.connect(e),this.domElement.addEventListener("pointerdown",this._onPointerDown),this.domElement.addEventListener("pointercancel",this._onPointerUp),this.domElement.addEventListener("contextmenu",this._onContextMenu),this.domElement.addEventListener("wheel",this._onMouseWheel,{passive:!1}),this.domElement.getRootNode().addEventListener("keydown",this._interceptControlDown,{passive:!0,capture:!0}),this.domElement.style.touchAction="none"}disconnect(){this.domElement.removeEventListener("pointerdown",this._onPointerDown),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.domElement.removeEventListener("pointercancel",this._onPointerUp),this.domElement.removeEventListener("wheel",this._onMouseWheel),this.domElement.removeEventListener("contextmenu",this._onContextMenu),this.stopListenToKeyEvents(),this.domElement.getRootNode().removeEventListener("keydown",this._interceptControlDown,{capture:!0}),this.domElement.style.touchAction="auto"}dispose(){this.disconnect()}getPolarAngle(){return this._spherical.phi}getAzimuthalAngle(){return this._spherical.theta}getDistance(){return this.object.position.distanceTo(this.target)}listenToKeyEvents(e){e.addEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=e}stopListenToKeyEvents(){this._domElementKeyEvents!==null&&(this._domElementKeyEvents.removeEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=null)}saveState(){this.target0.copy(this.target),this.position0.copy(this.object.position),this.zoom0=this.object.zoom}reset(){this.target.copy(this.target0),this.object.position.copy(this.position0),this.object.zoom=this.zoom0,this.object.updateProjectionMatrix(),this.dispatchEvent(lp),this.update(),this.state=tt.NONE}update(e=null){let t=this.object.position;bt.copy(t).sub(this.target),bt.applyQuaternion(this._quat),this._spherical.setFromVector3(bt),this.autoRotate&&this.state===tt.NONE&&this._rotateLeft(this._getAutoRotationAngle(e)),this.enableDamping?(this._spherical.theta+=this._sphericalDelta.theta*this.dampingFactor,this._spherical.phi+=this._sphericalDelta.phi*this.dampingFactor):(this._spherical.theta+=this._sphericalDelta.theta,this._spherical.phi+=this._sphericalDelta.phi);let n=this.minAzimuthAngle,s=this.maxAzimuthAngle;isFinite(n)&&isFinite(s)&&(n<-Math.PI?n+=Ht:n>Math.PI&&(n-=Ht),s<-Math.PI?s+=Ht:s>Math.PI&&(s-=Ht),n<=s?this._spherical.theta=Math.max(n,Math.min(s,this._spherical.theta)):this._spherical.theta=this._spherical.theta>(n+s)/2?Math.max(n,this._spherical.theta):Math.min(s,this._spherical.theta)),this._spherical.phi=Math.max(this.minPolarAngle,Math.min(this.maxPolarAngle,this._spherical.phi)),this._spherical.makeSafe(),this.enableDamping===!0?this.target.addScaledVector(this._panOffset,this.dampingFactor):this.target.add(this._panOffset),this.target.sub(this.cursor),this.target.clampLength(this.minTargetRadius,this.maxTargetRadius),this.target.add(this.cursor);let r=!1;if(this.zoomToCursor&&this._performCursorZoom||this.object.isOrthographicCamera)this._spherical.radius=this._clampDistance(this._spherical.radius);else{let o=this._spherical.radius;this._spherical.radius=this._clampDistance(this._spherical.radius*this._scale),r=o!=this._spherical.radius}if(bt.setFromSpherical(this._spherical),bt.applyQuaternion(this._quatInverse),t.copy(this.target).add(bt),this.object.lookAt(this.target),this.enableDamping===!0?(this._sphericalDelta.theta*=1-this.dampingFactor,this._sphericalDelta.phi*=1-this.dampingFactor,this._panOffset.multiplyScalar(1-this.dampingFactor)):(this._sphericalDelta.set(0,0,0),this._panOffset.set(0,0,0)),this.zoomToCursor&&this._performCursorZoom){let o=null;if(this.object.isPerspectiveCamera){let a=bt.length();o=this._clampDistance(a*this._scale);let l=a-o;this.object.position.addScaledVector(this._dollyDirection,l),this.object.updateMatrixWorld(),r=!!l}else if(this.object.isOrthographicCamera){let a=new D(this._mouse.x,this._mouse.y,0);a.unproject(this.object);let l=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),this.object.updateProjectionMatrix(),r=l!==this.object.zoom;let c=new D(this._mouse.x,this._mouse.y,0);c.unproject(this.object),this.object.position.sub(c).add(a),this.object.updateMatrixWorld(),o=bt.length()}else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled."),this.zoomToCursor=!1;o!==null&&(this.screenSpacePanning?this.target.set(0,0,-1).transformDirection(this.object.matrix).multiplyScalar(o).add(this.object.position):(Rl.origin.copy(this.object.position),Rl.direction.set(0,0,-1).transformDirection(this.object.matrix),Math.abs(this.object.up.dot(Rl.direction))<yv?this.object.lookAt(this.target):(cp.setFromNormalAndCoplanarPoint(this.object.up,this.target),Rl.intersectPlane(cp,this.target))))}else if(this.object.isOrthographicCamera){let o=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),o!==this.object.zoom&&(this.object.updateProjectionMatrix(),r=!0)}return this._scale=1,this._performCursorZoom=!1,r||this._lastPosition.distanceToSquared(this.object.position)>Vh||8*(1-this._lastQuaternion.dot(this.object.quaternion))>Vh||this._lastTargetPosition.distanceToSquared(this.target)>Vh?(this.dispatchEvent(lp),this._lastPosition.copy(this.object.position),this._lastQuaternion.copy(this.object.quaternion),this._lastTargetPosition.copy(this.target),!0):!1}_getAutoRotationAngle(e){return e!==null?Ht/60*this.autoRotateSpeed*e:Ht/60/60*this.autoRotateSpeed}_getZoomScale(e){let t=Math.abs(e*.01);return Math.pow(.95,this.zoomSpeed*t)}_rotateLeft(e){this._sphericalDelta.theta-=e}_rotateUp(e){this._sphericalDelta.phi-=e}_panLeft(e,t){bt.setFromMatrixColumn(t,0),bt.multiplyScalar(-e),this._panOffset.add(bt)}_panUp(e,t){this.screenSpacePanning===!0?bt.setFromMatrixColumn(t,1):(bt.setFromMatrixColumn(t,0),bt.crossVectors(this.object.up,bt)),bt.multiplyScalar(e),this._panOffset.add(bt)}_pan(e,t){let n=this.domElement;if(this.object.isPerspectiveCamera){let s=this.object.position;bt.copy(s).sub(this.target);let r=bt.length();r*=Math.tan(this.object.fov/2*Math.PI/180),this._panLeft(2*e*r/n.clientHeight,this.object.matrix),this._panUp(2*t*r/n.clientHeight,this.object.matrix)}else this.object.isOrthographicCamera?(this._panLeft(e*(this.object.right-this.object.left)/this.object.zoom/n.clientWidth,this.object.matrix),this._panUp(t*(this.object.top-this.object.bottom)/this.object.zoom/n.clientHeight,this.object.matrix)):(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - pan disabled."),this.enablePan=!1)}_dollyOut(e){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?this._scale/=e:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_dollyIn(e){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?this._scale*=e:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_updateZoomParameters(e,t){if(!this.zoomToCursor)return;this._performCursorZoom=!0;let n=this.domElement.getBoundingClientRect(),s=e-n.left,r=t-n.top,o=n.width,a=n.height;this._mouse.x=s/o*2-1,this._mouse.y=-(r/a)*2+1,this._dollyDirection.set(this._mouse.x,this._mouse.y,1).unproject(this.object).sub(this.object.position).normalize()}_clampDistance(e){return Math.max(this.minDistance,Math.min(this.maxDistance,e))}_handleMouseDownRotate(e){this._rotateStart.set(e.clientX,e.clientY)}_handleMouseDownDolly(e){this._updateZoomParameters(e.clientX,e.clientX),this._dollyStart.set(e.clientX,e.clientY)}_handleMouseDownPan(e){this._panStart.set(e.clientX,e.clientY)}_handleMouseMoveRotate(e){this._rotateEnd.set(e.clientX,e.clientY),this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);let t=this.domElement;this._rotateLeft(Ht*this._rotateDelta.x/t.clientHeight),this._rotateUp(Ht*this._rotateDelta.y/t.clientHeight),this._rotateStart.copy(this._rotateEnd),this.update()}_handleMouseMoveDolly(e){this._dollyEnd.set(e.clientX,e.clientY),this._dollyDelta.subVectors(this._dollyEnd,this._dollyStart),this._dollyDelta.y>0?this._dollyOut(this._getZoomScale(this._dollyDelta.y)):this._dollyDelta.y<0&&this._dollyIn(this._getZoomScale(this._dollyDelta.y)),this._dollyStart.copy(this._dollyEnd),this.update()}_handleMouseMovePan(e){this._panEnd.set(e.clientX,e.clientY),this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd),this.update()}_handleMouseWheel(e){this._updateZoomParameters(e.clientX,e.clientY),e.deltaY<0?this._dollyIn(this._getZoomScale(e.deltaY)):e.deltaY>0&&this._dollyOut(this._getZoomScale(e.deltaY)),this.update()}_handleKeyDown(e){let t=!1;switch(e.code){case this.keys.UP:e.ctrlKey||e.metaKey||e.shiftKey?this.enableRotate&&this._rotateUp(Ht*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(0,this.keyPanSpeed),t=!0;break;case this.keys.BOTTOM:e.ctrlKey||e.metaKey||e.shiftKey?this.enableRotate&&this._rotateUp(-Ht*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(0,-this.keyPanSpeed),t=!0;break;case this.keys.LEFT:e.ctrlKey||e.metaKey||e.shiftKey?this.enableRotate&&this._rotateLeft(Ht*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(this.keyPanSpeed,0),t=!0;break;case this.keys.RIGHT:e.ctrlKey||e.metaKey||e.shiftKey?this.enableRotate&&this._rotateLeft(-Ht*this.keyRotateSpeed/this.domElement.clientHeight):this.enablePan&&this._pan(-this.keyPanSpeed,0),t=!0;break}t&&(e.preventDefault(),this.update())}_handleTouchStartRotate(e){if(this._pointers.length===1)this._rotateStart.set(e.pageX,e.pageY);else{let t=this._getSecondPointerPosition(e),n=.5*(e.pageX+t.x),s=.5*(e.pageY+t.y);this._rotateStart.set(n,s)}}_handleTouchStartPan(e){if(this._pointers.length===1)this._panStart.set(e.pageX,e.pageY);else{let t=this._getSecondPointerPosition(e),n=.5*(e.pageX+t.x),s=.5*(e.pageY+t.y);this._panStart.set(n,s)}}_handleTouchStartDolly(e){let t=this._getSecondPointerPosition(e),n=e.pageX-t.x,s=e.pageY-t.y,r=Math.sqrt(n*n+s*s);this._dollyStart.set(0,r)}_handleTouchStartDollyPan(e){this.enableZoom&&this._handleTouchStartDolly(e),this.enablePan&&this._handleTouchStartPan(e)}_handleTouchStartDollyRotate(e){this.enableZoom&&this._handleTouchStartDolly(e),this.enableRotate&&this._handleTouchStartRotate(e)}_handleTouchMoveRotate(e){if(this._pointers.length==1)this._rotateEnd.set(e.pageX,e.pageY);else{let n=this._getSecondPointerPosition(e),s=.5*(e.pageX+n.x),r=.5*(e.pageY+n.y);this._rotateEnd.set(s,r)}this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);let t=this.domElement;this._rotateLeft(Ht*this._rotateDelta.x/t.clientHeight),this._rotateUp(Ht*this._rotateDelta.y/t.clientHeight),this._rotateStart.copy(this._rotateEnd)}_handleTouchMovePan(e){if(this._pointers.length===1)this._panEnd.set(e.pageX,e.pageY);else{let t=this._getSecondPointerPosition(e),n=.5*(e.pageX+t.x),s=.5*(e.pageY+t.y);this._panEnd.set(n,s)}this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd)}_handleTouchMoveDolly(e){let t=this._getSecondPointerPosition(e),n=e.pageX-t.x,s=e.pageY-t.y,r=Math.sqrt(n*n+s*s);this._dollyEnd.set(0,r),this._dollyDelta.set(0,Math.pow(this._dollyEnd.y/this._dollyStart.y,this.zoomSpeed)),this._dollyOut(this._dollyDelta.y),this._dollyStart.copy(this._dollyEnd);let o=(e.pageX+t.x)*.5,a=(e.pageY+t.y)*.5;this._updateZoomParameters(o,a)}_handleTouchMoveDollyPan(e){this.enableZoom&&this._handleTouchMoveDolly(e),this.enablePan&&this._handleTouchMovePan(e)}_handleTouchMoveDollyRotate(e){this.enableZoom&&this._handleTouchMoveDolly(e),this.enableRotate&&this._handleTouchMoveRotate(e)}_addPointer(e){this._pointers.push(e.pointerId)}_removePointer(e){delete this._pointerPositions[e.pointerId];for(let t=0;t<this._pointers.length;t++)if(this._pointers[t]==e.pointerId){this._pointers.splice(t,1);return}}_isTrackingPointer(e){for(let t=0;t<this._pointers.length;t++)if(this._pointers[t]==e.pointerId)return!0;return!1}_trackPointer(e){let t=this._pointerPositions[e.pointerId];t===void 0&&(t=new ce,this._pointerPositions[e.pointerId]=t),t.set(e.pageX,e.pageY)}_getSecondPointerPosition(e){let t=e.pointerId===this._pointers[0]?this._pointers[1]:this._pointers[0];return this._pointerPositions[t]}_customWheelEvent(e){let t=e.deltaMode,n={clientX:e.clientX,clientY:e.clientY,deltaY:e.deltaY};switch(t){case 1:n.deltaY*=16;break;case 2:n.deltaY*=100;break}return e.ctrlKey&&!this._controlActive&&(n.deltaY*=10),n}}});var zs,Hh=He(()=>{zs=class{deps;mode;basePixelRatio=1;appliedRatio=1;factor=1;interacting=!1;settleTimer=null;frameHandle=null;lastTick=null;renderedSinceTick=!1;emptyFrames=0;samplerGen=0;slowStreak=0;fastStreak=0;constructor(e,t="off"){this.deps=e,this.mode=t,this.appliedRatio=e.getPixelRatio?.()??1}setMode(e){this.mode=e,e==="off"&&(this.clearTimer(),this.interacting&&this.restore())}onFrame(){if(this.mode!=="auto"){this.deps.render();return}this.interacting||(this.interacting=!0,this.basePixelRatio=this.deps.getPixelRatio?.()??1,this.appliedRatio=this.basePixelRatio,this.factor=.6,this.slowStreak=0,this.fastStreak=0),this.clearTimer(),this.applyRatio(this.basePixelRatio*this.factor),this.deps.render(),this.renderedSinceTick=!0,this.startSampling()}settle(){this.mode!=="auto"||!this.interacting||(this.clearTimer(),this.settleTimer=setTimeout(()=>{this.settleTimer=null,this.restore()},150))}rebase(e){this.basePixelRatio=e,this.applyRatio(this.interacting?e*this.factor:e)}get currentRatio(){return this.appliedRatio}get reduction(){return this.interacting?this.appliedRatio/this.basePixelRatio:1}dispose(){this.clearTimer(),this.stopSampling()}restore(){this.stopSampling(),this.interacting=!1,this.factor=1,this.applyRatio(this.basePixelRatio),this.deps.render()}applyRatio(e){e!==this.appliedRatio&&(this.appliedRatio=e,this.deps.setPixelRatio(e))}requestFrame(e){return this.deps.requestFrame?this.deps.requestFrame(e):typeof globalThis.requestAnimationFrame=="function"?globalThis.requestAnimationFrame(e):null}startSampling(){this.frameHandle===null&&(this.lastTick=null,this.schedule(++this.samplerGen))}schedule(e){this.frameHandle=this.requestFrame(t=>this.tick(t,e))}stopSampling(){this.samplerGen++,this.frameHandle!==null&&(this.deps.requestFrame?this.deps.cancelFrame?.(this.frameHandle):typeof globalThis.cancelAnimationFrame=="function"&&globalThis.cancelAnimationFrame(this.frameHandle),this.frameHandle=null),this.lastTick=null}tick(e,t){if(t===this.samplerGen){if(this.frameHandle=null,!this.renderedSinceTick){if(++this.emptyFrames>=6){this.lastTick=null,this.slowStreak=0,this.fastStreak=0;return}this.lastTick=e,this.schedule(t);return}this.emptyFrames=0,this.renderedSinceTick=!1,this.lastTick!==null&&this.sample(e-this.lastTick),this.lastTick=e,this.schedule(t)}}sample(e){e>22?(this.fastStreak=0,++this.slowStreak>=3&&(this.slowStreak=0,this.factor=Math.max(.4,this.factor-.15))):e<18?(this.slowStreak=0,++this.fastStreak>=3&&(this.fastStreak=0,this.factor=Math.min(1,this.factor+.15))):(this.slowStreak=0,this.fastStreak=0)}clearTimer(){this.settleTimer!==null&&(clearTimeout(this.settleTimer),this.settleTimer=null)}}});function Lv(i){return typeof i.addEventListener=="function"&&"style"in i}var Pv,Wh,Vs,Xh=He(()=>{ci();up();Tl();Wl();Hh();_n();Pv={top:[0,1,0],bottom:[0,-1,0],front:[0,0,1],back:[0,0,-1],left:[-1,0,0],right:[1,0,0],iso:[1,1,1]},Wh=class{env;notify;query=null;onChange=()=>{this.arm(),this.notify(this.read())};constructor(e,t){this.env=e,this.notify=t,this.arm()}read(){let e=this.env?.devicePixelRatio;return typeof e=="number"&&e>0?Math.min(e,El):1}arm(){this.disarm();let e=this.env?.devicePixelRatio;typeof this.env?.matchMedia!="function"||typeof e!="number"||!(e>0)||(this.query=this.env.matchMedia(`(resolution: ${e}dppx)`),this.query.addEventListener("change",this.onChange))}disarm(){this.query?.removeEventListener("change",this.onChange),this.query=null}dispose(){this.disarm()}};Vs=class{gl;perspectiveCamera;orthographicCamera;activeCameraRef;cameraModeState;aspect=1;viewHalfHeight=100;framedTarget=new D;controls=null;scene;canvas;interactionQuality;onCameraChanged;onContextLostCb;onContextRestoredCb;contextLost=!1;disposedFlag=!1;programmaticMove=!1;pendingLensScale=1;hostRatio=null;displayEnv;dprWatcher=null;onContextLost=e=>{e.preventDefault(),this.contextLost=!0,this.onContextLostCb?.()};onContextRestored=()=>{this.contextLost=!1,this.onContextRestoredCb?.()};constructor(e){e.pixelRatio!==void 0&&An(e.pixelRatio),e.cameraMode!==void 0&&Tn(e.cameraMode),this.displayEnv=e.displayEnv??globalThis,this.canvas=e.canvas,this.scene=e.scene,this.onCameraChanged=e.onCameraChanged,this.onContextLostCb=e.onContextLost,this.onContextRestoredCb=e.onContextRestored,this.gl=(e.createRenderer??(n=>Sl(n,{preserveDrawingBuffer:e.preserveDrawingBuffer})))(e.canvas),this.interactionQuality=new zs({setPixelRatio:n=>this.gl.setPixelRatio?.(n),getPixelRatio:()=>this.hostRatio??this.gl.getPixelRatio?.()??1,render:()=>this.render()},e.interactionQuality??"off"),this.perspectiveCamera=new Ct(50,1,.1,1e4),this.perspectiveCamera.position.set(-100,200,250),this.orthographicCamera=new Ui(-1,1,1,-1,.1,1e4),this.orthographicCamera.position.set(-100,200,250),this.cameraModeState=e.cameraMode??"perspective",this.activeCameraRef=this.cameraModeState==="orthographic"?this.orthographicCamera:this.perspectiveCamera,e.pixelRatio!==void 0&&this.applyPixelRatioOption(e.pixelRatio);let t=this.gl.domElement;if(Lv(t))try{let n=e.createControls??((o,a)=>new Il(o,a));this.controls=n(this.activeCameraRef,t),this.controls.zoomToCursor=!0,this.controls.listenToKeyEvents(t);let s=e.onInteractionStart,r=!1;this.controls.addEventListener("start",()=>{r=!0}),this.controls.addEventListener("change",()=>{this.programmaticMove||(s?.(),this.onInteractionFrame(),r||this.settleInteraction())}),this.controls.addEventListener("end",()=>{r=!1,this.settleInteraction(),this.onCameraChanged?.(this.getCameraState())})}catch{this.controls=null}this.canvas.addEventListener?.("webglcontextlost",this.onContextLost),this.canvas.addEventListener?.("webglcontextrestored",this.onContextRestored)}get activeCamera(){return this.activeCameraRef}get cameraMode(){return this.cameraModeState}get disposed(){return this.disposedFlag}updateCameraProjection(){this.perspectiveCamera.aspect=this.aspect,this.perspectiveCamera.updateProjectionMatrix();let e=this.viewHalfHeight,t=e*this.aspect;this.orthographicCamera.left=-t,this.orthographicCamera.right=t,this.orthographicCamera.top=e,this.orthographicCamera.bottom=-e,this.orthographicCamera.updateProjectionMatrix()}setCameraMode(e){if(Tn(e),this.disposedFlag||e===this.cameraModeState)return;let t=this.activeCameraRef,n=e==="orthographic"?this.orthographicCamera:this.perspectiveCamera;if(n.position.copy(t.position),n.quaternion.copy(t.quaternion),n.up.copy(t.up),this.cameraModeState=e,this.activeCameraRef=n,this.updateCameraProjection(),this.controls&&(this.controls.object=n,this.updateControls()),e==="perspective"&&this.pendingLensScale!==1){let s=this.pendingLensScale;this.pendingLensScale=1,this.applyLensDolly(s)}this.render()}updateControls(){if(this.controls){this.programmaticMove=!0;try{this.controls.update()}finally{this.programmaticMove=!1}}}currentTarget(){return this.controls?this.controls.target.clone():this.framedTarget.clone()}upForViewDir(e){return Math.abs(e.y)>.999?new D(0,0,-1):new D(0,1,0)}setView(e){if(this.disposedFlag)return;let t=new D(...Pv[e]).normalize(),n=this.currentTarget(),s=this.activeCameraRef.position.distanceTo(n)||this.viewHalfHeight*2.15;this.activeCameraRef.up.copy(this.upForViewDir(t)),this.activeCameraRef.position.copy(n).addScaledVector(t,s),this.activeCameraRef.lookAt(n),this.framedTarget.copy(n),this.updateCameraProjection(),this.controls&&(this.controls.target.copy(n),this.updateControls()),this.render()}getCameraState(){let e=this.currentTarget(),t=this.activeCameraRef.position;return{position:{x:t.x,y:t.y,z:t.z},target:{x:e.x,y:e.y,z:e.z},zoom:this.activeCameraRef.zoom,cameraMode:this.cameraModeState}}get fov(){return this.perspectiveCamera.fov}setFov(e){if(kt(e),this.disposedFlag||e===this.perspectiveCamera.fov)return;let t=qi(e)/qi(this.perspectiveCamera.fov);if(this.perspectiveCamera.fov=e,this.perspectiveCamera.updateProjectionMatrix(),this.cameraModeState!=="perspective"){this.pendingLensScale*=t;return}this.applyLensDolly(t),this.render()}applyLensDolly(e){let t=this.currentTarget(),n=this.perspectiveCamera.position.clone().sub(t);this.perspectiveCamera.position.copy(t).add(n.multiplyScalar(e)),this.perspectiveCamera.lookAt(t),this.controls&&(this.controls.minDistance!==void 0&&(this.controls.minDistance*=e),this.controls.maxDistance!==void 0&&(this.controls.maxDistance*=e),this.updateControls())}setCameraState(e){if(Zi(e),this.disposedFlag)return;this.setCameraMode(e.cameraMode);let t=this.activeCameraRef,n=new D(e.target.x,e.target.y,e.target.z),s=new D(e.position.x,e.position.y,e.position.z).sub(n).normalize();t.up.copy(this.upForViewDir(s)),t.position.set(e.position.x,e.position.y,e.position.z),t.zoom=e.zoom,t.lookAt(n),t.updateProjectionMatrix(),this.framedTarget.copy(n),this.controls&&(this.controls.target.copy(n),this.updateControls()),this.render()}frameTo(e,t){if(this.disposedFlag)return;let{target:n,position:s,viewHalfHeight:r}=wl(e,t,this.perspectiveCamera.fov);if(this.pendingLensScale=1,this.viewHalfHeight=r,this.framedTarget.copy(n),this.activeCameraRef.position.copy(s),this.activeCameraRef.lookAt(n),this.updateCameraProjection(),this.controls){this.controls.target.copy(n);let o=qi(this.perspectiveCamera.fov);this.controls.minDistance=Math.max(1,t*.15)*o,this.controls.maxDistance=t*30*o,this.updateControls()}this.render()}fitBox(e,t,n={}){if(this.disposedFlag)return;let s=Math.max(1,n.margin??1.1),r=new D().addVectors(e,t).multiplyScalar(.5),o=Math.max(.001,r.distanceTo(t)),a=(n.direction?.clone()??new D(-1.2,1.6,1.8)).normalize();(!Number.isFinite(a.x)||a.lengthSq()===0)&&a.set(-1.2,1.6,1.8).normalize();let l=this.upForViewDir(a),c=new D().crossVectors(l,a).normalize(),h=new D().crossVectors(a,c);if(!(this.aspect>0)||!Number.isFinite(this.aspect))return;let u=Math.tan(this.perspectiveCamera.fov/2*Math.PI/180)/s,p=u*this.aspect,d=[],g=0,_=0,m=new D;for(let P=0;P<8;P++){m.set(P&1?t.x:e.x,P&2?t.y:e.y,P&4?t.z:e.z).sub(r);let S=[m.dot(c),m.dot(h),m.dot(a)];d.push(S),g=Math.max(g,Math.abs(S[0])),_=Math.max(_,Math.abs(S[1]))}let f=0,w=0,M,v=()=>{let P=o*.5;for(let[S,x,T]of d)P=Math.max(P,T+Math.abs(S-f)/p,T+Math.abs(x-w)/u);return P},A=this.activeCameraRef===this.perspectiveCamera;M=v();for(let P=0;A&&P<6;P++){let S=1/0,x=-1/0,T=1/0,z=-1/0;for(let[O,X,K]of d){let k=Math.max(1e-6,M-K),te=(O-f)/k,W=(X-w)/k;S=Math.min(S,te),x=Math.max(x,te),T=Math.min(T,W),z=Math.max(z,W)}f+=(S+x)/2*M,w+=(T+z)/2*M,M=v()}r.addScaledVector(c,f).addScaledVector(h,w);let I=Math.max(1e4,(M+o*2)*1.05);this.perspectiveCamera.far=I,this.orthographicCamera.far=I,this.viewHalfHeight=Math.max(.001,Math.max(_,g/Math.max(1e-6,this.aspect))*s),this.pendingLensScale=1,this.framedTarget.copy(r);let C=this.activeCameraRef;C.up.copy(l),C.zoom=1,C.position.copy(r).addScaledVector(a,M),C.lookAt(r),this.updateCameraProjection(),this.controls&&(this.controls.target.copy(r),this.controls.minDistance=Math.max(1,o*.15),this.controls.maxDistance=Math.max(M*4,o*30),this.updateControls()),this.render()}viewDirection(){return this.activeCameraRef.position.clone().sub(this.currentTarget()).normalize()}setInteractionQuality(e){this.disposedFlag||this.interactionQuality.setMode(e)}setPixelRatio(e){An(e),!this.disposedFlag&&this.applyPixelRatioOption(e)}applyPixelRatioOption(e){this.dprWatcher?.dispose(),this.dprWatcher=null,e==="device"?(this.dprWatcher=new Wh(this.displayEnv,t=>this.rebaseRatio(t)),this.rebaseRatio(this.dprWatcher.read())):this.rebaseRatio(e)}rebaseRatio(e){if(this.disposedFlag)return;let t=this.interactionQuality.currentRatio;this.hostRatio=e,this.interactionQuality.rebase(e),this.interactionQuality.currentRatio!==t&&this.render()}onInteractionFrame(){this.disposedFlag||this.interactionQuality.onFrame()}settleInteraction(){this.disposedFlag||this.interactionQuality.settle()}resize(e,t){this.disposedFlag||(e>0&&t>0&&(this.aspect=e/t),this.updateCameraProjection(),this.gl.setSize(e,t,!1),this.render())}render(){this.disposedFlag||this.contextLost||this.gl.render(this.scene,this.activeCameraRef)}async capture(e={},t){if(vu(e),this.disposedFlag||this.contextLost||!ep(this.gl)){let g=this.disposedFlag?"stage disposed":this.contextLost?"WebGL context lost":"renderer cannot render-to-target";throw new hn(`capture unavailable: ${g}`)}let n=this.gl,s=this.interactionQuality,r=this.hostRatio===null?s.reduction:s.currentRatio,{w:o,h:a}=bu(e,this.canvas.width/r,this.canvas.height/r);Mu(o,a);let l=new rn(o,a);l.texture.colorSpace=xt;let c=this.aspect,h=this.scene.background,u=e.background!==void 0,p,d;try{d=t?.(),u&&(this.scene.background=e.background==="transparent"?null:new Ne(e.background)),this.aspect=o/a,this.updateCameraProjection(),n.setRenderTarget(l),n.render(this.scene,this.activeCameraRef);let g=new Uint8Array(o*a*4);n.readRenderTargetPixels(l,0,0,o,a,g),p=Su(g,o,a)}finally{n.setRenderTarget(null),l.dispose(),d?.(),u&&(this.scene.background=h),this.aspect=c,this.updateCameraProjection(),this.render()}return wu(p,o,a,e.format??"image/png",e.quality)}dispose(){this.disposedFlag||(this.disposedFlag=!0,this.dprWatcher?.dispose(),this.dprWatcher=null,this.interactionQuality.dispose(),this.canvas.removeEventListener?.("webglcontextlost",this.onContextLost),this.canvas.removeEventListener?.("webglcontextrestored",this.onContextRestored),this.controls?.dispose(),this.gl.dispose())}}});function qh(i,e){return i!=="auto"?i:e<=_o?"tubes":"lines"}function an(i){return Number.isFinite(i.min.x+i.min.y+i.min.z+i.max.x+i.max.y+i.max.z)}function Nv(i){return i.min.x===1/0&&i.min.y===1/0&&i.min.z===1/0&&i.max.x===-1/0&&i.max.y===-1/0&&i.max.z===-1/0}function Yh(i){let e=i.bed,t=i.excludedRegions;if(e.kind==="rect")return{x:e.max.x-e.min.x,y:e.max.y-e.min.y,z:i.heightMm??250,min:{...e.min},excludedRegions:t};if(e.kind==="circular"){let a=e.diameter/2;return{x:e.diameter,y:e.diameter,z:i.heightMm??250,min:{x:e.center.x-a,y:e.center.y-a},excludedRegions:t,shape:{kind:"circular",center:{...e.center},diameter:e.diameter}}}let n=1/0,s=1/0,r=-1/0,o=-1/0;for(let a of e.points)n=Math.min(n,a.x),s=Math.min(s,a.y),r=Math.max(r,a.x),o=Math.max(o,a.y);return{x:r-n,y:o-s,z:i.heightMm??250,min:{x:n,y:s},excludedRegions:t,shape:{kind:"polygon",points:e.points.map(a=>({x:a.x,y:a.y}))}}}function $h(i,e){let t=i.userData.chunk;if(t===void 0)return null;let n=i.userData.vertexSegment,s=n!==void 0?n[e]:Math.floor(e/2);return s===void 0||s<0||s>=t.count?null:t.segIndices[s]}var Dv,Uv,Fv,Ov,Pl,dp=He(()=>{ci();mi();ec();xi();tc();nc();Ph();Lh();Dh();Uh();vo();Tl();Bh();kh();ap();ho();Xh();_n();Dv=.35;Uv={mode:"single",color:[.9,.4,.7]};Fv=8,Ov=2048;Pl=class{scheduleFrame;chunksPerTick;renderDuringBuild;stage;scene=new Er;root=new nn;toolpathGroup=new nn;volumeGroup=null;cageVisible=!0;frameContentMode="all";volumeDef=null;backdrop=null;hemiLight;dirLight;resolvedTheme;ir=null;irHasExtrude=!1;raycaster=new Xr;pointer=new ce;buildResult=null;pendingChunks=[];builtCount=0;colorMode;requestedQuality;active="lines";qualityMode;progressivePreview;tubeOptions;tubeByteBudget;tubeRadialSegments=8;previewSegments=0;previewBounds=null;startLayer=0;endLayer=1/0;scrubSegIndex=null;kindVisible={extrude:!0,travel:!0,wipe:!0,cut:!0};hiddenFeatureRoles=new Set;progress=null;presentationMode="hidden";markerMesh=null;ghostMaterial=new Gt({color:9082016,transparent:!0,opacity:.22,depthWrite:!1});bandMaterial=new Gt({color:16752640,transparent:!0,opacity:.9});staleBandMaterial=new Gt({color:10395294,transparent:!0,opacity:.5});markerMaterial=new Vt({color:16739584,transparent:!0,depthTest:!1});staleMarkerMaterial=new Vt({color:10395294,transparent:!0,opacity:.7,depthTest:!1});showRetractions=!1;retractionPoints=null;retractionSegIndices=new Uint32Array(0);retractionMaterial=new ws({size:6,sizeAttenuation:!1,vertexColors:!0,transparent:!0,depthTest:!1});listeners=new Set;disposed=!1;gpuInfo=null;lastRenderStats=null;buildStartMs=null;firstRenderMs=null;buildDisclosures=[];constrainingTubeBudget=null;geometryConcurrency;geometryMemoryBudgetBytes;coreBudget;createGeometryWorker;geometryPool=null;buildParallelism="main";poolWorkerCount=0;buildGeneration=0;constructor(e){e.cameraFov!==void 0&&kt(e.cameraFov),yo(e.tube),zu(e),e.progressivePreview!==void 0&&Xn(e.progressivePreview),e.colorMode!==void 0&&Qt(e.colorMode),this.chunksPerTick=e.chunksPerTick,this.renderDuringBuild=e.renderDuringBuild??!0,this.colorMode=e.colorMode??Uv,this.requestedQuality=e.quality??"auto",this.frameContentMode=e.frameContent??"all",this.tubeOptions=e.tube??{},this.tubeByteBudget=e.tubeByteBudget??Qi,this.geometryConcurrency=e.geometryConcurrency??"auto",this.geometryMemoryBudgetBytes=e.geometryMemoryBudgetBytes??Math.floor((e.tubeByteBudget??Qi)/2),this.coreBudget=e.coreBudget,this.createGeometryWorker=e.createGeometryWorker,this.qualityMode=e.qualityMode??"adaptive",this.progressivePreview=e.progressivePreview??"lines",this.scheduleFrame=e.scheduleFrame??(n=>{let s=!1,r=()=>{s||(s=!0,n())};typeof requestAnimationFrame=="function"&&requestAnimationFrame(r),setTimeout(r,50)}),this.root.rotation.x=-Math.PI/2,this.scene.add(this.root),this.root.add(this.toolpathGroup),this.resolvedTheme=Js(e.theme);let t=this.resolvedTheme;this.hemiLight=new Hr(t.hemisphereSky,t.hemisphereGround,t.hemisphereIntensity),this.scene.add(this.hemiLight),this.dirLight=new Wr(t.directionalColor,t.directionalIntensity),this.dirLight.position.set(1,2,1.5),this.scene.add(this.dirLight),this.applyBackground(),e.buildVolume&&(this.volumeDef=e.buildVolume,this.volumeGroup=Bs(e.buildVolume,this.volumeStyle()),this.root.add(this.volumeGroup)),this.stage=new Vs({canvas:e.canvas,scene:this.scene,cameraMode:e.cameraMode,interactionQuality:e.interactionQuality,...e.pixelRatio!==void 0?{pixelRatio:e.pixelRatio}:{},preserveDrawingBuffer:e.preserveDrawingBuffer,createRenderer:e.createRenderer,onCameraChanged:n=>this.emit({type:"camera-changed",state:n}),onContextLost:()=>this.emit({type:"contextlost"}),onContextRestored:()=>{this.ir!==null&&this.startBuild(this.ir),this.emit({type:"restored"})}}),e.cameraFov!==void 0&&this.stage.setFov(e.cameraFov),this.frame()}get camera(){return this.stage.activeCamera}get cameraMode(){return this.stage.cameraMode}onEvent(e){return this.listeners.add(e),()=>this.listeners.delete(e)}emit(e){for(let t of this.listeners)t(e)}appendPartial(e){if(this.disposed||e.segments.count===0||this.effectivePreview()==="off")return;this.ir!==null&&(this.ir=null,this.buildResult=null,this.clearToolpathGeometry(),this.refreshContactShadow());let t=this.previewSegments===0;this.previewSegments+=e.segments.count;let n=ir(this.previewSegments);if(this.effectivePreview()==="lines"){let r;try{r=vi(e,{decimation:n})}catch(a){this.emit({type:"error",code:"E_PREVIEW_BUILD",message:a instanceof Error?a.message:String(a)});return}for(let a of r.chunks){let l=new lt;l.setAttribute("position",new Ke(a.positions,3)),l.setAttribute("color",new Ke(Mi(e,a,this.colorMode),3));let c=new Fn(l,new Gt({vertexColors:!0}));c.name=`preview:${a.kind}`,c.userData.chunk=a,c.userData.preview=!0,c.visible=this.kindVisible[a.kind],this.toolpathGroup.add(c)}let o=e.header.originOffset;this.toolpathGroup.position.set(o.x,o.y,o.z)}let s=e.boundsWithTravel;an(s)&&(this.previewBounds===null?this.previewBounds={min:new D(s.min.x,s.min.y,s.min.z),max:new D(s.max.x,s.max.y,s.max.z)}:(this.previewBounds.min.min(new D(s.min.x,s.min.y,s.min.z)),this.previewBounds.max.max(new D(s.max.x,s.max.y,s.max.z)))),this.emit({type:"previewAppend",cumulativeSegments:this.previewSegments,decimationApplied:n}),this.effectivePreview()==="lines"&&(t?this.frame():this.render())}setIR(e){this.disposed||(this.ir=e,this.irHasExtrude=e.segments.kind.some(t=>(t&ut.Extrude)!==0),this.startLayer=0,this.endLayer=1/0,this.scrubSegIndex=null,this.progress=null,this.presentationMode!=="hidden"&&(this.presentationMode="hidden",this.emit({type:"progress-presentation-changed",mode:"hidden",reason:"new-ir"})),this.buildRetractionMarkers(),this.updateRetractionMarkers(),this.startBuild(e),this.positionToolpath(e),this.refreshContactShadow(),this.frame())}positionToolpath(e){let t=e.header.originOffset;this.toolpathGroup.position.set(t.x,t.y,t.z)}startBuild(e){this.clearToolpathGeometry(),this.buildGeneration++,this.buildStartMs=performance.now(),this.firstRenderMs=null,this.buildDisclosures=[],this.constrainingTubeBudget=null;let t=this.qualityMode==="full"?1:"auto";try{this.buildResult=vi(e,{decimation:t})}catch(n){this.emit({type:"error",code:"E_GEOMETRY_BUILD",message:n instanceof Error?n.message:String(n)});return}if(this.active=this.qualityMode==="fast"?"lines":qh(this.requestedQuality,this.buildResult.totalSegmentsIncluded),this.active==="tubes"){try{this.buildResult=vi(e,{decimation:1,targetSegmentsPerChunk:Ov})}catch(a){this.emit({type:"error",code:"E_GEOMETRY_BUILD",message:a instanceof Error?a.message:String(a)});return}let n=this.buildResult.chunks.reduce((a,l)=>l.kind==="extrude"?a+l.count:a,0),s=this.tubeOptions.radialSegments??8,r=this.qualityMode==="full"?Number.POSITIVE_INFINITY:this.tubeByteBudget,o=xo(n,s,r);if(o===null){this.fallbackToLines(`tube memory budget: ${n.toLocaleString()} extrusion segments exceed the budget even at minimum cross-section`);return}Number.isFinite(r)&&o<s&&(this.constrainingTubeBudget=r),this.tubeRadialSegments=o}if(this.buildParallelism="main",this.poolWorkerCount=0,this.active==="tubes"){let n=this.buildResult.chunks.filter(r=>r.kind==="extrude"),s=this.poolSizeFor(n);if(s>=1){this.buildParallelism="pool",this.poolWorkerCount=s,this.buildTubesViaPool(s).catch(r=>{this.disposed||this.fallbackToSerialTubes(r instanceof Error?r.message:String(r))});return}}this.pendingChunks=[...this.buildResult.chunks],this.builtCount=0,this.scheduleFrame(()=>this.buildTick())}poolSizeFor(e){if(this.geometryConcurrency==="off"||this.createGeometryWorker===void 0)return 0;let t=e.length;if(t===0)return 0;let n=e.reduce((h,u)=>h+u.count,0);if(this.geometryConcurrency==="auto"&&zh(n,this.tubeRadialSegments,this.ensureGpuInfo().capability)<rp)return 0;let s=this.coreBudget??(typeof navigator<"u"?navigator.hardwareConcurrency:void 0),r=typeof this.geometryConcurrency=="number"?Math.max(1,Math.floor(this.geometryConcurrency)):Cl(s),o=rr(this.tubeRadialSegments),a=e.reduce((h,u)=>Math.max(h,o*u.count),1),l=Math.max(1,Math.floor(this.geometryMemoryBudgetBytes/a)),c=Math.max(1,Math.min(r,l,t));return this.geometryConcurrency==="auto"&&c<2?0:c}ensurePool(e){return this.geometryPool!==null&&this.geometryPool.size===e?this.geometryPool:(this.geometryPool?.dispose(),this.geometryPool=new ks(e,this.createGeometryWorker),this.geometryPool)}async buildTubesViaPool(e){let t=this.buildGeneration,n=this.buildResult;if(this.ir===null||n===null)return;let s=0;for(let c of n.chunks){if(c.kind==="extrude")continue;let h=this.makeChunkMesh(c);h.name=`chunk:${c.kind}:${c.layerStart}-${c.layerEnd}`,h.userData.chunk=c,this.applyDrawStateToMesh(h,c),this.applyFeatureVisibilityToMesh(h,c),this.toolpathGroup.add(h),s++}let r=n.chunks.filter(c=>c.kind==="extrude"),o=r.map((c,h)=>({id:h,positions:c.positions.buffer.slice(0),count:c.count,radialSegments:this.tubeRadialSegments,lineWidth:this.tubeOptions.lineWidth,lineHeight:this.tubeOptions.lineHeight})),a;try{a=this.ensurePool(e)}catch(c){if(this.disposed||t!==this.buildGeneration)return;this.fallbackToSerialTubes(c instanceof Error?c.message:String(c));return}let l=n.chunks.length;this.builtCount=s;try{await a.buildStreaming(o,(c,h)=>{this.disposed||t!==this.buildGeneration||(this.toolpathGroup.add(this.makeTubeMeshFromResponse(r[c],h)),this.builtCount++,this.emit({type:"buildProgress",chunksBuilt:this.builtCount,chunksTotal:l}),this.emit({type:"stage",stage:"building-geometry",progress:l>0?this.builtCount/l:1,detail:{built:this.builtCount,total:l}}),this.renderDuringBuild&&this.effectivePreview()!=="hold"&&this.render())})}catch(c){if(this.disposed||t!==this.buildGeneration)return;this.fallbackToSerialTubes(c instanceof Error?c.message:String(c));return}this.disposed||t!==this.buildGeneration||(this.emit({type:"stage",stage:"preparing-gpu"}),this.emit({type:"buildComplete",segments:n.totalSegmentsIncluded,decimationApplied:n.decimationApplied,travelHidden:n.travelHidden,quality:this.active,skippedNonFinite:n.skippedNonFinite}),this.lastRenderStats=this.assembleRenderStats(),this.emit({type:"renderStats",stats:this.lastRenderStats}),this.renderDuringBuild&&this.effectivePreview()==="hold"&&this.render(),this.emit({type:"stage",stage:"ready"}))}makeTubeMeshFromResponse(e,t){let n=new Uint32Array(t.vertexSegment),s=new lt;s.setAttribute("position",new Ke(new Float32Array(t.positions),3)),s.setAttribute("normal",new Ke(new Float32Array(t.normals),3)),s.setAttribute("color",new Ke(this.tubeVertexColors(e,n),3)),s.setIndex(new Ke(new Uint32Array(t.indices),1));let r=new gt(s,this.makeExtrudeMaterial());return r.name=`chunk:${e.kind}:${e.layerStart}-${e.layerEnd}`,r.userData.chunk=e,r.userData.drawUnitsPerSegment=t.indicesPerSegment,r.userData.vertexSegment=n,this.applyDrawStateToMesh(r,e),this.applyFeatureVisibilityToMesh(r,e),r}fallbackToSerialTubes(e){this.buildDisclosures.push(`pool\u2192serial-tubes: ${e}`),this.buildParallelism="main",this.poolWorkerCount=0,this.geometryPool?.dispose(),this.geometryPool=null,this.clearToolpathGeometry(),this.buildResult!==null&&(this.builtCount=0,this.pendingChunks=[...this.buildResult.chunks],this.scheduleFrame(()=>this.buildTick()))}fallbackToLines(e){if(this.buildDisclosures.push(`tubes\u2192lines: ${e}`),/budget/i.test(e)&&Number.isFinite(this.tubeByteBudget)&&(this.constrainingTubeBudget=this.tubeByteBudget),this.emit({type:"qualityFallback",from:"tubes",to:"lines",reason:e}),this.active="lines",this.buildParallelism="main",this.poolWorkerCount=0,this.clearToolpathGeometry(),this.ir!==null)try{this.buildResult=vi(this.ir,{decimation:1})}catch{this.buildResult=null}this.buildResult!==null&&(this.pendingChunks=[...this.buildResult.chunks],this.scheduleFrame(()=>this.buildTick()))}tubeVertexColors(e,t){if(this.ir===null)return new Float32Array(t.length*3);let n=Mi(this.ir,e,this.colorMode),s=new Float32Array(t.length*3);for(let r=0;r<t.length;r++){let o=t[r]*6;s[r*3]=n[o],s[r*3+1]=n[o+1],s[r*3+2]=n[o+2]}return s}makeChunkMesh(e){if(this.active==="tubes"&&e.kind==="extrude"){let s=es(e,{...this.tubeOptions,radialSegments:this.tubeRadialSegments}),r=new lt;r.setAttribute("position",new Ke(s.positions,3)),r.setAttribute("normal",new Ke(s.normals,3)),r.setAttribute("color",new Ke(this.tubeVertexColors(e,s.vertexSegment),3)),r.setIndex(new Ke(s.indices,1));let o=new gt(r,this.makeExtrudeMaterial());return o.userData.drawUnitsPerSegment=s.indicesPerSegment,o.userData.vertexSegment=s.vertexSegment,o}let t=new lt;t.setAttribute("position",new Ke(e.positions,3)),t.setAttribute("color",new Ke(Mi(this.ir,e,this.colorMode),3));let n=new Fn(t,new Gt({vertexColors:!0}));return n.userData.drawUnitsPerSegment=2,n}buildTick(){if(this.disposed||this.ir===null||this.buildResult===null)return;let e=performance.now(),t=0;for(;this.pendingChunks.length>0;){if(this.chunksPerTick!==void 0){if(t>=this.chunksPerTick)break}else if(t>0&&performance.now()-e>=Fv)break;let s=this.pendingChunks.shift(),r;try{r=this.makeChunkMesh(s)}catch(o){this.active==="tubes"?this.fallbackToLines(o instanceof Error?o.message:String(o)):this.emit({type:"error",code:"E_GEOMETRY_BUILD",message:o instanceof Error?o.message:String(o)});return}r.name=`chunk:${s.kind}:${s.layerStart}-${s.layerEnd}`,r.userData.chunk=s,this.applyDrawStateToMesh(r,s),this.applyFeatureVisibilityToMesh(r,s),this.toolpathGroup.add(r),this.builtCount++,t++}let n=this.buildResult.chunks.length;this.emit({type:"buildProgress",chunksBuilt:this.builtCount,chunksTotal:n}),this.emit({type:"stage",stage:"building-geometry",progress:n>0?this.builtCount/n:1,detail:{built:this.builtCount,total:n}}),this.renderDuringBuild&&this.effectivePreview()!=="hold"&&this.render(),this.pendingChunks.length>0?this.scheduleFrame(()=>this.buildTick()):(this.emit({type:"stage",stage:"preparing-gpu"}),this.emit({type:"buildComplete",segments:this.buildResult.totalSegmentsIncluded,decimationApplied:this.buildResult.decimationApplied,travelHidden:this.buildResult.travelHidden,quality:this.active,skippedNonFinite:this.buildResult.skippedNonFinite}),this.lastRenderStats=this.assembleRenderStats(),this.emit({type:"renderStats",stats:this.lastRenderStats}),this.renderDuringBuild&&this.effectivePreview()==="hold"&&this.render(),this.emit({type:"stage",stage:"ready"}))}flushBuild(){for(;this.pendingChunks.length>0&&!this.disposed;)this.buildTick()}get layerCount(){return this.ir?.layers.length??0}get segmentCount(){return this.ir?.segments.count??0}pickSegment(e,t,n){if(this.chunkMeshes.length===0)return null;this.pointer.set(e,t),this.raycaster.setFromCamera(this.pointer,this.stage.activeCamera),this.raycaster.params.Line.threshold=n??this.pickThreshold();for(let s of this.raycaster.intersectObjects(this.chunkMeshes,!1)){if(s.index===void 0)continue;let r=$h(s.object,s.index);if(r!==null)return r}return null}pickThreshold(){let e=this.ir?.bounds;return e===void 0||!an(e)?.5:Math.max(.2,.005*Math.hypot(e.max.x-e.min.x,e.max.y-e.min.y,e.max.z-e.min.z))}setLayerRange(e,t){this.disposed||(this.startLayer=Math.max(0,Math.floor(e)),this.endLayer=Math.floor(t),this.applyDrawState(),this.render())}setScrubPosition(e){this.disposed||(this.scrubSegIndex=e===null?null:Math.max(-1,Math.floor(e)),this.applyDrawState(),this.render())}setShowRetractions(e){this.disposed||(this.showRetractions=e,this.updateRetractionMarkers(),this.render())}get hasRetractions(){return this.ir?.header.capabilities.retractions==="known"}buildRetractionMarkers(){this.retractionPoints!==null&&(this.toolpathGroup.remove(this.retractionPoints),this.retractionPoints.geometry.dispose(),this.retractionPoints=null),this.retractionSegIndices=new Uint32Array(0);let e=this.ir?.retractions??[];if(e.length===0)return;let t=new Float32Array(e.length*3),n=new Float32Array(e.length*3),s=new Uint32Array(e.length);for(let a=0;a<e.length;a++){let l=e[a];t[a*3]=l.x,t[a*3+1]=l.y,t[a*3+2]=l.z;let c=l.kind==="retract";n[a*3]=c?1:0,n[a*3+1]=c?.43:.72,n[a*3+2]=c?0:.83,s[a]=l.segIndex}let r=new lt;r.setAttribute("position",new Ke(t,3)),r.setAttribute("color",new Ke(n,3));let o=new Ar(r,this.retractionMaterial);o.renderOrder=11,o.frustumCulled=!1,this.retractionSegIndices=s,this.retractionPoints=o,this.toolpathGroup.add(o)}updateRetractionMarkers(){let e=this.retractionPoints;if(e===null)return;if(!this.showRetractions||!this.hasRetractions){e.visible=!1;return}e.visible=!0;let t=this.visibleSegWindow(),n=this.retractionSegIndices,s=0;for(;s<n.length&&n[s]<t.lo;)s++;let r=s;for(;r<n.length&&n[r]<=t.hi;)r++;e.geometry.setDrawRange(s,Math.max(0,r-s))}visibleSegWindow(){let e=this.ir;if(e===null||e.layers.length===0)return{lo:0,hi:1/0};let t=e.layers.length-1,n=Math.min(Math.max(0,this.startLayer),t),s=Math.min(Math.max(n,this.endLayer===1/0?t:this.endLayer),t),r=e.layers[n].segStart,o=e.layers[s].segEnd;return this.scrubSegIndex!==null&&(o=Math.min(o,this.scrubSegIndex)),{lo:r,hi:o}}setKindVisible(e,t){this.disposed||(this.kindVisible[e]=t,this.applyDrawState(),this.render())}setFeatureRoleVisible(e,t){this.disposed||(t?this.hiddenFeatureRoles.delete(e):this.hiddenFeatureRoles.add(e),this.applyFeatureVisibility(),this.render())}getHiddenFeatureRoles(){return[...this.hiddenFeatureRoles]}applyFeatureVisibility(){for(let e of this.chunkMeshes){let t=e.userData.chunk;t&&this.applyFeatureVisibilityToMesh(e,t)}}applyFeatureVisibilityToMesh(e,t){if(this.ir===null||t.kind!=="extrude")return;let n=e.geometry.getAttribute("position"),s=n.array,r=e.userData.baseFeaturePositions;if(this.hiddenFeatureRoles.size===0){r!==void 0&&(s.set(r),n.needsUpdate=!0,e.userData.baseFeaturePositions=void 0);return}r===void 0&&(r=s.slice(),e.userData.baseFeaturePositions=r);let o=this.ir.segments.feature,a=e.userData.vertexSegment,l=s.length/3;for(let c=0;c<l;c++){let h=a!==void 0?a[c]:c>>1,u=t.segIndices[h];this.hiddenFeatureRoles.has(o[u])?(s[c*3]=NaN,s[c*3+1]=NaN,s[c*3+2]=NaN):(s[c*3]=r[c*3],s[c*3+1]=r[c*3+1],s[c*3+2]=r[c*3+2])}n.needsUpdate=!0}isColorModeAvailable(e){if(e==="feature"){let t=this.ir?.header.capabilities.featureRoles;return t!==void 0&&t!=="unavailable"}if(e==="colorChange"){let t=this.ir?.header.capabilities.colorChanges;return t!==void 0&&t!=="unavailable"}if(e==="object"){let t=this.ir?.header.capabilities.objects;return t!==void 0&&t!=="unavailable"}if(e==="feedrate")return this.ir?.header.capabilities.feedrate!=="unavailable";if(e==="layerHeight"){let t=this.ir?.header.capabilities.layers;return t!==void 0&&t!=="unavailable"}if(e==="power"){let t=this.ir?.header.capabilities.toolPower;return t!==void 0&&t!=="unavailable"}return!0}get hasColorChanges(){return this.ir?.header.capabilities.colorChanges==="known"}applyDrawState(){for(let e of this.chunkMeshes){let t=e.userData.chunk;t&&this.applyDrawStateToMesh(e,t)}this.updateMarker(),this.updateRetractionMarkers()}overlayCuts(){if(this.presentationMode==="hidden"||this.progress===null)return null;let e=this.progress,t=e.band!==null?e.band[0]-1:e.segIndex??-1,n=e.band!==null?e.band[1]:e.segIndex??-1;return e.band!==null&&e.band[0]===e.band[1]?{lo:e.band[0],hi:e.band[1]}:{lo:t,hi:n}}applyDrawStateToMesh(e,t){if(e.userData.preview===!0){e.visible=this.kindVisible[t.kind];return}if(this.ir===null)return;if(!this.kindVisible[t.kind]){e.visible=!1,this.setOverlayMeshes(e,t,null,!1);return}let n=this.scrubSegIndex!==null,s=this.overlayCuts(),r=n?this.scrubSegIndex:s!==null?s.lo:void 0,o=bi(this.ir,t,this.startLayer,this.endLayer,r);e.visible=o.visible;let a=e.userData.drawUnitsPerSegment??2;e.geometry.setDrawRange(o.drawStart*a,o.drawCount*a),this.setOverlayMeshes(e,t,s,n)}setOverlayMeshes(e,t,n,s){let r=e.userData.overlayGhost,o=e.userData.overlayBand;if(n===null){r!==void 0&&(r.visible=!1),o!==void 0&&(o.visible=!1);return}if(r===void 0){let c=e.userData.drawUnitsPerSegment===2?e.geometry.getAttribute("position"):new Ke(t.positions,3),h=(u,p)=>{let d=new lt;d.setAttribute("position",c);let g=new Fn(d,u);return g.name=`${p}:${t.kind}:${t.layerStart}-${t.layerEnd}`,g.userData.overlayFor=e,this.toolpathGroup.add(g),g};r=h(this.ghostMaterial,"overlay-ghost"),o=h(this.bandMaterial,"overlay-band"),e.userData.overlayGhost=r,e.userData.overlayBand=o}let a=mo(this.ir,t,this.startLayer,this.endLayer,n.lo,n.hi);r.visible=!s&&a.ghost.visible,r.geometry.setDrawRange(a.ghost.drawStart*2,a.ghost.drawCount*2),o.visible=a.band.visible,o.material=this.presentationMode==="stale"?this.staleBandMaterial:this.bandMaterial,o.geometry.setDrawRange(a.band.drawStart*2,a.band.drawCount*2)}updateMarker(){let e=this.progress;if(!(this.ir!==null&&this.presentationMode!=="hidden"&&e!==null&&e.confidence==="known"&&e.segIndex!==null)){this.markerMesh!==null&&(this.markerMesh.visible=!1);return}this.markerMesh===null&&(this.markerMesh=new gt(new Br(1.5,16,12),this.markerMaterial),this.markerMesh.name="overlay-marker",this.markerMesh.userData.overlayMarker=!0,this.markerMesh.renderOrder=10,this.toolpathGroup.add(this.markerMesh));let n=this.ir,s=n.bounds;if(an(s)){let o=Math.hypot(s.max.x-s.min.x,s.max.y-s.min.y,s.max.z-s.min.z)/2;this.markerMesh.scale.setScalar(Math.max(1.5,Math.min(5,o*.035))/1.5)}let r=e.segIndex;this.markerMesh.position.set(n.segments.x1[r],n.segments.y1[r],n.segments.z1[r]),this.markerMesh.material=this.presentationMode==="stale"?this.staleMarkerMaterial:this.markerMaterial,this.markerMesh.visible=!0}setProgress(e){if(this.disposed)return;this.progress=e;let t,n;e===null||e.confidence==="unavailable"?(t="hidden",n=e?.notes[0]?.code):e.stale?(t="stale",n="observation-stale"):t=e.confidence==="known"?"exact":"band",t!==this.presentationMode&&(this.presentationMode=t,this.emit(n===void 0?{type:"progress-presentation-changed",mode:t}:{type:"progress-presentation-changed",mode:t,reason:n})),this.applyDrawState(),this.render()}get progressPresentation(){return this.presentationMode}get cameraFov(){return this.stage.fov}setCameraFov(e){this.stage.setFov(e)}setPixelRatio(e){this.stage.setPixelRatio(e)}setCameraMode(e){this.stage.setCameraMode(e)}setView(e){this.stage.setView(e)}getCameraState(){return this.stage.getCameraState()}setCameraState(e){this.stage.setCameraState(e)}async capture(e){let t=this.volumeGroup;return e?.includeBuildVolume!==!1||t===null?this.stage.capture(e):this.stage.capture(e,()=>{let n=t.visible;return t.visible=!1,()=>{t.visible=n}})}frameBounds(){let e=this.ir;if(e===null)return null;if(this.frameContentMode==="object"){if(an(e.modelBounds))return e.modelBounds;if(an(e.objectBounds))return e.objectBounds}return an(e.bounds)?e.bounds:Nv(e.bounds)&&an(e.boundsWithTravel)?e.boundsWithTravel:null}frame(){if(this.disposed)return;let e=this.frameBounds(),t=new D,n=100;if(e)t.set((e.min.x+e.max.x)/2,(e.min.y+e.max.y)/2,(e.min.z+e.max.z)/2),n=Math.max(10,t.distanceTo(new D(e.min.x,e.min.y,e.min.z)));else if(this.previewBounds!==null){let s=this.previewBounds;t.set((s.min.x+s.max.x)/2,(s.min.y+s.max.y)/2,(s.min.z+s.max.z)/2),n=Math.max(10,t.distanceTo(s.min))}else this.volumeDef&&(t.set(this.volumeDef.x/2,this.volumeDef.y/2,0),n=Math.max(10,Math.max(this.volumeDef.x,this.volumeDef.y)*.75));this.stage.frameTo(t,n)}setColorMode(e){if(Qt(e),!this.isColorModeAvailable(e.mode))return this.emit({type:"error",code:"E_COLOR_MODE_UNAVAILABLE",message:`color mode '${e.mode}' is unavailable: the IR does not carry the required capability ('unavailable' or missing)`}),!1;if(this.colorMode=e,this.ir===null)return!0;for(let t of this.chunkMeshes){let n=t.userData.chunk;if(!n)continue;let s=t.userData.vertexSegment,r=s?this.tubeVertexColors(n,s):Mi(this.ir,n,e);t.geometry.setAttribute("color",new Ke(r,3))}return this.render(),!0}makeExtrudeMaterial(){return this.resolvedTheme.materialPreset==="glossy"?new kr({vertexColors:!0,roughness:.35,metalness:.1}):new zr({vertexColors:!0})}volumeStyle(){return xl(this.resolvedTheme,this.cageVisible)}setBuildVolumeCage(e){if(this.disposed)return;this.cageVisible=e;let t=this.volumeGroup?.getObjectByName("volumeCage");t!==void 0&&(t.visible=e),this.render()}setFrameContent(e){if(!this.disposed){if(this.frameContentMode=e,e==="object"&&this.ir!==null&&!an(this.ir.modelBounds)&&!an(this.ir.objectBounds)){let t=this.ir.header.capabilities.nonModelClassification??"unavailable";this.emit({type:"error",code:"E_FRAME_CONTENT_UNAVAILABLE",message:`frameContent 'object' cannot isolate the model (nonModelClassification: ${t}); framing all productive moves (extrusion or cut)`})}this.frame()}}setInteractionQuality(e){this.stage.setInteractionQuality(e)}onInteractionFrame(){this.stage.onInteractionFrame()}settleInteraction(){this.stage.settleInteraction()}applyBackground(){let e=this.resolvedTheme.background;this.backdrop?.dispose(),this.backdrop=null,e!==null&&typeof e=="object"?(this.backdrop=Ml(e),this.scene.background=this.backdrop.texture):this.scene.background=e===null?null:new Ne(e)}shadowFootprint(){let e=this.ir;return e===null?null:an(e.modelBounds)?e.modelBounds:an(e.objectBounds)?e.objectBounds:an(e.bounds)?e.bounds:null}refreshContactShadow(){let e=this.volumeGroup;if(e===null)return;let t=e.getObjectByName("contactShadow");t!==void 0&&(Xi(t),e.remove(t));let n=this.ir!==null&&this.ir.segments.count>0&&!this.irHasExtrude;for(let o of["bedSurface","bedSurfaceEdge"]){let a=e.getObjectByName(o),l=a?.material;if(a===void 0||l===void 0)continue;let c=a.userData.plateBase??={opacity:l.opacity,transparent:l.transparent};l.opacity=n?Math.min(c.opacity,Dv):c.opacity;let h=n?!0:c.transparent;l.transparent!==h&&(l.needsUpdate=!0),l.transparent=h}let s=this.resolvedTheme.contactShadow;if(s===void 0||n)return;let r=bl(this.shadowFootprint(),s.opacity);r!==null&&e.add(r)}setTheme(e){if(this.disposed)return;let t=this.resolvedTheme.materialPreset;this.resolvedTheme=Js(e);let n=this.resolvedTheme;if(this.hemiLight.color.set(n.hemisphereSky),this.hemiLight.groundColor.set(n.hemisphereGround),this.hemiLight.intensity=n.hemisphereIntensity,this.dirLight.color.set(n.directionalColor),this.dirLight.intensity=n.directionalIntensity,this.applyBackground(),this.volumeDef!==null&&this.volumeGroup!==null&&(Xi(this.volumeGroup),this.root.remove(this.volumeGroup),this.volumeGroup=Bs(this.volumeDef,this.volumeStyle()),this.root.add(this.volumeGroup),this.refreshContactShadow()),n.materialPreset!==t)for(let s of this.chunkMeshes){if(s.userData.vertexSegment===void 0)continue;let r=s.material;s.material=this.makeExtrudeMaterial(),r?.dispose()}this.render()}resize(e,t){this.stage.resize(e,t)}render(){this.firstRenderMs===null&&this.buildStartMs!==null&&(this.firstRenderMs=performance.now()-this.buildStartMs),this.stage.render()}getRenderStats(){return this.lastRenderStats}ensureGpuInfo(){return this.gpuInfo===null&&(this.gpuInfo=Al(this.stage.gl)),this.gpuInfo}assembleRenderStats(){let e=this.gpuInfo??this.ensureGpuInfo(),t=this.buildResult,n=0,s=0,r=0;for(let a of this.toolpathGroup.children){let l=a.geometry;if(l===void 0||a.userData?.chunk===void 0)continue;r++;let c=l.attributes?.position;typeof c?.count=="number"&&(n+=c.count);for(let u of Object.keys(l.attributes??{})){let p=l.attributes?.[u]?.array?.byteLength;typeof p=="number"&&(s+=p)}let h=l.index?.array?.byteLength;typeof h=="number"&&(s+=h)}let o=this.active==="tubes";return{backend:"3d-webgl",webglVersion:e.webglVersion,capability:e.capability,gpuRenderer:e.gpuRenderer,gpuVendor:e.gpuVendor,geometryMode:this.active,sourceSegmentCount:this.ir?.segments.count??0,renderedSegmentCount:t?.totalSegmentsIncluded??0,decimationApplied:t?.decimationApplied??1,vertexCount:r>0?n:null,drawCalls:r,tubeBytes:o?s:null,tubeByteBudget:this.constrainingTubeBudget,buildParallelism:this.buildParallelism,workerCount:this.poolWorkerCount,qualityMode:this.qualityMode,disclosures:[...this.buildDisclosures],parseMs:null,geometryBuildMs:this.buildStartMs===null?null:performance.now()-this.buildStartMs,firstRenderMs:this.firstRenderMs,totalReadyMs:null}}setBuildVolume(e){if(this.disposed)return;let t="bed"in e,n="bed"in e?Yh(e):e,s;try{s=Bs(n,this.volumeStyle())}catch(r){if(!t||!(r instanceof RangeError))throw r;this.emit({type:"error",code:"machine-geometry-invalid",message:`file-discovered bed rejected: ${r.message}`});return}if(this.volumeDef!==null&&t){let r=Math.abs(this.volumeDef.x-n.x),o=Math.abs(this.volumeDef.y-n.y);(r>1||o>1)&&this.emit({type:"error",code:"machine-geometry-mismatch",message:`file-discovered bed ${n.x}\xD7${n.y} differs from the configured ${this.volumeDef.x}\xD7${this.volumeDef.y} \u2014 this file may target a different printer`})}this.volumeGroup!==null&&(Xi(this.volumeGroup),this.root.remove(this.volumeGroup)),this.volumeDef=n,this.volumeGroup=s,this.root.add(this.volumeGroup),this.refreshContactShadow(),this.render()}get activeQuality(){return this.active}setQuality(e){this.disposed||(this.requestedQuality=e,this.ir!==null&&(this.startBuild(this.ir),this.render()))}setQualityMode(e){gn(e),!this.disposed&&(this.qualityMode=e,this.ir!==null&&(this.startBuild(this.ir),this.render()))}setProgressivePreview(e){Xn(e),!this.disposed&&(this.progressivePreview=e)}effectivePreview(){if(this.progressivePreview!=="auto")return this.progressivePreview;if(this.active==="tubes"&&this.buildResult!==null){let e=this.buildResult.chunks.reduce((n,s)=>s.kind==="extrude"?n+s.count:n,0),t=(this.gpuInfo??this.ensureGpuInfo()).capability;if(zh(e,this.tubeRadialSegments,t)>=op)return"hold"}return"lines"}get chunkMeshes(){return this.toolpathGroup.children.filter(e=>e.userData?.chunk!==void 0)}clearToolpathGeometry(){for(let e of[...this.toolpathGroup.children]){if(e===this.retractionPoints)continue;let t=e;t.geometry?.dispose();let n=t.material;Array.isArray(n)?n.forEach(s=>s.dispose()):n?.dispose(),this.toolpathGroup.remove(e)}this.pendingChunks=[],this.builtCount=0,this.previewSegments=0,this.previewBounds=null,this.markerMesh=null}dispose(){this.disposed||(this.disposed=!0,this.buildGeneration++,this.geometryPool?.dispose(),this.geometryPool=null,this.clearToolpathGeometry(),this.volumeGroup&&Xi(this.volumeGroup),this.backdrop?.dispose(),this.backdrop=null,this.ghostMaterial.dispose(),this.bandMaterial.dispose(),this.staleBandMaterial.dispose(),this.markerMaterial.dispose(),this.staleMarkerMaterial.dispose(),this.retractionPoints?.geometry?.dispose(),this.retractionMaterial.dispose(),this.stage.dispose(),this.listeners.clear(),this.ir=null)}}});function fp(i){try{return Zh(i)}catch(e){return{response:{id:i.id,error:e instanceof Error?e.message:String(e)},transfer:[]}}}function Zh(i){let e=new Float32Array(i.positions),t={kind:"extrude",layerStart:0,layerEnd:0,count:i.count,positions:e,segIndices:new Uint32Array(0)},n=es(t,{radialSegments:i.radialSegments,lineWidth:i.lineWidth,lineHeight:i.lineHeight}),s={id:i.id,positions:n.positions.buffer,normals:n.normals.buffer,indices:n.indices.buffer,vertexSegment:n.vertexSegment.buffer,vertexCount:n.vertexCount,indicesPerSegment:n.indicesPerSegment};return{response:s,transfer:[s.positions,s.normals,s.indices,s.vertexSegment]}}var pp=He(()=>{vo()});var mp={};Np(mp,{CAMERA_MODES:()=>Hn,CAMERA_VIEWS:()=>Wn,CONTACT_SHADOW_Z:()=>Nh,CaptureUnsupportedError:()=>hn,DEFAULT_THEME:()=>ql,DEVICE_PIXEL_RATIO_CAP:()=>El,FRAME_CONTENT_MODES:()=>Ys,GeometryWorkerPool:()=>ks,INTERACTION_QUALITY_MODES:()=>$s,InteractionQualityController:()=>zs,InteractiveStage:()=>Vs,MAX_GRID_LINES_PER_AXIS:()=>En,MIN_RADIAL_SEGMENTS:()=>sr,PROGRESSIVE_PREVIEW_MODES:()=>Xs,QUALITY_POLICIES:()=>qs,RENDERER_MODES:()=>Zs,STUDIO_CAMERA_FOV:()=>lo,TUBES_AUTO_MAX_SEGMENTS:()=>_o,TUBE_CPU_BYTE_BUDGET:()=>Qi,TUBE_SEGMENT_BUDGET:()=>ku,ToolpathRenderer:()=>Pl,UNKNOWN_GPU_INFO:()=>Oh,autoDecimation:()=>ir,buildChunkColors:()=>Mi,buildChunks:()=>vi,buildTubeChunk:()=>es,checkBuildVolume:()=>yi,checkCameraFov:()=>kt,checkCameraMode:()=>Tn,checkCameraState:()=>Zi,checkCameraView:()=>oo,checkFrameContent:()=>js,checkInteractionQuality:()=>Ks,checkPixelRatio:()=>An,checkProgressivePreview:()=>Xn,checkQualityMode:()=>gn,checkRendererMode:()=>ao,checkTheme:()=>_i,chooseQuality:()=>qh,classifyRenderer:()=>to,computeDrawState:()=>bi,computeOverlayDrawStates:()=>mo,createBackdrop:()=>Ml,createBrowserGeometryWorker:()=>sp,createBuildVolume:()=>Bs,createContactShadow:()=>bl,createDefaultGLRenderer:()=>Sl,detectRenderCapability:()=>np,disposeBuildVolume:()=>Xi,feedrateRange:()=>Ki,framingFromCenterRadius:()=>wl,framingLensScale:()=>qi,handleGeometryMessage:()=>fp,handleGeometryRequest:()=>Zh,lensScale:()=>tp,machineToVolume:()=>Yh,probeGpuInfo:()=>Al,resolveCapability:()=>ip,resolveHitSegment:()=>$h,resolvePoolSize:()=>Cl,resolveTheme:()=>Js,studioTheme:()=>co,tubeRadialForBudget:()=>xo,tubeSegmentBytes:()=>rr,volumeStyle:()=>xl});var gp=He(()=>{ec();tc();nc();vo();dp();Ph();Tl();Hh();Xh();ho();Dh();Uh();Lh();Bh();kh();pp();Fh();ji()});function _u(i){return typeof i=="object"&&i!==null&&typeof i.getReader=="function"}var qt=class extends Error{code;srcByte;constructor(e,t,n,s){super(t,s),this.code=e,this.srcByte=n,this.name="ParseSessionError"}},Gn=class extends qt{partial;terminated;constructor(e,t,n=!1){super("E_CANCELLED",e),this.partial=t,this.terminated=n,this.name="CancelledError"}};function Xp(){return new Worker(new URL("./vendor-gcode-worker.js",import.meta.url))}var Hs=class{factory;terminateFallbackMs;worker=null;active=null;nextId=1;instanceSupplied;instanceSpent=!1;progressListeners=new Set;partialListeners=new Set;constructor(e={}){let t=e.worker;this.instanceSupplied=t!==void 0&&typeof t!="function",this.factory=t===void 0?Xp:typeof t=="function"?t:()=>t,this.terminateFallbackMs=e.terminateFallbackMs??2e3}onProgress(e){return this.progressListeners.add(e),()=>this.progressListeners.delete(e)}onPartial(e){return this.partialListeners.add(e),()=>this.partialListeners.delete(e)}parse(e,t={}){return this.active!==null?Promise.reject(new qt("E_BUSY","a parse is already in progress on this session")):this.instanceSpent?Promise.reject(new qt("E_WORKER_TERMINATED","the worker instance supplied to this session was terminated; supply a worker factory to allow a new worker")):new Promise((n,s)=>{let r;try{r=this.ensureWorker()}catch(l){s(new qt("E_WORKER_CREATE_FAILED",`could not start the parse worker: ${l instanceof Error?l.message:String(l)}`,void 0,{cause:l}));return}let o=this.nextId++,a={id:o,resolve:n,reject:s};this.active=a;try{let l;e instanceof Uint8Array?l=[e.buffer]:_u(e)&&typeof e!="string"&&(l=[e]),r.postMessage({v:1,type:"parse",id:o,input:e,opts:t},l)}catch(l){this.settle(a,void 0,new qt("E_POST_FAILED",`could not send the parse to the worker: ${l instanceof Error?l.message:String(l)}`,void 0,{cause:l}))}})}cancel(){let e=this.active;e===null||this.worker===null||e.cancelTimer===void 0&&(this.worker.postMessage({v:1,type:"cancel",id:e.id}),e.cancelTimer=setTimeout(()=>{this.teardownWorker(),this.settle(e,void 0,new Gn("cancelled (worker terminated after timeout)",void 0,!0))},this.terminateFallbackMs))}dispose(){let e=this.active;e!==null&&this.settle(e,void 0,new qt("E_DISPOSED","session disposed")),this.teardownWorker(),this.progressListeners.clear(),this.partialListeners.clear()}ensureWorker(){if(this.worker===null){let e=this.factory();e.onmessage=t=>this.onMessage(t.data),e.onerror=t=>{let n=this.active;this.teardownWorker(),n!==null&&this.settle(n,void 0,new qt("E_WORKER_CRASHED",`worker crashed: ${t instanceof Error?t.message:String(t)}`))},this.worker=e}return this.worker}teardownWorker(){this.worker!==null&&(this.worker.onmessage=null,this.worker.onerror=null,this.worker.terminate(),this.worker=null,this.instanceSupplied&&(this.instanceSpent=!0))}settle(e,t,n){e.cancelTimer!==void 0&&clearTimeout(e.cancelTimer),this.active===e&&(this.active=null),n!==void 0?e.reject(n):t!==void 0&&e.resolve(t)}onMessage(e){let t=this.active;if(t===null||e.id!==t.id)return e.type==="progress",void 0;switch(e.type){case"progress":for(let n of this.progressListeners)n({bytesProcessed:e.bytesProcessed,totalBytes:e.totalBytes,phase:e.phase});return;case"partial":for(let n of this.partialListeners)n(e.slice,e.cumulativeSegments);return;case"done":this.settle(t,{ir:e.ir,stats:e.stats,metadata:e.metadata});return;case"cancelled":this.settle(t,void 0,new Gn("parse cancelled",e.partial?{ir:e.partial.ir,stats:e.partial.stats}:void 0));return;case"error":this.settle(t,void 0,new qt(e.error.code,e.error.message,e.error.srcByte));return}}};ji();mi();xi();function Kl(i){let e=i>0?i>1?1:i:0;return Math.round(e*255)}function Lu(i){return`rgb(${Kl(i[0])}, ${Kl(i[1])}, ${Kl(i[2])})`}function Kp(i,e){return[Math.max(0,i.segStart),Math.min(Math.floor(i.segEnd)+1,e)]}function fo(i,e){return Number.isFinite(i.x0[e])&&Number.isFinite(i.y0[e])&&Number.isFinite(i.x1[e])&&Number.isFinite(i.y1[e])}function Ql(i){let e=i.segments,t=0,n=0;for(let s=0;s<e.count;s++)(e.kind[s]&(ut.Extrude|ut.Travel|ut.Cut))!==0&&(fo(e,s)?t++:n++);return{drawable:t,skippedNonFinite:n}}function Du(i,e,t,n=8){let s=Number.isFinite(n)?n:0,r=Math.max(1,(Number.isFinite(e)?e:0)-2*s),o=Math.max(1,(Number.isFinite(t)?t:0)-2*s),a=Number.isFinite(i.minX)&&Number.isFinite(i.minY)&&Number.isFinite(i.maxX)&&Number.isFinite(i.maxY),l=a?i.minX:0,c=a?i.minY:0,h=a?i.maxX-l:0,u=a?i.maxY-c:0,p=!i.hasContent||h<=0&&u<=0?1:Math.min(h>0?r/h:1/0,u>0?o/u:1/0),d=h*p,g=u*p,_=s+(r-d)/2,m=s+(o-g)/2;return{scale:p,project(f,w){let M=_+(f-l)*p,v=m+(g-(w-c)*p);return[M,v]}}}function Jl(i,e,t){let n=e.layers.length,s=e.layers[t.layer],r={layer:t.layer,layerCount:n,extrudeDrawn:0,travelDrawn:0,cutDrawn:0,skippedNonFinite:0,drawn:!1};if(!s)return r;let o=e.segments,a=er(e,t.colorMode),l=t.lineWidth??1,c=t.travel?t.travel:null,h=t.cut!==!1,[u,p]=Kp(s,o.count),d=0;i.lineCap="round",i.lineJoin="round";let g=i.globalAlpha;i.globalAlpha=t.opacity??1;let _=0;if(c){i.strokeStyle=c.color,i.lineWidth=c.lineWidth??.5;for(let A=u;A<p;A++){if((o.kind[A]&ut.Travel)===0)continue;if(!fo(o,A)){d++;continue}let[I,C]=t.fit.project(o.x0[A],o.y0[A]),[P,S]=t.fit.project(o.x1[A],o.y1[A]);i.beginPath(),i.moveTo(I,C),i.lineTo(P,S),i.stroke(),_++}}i.lineWidth=l;let m=t.opacity??1,f=m*(t.upcomingOpacity??.15),w=t.progressCutSeg,M=0,v=0;for(let A=u;A<p;A++){let I=o.kind[A],C=(I&ut.Extrude)!==0;if(!C&&!(h&&(I&ut.Cut)!==0))continue;if(!fo(o,A)){d++;continue}i.globalAlpha=w!==void 0&&A>w?f:m,i.strokeStyle=Lu(a(A));let[P,S]=t.fit.project(o.x0[A],o.y0[A]),[x,T]=t.fit.project(o.x1[A],o.y1[A]);i.beginPath(),i.moveTo(P,S),i.lineTo(x,T),i.stroke(),C?M++:v++}return i.globalAlpha=g,{layer:t.layer,layerCount:n,extrudeDrawn:M,travelDrawn:_,cutDrawn:v,skippedNonFinite:d,drawn:!0}}function Nu(i){let e=i.segments,t=1/0,n=1/0,s=-1/0,r=-1/0;for(let o=0;o<e.count;o++){if(!fo(e,o))continue;let a=e.x0[o],l=e.x1[o],c=e.y0[o],h=e.y1[o];a<t&&(t=a),l<t&&(t=l),a>s&&(s=a),l>s&&(s=l),c<n&&(n=c),h<n&&(n=h),c>r&&(r=c),h>r&&(r=h)}return t>s?{minX:0,minY:0,maxX:0,maxY:0,hasContent:!1}:{minX:t,minY:n,maxX:s,maxY:r,hasContent:!0}}function po(i){let e=[],t=i.header.capabilities.layers;return t==="unavailable"?e.push("No planar layer index (non-planar or CNC toolpath): showing all moves in one flat top-down view. Z variation and non-XY (e.g. G18/G19 plane) motion are not represented in 2D."):t==="inferred"&&e.push("Layer index is inferred; layer boundaries may be approximate."),e}function Uu(i,e,t){let n=e.layers.length,s={layer:t.layer,layerCount:n,ghostLayers:[],extrudeDrawn:0,travelDrawn:0,cutDrawn:0,skippedNonFinite:0,drawn:!1};if(!e.layers[t.layer])return s;let r=Math.floor(t.adjacentLayers??1),o=t.ghostOpacity??.25,a=Math.max(0,t.layer-r),l=[],c=0,h=0,u=0,p=0;for(let m=a;m<t.layer;m++){let f=Jl(i,e,{layer:m,colorMode:t.colorMode,fit:t.fit,lineWidth:t.lineWidth,opacity:o,cut:t.cut});f.drawn&&(l.push(m),c+=f.extrudeDrawn,u+=f.cutDrawn,p+=f.skippedNonFinite)}let d=t.progress,g=d!=null&&d.segIndex!=null&&d.layerIndex===t.layer?d.segIndex:void 0,_=Jl(i,e,{layer:t.layer,colorMode:t.colorMode,fit:t.fit,lineWidth:t.lineWidth,travel:t.travel,cut:t.cut,progressCutSeg:g});return c+=_.extrudeDrawn,h+=_.travelDrawn,u+=_.cutDrawn,p+=_.skippedNonFinite,{layer:t.layer,layerCount:n,ghostLayers:l,extrudeDrawn:c,travelDrawn:h,cutDrawn:u,skippedNonFinite:p,drawn:!0}}var Jp={mode:"single",color:[.55,.72,.55]};function Pu(i){if(Number.isNaN(i))throw new RangeError(`LayerView2D: adjacentLayers must be a number (got ${i}).`)}function Qp(i){if(!(i>=0&&i<=1))throw new RangeError(`LayerView2D: ghostOpacity must be in [0, 1] (got ${i}).`)}function em(i){if(!(Number.isFinite(i)&&i>0))throw new RangeError(`LayerView2D: lineWidth must be a finite number > 0 (got ${i}).`)}function tm(i){if(!(Number.isFinite(i)&&i>=0))throw new RangeError(`LayerView2D: padding must be a finite number >= 0 (got ${i}).`)}var tr=class{canvas;ir=null;bounds={minX:0,minY:0,maxX:0,maxY:0,hasContent:!1};layer;colorMode;lineWidth;travel;cut;padding;adjacentLayers;ghostOpacity;progress=null;constructor(e,t={}){this.canvas=e,t.colorMode!==void 0&&Qt(t.colorMode),t.lineWidth!==void 0&&em(t.lineWidth),t.padding!==void 0&&tm(t.padding),t.adjacentLayers!==void 0&&Pu(t.adjacentLayers),t.ghostOpacity!==void 0&&Qp(t.ghostOpacity),this.layer=0,t.layer!==void 0&&this.setLayer(t.layer),this.colorMode=t.colorMode??Jp,this.lineWidth=t.lineWidth??1,this.travel=t.travel??!1,this.cut=t.cut??!0,this.padding=t.padding??8,this.adjacentLayers=t.adjacentLayers??1,this.ghostOpacity=t.ghostOpacity??.25}setToolpath(e){this.ir=e,this.bounds=e?Nu(e):{minX:0,minY:0,maxX:0,maxY:0,hasContent:!1}}setLayer(e){Number.isNaN(e)||(this.layer=e<0?0:Math.floor(e))}setColorMode(e){Qt(e),this.colorMode=e}setAdjacentLayers(e){Pu(e),this.adjacentLayers=e}setProgress(e){this.progress=e}setTravel(e){this.travel=e}setCut(e){this.cut=e}getDisclosures(){return this.ir?po(this.ir):[]}get layerCount(){return this.ir?.layers.length??0}render(){let e=this.canvas.getContext("2d"),t=Math.min(this.layer,Math.max(0,this.layerCount-1)),n={layer:t,layerCount:this.layerCount,ghostLayers:[],extrudeDrawn:0,travelDrawn:0,cutDrawn:0,skippedNonFinite:0,drawn:!1};if(!e||(e.clearRect(0,0,this.canvas.width,this.canvas.height),!this.ir))return n;let s=Du(this.bounds,this.canvas.width,this.canvas.height,this.padding);return Uu(e,this.ir,{layer:t,adjacentLayers:this.adjacentLayers,colorMode:this.colorMode,fit:s,lineWidth:this.lineWidth,travel:this.travel,cut:this.cut,ghostOpacity:this.ghostOpacity,progress:this.progress})}};xi();var nm={color:"rgba(120,120,120,0.9)",lineWidth:.5};function Fu(i){return Number.isFinite(i)&&i>=1?Math.round(i):1}var Ji=class{canvas;view;ir=null;listeners=new Set;travelStyle;disposed=!1;constructor(e,t={}){this.canvas=e,this.travelStyle=t.travel||nm,this.view=new tr(e,{colorMode:t.colorMode,adjacentLayers:t.adjacentLayers,ghostOpacity:t.ghostOpacity,lineWidth:t.lineWidth,travel:t.travel})}redraw(){this.disposed||this.view.render()}emit(e){for(let t of this.listeners)t(e)}disclose(e,t){this.emit({type:"renderer-unsupported",feature:e,message:t})}onEvent(e){return this.listeners.add(e),()=>this.listeners.delete(e)}resize(e,t){this.canvas.width=Fu(e),this.canvas.height=Fu(t),this.redraw()}setIR(e){if(this.disposed)return;this.ir=e,this.view.setToolpath(e),this.redraw();for(let s of po(e))this.disclose("layers",s);let{drawable:t,skippedNonFinite:n}=Ql(e);queueMicrotask(()=>{this.ir===e&&this.emit({type:"buildComplete",segments:t,decimationApplied:1,travelHidden:!1,quality:"lines",skippedNonFinite:n})})}appendPartial(){}get layerCount(){return this.ir?.layers.length??0}get segmentCount(){return this.ir?.segments.count??0}setBuildVolume(e){}setBuildVolumeCage(e){}setFrameContent(e){}setInteractionQuality(e){}setLayerRange(e,t){this.view.setLayer(t),this.redraw()}setScrubPosition(e){}setKindVisible(e,t){if(e==="travel")this.view.setTravel(t?this.travelStyle:!1);else if(e==="cut")this.view.setCut(t);else return;this.redraw()}setShowRetractions(e){e&&this.disclose("retractions","Retraction markers are only shown in the 3D renderer.")}setColorMode(e){return this.isColorModeAvailable(e.mode)?(this.view.setColorMode(e),this.redraw(),!0):!1}isColorModeAvailable(e){let t=this.ir?.header.capabilities;return e==="feature"?t?.featureRoles!==void 0&&t.featureRoles!=="unavailable":e==="colorChange"?t?.colorChanges!==void 0&&t.colorChanges!=="unavailable":e==="object"?t?.objects!==void 0&&t.objects!=="unavailable":e==="feedrate"?t?.feedrate!=="unavailable":e==="layerHeight"?t?.layers!==void 0&&t.layers!=="unavailable":e==="power"?t?.toolPower!==void 0&&t.toolPower!=="unavailable":!0}get hasRetractions(){return!1}get hasColorChanges(){return this.ir?.header.capabilities.colorChanges==="known"}getRenderStats(){return null}setQuality(e){this.disclose("quality","Quality/geometry modes apply only to the 3D renderer; the 2D view has none.")}setQualityMode(e){}setProgressivePreview(e){}setCameraMode(e){this.disclose("camera","Camera projection applies only to the 3D renderer; the 2D view is flat top-down.")}setCameraFov(e){this.disclose("camera","The camera lens applies only to the 3D renderer; the 2D view is flat top-down.")}setPixelRatio(e){this.disclose("quality","The pixel ratio applies only to the 3D renderer; the 2D view keeps its own resolution.")}setView(e){this.disclose("camera","Preset views apply only to the 3D renderer; the 2D view is fixed top-down.")}getCameraState(){return null}setCameraState(e){this.disclose("camera","Camera state applies only to the 3D renderer; the 2D view has no 3D pose.")}setTheme(e){}setProgress(e){let t=e===null?null:{segIndex:e.segIndex,layerIndex:e.layerIndex};this.view.setProgress(t),this.redraw()}pickSegment(){return null}frame(){this.redraw()}dispose(){this.disposed=!0,this.listeners.clear(),this.view.setToolpath(null),this.ir=null}};mi();var Bu=[.7,.7,.7];function im(i){if(i===void 0)return null;let e=i.trim().replace(/^#/,"");return e.length===3&&(e=e[0]+e[0]+e[1]+e[1]+e[2]+e[2]),/^[0-9a-fA-F]{6}$/.test(e)?[parseInt(e.slice(0,2),16)/255,parseInt(e.slice(2,4),16)/255,parseInt(e.slice(4,6),16)/255]:null}var sm=64;function Ou(i){return Number.isInteger(i)&&i>=0&&i<sm}function rm(i,e=Bu){let t=i?.filaments;if(t===void 0)return[];let n=-1;for(let o of t)Ou(o.slot)&&o.slot>n&&(n=o.slot);let s=Array.from({length:n+1},()=>e),r=!1;for(let o of t){let a=Ou(o.slot)?im(o.color):null;a!==null&&(s[o.slot]=a,r=!0)}return r?s:[]}function nr(i,e,t){if(i===void 0||i.mode!=="filament")return i;let n=i.fallback??Bu,s=rm(e,n);if(s.length===0)return{mode:"single",color:n};if(t===null)return{mode:"tool",palette:s,fallback:n};let r=t.colorChanges.length>0,o=r?t.colorChanges.length+1:0;if(!r)for(let a of t.tools)a.id+1>o&&(o=a.id+1);for(;s.length<o;)s.push(n);return r?{mode:"colorChange",palette:s,fallback:n}:{mode:"tool",palette:s,fallback:n}}function Ll(i,e,t,n){let s={code:i,message:e};return t!==void 0&&(s.cause=t),n!==void 0&&(s.reason=n),s}var xp=["single","tool","feature","colorChange","filament","feedrate","object","layerHeight","power","moveKind"],Bv={parsing:!1,parseProgress:null,summary:null,metadata:void 0,activeQuality:null,presentation:"hidden",layerCount:0,segmentCount:0,disclosure:"",totalTimeMs:null,timeEstimateSource:null,availableColorModes:[],hasRetractions:!1,hasColorChanges:!1,error:null};function kv(i){try{let e=typeof File<"u"&&i instanceof File?i.size:i.byteLength;return typeof e=="number"?e:0}catch{return 0}}function zv(i){return i instanceof Uint8Array?i:new Uint8Array(i)}function Vv(i){let e=i%100,t=i%10,n=e>=11&&e<=13?"th":t===1?"st":t===2?"nd":t===3?"rd":"th";return`${i}${n}`}function _p(i,e){for(let t of i)try{t(e)}catch(n){queueMicrotask(()=>{throw n})}}function Gv(i){i!=null&&(i.mode!=null&&ao(i.mode),i.buildVolume!=null&&!vp(i.buildVolume)&&yi(i.buildVolume),i.qualityMode!=null&&gn(i.qualityMode),i.progressivePreview!=null&&Xn(i.progressivePreview),i.cameraMode!=null&&Tn(i.cameraMode),i.cameraFov!=null&&kt(i.cameraFov),i.pixelRatio!=null&&An(i.pixelRatio),i.frameContent!=null&&js(i.frameContent),i.interactionQuality!=null&&Ks(i.interactionQuality),_i(i.theme))}function vp(i){return typeof i=="object"&&"bed"in i}function Dl(i,e){if(typeof e!="number"||Number.isNaN(e))throw new RangeError(`${i} needs a number that is not NaN (got ${String(e)})`)}function yp(i,e){return pu(i.cumulativeMs,e)-1}function jh(i={}){let e={...Bv},t=new Set,n=R=>{e={...e,...R},_p(t,e)},s=new Hs(i.createWorker===void 0?{}:{worker:i.createWorker}),r=null,o=null,a=null,l=null,c,h=null;i.renderer?.colorMode!==void 0&&Qt(i.renderer.colorMode);let u=i.renderer?.colorMode,p,d=i.renderer?.buildVolume!=null;Gv(i.renderer);let g=i.renderer?.cameraFov??void 0,_=i.renderer?.pixelRatio??void 0,m=null,f=0,w=null,M=null,v=!1,A=0,I=[],C=null,P=null,S=!1,x=()=>a===null||S,T=(R,H)=>{r!==null?H(r):I.push({control:R,run:H})},z=new Set,O=R=>_p(z,R);function X(R){if(R.type==="buildComplete"){let H=R.decimationApplied>1?`Showing every ${Vv(R.decimationApplied)} drawn segment (layer boundaries kept); travel hidden. ${R.segments.toLocaleString()} segments drawn.`:"",q=R.skippedNonFinite??0,de=q>0?q===1?"1 segment with a non-finite coordinate was not drawn.":`${q.toLocaleString()} segments with a non-finite coordinate were not drawn.`:"";n({activeQuality:R.quality,disclosure:H!==""&&de!==""?`${H} ${de}`:H+de})}else R.type==="qualityFallback"?n({activeQuality:R.to}):R.type==="progress-presentation-changed"?n({presentation:R.mode}):R.type==="error"&&n({error:{code:R.code,message:R.message}});O(R)}function K(){o?.(),o=null,w?.disconnect(),w=null,M!==null&&typeof window<"u"&&(window.removeEventListener("resize",M),M=null),r?.dispose(),r=null}function k(R){let H=R.clientWidth||R.width||1,q=R.clientHeight||R.height||1;r?.resize(H,q)}function te(R,H){if(r=H,o=H.onEvent(X),k(R),typeof ResizeObserver<"u"){let q=new ResizeObserver(()=>k(R));q.observe(R),w=q}if(typeof window<"u"&&(M=()=>k(R),window.addEventListener("resize",M)),a!==null&&(H.setIR(a),c!==void 0&&!d&&H.setBuildVolume(c)),r===H){for(let q of I.splice(0)){try{q.run(H)}catch(de){let Re=Ll("E_CONTROL_REJECTED",`${q.control} rejected: ${de instanceof Error?de.message:String(de)}`,de);n({error:Re}),O({type:"error",...Re})}if(r!==H)return}a!==null&&(n({layerCount:H.layerCount,segmentCount:H.segmentCount}),Ce())}}function W(R){if(v||(K(),R===null))return;let H=++A,q=i.renderer??{};if((q.mode??"3d")==="2d"){te(R,new Ji(R,{colorMode:nr(u,p,a),adjacentLayers:q.adjacentLayers,ghostOpacity:q.ghostOpacity}));return}Promise.resolve().then(()=>(gp(),mp)).then(Re=>{if(v||H!==A)return;let fe=new Re.ToolpathRenderer({canvas:R,buildVolume:q.buildVolume,quality:q.quality??"auto",qualityMode:q.qualityMode??void 0,progressivePreview:q.progressivePreview??void 0,cameraMode:q.cameraMode??void 0,cameraFov:g,..._!==void 0?{pixelRatio:_}:{},frameContent:q.frameContent,interactionQuality:q.interactionQuality,colorMode:nr(u,p,a),tube:q.tube,theme:q.theme,createRenderer:q.createRenderer,scheduleFrame:q.scheduleFrame,chunksPerTick:q.chunksPerTick,geometryConcurrency:q.geometryConcurrency,geometryMemoryBudgetBytes:q.geometryMemoryBudgetBytes,...typeof navigator<"u"&&Number.isFinite(navigator.hardwareConcurrency)?{coreBudget:navigator.hardwareConcurrency}:{},...typeof Worker<"u"&&q.geometryConcurrency!=="off"?{createGeometryWorker:Re.createBrowserGeometryWorker}:{}});te(R,fe)},de("load")).catch(de("start"));function de(Re){return fe=>{if(v||H!==A)return;let xe=Ll("E_RENDERER_LOAD",fe instanceof Error?fe.message:String(fe),fe,Re);n({error:xe}),O({type:"error",...xe})}}}let se=s.onProgress(R=>{n({parseProgress:R}),O({type:"parse-progress",progress:R});let H=R.totalBytes>0?R.bytesProcessed/R.totalBytes:void 0;O({type:"stage",stage:R.phase==="finalizing"?"classifying":"parsing",progress:H})}),re=s.onPartial(R=>{r?.appendPartial(R)});async function pe(R,H){if(v)return{ok:!1,error:{code:"E_DISPOSED",message:"preview disposed"}};let q=++f;if(S=!0,e.parsing&&(s.cancel(),await m?.catch(()=>{}),q!==f||v))return{ok:!1,cancelled:!0};n({parsing:!0,parseProgress:null,error:null});let de=kv(R);O({type:"parse-started",bytes:de});let Re=null;try{if(typeof R!="object"||R===null)throw new TypeError(`parse input must be a Uint8Array, ArrayBuffer or File (got ${String(R)})`);let fe={...i.parseDefaults,...H};Re=s.parse(R instanceof ArrayBuffer?zv(R):R,fe),m=Re;let xe=await Re;if(q!==f)throw new Gn("superseded by a newer parse");a=xe.ir,p=xe.metadata,c=xe.metadata?.machine,h=uu(xe.ir,{fileSizeBytes:de}),l=fu(xe.ir);let je=l,Ge=xe.metadata?.printEstimate?.seconds,L=Ge!==void 0?Ge*1e3:l.totalMs,_t=Ge!==void 0?"slicer":"kinematic",qe=r!==null?{layerCount:r.layerCount,segmentCount:r.segmentCount}:{layerCount:xe.ir.layers.length,segmentCount:xe.ir.segments.count};r!==null&&(u?.mode==="filament"&&r.setColorMode(nr(u,xe.metadata,xe.ir)),r.setIR(xe.ir));let $e=C,me=P;if(C=null,P=null,S=!1,$e!==null&&T("setLayerRange",ke=>ke.setLayerRange($e.start,$e.end)),me!==null){let ke=me.kind==="segment"?me.seg:yp(je,me.ms);T(me.kind==="segment"?"setScrubPosition":"setScrubTime",Se=>Se.setScrubPosition(ke))}return n({summary:{segments:xe.ir.segments.count,layers:xe.ir.layers.length,complete:xe.ir.header.complete,stopReason:xe.stats.stopReason?.code,capabilities:{...xe.ir.header.capabilities},warnings:xe.ir.header.warnings.length},metadata:xe.metadata,presentation:"hidden",totalTimeMs:L,timeEstimateSource:_t,...r!==null?{layerCount:r.layerCount,segmentCount:r.segmentCount}:qe}),c!==void 0&&(d?O({type:"machine-geometry-discovered",machine:c}):r?.setBuildVolume(c)),O({type:"parse-complete",segments:xe.ir.segments.count,layers:xe.ir.layers.length,complete:xe.ir.header.complete,capabilities:{...xe.ir.header.capabilities},warnings:xe.ir.header.warnings,metadata:xe.metadata}),Ce(),{ok:!0,result:xe}}catch(fe){if(fe instanceof Gn||q!==f)return O({type:"parse-cancelled"}),{ok:!1,cancelled:!0};let xe=fe instanceof qt?Ll(fe.code,fe.message,fe.cause):Ll("E_UNKNOWN",fe instanceof Error?fe.message:String(fe),fe);return n({error:xe}),O({type:"parse-error",...xe}),{ok:!1,error:xe}}finally{q===f&&(S=!1),n({parsing:!1,parseProgress:null}),m===Re&&(m=null)}}function Ce(){if(r===null)return;let R=r;n({availableColorModes:xp.filter(H=>R.isColorModeAvailable(H)),hasRetractions:R.hasRetractions,hasColorChanges:R.hasColorChanges})}let Xe={setLayerRange:(R,H)=>{Dl("setLayerRange startLayer",R),Dl("setLayerRange endLayer",H),C=x()?{start:R,end:H}:null,T("setLayerRange",q=>q.setLayerRange(R,H))},setScrubPosition:R=>{R!==null&&Dl("setScrubPosition",R),P=x()?{kind:"segment",seg:R}:null,T("setScrubPosition",H=>H.setScrubPosition(R))},setScrubTime:R=>{if(R!==null&&Dl("setScrubTime",R),P=x()?R===null?{kind:"segment",seg:null}:{kind:"time",ms:R}:null,R===null){T("setScrubTime",q=>q.setScrubPosition(null));return}if(l===null)return;let H=yp(l,R);T("setScrubTime",q=>q.setScrubPosition(H))},setKindVisible:(R,H)=>T("setKindVisible",q=>q.setKindVisible(R,H)),setFeatureRoleVisible:(R,H)=>T("setFeatureRoleVisible",q=>q.setFeatureRoleVisible?.(R,H)),setShowRetractions:R=>T("setShowRetractions",H=>H.setShowRetractions(R)),setColorMode:R=>{Qt(R),u=R;let H=nr(R,p,a)??R;return r!==null?r.setColorMode(H):(I.push({control:"setColorMode",run:q=>q.setColorMode(H)}),!0)},setQuality:R=>T("setQuality",H=>H.setQuality(R)),setQualityMode:R=>{gn(R),T("setQualityMode",H=>H.setQualityMode(R))},setProgressivePreview:R=>{Xn(R),T("setProgressivePreview",H=>H.setProgressivePreview(R))},setCameraMode:R=>{Tn(R),T("setCameraMode",H=>H.setCameraMode(R))},setCameraFov:R=>{kt(R),g=R,T("setCameraFov",H=>H.setCameraFov?.(R))},setPixelRatio:R=>{An(R),_=R,T("setPixelRatio",H=>H.setPixelRatio?.(R))},setView:R=>{oo(R),T("setView",H=>H.setView(R))},getCameraState:()=>r!==null?r.getCameraState():null,capture:R=>r!==null&&typeof r.capture=="function"?r.capture(R):Promise.reject(new hn("capture unavailable: renderer not ready or unsupported")),getRenderStats:()=>r!==null?r.getRenderStats():null,pickSegment:(R,H,q)=>r!==null?r.pickSegment(R,H,q):null,isColorModeAvailable:R=>r!==null?r.isColorModeAvailable(R):!0,setCameraState:R=>{Zi(R),T("setCameraState",H=>H.setCameraState(R))},setTheme:R=>{_i(R),T("setTheme",H=>H.setTheme(R))},setBuildVolume:R=>{R!=null&&(vp(R)||yi(R),d=!0,T("setBuildVolume",H=>H.setBuildVolume(R)))},setBuildVolumeCage:R=>T("setBuildVolumeCage",H=>H.setBuildVolumeCage(R)),setFrameContent:R=>{let H=R??"all";js(H),T("setFrameContent",q=>q.setFrameContent(H))},setInteractionQuality:R=>{let H=R??"off";Ks(H),T("setInteractionQuality",q=>q.setInteractionQuality(H))},frame:()=>T("frame",R=>R.frame())};function Z(){v||(v=!0,s.cancel(),se(),re(),s.dispose(),K(),a=null,l=null,h=null,z.clear(),t.clear())}return{bindCanvas:W,parse:pe,cancel:()=>s.cancel(),observeProgress:R=>{if(h===null)return null;let H=h.observe(R);return r?.setProgress(H),H},tickProgress:R=>{if(h===null)return null;let H=h.tick(R);return r?.setProgress(H),H},clearProgress:()=>{h?.reset(),r?.setProgress(null),n({presentation:"hidden"})},getState:()=>e,onStateChange:R=>(t.add(R),()=>t.delete(R)),controls:Xe,raw:{session:s,renderer:()=>r},onEvent:R=>(z.add(R),()=>z.delete(R)),dispose:Z}}ji();ji();ji();var Nl=["auto","lines","tubes"],Ul=qs,Fl=Xs;var Ol=Ys,Bl=$s,Kh=Zs;function Lt(i,e){return i.includes(e)?e:void 0}function Vn(i,e,t){if(t!==null&&!e.includes(t))throw new RangeError(`${i} must be ${e.map(n=>`'${n}'`).join(", ")} (got ${String(t)})`)}var Hv=50,Wv=["quality","quality-mode","progressive-preview","camera-mode","camera-fov","pixel-ratio","frame-content","interaction-quality","view","show-travel","show-wipe","show-cut","show-retractions","show-volume-cage","scrub","scrub-time","layer-range","hidden-feature-roles"],Ep="gcode-preview";function Xv(i){return i===null?void 0:no(i)}var io=class extends HTMLElement{static get observedAttributes(){return[...Wv]}controller=null;canvasEl=null;_source=null;_parseOptions;_buildVolume;_colorMode;_tube;_theme;lastFov;lastPixelRatio;lastScrub=null;lastScrubTime=null;_progress=null;_createWorker;_rendererOptions;_cameraState=null;prevHiddenRoles=[];get source(){return this._source}set source(e){if(e===this._source||(this._source=e,this.controller===null||e===null))return;let t=this.controller;t.parse(e,this._parseOptions);let n=this.layerRange;n!==null&&t.controls.setLayerRange(n[0],n[1]);let s=this.scrub;s!==null&&t.controls.setScrubPosition(s);let r=this.scrubTime;r!==null&&t.controls.setScrubTime(r)}get parseOptions(){return this._parseOptions}set parseOptions(e){this._parseOptions=e}get buildVolume(){return this._buildVolume}set buildVolume(e){this._buildVolume=e,this.controller!==null&&e!=null&&"bed"in e&&this.controller.controls.setBuildVolume(e)}get colorMode(){return this._colorMode}set colorMode(e){this._colorMode=e,this.controller!==null&&e!==void 0&&this.controller.controls.setColorMode(e)}get tube(){return this._tube}set tube(e){this._tube=e}get theme(){return this._theme}set theme(e){this._theme=e,this.controller!==null&&e!==void 0&&this.controller.controls.setTheme(e)}get progress(){return this._progress}set progress(e){this._progress=e,this.applyProgress()}get createWorker(){return this._createWorker}set createWorker(e){this._createWorker=e}get rendererOptions(){return this._rendererOptions}set rendererOptions(e){this._rendererOptions=e}get renderer(){return this.getAttribute("renderer")}set renderer(e){Vn("renderer",Kh,e),this.reflect("renderer",e)}get adjacentLayers(){let e=this.getAttribute("adjacent-layers");return e===null?null:Number(e)}set adjacentLayers(e){this.reflect("adjacent-layers",e)}get quality(){return this.getAttribute("quality")}set quality(e){Vn("quality",Nl,e),this.reflect("quality",e)}get qualityMode(){return this.getAttribute("quality-mode")}set qualityMode(e){Vn("qualityMode",Ul,e),this.reflect("quality-mode",e)}get progressivePreview(){return this.getAttribute("progressive-preview")}set progressivePreview(e){Vn("progressivePreview",Fl,e),this.reflect("progressive-preview",e)}get cameraMode(){return this.getAttribute("camera-mode")}set cameraMode(e){Vn("cameraMode",Hn,e),this.reflect("camera-mode",e)}get cameraFov(){return wp(this.getAttribute("camera-fov"))??this.lastFov??null}set cameraFov(e){if(e!==null&&!(e>=10&&e<=120))throw new RangeError(`fov must be in [10, 120] degrees (got ${String(e)})`);this.reflect("camera-fov",e)}get pixelRatio(){return Sp(this.getAttribute("pixel-ratio"))??this.lastPixelRatio??null}set pixelRatio(e){if(e!==null&&e!=="device"&&!(typeof e=="number"&&e>0&&e<=4))throw new RangeError(`pixelRatio must be 'device' or a number in (0, 4] (got ${String(e)})`);this.reflect("pixel-ratio",e)}get frameContent(){return this.getAttribute("frame-content")}set frameContent(e){Vn("frameContent",Ol,e),this.reflect("frame-content",e)}get interactionQuality(){return this.getAttribute("interaction-quality")}set interactionQuality(e){Vn("interactionQuality",Bl,e),this.reflect("interaction-quality",e)}get view(){return this.getAttribute("view")}set view(e){Vn("view",Wn,e),this.reflect("view",e)}get cameraState(){return this.controller!==null?this.controller.controls.getCameraState():this._cameraState}set cameraState(e){this._cameraState=e,this.controller!==null&&e!==null&&this.controller.controls.setCameraState(e)}get showTravel(){return this.getAttribute("show-travel")!=="false"}set showTravel(e){this.setAttribute("show-travel",e?"true":"false")}get showWipe(){return this.getAttribute("show-wipe")!=="false"}set showWipe(e){this.setAttribute("show-wipe",e?"true":"false")}get showCut(){return this.getAttribute("show-cut")!=="false"}set showCut(e){this.setAttribute("show-cut",e?"true":"false")}get showRetractions(){return this.getAttribute("show-retractions")==="true"}set showRetractions(e){this.setAttribute("show-retractions",e?"true":"false")}get showVolumeCage(){return this.getAttribute("show-volume-cage")!=="false"}set showVolumeCage(e){this.setAttribute("show-volume-cage",e?"true":"false")}get scrub(){let e=this.getAttribute("scrub");return e===null?null:no(e)??this.lastScrub}set scrub(e){this.reflect("scrub",e)}get scrubTime(){let e=this.getAttribute("scrub-time");return e===null?null:no(e)??this.lastScrubTime}set scrubTime(e){this.reflect("scrub-time",e)}get layerRange(){return Mp(this.getAttribute("layer-range"))}set layerRange(e){this.reflect("layer-range",e===null?null:`${e[0]},${e[1]}`)}get hiddenFeatureRoles(){return bp(this.getAttribute("hidden-feature-roles"))}set hiddenFeatureRoles(e){this.reflect("hidden-feature-roles",e===null||e.length===0?null:e.join(","))}get state(){return this.requireController().getState()}get controls(){return this.requireController().controls}get raw(){return this.requireController().raw}parse(e,t){return this.requireController().parse(e,t)}capture(e){return this.controller===null?Promise.reject(new hn("no canvas bound (not connected)")):this.controller.controls.capture(e)}observeProgress(e){return this.controller?.observeProgress(e)??null}tickProgress(e){return this.controller?.tickProgress(e)??null}clearProgress(){this.controller?.clearProgress()}onEvent(e){return this.requireController().onEvent(e)}connectedCallback(){if(this.controller!==null)return;let e=this.shadowRoot??this.attachShadow({mode:"open"});e.replaceChildren();let t=document.createElement("style");t.textContent=":host{display:block;width:100%;height:100%}canvas{display:block;width:100%;height:100%}";let n=document.createElement("canvas");n.setAttribute("aria-label","3D G-code toolpath preview"),n.setAttribute("tabindex","0"),e.append(t,n),this.canvasEl=n;let s=this._buildVolume!=null&&"bed"in this._buildVolume,r=Lt(Kh,this.getAttribute("renderer")),o=Lt(Nl,this.getAttribute("quality"))??"auto",a=Lt(Hn,this.getAttribute("camera-mode"))??null,l=this.acceptFov(this.getAttribute("camera-fov")),c=this.acceptPixelRatio(this.getAttribute("pixel-ratio"));if(this.controller=jh({createWorker:this._createWorker,renderer:{mode:r,buildVolume:s?void 0:this._buildVolume,quality:o,qualityMode:Lt(Ul,this.getAttribute("quality-mode")),progressivePreview:Lt(Fl,this.getAttribute("progressive-preview")),cameraMode:a??void 0,cameraFov:l,pixelRatio:c,frameContent:Lt(Ol,this.getAttribute("frame-content")),interactionQuality:Lt(Bl,this.getAttribute("interaction-quality")),colorMode:this._colorMode,tube:this._tube,theme:this._theme,adjacentLayers:Xv(this.getAttribute("adjacent-layers")),...this._rendererOptions},parseDefaults:this._parseOptions}),this.controller.onEvent(h=>this.reemit(h)),this.controller.bindCanvas(n),r==="2d"){let h=this.controller.controls;o!=="auto"&&h.setQuality(o),a!==null&&a!=="perspective"&&h.setCameraMode(a),l!==void 0&&l!==Hv&&h.setCameraFov(l),c!==void 0&&h.setPixelRatio(c)}s&&this.controller.controls.setBuildVolume(this._buildVolume),this.applyRuntimeState(),this._source!==null&&this.controller.parse(this._source,this._parseOptions)}disconnectedCallback(){this.controller?.dispose(),this.controller=null,this.canvasEl=null,this.shadowRoot?.replaceChildren(),this.prevHiddenRoles=[]}attributeChangedCallback(e,t,n){if(this.controller===null)return;let s=this.controller.controls;switch(e){case"quality":{let r=n===null?"auto":Lt(Nl,n);r!==void 0&&s.setQuality(r);break}case"quality-mode":{let r=Lt(Ul,n);r!==void 0&&s.setQualityMode(r);break}case"progressive-preview":{let r=Lt(Fl,n);r!==void 0&&s.setProgressivePreview(r);break}case"camera-mode":{let r=Lt(Hn,n);r!==void 0&&s.setCameraMode(r);break}case"camera-fov":{let r=this.acceptFov(n);r!==void 0&&s.setCameraFov(r);break}case"pixel-ratio":{let r=this.acceptPixelRatio(n);r!==void 0&&s.setPixelRatio(r);break}case"frame-content":{let r=Lt(Ol,n);r!==void 0&&s.setFrameContent(r);break}case"interaction-quality":{let r=Lt(Bl,n);r!==void 0&&s.setInteractionQuality(r);break}case"view":{let r=Lt(Wn,n);r!==void 0&&s.setView(r);break}case"show-travel":s.setKindVisible("travel",n!=="false");break;case"show-wipe":s.setKindVisible("wipe",n!=="false");break;case"show-cut":s.setKindVisible("cut",n!=="false");break;case"show-volume-cage":s.setBuildVolumeCage(n!=="false");break;case"show-retractions":s.setShowRetractions(n==="true");break;case"scrub":{let r=this.acceptScrub(n);r!==void 0&&s.setScrubPosition(r);break}case"scrub-time":{let r=this.acceptScrubTime(n);r!==void 0&&s.setScrubTime(r);break}case"layer-range":{let r=Mp(n);r===null?s.setLayerRange(0,Number.POSITIVE_INFINITY):s.setLayerRange(r[0],r[1]);break}case"hidden-feature-roles":this.applyHiddenRoles(bp(n));break;default:break}}applyRuntimeState(){let e=this.requireController().controls;e.setKindVisible("travel",this.showTravel),e.setKindVisible("wipe",this.showWipe),e.setKindVisible("cut",this.showCut),e.setShowRetractions(this.showRetractions),e.setBuildVolumeCage(this.showVolumeCage);let t=this.layerRange;t===null?e.setLayerRange(0,Number.POSITIVE_INFINITY):e.setLayerRange(t[0],t[1]),e.setScrubPosition(this.acceptScrub(this.getAttribute("scrub"))??this.lastScrub);let n=this.acceptScrubTime(this.getAttribute("scrub-time"))??this.lastScrubTime;n!==null&&e.setScrubTime(n),this.applyHiddenRoles(this.hiddenFeatureRoles),this.applyProgress();let s=Lt(Wn,this.getAttribute("view"));s!==void 0&&e.setView(s),this._cameraState!==null&&e.setCameraState(this._cameraState)}applyHiddenRoles(e){if(this.controller===null)return;let t=this.controller.controls;for(let n of this.prevHiddenRoles)e.includes(n)||t.setFeatureRoleVisible(n,!0);for(let n of e)this.prevHiddenRoles.includes(n)||t.setFeatureRoleVisible(n,!1);this.prevHiddenRoles=[...e]}applyProgress(){this.controller!==null&&(this._progress===null?this.controller.clearProgress():this.controller.observeProgress(this._progress))}acceptFov(e){let t=wp(e);return t!==void 0&&(this.lastFov=t),this.lastFov}acceptPixelRatio(e){let t=Sp(e);return t!==void 0&&(this.lastPixelRatio=t),this.lastPixelRatio}acceptScrub(e){if(e===null)return this.lastScrub=null;let t=no(e);return t!==void 0&&(this.lastScrub=t),t}acceptScrubTime(e){if(e===null)return this.lastScrubTime=null;let t=no(e);return t!==void 0&&(this.lastScrubTime=t),t}reflect(e,t){t===null?this.removeAttribute(e):this.setAttribute(e,String(t))}requireController(){if(this.controller===null)throw new Error("<gcode-preview>: not connected to the DOM yet (no controller). Append it before use.");return this.controller}reemit(e){let t=(n,s)=>{this.dispatchEvent(new CustomEvent(n,{detail:s}))};switch(e.type){case"parse-complete":t("ready",{segments:e.segments,layers:e.layers,complete:e.complete,capabilities:e.capabilities,warnings:e.warnings,metadata:e.metadata});break;case"camera-changed":t("camerachange",e.state);break;case"parse-error":{let{type:n,...s}=e;t("parse-error",s);break}case"parse-cancelled":t("parse-cancelled");break;case"parse-progress":t("parse-progress",{bytesProcessed:e.progress.bytesProcessed,totalBytes:e.progress.totalBytes});break;case"stage":t("stage",{stage:e.stage,progress:e.progress,detail:e.detail});break;case"buildComplete":t("build-complete",{segments:e.segments,quality:e.quality}),t("disclosure",{text:this.controller?.getState().disclosure??""});break;case"qualityFallback":t("quality-fallback",{from:e.from,to:e.to,reason:e.reason});break;case"progress-presentation-changed":t("progress-presentation-changed",e.reason===void 0?{mode:e.mode}:{mode:e.mode,reason:e.reason});break;case"machine-geometry-discovered":t("machine-geometry-discovered",{machine:e.machine});break;case"error":{let{type:n,...s}=e;e.code==="machine-geometry-mismatch"?t("machine-geometry-mismatch",{message:e.message}):t("error",s);break}case"renderer-unsupported":t("renderer-unsupported",{feature:e.feature,message:e.message});break;default:break}}};function Mp(i){if(i===null)return null;let e=i.split(",").map(t=>Number(t));return e.length!==2||e.some(t=>Number.isNaN(t))?null:[e[0],e[1]]}function bp(i){return i===null||i.trim()===""?[]:i.split(",").map(e=>Number(e)).filter(e=>Number.isFinite(e))}function Tp(i=Ep){typeof customElements>"u"||customElements.get(i)===void 0&&customElements.define(i,io)}function Sp(i){if(i==="device")return"device";let e=Number(i);return e>0&&e<=4?e:void 0}function no(i){let e=Number(i);return Number.isNaN(e)?void 0:e}function wp(i){let e=Number(i);return e>=10&&e<=120?e:void 0}mi();xi();export{xp as ALL_COLOR_MODES,wn as FeatureRole,io as GcodePreviewElement,Ji as LayerView2DRenderer,ut as MoveKind,lo as STUDIO_CAMERA_FOV,jh as createPreviewController,Tp as defineGcodePreview,Ki as feedrateRange,co as studioTheme};
/*! Bundled license information:

three/build/three.core.js:
three/build/three.module.js:
  (**
   * @license
   * Copyright 2010-2025 Three.js Authors
   * SPDX-License-Identifier: MIT
   *)
*/
