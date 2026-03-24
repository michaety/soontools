// ==UserScript==
// @name         Soon Clipper
// @namespace    https://fishtank.news
// @version      1.5.2
// @description  Snipping tool style video recorder for fishtank.live — fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      cdn.fishtank.live
// @run-at       document-idle
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
  let mainVideoEl   = null;
  let recording     = false; // kept in sync with activeSession for UI guards

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
    // Fast path: cached element is still valid — avoids querySelectorAll + getBoundingClientRect
    // Use .isConnected instead of document.contains() (cheaper, no tree walk)
    if (mainVideoEl && mainVideoEl.isConnected &&
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

    let lastOverlayDraw=0;
    function updateCanvas(ts) {
      if (!document.getElementById('sc-crop-canvas')) return;
      if(document.hidden||ts-lastOverlayDraw<33){requestAnimationFrame(updateCanvas);return;} // ~30fps, skip when tab backgrounded
      lastOverlayDraw=ts;
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
    updateCanvas(0);

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
  // ── RECORDING SESSION ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // All recording state is encapsulated in RecordingSession. No shared mutable
  // state leaks between sessions — cam splits create a new instance cleanly.
  //
  // External API (used by UI and camWatcher):
  //   session = new RecordingSession(cropRegion)
  //   await session.start()   → throws if no video found
  //   session.stop()          → triggers onstop → finaliseClip
  //   session.destroy()       → immediate teardown, no clip saved
  //   session.isActive        → true while recording
  //   session.seconds         → elapsed seconds (for status display)

  // Shared assets — fetched once per page session, reused across recordings
  const _assets = { logoImg: null, logoReady: false };

  function _loadAssets() {
    if(!_assets.logoImg) {
      const img = new Image();
      GM_xmlhttpRequest({
        method:'GET', url:'https://cdn.fishtank.live/images/logo/logo-stripe.png',
        responseType:'blob',
        onload: r => { img.onload = () => { _assets.logoReady = true; }; img.src = URL.createObjectURL(r.response); }
      });
      _assets.logoImg = img;
    }
  }

  class RecordingSession {
    constructor(cropRegion) {
      this.cropRegion  = cropRegion || null;
      this.isActive    = false;
      this.seconds     = 0;
      this._chunks     = [];
      this._startTime  = null;
      this._mimeType   = SUPPORTED_MIME;

      // All owned resources — cleaned up in destroy()
      this._canvas     = null;
      this._ctx        = null;
      this._stream     = null;
      this._recorder   = null;
      this._audioDst   = null;
      this._audioNode  = null;
      this._camWatcher = null;
      this._recTimer   = null;
      this._borderTimer= null;
      this._autoStop   = null;
      this._vid        = null;        // video element at session start
      this._lastVid    = null;        // tracks current video for cam switch detection
      this._lastSrc    = null;        // tracks src for split detection
      this._staticFrames = 0;
      this._splitDebounce = false;
      this._goneCount  = 0;
      this.multiCam    = false; // set true for continuous multi-cam mode
      this._stopTime   = null;  // set in stop() to accurately calculate duration

      // Offscreen canvas for static noise — created once per session
      this._staticCanvas = document.createElement('canvas');
      this._staticCanvas.width = 80; this._staticCanvas.height = 45;
      this._staticCtx = this._staticCanvas.getContext('2d');

      // rAF state
      this._lastDrawTs = 0;
      this._rafId      = null;
    }

    async start() {
      const vid = getVideoEl();
      if (!vid) throw new Error('No video found');
      this._vid = vid;
      this._lastVid = vid;
      this._lastSrc = vid.currentSrc || vid.src;

      // AudioContext — shared across sessions, must survive
      if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
      if (sharedAudioCtx.state === 'suspended') await sharedAudioCtx.resume().catch(() => {});
      _loadAssets();

      // Canvas
      const vw = vid.videoWidth || 1920, vh = vid.videoHeight || 1080;
      this._canvas = document.createElement('canvas');
      this._canvas.width = vw; this._canvas.height = vh;
      this._ctx = this._canvas.getContext('2d');

      // Stream + audio
      this._stream = this._canvas.captureStream(24);
      this._connectAudio(vid);

      // MediaRecorder
      this._recorder = new MediaRecorder(this._stream, {
        mimeType: this._mimeType,
        videoBitsPerSecond: 4_000_000,
        audioBitsPerSecond: 128_000
      });
      this._recorder.ondataavailable = e => { if (e.data.size > 0) this._chunks.push(e.data); };
      this._recorder.onstop = () => this._onStop();
      this._recorder.start(250);

      this.isActive = true;
      this._startTime = Date.now();

      // Timers
      this._recTimer = setInterval(() => {
        if (!this.isActive) return;
        this.seconds++;
        showStatus('⏺ ' + formatDuration(this.seconds), 'rec');
        if (UI.recIndicator) { UI.recIndicator.textContent = '⏺ ' + formatDuration(this.seconds); UI.recIndicator.style.display = ''; }
        updateRecordBtn(false, true);
      }, 1000);

      this._borderTimer = setInterval(() => {
        if (!this._vid) return;
        if (!this.isActive) { this._vid.style.outline = ''; return; }
        this._vid.style.outline = this.seconds % 2 === 0 ? '3px solid #df4e1e' : '3px solid #ff7043';
        this._vid.style.outlineOffset = '-3px';
      }, 1000);

      this._autoStop = setTimeout(() => this.stop(), MAX_RECORD_SEC * 1000);
      this._camWatcher = setInterval(() => this._watchCam(), 500);

      if (this.cropRegion) showRecordingCropOverlay(vid, this.cropRegion);

      // Start draw loop
      this._rafId = requestAnimationFrame(ts => this._drawFrame(ts));

      updateRecordBtn(false, true);
      showStatus('Recording — press ⏹ to stop', 'rec');
    }

    stop() {
      if (!this.isActive) return;
      this.isActive = false; // stops drawFrame immediately — canvas freezes here
      this._stopTime = Date.now(); // capture NOW before recorder flush delay
      if (this._recorder?.state === 'recording' || this._recorder?.state === 'paused') {
        // Flush current buffer first to minimise frozen frames in final chunk
        try { this._recorder.requestData(); } catch {}
        this._recorder.stop(); // triggers _onStop via onstop event
      }
      showStatus('Processing…', 'loading');
    }

    destroy() {
      // Immediate teardown — no clip saved (used when session is superseded)
      this.isActive = false;
      this._destroyed = true; // suppress onstop → finaliseClip
      this._clearTimers();
      if (this._recorder?.state !== 'inactive') {
        try { this._recorder.stop(); } catch {}
      }
      this._teardownAudio();
      if (this._vid) this._vid.style.outline = '';
      document.getElementById('sc-rec-crop-overlay')?.remove();
    }

    _onStop() {
      if (this._destroyed) return; // destroy() was called — don't save a clip
      this._clearTimers();
      this._teardownAudio();
      if (this._vid) this._vid.style.outline = '';
      this.isActive = false;
      if (UI.recIndicator) UI.recIndicator.style.display = 'none';
      updateRecordBtn(false, false);
      document.getElementById('sc-rec-crop-overlay')?.remove();

      const endTime = this._stopTime || Date.now();
      const durationSec = this._startTime
        ? Math.max(1, Math.round((endTime - this._startTime) / 1000))
        : Math.max(1, this.seconds || 1);
      finaliseClip(this._mimeType, this._chunks, durationSec);
    }

    _clearTimers() {
      clearInterval(this._camWatcher);
      clearInterval(this._recTimer);
      clearInterval(this._borderTimer);
      clearTimeout(this._autoStop);
      this._camWatcher = this._recTimer = this._borderTimer = this._autoStop = null;
    }

    _connectAudio(vid) {
      try {
        let node = sharedAudioSources.get(vid);
        if (!node) {
          node = sharedAudioCtx.createMediaElementSource(vid);
          sharedAudioSources.set(vid, node);
        }
        if (this._audioDst) { try { node.disconnect(this._audioDst); } catch {} }
        const dst = sharedAudioCtx.createMediaStreamDestination();
        this._audioDst = dst;
        this._audioNode = node;
        node.connect(dst);
        // Connect to speakers only once — repeated connects stack gain causing volume doubling
        if (!node._scDestConnected) { node.connect(sharedAudioCtx.destination); node._scDestConnected = true; }
        this._stream.getAudioTracks().forEach(t => { this._stream.removeTrack(t); t.stop(); });
        dst.stream.getAudioTracks().forEach(t => this._stream.addTrack(t));
        console.log('[SOON CLIP] Audio connected');
      } catch(e) {
        console.warn('[SOON CLIP] Audio connect failed:', e.message);
      }
    }

    _teardownAudio() {
      if (this._audioNode && this._audioDst) {
        try { this._audioNode.disconnect(this._audioDst); } catch {}
      }
      this._audioNode = this._audioDst = null;
    }

    _drawStatic(w, h) {
      // Reuse ImageData — avoids allocating 14KB per frame at 24fps
      if (!this._staticImgData) this._staticImgData = this._staticCtx.createImageData(80, 45);
      const imgData = this._staticImgData;
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() * 180 | 0;
        d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
      }
      this._staticCtx.putImageData(imgData, 0, 0);
      this._ctx.imageSmoothingEnabled = false;
      this._ctx.drawImage(this._staticCanvas, 0, 0, w, h);
      this._ctx.imageSmoothingEnabled = true;
      const { logoImg, logoReady } = _assets;
      if (logoReady && logoImg.naturalWidth > 0) {
        const lw = Math.min(w * 0.85, 600), lh = lw * (logoImg.naturalHeight / logoImg.naturalWidth);
        this._ctx.globalAlpha = 0.9;
        this._ctx.drawImage(logoImg, (w - lw) / 2, (h - lh) / 2, lw, lh);
        this._ctx.globalAlpha = 1;
      } else {
        this._ctx.fillStyle = 'rgba(0,0,0,0.55)';
        this._ctx.fillRect(w/2-90, h/2-20, 180, 40);
        this._ctx.fillStyle = 'white'; this._ctx.font = 'bold 15px sans-serif';
        this._ctx.textAlign = 'center'; this._ctx.textBaseline = 'middle';
        this._ctx.fillText('switching cam...', w/2, h/2);
      }
    }

    _drawFrame(ts) {
      if (!this.isActive) return; // session ended — rAF loop stops here
      if (document.hidden || ts - this._lastDrawTs < 41.67) { // ~24fps, skip entirely when tab backgrounded
        this._rafId = requestAnimationFrame(ts => this._drawFrame(ts));
        return;
      }
      this._lastDrawTs = ts;

      // Prefer cached vid — only call getVideoEl() when it's stale
      const cv = (this._lastVid?.readyState >= 2 && !this._lastVid.paused) ? this._lastVid : getVideoEl();
      if (!cv || cv.readyState < 2) {
        // Multi-cam: draw static to fill stream load gap
        // Split-clip: hold last frame (canvas retains it) — no static in the clip
        if (this.multiCam) this._drawStatic(this._canvas.width, this._canvas.height);
        this._rafId = requestAnimationFrame(ts => this._drawFrame(ts));
        return;
      }
      if (cv !== this._lastVid) {
        this._lastVid = cv;
        // Split-clip: cam change handled by _watchCam stopping the recording
        // Multi-cam: no static here — readyState < 2 path already covered the
        // loading gap. Adding frames here after the stream is ready causes a
        // second static burst immediately after the first one clears.
      }
      if (this._staticFrames > 0) {
        this._drawStatic(this._canvas.width, this._canvas.height);
        this._staticFrames--;
        this._rafId = requestAnimationFrame(ts => this._drawFrame(ts));
        return;
      }
      const cr = this.cropRegion;
      const vw = cv.videoWidth || 1920, vh = cv.videoHeight || 1080;
      if (cr) {
        const cw = Math.round(cr.w * vw), ch = Math.round(cr.h * vh);
        if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
        this._ctx.drawImage(cv, cr.x*vw, cr.y*vh, cr.w*vw, cr.h*vh, 0, 0, cw, ch);
      } else {
        if (this._canvas.width !== vw || this._canvas.height !== vh) { this._canvas.width = vw; this._canvas.height = vh; }
        this._ctx.drawImage(cv, 0, 0, vw, vh);
      }
      this._rafId = requestAnimationFrame(ts => this._drawFrame(ts));
    }

    _watchCam() {
      if (!this.isActive) return;
      const cv = (this._lastVid?.readyState >= 2 && !this._lastVid.paused) ? this._lastVid : getVideoEl();
      if (!cv || cv.readyState === 0 || (cv.paused && cv.readyState < 2)) {
        if (++this._goneCount >= 10) { // ~5s at 500ms interval
          console.log('[SOON CLIP] Stream gone — stopping');
          stopRecording(); // use wrapper so recording flag + activeSession stay in sync
        }
        return;
      }
      this._goneCount = 0;
      const src = cv.currentSrc || cv.src;
      if (src && src !== this._lastSrc) {
        this._lastSrc = src;
        if (this._splitDebounce) return;
        this._splitDebounce = true;
        setTimeout(() => { this._splitDebounce = false; }, 2000);
        if (this.multiCam) {
          // Multi-cam: the readyState < 2 path in _drawFrame will naturally show
          // static during the actual loading gap — no pre-emptive static needed here.
          // Pre-priming _staticFrames while the old stream is still buffered causes
          // a false static burst before the real loading gap, creating a double-static.
          console.log('[SOON CLIP] Cam switch — continuing (multi-cam mode)');
        } else {
          // Split-clip: stop current and start fresh after it fully finalises
          console.log('[SOON CLIP] Cam split — new clip');
          stopRecording();
          // Wait for onstop to complete before starting new session —
          // prevents double audio connect from overlapping teardown/setup
          setTimeout(() => { if (!activeSession?.isActive) startRecording(); }, 1000);
        }
      }
    }
  }

  // ── Session management ─────────────────────────────────────────────────────
  let activeSession = null;

  async function startRecording() {
    if (activeSession?.isActive) return;
    const session = new RecordingSession(cropRegion);
    session.multiCam = localStorage.getItem('sc_multicam') === '1';
    try {
      await session.start();
      activeSession = session;
      recording = true; // keep module-level flag in sync for UI guards
    } catch(e) {
      showStatus(e.message || 'Could not start recording', 'err');
      session.destroy();
    }
  }

  function stopRecording() {
    if (!activeSession?.isActive) return;
    recording = false;
    activeSession.stop();
    activeSession = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── WEBM DURATION FIX ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function fixWebmDuration(chunks,durationSec) {
    return new Promise(resolve=>{
      new Blob(chunks).arrayBuffer().then(buf=>{
        const data=new Uint8Array(buf), view=new DataView(buf);
        const scanLimit = Math.min(data.length - 12, 2048); // Duration is always in first ~200 bytes
        for(let i=0;i<scanLimit;i++){
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

  function finaliseClip(mimeType, chunksSnapshot, durationSec) {
    const totalSize=chunksSnapshot.reduce((s,c)=>s+c.size,0);
    if(totalSize<1000||chunksSnapshot.length===0){showStatus('No data recorded — try again','err');return;}

    const clipId=Date.now();
    const clip={id:clipId,blob:null,blobUrl:null,thumbUrl:null,duration:durationSec,trimIn:0,trimOut:durationSec,
      label:(window.SOON.activeRoom?.label||'Clip')+' — '+formatDuration(durationSec),
      filename:'soontools_'+clipId+'.webm',mimeType,processing:true};

    clips.unshift(clip);
    // Cap at 5 clips — revoke oldest blob URLs to free memory (clips can be 10-50MB each)
    while(clips.length>5){
      const old=clips.pop();
      if(old.blobUrl){URL.revokeObjectURL(old.blobUrl);old.blobUrl=null;}
      if(old.thumbUrl){URL.revokeObjectURL(old.thumbUrl);old.thumbUrl=null;}
      document.querySelector(`[data-clip-id="${old.id}"]`)?.remove();
    }
    // Collapse all existing FULLY-BUILT cards (not processing placeholders) when a new clip arrives
    UI.clipsList?.querySelectorAll('.sc-clip-card:not([data-processing]) .sc-card-body').forEach(b=>{
      if(b.style.display!=='none'){b.style.display='none';const t=b.previousElementSibling?.querySelector('.sc-card-toggle');if(t)t.textContent='+';}
    });
    renderQueue();
    showStatus('Clip captured — processing…','loading');

    let ps=0;
    const pt=setInterval(()=>{
      ps++;
      const card=document.querySelector(`[data-clip-id="${clipId}"]`);
      if(!card){clearInterval(pt);return;} // card removed — stop timer
      const el=card.querySelector('.sc-ph-status');
      if(el) el.textContent='Processing… '+ps+'s';
    },1000);

    fixWebmDuration(chunksSnapshot,durationSec).then(fixedBuf=>{
      clearInterval(pt);
      const blob=new Blob([fixedBuf],{type:mimeType});
      clip.blob=blob; clip.blobUrl=URL.createObjectURL(blob); clip.processing=false;
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
    // Use preload='auto' and visible size so browser actually loads it
    // 1x1px elements with preload='metadata' get silently deferred by Chrome
    v.src=url; v.muted=true; v.preload='metadata';
    v.style.cssText='position:fixed;left:-9999px;width:120px;height:68px;opacity:0;pointer-events:none;';
    document.body.appendChild(v);

    // AbortController removes all listeners atomically on cleanup,
    // preventing callbacks from firing on a detached element.
    const ac=new AbortController();
    let cleaned=false;
    const cleanup=()=>{
      if(cleaned)return; cleaned=true;
      clearTimeout(timeout);
      ac.abort(); // removes all event listeners below
      v.remove(); URL.revokeObjectURL(url);
    };
    const timeout=setTimeout(cleanup,5000);

    // preload=metadata: loadedmetadata fires, then seek to 0.5s triggers seeked
    v.addEventListener('loadedmetadata',()=>{v.currentTime=0.5;},{signal:ac.signal});
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
      cleanup();
    },{signal:ac.signal});
    v.addEventListener('error',cleanup,{signal:ac.signal});
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
    let lastCropDraw=0;
    function draw(ts) {
      if(!recording){canvas.remove();return;}
      if(document.hidden||ts-lastCropDraw<33){requestAnimationFrame(draw);return;} // ~30fps, skip when tab backgrounded
      lastCropDraw=ts;
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

  // Cached once at startup — no need to re-probe on every recording
  // VP8 preferred over VP9: more predictable keyframe intervals for MediaRecorder chunks,
  // resulting in more reliable blob playback in the preview player.
  // Prefer H.264/AAC MP4 recording — allows stream copy into MP4 without re-encode.
  // VP8/VP9 WebM requires full video re-encode to get into MP4, which crashes the tab.
  const SUPPORTED_MIME = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 + AAC — ideal, c:copy into MP4 works
    'video/mp4;codecs=avc1',                    // H.264, any AAC
    'video/mp4',                                // MP4 generic
    'video/webm;codecs=vp8,opus',               // Fallback WebM
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ].find(t=>MediaRecorder.isTypeSupported(t))||'';

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FFMPEG ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // Serial queue — each downloadClip call chains onto this, guaranteeing
  // ffmpeg.wasm never receives concurrent run() calls
  let ffmpegQueue = Promise.resolve();

  // Cached FFmpeg instance — loaded once, reused across downloads.
  // A run-level mutex (ffmpegRunning) prevents concurrent run() calls
  // without the overhead of recreating the wasm instance each time.
  let ffmpegCached = null;
  let ffmpegLoadPromise = null;
  let ffmpegRunning = false;

  async function getOrLoadFFmpeg() {
    if(ffmpegCached) return ffmpegCached;
    if(ffmpegLoadPromise) return ffmpegLoadPromise;
    ffmpegLoadPromise = (async () => {
      await loadScript('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');
      const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
      const FFmpegLib=win.FFmpeg;
      if(!FFmpegLib?.createFFmpeg) throw new Error('FFmpeg global not found');
      const ff=FFmpegLib.createFFmpeg({
        mainName:'main', log:false,
        corePath:'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js'
      });
      await ff.load();
      ffmpegCached=ff;
      return ff;
    })();
    try {
      const ff = await ffmpegLoadPromise;
      ffmpegLoadPromise = null;
      return ff;
    } catch(e) {
      ffmpegLoadPromise = null;
      ffmpegCached = null;
      throw e;
    }
  }

  function loadScript(src) {
    return new Promise((resolve,reject)=>{
      const existing=document.querySelector(`script[src="${src}"]`);
      if(existing){
        // Script tag exists but may still be loading — wait for it
        if(existing.dataset.loaded==='1'){resolve();return;}
        existing.addEventListener('load',()=>{existing.dataset.loaded='1';resolve();},{once:true});
        existing.addEventListener('error',reject,{once:true});
        return;
      }
      const s=document.createElement('script');
      s.src=src;
      s.onload=()=>{s.dataset.loaded='1';resolve();};
      s.onerror=reject;
      document.head.appendChild(s);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── DOWNLOAD ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  async function downloadClip(clip) {
    // Append to the serial queue. The key detail:
    // - _runDownload swallows its own errors internally (try/catch inside it)
    //   so it NEVER rejects — the queue chain stays alive automatically.
    // - We must NOT .catch() on ffmpegQueue itself here, because that would
    //   replace ffmpegQueue with an already-resolved promise, causing the next
    //   call to skip the queue and run immediately (the bug we had before).
    ffmpegQueue = ffmpegQueue.then(() => _runDownload(clip));
    return ffmpegQueue;
  }

  async function _runDownload(clip) {
    const needsTrim=clip.trimIn>0.1||clip.trimOut<clip.duration-0.1;
    // Animated progress bar — fills over estimated duration, no extra CPU
    const estimatedMs = Math.min(30000, Math.max(5000, clip.duration * 800));
    const statusEl = document.getElementById('sc-cst-'+clip.id);
    if(statusEl){
      statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:9px;opacity:0.6;">Converting…</span><div style="flex:1;height:3px;background:rgba(0,0,0,0.12);border-radius:2px;overflow:hidden;"><div id="sc-prog-'+clip.id+'" style="height:100%;width:0%;background:var(--base-primary,#df4e1e);border-radius:2px;transition:width '+estimatedMs+'ms linear;"></div></div></div>';
      statusEl.style.display='';
      requestAnimationFrame(()=>{ const bar=document.getElementById('sc-prog-'+clip.id); if(bar) bar.style.width='90%'; });
    }
    try{
      if(!clip.blobUrl) throw new Error('Clip was deleted before conversion could start');
      const ff = await getOrLoadFFmpeg();
      const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
      const FFmpegLib=win.FFmpeg;
      const{fetchFile}=FFmpegLib;
      if(!fetchFile) throw new Error('fetchFile not found');
      // Wait for any concurrent run to finish — queue serialises calls but
      // ffmpegRunning guards against the wasm internal state not resetting
      let waited=0;
      while(ffmpegRunning && waited<15000){
        await new Promise(res=>setTimeout(res,100)); waited+=100;
      }
      if(ffmpegRunning) throw new Error('FFmpeg still busy after 15s — try again');
      ffmpegRunning=true;
      const inputData=await fetchFile(clip.blobUrl);
      ff.FS('writeFile','input.webm',inputData); // named .webm for ffmpeg input regardless of container

      async function runFFmpeg(args) {
        try { await ff.run(...args); } catch(e) {
          if(!e.message?.includes('exit(0)')) throw e;
        }
      }

      const trimArgs = needsTrim ? ['-ss',clip.trimIn.toFixed(3),'-to',clip.trimOut.toFixed(3)] : [];
      // Copy video stream (no decode/encode — fast), re-encode audio Opus→AAC
      // Opus audio cannot be stream-copied into MP4 container — AAC is required.
      // Audio-only re-encode is negligible CPU cost vs full video re-encode.
      await runFFmpeg([
        '-i','input.webm',...trimArgs,
        '-c','copy',
        '-movflags','+faststart','-y','output.mp4'
      ]);

      let outputData;
      try{ outputData=ff.FS('readFile','output.mp4'); }catch(e){ outputData=null; }
      if(!outputData||outputData.length<1000) throw new Error('MP4 conversion failed — try again');
      triggerDownload(new Blob([outputData.buffer],{type:'video/mp4'}),clip.filename.replace(/\.\w+$/,'.mp4'));
      updateClipStatus(clip.id,'✓ Saved as MP4');
      // Clean up wasm FS
      try{ff.FS('unlink','input.webm');}catch{}
      try{ff.FS('unlink','output.mp4');}catch{}
    }catch(err){
      console.warn('[SOON CLIP] FFmpeg failed:',err.message);
      // Discard cached instance — any failure may leave FFmpeg in a bad state
      ffmpegCached=null;
      updateClipStatus(clip.id,'⚠ MP4 failed — click Save MP4 to retry', true);
    }finally{
      ffmpegRunning=false;
      // Snap progress bar to 100% or reset on completion
      const bar=document.getElementById('sc-prog-'+clip.id);
      if(bar){bar.style.transition='width 0.2s ease';bar.style.width='100%';}
    }
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

    // Multi-cam toggle
    const mcRow=document.createElement('div'); mcRow.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
    const mcLbl=document.createElement('div');
    mcLbl.innerHTML='<span style="font-size:10px;color:rgba(0,0,0,0.65);">Multi-cam mode</span><div style="font-size:9px;opacity:0.45;margin-top:1px;">Record continuously across cam switches</div>';
    const mcBtn=document.createElement('button'); mcBtn.className='sc-toggle-btn';
    const mcOn=()=>localStorage.getItem('sc_multicam')==='1';
    const mcUpdate=()=>{mcBtn.textContent=mcOn()?'ON':'OFF';mcBtn.classList.toggle('sc-toggle-btn--on',mcOn());};
    mcUpdate();
    mcBtn.addEventListener('click',e=>{e.stopPropagation();localStorage.setItem('sc_multicam',mcOn()?'0':'1');mcUpdate();});
    mcRow.appendChild(mcLbl); mcRow.appendChild(mcBtn); panel.appendChild(mcRow);

    const sep=document.createElement('div'); sep.style.cssText='border-top:1px solid rgba(0,0,0,0.1);margin:8px 0 6px;'; panel.appendChild(sep);
    const kbTitle=document.createElement('div'); kbTitle.style.cssText='font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.4;margin-bottom:6px;'; kbTitle.textContent='Keyboard Shortcuts'; panel.appendChild(kbTitle);

    const shortcutAbort = new AbortController();
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
      },{capture:true, signal:shortcutAbort.signal}); // aborted when panel is removed
      row.appendChild(lbl); row.appendChild(btn); panel.appendChild(row);
    }
    makeShortcutRow('Record','sc_key_record');
    makeShortcutRow('Screenshot','sc_key_screenshot');
    panel._abort = shortcutAbort; // exposed so caller can abort on panel removal
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
    let reinjecting = false;

    function inject() {
      if(document.getElementById('sc-root'))return;
      if(reinjecting)return;
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

      const stalePanel = document.getElementById('sc-settings');
      if(stalePanel){ stalePanel._abort?.abort(); stalePanel.remove(); } // clean up listeners + DOM
      const settingsPanel=buildSettingsPanel();
      document.body.appendChild(settingsPanel);

      const body=document.createElement('div'); body.id='sc-body';
      const inner=document.createElement('div'); inner.className='sc-inner';
      inner.innerHTML='<div id="sc-status-row" class="sc-sublabel" style="min-height:13px;"></div><div id="sc-clips-list"></div>';
      body.appendChild(inner); root.appendChild(hdr); root.appendChild(body);

      function initPosition(cb,attempts=0){
        const ftfpMap=document.getElementById('ftfp-map');
        const chatInput=document.getElementById('chat-input');
        if(ftfpMap){ftfpMap.insertAdjacentElement('afterend',root);cb();startRejectionWatcher();return;}
        if(chatInput){
          const insertBefore=chatInput.parentElement?.parentElement?.parentElement;
          if(insertBefore?.parentElement){
            insertBefore.insertAdjacentElement('beforebegin',root);
            cb(); startRejectionWatcher(); return;
          }
        }
        if(attempts<33) setTimeout(()=>initPosition(cb,attempts+1),300);
        else { document.body.appendChild(root); cb(); startRejectionWatcher(); } // fallback
      }

      // Watch for React wiping our root out of the DOM and re-inject cleanly
      function startRejectionWatcher() {
        const obs=new MutationObserver(()=>{
          if(!document.contains(root)){
            obs.disconnect();
            if(reinjecting)return;
            reinjecting=true;
            // Debounce — wait for React to finish hydrating before re-injecting
            setTimeout(()=>{ reinjecting=false; inject(); }, 1000);
          }
        });
        // Watch only direct children of body — avoids firing on every React
        // sub-tree mutation. Our root is always a direct child of its container.
        const watchTarget = root.parentElement || document.body;
        obs.observe(watchTarget,{childList:true});
      }

      initPosition(()=>{
        UI.recIndicator=document.getElementById('sc-rec-indicator');
        UI.statusEl=document.getElementById('sc-status-row');
        UI.clipsList=document.getElementById('sc-clips-list');
        UI.recGroup=document.getElementById('sc-rec-group');
        UI.recFull=document.getElementById('sc-rec-full');
        UI.recCrop=document.getElementById('sc-rec-crop');

        // Per-instance listeners on fresh elements — safe to re-register each injection
        const settingsBtn=document.getElementById('sc-settings-btn');
        settingsBtn.dataset.open='0';
        settingsBtn.addEventListener('click',e=>{
          e.stopPropagation();
          const open=settingsBtn.dataset.open==='1';
          settingsBtn.dataset.open=open?'0':'1';
          if(!open){
            const r=e.currentTarget.getBoundingClientRect();
            settingsPanel.style.top=(r.bottom+4)+'px';
            settingsPanel.style.right=(window.innerWidth-r.right)+'px';
            settingsPanel.style.display='';
          } else {
            settingsPanel.style.display='none';
          }
        });

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

        showStatus('Click ⏺ to record • 📷 to screenshot','');
        console.log('[SOON CLIP] UI injected v5.2.0');
      });
    }

    // Global document listeners — registered ONCE, outside inject(),
    // so they don't stack up on every React-triggered re-injection
    document.addEventListener('click',()=>{
      const panel=document.getElementById('sc-settings');
      if(panel && panel.style.display !== 'none') {
        panel.style.display='none';
        // Reset the settingsOpen flag on whatever inject() instance owns it —
        // find it via the button and simulate a consistent closed state.
        // We can't reach the closure var directly, so we store state on the button.
        const btn=document.getElementById('sc-settings-btn');
        if(btn) btn.dataset.open='0';
      }
    });
    document.addEventListener('keydown',e=>{
      if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
      if(e.key==='Escape'&&frameMode){cancelFrameMode();return;}
      const recKey=getShortcut('sc_key_record'), ssKey=getShortcut('sc_key_screenshot');
      if(recKey&&matchesShortcut(e,recKey)){e.preventDefault();if(recording)stopRecording();else{cropRegion=null;startRecording();}return;}
      if(ssKey&&matchesShortcut(e,ssKey)){e.preventDefault();takeScreenshot(null);}
    },{capture:true});

    // Wait for full page load (React hydration completes after window load on Next.js)
    // then add a small buffer to ensure hydration is done before injecting
    function safeInject() {
      if(document.readyState==='complete') setTimeout(inject, 300);
      else window.addEventListener('load', ()=>setTimeout(inject,300), {once:true});
    }
    safeInject();
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
    if(clip.processing) card.dataset.processing='1';

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
      card.appendChild(hdr); card.appendChild(body);
      // Wire toggle even on processing cards so they're always collapsible
      hdr.querySelector('.sc-card-toggle').addEventListener('click',()=>{
        const open=body.style.display!=='none';
        body.style.display=open?'none':'';
        hdr.querySelector('.sc-card-toggle').textContent=open?'+':'−';
      });
      return card;
    }

    body.innerHTML=`
      <video class="sc-clip-video" src="${clip.blobUrl}" preload="metadata" muted playsinline style="visibility:hidden;height:0;margin:0;"></video>
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

    // Declare dragAbort here so it's in scope for the del button listener below
    const dragAbort = new AbortController();

    hdr.querySelector('.sc-card-toggle').addEventListener('click',()=>{
      const open=body.style.display!=='none';
      body.style.display=open?'none':'';
      hdr.querySelector('.sc-card-toggle').textContent=open?'+':'−';
      // When expanding, kick the video to load if metadata hasn't arrived yet
      // (browsers skip metadata loading for hidden elements)
      if(!open){
        // Switch to full preload when expanded so playback is smooth
        if(video.preload!=='auto') video.preload='auto';
        // If metadata loaded while card was collapsed, the video is still hidden — show it now
        if(video.readyState>=1&&video.style.visibility==='hidden'){
          if(loadingDiv.isConnected) loadingDiv.remove();
          video.style.visibility=''; video.style.height=''; video.style.margin='';
        }
      }
    });
    hdr.querySelector('.sc-dl-btn-sm').addEventListener('click',()=>{
      // Snapshot trim state for a full-clip save — don't mutate clip object
      // since downloadClip is async and the queue may not run until later
      const snapClip=Object.assign({},clip,{trimIn:0,trimOut:clip.duration});
      downloadClip(snapClip);
    });
    hdr.querySelector('.sc-del-btn').addEventListener('click',()=>{
      URL.revokeObjectURL(clip.blobUrl); clip.blobUrl=null;
      if(clip.thumbUrl){URL.revokeObjectURL(clip.thumbUrl); clip.thumbUrl=null;}
      clips.splice(clips.findIndex(c=>c.id===clip.id),1);
      dragAbort.abort(); // clean up drag listeners
      card.remove();
    });

    const video=body.querySelector('.sc-clip-video');
    const loadingDiv=document.createElement('div'); loadingDiv.style.cssText='padding:20px;text-align:center;font-size:10px;opacity:0.5;'; loadingDiv.textContent='Loading…';
    body.insertBefore(loadingDiv,video);
    // video is visibility:hidden;height:0 until loadedmetadata fires
    // This keeps it in the DOM so Chrome loads the blob regardless of card expand state
    let videoErrorShown = false;
    video.addEventListener('error',()=>{
      if(videoErrorShown) return; // don't show twice or loop
      videoErrorShown = true;
      if(loadingDiv.isConnected) loadingDiv.remove();
      const errDiv=document.createElement('div');
      errDiv.style.cssText='padding:10px 6px;text-align:center;font-size:10px;color:rgba(0,0,0,0.45);background:rgba(0,0,0,0.05);border-radius:3px;margin-top:5px;';
      errDiv.textContent='Preview unavailable — use Save MP4 to download';
      video.insertAdjacentElement('afterend',errDiv);
      video.style.visibility='hidden'; video.style.height='0'; video.style.margin='0';
    });

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
    // MUST be attached before any video.load() call below, otherwise the event
    // can fire before the listener is registered and the video stays hidden forever
    function revealVideo() {
      if(loadingDiv.isConnected) loadingDiv.remove();
      video.style.visibility=''; video.style.height=''; video.style.margin='';
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        clip.duration = video.duration;
        clip.trimOut  = video.duration;
        updateTrim();
      } else if (!isFinite(video.duration)) {
        video.currentTime = 1e10;
        video.addEventListener('seeked', () => {
          if (isFinite(video.duration) && video.duration > 0) {
            clip.duration = video.duration;
            clip.trimOut  = video.duration;
            updateTrim();
          }
          video.currentTime = 0;
        }, { once: true });
      }
    }

    video.addEventListener('loadedmetadata', revealVideo, { once: true });

    playBtn.addEventListener('click',()=>{
      if(video.paused){
        video.currentTime=Math.max(clip.trimIn,video.currentTime);
        // Don't call video.load() here — it resets the decoder and can trigger
        // new error events causing a crash loop. Just play() and let it buffer.
        video.play().catch(()=>{});
      }else video.pause();
    });
    video.addEventListener('play',()=>{playBtn.textContent='⏸';});
    video.addEventListener('pause',()=>{playBtn.textContent='▶';});
    video.addEventListener('ended',()=>{playBtn.textContent='▶';video.currentTime=clip.trimIn;});

    const muteBtn=body.querySelector('.sc-mute-btn'); video.muted=true;
    muteBtn.addEventListener('click',()=>{video.muted=!video.muted;muteBtn.textContent=video.muted?'🔇':'🔊';});

    function safeSeek(time){
      if(video.readyState<1) return; // not loaded enough to seek
      const wasPlaying=!video.paused;
      const t=Math.max(clip.trimIn,Math.min(clip.trimOut,time));
      try{
        video.currentTime=t;
        // Resume if was playing — seek interrupts playback
        if(wasPlaying){
          video.addEventListener('seeked',()=>video.play().catch(()=>{}),{once:true});
        }
      }catch(e){}
    }
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
    },{signal:dragAbort.signal});
    document.addEventListener('mouseup',()=>{drag=null;},{signal:dragAbort.signal});
    // Clean up global listeners when card is deleted
    hdr.querySelector('.sc-del-btn').addEventListener('click',()=>dragAbort.abort(),{once:true});

    body.querySelectorAll('.sc-qbtn[data-sec]').forEach(btn=>btn.addEventListener('click',()=>{clip.trimOut=Math.min(clip.duration,clip.trimIn+parseInt(btn.dataset.sec));updateTrim();video.currentTime=clip.trimIn;}));
    body.querySelector('.sc-qbtn-reset').addEventListener('click',()=>{clip.trimIn=0;clip.trimOut=clip.duration;updateTrim();});
    body.querySelector('.sc-dl-btn').addEventListener('click',()=>downloadClip(clip));

    updateTrim();
    return card;
  }

  function updateClipStatus(clipId,msg,isErr=false){const el=document.getElementById('sc-cst-'+clipId);if(el){el.textContent=msg;el.style.display=msg?'':'none';el.style.color=isErr?'var(--base-primary,#df4e1e)':'';el.style.fontWeight=isErr?'700':'';}}
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

      #sc-settings { position:fixed;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border:1px solid rgba(0,0,0,0.2);border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:2147483640;padding:10px;min-width:230px; }
      .sc-toggle-btn { font-size:10px;font-weight:700;padding:2px 8px;background:rgba(0,0,0,0.1);border:1px solid rgba(0,0,0,0.2);border-radius:3px;cursor:pointer;min-width:40px;text-align:center;transition:background 0.1s,color 0.1s; }
      .sc-toggle-btn--on { background:rgba(223,78,30,0.15);border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }

      #sc-body { background:var(--base-light,#dddec4);background-image:var(--base-texture-background); }
      .sc-inner { padding:8px;display:flex;flex-direction:column;gap:8px; }
      #sc-clips-list { max-height:520px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(0,0,0,0.2) transparent; }
      #sc-clips-list::-webkit-scrollbar { width:4px; }
      #sc-clips-list::-webkit-scrollbar-track { background:transparent; }
      #sc-clips-list::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.2);border-radius:2px; }
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

  function init(){
    addStyles();
    buildUI();
    // Tear down any active recording on navigation — prevents MediaRecorder and
    // timers from leaking into an unloaded page context.
    window.addEventListener('beforeunload', () => {
      if (activeSession?.isActive) activeSession.destroy();
    });
  }
  init();

})();
