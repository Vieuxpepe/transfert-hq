/* Local, pre-generated reaction OGGs. No synthesis credentials in the browser. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HqCompanionReactionAudio=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MANIFEST_REVISION='2026-11-04-expressive';
  const HOT_PREFETCH_KINDS=['hmm','giggle','laugh','exhale','kiss','moan','surprised','lipsmack','wet_mouth','gulp','pleasure','whimper','contented','humming','yawn'];
  const HOT_PREFETCH_PER_KIND=2;
  function pickVariant(samples,state,random=Math.random){
    if(!samples?.length)return null;
    if(!state.bag?.length){
      state.bag=samples.slice();
      for(let i=state.bag.length-1;i>0;i--){
        const j=Math.min(i,Math.floor(Math.max(0,Math.min(1,random()))*(i+1)));
        [state.bag[i],state.bag[j]]=[state.bag[j],state.bag[i]];
      }
      if(state.bag.length>1&&state.bag[0]===state.last)[state.bag[0],state.bag[1]]=[state.bag[1],state.bag[0]];
    }
    return state.last=state.bag.shift();
  }
  function create(win, enabled, random=Math.random, context=()=>({})){
    let bank={},phases={},active=null,activeKind=null,activePriority=0,reactionCtx=null;
    const cycles=new Map();
    let activeInfo=null,lastStart=-Infinity,lastEnd=-Infinity;
    let idleStarts=[];
    const retiring=new Set();
    const kinds=['hmm','laugh','exhale','questioning','surprised','thinking','giggle','sympathetic','yawn','contented',
      'kiss','lipsmack','wet_mouth','gulp','humming','slap','pleasure','moan','whimper','purr','clink','pop','pounce','dizzy','cupid',
      'ack','typing_backchannel','celebrate','mock_scandal','booty_breath',
      'treat_coffee','treat_strawberry','treat_rose','treat_champagne'];
    const phaseKinds=['deepthroat','cum_begging','climax_fever','phase7_size_worship','phase9_breast_vivid','pull_surrender',
      'phase8_rear_grind','booty_arch','whisper_ear','morning_wood','afterglow_cooldown','tease_deny'];
    const reactionUrl=/^\/assets\/companion\/chat\/reactions\/(?:elevenlabs_[0-9]+\/)?[a-z0-9_-]+\.[0-9a-f]{8}\.ogg$/;
    const validSample=(sample,maxDuration)=>sample&&
      reactionUrl.test(String(sample.url||''))&&
      Number.isFinite(sample.duration_ms)&&sample.duration_ms>=150&&sample.duration_ms<=maxDuration;
    const pool=(sample,maxDuration)=>(Array.isArray(sample)?sample:[sample]).filter(item=>validSample(item,maxDuration));
    const pick=(group,key)=>{
      const samples=group[key];if(!samples?.length)return null;
      const id=(group===phases?'phase:':'reaction:')+samples.map(sample=>sample.url).join('|');
      if(!cycles.has(id))cycles.set(id,{});
      return pickVariant(samples,cycles.get(id),random);
    };
    const lastPitch=new Map();
    const finish=info=>{
      if(!info||info.finished)return;
      info.finished=true;
      for(const timer of info.timers||[])win.clearTimeout?.(timer);
      retiring.delete(info);
      for(const node of info.nodes||[])try{node.disconnect();}catch(_){}
      if(info.source){info.source.onended=null;try{info.source.stop();}catch(_){}}
      if(info.audio){
        info.audio.onended=info.audio.onerror=null;
        try{info.audio.pause();info.audio.currentTime=0;}catch(_){}
        try{if(info.audio.removeAttribute){info.audio.removeAttribute('src');info.audio.load?.();}}catch(_){}
      }
    };
    const stop=(kind,immediate=false)=>{
      if(!enabled()||win.document.hidden)immediate=true;
      if(immediate)for(const info of [...retiring])finish(info);
      if(kind&&kind!==activeKind)return;
      const info=activeInfo||(active?{audio:active}:null);
      if(info)lastEnd=Date.now();
      active=null;activeInfo=null;activeKind=null;
      if(!info)return;
      if(immediate||!context().smoothStops||!win.setTimeout){finish(info);return;}
      info.timers=[];retiring.add(info);
      if(info.gain){
        const now=info.ctx.currentTime,param=info.gain.gain;
        param.cancelScheduledValues(now);param.setValueAtTime(param.value,now);
        param.linearRampToValueAtTime(0,now+.08);
      }else if(info.audio){
        const volume=info.audio.volume;
        for(let i=1;i<4;i++)info.timers.push(win.setTimeout(()=>{info.audio.volume=volume*(1-i/4);},i*20));
      }
      info.timers.push(win.setTimeout(()=>finish(info),80));
    };
    const ensureReactionCtx=()=>{
      if(reactionCtx)return reactionCtx;
      const shared=context().audioContext;
      if(shared){reactionCtx=shared;return reactionCtx;}
      const AC=win.AudioContext||win.webkitAudioContext;
      if(!AC)return null;
      reactionCtx=new AC();
      return reactionCtx;
    };
    let slapImpacts=[];
    let impactPools={};
    let hotPrefetchUrls=[];
    let backgroundPrefetchUrls=[];
    let gainDb={idle:-6,voice:0,phase:-1.5,impact:3.5};
    const phaseUrls=new Set();
    const warmed=new Map();
    const connectVoiceOut=(ctx,gainNode)=>{
      const hook=context().connectVoiceOut;
      if(typeof hook==='function'){hook(gainNode,ctx);return;}
      const bus=context().sfxBus;
      if(bus?.connectVoice){bus.connectVoice(gainNode);return;}
      gainNode.connect(ctx.destination);
    };
    const validImpact=(sample,maxDuration)=>sample&&
      reactionUrl.test(String(sample.url||''))&&
      Number.isFinite(sample.duration_ms)&&sample.duration_ms>=150&&sample.duration_ms<=maxDuration;
    const impactPool=(sample,maxDuration)=>(Array.isArray(sample)?sample:[sample]).filter(item=>validImpact(item,maxDuration));
    const dbToGain=db=>10**((Number(db)||0)/20);
    const levelFor=(kind,priority,isPhase)=>{
      if(isPhase)return dbToGain(gainDb.phase);
      if(priority<=0)return dbToGain(gainDb.idle)* (context().mediaPlaying===false?10**(-4/20):1);
      return dbToGain(gainDb.voice);
    };
    // Decoded-buffer LRU + bounded fetch/decode concurrency. `warmed` keeps insertion order = recency; in-flight
    // promises are never evicted, and a buffer being played stays alive through its own source node.
    const MAX_DECODED=48,MAX_JOBS=3;
    let runningJobs=0;const jobQueue=[];
    const pumpJobs=()=>{
      while(runningJobs<MAX_JOBS&&jobQueue.length){
        const run=jobQueue.shift();runningJobs++;
        run().finally(()=>{runningJobs--;pumpJobs();});
      }
    };
    const enqueueJob=(fn)=>new Promise((resolve)=>{jobQueue.push(()=>fn().then(resolve,()=>resolve(null)));pumpJobs();});
    const touchBuffer=(url,buf)=>{warmed.delete(url);warmed.set(url,buf);};
    const trimDecoded=()=>{
      let decoded=0;for(const v of warmed.values())if(typeof v?.then!=='function')decoded++;
      if(decoded<=MAX_DECODED)return;
      for(const [k,v] of warmed){
        if(decoded<=MAX_DECODED)break;
        if(typeof v?.then==='function')continue;
        warmed.delete(k);decoded--;
      }
    };
    const sampleBuffer=(url)=>{
      const hit=warmed.get(url);
      if(!hit||typeof hit.then==='function')return null;
      touchBuffer(url,hit);
      return hit;
    };
    const warmSample=(win,url)=>{
      if(!url)return Promise.resolve(null);
      const hit=warmed.get(url);
      if(hit){
        if(typeof hit.then==='function')return hit;
        touchBuffer(url,hit);
        return Promise.resolve(hit);
      }
      const ctx=ensureReactionCtx();
      if(!ctx)return Promise.resolve(null);
      if(ctx.state==='suspended')ctx.resume().catch(()=>{});
      const job=enqueueJob(()=>win.fetch(url).then(r=>r.ok?r.arrayBuffer():Promise.reject()).then(ab=>ctx.decodeAudioData(ab))).then(buf=>{
        if(!buf){warmed.delete(url);return null;}
        touchBuffer(url,buf);trimDecoded();
        return buf;
      });
      warmed.set(url,job);
      return job;
    };
    const warmSamples=(win,urls)=>Promise.all((urls||[]).filter(Boolean).map(url=>warmSample(win,url)));
    const manifestUrl='/assets/companion/chat/reactions/manifest.runtime.json?v='+encodeURIComponent(MANIFEST_REVISION);
    const loadManifest=()=>win.fetch(manifestUrl).then(r=>r.ok?r.json():null).catch(()=>null);
    const ready=loadManifest().then(manifest=>{
      if(manifest)return manifest;
      return win.fetch('/assets/companion/chat/reactions/manifest.json?v='+encodeURIComponent(MANIFEST_REVISION))
        .then(r=>r.ok?r.json():null);
    }).then(manifest=>{
        const idleDb=Number(manifest?.mastering?.idle_playback_gain_db);
        if(Number.isFinite(idleDb)&&idleDb>=-18&&idleDb<=0)gainDb.idle=idleDb;
        const voiceDb=Number(manifest?.mastering?.voice_playback_gain_db);
        if(Number.isFinite(voiceDb)&&voiceDb>=-12&&voiceDb<=6)gainDb.voice=voiceDb;
        const phaseDb=Number(manifest?.mastering?.phase_playback_gain_db);
        if(Number.isFinite(phaseDb)&&phaseDb>=-12&&phaseDb<=6)gainDb.phase=phaseDb;
        const impactDb=Number(manifest?.mastering?.impact_playback_gain_db);
        if(Number.isFinite(impactDb)&&impactDb>=-12&&impactDb<=12)gainDb.impact=impactDb;
        for(const [kind,sample] of Object.entries(manifest?.samples||{})){
          if(!kinds.includes(kind))continue;
          const samples=pool(sample,6000);if(samples.length)bank[kind]=samples;
        }
        for(const [kind,sample] of Object.entries(manifest?.phases||{})){
          if(!phaseKinds.includes(kind))continue;
          const samples=pool(sample,12000);if(samples.length)phases[kind]=samples;
          for(const item of samples)if(item?.url)phaseUrls.add(item.url);
        }
        slapImpacts=impactPool(manifest?.impacts?.slap,6000).map(item=>item.url);
        impactPools=manifest?.impacts||{};
        const warmKinds=(scene=>{
          const nsfw=!!scene?.nsfwOn;
          return nsfw
            ?['kiss','moan','lipsmack','wet_mouth','gulp','giggle','whimper','hmm','surprised','pleasure']
            :['hmm','giggle','exhale','yawn','surprised','humming','contented','questioning'];
        })({nsfwOn:false});
        const buildUrls=(kinds,take)=>kinds.flatMap(kind=>{
          const entry=bank[kind];if(!entry)return [];
          const list=Array.isArray(entry)?entry:[entry];
          return list.slice(0,take).map(item=>item?.url).filter(Boolean);
        });
        hotPrefetchUrls=[...slapImpacts.slice(0,2),...buildUrls(warmKinds,1)];
        backgroundPrefetchUrls=buildUrls(warmKinds,HOT_PREFETCH_PER_KIND);
        return Object.keys(bank).length>0;
      }).catch(()=>false);
    const warmPriorityUrls=(scene={})=>{
      const nsfw=!!scene.nsfwOn;
      const kinds=nsfw
        ?['kiss','moan','lipsmack','wet_mouth','gulp','giggle','whimper','pleasure']
        :['hmm','giggle','exhale','yawn','surprised'];
      const fromKinds=(take)=>kinds.flatMap(kind=>{
        const entry=bank[kind];if(!entry)return [];
        const list=Array.isArray(entry)?entry:[entry];
        return list.slice(0,take).map(item=>item?.url).filter(Boolean);
      });
      const hot=[...(nsfw?slapImpacts.slice(0,2):[]),...fromKinds(1)];
      const background=fromKinds(HOT_PREFETCH_PER_KIND);
      return {hot,background};
    };
    const idleGain=()=>dbToGain(gainDb.idle);
    const pleasureGruntUrls=()=>(bank.pleasure||[]).map(item=>item.url).filter(Boolean);
    const playDecoded=(ctx,sample,info,kind,priority,volume,rate,ended)=>{
      const buf=sampleBuffer(sample.url);
      if(!buf)return false;
      const now=ctx.currentTime;
      const src=ctx.createBufferSource();
      src.buffer=buf;
      src.playbackRate.value=rate;
      info.nodes.push(src);
      const tone=ctx.createBiquadFilter();
      info.nodes.push(tone);
      tone.type='lowpass';
      tone.frequency.setValueAtTime(12000,now);
      tone.Q.setValueAtTime(0.55,now);
      const gainNode=ctx.createGain();
      info.nodes.push(gainNode);
      gainNode.gain.setValueAtTime(0.001,now);
      gainNode.gain.linearRampToValueAtTime(volume,now+0.015);
      src.connect(tone);
      tone.connect(gainNode);
      connectVoiceOut(ctx,gainNode);
      const tail=buf.duration/rate;
      src.onended=ended;
      src.start(now);
      src.stop(now+tail);
      Object.assign(info,{gain:gainNode,ctx,source:src,audio:null});
      active=info;
      activeKind=kind;
      activePriority=priority;
      activeInfo=info;
      return Math.round(tail*1000);
    };
    const impactUrls=key=>impactPool(impactPools[key],6000).map(item=>item.url);
    const sampleUrls=(kind,limit=2)=>{
      const entry=bank[kind];if(!entry)return [];
      const list=Array.isArray(entry)?entry:[entry];
      return list.slice(0,Math.max(1,limit)).map(item=>item?.url).filter(Boolean);
    };
    return {ready,slapImpactUrls:()=>slapImpacts.slice(),impactUrls,hasImpact:key=>impactUrls(key).length>0,hotPrefetchUrls:()=>hotPrefetchUrls.slice(),
      backgroundPrefetchUrls:()=>backgroundPrefetchUrls.slice(),warmPriorityUrls,impactGainDb:()=>gainDb.impact,
      phaseGainDb:()=>gainDb.phase,voiceGainDb:()=>gainDb.voice,
      sampleUrls,
      playbackGainDbForUrl:url=>phaseUrls.has(String(url||''))?gainDb.phase:gainDb.voice,
      pleasureGruntUrls,
      getDecodedBuffer:url=>sampleBuffer(url),
      ensureDecodedBuffer:url=>warmSample(win,url).then(()=>sampleBuffer(url)),
      warmSample:(url)=>warmSample(win,url),
      warmSamples:(urls)=>warmSamples(win,urls),stop,isPlaying:()=>!!active,has:kind=>!!bank[kind]?.length,pickReaction:kind=>pick(bank,kind),pickPhase:kind=>pick(phases,kind),start(kind,options={}){
      if(!enabled()||win.document.hidden){stop();return 0;}
      const priority=Number(options.priority)||0;
      const scene=context(),now=Date.now();
      idleStarts=idleStarts.filter(time=>now-time<60000);
      if(scene.paceReactions&&priority<=0&&(scene.typing||scene.busy||now-lastStart<10000||now-lastEnd<6000||idleStarts.length>=3))return 0;
      if(scene.paceReactions&&priority>0&&now-lastStart<450&&activePriority>=priority)return 0;
      const volume=.25*levelFor(kind,priority,false);
      if(active&&options.interrupt===false&&priority<=activePriority)return 0;
      stop();
      const sample=pick(bank,kind);if(!sample)return 0;
      const ctx=ensureReactionCtx();
      if(sample.natural&&ctx){
        if(ctx.state==='suspended')ctx.resume().catch(()=>{});
        const info={audio:null,nodes:[]};
        const ended=()=>{
          if(active===info||active?.source){active=null;activeInfo=null;lastEnd=Date.now();}
          finish(info);
        };
        lastStart=now;
        if(scene.paceReactions&&priority<=0)idleStarts.push(now);
        const ms=playDecoded(ctx,sample,info,kind,priority,volume,1,ended);
        if(ms>0)return ms;
      }
      const audio=new win.Audio(sample.url);
      audio.crossOrigin='anonymous';
      active=audio;
      activeKind=kind;
      activePriority=priority;
      const info={audio,nodes:[]};activeInfo=info;lastStart=now;
      if(scene.paceReactions&&priority<=0)idleStarts.push(now);
      audio.preload='auto';
      // A fixed pitch per playback avoids warbling; +/-45 cents keeps the voice familiar.
      let semitones=(random()*2-1)*.45;
      const previous=lastPitch.get(kind);
      if(previous!==undefined&&Math.abs(semitones-previous)<.12)semitones=previous<=0?.3:-.3;
      lastPitch.set(kind,semitones);
      const rate=sample.natural?1:2**(semitones/12);
      audio.preservesPitch=!!sample.natural;
      if('webkitPreservesPitch' in audio)audio.webkitPreservesPitch=!!sample.natural;
      if('mozPreservesPitch' in audio)audio.mozPreservesPitch=!!sample.natural;
      audio.playbackRate=rate;
      const ended=()=>{
        if(active===audio){active=null;activeInfo=null;lastEnd=Date.now();}
        finish(info);
      };
      audio.onended=ended;
      audio.onerror=ended;
      let gainNode=null;
      if(ctx){
        if(ctx.state==='suspended')ctx.resume().catch(()=>{});
        try{
          const t=ctx.currentTime;
          const tone=ctx.createBiquadFilter();
          info.nodes.push(tone);
          tone.type='lowpass';
          tone.frequency.setValueAtTime(sample.natural?12000:2100+random()*350,t);
          tone.Q.setValueAtTime(0.55,t);
          const src=ctx.createMediaElementSource(audio);
          info.nodes.push(src);
          gainNode=ctx.createGain();
          info.nodes.push(gainNode);
          gainNode.gain.setValueAtTime(0.001,t);
          gainNode.gain.linearRampToValueAtTime(volume,t+0.015);
          src.connect(tone);
          tone.connect(gainNode);
          connectVoiceOut(ctx,gainNode);
        }catch(_){gainNode=null;}
      }
      if(!gainNode)audio.volume=volume;
      Object.assign(info,{gain:gainNode,ctx});
      const tryPlay=()=>{try{const playing=audio.play();if(playing?.catch)playing.catch(ended);}catch(_){ended();}};
      if(audio.readyState>=2)tryPlay();
      else if(typeof audio.addEventListener==='function')audio.addEventListener('canplay',tryPlay,{once:true});
      else tryPlay();
      return sample.duration_ms/rate;
    }};
  }
  return {create,pickVariant};
});
