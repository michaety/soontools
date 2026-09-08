// ==UserScript==
// @name         Soon Clipper
// @namespace    https://fishtank.news
// @version      1.5.36
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

  // Some cams are mounted sideways and the site rotates them upright with a CSS
  // transform (on the <video> itself or an ancestor) rather than actually
  // re-encoding the stream. canvas.drawImage() samples the raw decoded frame,
  // which ignores that transform entirely — so screenshots/recordings of a
  // rotated cam come out sideways unless we detect and replicate the rotation.
  function getVideoRotationDeg(vid) {
    let matrix = new DOMMatrix();
    for (let el = vid; el && el !== document.documentElement; el = el.parentElement) {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        try { matrix = new DOMMatrix(t).multiply(matrix); } catch (e) {}
      }
    }
    const deg = Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI / 90) * 90;
    return ((deg % 360) + 360) % 360; // normalise to 0/90/180/270
  }

  // Draws vid onto ctx at (0,0) sized vw×vh, applying the rotation detected by
  // getVideoRotationDeg. Caller must size the canvas to match (swap w/h for 90/270).
  function drawRotatedFrame(ctx, vid, vw, vh, rotation) {
    if (!rotation) { ctx.drawImage(vid, 0, 0, vw, vh); return; }
    // save/restore since ctx transform state persists across calls unless the
    // canvas's own width/height is reassigned — this can be called every frame
    // with unchanged canvas dimensions, so it must not accumulate rotations.
    ctx.save();
    switch (rotation) {
      case 90:  ctx.translate(vh, 0); ctx.rotate(Math.PI / 2); break;
      case 180: ctx.translate(vw, vh); ctx.rotate(Math.PI); break;
      case 270: ctx.translate(0, vw); ctx.rotate(-Math.PI / 2); break;
    }
    ctx.drawImage(vid, 0, 0, vw, vh);
    ctx.restore();
  }

  // ctx.shadowBlur is a real per-pixel software blur, not a GPU effect — cheap
  // once, expensive if re-run every frame for a rect that isn't actually
  // changing (e.g. a static crop-recording border drawn at 30fps for up to 5
  // minutes). This renders the glowing stroke to an offscreen canvas once per
  // distinct size/position and reuses it until the caller asks for a different
  // one — pass the same `cache` object (e.g. `{}` created once outside the
  // draw loop) across calls so it persists between frames.
  function drawCachedGlowRect(ctx, cache, x, y, w, h, color, blur, lineWidth, lineDash) {
    const key = x+'|'+y+'|'+w+'|'+h+'|'+color+'|'+blur+'|'+lineWidth+'|'+(lineDash||'');
    if (cache.key !== key) {
      const pad = Math.ceil(blur * 3) + lineWidth; // shadow can extend ~3x its blur radius
      const gc = cache.canvas || document.createElement('canvas');
      gc.width = Math.ceil(w + pad*2); gc.height = Math.ceil(h + pad*2);
      const gctx = gc.getContext('2d');
      gctx.shadowColor = color; gctx.shadowBlur = blur;
      gctx.strokeStyle = color; gctx.lineWidth = lineWidth;
      if (lineDash) gctx.setLineDash(lineDash);
      gctx.strokeRect(pad, pad, w, h);
      cache.canvas = gc; cache.pad = pad; cache.key = key;
    }
    ctx.drawImage(cache.canvas, x - cache.pad, y - cache.pad);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FRAME MODE ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function enterFrameMode() {
    const vid = getVideoEl();
    if (!vid) { showStatus('No video found', 'err'); return; }
    frameMode = true; cropRegion = null;
    let dragStart = null;
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
    const idleGlowCache={}; // persists across frames — see drawCachedGlowRect
    function updateCanvas(ts) {
      if (!document.getElementById('sc-crop-canvas')) return;
      if(document.hidden||ts-lastOverlayDraw<33){requestAnimationFrame(updateCanvas);return;} // ~30fps, skip when tab backgrounded
      lastOverlayDraw=ts;
      const r = getVidRect();
      canvas.style.left = r.left+'px'; canvas.style.top = r.top+'px';
      // Reassigning width/height reallocates the backing store — only do it on change
      const cw = Math.round(r.width), ch = Math.round(r.height);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
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
        // Static (no dash animation here) — fully cacheable across frames.
        drawCachedGlowRect(ctx,idleGlowCache,1,1,canvas.width-2,canvas.height-2,'#df4e1e',8,2,[6,4]);
      }
      requestAnimationFrame(updateCanvas);
    }
    updateCanvas(0);

    const hint = document.createElement('div');
    hint.id = 'sc-hint';
    hint.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);color:white;font-size:12px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;letter-spacing:0.05em;text-transform:uppercase;pointer-events:none;background:rgba(0,0,0,0.75);padding:6px 14px;border-radius:4px;z-index:2147483647;white-space:nowrap;border:1px solid rgba(223,78,30,0.5);';
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
      if (action==='record') {
        startRecording(); // startRecording handles its own button state
      } else {
        // Reset button back to normal state — frame mode is over
        updateRecordBtn(false, false);
        if (action==='screenshot') {
          const region = cropRegion;
          cropRegion = null; // clear immediately — don't let it affect recording
          takeScreenshot(region);
        }
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
  const _assets = { logoImg: null, logoReady: false, staticSoundBuf: null };

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
    // Preload static/cam-switch sound — fetch the raw bytes now, decode later
    // when AudioContext is available (avoids creating AudioContext before user interaction)
    if(!_assets.staticSoundBuf && !_assets._staticSoundRaw) {
      _assets._staticSoundRaw = 'loading';
      GM_xmlhttpRequest({
        method:'GET', url:'https://cdn.fishtank.live/sounds/chunk-short.mp3',
        responseType:'arraybuffer',
        onload: r => { _assets._staticSoundRaw = r.response; _decodeStaticSound(); },
        onerror: () => { _assets._staticSoundRaw = null; }
      });
    } else if (_assets._staticSoundRaw && _assets._staticSoundRaw !== 'loading' && !_assets.staticSoundBuf) {
      _decodeStaticSound(); // raw bytes ready but AudioContext wasn't available last time
    }
  }

  function _decodeStaticSound() {
    if (_assets.staticSoundBuf || !_assets._staticSoundRaw || _assets._staticSoundRaw === 'loading' || !sharedAudioCtx) return;
    const raw = _assets._staticSoundRaw;
    _assets._staticSoundRaw = null; // consume — decodeAudioData detaches the buffer
    sharedAudioCtx.decodeAudioData(raw).then(buf => {
      _assets.staticSoundBuf = buf;
      console.log('[SOON CLIP] Static sound decoded:', buf.duration.toFixed(1) + 's');
    }).catch(() => { _assets.staticSoundBuf = null; });
  }

  class RecordingSession {
    constructor(cropRegion) {
      this.cropRegion  = cropRegion || null;
      this._rotation   = 0; // set in start() — degrees the source cam is CSS-rotated by
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
      this._vid        = null;        // current video element (updated on cam switch)
      this._lastSrc    = null;        // tracks src for split detection
      this._splitDebounce = false;
      this._goneCount  = 0;
      this.multiCam    = false; // set true for continuous multi-cam mode
      this._stopTime   = null;  // set in stop() to accurately calculate duration

      // Offscreen canvas for static noise — created once per session
      this._staticCanvas = document.createElement('canvas');
      this._staticCanvas.width = 80; this._staticCanvas.height = 45;
      this._staticCtx = this._staticCanvas.getContext('2d');

      // Static sound state — plays chunk-short.mp3 into the recording during cam switches
      this._staticSoundNode = null;
      this._staticSoundGain = null;
      this._staticSoundPlaying = false; // true while sound is active OR already played this gap
      this._staticSoundFired = false;   // true once fired for current static gap, reset when stream returns

      // rAF state — bind the callback once instead of allocating a closure per frame
      this._lastDrawTs = 0;
      this._boundDraw = ts => this._drawFrame(ts);
    }

    async start() {
      const vid = getVideoEl();
      if (!vid) throw new Error('No video found');
      this._vid = vid;
      this._lastSrc = vid.currentSrc || vid.src;

      // AudioContext — shared across sessions, must survive
      if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
      if (sharedAudioCtx.state === 'suspended') await sharedAudioCtx.resume().catch(() => {});
      _loadAssets();

      // Canvas — some cams are mounted sideways and shown upright via a CSS
      // rotation the site applies; replicate it here since captureStream()
      // only sees the raw (unrotated) decoded frame.
      const vw = vid.videoWidth || 1920, vh = vid.videoHeight || 1080;
      this._rotation = this.cropRegion ? 0 : getVideoRotationDeg(vid); // crop coords are screen-space already; skip there
      const swapped = this._rotation===90 || this._rotation===270;
      this._canvas = document.createElement('canvas');
      this._canvas.width = swapped?vh:vw; this._canvas.height = swapped?vw:vh;
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
      requestAnimationFrame(this._boundDraw);

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
      this._stopStaticSound();
      if (this._audioNode && this._audioDst) {
        try { this._audioNode.disconnect(this._audioDst); } catch {}
      }
      this._audioNode = this._audioDst = null;
    }

    _startStaticSound() {
      if (this._staticSoundFired) return; // already played for this static gap
      const buf = _assets.staticSoundBuf;
      if (!buf || buf === 'loading' || !sharedAudioCtx || !this._audioDst) return;
      try {
        const src = sharedAudioCtx.createBufferSource();
        src.buffer = buf;
        const gain = sharedAudioCtx.createGain();
        gain.gain.value = 0.4; // mix at 40% to not overpower
        src.onended = () => { this._staticSoundPlaying = false; }; // natural end cleanup
        src.connect(gain);
        // Route into the recording stream
        gain.connect(this._audioDst);
        // Also route to speakers so user hears it live
        gain.connect(sharedAudioCtx.destination);
        src.start();
        this._staticSoundNode = src;
        this._staticSoundGain = gain;
        this._staticSoundPlaying = true;
        this._staticSoundFired = true; // prevent re-triggering until stream returns
      } catch(e) {
        console.warn('[SOON CLIP] Static sound start failed:', e.message);
      }
    }

    _stopStaticSound() {
      if (!this._staticSoundPlaying) return;
      try {
        this._staticSoundNode?.stop();
        this._staticSoundNode?.disconnect();
        this._staticSoundGain?.disconnect();
      } catch(e) {}
      this._staticSoundNode = null;
      this._staticSoundGain = null;
      this._staticSoundPlaying = false;
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
        requestAnimationFrame(this._boundDraw);
        return;
      }
      this._lastDrawTs = ts;

      // Prefer cached vid — only call getVideoEl() when it's stale
      const cv = (this._vid?.readyState >= 2 && !this._vid.paused) ? this._vid : getVideoEl();
      if (!cv || cv.readyState < 2) {
        // Multi-cam: draw static to fill stream load gap
        // Split-clip: hold last frame (canvas retains it) — no static in the clip
        if (this.multiCam) {
          this._drawStatic(this._canvas.width, this._canvas.height);
          this._startStaticSound();
        }
        requestAnimationFrame(this._boundDraw);
        return;
      }
      // Stream is back — stop static sound and reset for next gap
      this._stopStaticSound();
      this._staticSoundFired = false;
      if (cv !== this._vid) {
        this._vid = cv;
        // Split-clip: cam change handled by _watchCam stopping the recording
        // Multi-cam: no static here — readyState < 2 path already covered the
        // loading gap. Adding frames here after the stream is ready causes a
        // second static burst immediately after the first one clears.
      }
      const cr = this.cropRegion;
      const vw = cv.videoWidth || 1920, vh = cv.videoHeight || 1080;
      if (cr) {
        const cw = Math.round(cr.w * vw), ch = Math.round(cr.h * vh);
        if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
        this._ctx.drawImage(cv, cr.x*vw, cr.y*vh, cr.w*vw, cr.h*vh, 0, 0, cw, ch);
      } else {
        const swapped = this._rotation===90 || this._rotation===270;
        const cw = swapped?vh:vw, ch = swapped?vw:vh;
        if (this._canvas.width !== cw || this._canvas.height !== ch) { this._canvas.width = cw; this._canvas.height = ch; }
        drawRotatedFrame(this._ctx, cv, vw, vh, this._rotation);
      }
      requestAnimationFrame(this._boundDraw);
    }

    _watchCam() {
      if (!this.isActive) return;
      const cv = (this._vid?.readyState >= 2 && !this._vid.paused) ? this._vid : getVideoEl();
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
          // stopRecording() clears activeSession synchronously, so the actual
          // wait for _onStop's audio teardown to finish (avoiding a double
          // audio-connect) is this fixed 1s delay, not the check below — that
          // check only guards against the user manually starting a new
          // recording during this window.
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

  // Patches the EBML Duration element and returns Blob parts for the fixed file.
  // Only the first few KB are read into memory — the rest of the (potentially
  // 100MB+) recording stays a lazy Blob slice instead of a full heap copy.
  const WEBM_HEAD_BYTES = 4096;
  async function fixWebmDuration(chunks,durationSec) {
    const whole=new Blob(chunks);
    const head=await whole.slice(0,WEBM_HEAD_BYTES).arrayBuffer();
    const data=new Uint8Array(head), view=new DataView(head);
    const scanLimit = Math.min(data.length - 12, 2048); // Duration is always in first ~200 bytes
    for(let i=0;i<scanLimit;i++){
      if(data[i]===0x44&&data[i+1]===0x89){
        const st=data[i+2];
        if(st===0x88){view.setFloat64(i+3,durationSec*1000,false);break;}
        if(st===0x84){view.setFloat32(i+3,durationSec*1000,false);break;}
      }
    }
    return [head, whole.slice(WEBM_HEAD_BYTES)];
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
      if(old._previewFixedUrl){URL.revokeObjectURL(old._previewFixedUrl);old._previewFixedUrl=null;}
      old._dragAbort?.abort(); // card's trim-handle drag listeners are on `document` — must abort even when evicted, not just manually deleted
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

    // MP4 needs no patching — hand the recorder chunks straight to the Blob
    // constructor (zero-copy; a Blob of Blobs is lazy). WebM reads only its
    // first few KB to patch Duration. Previously both paths pulled the entire
    // recording into an ArrayBuffer — ~150MB for a 5-min clip — on the main
    // thread, just to wrap it back into a Blob.
    const buildParts = mimeType.startsWith('video/mp4')
      ? Promise.resolve(chunksSnapshot)
      : fixWebmDuration(chunksSnapshot,durationSec);
    buildParts.then(parts=>{
      clearInterval(pt);
      const blob=new Blob(parts,{type:mimeType});
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
    const glowCache={}; // persists across frames — see drawCachedGlowRect
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
      // Reassigning width/height reallocates the backing store — only do it on change
      const cw=Math.round(rw), ch=Math.round(rh);
      if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
      ctx.clearRect(0,0,canvas.width,canvas.height);
      const cx=rx-cLeft, cy=ry-cTop;
      // Round to whole pixels before caching — getBoundingClientRect can jitter
      // by sub-pixel fractions between otherwise-identical frames, which would
      // otherwise bust the cache key every frame and defeat the point.
      drawCachedGlowRect(ctx,glowCache,Math.round(cx),Math.round(cy),Math.round(rw2),Math.round(rh2),'#df4e1e',10,2);
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
  // VP8/VP9 WebM falls back to full H.264 re-encode via ffmpeg.wasm (slower but Twitter-compatible).
  const SUPPORTED_MIME = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 avc1 + AAC — Twitter/X compatible
    'video/mp4;codecs=avc1',                    // H.264 avc1 generic
    'video/mp4;codecs=avc3.42E01E,mp4a.40.2', // H.264 avc3 fallback — handles resolution changes but Twitter rejects avc3
    'video/mp4;codecs=avc3',                    // H.264 avc3, any AAC
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
  let ffmpegCached = null;
  let ffmpegLoadPromise = null;

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

  // Shared by _runDownload and _runPreviewRepair — both stream-copy (or, for
  // WebM, re-encode) the recorder's raw output into a clean, faststart MP4.
  // Callers are always serialized through ffmpegQueue, so reusing fixed temp
  // filenames across both call sites is safe (never runs concurrently).
  async function remuxToMp4(ff, blobUrl, mimeType, trim) {
    const win=(typeof unsafeWindow!=='undefined')?unsafeWindow:window;
    const FFmpegLib=win.FFmpeg;
    const{fetchFile}=FFmpegLib;
    if(!fetchFile) throw new Error('fetchFile not found');
    const inputData=await fetchFile(blobUrl);
    ff.FS('writeFile','sc-input.webm',inputData); // named .webm for ffmpeg input regardless of container

    // -ss before -i for input-level seeking (accurate keyframe seek with -c copy)
    // Use -t (duration) instead of -to (absolute) since -ss before -i resets timestamps to 0
    const seekArgs = trim ? ['-ss',trim.in.toFixed(3)] : [];
    const durArgs  = trim ? ['-t',(trim.out-trim.in).toFixed(3)] : [];
    // Strategy per source codec:
    //   avc1 MP4 → stream copy (fast, Twitter-compatible)
    //   avc3 MP4 → stream copy + tag as avc1 (fast, fixes Twitter rejection)
    //   WebM VP8/VP9 → full H.264 re-encode (slow but necessary)
    const isWebm = mimeType?.startsWith('video/webm');
    const isAvc3 = mimeType?.includes('avc3');
    const codecArgs = isWebm
      ? ['-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p',
         '-c:a','aac','-b:a','128k']
      : ['-c','copy'];
    // avc3 is bitstream-identical to avc1 — just tag it as avc1 for Twitter
    const tagArgs = isAvc3 ? ['-tag:v','avc1'] : [];
    try {
      await ff.run(...seekArgs,'-i','sc-input.webm',...durArgs,...codecArgs,...tagArgs,'-movflags','+faststart','-y','sc-output.mp4');
    } catch(e) {
      if(!e.message?.includes('exit(0)')) throw e;
    }

    let outputData;
    try{ outputData=ff.FS('readFile','sc-output.mp4'); }catch(e){ outputData=null; }
    try{ff.FS('unlink','sc-input.webm');}catch{}
    try{ff.FS('unlink','sc-output.mp4');}catch{}
    if(!outputData||outputData.length<1000) throw new Error('MP4 conversion failed — try again');
    return outputData;
  }

  async function _runDownload(clip) {
    const needsTrim=clip.trimIn>0.1||clip.trimOut<clip.duration-0.1;
    // Animated progress bar — fills over estimated duration, no extra CPU
    const isReencode = clip.mimeType?.startsWith('video/webm');
    const estimatedMs = Math.min(isReencode?120000:30000, Math.max(5000, clip.duration * (isReencode?4000:800)));
    const statusEl = document.getElementById('sc-cst-'+clip.id);
    if(statusEl){
      statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:9px;opacity:0.6;">'+(isReencode?'Re-encoding to H.264…':'Converting…')+'</span><div style="flex:1;height:3px;background:rgba(0,0,0,0.12);border-radius:2px;overflow:hidden;"><div id="sc-prog-'+clip.id+'" style="height:100%;width:0%;background:var(--base-primary,#df4e1e);border-radius:2px;transition:width '+estimatedMs+'ms linear;"></div></div></div>';
      statusEl.style.display='';
      requestAnimationFrame(()=>{ const bar=document.getElementById('sc-prog-'+clip.id); if(bar) bar.style.width='90%'; });
    }
    try{
      if(!clip.blobUrl) throw new Error('Clip was deleted before conversion could start');
      const ff = await getOrLoadFFmpeg();
      const outputData = await remuxToMp4(ff,clip.blobUrl,clip.mimeType,needsTrim?{in:clip.trimIn,out:clip.trimOut}:null);
      triggerDownload(new Blob([outputData.buffer],{type:'video/mp4'}),clip.filename.replace(/\.\w+$/,'.mp4'));
      updateClipStatus(clip.id,'✓ Saved as MP4');
    }catch(err){
      console.warn('[SOON CLIP] FFmpeg failed:',err.message);
      // Discard cached instance — any failure may leave FFmpeg in a bad state
      ffmpegCached=null;
      updateClipStatus(clip.id,'⚠ MP4 failed — click Save MP4 to retry', true);
    }finally{
      // Snap progress bar to 100% or reset on completion
      const bar=document.getElementById('sc-prog-'+clip.id);
      if(bar){bar.style.transition='width 0.2s ease';bar.style.width='100%';}
    }
  }

  // MediaRecorder's raw MP4/WebM output is a streaming-oriented container (moov
  // often missing/trailing) that Chrome's plain <video src=blob> demuxer can
  // refuse to play even though the bytes are perfectly valid — the same fast
  // stream-copy remux that downloadClip already relies on (-movflags +faststart)
  // fixes this. Run it once, automatically, before giving up on the preview.
  async function repairPreview(clip,video) {
    if(clip._previewRepairAttempted) return false;
    clip._previewRepairAttempted = true;
    ffmpegQueue = ffmpegQueue.then(()=>_runPreviewRepair(clip,video));
    return ffmpegQueue;
  }

  async function _runPreviewRepair(clip,video) {
    try{
      if(!clip.blobUrl) return false;
      const ff = await getOrLoadFFmpeg();
      const outputData = await remuxToMp4(ff,clip.blobUrl,clip.mimeType,null);
      if(clip._previewFixedUrl) URL.revokeObjectURL(clip._previewFixedUrl);
      clip._previewFixedUrl = URL.createObjectURL(new Blob([outputData.buffer],{type:'video/mp4'}));
      if(!video.isConnected) return false; // card was removed while we were working
      video.src = clip._previewFixedUrl;
      video.load();
      return true;
    }catch(e){
      console.warn('[SOON CLIP] Preview repair failed:',e.message);
      ffmpegCached=null; // failure may leave FFmpeg in a bad state
      return false;
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
      const rotation=getVideoRotationDeg(vid);
      const swapped=rotation===90||rotation===270;
      canvas.width=swapped?vh:vw; canvas.height=swapped?vw:vh;
      drawRotatedFrame(canvas.getContext('2d'),vid,vw,vh,rotation);
    }
    canvas.toBlob(blob=>{
      const filename='soontools_screenshot_'+Date.now()+'.png';
      const blobUrl=URL.createObjectURL(blob);
      const ss={id:Date.now(),blob,blobUrl,filename,label:(window.SOON.activeRoom?.label||'Screenshot')+' — '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
      screenshots.unshift(ss);
      if(screenshots.length>5){const e=screenshots.pop();URL.revokeObjectURL(e.blobUrl);}
      renderQueue();
      triggerDownload(blob,filename);
      try{navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);}catch(_){}
      showStatus('Screenshot saved + copied ✓','ok');
      vid.style.outline='3px solid #df4e1e';
      setTimeout(()=>{vid.style.outline='';},400);
    },'image/png');
  }

  function enterCropScreenshot(){pendingAction='screenshot';enterFrameMode();}

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SETTINGS ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function buildSettingsPanel(root, reinject) {
    const panel=document.createElement('div');
    panel.id='sc-settings';
    panel.style.cssText='display:none;position:absolute;right:0;top:100%;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border:1px solid rgba(0,0,0,0.2);border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9999;padding:10px;min-width:200px;';

    const title=document.createElement('div');
    title.style.cssText='font-size:10px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.5;margin-bottom:8px;';
    title.textContent='Settings'; panel.appendChild(title);

    // iOS-style on/off switch — used for the two boolean settings below.
    // (Keyboard-shortcut capture buttons further down show text, not a bool,
    // so they keep the plain .sc-toggle-btn chrome instead of this.)
    function buildSwitch(checked,onChange,ariaLabel){
      const label=document.createElement('label'); label.className='sc-switch';
      const input=document.createElement('input'); input.type='checkbox'; input.checked=checked;
      if(ariaLabel) input.setAttribute('aria-label',ariaLabel); // adjacent text isn't <label>-associated, so screen readers need this explicitly
      const track=document.createElement('span'); track.className='sc-switch-track';
      label.appendChild(input); label.appendChild(track);
      label.addEventListener('click',e=>e.stopPropagation());
      input.addEventListener('change',()=>onChange(input.checked));
      return label;
    }

    // Multi-cam toggle
    const mcRow=document.createElement('div'); mcRow.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
    const mcLbl=document.createElement('div');
    mcLbl.innerHTML='<span style="font-size:10px;color:var(--base-dark-text,rgb(25,28,32));opacity:0.65;">Multi-cam mode</span><div style="font-size:9px;opacity:0.45;margin-top:1px;">Record continuously across cam switches</div>';
    const mcSwitch=buildSwitch(localStorage.getItem('sc_multicam')==='1',checked=>{localStorage.setItem('sc_multicam',checked?'1':'0');},'Multi-cam mode');
    mcRow.appendChild(mcLbl); mcRow.appendChild(mcSwitch); panel.appendChild(mcRow);

    // Placement toggle — left panel vs chat sidebar. Switch ON = docked left.
    const plRow=document.createElement('div'); plRow.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;';
    const plLbl=document.createElement('div');
    plLbl.innerHTML='<span style="font-size:10px;color:var(--base-dark-text,rgb(25,28,32));opacity:0.65;">Left side</span><div style="font-size:9px;opacity:0.45;margin-top:1px;">On docks Clip in the left panel, off docks it by chat</div>';
    const plSwitch=buildSwitch(localStorage.getItem('sc_placement')!=='chat',checked=>{
      localStorage.setItem('sc_placement',checked?'left':'chat');
      // Re-inject at new position
      root.remove();
      reinject();
    },'Left side placement');
    plRow.appendChild(plLbl); plRow.appendChild(plSwitch); panel.appendChild(plRow);

    const sep=document.createElement('div'); sep.style.cssText='border-top:1px solid rgba(0,0,0,0.1);margin:8px 0 6px;'; panel.appendChild(sep);
    const kbTitle=document.createElement('div'); kbTitle.style.cssText='font-size:9px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.4;margin-bottom:6px;'; kbTitle.textContent='Keyboard Shortcuts'; panel.appendChild(kbTitle);

    const shortcutAbort = new AbortController();
    function makeShortcutRow(label,key){
      const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;';
      const lbl=document.createElement('span'); lbl.style.cssText='font-size:10px;color:var(--base-dark-text,rgb(25,28,32));opacity:0.65;flex:1;'; lbl.textContent=label;
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
    makeShortcutRow('Crop Record','sc_key_crop_record');
    makeShortcutRow('Crop Screenshot','sc_key_crop_screenshot');
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

  // Native Tailwind chrome classes copied verbatim off the site's own buttons
  // (icon-row, Missions-reset, Shop, and collapse buttons) — shared by inject()
  // and updateRecordBtn() so button state changes don't fall back to plain CSS.
  const NATIVE_DARK_BTN='bg-gradient-to-r from-dark-400/75 to-dark-500/75 p-0.5 inline-flex items-center justify-center cursor-pointer rounded-md hover:brightness-105 focus-visible:outline-1 focus-visible:outline-tertiary text-light-text w-[24px] h-[24px]';
  const NATIVE_DANGER_BTN='bg-gradient-to-r from-danger-500 to-danger-600/75 active:to-danger-700/90 p-0.5 inline-flex items-center justify-center cursor-pointer rounded-md hover:brightness-105 focus-visible:outline-1 focus-visible:outline-tertiary text-light-text w-[24px] h-[24px]';
  const NATIVE_PRIMARY_BTN='bg-gradient-to-r from-primary-400 to-primary-500/90 active:to-primary-600/75 p-0.5 inline-flex items-center justify-center cursor-pointer rounded-md hover:brightness-105 focus-visible:outline-1 focus-visible:outline-tertiary text-light-text w-[24px] h-[24px]';
  const SC_ICON_ATTRS='viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const SC_CORNERS='<path d="M4 9V6a2 2 0 0 1 2-2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M9 20H6a2 2 0 0 1-2-2v-3"/>';
  const SC_CAMERA='<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>';
  const ICON_SCREENSHOT=`<svg ${SC_ICON_ATTRS}>${SC_CAMERA}</svg>`;
  const ICON_CROP_SCREENSHOT=`<svg ${SC_ICON_ATTRS}>${SC_CORNERS}<g transform="translate(12,12) scale(0.62) translate(-12,-12)">${SC_CAMERA}</g></svg>`;
  const ICON_RECORD=`<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>`;
  const ICON_CROP_RECORD=`<svg ${SC_ICON_ATTRS}>${SC_CORNERS}<circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none"/></svg>`;
  const ICON_STOP=`<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>`;
  const ICON_SETTINGS=`<svg ${SC_ICON_ATTRS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  function buildUI() {
    let reinjecting = false;

    function inject() {
      if(document.getElementById('sc-root'))return;
      if(reinjecting)return;
      const root=document.createElement('div'); root.id='sc-root';

      const hdr=document.createElement('div'); hdr.className='sc-hdr';
      hdr.innerHTML=`
        <span class="sc-hdr-title">Clip</span>
        <span id="sc-rec-indicator" class="sc-rec-indicator" style="display:none;"></span>
        <div style="margin-left:auto;display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end;row-gap:4px;">
          <div class="sc-btn-group">
            <button id="sc-ss-full" class="sc-icon-btn ${NATIVE_DARK_BTN}" title="Screenshot">${ICON_SCREENSHOT}</button>
            <button id="sc-ss-crop" class="sc-icon-btn ${NATIVE_DARK_BTN}" title="Crop screenshot">${ICON_CROP_SCREENSHOT}</button>
          </div>
          <div class="sc-btn-group" id="sc-rec-group">
            <button id="sc-rec-full" class="sc-rec-btn ${NATIVE_DANGER_BTN}" title="Record fullscreen">${ICON_RECORD}</button>
            <button id="sc-rec-crop" class="sc-rec-btn sc-rec-btn--crop ${NATIVE_DANGER_BTN}" title="Record selection">${ICON_CROP_RECORD}</button>
          </div>
          <button id="sc-settings-btn" class="sc-icon-btn ${NATIVE_DARK_BTN}" title="Settings">${ICON_SETTINGS}</button>
          <button id="sc-toggle" class="sc-toggle-collapse ${NATIVE_PRIMARY_BTN}" title="Collapse"></button>
        </div>`;

      const stalePanel = document.getElementById('sc-settings');
      if(stalePanel){ stalePanel._abort?.abort(); stalePanel.remove(); } // clean up listeners + DOM
      const settingsPanel=buildSettingsPanel(root, inject);
      document.body.appendChild(settingsPanel);

      const body=document.createElement('div'); body.id='sc-body';
      const inner=document.createElement('div'); inner.className='sc-inner';
      inner.innerHTML='<div id="sc-status-row" class="sc-sublabel" style="min-height:13px;"></div><div id="sc-clips-list"></div>';
      body.appendChild(inner); root.appendChild(hdr); root.appendChild(body);

      // Find the left game-panel column (Events / Missions / Inventory stack).
      // Matched by its stable "left-0" positioning class rather than its current
      // on-screen position — the column slides in from off-screen on load, so a
      // bounding-rect check can catch it mid-animation and wrongly conclude it
      // isn't there yet.
      function findLeftPanel() {
        const ftfpMap=document.getElementById('ftfp-map');
        if(ftfpMap?.parentElement) return ftfpMap.parentElement;
        for(const el of document.querySelectorAll('div[class*="left-0"]')){
          let target = el;
          // Unwrap single-child positioning shells to reach the actual card column
          while(target.children.length===1 && target.firstElementChild.tagName==='DIV') target = target.firstElementChild;
          const r=target.getBoundingClientRect();
          if(r.width>=150 && r.width<=320 && r.height>=200 && target.children.length>=2 && target.children.length<=8) return target;
        }
        return null;
      }

      function initPosition(cb,attempts=0){
        // Prefer the left game-panel column unless user has opted into chat placement
        const wantsLeft=localStorage.getItem('sc_placement')!=='chat';
        const leftPanel=wantsLeft && findLeftPanel();
        if(leftPanel){
          root.classList.remove('sc-placement-chat');
          // Sit below the first tile (the icon-row strip above Events) rather than above everything
          if(leftPanel.firstElementChild) leftPanel.firstElementChild.insertAdjacentElement('afterend',root);
          else leftPanel.appendChild(root);
          cb(); startRejectionWatcher(leftPanel,true); return;
        }
        // Chat sidebar: inserted in-flow as its own card, stacked above the chat card.
        // The left column can still be mid-animation-in the first ~3s, so unless chat
        // is the actual preference, keep retrying for it instead of settling for chat here.
        const chatInput=document.getElementById('chat-input');
        if(chatInput && (!wantsLeft || attempts>=10)){
          const insertBefore=chatInput.parentElement?.parentElement?.parentElement;
          if(insertBefore){
            root.classList.add('sc-placement-chat');
            insertBefore.insertAdjacentElement('beforebegin',root);
            cb(); startRejectionWatcher(insertBefore.parentElement||document.body,true); return;
          }
        }
        if(attempts<33) setTimeout(()=>initPosition(cb,attempts+1),300);
        else { document.body.appendChild(root); cb(); startRejectionWatcher(document.body,false); } // fallback
      }

      // inFlow=true  → root is inside `container` directly; watch container's children
      // inFlow=false → root is on body as fixed overlay; watch container itself for removal
      function startRejectionWatcher(container,inFlow) {
        const watchTarget=inFlow ? container : (container.parentElement||document.body);
        const obs=new MutationObserver(()=>{
          const gone=inFlow ? !document.contains(root) : !document.contains(container);
          if(gone){
            obs.disconnect();
            if(reinjecting)return;
            reinjecting=true;
            root.remove();
            setTimeout(()=>{ reinjecting=false; inject(); }, 1000);
          }
        });
        obs.observe(watchTarget,{childList:true});
      }

      initPosition(()=>{
        UI.recIndicator=document.getElementById('sc-rec-indicator');
        UI.statusEl=document.getElementById('sc-status-row');
        UI.clipsList=document.getElementById('sc-clips-list');
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
        document.getElementById('sc-toggle').addEventListener('click',()=>{collapsed=!collapsed;body.style.display=collapsed?'none':'';document.getElementById('sc-toggle').classList.toggle('sc-collapsed',collapsed);});

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
        // Read live from the manifest rather than a hardcoded string that drifts out of sync on every version bump
        console.log('[SOON CLIP] UI injected v'+(typeof GM_info!=='undefined'?GM_info.script.version:'?'));
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
      const cropRecKey=getShortcut('sc_key_crop_record'), cropSsKey=getShortcut('sc_key_crop_screenshot');
      if(recKey&&matchesShortcut(e,recKey)){e.preventDefault();if(recording)stopRecording();else{cropRegion=null;startRecording();}return;}
      if(ssKey&&matchesShortcut(e,ssKey)){e.preventDefault();takeScreenshot(null);return;}
      if(cropRecKey&&matchesShortcut(e,cropRecKey)){e.preventDefault();if(recording)stopRecording();else if(!frameMode){pendingAction='record';enterFrameMode();}return;}
      if(cropSsKey&&matchesShortcut(e,cropSsKey)){e.preventDefault();if(!frameMode)enterCropScreenshot();}
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
    // Called every second while recording (so it self-heals after a React
    // re-inject swaps the buttons out). Skip the innerHTML/className rewrite
    // when nothing changed — otherwise the SVG is re-parsed on every tick.
    const state=isRecording?'rec':inFrameMode?'frame':'idle';
    if(UI.recFull.dataset.scState===state)return;
    UI.recFull.dataset.scState=state;
    if(isRecording){
      UI.recFull.innerHTML=ICON_STOP; UI.recFull.className=`sc-rec-btn sc-rec-btn--stop ${NATIVE_DANGER_BTN}`; UI.recFull.title='Stop recording';
      UI.recCrop.style.display='none';
    }else if(inFrameMode){
      UI.recFull.textContent='✕ Cancel'; UI.recFull.className=`sc-rec-btn sc-rec-btn--cancel sc-rec-btn--full ${NATIVE_DARK_BTN}`;
      UI.recCrop.style.display='none';
    }else{
      UI.recFull.innerHTML=ICON_RECORD; UI.recFull.className=`sc-rec-btn ${NATIVE_DANGER_BTN}`; UI.recFull.title='Record fullscreen';
      UI.recCrop.style.display=''; UI.recCrop.innerHTML=ICON_CROP_RECORD; UI.recCrop.className=`sc-rec-btn sc-rec-btn--crop ${NATIVE_DANGER_BTN}`; UI.recCrop.title='Record selection';
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
        cell.innerHTML=`<img class="sc-ss-thumb" src="${ss.blobUrl}" title="${ss.label}"><div class="sc-ss-cell-actions"><button class="sc-ss-save" title="Save">↓</button><button class="sc-ss-del" title="Delete">✕</button></div>`;
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
        <span class="sc-sublabel" style="font-weight:700;font-variation-settings:'slnt' 0,'wght' 700;">${formatDuration(clip.duration)}</span>
        <span id="sc-tlo-lbl-${clip.id}" class="sc-sublabel">Out: ${formatDuration(clip.duration)}</span>
      </div>
      <div class="sc-card-actions">
        <div style="display:flex;gap:3px;">
          <button class="sc-qbtn" data-sec="30">30s</button>
          <button class="sc-qbtn" data-sec="60">60s</button>
          <button class="sc-qbtn" data-sec="120">2m</button>
          <button class="sc-qbtn sc-qbtn-reset">Reset</button>
        </div>
        <button class="sc-dl-btn" title="Save MP4">MP4 ↓</button>
      </div>
      <div class="sc-clip-status" id="sc-cst-${clip.id}" style="display:none;"></div>`;

    card.appendChild(hdr); card.appendChild(body);

    // Declare dragAbort here so it's in scope for the del button listener below.
    // Stashed on the clip too — the trim handles' mousemove/mouseup listeners
    // are on `document`, so the 5-clip eviction cap in finaliseClip must abort
    // this even when a card is silently evicted rather than manually deleted.
    const dragAbort = new AbortController();
    clip._dragAbort = dragAbort;

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
      if(clip._previewFixedUrl){URL.revokeObjectURL(clip._previewFixedUrl); clip._previewFixedUrl=null;}
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
    function showPreviewUnavailable() {
      if(videoErrorShown) return; // don't show twice or loop
      videoErrorShown = true;
      if(loadingDiv.isConnected) loadingDiv.remove();
      const errDiv=document.createElement('div');
      errDiv.style.cssText='padding:10px 6px;text-align:center;font-size:10px;color:var(--base-dark-text,rgb(25,28,32));opacity:0.65;background:rgba(0,0,0,0.05);border-radius:3px;margin-top:5px;';
      errDiv.textContent='Preview unavailable — use Save MP4 to download';
      video.insertAdjacentElement('afterend',errDiv);
      video.style.visibility='hidden'; video.style.height='0'; video.style.margin='0';
    }
    video.addEventListener('error',()=>{
      if(videoErrorShown) return;
      if(!clip._previewRepairAttempted){
        // loadedmetadata (still pending, {once:true}) will fire and reveal the
        // video normally if the repaired file plays — only fall back to the
        // static message if the repair itself fails.
        if(loadingDiv.isConnected===false) body.insertBefore(loadingDiv,video);
        repairPreview(clip,video).then(ok=>{ if(!ok) showPreviewUnavailable(); });
        return;
      }
      showPreviewUnavailable();
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

      #sc-root {
        font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);
        border-radius:var(--radius-lg,8px);
        overflow:hidden;
        flex-shrink:0;
        background:var(--base-light,#dddec4);
        background-image:var(--base-texture-panel,var(--base-texture-background));
        box-shadow:rgba(0,0,0,0.3) 0 1px 3px 0;
        border-top:2px solid color-mix(in srgb,var(--base-light,#dddec4) 80%,white);
        border-left:2px solid color-mix(in srgb,var(--base-light,#dddec4) 80%,white);
        border-bottom:3px solid color-mix(in srgb,var(--base-light,#dddec4) 60%,black);
        border-right:2px solid color-mix(in srgb,var(--base-light,#dddec4) 60%,black);
      }
      #sc-root.sc-placement-chat {
        box-shadow:none;
        border-bottom-color:color-mix(in srgb,var(--base-light,#dddec4) 80%,white);
        border-right-color:color-mix(in srgb,var(--base-light,#dddec4) 80%,white);
      }
      /* flex-wrap so the icon buttons drop to a second row instead of spilling
         past the card edge when the host page is too narrow/zoomed to fit them
         on one line (seen on the site's own panels too at high browser zoom). */
      .sc-hdr { display:flex;align-items:center;flex-wrap:wrap;padding:4px;gap:5px;min-height:41px;box-sizing:border-box;border-bottom:1px solid rgba(0,0,0,0.15);box-shadow:rgba(255,255,255,0.5) 0 1px 0;user-select:none; }
      .sc-hdr-title { font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:14px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;line-height:1.5;color:var(--base-dark-text,rgb(25,28,32)); }
      .sc-rec-indicator { font-size:10px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;color:var(--base-primary,#df4e1e);letter-spacing:0.05em; }

      /* Chrome (background/size/radius/hover) for these buttons comes from the native
         Tailwind utility classes applied alongside these — copied verbatim off the
         site's own icon-row, record-shop, and collapse buttons. Only the leftovers
         those classes don't cover live here. */
      .sc-btn-group { display:flex;gap:2px; }
      .sc-icon-btn { font-size:12px;line-height:1; }
      .sc-rec-btn { font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:11px; }
      .sc-rec-btn--crop { opacity:0.75; }
      .sc-rec-btn--stop { animation:sc-pulse 1.1s infinite; }
      .sc-rec-btn--cancel { opacity:0.85; }
      .sc-rec-btn--full { width:auto!important;padding-left:7px!important;padding-right:7px!important; }

      .sc-toggle-collapse { position:relative; }
      .sc-toggle-collapse::before { content:'';display:block;width:10px;height:2px;border-radius:1px;background:currentColor; }
      .sc-toggle-collapse.sc-collapsed::after { content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2px;height:10px;border-radius:1px;background:currentColor; }

      #sc-settings { position:fixed;background:var(--base-light,#dddec4);background-image:var(--base-texture-panel,var(--base-texture-background));border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-lg,8px);box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:2147483640;padding:10px;min-width:230px; }
      .sc-toggle-btn { font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:10px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;padding:2px 8px;background:rgba(0,0,0,0.1);border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-md,6px);cursor:pointer;min-width:40px;text-align:center;transition:background 0.1s,color 0.1s; }
      .sc-toggle-btn--on { background:rgba(223,78,30,0.15);border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }

      .sc-switch { position:relative;display:inline-block;width:38px;height:22px;flex-shrink:0;cursor:pointer; }
      .sc-switch input { position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer; }
      .sc-switch-track { position:absolute;inset:0;background:rgba(0,0,0,0.25);border-radius:999px;transition:background 0.15s ease; }
      .sc-switch-track::before { content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);transition:transform 0.15s ease; }
      /* Same accent var as the record button / timeline fill / download button
         elsewhere in this panel, so the switch follows the site's own theme
         editor instead of being pinned to a fixed green. */
      .sc-switch input:checked + .sc-switch-track { background:var(--base-primary,#df4e1e); }
      .sc-switch input:checked + .sc-switch-track::before { transform:translateX(16px); }
      .sc-switch input:focus-visible + .sc-switch-track { outline:2px solid var(--base-primary,#df4e1e);outline-offset:2px; }

      #sc-body { background:transparent; }
      .sc-inner { padding:4px;display:flex;flex-direction:column;gap:8px; }
      #sc-clips-list { max-height:520px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:rgba(0,0,0,0.2) transparent; }
      #sc-clips-list::-webkit-scrollbar { width:4px; }
      #sc-clips-list::-webkit-scrollbar-track { background:transparent; }
      #sc-clips-list::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.2);border-radius:2px; }
      .sc-sublabel { font-size:9px;opacity:0.55;color:var(--base-dark-text,rgb(25,28,32)); }
      .sc-status--ok      { color:var(--base-secondary,#26b64b)!important;opacity:1!important; }
      .sc-status--err     { color:var(--base-primary,#df4e1e)!important;opacity:1!important; }
      .sc-status--loading { opacity:0.75!important; }
      .sc-status--rec     { color:#df4e1e!important;opacity:1!important;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700; }

      .sc-ss-strip { display:flex;gap:4px;padding:6px 0 4px;overflow-x:auto;scrollbar-width:none; }
      .sc-ss-strip::-webkit-scrollbar { display:none; }
      .sc-ss-cell { position:relative;flex-shrink:0;width:72px;border-radius:var(--radius-sm,3px);overflow:hidden;border:1px solid rgba(0,0,0,0.15);background:#000;cursor:pointer; }
      .sc-ss-cell:hover .sc-ss-cell-actions { opacity:1; }
      .sc-ss-thumb { width:72px;height:40px;object-fit:cover;display:block;transition:opacity 0.12s; }
      .sc-ss-cell:hover .sc-ss-thumb { opacity:0.7; }
      .sc-ss-cell-actions { position:absolute;bottom:0;left:0;right:0;display:flex;justify-content:space-between;padding:2px 3px;background:linear-gradient(transparent,rgba(0,0,0,0.7));opacity:0;transition:opacity 0.12s; }
      .sc-ss-save,.sc-ss-del { font-size:9px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;background:none;border:none;color:white;cursor:pointer;padding:1px 2px;line-height:1; }
      .sc-ss-save:hover { color:#26b64b; }
      .sc-ss-del:hover  { color:#df4e1e; }

      .sc-clip-card { background:rgba(0,0,0,0.08);border-radius:var(--radius-md,4px);border:1px solid rgba(0,0,0,0.1);overflow:hidden;margin-bottom:6px; }
      .sc-card-hdr { display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:default; }
      .sc-card-thumb { width:48px;height:27px;object-fit:cover;border-radius:var(--radius-sm,2px);flex-shrink:0;background:#000; }
      .sc-card-hdr-info { flex:1;min-width:0; }
      .sc-clip-label { font-size:10px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;color:var(--base-dark-text,rgb(25,28,32));opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block; }
      .sc-card-toggle { font-size:11px;width:18px;height:18px;border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-sm,3px);background:var(--base-light,#dddec4);color:var(--base-dark-text,rgb(25,28,32));opacity:0.65;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1; }
      .sc-card-toggle:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-card-body { padding:0 6px 6px;display:flex;flex-direction:column;gap:5px;border-top:1px solid rgba(0,0,0,0.08); }
      /* transform forces this off Chrome's hardware video-overlay compositing path on
         Windows, which otherwise can stretch the decoded frame to fill the box and
         ignore object-fit entirely — the file itself is unaffected, only this <video>. */
      /* object-fit:contain (not cover) — the left-docked panel is much narrower
         than a typical camera feed's aspect ratio, so cover was cropping hard
         into the sides to fill the box, which read as a "stretched"/zoomed
         preview even though the recording itself was untouched. */
      .sc-clip-video { width:100%;display:block;background:#000;height:180px;object-fit:contain;border-radius:var(--radius-sm,2px);margin-top:5px;transform:translateZ(0); }

      .sc-player-row { display:flex;align-items:center;gap:6px; }
      .sc-play-btn { width:22px;height:22px;border-radius:50%;background:var(--base-primary,#df4e1e);border:none;color:white;font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity 0.1s; }
      .sc-play-btn:hover { opacity:0.85; }
      .sc-mute-btn { font-size:11px;padding:2px 4px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-sm,3px);cursor:pointer;flex-shrink:0;transition:background 0.1s;line-height:1; }
      .sc-mute-btn:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-skip-btn { font-size:10px;padding:2px 4px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-sm,3px);color:var(--base-dark-text,rgb(25,28,32));opacity:0.7;cursor:pointer;flex-shrink:0;transition:background 0.1s; }
      .sc-skip-btn:hover { background:var(--base-light-300,#c8c9a8); }
      /* Left-docked panel is narrower than the chat-sidebar placement, and the
         player row was cramped — drop the ±5s skip buttons there to give the
         timeline more room for trimming; keep them where there's space (chat). */
      #sc-root:not(.sc-placement-chat) .sc-skip-btn[data-skip="5"],
      #sc-root:not(.sc-placement-chat) .sc-skip-btn[data-skip="-5"] { display:none; }
      .sc-time-display { font-size:9px;opacity:0.5;font-family:monospace;flex-shrink:0; }

      .sc-timeline { position:relative;flex:1;height:24px;background:rgba(0,0,0,0.1);border-radius:var(--radius-sm,3px);cursor:pointer;display:inline-block;border:1px solid rgba(0,0,0,0.1);overflow:visible; }
      .sc-tl-track { position:absolute;top:50%;left:0;right:0;height:4px;transform:translateY(-50%);background:rgba(0,0,0,0.12);border-radius:2px; }
      .sc-tl-filled { position:absolute;top:50%;height:4px;transform:translateY(-50%);background:var(--base-primary,#df4e1e);opacity:0.65;border-radius:2px;pointer-events:none; }
      .sc-tl-handle { position:absolute;top:50%;transform:translate(-50%,-50%);width:5px;height:20px;background:var(--base-primary,#df4e1e);border-radius:2px;cursor:col-resize;z-index:2;box-shadow:0 1px 3px rgba(0,0,0,0.3); }
      .sc-tl-handle::after { content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:1px;height:10px;background:rgba(255,255,255,0.6);border-radius:1px; }
      .sc-tl-playhead { position:absolute;top:0;bottom:0;width:2px;background:rgba(0,0,0,0.4);pointer-events:none;transform:translateX(-50%);z-index:1; }
      .sc-tl-playhead::before { content:'';position:absolute;top:-2px;left:50%;transform:translateX(-50%);border-left:3px solid transparent;border-right:3px solid transparent;border-top:4px solid rgba(0,0,0,0.4); }
      .sc-tl-tick { position:absolute;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.08);pointer-events:none; }
      .sc-trim-times { display:flex;justify-content:space-between;padding:0 1px; }

      .sc-card-actions { display:flex;justify-content:space-between;align-items:center;gap:6px; }
      .sc-qbtn { padding:2px 5px;font-size:9px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;letter-spacing:0.04em;text-transform:uppercase;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-sm,3px);color:var(--base-dark-text,rgb(25,28,32));opacity:0.7;cursor:pointer;transition:background 0.1s; }
      .sc-qbtn:hover { background:var(--base-light-300,#c8c9a8); }
      .sc-dl-btn { padding:4px 7px;font-size:9px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;letter-spacing:0.04em;text-transform:uppercase;background:var(--base-primary,#df4e1e);border:none;border-radius:var(--radius-sm,3px);color:white;cursor:pointer;transition:opacity 0.1s;white-space:nowrap; }
      .sc-dl-btn:hover { opacity:0.85; }
      .sc-dl-btn-sm { padding:2px 6px;font-size:9px;font-weight:700;font-variation-settings:"slnt" 0,"wght" 700;background:var(--base-primary,#df4e1e);border:none;border-radius:var(--radius-sm,3px);color:white;cursor:pointer;transition:opacity 0.1s; }
      .sc-dl-btn-sm:hover { opacity:0.85; }
      .sc-del-btn { padding:2px 6px;font-size:10px;background:var(--base-light,#dddec4);border:1px solid rgba(0,0,0,0.2);border-radius:var(--radius-sm,3px);color:var(--base-dark-text,rgb(25,28,32));opacity:0.55;cursor:pointer;transition:background 0.1s; }
      .sc-del-btn:hover { background:rgba(223,78,30,0.15);color:var(--base-primary,#df4e1e);opacity:1; }
      .sc-clip-status { font-size:9px;color:var(--base-dark-text,rgb(25,28,32));opacity:0.55;padding:2px 0; }

    `);
  }

  function init(){
    addStyles();
    buildUI();
    _loadAssets(); // preload logo + static sound early so they're cached before first recording
    // Tear down any active recording on navigation — prevents MediaRecorder and
    // timers from leaking into an unloaded page context.
    window.addEventListener('beforeunload', () => {
      if (activeSession?.isActive) activeSession.destroy();
    });
  }
  init();

})();
