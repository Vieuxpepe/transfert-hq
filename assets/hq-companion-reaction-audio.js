/* Local, pre-generated reaction WAVs. No synthesis credentials in the browser. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HqCompanionReactionAudio=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
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
    let bank={},phases={},active=null,activeKind=null,activePriority=0,reactionCtx=null,idleGain=0.501187;
    const cycles=new Map();
    let activeInfo=null,lastStart=-Infinity,lastEnd=-Infinity;
    let idleStarts=[];
    const retiring=new Set();
    const kinds=['hmm','laugh','exhale','questioning','surprised','thinking','giggle','sympathetic','yawn','contented',
      'kiss','lipsmack','humming','slap','pleasure','moan','whimper'];
    const phaseKinds=['deepthroat','cum_begging','climax_fever','phase7_size_worship','phase9_breast_vivid','pull_surrender'];
    const validSample=(sample,maxDuration)=>sample&&
      /^\/assets\/companion\/chat\/reactions\/(?:elevenlabs_20261103\/)?[a-z0-9_-]+\.wav$/.test(String(sample.url||''))&&
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
      info.audio.onended=info.audio.onerror=null;
      try{info.audio.pause();info.audio.currentTime=0;}catch(_){}
      try{if(info.audio.removeAttribute){info.audio.removeAttribute('src');info.audio.load?.();}}catch(_){}
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
      }else{
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
    const ready=win.fetch('/assets/companion/chat/reactions/manifest.json',{cache:'no-cache'})
      .then(response=>response.ok?response.json():null).then(manifest=>{
        const idleDb=Number(manifest?.mastering?.idle_playback_gain_db);
        if(Number.isFinite(idleDb)&&idleDb>=-18&&idleDb<=0)idleGain=10**(idleDb/20);
        for(const [kind,sample] of Object.entries(manifest?.samples||{})){
          if(!kinds.includes(kind))continue;
          const samples=pool(sample,6000);if(samples.length)bank[kind]=samples;
        }
        for(const [kind,sample] of Object.entries(manifest?.phases||{})){
          if(!phaseKinds.includes(kind))continue;
          const samples=pool(sample,12000);if(samples.length)phases[kind]=samples;
        }
        return Object.keys(bank).length>0;
      }).catch(()=>false);
    return {ready,stop,isPlaying:()=>!!active,has:kind=>!!bank[kind]?.length,pickReaction:kind=>pick(bank,kind),pickPhase:kind=>pick(phases,kind),start(kind,options={}){
      if(!enabled()||win.document.hidden){stop();return 0;}
      const priority=Number(options.priority)||0;
      const scene=context(),now=Date.now();
      idleStarts=idleStarts.filter(time=>now-time<60000);
      if(scene.paceReactions&&priority<=0&&(scene.typing||scene.busy||now-lastStart<10000||now-lastEnd<6000||idleStarts.length>=3))return 0;
      if(scene.paceReactions&&priority>0&&now-lastStart<450&&activePriority>=priority)return 0;
      const volume=.25*(priority<=0?idleGain*(scene.mediaPlaying===false?10**(-4/20):1):1);
      if(active&&options.interrupt===false&&priority<=activePriority)return 0;
      stop();
      const sample=pick(bank,kind);if(!sample)return 0;
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
      const ctx=ensureReactionCtx();
      let gainNode=null;
      if(ctx){
        if(ctx.state==='suspended')ctx.resume().catch(()=>{});
        try{
          const now=ctx.currentTime;
          const tone=ctx.createBiquadFilter();
          info.nodes.push(tone);
          tone.type='lowpass';
          tone.frequency.setValueAtTime(sample.natural?12000:2100+random()*350,now);
          tone.Q.setValueAtTime(0.55,now);
          const src=ctx.createMediaElementSource(audio);
          info.nodes.push(src);
          gainNode=ctx.createGain();
          info.nodes.push(gainNode);
          gainNode.gain.setValueAtTime(0.001,now);
          gainNode.gain.linearRampToValueAtTime(volume,now+0.018);
          src.connect(tone);
          tone.connect(gainNode);
          gainNode.connect(ctx.destination);
        }catch(_){gainNode=null;}
      }
      if(!gainNode)audio.volume=volume;
      Object.assign(info,{gain:gainNode,ctx});
      try{const playing=audio.play();if(playing?.catch)playing.catch(ended);}
      catch(_){ended();return 0;}
      return sample.duration_ms/rate;
    }};
  }
  return {create,pickVariant};
});
