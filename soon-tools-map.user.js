// ==UserScript==
// @name         Soon Map
// @namespace    https://fishtank.news
// @version      3.3.0
// @description  Enhances Fishtank's native map — click any room to switch cam, syncs with stream. By fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.fishtank.live
// @connect      streams-k.fishtank.live
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SHARED ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        anonymous: false,
        withCredentials: true,
        headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
        responseType: 'text',
        onload(r) {
          if (r.status === 0) { reject(new Error('gmFetch status 0')); return; }
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            json() {
              try { return Promise.resolve(JSON.parse(r.responseText)); }
              catch(_) { return Promise.reject(new Error('JSON parse failed')); }
            }
          });
        },
        onerror(e) { reject(new Error('gmFetch network error')); },
        ontimeout() { reject(new Error('gmFetch timeout')); }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ROOMS ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const ROOMS = [
    { id: 'GLASS',  label: 'Glass Room',   slug: 'gsrm-5',       tab: 'Glassroom',       floor: 'down', streamKey: 'glass'           },
    { id: 'FOYER',  label: 'Foyer',        slug: 'foyr-5',       tab: 'Foyer',           floor: 'down', streamKey: 'foyer'           },
    { id: 'MARKET', label: 'Market',       slug: 'mrke-5',       tab: 'Market',          floor: 'down', streamKey: 'market'          },
    { id: 'JACUZ',  label: 'Jacuzzi',      slug: 'jckz-5',       tab: 'Jacuzzi',         floor: 'down', streamKey: 'jacuzzi'         },
    { id: 'HALLD',  label: 'Hallway',      slug: 'hwdn-5',       tab: 'Hallway Down',    floor: 'down', streamKey: 'hallway down'    },
    { id: 'DINING', label: 'Dining Room',  slug: 'dnrm-5',       tab: 'Dining Room',     floor: 'down', streamKey: 'dining'          },
    { id: 'KITCH',  label: 'Kitchen',      slug: 'ktch-5',       tab: 'Kitchen',         floor: 'down', streamKey: 'kitchen'         },
    { id: 'BAR',    label: 'Bar',          slug: 'brrr-5',       tab: 'Bar',             floor: 'down', streamKey: 'bar'             },
    { id: 'CLOS',   label: 'Closet',       slug: 'dmcl-5',       tab: 'Closet',          floor: 'down', streamKey: 'closet'          },
    { id: 'DORM',   label: 'Dorm',         slug: 'dmrm-5',       tab: 'Dorm',            floor: 'down', streamKey: 'dorm'            },
    { id: 'CONF',   label: 'Confessional', slug: 'cfsl-5',       tab: 'Confessional',    floor: 'up',   streamKey: 'confess'         },
    { id: 'CORR',   label: 'Corridor',     slug: 'codr-5',       tab: 'Corridor',        floor: 'up',   streamKey: 'corridor'        },
    { id: 'JNDL',   label: 'Jungle Room',  slug: 'br4j-5',       tab: 'Jungle Room',     floor: 'up',   streamKey: 'jungle'          },
    { id: 'HALLU',  label: 'West Wing',    slug: 'hwup-5',       tab: 'Hallway Up',      floor: 'up',   streamKey: 'hallway up'      },
    { id: 'BALC',   label: 'East Wing',    slug: 'bkny-5',       tab: 'Balcony',         floor: 'up',   streamKey: 'balcony'         },
    { id: 'DIR',    label: 'Director Mode',slug: 'dirc-5',       tab: 'Director Mode',   floor: null,   streamKey: 'director'        },
    { id: 'BPTZ',   label: 'Bar PTZ',      slug: 'brpz-5',       tab: 'Bar PTZ',         floor: 'down', streamKey: 'bar ptz'         },
    { id: 'CAM',    label: 'Cameraman',    slug: 'cameraman2-5', tab: 'Cameraman',       floor: null,   streamKey: 'cameraman'       },
    { id: 'BALT',   label: 'Bar Alt',      slug: 'brrr2-5',      tab: 'Bar Alternate',   floor: 'down', streamKey: 'bar alternate'   },
    { id: 'DALT',   label: 'Dorm Alt',     slug: 'dmrm2-5',      tab: 'Dorm Alternate',  floor: 'down', streamKey: 'dorm alternate'  },
    { id: 'MALT',   label: 'Market Alt',   slug: 'mrke2-5',      tab: 'Market Alternate',floor: 'down', streamKey: 'market alternate'},
    { id: 'JOBB',   label: 'Jungle Loft',  slug: 'jobb-5',       tab: null,              floor: 'up',   streamKey: 'jungle loft'    },
  ];

  // Alt cameras are accessed by clicking zone polygons on the parent stream's video overlay.
  // The zones API tells us which polygon to click. We fetch zone data at startup and cache it.
  const ALT_CAMERAS = {
    'BPTZ': { parentId: 'BAR',    parentSlug: 'brrr-5', altSlug: 'brpz-5' },
    'BALT': { parentId: 'BAR',    parentSlug: 'brrr-5', altSlug: 'brrr2-5' },
    'DALT': { parentId: 'DORM',   parentSlug: 'dmrm-5', altSlug: 'dmrm2-5' },
    'MALT': { parentId: 'MARKET', parentSlug: 'mrke-5', altSlug: 'mrke2-5' },
    'JOBB': { parentId: 'HALLU',  parentSlug: 'hwup-5', altSlug: 'jobb-5'  },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STATE ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let allStreams        = [];
  let _streamsLoaded    = false;
  let _activeRoomId     = null;
  let _switchingSlug    = null;
  let _lastDetectedSlug = null;

  // Cleanup handles — collected and released on beforeunload
  const _cleanupAC         = new AbortController(); // aborts all document event listeners
  let _streamWatcher = null;
  let _mapObserver         = null;
  let _floorGuard          = null;

  // Cache: { BALT: { zoneIndex: 1, points: "0.35,0.00 ..." }, ... }
  const altZoneCache = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STREAM TOKEN / URL ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function getStreamToken() {
    try {
      const entries = (unsafeWindow || window).performance.getEntriesByType('resource');
      for (const e of entries) {
        let m = e.name.match(/streams-[a-z]\.fishtank\.live.*[?&]tkn=([^&]+)/);
        if (m) return { param: 'tkn', value: decodeURIComponent(m[1]) };
        m = e.name.match(/streams-[a-z]\.fishtank\.live.*[?&]jwt=([^&]+)/);
        if (m) return { param: 'jwt', value: decodeURIComponent(m[1]) };
      }
    } catch(e) {}
    return null;
  }

  function slugToM3u8(slug) {
    const tkn = getStreamToken();
    const base = `https://streams-k.fishtank.live/hls/live+${slug}/index.m3u8`;
    return tkn ? `${base}?${tkn.param}=${tkn.value}` : base;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STREAMS + ALT ZONE PREFETCH ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadStreams() {
    if (_streamsLoaded) return;
    _streamsLoaded = true;
    try {
      const r = await gmFetch('https://api.fishtank.live/v1/live-streams');
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      allStreams = Array.isArray(data) ? data : (data.liveStreams || data.streams || []);
      console.log('[SOON] streams loaded:', allStreams.length);
      prefetchAltZones();
    } catch(e) {
      _streamsLoaded = false;
      console.error('[SOON] loadStreams:', e);
    }
  }

  async function prefetchAltZones() {
    for (const [altId, altDef] of Object.entries(ALT_CAMERAS)) {
      try {
        const r = await gmFetch(`https://api.fishtank.live/v1/live-streams/zones/${altDef.parentSlug}`);
        if (!r.ok) { console.warn('[SOON] zones fetch failed for', altDef.parentSlug, r.status); continue; }
        const data = await r.json();
        const zones = data.clickableZones || data.zones || data;
        if (!Array.isArray(zones)) { console.warn('[SOON] zones not array for', altDef.parentSlug); continue; }

        // Find the zone whose action navigates to the alt stream
        const idx = zones.findIndex(z => {
          const meta = z.action?.metadata || z.metadata || z.targetId || z.target || '';
          return meta === altDef.altSlug || String(meta).includes(altDef.altSlug);
        });

        if (idx !== -1) {
          altZoneCache[altId] = { zoneIndex: idx, points: zones[idx].points || '' };
          console.log('[SOON] alt zone cached:', altId, '→ index', idx);
        } else {
          console.warn('[SOON] alt zone not found for', altId, '— metadata:', zones.map(z => z.action?.metadata || '?'));
        }
      } catch(e) {
        console.error('[SOON] prefetchAltZones error:', altId, e);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ROOM SELECTION ─────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function onRoomSelected(roomId) {
    _activeRoomId = roomId;
    const room = ROOMS.find(r => r.id === roomId);
    if (!room?.slug) return;
    window.SOON = window.SOON || {};
    window.SOON.activeRoomId = roomId;
    window.SOON.activeRoom   = room;
    window.SOON.activeSlug   = room.slug;
    window.SOON.activeM3u8   = slugToM3u8(room.slug);
    if (typeof window.SOON.onRoomChange === 'function') {
      window.SOON.onRoomChange(roomId, room, room.slug, window.SOON.activeM3u8);
    }
  }

  // Click Fishtank's own tab button for a room
  function clickTab(roomId) {
    const room = ROOMS.find(r => r.id === roomId);
    if (!room?.tab) return false;
    function fireClick(el) {
      el.focus();
      ['mousedown','mouseup','click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) }))
      );
    }
    function isMatch(btnText) {
      const cleaned = btnText.replace(/\d+$/, '').trim();
      return cleaned === room.tab || cleaned === room.label;
    }
    for (const btn of document.querySelectorAll('button')) {
      // Skip our own buttons
      if (btn.dataset?.soonRoom || btn.closest('#soon-alt-overlay')) continue;
      const text = btn.textContent.trim();
      if (isMatch(text)) {
        console.log('[SOON] clickTab matched:', text, '→', room.id);
        fireClick(btn);
        return true;
      }
    }
    console.warn('[SOON] clickTab: no button found for', room.tab);
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ALT CAMERAS — ZONE POLYGON CLICK ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function firePolygonClick(polygon) {
    const rect = polygon.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      polygon.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        view: unsafeWindow || window,
      }));
    });
    console.log('[SOON] fired polygon click at', cx.toFixed(0), cy.toFixed(0));
  }

  function switchToAltCam(altId, retried = false) {
    const altDef = ALT_CAMERAS[altId];
    if (!altDef) return false;

    const cached = altZoneCache[altId];
    if (!cached) {
      if (!retried) {
        console.log('[SOON] zone cache miss for', altId, '— waiting for prefetch...');
        setTimeout(() => switchToAltCam(altId, true), 2000);
        return true;
      }
      console.warn('[SOON] no cached zone data for', altId, '— try refreshing');
      return false;
    }

    console.log('[SOON] switchToAltCam:', altId, 'zone index:', cached.zoneIndex);

    // Step 1: make sure we're on the parent room
    const needsSwitch = _activeRoomId !== altDef.parentId;
    if (needsSwitch) {
      clickTab(altDef.parentId);
      onRoomSelected(altDef.parentId);
    }

    // Step 2: find the right polygon and click it.
    // Match by points attribute (stable across DOM reorder), fall back to index.
    const targetIdx = cached.zoneIndex;
    const targetPoints = cached.points || '';
    let done = false;

    function tryClick() {
      if (done) return true;
      const polygons = document.querySelectorAll('polygon.absolute');
      if (polygons.length <= targetIdx) return false;
      let poly = targetPoints
        ? [...polygons].find(p => p.getAttribute('points') === targetPoints)
        : null;
      if (!poly) poly = polygons[targetIdx];
      if (!poly?.isConnected) return false;
      done = true;
      firePolygonClick(poly);
      onRoomSelected(altId);
      console.log('[SOON] alt cam switched:', altId);
      // Guard against map floor change — keep the map on the alt cam's floor
      const altRoom = ROOMS.find(r => r.id === altId);
      const wantFloor = altRoom?.floor || 'down';
      const mapImg = document.querySelector('img[src*="map/s5/"]');
      if (mapImg) {
        if (_floorGuard) _floorGuard.disconnect();
        _floorGuard = new MutationObserver(() => {
          const wantLower = wantFloor === 'down';
          const isLower = mapImg.src && mapImg.src.includes('lower');
          if (wantLower && !isLower) {
            mapImg.src = mapImg.src.replace(/upper/, 'lower');
            const floorBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Downstairs');
            if (floorBtn) floorBtn.click();
            console.log('[SOON] intercepted floor switch, reverted to downstairs');
          } else if (!wantLower && isLower) {
            mapImg.src = mapImg.src.replace(/lower/, 'upper');
            const floorBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Upstairs');
            if (floorBtn) floorBtn.click();
            console.log('[SOON] intercepted floor switch, reverted to upstairs');
          }
        });
        _floorGuard.observe(mapImg, { attributes: true, attributeFilter: ['src'] });
        setTimeout(() => { if (_floorGuard) { _floorGuard.disconnect(); _floorGuard = null; } }, 2000);
      }
      return true;
    }

    // If already on parent room, try immediately
    if (!needsSwitch && tryClick()) return true;

    // Poll until polygons appear. When switching rooms, wait for React to
    // swap out the old polygons — points data from the API may not exactly
    // match DOM attributes, so we can't rely on it to filter stale polygons.
    let attempts = 0;
    setTimeout(() => {
      const poll = setInterval(() => {
        if (done) { clearInterval(poll); return; }
        attempts++;
        if (tryClick()) { clearInterval(poll); return; }
        if (attempts >= 40) {
          clearInterval(poll);
          console.warn('[SOON] alt zone polygon never appeared for', altId);
        }
      }, 100);
    }, needsSwitch ? 500 : 0);

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SLUG SWITCHING ─────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function switchToSlug(slug) {
    if (_switchingSlug === slug) return;

    // Already on this room — nothing to do
    const targetRoom = ROOMS.find(r => r.slug === slug);
    if (targetRoom && targetRoom.id === _activeRoomId) return;

    _switchingSlug = slug;
    console.log('[SOON] switchToSlug:', slug);

    // Check if this is an alt cam
    const altId = Object.keys(ALT_CAMERAS).find(id => ROOMS.find(r => r.id === id)?.slug === slug);

    if (altId) {
      switchToAltCam(altId);
      setTimeout(() => { _switchingSlug = null; }, 3000);
      return;
    }

    // Regular room — use tab click
    const room = ROOMS.find(r => r.slug === slug);
    if (room) {
      clickTab(room.id);
      onRoomSelected(room.id);
      // Ensure map shows correct floor after switch
      ensureMapFloor(room.floor);
    }
    _switchingSlug = null;
  }

  // Force the native map to show the correct floor.
  // When floor is null (Director, Cameraman), freeze the map on its current floor.
  //
  // React replaces the <img> element on re-render, so MutationObserver on the old
  // element doesn't work. Instead we poll — checking repeatedly after the click to
  // catch and revert the change regardless of React's render timing.
  function ensureMapFloor(floor) {
    const mapImg = document.querySelector('img[src*="map/s5/"]');
    if (!mapImg) return;

    // Snapshot which floor we want BEFORE native code acts
    const currentlyDown = mapImg.src.includes('lower');
    const wantDown = floor ? (floor === 'down') : currentlyDown;

    function forceFloor() {
      const img = document.querySelector('img[src*="map/s5/"]');
      if (!img) return;
      if (img.src.includes('lower') === wantDown) return; // already correct
      const label = wantDown ? 'Downstairs' : 'Upstairs';
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
      if (btn) {
        btn.click();
        console.log('[SOON] forced map to', label);
      }
    }

    // Poll at multiple intervals to catch React re-renders.
    [200, 400, 700, 1200].forEach(ms => setTimeout(forceFloor, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ALT CAM OVERLAY (buttons on the map) ───────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const ALT_BUTTONS = [
    ['BPTZ', 'PTZ', 43.0, 52.0, 7.0, 12.0, 'down'],
    ['BALT', 'ALT', 52.0, 82.0, 7.0, 12.0, 'down'],
    ['MALT', 'ALT', 71.0, 18.0, 7.0, 10.0, 'down'],
    ['DALT', 'ALT', 76.0, 33.0, 7.0, 12.0, 'down'],
    ['JOBB', 'JOB', 25.0, 42.0, 6.0, 7.0, 'up'],
  ];

  let _altOverlay = null;

  function injectAltOverlay() {
    if (_altOverlay) return;

    const mapImg = document.querySelector('img[src*="map/s5/"]');
    if (!mapImg) return;
    const parent = mapImg.parentElement;
    if (!parent) return;

    console.log('[SOON] alt overlay attaching to map container, size:', parent.offsetWidth, 'x', parent.offsetHeight);

    const overlay = document.createElement('div');
    overlay.id = 'soon-alt-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';

    for (const [roomId, label, l, t, w, h, btnFloor] of ALT_BUTTONS) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.soonRoom = roomId;
      btn.dataset.floor = btnFloor;
      btn.style.cssText = [
        'position:absolute',
        `left:${l}%`, `top:${t}%`, `width:${w}%`, `height:${h}%`,
        'pointer-events:auto',
        'background:rgba(0,0,0,0.35)',
        'border:1px solid rgba(255,255,255,0.3)',
        'border-radius:3px',
        'color:rgba(255,255,255,0.75)',
        'font-size:clamp(5px,1vw,9px)',
        'font-weight:700',
        'letter-spacing:0.06em',
        'text-transform:uppercase',
        'cursor:pointer',
        'display:flex', 'align-items:center', 'justify-content:center',
        'transition:background 0.12s,color 0.12s',
        'white-space:nowrap',
        'padding:1px',
        'z-index:10',
      ].join(';');

      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(223,78,30,0.5)';
        btn.style.color = '#fff';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(0,0,0,0.35)';
        btn.style.color = 'rgba(255,255,255,0.75)';
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const room = ROOMS.find(r => r.id === roomId);
        if (room?.slug) switchToSlug(room.slug);
      });

      overlay.appendChild(btn);
    }

    parent.appendChild(overlay);
    _altOverlay = overlay;
    console.log('[SOON] alt cam overlay injected');
  }

  function watchForNativeMap() {
    if (!_altOverlay) injectAltOverlay();

    // Track the image element we're currently observing so we can re-attach
    // if React swaps it out for a new element.
    let _observedImg = null;

    function updateOverlayVisibility() {
      if (!_altOverlay) { injectAltOverlay(); return; }
      const mapImg = document.querySelector('img[src*="map/s5/"]');
      if (!mapImg) return;
      const isDownstairs = mapImg.src.includes('lower');
      const currentFloor = isDownstairs ? 'down' : 'up';
      _altOverlay.style.display = '';
      for (const btn of _altOverlay.querySelectorAll('button[data-floor]')) {
        btn.style.display = btn.dataset.floor === currentFloor ? '' : 'none';
      }
      if (isDownstairs && !document.getElementById('soon-alt-overlay')) {
        _altOverlay = null;
        injectAltOverlay();
      }
      // If the image element changed (React re-render), re-attach observer to new element
      if (mapImg !== _observedImg) {
        attachImgObserver(mapImg);
      }
    }

    function attachImgObserver(img) {
      if (_mapObserver) _mapObserver.disconnect();
      _observedImg = img;
      _mapObserver = new MutationObserver(updateOverlayVisibility);
      // Watch the image itself for src changes (floor switch)
      _mapObserver.observe(img, { attributes: true, attributeFilter: ['src'] });
      // Also watch its parent for childList changes (React swapping the element)
      if (img.parentElement) {
        _mapObserver.observe(img.parentElement, { childList: true });
      }
    }

    if (_mapObserver) _mapObserver.disconnect();

    // Find the map image and attach observer directly to it.
    // Falls back to a lightweight poll if the map isn't in the DOM yet.
    const mapImg = document.querySelector('img[src*="map/s5/"]');
    if (mapImg) {
      attachImgObserver(mapImg);
    } else {
      let _mapPollAttempts = 0;
      const _mapPoll = setInterval(() => {
        _mapPollAttempts++;
        const img = document.querySelector('img[src*="map/s5/"]');
        if (img) {
          clearInterval(_mapPoll);
          attachImgObserver(img);
        } else if (_mapPollAttempts >= 30) {
          clearInterval(_mapPoll);
        }
      }, 500);
    }

    // Also intercept Upstairs/Downstairs button clicks directly — the most
    // reliable trigger since the user clicking the button is what causes the
    // floor switch. MutationObserver is the backup for programmatic changes.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('button');
      if (!btn) return;
      const text = btn.textContent?.trim();
      if (text === 'Upstairs' || text === 'Downstairs') {
        // Defer slightly — the src change happens after the click handler
        setTimeout(updateOverlayVisibility, 100);
      }
    }, { capture: true, signal: _cleanupAC.signal });

    [500, 1500, 3000].forEach(ms => setTimeout(updateOverlayVisibility, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MUTE NATIVE MAP HOVER SOUNDS ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function muteMapHoverSounds() {
    // Guard against double-patching if script reloads — chained wraps would
    // make _origPlay point to the already-wrapped function, breaking audio.
    if (HTMLAudioElement.prototype.__soonPatched__) {
      console.log('[SOON] map hover sound intercept already active — skipping');
      return;
    }
    HTMLAudioElement.prototype.__soonPatched__ = true;

    // Track whether we're in a hover event — only mute sounds triggered by hover.
    // Uses a single pointermove listener instead of 5 separate mouse listeners.
    // Pointer events fire less frequently than mouseover/mouseenter on complex DOMs.
    let _inHover = false;
    let _hoverTimer = null;
    const sig = { capture: true, signal: _cleanupAC.signal };
    document.addEventListener('pointermove', () => {
      _inHover = true;
      clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(() => { _inHover = false; }, 150);
    }, sig);
    // Click resets hover flag so click sounds play
    document.addEventListener('click', () => { _inHover = false; }, sig);

    const _origPlay = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = function() {
      if (_inHover) {
        this.muted = true;
        return Promise.resolve();
      }
      return _origPlay.call(this);
    };
    console.log('[SOON] map hover sound intercept active (clicks preserved)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── NATIVE MAP + TAB SYNC ──────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function hookNativeMapClicks() {
    document.addEventListener('click', (e) => {
      const el = e.target;
      if (el.tagName !== 'POLYGON') return;

      const slug = el.getAttribute('data-target-slug') ||
                   el.closest('[data-target-slug]')?.getAttribute('data-target-slug');
      if (!slug) return;

      const room = ROOMS.find(r => r.slug === slug);
      if (room) {
        setTimeout(() => onRoomSelected(room.id), 200);
      }
    }, { capture: true, signal: _cleanupAC.signal });
  }

  function watchStreamChanges() {
    // Event-driven: PerformanceObserver fires only when new resources load,
    // replacing the 1-second setInterval that polled the entire resource timing buffer.
    // Zero CPU cost when no new stream segments arrive.
    if (_streamWatcher) { _streamWatcher.disconnect(); _streamWatcher = null; }
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const url = entries[i].name;
          if (!url.includes('streams-') || !url.includes('.fishtank.live')) continue;
          const m = url.match(/live\+([a-z0-9]+-\d+)/);
          if (!m) continue;
          const slug = m[1];
          if (slug === _lastDetectedSlug) break;
          _lastDetectedSlug = slug;
          const room = ROOMS.find(r => r.slug === slug);
          if (room && room.id !== _activeRoomId) {
            onRoomSelected(room.id);
          }
          break;
        }
      });
      observer.observe({ type: 'resource', buffered: false });
      _streamWatcher = observer; // stored for cleanup
    } catch(e) {
      // Fallback for browsers that don't support PerformanceObserver (unlikely)
      console.warn('[SOON] PerformanceObserver unavailable, falling back to polling');
      const interval = setInterval(() => {
        try {
          const entries = (unsafeWindow || window).performance.getEntriesByType('resource');
          const recent = entries.slice(-50);
          for (let i = recent.length - 1; i >= 0; i--) {
            const url = recent[i].name;
            if (!url.includes('streams-') || !url.includes('.fishtank.live')) continue;
            const m = url.match(/live\+([a-z0-9]+-\d+)/);
            if (!m) continue;
            const slug = m[1];
            if (slug === _lastDetectedSlug) break;
            _lastDetectedSlug = slug;
            const room = ROOMS.find(r => r.slug === slug);
            if (room && room.id !== _activeRoomId) {
              onRoomSelected(room.id);
            }
            break;
          }
        } catch(e) {}
      }, 1000);
      _streamWatcher = { disconnect() { clearInterval(interval); } };
    }
  }

  function watchTabClicks() {
    document.addEventListener('click', (e) => {
      let el = e.target;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        if (el.tagName === 'BUTTON') {
          if (el.dataset?.soonRoom || el.closest('#soon-alt-overlay')) break;
          if (el.dataset?.fpRoom || el.closest('#ftfp-map')) break;

          const text = el.textContent?.trim().replace(/\d+$/, '').trim();
          const room = ROOMS.find(r => r.tab && (
            text === r.tab || text === r.label ||
            r.tab.startsWith(text) || r.label.startsWith(text)
          ));
          if (room) {
            onRoomSelected(room.id);
            ensureMapFloor(room.floor);
            break;
          }
        }
        el = el.parentElement;
      }
    }, { capture: true, signal: _cleanupAC.signal });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLEANUP ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function cleanup() {
    if (_streamWatcher) { _streamWatcher.disconnect();   _streamWatcher = null; }
    if (_mapObserver)         { _mapObserver.disconnect();           _mapObserver = null; }
    if (_floorGuard)          { _floorGuard.disconnect();            _floorGuard = null; }
    _cleanupAC.abort(); // removes all document event listeners registered with _cleanupAC.signal
  }
  window.addEventListener('beforeunload', cleanup);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INIT ───────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    window.SOON = window.SOON || {};
    window.SOON.ROOMS          = ROOMS;
    window.SOON.getStreamToken = getStreamToken;
    window.SOON.slugToM3u8     = slugToM3u8;
    window.SOON.switchToSlug   = switchToSlug;

    hookNativeMapClicks();
    watchTabClicks();
    watchStreamChanges();
    watchForNativeMap();
    muteMapHoverSounds();
    loadStreams();

    console.log('[SOON] Soon Map v3.2.8 ready');
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

})();
