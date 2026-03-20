// ==UserScript==
// @name         Soon Clipper
// @namespace    https://fishtank.news
// @version      2.0.0
// @description  Clip, trim, crop, watermark & download fishtank.live streams — fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-end
// @version      2.0.0
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-clipper.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-clipper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SHARED NAMESPACE ───────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  window.SOON = window.SOON || {};

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLIP MODULE ────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const ClipModule = (() => {

    // ── State ────────────────────────────────────────────────────────────────
    let hlsInstance     = null;   // hls.js instance attached to stream
    let hlsLoaded       = false;
    let ffmpeg          = null;   // FFmpeg.wasm instance
    let ffmpegLoaded    = false;
    let ffmpegLoading   = false;

    // Rolling segment buffer: [{ data: Uint8Array, duration: number, seq: number }]
    const segmentBuffer  = [];
    const MAX_BUFFER_SEC = 120;   // keep last 2 minutes

    // Clip queue: [{ id, segments, trimStart, trimEnd, crop, watermark, status, filename }]
    const clipQueue      = [];
    let   queueRunning   = false;

    // Current stream state
    let currentM3u8      = null;
    let activeRoomId     = null;
    let activeRoomLabel  = 'Unknown Room';

    // UI element refs (populated by buildUI)
    const UI = {};

    // Crop state (% of video frame)
    const crop = { enabled: false, x: 0, y: 0, w: 100, h: 100 };

    // Watermark state
    const watermark = { enabled: true, text: 'fishtank.news', position: 'br' };

    // ── CDN URLs ──────────────────────────────────────────────────────────────
    const HLS_CDN    = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
    // FFmpeg.wasm single-thread build — no SharedArrayBuffer / COOP headers needed
    const FFMPEG_CORE_CDN = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js';
    const FFMPEG_CDN      = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';

    // ── Lazy loaders ──────────────────────────────────────────────────────────
    function loadScript(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Failed to load: ' + src));
        document.head.appendChild(s);
      });
    }

    async function ensureHls() {
      if (hlsLoaded) return;
      setStatus('Loading HLS player…', 'loading');
      await loadScript(HLS_CDN);
      hlsLoaded = true;
    }

    async function ensureFFmpeg() {
      if (ffmpegLoaded) return;
      if (ffmpegLoading) {
        // Wait for existing load
        await new Promise(resolve => {
          const check = setInterval(() => { if (ffmpegLoaded) { clearInterval(check); resolve(); } }, 200);
        });
        return;
      }
      ffmpegLoading = true;
      setStatus('Loading FFmpeg (first time ~30MB)…', 'loading');
      setEncodeBtn(false, 'Loading FFmpeg…');
      try {
        await loadScript(FFMPEG_CDN);
        const { FFmpeg } = window.FFmpegWASM || unsafeWindow.FFmpegWASM;
        ffmpeg = new FFmpeg();
        ffmpeg.on('log', ({ message }) => console.log('[SOON FFMPEG]', message));
        ffmpeg.on('progress', ({ progress }) => {
          setStatus(`Encoding… ${Math.round(progress * 100)}%`, 'loading');
          if (UI.encodeBtn) UI.encodeBtn.textContent = `Encoding ${Math.round(progress * 100)}%…`;
        });
        await ffmpeg.load({ coreURL: FFMPEG_CORE_CDN });
        ffmpegLoaded = true;
        ffmpegLoading = false;
        setStatus('FFmpeg ready', 'ok');
        setEncodeBtn(true, 'Add to Queue');
      } catch (err) {
        ffmpegLoading = false;
        setStatus('FFmpeg failed to load: ' + err.message, 'err');
        console.error('[SOON CLIP] FFmpeg load error:', err);
        throw err;
      }
    }

    // ── Stream attachment ──────────────────────────────────────────────────────
    // Find the live HLS stream URL from the page's existing video element
    function findCurrentM3u8() {
      // Check all video elements on page for an HLS src
      for (const vid of document.querySelectorAll('video')) {
        const src = vid.src || '';
        if (src.includes('.m3u8')) return src;
        // Check hls.js attached source
        if (vid._hls?.url) return vid._hls.url;
      }
      // Check video source elements
      for (const src of document.querySelectorAll('source[src*=".m3u8"]')) {
        if (src.src) return src.src;
      }
      return null;
    }

    // Intercept page's own hls.js instance to get stream URL
    // This runs early and patches WebSocket + hls.js before fishtank loads them
    function interceptHlsSource() {
      // Watch for video src changes via MutationObserver
      const observer = new MutationObserver(() => {
        const url = findCurrentM3u8();
        if (url && url !== currentM3u8) {
          console.log('[SOON CLIP] Detected stream URL change:', url.slice(-50));
          currentM3u8 = url;
          if (hlsInstance) attachToStream(url);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

      // Also poll since React may swap video src without DOM mutations
      setInterval(() => {
        const url = findCurrentM3u8();
        if (url && url !== currentM3u8) {
          currentM3u8 = url;
          if (hlsInstance) attachToStream(url);
        }
      }, 2000);
    }

    async function attachToStream(m3u8Url) {
      if (!m3u8Url) return;
      try {
        await ensureHls();
      } catch(e) {
        setStatus('HLS player failed to load', 'err');
        return;
      }

      // Detach previous instance
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      segmentBuffer.length = 0;
      updateBufferDisplay();

      const Hls = window.Hls || unsafeWindow.Hls;
      if (!Hls || !Hls.isSupported()) {
        setStatus('HLS not supported in this browser', 'err');
        return;
      }

      const hls = new Hls({
        enableWorker: false,       // avoid SharedArrayBuffer requirement
        lowLatencyMode: false,
        backBufferLength: 0,
        maxBufferLength: 30,
        // We only want segments, don't attach to a video element
        // (avoids competing with fishtank's own player)
      });

      // Intercept fragment loads to buffer raw .ts data
      hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
        try {
          const buf  = data.frag.stats?.loaded
            ? data.payload                          // hls.js v1+
            : data.frag._data;                      // fallback

          if (!buf) return;

          segmentBuffer.push({
            data:     new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer),
            duration: data.frag.duration || 2,
            seq:      data.frag.sn,
          });

          trimBuffer();
          updateBufferDisplay();
        } catch(e) {
          console.warn('[SOON CLIP] Segment capture error:', e.message);
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          setStatus('Stream error: ' + data.details, 'err');
        }
      });

      hls.loadSource(m3u8Url);
      // Attach to a hidden video element so hls.js actually loads segments
      const hiddenVid = getOrCreateHiddenVideo();
      hls.attachMedia(hiddenVid);

      hlsInstance = hls;
      currentM3u8 = m3u8Url;
      setStatus(`Buffering ${activeRoomLabel}…`, 'ok');
      console.log('[SOON CLIP] Attached to stream:', m3u8Url.slice(-50));
    }

    function getOrCreateHiddenVideo() {
      let v = document.getElementById('soon-clip-hiddenvid');
      if (!v) {
        v = document.createElement('video');
        v.id = 'soon-clip-hiddenvid';
        v.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
        v.muted = true;
        document.body.appendChild(v);
      }
      return v;
    }

    // ── Buffer management ──────────────────────────────────────────────────────
    function trimBuffer() {
      let total = segmentBuffer.reduce((s, seg) => s + seg.duration, 0);
      while (total > MAX_BUFFER_SEC && segmentBuffer.length > 1) {
        total -= segmentBuffer.shift().duration;
      }
    }

    function bufferDuration() {
      return segmentBuffer.reduce((s, seg) => s + seg.duration, 0);
    }

    function updateBufferDisplay() {
      if (!UI.bufferBar) return;
      const dur = bufferDuration();
      const pct = Math.min(100, (dur / MAX_BUFFER_SEC) * 100);
      UI.bufferBar.style.width = pct + '%';
      UI.bufferLabel.textContent = dur > 0
        ? `${Math.floor(dur)}s buffered (${segmentBuffer.length} segments)`
        : 'No buffer yet';
    }

    // ── Clipping ────────────────────────────────────────────────────────────────
    // Collect the last N seconds of segments from the buffer
    function collectSegments(durationSec) {
      if (!segmentBuffer.length) return [];
      const segments = [];
      let collected = 0;
      // Walk backwards
      for (let i = segmentBuffer.length - 1; i >= 0 && collected < durationSec; i--) {
        segments.unshift(segmentBuffer[i]);
        collected += segmentBuffer[i].duration;
      }
      return segments;
    }

    function addToQueue(durationSec, label) {
      const segments = collectSegments(durationSec);
      if (!segments.length) {
        setStatus('No buffered video to clip — wait for buffer to fill', 'err');
        return;
      }

      const totalDur = segments.reduce((s, seg) => s + seg.duration, 0);
      const trimStart = Math.max(0, totalDur - durationSec);

      const job = {
        id:        Date.now(),
        label:     label || `${activeRoomLabel} — Last ${durationSec}s`,
        segments:  segments.map(s => ({ ...s })), // deep copy
        trimStart,
        trimEnd:   totalDur,
        crop:      { ...crop },
        watermark: { ...watermark },
        filename:  `soontools_${activeRoomId || 'clip'}_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.mp4`,
        status:    'queued',
        output:    null,
      };

      clipQueue.push(job);
      renderQueue();
      setStatus(`Added to queue: ${job.label}`, 'ok');

      if (!queueRunning) processQueue();
    }

    // ── FFmpeg processing ──────────────────────────────────────────────────────
    async function processQueue() {
      if (queueRunning) return;
      const pending = clipQueue.filter(j => j.status === 'queued');
      if (!pending.length) return;

      queueRunning = true;

      for (const job of pending) {
        if (job.status !== 'queued') continue;
        job.status = 'encoding';
        renderQueue();

        try {
          await ensureFFmpeg();
          job.output = await encodeClip(job);
          job.status = 'done';
          triggerDownload(job.output, job.filename);
          setStatus(`✓ ${job.label} — downloaded`, 'ok');
        } catch(err) {
          job.status = 'error';
          job.error  = err.message;
          setStatus(`✗ Encode failed: ${err.message}`, 'err');
          console.error('[SOON CLIP] encode error:', err);
        }

        renderQueue();
      }

      queueRunning = false;
    }

    async function encodeClip(job) {
      const { segments, trimStart, trimEnd, crop, watermark, filename } = job;

      // Write segments to FFmpeg virtual FS
      const segFiles = [];
      for (let i = 0; i < segments.length; i++) {
        const fname = `seg_${i}.ts`;
        await ffmpeg.writeFile(fname, segments[i].data);
        segFiles.push(fname);
      }

      // Concat list
      const concatLines = segFiles.map(f => `file '${f}'`).join('\n');
      await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatLines));

      // Build video filter chain
      const filters = [];

      if (crop.enabled) {
        // crop=w:h:x:y in pixels — we get % so convert at encode time
        // We use iw/ih expressions so FFmpeg resolves at runtime
        const cw = `iw*${(crop.w / 100).toFixed(4)}`;
        const ch = `ih*${(crop.h / 100).toFixed(4)}`;
        const cx = `iw*${(crop.x / 100).toFixed(4)}`;
        const cy = `ih*${(crop.y / 100).toFixed(4)}`;
        filters.push(`crop=${cw}:${ch}:${cx}:${cy}`);
      }

      if (watermark.enabled && watermark.text) {
        const pos = {
          tl: 'x=10:y=10',
          tr: 'x=w-tw-10:y=10',
          bl: 'x=10:y=h-th-10',
          br: 'x=w-tw-10:y=h-th-10',
        }[watermark.position] || 'x=w-tw-10:y=h-th-10';
        // Escape special chars in watermark text
        const txt = watermark.text.replace(/'/g, "\\'").replace(/:/g, '\\:');
        filters.push(
          `drawtext=text='${txt}':fontsize=24:fontcolor=white:` +
          `${pos}:shadowcolor=black:shadowx=1:shadowy=1:alpha=0.8`
        );
      }

      const vf = filters.length ? ['-vf', filters.join(',')] : [];

      // Run FFmpeg
      const outFile = 'output.mp4';
      await ffmpeg.exec([
        '-f',       'concat',
        '-safe',    '0',
        '-i',       'concat.txt',
        '-ss',      String(trimStart),
        '-to',      String(trimEnd),
        ...vf,
        '-c:v',     'libx264',
        '-preset',  'fast',
        '-crf',     '23',
        '-c:a',     'aac',
        '-b:a',     '128k',
        '-movflags','faststart',
        '-y',
        outFile,
      ]);

      const data = await ffmpeg.readFile(outFile);
      const blob = new Blob([data.buffer], { type: 'video/mp4' });

      // Cleanup FS
      for (const f of segFiles) { try { await ffmpeg.deleteFile(f); } catch {} }
      try { await ffmpeg.deleteFile('concat.txt'); } catch {}
      try { await ffmpeg.deleteFile(outFile); } catch {}

      return blob;
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // ── UI ─────────────────────────────────────────────────────────────────────
    function buildUI() {
      // Find where to inject — look for the map panel or a suitable sidebar
      const tryInject = setInterval(() => {
        const anchor = document.getElementById('ftfp-map') || findSidebarAnchor();
        if (!anchor) return;
        clearInterval(tryInject);

        const root = document.createElement('div');
        root.id = 'soon-clip-root';
        root.style.cssText = 'width:100%;font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);flex-shrink:0;display:flex;flex-direction:column;';

        // ── Section header ───────────────────────────────────────────────────
        const hdr = document.createElement('div');
        hdr.className = 'soon-clip-hdr';
        hdr.innerHTML = `
          <span class="ftc-hdr-fish">
            <svg style="width:14px;height:14px;" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 4l-4 4H6l-2 2 2 2h8l4 4 2-4-1-2 1-2-2-4z"/>
            </svg>
          </span>
          <span class="ftc-hdr-title">Clip</span>
          <span id="soon-clip-status-badge" class="soon-clip-badge">Inactive</span>
          <div style="margin-left:auto;display:flex;align-items:center;gap:5px;">
            <button id="soon-clip-toggle" class="ftc-hdr-btn">−</button>
          </div>
        `;

        // ── Body ──────────────────────────────────────────────────────────────
        const body = document.createElement('div');
        body.id = 'soon-clip-body';
        body.style.cssText = 'overflow:hidden;transition:max-height 0.3s ease;background:var(--base-background,#557194);background-image:var(--base-texture-background);';

        const inner = document.createElement('div');
        inner.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:8px;';

        // Buffer indicator
        inner.innerHTML += `
          <div class="soon-clip-section">
            <div class="soon-clip-label">Stream Buffer</div>
            <div class="soon-clip-buftrack">
              <div id="soon-clip-bufbar" class="soon-clip-bufbar" style="width:0%"></div>
            </div>
            <div id="soon-clip-buflabel" class="soon-clip-sublabel">No buffer yet — open clip panel to start</div>
          </div>
        `;

        // Quick clip buttons
        inner.innerHTML += `
          <div class="soon-clip-section">
            <div class="soon-clip-label">Quick Clip</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="soon-clip-qbtn" data-sec="30">Last 30s</button>
              <button class="soon-clip-qbtn" data-sec="60">Last 60s</button>
              <button class="soon-clip-qbtn" data-sec="90">Last 90s</button>
              <button class="soon-clip-qbtn" data-sec="120">Last 2min</button>
            </div>
          </div>
        `;

        // Watermark
        inner.innerHTML += `
          <div class="soon-clip-section">
            <div class="soon-clip-label">Watermark</div>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="checkbox" id="soon-wm-enabled" checked style="flex-shrink:0;">
              <input type="text" id="soon-wm-text" value="fishtank.news"
                style="flex:1;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.2);border-radius:3px;padding:3px 6px;color:inherit;font-size:11px;">
              <select id="soon-wm-pos"
                style="background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.2);border-radius:3px;padding:3px 4px;color:inherit;font-size:11px;">
                <option value="tl">↖ TL</option>
                <option value="tr">↗ TR</option>
                <option value="bl">↙ BL</option>
                <option value="br" selected>↘ BR</option>
              </select>
            </div>
          </div>
        `;

        // Crop
        inner.innerHTML += `
          <div class="soon-clip-section">
            <div style="display:flex;align-items:center;gap:6px;">
              <div class="soon-clip-label" style="margin:0;">Crop</div>
              <input type="checkbox" id="soon-crop-enabled">
              <span class="soon-clip-sublabel">(% of frame)</span>
            </div>
            <div id="soon-crop-fields" style="display:none;margin-top:6px;">
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;">
                ${['x','y','w','h'].map(k => `
                  <div>
                    <div class="soon-clip-sublabel">${k.toUpperCase()}</div>
                    <input type="number" id="soon-crop-${k}" value="${crop[k]}" min="0" max="100" step="1"
                      style="width:100%;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.2);border-radius:3px;padding:3px 4px;color:inherit;font-size:11px;">
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        `;

        // Add to queue button
        inner.innerHTML += `
          <button id="soon-clip-encode" class="soon-clip-primary-btn" disabled>
            Open Panel to Start Buffering
          </button>
          <div id="soon-clip-status" class="soon-clip-status"></div>
        `;

        // Queue
        inner.innerHTML += `
          <div class="soon-clip-section" id="soon-queue-wrap" style="display:none;">
            <div class="soon-clip-label">Queue</div>
            <div id="soon-queue-list" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
        `;

        body.appendChild(inner);
        root.appendChild(hdr);
        root.appendChild(body);
        anchor.insertAdjacentElement('afterend', root);

        // Store refs
        UI.root        = root;
        UI.body        = body;
        UI.bufferBar   = document.getElementById('soon-clip-bufbar');
        UI.bufferLabel = document.getElementById('soon-clip-buflabel');
        UI.encodeBtn   = document.getElementById('soon-clip-encode');
        UI.statusEl    = document.getElementById('soon-clip-status');
        UI.badgeEl     = document.getElementById('soon-clip-status-badge');
        UI.queueWrap   = document.getElementById('soon-queue-wrap');
        UI.queueList   = document.getElementById('soon-queue-list');

        // Toggle collapse
        let collapsed = false;
        document.getElementById('soon-clip-toggle').addEventListener('click', () => {
          collapsed = !collapsed;
          body.style.maxHeight = collapsed ? '0' : '';
          body.style.overflow  = collapsed ? 'hidden' : '';
          document.getElementById('soon-clip-toggle').textContent = collapsed ? '+' : '−';

          // Start buffering when panel is first opened
          if (!collapsed && !hlsInstance) {
            startBuffering();
          }
        });

        // Quick clip buttons
        inner.querySelectorAll('.soon-clip-qbtn').forEach(btn => {
          btn.addEventListener('click', () => {
            const sec = parseInt(btn.dataset.sec);
            addToQueue(sec);
          });
        });

        // Watermark inputs
        document.getElementById('soon-wm-enabled').addEventListener('change', e => {
          watermark.enabled = e.target.checked;
        });
        document.getElementById('soon-wm-text').addEventListener('input', e => {
          watermark.text = e.target.value;
        });
        document.getElementById('soon-wm-pos').addEventListener('change', e => {
          watermark.position = e.target.value;
        });

        // Crop inputs
        document.getElementById('soon-crop-enabled').addEventListener('change', e => {
          crop.enabled = e.target.checked;
          document.getElementById('soon-crop-fields').style.display = crop.enabled ? '' : 'none';
        });
        ['x','y','w','h'].forEach(k => {
          document.getElementById(`soon-crop-${k}`).addEventListener('input', e => {
            crop[k] = parseFloat(e.target.value) || 0;
          });
        });

        // Encode button → just triggers queue process
        UI.encodeBtn.addEventListener('click', () => {
          if (UI.encodeBtn.disabled) return;
          addToQueue(60); // default 60s on button click
        });

        console.log('[SOON CLIP] UI injected v2.0');
      }, 500);
    }

    function findSidebarAnchor() {
      // Fishtank's left sidebar usually has a predictable structure
      const sidebar = document.querySelector('[class*="sidebar"], [class*="left-panel"], [class*="StreamPanel"]');
      return sidebar || null;
    }

    // ── Start buffering ────────────────────────────────────────────────────────
    async function startBuffering() {
      const url = currentM3u8 || findCurrentM3u8();
      if (!url) {
        setStatus('No stream detected — switch to a room first', 'err');
        return;
      }
      await attachToStream(url);
      setEncodeBtn(true, 'Add to Queue');
    }

    // ── Status helpers ─────────────────────────────────────────────────────────
    function setStatus(msg, type) {
      console.log('[SOON CLIP]', msg);
      if (!UI.statusEl) return;
      UI.statusEl.textContent = msg;
      UI.statusEl.className = 'soon-clip-status soon-clip-status--' + (type || '');

      if (UI.badgeEl) {
        UI.badgeEl.textContent = type === 'loading' ? '…' : type === 'err' ? '✗' : type === 'ok' ? '●' : '—';
        UI.badgeEl.className = 'soon-clip-badge soon-clip-badge--' + (type || '');
      }
    }

    function setEncodeBtn(enabled, label) {
      if (!UI.encodeBtn) return;
      UI.encodeBtn.disabled     = !enabled;
      UI.encodeBtn.textContent  = label || 'Add to Queue';
    }

    // ── Queue renderer ─────────────────────────────────────────────────────────
    function renderQueue() {
      if (!UI.queueList) return;
      const active = clipQueue.filter(j => j.status !== 'done' || Date.now() - j.id < 30000);
      UI.queueWrap.style.display = active.length ? '' : 'none';
      UI.queueList.innerHTML = active.map(job => {
        const icon = { queued: '⏳', encoding: '⚙️', done: '✓', error: '✗' }[job.status] || '?';
        const cls  = 'soon-queue-item soon-queue-item--' + job.status;
        return `<div class="${cls}">
          <span class="soon-qi-icon">${icon}</span>
          <span class="soon-qi-label">${job.label}</span>
          ${job.status === 'encoding' ? `<span class="soon-qi-enc">Encoding…</span>` : ''}
          ${job.status === 'error'    ? `<span class="soon-qi-err">${job.error}</span>` : ''}
          ${job.status === 'done'     ? `<span class="soon-qi-done">↓ Downloaded</span>` : ''}
        </div>`;
      }).join('');
    }

    // ── Styles ──────────────────────────────────────────────────────────────────
    function addStyles() {
      GM_addStyle(`
        #soon-clip-root {
          font-family: var(--base-font-primary, sofia-pro-variable, sans-serif);
        }
        .soon-clip-hdr {
          display: flex; align-items: center; padding: 0px 3.2px 1.6px; gap: 6px;
          background: var(--base-light, #dddec4);
          background-image: var(--base-texture-background);
          border-bottom: 1px solid rgba(0,0,0,0.15);
          box-shadow: rgba(255,255,255,0.5) 0px 1px 0px;
          flex-shrink: 0; user-select: none;
        }
        .soon-clip-badge {
          font-size: 9px; letter-spacing: 0.06em;
          padding: 1px 6px; border-radius: 10px;
          border: 1px solid rgba(0,0,0,0.2);
          color: rgba(0,0,0,0.45);
        }
        .soon-clip-badge--ok      { color: var(--base-secondary,#26b64b); border-color: var(--base-secondary,#26b64b); }
        .soon-clip-badge--err     { color: var(--base-primary,#df4e1e); border-color: var(--base-primary,#df4e1e); }
        .soon-clip-badge--loading { color: rgba(0,0,0,0.5); border-color: rgba(0,0,0,0.2); }
        .soon-clip-section {
          display: flex; flex-direction: column; gap: 4px;
        }
        .soon-clip-label {
          font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; opacity: 0.6;
        }
        .soon-clip-sublabel {
          font-size: 9px; opacity: 0.5;
        }
        .soon-clip-buftrack {
          height: 4px; background: rgba(0,0,0,0.2); border-radius: 2px; overflow: hidden;
        }
        .soon-clip-bufbar {
          height: 100%; background: var(--base-secondary,#26b64b);
          transition: width 0.5s ease; border-radius: 2px;
        }
        .soon-clip-qbtn {
          flex: 1; padding: 5px 4px; font-size: 10px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase;
          background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.15);
          border-radius: 3px; color: inherit; cursor: pointer; min-width: 60px;
          transition: background 0.12s, border-color 0.12s;
        }
        .soon-clip-qbtn:hover {
          background: rgba(0,0,0,0.35); border-color: rgba(255,255,255,0.3);
        }
        .soon-clip-primary-btn {
          width: 100%; padding: 7px 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.06em; text-transform: uppercase;
          background: var(--base-primary,#df4e1e); border: none; border-radius: 3px;
          color: #fff; cursor: pointer; transition: opacity 0.15s;
        }
        .soon-clip-primary-btn:disabled {
          opacity: 0.4; cursor: not-allowed;
        }
        .soon-clip-primary-btn:not(:disabled):hover { opacity: 0.85; }
        .soon-clip-status {
          font-size: 10px; opacity: 0.7; min-height: 14px; word-break: break-word;
        }
        .soon-clip-status--err     { color: var(--base-primary,#df4e1e); opacity: 1; }
        .soon-clip-status--ok      { color: var(--base-secondary,#26b64b); opacity: 1; }
        .soon-clip-status--loading { opacity: 0.8; }
        .soon-queue-item {
          display: flex; align-items: center; gap: 6px;
          padding: 5px 7px; border-radius: 3px;
          background: rgba(0,0,0,0.15); font-size: 10px;
        }
        .soon-queue-item--encoding { background: rgba(223,78,30,0.15); }
        .soon-queue-item--done     { background: rgba(38,182,75,0.1); }
        .soon-queue-item--error    { background: rgba(223,78,30,0.2); }
        .soon-qi-icon  { flex-shrink: 0; font-size: 11px; }
        .soon-qi-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .soon-qi-enc, .soon-qi-err, .soon-qi-done { font-size: 9px; opacity: 0.7; flex-shrink: 0; }
        .soon-qi-done { color: var(--base-secondary,#26b64b); }
        .soon-qi-err  { color: var(--base-primary,#df4e1e); }
      `);
    }

    // ── Map integration ────────────────────────────────────────────────────────
    // Register callback so Map script can notify us of room changes
    function registerWithMap() {
      // If map already set a room before we loaded, pick it up
      if (window.SOON.activeRoomId) {
        activeRoomId    = window.SOON.activeRoomId;
        activeRoomLabel = window.SOON.activeRoom?.label || activeRoomId;
      }

      // Listen for future room changes
      window.SOON.onRoomChange = (roomId, room) => {
        activeRoomId    = roomId;
        activeRoomLabel = room?.label || roomId;

        // If we're already buffering, switch stream to new room
        // The stream URL will update via interceptHlsSource polling
        setStatus(`Switched to ${activeRoomLabel} — waiting for stream URL…`, 'ok');
        console.log('[SOON CLIP] Room changed to', activeRoomLabel);
      };
    }

    // ── Init ───────────────────────────────────────────────────────────────────
    function init() {
      addStyles();
      registerWithMap();
      interceptHlsSource();
      buildUI();
    }

    return { init };

  })(); // end ClipModule

  // ═══════════════════════════════════════════════════════════════════════════
  // ── BOOT ───────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // Run after DOM is ready (document-end)
  ClipModule.init();

})();
