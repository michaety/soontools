// ==UserScript==
// @name         Soon Tools — Clip
// @namespace    https://fishtank.news
// @version      0.1.1
// @description  Snipping tool style video recorder for fishtank.live — fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      cdn.fishtank.live
// @run-at       document-end
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-clipper.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-clipper.user.js
// ==/UserScript==

(function () {
  'use strict';

  window.SOON = window.SOON || {};

  const MAX_RECORD_SEC = 300;

  let frameMode     = false;
  let pendingAction = null;
  let cropRegion    = null;
  let dragStart     = null;
  let recorder      = null;
  let recChunks     = [];
  let recTimer      = null;
  let recSeconds    = 0;
  let recStartTime  = null;
  let recording     = false;
  let mainVideoEl   = null;

  // Page-level WebAudio context and source cache
  // Must persist across recordings — browser only allows one MediaElementSource per element ever
  let sharedAudioCtx = null;
  const sharedAudioSources = new WeakMap(); // element → MediaElementSourceNode
  const clips       = [];
  const screenshots = [];
  const UI          = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // ── VIDEO HELPER ───────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function getVideoEl() {
    if (mainVideoEl && document.contains(mainVideoEl) &&
        mainVideoEl.id !== 'sc-hidden-vid' &&
        !mainVideoEl.paused && mainVideoEl.readyState >= 2) {
      return mainVideoEl;
    }
    let best = null, bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.id === 'sc-hidden-vid') continue;
      if (v.closest('#sc-root')) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 50) continue;
      const score = r.width * r.height * (v.paused ? 0.5 : 1);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    mainVideoEl = best;
    return best;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FRAME MODE ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function enterFrameMode() {
    const vid = getVideoEl();
    if (!vid) { showStatus('No video found', 'err'); return; }
    frameMode = true; cropRegion = null; dragStart = null;
    const wasPaused = vid.paused;

    function getVidRect() {
      const el = vid.getBoundingClientRect();
      const vw = vid.videoWidth||1920, vh = vid.videoHeight||1080;
      const scale = Math.min(el.width/vw, el.height/vh);
      const rw = vw*scale, rh = vh*scale;
      const ox = (el.width-rw)/2, oy = (el.height-rh)/2;
      return { left:el.left+ox, top:el.top+oy, right:el.left+ox+rw, bottom:el.top+oy+rh, width:rw, height:rh };
    }

    const canvas = document.createElement('canvas');
    canvas.id = 'sc-crop-canvas';
    canvas.style.cssText = 'position:fixed;z-index:2147483647;cursor:crosshair;pointer-events:auto;box-sizing:border-box;';
    document.documentElement.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let drag = null, dashOffset = 0;

    function updateCanvas() {
      if (!document.getElementById('sc-crop-canvas')) return;
      const r = getVidRect();
      canvas.style.left = r.left+'px'; canvas.style.top = r.top+'px';
      canvas.width = Math.round(r.width); canvas.height = Math.round(r.height);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      if (drag && dragStart) {
        const x=Math.min(drag.x,dragStart.cx), y=Math.min(drag.y,dragStart.cy);
        const w=Math.abs(drag.x-dragStart.cx), h=Math.abs(drag.y-dragStart.cy);
        ctx.clearRect(x,y,w,h);
        ctx.shadowColor='#df4e1e'; ctx.shadowBlur=12; ctx.strokeStyle='#df4e1e'; ctx.lineWidth=2; ctx.setLineDash([]);
        ctx.strokeRect(x,y,w,h); ctx.shadowBlur=0;
        ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=1; ctx.setLineDash([6,4]);
        ctx.lineDashOffset=-dashOffset; ctx.strokeRect(x+0.5,y+0.5,w-1,h-1); ctx.setLineDash([]);
        dashOffset=(dashOffset+0.5)%10;
      } else {
        ctx.shadowColor='#df4e1e'; ctx.shadowBlur=8; ctx.strokeStyle='#df4e1e'; ctx.lineWidth=2; ctx.setLineDash([6,4]);
        ctx.strokeRect(1,1,canvas.width-2,canvas.height-2); ctx.setLineDash([]); ctx.shadowBlur=0;
      }
      requestAnimationFrame(updateCanvas);
    }
    updateCanvas();

    const hint = document.createElement('div');
    hint.id = 'sc-hint';
    hint.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);color:white;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;pointer-events:none;background:rgba(0,0,0,0.75);padding:6px 14px;border-radius:4px;z-index:2147483647;white-space:nowrap;border:1px solid rgba(223,78,30,0.5);';
    hint.textContent = `Drag to frame ${pendingAction==='screenshot'?'screenshot':'record'} • Esc to cancel`;
    document.documentElement.appendChild(hint);
    updateRecordBtn(true, false);
    showStatus('Drag over the video to select region', 'ok');

    function onDown(e) {
      e.preventDefault(); e.stopPropagation();
      hint.style.display='none';
      const r=canvas.getBoundingClientRect();
      dragStart={screenX:e.clientX,screenY:e.clientY,cx:e.clientX-r.left,cy:e.clientY-r.top};
      drag={x:dragStart.cx,y:dragStart.cy};
    }
    function onMove(e) {
      e.preventDefault(); e.stopPropagation();
      if (!dragStart) return;
      const r=canvas.getBoundingClientRect();
      drag={x:e.clientX-r.left,y:e.clientY-r.top};
    }
    function onUp(e) {
      e.preventDefault(); e.stopPropagation();
      if (!dragStart) { cancelFrameMode(); return; }
      const sw=Math.abs(e.clientX-dragStart.screenX), sh=Math.abs(e.clientY-dragStart.screenY);
      if (sw<15||sh<15) {
        cancelFrameMode();
        if (!recording&&!wasPaused) vid.play().catch(()=>{});
        showStatus('Too small — drag a region to crop','err'); return;
      }
      const vidRect=getVidRect();
      const sx=Math.min(e.clientX,dragStart.screenX), sy=Math.min(e.clientY,dragStart.screenY);
      const cx=Math.max(vidRect.left,sx), cy=Math.max(vidRect.top,sy);
      const cx2=Math.min(vidRect.right,sx+sw), cy2=Math.min(vidRect.bottom,sy+sh);
      cropRegion={x:(cx-vidRect.left)/vidRect.width,y:(cy-vidRect.top)/vidRect.height,w:(cx2-cx)/vidRect.width,h:(cy2-cy)/vidRect.height};
      exitFrameMode();
      if (!recording&&!wasPaused) vid.play().catch(()=>{});
      const action=pendingAction; pendingAction=null;
      if (action==='screenshot') {
        const region = cropRegion;
        cropRegion = null; // clear immediately — don't let it affect recording
        takeScreenshot(region);
      } else {
        startRecording();
      }
    }
    canvas.addEventListener('mousedown',onDown,{capture:true});
    canvas.addEventListener('mousemove',onMove,{capture:true});
    canvas.addEventListener('mouseup',  onUp,  {capture:true});
  }

  function exitFrameMode() {
    frameMode=false;
    document.getElementById('sc-crop-canvas')?.remove();
    document.getElementById('sc-hint')?.remove();
  }

  function cancelFrameMode() {
    exitFrameMode(); pendingAction=null;
    updateRecordBtn(false,false); showStatus('Cancelled','');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── RECORDING ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  async function startRecording() {
    const vid = getVideoEl();
    if (!vid) { showStatus('No video found','err'); return; }

    // Use shared AudioContext — must persist across recordings
    // Browser suspends AudioContext without user gesture, resume on record click
    if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
    if (sharedAudioCtx.state === 'suspended') await sharedAudioCtx.resume().catch(() => {});

    // Pre-load transition sound
    let transitionSoundBuffer = null;
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://cdn.fishtank.live/sounds/chunk-short.mp3',
      responseType: 'arraybuffer',
      onload: r => {
        sharedAudioCtx.decodeAudioData(r.response)
          .then(decoded => { transitionSoundBuffer = decoded; })
          .catch(() => {});
      }
    });

    const logoImg = new Image();
    let logoReady = false;
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://cdn.fishtank.live/images/logo/logo-stripe.png',
      responseType: 'blob',
      onload: r => {
        logoImg.onload = () => { logoReady = true; };
        logoImg.src = URL.createObjectURL(r.response);
      }
    });

    const canvas = document.createElement('canvas');
    canvas.width  = vid.videoWidth||1920;
    canvas.height = vid.videoHeight||1080;
    const ctx = canvas.getContext('2d');

    // drawFrame tracks its own copy for rendering
    let lastVid = vid, staticFrames = 0;

    function playTransitionSound() {
      if (!transitionSoundBuffer || !sharedAudioCtx) return;
      try {
        const src = sharedAudioCtx.createBufferSource();
        src.buffer = transitionSoundBuffer;
        src.connect(sharedAudioCtx.destination);
        src.start();
      } catch(e) {}
    }

    function drawStatic(w, h) {
      const sw=80, sh=45;
      const imageData=ctx.createImageData(sw,sh);
      const data=imageData.data;
      for (let i=0; i<data.length; i+=4) {
        const v=Math.random()*180|0;
        data[i]=v; data[i+1]=v; data[i+2]=v; data[i+3]=255;
      }
      const tmp=document.createElement('canvas');
      tmp.width=sw; tmp.height=sh;
      tmp.getContext('2d').putImageData(imageData,0,0);
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(tmp,0,0,w,h);
      ctx.imageSmoothingEnabled=true;
      if (logoReady && logoImg.naturalWidth>0) {
        const logoW=Math.min(w*0.85,600);
        const logoH=logoW*(logoImg.naturalHeight/logoImg.naturalWidth);
        ctx.globalAlpha=0.9;
        ctx.drawImage(logoImg,(w-logoW)/2,(h-logoH)/2,logoW,logoH);
        ctx.globalAlpha=1;
      } else {
        ctx.fillStyle='rgba(0,0,0,0.55)';
        ctx.fillRect(w/2-90,h/2-20,180,40);
        ctx.fillStyle='white'; ctx.font='bold 15px sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText('switching cam...',w/2,h/2);
      }
    }

    function drawFrame() {
      if (!recording) return;
      const currentVid = getVideoEl();
      if (!currentVid||currentVid.readyState<2) {
        drawStatic(canvas.width,canvas.height);
        requestAnimationFrame(drawFrame); return;
      }
      // Detect cam switch in drawFrame too — keeps lastVid in sync
      if (currentVid!==lastVid) {
        staticFrames=12;
        lastVid=currentVid;
        playTransitionSound();
      }
      if (staticFrames>0) {
        drawStatic(canvas.width,canvas.height);
        staticFrames--;
        requestAnimationFrame(drawFrame); return;
      }
      if (cropRegion) {
        const vw=currentVid.videoWidth||1920, vh=currentVid.videoHeight||1080;
        const cw=Math.round(cropRegion.w*vw), ch=Math.round(cropRegion.h*vh);
        if (canvas.width!==cw||canvas.height!==ch) { canvas.width=cw; canvas.height=ch; }
        ctx.drawImage(currentVid,cropRegion.x*vw,cropRegion.y*vh,cropRegion.w*vw,cropRegion.h*vh,0,0,cw,ch);
      } else {
        const vw=currentVid.videoWidth||1920, vh=currentVid.videoHeight||1080;
        if (canvas.width!==vw||canvas.height!==vh) { canvas.width=vw; canvas.height=vh; }
        ctx.drawImage(currentVid,0,0,vw,vh);
      }
      requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);

    const canvasStream = canvas.captureStream(30);

    function connectAudio(v) {
      try {
        // Get or create the MediaElementSource for this element
        // Browser only allows one per element ever — must reuse
        let node = sharedAudioSources.get(v);
        if (!node) {
          node = sharedAudioCtx.createMediaElementSource(v);
          sharedAudioSources.set(v, node);
        }
        // Create a new destination for this recording session
        const dst = sharedAudioCtx.createMediaStreamDestination();
        node.connect(dst);
        node.connect(sharedAudioCtx.destination); // keep playing to speakers
        // Replace audio tracks on the canvas stream
        canvasStream.getAudioTracks().forEach(t => { canvasStream.removeTrack(t); t.stop(); });
        dst.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
        console.log('[SOON CLIP] Audio connected via WebAudio');
      } catch(e) {
        console.warn('[SOON CLIP] Audio connect failed:', e.message);
      }
    }
    connectAudio(vid);

    let streamGoneFrames = 0;
    const STREAM_GONE_THRESHOLD = 17;
    // Track src not element — Fishtank reuses the same video element, just changes src
    let watcherLastSrc = vid.currentSrc || vid.src;

    const camWatcher = setInterval(() => {
      if (!recording) { clearInterval(camWatcher); return; }
      const currentVid = getVideoEl();
      if (!currentVid || currentVid.readyState === 0 || (currentVid.paused && currentVid.readyState < 2)) {
        streamGoneFrames++;
        if (streamGoneFrames >= STREAM_GONE_THRESHOLD) {
          console.log('[SOON CLIP] Stream closed — stopping');
          clearInterval(camWatcher); stopRecording();
        }
        return;
      }
      streamGoneFrames = 0;

      const currentSrc = currentVid.currentSrc || currentVid.src;
      if (currentSrc && currentSrc !== watcherLastSrc) {
        watcherLastSrc = currentSrc;
        console.log('[SOON CLIP] Cam src changed — splitting clip');
        const was = recording;
        stopRecording();
        if (was) setTimeout(() => { if (!recording) startRecording(); }, 800);
      }
    }, 300);

    if (cropRegion) showRecordingCropOverlay(vid,cropRegion);

    const mimeType=getSupportedMimeType();
    recChunks=[];
    recorder=new MediaRecorder(canvasStream,{mimeType,videoBitsPerSecond:8_000_000,audioBitsPerSecond:128_000});
    recorder.ondataavailable=e=>{if(e.data.size>0)recChunks.push(e.data);};
    recorder.onstop=()=>{
      clearInterval(camWatcher);
      const v=getVideoEl(); if(v)v.style.outline='';
      if (recording) {
        clearInterval(recTimer); clearTimeout(recorder._autoStop);
        recording=false;
        if(UI.recIndicator)UI.recIndicator.style.display='none';
        updateRecordBtn(false,false);
        document.getElementById('sc-rec-crop-overlay')?.remove();
      }
      finaliseClip(mimeType);
    };

    recorder.start(500);
    recording=true; recSeconds=0; recStartTime=Date.now();

    const borderTimer=setInterval(()=>{
      const v=getVideoEl();
      if(!v||!recording){clearInterval(borderTimer);return;}
      v.style.outline=recSeconds%2===0?'3px solid #df4e1e':'3px solid #ff7043';
      v.style.outlineOffset='-3px';
    },1000);
    recorder._borderTimer=borderTimer;
    recorder._autoStop=setTimeout(()=>stopRecording(),MAX_RECORD_SEC*1000);

    recTimer=setInterval(()=>{
      recSeconds++;
      showStatus('⏺ '+formatDuration(recSeconds),'rec');
      if(UI.recIndicator){UI.recIndicator.textContent='⏺ '+formatDuration(recSeconds);UI.recIndicator.style.display='';}
      updateRecordBtn(false,true);
    },1000);

    updateRecordBtn(false,true);
    showStatus('Recording — press ⏹ to stop','rec');
  }

  function stopRecording() {
    if (!recorder||!recording) return;
    clearInterval(recTimer); clearTimeout(recorder._autoStop);
    recording=false;
    if(recorder.state==='recording'||recorder.state==='paused')recorder.stop();
    if(recorder._borderTimer)clearInterval(recorder._borderTimer);
    const vid=getVideoEl(); if(vid)vid.style.outline='';
    document.getElementById('sc-rec-crop-overlay')?.remove();
    if(UI.recIndicator)UI.recIndicator.style.display='none';
    updateRecordBtn(false,false);
    showStatus('Processing…','loading');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── WEBM DURATION FIX ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function fixWebmDuration(chunks,durationSec) {
    return new Promise(resolve=>{
      new Blob(chunks).arrayBuffer().then(buf=>{
        const data=new Uint8Array(buf), view=new DataView(buf);
        for(let i=0;i<data.length-12;i++){
          if(data[i]===0x44&&data[i+1]===0x89){
            const st=data[i+2];
            if(st===0x88){view.setFloat64(i+3,durationSec*1000,false);resolve(buf);return;}
            if(st===0x84){view.setFloat32(i+3,durationSec*1000,false);resolve(buf);return;}
          }
        }
        resolve(buf);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FINALISE CLIP ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function finaliseClip(mimeType) {
    const totalSize=recChunks.reduce((s,c)=>s+c.size,0);
    const durationSec=recStartTime?Math.max(1,Math.round((Date.now()-recStartTime)/1000)):Math.max(1,recSeconds);
    if(totalSize<1000||recChunks.length===0){showStatus('No data recorded — try again','err');return;}

    const isWebm=mimeType.includes('webm')||!mimeType.includes('mp4');
    const ext=isWebm?'webm':'mp4';
    const clipId=Date.now();
    const clip={id:clipId,blob:null,blobUrl:null,thumbUrl:null,duration:durationSec,trimIn:0,trimOut:durationSec,
      label:(window.SOON.activeRoom?.label||'Clip')+' — '+formatDuration(durationSec),
      filename:'soontools_'+clipId+'.'+ext,mimeType,processing:true};

    clips.unshift(clip);
    UI.clipsList?.querySelectorAll('.sc-card-body').forEach(b=>{
      if(b.style.display!=='none'){b.style.display='none';const t=b.previousElementSibling?.querySelector('.sc-card-toggle');if(t)t.textContent='+';}
    });
    renderQueue();
    showStatus('Clip captured — processing…','loading');

    let ps=0;
    const pt=setInterval(()=>{ps++;const el=document.querySelector(`[data-clip-id="${clipId}"] .sc-ph-status`);if(el)el.textContent='Processing… '+ps+'s';},1000);

    fixWebmDuration(recChunks,durationSec).then(fixedBuf=>{
      clearInterval(pt);
      const blob=new Blob([fixedBuf],{type:mimeType});
      clip.blob=blob; clip.blobUrl=URL.createObjectURL(blob); clip.processing=false; cropRegion=null;
      const existing=document.querySelector(`[data-clip-id="${clipId}"]`);
      const fullCard=buildClipCard(clip,true);
      if(existing)existing.replaceWith(fullCard);
      showStatus('Clip ready — '+formatDuration(durationSec),'ok');
      generateThumbnailAsync(blob,thumb=>{
        clip.thumbUrl=thumb;
        const img=document.querySelector(`[data-clip-thumb="${clipId}"]`);
        if(img){img.src=thumb;img.style.display='';}
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── THUMBNAIL ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function generateThumbnailAsync(blob,cb) {
    const url=URL.createObjectURL(blob);
    const v=document.createElement('video');
    v.src=url; v.muted=true; v.preload='metadata';
    v.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(v);
    v.addEventListener('loadeddata',()=>{v.currentTime=0.5;});
    v.addEventListener('seeked',()=>{
      try{
        const c=document.createElement('canvas'); c.width=120; c.height=68;
        const ctx=c.getContext('2d'); ctx.drawImage(v,0,0,120,68);
        const px=ctx.getImageData(40,20,40,28).data;
        let br=0; for(let i=0;i<px.length;i+=4)br+=px[i]+px[i+1]+px[i+2];
        const avg=br/(px.length/4*3);
        if(avg<5&&v.currentTime<v.duration-0.5){v.currentTime=Math.min(v.duration*0.3,v.currentTime+0.5);return;}
        cb(c.toDataURL('image/jpeg',0.7));
      }catch(e){}
      v.remove(); URL.revokeObjectURL(url);
    });
    v.addEventListener('error',()=>{v.remove();URL.revokeObjectURL(url);});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CROP OVERLAY (during recording) ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function showRecordingCropOverlay(vid,region) {
    document.getElementById('sc-rec-crop-overlay')?.remove();
    const canvas=document.createElement('canvas');
    canvas.id='sc-rec-crop-overlay';
    canvas.style.cssText='position:fixed;z-index:2147483646;pointer-events:none;';
    document.documentElement.appendChild(canvas);
    const ctx=canvas.getContext('2d'); let dashOffset=0;
    function draw() {
      if(!recording){canvas.remove();return;}
      const el=vid.getBoundingClientRect();
      const vw=vid.videoWidth||1920, vh=vid.videoHeight||1080;
      const scale=Math.min(el.width/vw,el.height/vh);
      const rw=vw*scale, rh=vh*scale, ox=(el.width-rw)/2, oy=(el.height-rh)/2;
      const cLeft=el.left+ox, cTop=el.top+oy;
      const rx=cLeft+region.x*rw, ry=cTop+region.y*rh, rw2=region.w*rw, rh2=region.h*rh;
      canvas.style.left=cLeft+'px'; canvas.style.top=cTop+'px';
      canvas.width=Math.round(rw); canvas.height=Math.round(rh);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      const cx=rx-cLeft, cy=ry-cTop;
      ctx.shadowColor='#df4e1e'; ctx.shadowBlur=10; ctx.strokeStyle='#df4e1e'; ctx.lineWidth=2; ctx.setLineDash([]);
      ctx.strokeRect(cx,cy,rw2,rh2); ctx.shadowBlur=0;
      ctx.strokeStyle='rgba(255,255,255,0.8)'; ctx.lineWidth=1; ctx.setLineDash([6,4]);
      ctx.lineDashOffset=-dashOffset; ctx.strokeRect(cx+0.5,cy+0.5,rw2-1,rh2-1); ctx.setLineDash([]);
      dashOffset=(dashOffset+0.4)%10;
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  }

  function getSupportedMimeType() {
    return ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']
      .find(t=>MediaRecorder.isTypeSupported(t))||'';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FFMPEG ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let ffmpegInstance=null, ffmpegLoading=false, ffmpegReady=false;
  let ffmpegBusy=false; // Mutex: only one command at a time

  function loadScript(src) {
    return new Promise((resolve,reject)=>{
      if(document.querySelector(`script[src="${src}"]`)){resolve();return;}
      const s=document.createElement('script');
      s.src=src; s.onload=resolve; s.onerror=reject;
      document.head.appendChild(s);
    });
  }

  async function getFFmpeg() {
    if(ffmpegReady)return ffmpegInstance;
    if(ffmpegLoading){await new Promise(res=>{const c=setInterval(()=>{if(ffmpegReady||!ffmpegLoading){clearInterval(c);res();}},100);});return ffmpegInstance;}
    ffmpegLoading=true; showStatus('Loading FFmpeg…','loading');
    try{
      await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
      const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
      const FFmpegLib=win.FFmpeg;
      if(!FFmpegLib?.createFFmpeg)throw new Error('FFmpeg global not found');
      ffmpegInstance=FFmpegLib.createFFmpeg({mainName:'main',log:false,corePath:'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'});
      await ffmpegInstance.load();
      ffmpegReady=true; ffmpegLoading=false; showStatus('FFmpeg ready','ok'); return ffmpegInstance;
    }catch(e){
      console.error('[SOON CLIP] FFmpeg load error:',e);
      showStatus('FFmpeg failed','err'); ffmpegLoading=false; return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── DOWNLOAD ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  async function downloadClip(clip) {
    const needsTrim=clip.trimIn>0.1||clip.trimOut<clip.duration-0.1;
    updateClipStatus(clip.id,'Converting to MP4…');
    let elapsed=0;
    const pt=setInterval(()=>{elapsed++;updateClipStatus(clip.id,'Converting… '+elapsed+'s');},1000);

    // Wait for FFmpeg to be free (mutex lock)
    while(ffmpegBusy) {
      await new Promise(res=>setTimeout(res,100));
    }
    ffmpegBusy=true;

    try{
      const ff=await getFFmpeg(); if(!ff)throw new Error('FFmpeg unavailable');
      const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
      const{fetchFile}=win.FFmpeg; if(!fetchFile)throw new Error('fetchFile not found');
      const inputData=await fetchFile(clip.blobUrl);
      ff.FS('writeFile','input.webm',inputData);
      const args=['-i','input.webm'];
      if(needsTrim)args.push('-ss',clip.trimIn.toFixed(3),'-to',clip.trimOut.toFixed(3));
      args.push('-c','copy','-movflags','+faststart','-y','output.mp4');
      await ff.run(...args);
      let outputData; try{outputData=ff.FS('readFile','output.mp4');}catch(e){throw new Error('output.mp4 not found');}
      if(!outputData||outputData.length<1000)throw new Error('Output too small');
      clearInterval(pt);
      triggerDownload(new Blob([outputData.buffer],{type:'video/mp4'}),clip.filename.replace(/\.\w+$/,'.mp4'));
      updateClipStatus(clip.id,'✓ Saved as MP4');
      try{ff.FS('unlink','input.webm');}catch{}
      try{ff.FS('unlink','output.mp4');}catch{}
    }catch(err){
      clearInterval(pt);
      console.warn('[SOON CLIP] FFmpeg failed:',err.message);
      updateClipStatus(clip.id,'MP4 failed — saving WebM');
      if(!needsTrim)triggerDownload(clip.blob,clip.filename);
      else trimAndDownloadWebm(clip);
    }finally{
      ffmpegBusy=false;
    }
  }

  function trimAndDownloadWebm(clip) {
    const vid=document.createElement('video');
    vid.src=clip.blobUrl; vid.muted=true;
    vid.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;';
    document.body.appendChild(vid);
    const mimeType=getSupportedMimeType(), chunks=[];
    vid.addEventListener('loadedmetadata',()=>{vid.currentTime=clip.trimIn;});
    vid.addEventListener('seeked',()=>{
      const stream=vid.captureStream?vid.captureStream():vid.mozCaptureStream();
      const rec=new MediaRecorder(stream,{mimeType});
      rec.ondataavailable=e=>{if(e.data.size>0)chunks.push(e.data);};
      rec.onstop=()=>{triggerDownload(new Blob(chunks,{type:mimeType}),clip.filename);updateClipStatus(clip.id,'✓ Saved (WebM)');vid.remove();};
      rec.start(); vid.play().catch(()=>{});
      const check=setInterval(()=>{if(vid.currentTime>=clip.trimOut){clearInterval(check);rec.stop();vid.pause();}},100);
      setTimeout(()=>{if(rec.state==='recording'){clearInterval(check);rec.stop();vid.pause();}},( clip.trimOut-clip.trimIn+3)*1000);
    });
  }

  function triggerDownload(blob,filename) {
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),15000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SCREENSHOT ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function takeScreenshot(region) {
    const vid=getVideoEl(); if(!vid){showStatus('No video found','err');return;}
    const canvas=document.createElement('canvas');
    const vw=vid.videoWidth||vid.clientWidth, vh=vid.videoHeight||vid.clientHeight;
    // Only use region if explicitly passed (crop screenshot) — never use cropRegion from recording
    if(region && region.w > 0 && region.h > 0){
      const sx=Math.round(region.x*vw),sy=Math.round(region.y*vh),sw=Math.round(region.w*vw),sh=Math.round(region.h*vh);
      canvas.width=sw; canvas.height=sh;
      canvas.getContext('2d').drawImage(vid,sx,sy,sw,sh,0,0,sw,sh);
    }else{
      canvas.width=vw; canvas.height=vh;
      canvas.getContext('2d').drawImage(vid,0,0,vw,vh);
    }
    canvas.toBlob(blob=>{
      const filename='soontools_screenshot_'+Date.now()+'.png';
      const dataUrl=canvas.toDataURL('image/jpeg',0.8);
      const blobUrl=URL.createObjectURL(blob);
      const ss={id:Date.now(),blob,blobUrl,dataUrl,filename,label:(window.SOON.activeRoom?.label||'Screenshot')+' — '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
      screenshots.unshift(ss);
      if(screenshots.length>5){const e=screenshots.pop();URL.revokeObjectURL(e.blobUrl);}
      renderQueue();
      triggerDownload(blob,filename);
      showStatus('Screenshot saved ✓','ok');
      vid.style.outline='3px solid #df4e1e';
      setTimeout(()=>{vid.style.outline='';},400);
    },'image/png');
  }

  function enterCropScreenshot(){pendingAction='screenshot';enterFrameMode();}

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SETTINGS ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function buildSettingsPanel() {
    const panel=document.createElement('div');
    panel.id='sc-settings';
    panel.style.cssText='display:none;position:absolute;right:0;top:100%;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border:1px solid rgba(0,0,0,0.2);border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9999;padding:10px;min-width:200px;';

    const title=document.createElement('div');
    title.style.cssText='font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.5;margin-bottom:8px;';
    title.textContent='Settings'; panel.appendChild(title);

    const sep=document.createElement('div'); sep.style.cssText='border-top:1px solid rgba(0,0,0,0.1);margin:8px 0 6px;'; panel.appendChild(sep);
    const kbTitle=document.createElement('div'); kbTitle.style.cssText='font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.4;margin-bottom:6px;'; kbTitle.textContent='Keyboard Shortcuts'; panel.appendChild(kbTitle);

    function makeShortcutRow(label,key){
      const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;';
      const lbl=document.createElement('span'); lbl.style.cssText='font-size:10px;color:rgba(0,0,0,0.65);flex:1;'; lbl.textContent=label;
      const btn=document.createElement('button'); btn.className='sc-toggle-btn'; btn.style.cssText='font-family:monospace;min-width:70px;';
      const getSaved=()=>localStorage.getItem(key)||'';
      btn.textContent=getSaved()||'None';
      let capturing=false;
      btn.addEventListener('click',e=>{e.stopPropagation();capturing=!capturing;btn.textContent=capturing?'Press…':(getSaved()||'None');btn.classList.toggle('sc-toggle-btn--on',capturing);});
      document.addEventListener('keydown',e=>{
        if(!capturing)return;
        if(['Control','Shift','Alt','Meta'].includes(e.key))return;
        e.preventDefault(); e.stopPropagation();
        const parts=[]; if(e.altKey)parts.push('Alt'); if(e.ctrlKey)parts.push('Ctrl'); if(e.shiftKey)parts.push('Shift');
        parts.push(e.key.length===1?e.key.toUpperCase():e.key);
        const combo=parts.join('+'); localStorage.setItem(key,combo);
        btn.textContent=combo||'None'; btn.classList.remove('sc-toggle-btn--on'); capturing=false;
      },{capture:true});
      row.appendChild(lbl); row.appendChild(btn); panel.appendChild(row);
    }
    makeShortcutRow('Record','sc_key_record');
    makeShortcutRow('Screenshot','sc_key_screenshot');
    return panel;
  }

  function getShortcut(key){return localStorage.getItem(key)||'';}

  function matchesShortcut(e,combo){
    if(!combo)return false;
    const parts=combo.split('+'), key=parts[parts.length-1];
    return e.key.toUpperCase()===key.toUpperCase()&&!!e.altKey===parts.includes('Alt')&&!!e.ctrlKey===parts.includes('Ctrl')&&!!e.shiftKey===parts.includes('Shift');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── UI ─────────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function buildUI() {
    function inject() {
      if(document.getElementById('sc-root'))return;
      const root=document.createElement('div'); root.id='sc-root';

      const hdr=document.createElement('div'); hdr.className='sc-hdr';
      hdr.innerHTML=`
        <span class="sc-hdr-icon">⏺</span>
        <span class="sc-hdr-title">Clip</span>
        <span id="sc-rec-indicator" class="sc-rec-indicator" style="display:none;"></span>
        <div style="margin-left:auto;display:flex;gap:4px;align-items:center;">
          <div class="sc-btn-group">
            <button id="sc-ss-full" class="sc-icon-btn" title="Screenshot">📷</button>
            <button id="sc-ss-crop" class="sc-icon-btn" title="Crop screenshot">✂📷</button>
          </div>
          <div class="sc-btn-group" id="sc-rec-group">
            <button id="sc-rec-full" class="sc-rec-btn" title="Record fullscreen">⏺</button>
            <button id="sc-rec-crop" class="sc-rec-btn sc-rec-btn--crop" title="Record selection">✂</button>
          </div>
          <button id="sc-settings-btn" class="sc-btn" title="Settings">⚙</button>
          <button id="sc-toggle" class="sc-btn">−</button>
        </div>`;

      const settingsPanel=buildSettingsPanel();
      hdr.style.position='relative'; hdr.appendChild(settingsPanel);

      const body=document.createElement('div'); body.id='sc-body';
      const inner=document.createElement('div'); inner.className='sc-inner';
      inner.innerHTML='<div id="sc-status-row" class="sc-sublabel" style="min-height:13px;"></div><div id="sc-clips-list"></div>';
      body.appendChild(inner); root.appendChild(hdr); root.appendChild(body);

      function initPosition(cb){
        const ftfpMap=document.getElementById('ftfp-map');
        const chatInput=document.getElementById('chat-input');
        if(ftfpMap){ftfpMap.insertAdjacentElement('afterend',root);cb();return;}
        if(chatInput){
          const insertBefore=chatInput.parentElement?.parentElement?.parentElement;
          if(insertBefore?.parentElement){
            insertBefore.insertAdjacentElement('beforebegin',root);
            const obs=new MutationObserver(()=>{if(!document.contains(root)){obs.disconnect();setTimeout(()=>initPosition(cb),100);}});
            obs.observe(document.body,{childList:true,subtree:true});
            cb(); return;
          }
        }
        setTimeout(()=>initPosition(cb),300);
      }

      initPosition(()=>{
        UI.recIndicator=document.getElementById('sc-rec-indicator');
        UI.statusEl=document.getElementById('sc-status-row');
        UI.clipsList=document.getElementById('sc-clips-list');
        UI.recGroup=document.getElementById('sc-rec-group');
        UI.recFull=document.getElementById('sc-rec-full');
        UI.recCrop=document.getElementById('sc-rec-crop');

        let settingsOpen=false;
        document.getElementById('sc-settings-btn').addEventListener('click',e=>{e.stopPropagation();settingsOpen=!settingsOpen;settingsPanel.style.display=settingsOpen?'':'none';});
        document.addEventListener('click',()=>{if(settingsOpen){settingsOpen=false;settingsPanel.style.display='none';}});

        let collapsed=false;
        document.getElementById('sc-toggle').addEventListener('click',()=>{collapsed=!collapsed;body.style.display=collapsed?'none':'';document.getElementById('sc-toggle').textContent=collapsed?'+':'−';});

        document.getElementById('sc-ss-full').addEventListener('click',()=>takeScreenshot(null));
        document.getElementById('sc-ss-crop').addEventListener('click',()=>enterCropScreenshot());

        UI.recFull.addEventListener('click',()=>{
          if(recording)stopRecording();
          else if(frameMode)cancelFrameMode();
          else{cropRegion=null;startRecording();}
        });
        UI.recCrop.addEventListener('click',()=>{
          if(recording)stopRecording();
          else if(frameMode)cancelFrameMode();
          else{pendingAction='record';enterFrameMode();}
        });

        document.addEventListener('keydown',e=>{
          if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
          if(e.key==='Escape'&&frameMode){cancelFrameMode();return;}
          const recKey=getShortcut('sc_key_record'), ssKey=getShortcut('sc_key_screenshot');
          if(recKey&&matchesShortcut(e,recKey)){e.preventDefault();if(recording)stopRecording();else{cropRegion=null;startRecording();}return;}
          if(ssKey&&matchesShortcut(e,ssKey)){e.preventDefault();takeScreenshot(null);}
        },{capture:true});

        showStatus('Click ⏺ to record • 📷 to screenshot','');
        console.log('[SOON CLIP] UI injected v4.3.1');
      });
    }
    if(document.body)inject();
    else document.addEventListener('DOMContentLoaded',inject,{once:true});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── RECORD BUTTON STATE ────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function updateRecordBtn(inFrameMode,isRecording){
    if(!UI.recFull)return;
    if(isRecording){
      UI.recFull.textContent='⏹'; UI.recFull.className='sc-rec-btn sc-rec-btn--stop'; UI.recFull.title='Stop recording';
      UI.recCrop.style.display='none';
    }else if(inFrameMode){
      UI.recFull.textContent='✕ Cancel'; UI.recFull.className='sc-rec-btn sc-rec-btn--cancel sc-rec-btn--full';
      UI.recCrop.style.display='none';
    }else{
      UI.recFull.textContent='⏺'; UI.recFull.className='sc-rec-btn'; UI.recFull.title='Record fullscreen';
      UI.recCrop.style.display=''; UI.recCrop.textContent='✂'; UI.recCrop.className='sc-rec-btn sc-rec-btn--crop'; UI.recCrop.title='Record selection';
    }
  }

  function showStatus(msg,type){
    if(!UI.statusEl)return;
    UI.statusEl.textContent=msg; UI.statusEl.className='sc-sublabel sc-status--'+(type||'');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── QUEUE / CARDS ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function renderQueue(){
    if(!UI.clipsList)return;
    const existingStrip=UI.clipsList.querySelector('.sc-ss-strip');
    if(screenshots.length>0){
      const strip=document.createElement('div'); strip.className='sc-ss-strip';
      screenshots.forEach(ss=>{
        const cell=document.createElement('div'); cell.className='sc-ss-cell';
        cell.innerHTML=`<img class="sc-ss-thumb" src="${ss.dataUrl}" title="${ss.label}"><div class="sc-ss-cell-actions"><button class="sc-ss-save" title="Save">↓</button><button class="sc-ss-del" title="Delete">✕</button></div>`;
        cell.querySelector('.sc-ss-save').addEventListener('click',()=>triggerDownload(ss.blob,ss.filename));
        cell.querySelector('.sc-ss-del').addEventListener('click',()=>{URL.revokeObjectURL(ss.blobUrl);screenshots.splice(screenshots.findIndex(s=>s.id===ss.id),1);renderQueue();});
        cell.querySelector('.sc-ss-thumb').addEventListener('click',()=>window.open(ss.blobUrl,'_blank'));
        strip.appendChild(cell);
      });
      if(existingStrip)existingStrip.replaceWith(strip);
      else UI.clipsList.insertBefore(strip,UI.clipsList.firstChild);
    }else if(existingStrip){existingStrip.remove();}

    clips.forEach((clip,idx)=>{
      if(UI.clipsList.querySelector(`[data-clip-id="${clip.id}"]`))return;
      const card=buildClipCard(clip,idx===0);
      const strip=UI.clipsList.querySelector('.sc-ss-strip');
      if(strip)strip.insertAdjacentElement('afterend',card);
      else UI.clipsList.insertBefore(card,UI.clipsList.firstChild);
    });
  }

  function buildClipCard(clip,expanded){
    const card=document.createElement('div'); card.className='sc-clip-card'; card.dataset.clipId=clip.id;

    const hdr=document.createElement('div'); hdr.className='sc-card-hdr';
    hdr.innerHTML=`
      <img class="sc-card-thumb" data-clip-thumb="${clip.id}" src="${clip.thumbUrl||''}" style="${clip.thumbUrl?'':'display:none;'}">
      <div class="sc-card-hdr-info"><span class="sc-clip-label">${clip.label}</span></div>
      <div style="display:flex;gap:3px;align-items:center;flex-shrink:0;">
        <button class="sc-dl-btn-sm" title="Quick save">↓</button>
        <button class="sc-del-btn">✕</button>
        <button class="sc-card-toggle">${expanded?'−':'+'}</button>
      </div>`;

    const body=document.createElement('div'); body.className='sc-card-body'; body.style.display=expanded?'':'none';

    if(clip.processing){
      body.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:10px 0;"><div class="sc-ph-spinner"></div><span class="sc-ph-status" style="font-size:10px;opacity:0.5;">Processing… 0s</span></div>`;
      card.appendChild(hdr); card.appendChild(body); return card;
    }

    body.innerHTML=`
      <video class="sc-clip-video" src="${clip.blobUrl}" preload="metadata" muted playsinline></video>
      <div class="sc-player-row">
        <button class="sc-play-btn">▶</button>
        <button class="sc-mute-btn" title="Toggle mute">🔇</button>
        <button class="sc-skip-btn" data-skip="-5" title="Back 5s">⏪</button>
        <button class="sc-skip-btn" data-skip="-1" title="Back 1s">◀</button>
        <span class="sc-timeline" id="sc-tl-${clip.id}">
          <span class="sc-tl-track"></span>
          <span class="sc-tl-filled" id="sc-tlf-${clip.id}"></span>
          <span class="sc-tl-handle sc-tl-in" id="sc-tli-${clip.id}"></span>
          <span class="sc-tl-handle sc-tl-out" id="sc-tlo-${clip.id}"></span>
          <span class="sc-tl-playhead" id="sc-tlp-${clip.id}"></span>
        </span>
        <button class="sc-skip-btn" data-skip="1" title="Forward 1s">▶</button>
        <button class="sc-skip-btn" data-skip="5" title="Forward 5s">⏩</button>
        <span class="sc-time-display" id="sc-time-${clip.id}">0s</span>
      </div>
      <div class="sc-trim-times">
        <span id="sc-tli-lbl-${clip.id}" class="sc-sublabel">In: 0.0s</span>
        <span class="sc-sublabel" style="font-weight:700;">${formatDuration(clip.duration)}</span>
        <span id="sc-tlo-lbl-${clip.id}" class="sc-sublabel">Out: ${formatDuration(clip.duration)}</span>
      </div>
      <div class="sc-card-actions">
        <div style="display:flex;gap:3px;">
          <button class="sc-qbtn" data-sec="30">30s</button>
          <button class="sc-qbtn" data-sec="60">60s</button>
          <button class="sc-qbtn" data-sec="120">2m</button>
          <button class="sc-qbtn sc-qbtn-reset">Reset</button>
        </div>
        <button class="sc-dl-btn">↓ Save MP4</button>
      </div>
      <div class="sc-clip-status" id="sc-cst-${clip.id}" style="display:none;"></div>`;

    card.appendChild(hdr); card.appendChild(body);

    hdr.querySelector('.sc-card-toggle').addEventListener('click',()=>{const open=body.style.display!=='none';body.style.display=open?'none':'';hdr.querySelector('.sc-card-toggle').textContent=open?'+':'−';});
    hdr.querySelector('.sc-dl-btn-sm').addEventListener('click',()=>{const ti=clip.trimIn,to=clip.trimOut;clip.trimIn=0;clip.trimOut=clip.duration;downloadClip(clip);clip.trimIn=ti;clip.trimOut=to;});
    hdr.querySelector('.sc-del-btn').addEventListener('click',()=>{URL.revokeObjectURL(clip.blobUrl);if(clip.thumbUrl)URL.revokeObjectURL(clip.thumbUrl);clips.splice(clips.findIndex(c=>c.id===clip.id),1);card.remove();});

    const video=body.querySelector('.sc-clip-video');
    const loadingDiv=document.createElement('div'); loadingDiv.style.cssText='padding:20px;text-align:center;font-size:10px;opacity:0.5;'; loadingDiv.textContent='Loading…';
    body.insertBefore(loadingDiv,video); video.style.display='none';

    const playBtn=body.querySelector('.sc-play-btn');
    const timeDisp=body.querySelector(`#sc-time-${clip.id}`);
    const tl=body.querySelector(`#sc-tl-${clip.id}`);
    const tlIn=body.querySelector(`#sc-tli-${clip.id}`);
    const tlOut=body.querySelector(`#sc-tlo-${clip.id}`);
    const tlFill=body.querySelector(`#sc-tlf-${clip.id}`);
    const tlPh=body.querySelector(`#sc-tlp-${clip.id}`);
    const inLbl=body.querySelector(`#sc-tli-lbl-${clip.id}`);
    const outLbl=body.querySelector(`#sc-tlo-lbl-${clip.id}`);

    const ticks=Math.min(18,Math.max(4,Math.floor(clip.duration/5)));
    for(let i=1;i<ticks;i++){const t=document.createElement('span');t.className='sc-tl-tick';t.style.left=(i/ticks*100)+'%';tl.appendChild(t);}

    function updateTrim(){
      const d=clip.duration,ip=(clip.trimIn/d)*100,op=(clip.trimOut/d)*100;
      tlIn.style.left=ip+'%'; tlOut.style.left=op+'%';
      tlFill.style.left=ip+'%'; tlFill.style.width=(op-ip)+'%';
      inLbl.textContent='In: '+clip.trimIn.toFixed(1)+'s';
      outLbl.textContent='Out: '+clip.trimOut.toFixed(1)+'s';
    }

    // Update from actual video metadata — timestamp estimate is a rounded integer
    video.addEventListener('loadedmetadata', () => {
      loadingDiv.remove(); video.style.display = '';
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        clip.duration = video.duration;
        clip.trimOut  = video.duration;
        updateTrim();
      }
    }, { once: true });

    playBtn.addEventListener('click',()=>{if(video.paused){video.currentTime=Math.max(clip.trimIn,video.currentTime);video.play().catch(()=>{})}else video.pause();});
    video.addEventListener('play',()=>{playBtn.textContent='⏸';});
    video.addEventListener('pause',()=>{playBtn.textContent='▶';});
    video.addEventListener('ended',()=>{playBtn.textContent='▶';video.currentTime=clip.trimIn;});

    const muteBtn=body.querySelector('.sc-mute-btn'); video.muted=true;
    muteBtn.addEventListener('click',()=>{video.muted=!video.muted;muteBtn.textContent=video.muted?'🔇':'🔊';});

    function safeSeek(time){video.currentTime=Math.max(clip.trimIn,Math.min(clip.trimOut,time));}
    body.querySelectorAll('.sc-skip-btn').forEach(btn=>btn.addEventListener('click',()=>safeSeek(video.currentTime+parseFloat(btn.dataset.skip))));

    card.setAttribute('tabindex','-1');
    video.addEventListener('timeupdate',()=>{
      const t=video.currentTime;
      tlPh.style.left=(t/clip.duration)*100+'%'; timeDisp.textContent=t.toFixed(1)+'s';
      if(!video.paused&&t>=clip.trimOut){video.pause();video.currentTime=clip.trimIn;}
    });

    tl.addEventListener('click',e=>{if(e.target===tlIn||e.target===tlOut)return;const r=tl.getBoundingClientRect();safeSeek(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*clip.duration);});

    let drag=null;
    tlIn.addEventListener('mousedown',e=>{e.stopPropagation();drag='in';});
    tlOut.addEventListener('mousedown',e=>{e.stopPropagation();drag='out';});
    document.addEventListener('mousemove',e=>{
      if(!drag)return;
      const r=tl.getBoundingClientRect(),s=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*clip.duration;
      if(drag==='in'){clip.trimIn=Math.max(0,Math.min(s,clip.trimOut-0.5));video.currentTime=clip.trimIn;}
      else{clip.trimOut=Math.min(clip.duration,Math.max(s,clip.trimIn+0.5));video.currentTime=clip.trimOut;}
      updateTrim();
    });
    document.addEventListener('mouseup',()=>{drag=null;});

    body.querySelectorAll('.sc-qbtn[data-sec]').forEach(btn=>btn.addEventListener('click',()=>{clip.trimOut=Math.min(clip.duration,clip.trimIn+parseInt(btn.dataset.sec));updateTrim();video.currentTime=clip.trimIn;}));
    body.querySelector('.sc-qbtn-reset').addEventListener('click',()=>{clip.trimIn=0;clip.trimOut=clip.duration;updateTrim();});
    body.querySelector('.sc-dl-btn').addEventListener('click',()=>downloadClip(clip));

    updateTrim();
    return card;
  }

  function updateClipStatus(clipId,msg){const el=document.getElementById('sc-cst-'+clipId);if(el){el.textContent=msg;el.style.display=msg?'':'none';}}
  function formatDuration(sec){const m=Math.floor(sec/60),s=Math.floor(sec%60);return m>0?m+':'+String(s).padStart(2,'0'):s+'s';}

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STYLES ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function addStyles(){
    GM_addStyle(`
      @keyframes sc-spin  { to { transform: rotate(360deg); } }
      @keyframes sc-pulse { 0%,100%{opacity:1} 50%{opacity:0.65} }
      .sc-ph-spinner { width:18px;height:18px;border:2px solid rgba(0,0,0,0.12);border-top-color:var(--base-primary,#df4e1e);border-radius:50%;animation:sc-spin 0.8s linear infinite;flex-shrink:0; }

      #sc-root { font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.2); }
      .sc-hdr { display:flex;align-items:center;padding:0 3px 1px;gap:5px;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border-bottom:1px solid rgba(0,0,0,0.15);box-shadow:rgba(255,255,255,0.5) 0 1px 0;user-select:none; }
      .sc-hdr-icon { color:var(--base-primary,#df4e1e);font-size:11px; }
      .sc-hdr-title { font-size:14px;font-weight:700;color:rgb(25,28,32); }
      .sc-rec-indicator { font-size:10px;font-weight:700;color:#df4e1e;letter-spacing:0.05em; }

      .sc-btn-group { display:flex;border-radius:3px;overflow:hidden;border:1px solid rgba(0,0,0,0.2); }
      .sc-icon-btn { font-size:12px;padding:2px 5px;background:rgba(0,0,0,0.07);border:none;border-right:1px solid rgba(0,0,0,0.12);cursor:pointer;line-height:1;transition:background 0.1s; }
      .sc-icon-btn:last-child { border-right:none; }
      .sc-icon-btn:hover { background:rgba(0,0,0,0.15); }
      #sc-rec-group { border-color:var(--base-primary,#df4e1e); }
      .sc-rec-btn { font-size:10px;font-weight:700;padding:2px 7px;background:var(--base-primary,#df4e1e);color:white;border:none;border-right:1px solid rgba(255,255,255,0.25);cursor:pointer;transition:opacity 0.1s;letter-spacing:0.04em; }
      .sc-rec-btn:last-child { border-right:none; }
      .sc-rec-btn:hover { opacity:0.85; }
      .sc-rec-btn--crop { background:rgba(223,78,30,0.7); }
      .sc-rec-btn--stop { background:#c0392b;animation:sc-pulse 1.1s infinite; }
      .sc-rec-btn--full { border-right:none; }
      .sc-rec-btn--cancel { background:rgba(0,0,0,0.25);color:rgba(0,0,0,0.7); }
      .sc-btn { font-size:13px;padding:1px 5px;border:1px solid rgba(0,0,0,0.22);border-radius:3px;background:transparent;color:rgba(0,0,0,0.6);cursor:pointer;transition:color 0.12s,border-color 0.12s; }
      .sc-btn:hover { border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }

      #sc-settings { position:absolute;right:0;top:calc(100% + 4px);background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border:1px solid rgba(0,0,0,0.2);border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9999;padding:10px;min-width:230px; }
      .sc-toggle-btn { font-size:10px;font-weight:700;padding:2px 8px;background:rgba(0,0,0,0.1);border:1px solid rgba(0,0,0,0.2);border-radius:3px;cursor:pointer;min-width:40px;text-align:center;transition:background 0.1s,color 0.1s; }
      .sc-toggle-btn--on { background:rgba(223,78,30,0.15);border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }

      #sc-body { background:var(--base-light,#dddec4);background-image:var(--base-texture-background); }
      .sc-inner { padding:8px;display:flex;flex-direction:column;gap:8px; }
      .sc-sublabel { font-size:9px;opacity:0.55;color:rgba(0,0,0,0.7); }
      .sc-status--ok      { color:var(--base-secondary,#26b64b)!important;opacity:1!important; }
      .sc-status--err     { color:var(--base-primary,#df4e1e)!important;opacity:1!important; }
      .sc-status--loading { opacity:0.75!important; }
      .sc-status--rec     { color:#df4e1e!important;opacity:1!important;font-weight:700; }

      .sc-ss-strip { display:flex;gap:4px;padding:6px 0 4px;overflow-x:auto;scrollbar-width:none; }
      .sc-ss-strip::-webkit-scrollbar { display:none; }
      .sc-ss-cell { position:relative;flex-shrink:0;width:72px;border-radius:3px;overflow:hidden;border:1px solid rgba(0,0,0,0.15);background:#000;cursor:pointer; }
      .sc-ss-cell:hover .sc-ss-cell-actions { opacity:1; }
      .sc-ss-thumb { width:72px;height:40px;object-fit:cover;display:block;transition:opacity 0.12s; }
      .sc-ss-cell:hover .sc-ss-thumb { opacity:0.7; }
      .sc-ss-cell-actions { position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;padding:2px 3px;background:linear-gradient(transparent,rgba(0,0,0,0.7));opacity:0;transition:opacity 0.12s; }
      .sc-ss-save,.sc-ss-del { font-size:9px;font-weight:700;background:none;border:none;color:white;cursor:pointer;padding:1px 2px;line-height:1; }
      .sc-ss-save:hover { color:#26b64b; }
      .sc-ss-del:hover  { color:#df4e1e; }

      .sc-clip-card { background:rgba(0,0,0,0.08);border-radius:4px;border:1px solid rgba(0,0,0,0.1);overflow:hidden;margin-bottom:6px; }
      .sc-card-hdr { display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:default; }
      .sc-card-thumb { width:48px;height:27px;object-fit:cover;border-radius:2px;flex-shrink:0;background:#000; }
      .sc-card-hdr-info { flex:1;min-width:0; }
      .sc-clip-label { font-size:10px;font-weight:700;color:rgba(0,0,0,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block; }
      .sc-card-toggle { font-size:11px;width:18px;height:18px;border:1px solid rgba(0,0,0,0.2);border-radius:3px;background:var(--base-light,#dddec4);color:rgba(0,0,0,0.45);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1; }
      .sc-card-toggle:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-card-body { padding:0 6px 6px;display:flex;flex-direction:column;gap:5px;border-top:1px solid rgba(0,0,0,0.08); }
      .sc-clip-video { width:100%;display:block;background:#000;height:180px;object-fit:cover;border-radius:2px;margin-top:5px; }

      .sc-player-row { display:flex;align-items:center;gap:6px; }
      .sc-play-btn { width:22px;height:22px;border-radius:50%;background:var(--base-primary,#df4e1e);border:none;color:white;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity 0.1s; }
      .sc-play-btn:hover { opacity:0.85; }
      .sc-mute-btn { font-size:11px;padding:2px 4px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:3px;cursor:pointer;flex-shrink:0;transition:background 0.1s;line-height:1; }
      .sc-mute-btn:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-skip-btn { font-size:10px;padding:2px 4px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:3px;color:rgba(0,0,0,0.6);cursor:pointer;flex-shrink:0;transition:background 0.1s; }
      .sc-skip-btn:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-time-display { font-size:9px;opacity:0.5;font-family:monospace;flex-shrink:0; }

      .sc-timeline { position:relative;flex:1;height:24px;background:rgba(0,0,0,0.1);border-radius:3px;cursor:pointer;display:inline-block;border:1px solid rgba(0,0,0,0.1);overflow:visible; }
      .sc-tl-track { position:absolute;top:50%;left:0;right:0;height:4px;transform:translateY(-50%);background:rgba(0,0,0,0.12);border-radius:2px; }
      .sc-tl-filled { position:absolute;top:50%;height:4px;transform:translateY(-50%);background:var(--base-primary,#df4e1e);opacity:0.65;border-radius:2px;pointer-events:none; }
      .sc-tl-handle { position:absolute;top:50%;transform:translate(-50%,-50%);width:5px;height:20px;background:var(--base-primary,#df4e1e);border-radius:2px;cursor:col-resize;z-index:2;box-shadow:0 1px 3px rgba(0,0,0,0.3); }
      .sc-tl-handle::after { content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1px;height:10px;background:rgba(255,255,255,0.6);border-radius:1px; }
      .sc-tl-playhead { position:absolute;top:0;bottom:0;width:2px;background:rgba(0,0,0,0.4);pointer-events:none;transform:translateX(-50%);z-index:1; }
      .sc-tl-playhead::before { content:'';position:absolute;top:-2px;left:50%;transform:translateX(-50%);border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid rgba(0,0,0,0.4); }
      .sc-tl-tick { position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.08);pointer-events:none; }
      .sc-trim-times { display:flex;justify-content:space-between;padding:0 1px; }

      .sc-card-actions { display:flex;justify-content:space-between;align-items:center;gap:6px; }
      .sc-qbtn { padding:2px 5px;font-size:9px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:3px;color:rgba(0,0,0,0.6);cursor:pointer;transition:background 0.1s; }
      .sc-qbtn:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-dl-btn { padding:4px 10px;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;background:var(--base-primary,#df4e1e);border:none;border-radius:3px;color:white;cursor:pointer;transition:opacity 0.1s; }
      .sc-dl-btn:hover { opacity:0.85; }
      .sc-dl-btn-sm { padding:2px 6px;font-size:9px;font-weight:700;background:var(--base-primary,#df4e1e);border:none;border-radius:3px;color:white;cursor:pointer;transition:opacity 0.1s; }
      .sc-dl-btn-sm:hover { opacity:0.85; }
      .sc-del-btn { padding:2px 6px;font-size:10px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:3px;color:rgba(0,0,0,0.45);cursor:pointer;transition:background 0.1s; }
      .sc-del-btn:hover { background:rgba(223,78,30,0.15);color:var(--base-primary,#df4e1e); }
      .sc-clip-status { font-size:9px;color:rgba(0,0,0,0.45);padding:2px 0; }
    `);
  }

  function init(){addStyles();buildUI();}
  init();

})();
