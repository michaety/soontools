// ==UserScript==
// @name         Soon Map
// @namespace    https://fishtank.news
// @version      2.2.2
// @description  Interactive floorplan map for fishtank.live — click any room to switch cam, syncs with the tab bar. By fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.fishtank.live
// @connect      streams-g.fishtank.live
// @connect      raw.githubusercontent.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SHARED ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const LS = {
    get: k => { try { return localStorage.getItem('ftc_' + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem('ftc_' + k, v); } catch {} }
  };

  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        anonymous: false,
        withCredentials: true,
        headers: {
          'Accept': 'application/json',
          ...(opts.headers || {})
        },
        responseType: 'text',
        onload(r) {
          if (r.status === 0) { reject(new Error('gmFetch status 0')); return; }
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            _body: r.responseText,
            text() { return Promise.resolve(r.responseText); },
            json() {
              try { return Promise.resolve(JSON.parse(r.responseText)); }
              catch(e) { return Promise.reject(new Error('gmFetch JSON parse failed: ' + r.responseText.slice(0,100))); }
            }
          });
        },
        onerror(e) { reject(new Error('gmFetch network error: ' + (e?.error || 'unknown'))); },
        ontimeout() { reject(new Error('gmFetch timeout')); }
      });
    });
  }

  function getCSSVar(name, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  }
  function getTheme() {
    return {
      primary:       getCSSVar('--base-primary',          '#df4e1e'),
      secondary:     getCSSVar('--base-secondary',        '#26b64b'),
      dark:          getCSSVar('--base-dark',              '#191c20'),
      light:         getCSSVar('--base-light',             '#dddec4'),
      background:    getCSSVar('--base-background',        '#557194'),
      fontPrimary:   getCSSVar('--base-font-primary',   'sofia-pro-variable, sans-serif'),
      fontSecondary: getCSSVar('--base-font-secondary', 'highway-gothic, sans-serif'),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ZONES API ──────────────────────────────────────────────────────────────
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

  async function fetchZones(slug) {
    if (!slug) return [];
    try {
      const r = await gmFetch(`https://api.fishtank.live/v1/live-streams/zones/${slug}`);
      if (!r.ok) return [];
      const data = await r.json();
      return data.clickableZones || [];
    } catch(e) {
      console.warn('[SOON] fetchZones failed for', slug, e.message);
      return [];
    }
  }

  function parseZonePoints(pointsStr) {
    return (pointsStr || '').trim().split(/\s+/).map(pair => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    }).filter(p => !isNaN(p.x) && !isNaN(p.y));
  }

  let _zoneOverlay  = null;
  let _activeSlug   = null;
  let _zonesFetching = false;

  function getVideoEl() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 100) { best = v; bestArea = area; }
    }
    return best;
  }

  function removeZoneOverlay() {
    if (_zoneOverlay) { _zoneOverlay.remove(); _zoneOverlay = null; }
  }

  async function showZoneOverlay(slug) {
    if (_zonesFetching) return;
    _zonesFetching = true;
    removeZoneOverlay();
    let zones = [];
    try { zones = await fetchZones(slug); } finally { _zonesFetching = false; }
    if (!zones.length) return;
    const vid = getVideoEl();
    if (!vid) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    // svg style set after appending to video parent
    const T = getTheme();
    for (const zone of zones) {
      if (zone.action?.name !== 'Change Live Stream') continue;
      const pts = parseZonePoints(zone.points);
      if (pts.length < 3) continue;
      const targetSlug = zone.action.metadata;
      const g = document.createElementNS(NS, 'g');
      g.dataset.targetSlug = targetSlug;
      g.dataset.normPoints = zone.points;
      const vis = document.createElementNS(NS, 'polygon');
      vis.style.cssText = `fill:${T.primary};opacity:0;stroke:${T.primary};stroke-width:1.5;transition:opacity 0.15s;`;
      vis.setAttribute('pointer-events', 'none');
      const hit = document.createElementNS(NS, 'polygon');
      hit.setAttribute('data-target-slug', targetSlug);
      hit.style.cssText = 'fill:transparent;stroke:none;cursor:pointer;';
      hit.setAttribute('pointer-events', 'all');
      hit.addEventListener('mouseenter', () => { vis.style.opacity = '0.35'; });
      hit.addEventListener('mouseleave', () => { vis.style.opacity = '0'; });
      hit.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetRoom = ROOMS.find(r => r.slug === targetSlug);
        if (targetRoom) {
          // Update map and switch stream without tearing down the zone overlay
          fpActiveRoom = targetRoom.id;
          if (targetRoom.floor && targetRoom.floor !== fpFloor) {
            fpFloor = targetRoom.floor;
            fpRebuildSVG();
          } else {
            if (fpMapEl) {
              fpMapEl.querySelectorAll('[id^="ftfp-fill-"]').forEach(f => {
                const id = f.id.replace('ftfp-fill-','');
                f.setAttribute('fill', id === fpActiveRoom ? FP_FILL_ACTIVE : 'transparent');
                f.setAttribute('opacity', id === fpActiveRoom ? '0.45' : '0');
              });
            }
            if (fpBuildLabelsRef) fpBuildLabelsRef();
          }
          fpClickTab(targetRoom.id);
          clipApplyRoomStream(targetRoom.id);
          // Refresh zone overlay for the new room after a short delay
          setTimeout(() => {
            removeZoneOverlay();
            if (targetRoom.slug) showZoneOverlay(targetRoom.slug);
          }, 500);
        } else {
          switchToSlug(targetSlug);
        }
      });
      g.appendChild(vis); g.appendChild(hit);
      svg.appendChild(g);
    }
    // Insert SVG inside the video's parent so it's naturally clipped by the
    // video container and sits under the player controls in normal stacking order
    const vidParent = vid.parentElement;
    if (!vidParent) { _zonesFetching = false; return; }
    const vidParentPos = getComputedStyle(vidParent).position;
    if (vidParentPos === 'static') vidParent.style.position = 'relative';
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:hidden;';
    vidParent.appendChild(svg);
    _zoneOverlay = svg;
    _activeSlug = slug;
    // No reposition loop needed — SVG is positioned relative to video parent
    // Polygon coords are 0-1 normalized to video frame, use % via viewBox
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const g of svg.querySelectorAll('g[data-norm-points]')) {
      const pts = parseZonePoints(g.dataset.normPoints);
      const ptStr = pts.map(p => `${p.x},${p.y}`).join(' ');
      g.querySelector('polygon:nth-of-type(1)').setAttribute('points', ptStr);
      g.querySelector('polygon:nth-of-type(2)').setAttribute('points', ptStr);
      // stroke-width in viewBox 0-1 space needs to be tiny
      g.querySelector('polygon:nth-of-type(1)').style.strokeWidth = '0.003';
    }
  }

  const ALT_CAMERAS = {
    'BALT': { parentId: 'BAR',    xyRatio: 9.19 },
    'DALT': { parentId: 'DORM',   xyRatio: 390  },
    'MALT': { parentId: 'MARKET', xyRatio: 263  },
  };

  function findAltPolygon(xyRatio) {
    const polygons = document.querySelectorAll('polygon');
    return Array.from(polygons).find(p => {
      const pts = p.getAttribute('points');
      if (!pts) return false;
      const coords = pts.split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
      if (coords.length < 2 || coords[1] === 0) return false;
      const ratio = coords[0] / coords[1];
      return Math.abs(ratio - xyRatio) / xyRatio < 0.15;
    });
  }

  function clickPolygonCentre(polygon) {
    const rect = polygon.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    polygon.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy,
      view: unsafeWindow || window,
    }));
    console.log('[SOON] clicked polygon centre at', cx.toFixed(0), cy.toFixed(0));
  }

  let _switchingSlug = null; // re-entry guard
  function switchToSlug(slug) {
    if (_switchingSlug === slug) return; // prevent re-entrant calls
    console.log('[SOON] switchToSlug:', slug);
    // Alt cams must use the polygon click mechanism — check these first
    const altId  = Object.keys(ALT_CAMERAS).find(id => ROOMS.find(r => r.id === id)?.slug === slug);
    const altDef = altId ? ALT_CAMERAS[altId] : null;
    if (altDef) {
      // Fall through to alt cam polygon logic below
    } else {
      // For all other slugs, do a direct room lookup
      const directRoom = ROOMS.find(r => r.slug === slug);
      if (directRoom) { onRoomSelected(directRoom.id); return; }
      // Unknown slug — try syncing map via stream name
      const stream = allStreams.find(s => s.id === slug);
      if (stream) { syncMapToStream(slug); }
      return;
    }
    const alreadyOnParent = fpActiveRoom === altDef.parentId;
    const pollForPolygon = (attempts = 0) => {
      const polygon = findAltPolygon(altDef.xyRatio);
      if (polygon) {
        _switchingSlug = slug;
        clickPolygonCentre(polygon);
        _activeSlug = slug;
        showZoneOverlay(slug);
        window.SOON = window.SOON || {};
        window.SOON.activeSlug = slug;
        window.SOON.activeM3u8 = slugToM3u8(slug);
        setTimeout(() => { _switchingSlug = null; }, 1000); // clear guard after 1s
      } else if (attempts < 20) { // reduced from 100 — fail faster
        setTimeout(() => pollForPolygon(attempts + 1), 100);
      } else {
        console.warn('[SOON] switchToSlug: polygon not found for', slug);
        _switchingSlug = null;
      }
    };
    if (alreadyOnParent) {
      pollForPolygon();
    } else {
      fpActiveRoom = altDef.parentId;
      const parentRoom = ROOMS.find(r => r.id === altDef.parentId);
      if (parentRoom?.floor) fpFloor = parentRoom.floor;
      fpRebuildSVG();
      fpClickTab(altDef.parentId);
      pollForPolygon();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ROOMS ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  const ROOMS = [
    // ── DOWNSTAIRS ─────────────────────────────────────────────────────────
    { id: 'GLASS',  label: 'Glass Room',   slug: 'gsrm-5',  tab: 'Glassroom',    floor: 'down', streamKey: 'glass'           },
    { id: 'FOYER',  label: 'Foyer',        slug: 'foyr-5',  tab: 'Foyer',         floor: 'down', streamKey: 'foyer'           },
    { id: 'MARKET', label: 'Market',       slug: 'mrke-5',  tab: 'Market',        floor: 'down', streamKey: 'market'          },
    { id: 'JACUZ',  label: 'Jacuzzi',      slug: 'jckz-5',  tab: 'Jacuzzi',       floor: 'down', streamKey: 'jacuzzi'         },
    { id: 'HALLD',  label: 'Hallway',      slug: 'hwdn-5',  tab: 'Hallway Down',  floor: 'down', streamKey: 'hallway down'    },
    { id: 'DINING', label: 'Dining Room',  slug: 'dnrm-5',  tab: 'Dining Room',   floor: 'down', streamKey: 'dining'          },
    { id: 'KITCH',  label: 'Kitchen',      slug: 'ktch-5',  tab: 'Kitchen',       floor: 'down', streamKey: 'kitchen'         },
    { id: 'BAR',    label: 'Bar',          slug: 'brrr-5',  tab: 'Bar',           floor: 'down', streamKey: 'bar'             },
    { id: 'CLOS',   label: 'Closet',       slug: 'dmcl-5',  tab: 'Closet',        floor: 'down', streamKey: 'closet'          },
    { id: 'DORM',   label: 'Dorm',         slug: 'dmrm-5',  tab: 'Dorm',          floor: 'down', streamKey: 'dorm'            },
    // ── UPSTAIRS ───────────────────────────────────────────────────────────
    { id: 'CONF',   label: 'Confessional', slug: 'cfsl-5',  tab: 'Confessional',  floor: 'up',   streamKey: 'confess'         },
    { id: 'CORR',   label: 'Corridor',     slug: 'codr-5',  tab: 'Corridor',      floor: 'up',   streamKey: 'corridor'        },
    { id: 'JNDL',   label: 'Jungle Room',  slug: 'br4j-5',  tab: 'Jungle Room',   floor: 'up',   streamKey: 'jungle'          },
    { id: 'HALLU',  label: 'West Wing',    slug: 'hwup-5',  tab: 'Hallway Up',    floor: 'up',   streamKey: 'hallway up'      },
    { id: 'BALC',   label: 'East Wing',    slug: 'bkny-5',  tab: 'Balcony',       floor: 'up',   streamKey: 'balcony'         },
    // ── MISC ───────────────────────────────────────────────────────────────
    { id: 'DIR',    label: 'Director Mode',slug: 'dirc-5', tab: 'Director Mode', floor: null,   streamKey: 'director'        },
    { id: 'BPTZ',   label: 'Bar PTZ',      slug: 'brpz-5',  tab: 'Bar PTZ',       floor: 'down', streamKey: 'bar ptz'         },
    { id: 'CAM',    label: 'Cameraman',    slug: 'cameraman2-5',  tab: 'Cameraman',     floor: null,   streamKey: 'cameraman'       },
    // ── ALT CAMS ───────────────────────────────────────────────────────────
    { id: 'BALT',   label: 'Bar Alt',      slug: 'brrr2-5', tab: 'Bar Alternate',    floor: 'down', streamKey: 'bar alternate'    },
    { id: 'DALT',   label: 'Dorm Alt',     slug: 'dmrm2-5', tab: 'Dorm Alternate',   floor: 'down', streamKey: 'dorm alternate'   },
    { id: 'MALT',   label: 'Market Alt',   slug: 'mrke2-5', tab: 'Market Alternate', floor: 'down', streamKey: 'market alternate' },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FLOORPLAN STATE ────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let fpActiveRoom     = null;
  let fpFloor          = 'down';
  let fpMapVisible     = true;
  let fpMinimised      = false;
  let fpContainer      = null;
  let fpMapEl          = null;
  let fpMapWrap        = null;
  let fpInjected       = false;
  let offlineRooms     = new Set();
  let fpBuildLabelsRef = null;
  let _streamsLoaded   = false;
  let allStreams        = [];
  let playbackId = null, streamName = null, streamId = null;

  const FP_FILL_ACTIVE  = 'var(--base-primary,#df4e1e)';
  const FP_FILL_OFFLINE = 'rgba(0,0,0,0.25)';
  const FP_FILL_HOVER   = 'var(--base-primary,#df4e1e)';

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MAP SYNC ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // Syncs the map highlight to any stream slug from any source
  // (polygon navigation, tab bar clicks, director tiles, etc.)
  function syncMapToStream(streamSlug) {
    if (!streamSlug || !allStreams.length) return;
    const stream = allStreams.find(s => s.id === streamSlug);
    if (!stream) return;
    const name = stream.name?.toLowerCase() || '';
    const room = ROOMS.find(r => r.streamKey && name.includes(r.streamKey.toLowerCase()));
    if (!room || room.id === fpActiveRoom) return;
    fpActiveRoom = room.id;
    if (room.floor && room.floor !== fpFloor) {
      // Floor switch needed — full rebuild
      fpFloor = room.floor;
      fpRebuildSVG();
    } else {
      // Same floor — lightweight highlight update only
      if (fpMapEl) {
        fpMapEl.querySelectorAll('[id^="ftfp-fill-"]').forEach(f => {
          const id = f.id.replace('ftfp-fill-', '');
          f.setAttribute('fill', id === fpActiveRoom ? FP_FILL_ACTIVE : 'transparent');
          f.setAttribute('opacity', id === fpActiveRoom ? '0.45' : '0');
        });
      }
      if (fpBuildLabelsRef) fpBuildLabelsRef();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ROOM SELECTION ─────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function onRoomSelected(roomId) {
    fpActiveRoom = roomId;
    const room = ROOMS.find(r => r.id === roomId);
    if (room?.floor && room.floor !== fpFloor) fpFloor = room.floor;
    fpRebuildSVG();
    fpClickTab(roomId);
    clipApplyRoomStream(roomId);
    removeZoneOverlay();
    if (room?.slug) {
      showZoneOverlay(room.slug);
      window.SOON = window.SOON || {};
      window.SOON.activeRoomId = roomId;
      window.SOON.activeRoom   = room;
      window.SOON.activeSlug   = room.slug;
      window.SOON.activeM3u8   = slugToM3u8(room.slug);
      if (typeof window.SOON.onRoomChange === 'function') {
        window.SOON.onRoomChange(roomId, room, room.slug, window.SOON.activeM3u8);
      }
    }
  }

  function fpClickTab(roomId) {
    const room = ROOMS.find(r => r.id === roomId);
    if (!room || !room.tab) return false;
    function fireClick(el) {
      el.focus();
      ['mousedown','mouseup','click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) }))
      );
    }
    function isMatch(btnText, room) {
      const cleaned = btnText.replace(/\d+$/, '').trim();
      return cleaned === room.tab || cleaned === room.label;
    }
    if (fpContainer) {
      for (const btn of fpContainer.querySelectorAll('button')) {
        if (isMatch(btn.textContent.trim(), room)) { fireClick(btn); return true; }
      }
    }
    for (const btn of document.querySelectorAll('button')) {
      if (isMatch(btn.textContent.trim(), room)) { fireClick(btn); return true; }
    }
    console.warn('[SOON] fpClickTab: no button found for', room.tab);
    return false;
  }

  function fpCheckOfflineFromDOM() {
    const grid = document.querySelector('div.grid-cols-5, div.grid-cols-4');
    if (!grid) return;
    const newOffline = new Set();
    for (const room of ROOMS) {
      for (const btn of grid.querySelectorAll('button')) {
        const _t = btn.textContent.trim().replace(/\d+$/, '');
        if (_t === room.tab) {
          const cl = btn.className || '';
          if (cl.includes('cursor-not-allowed') || cl.includes('opacity-60')) newOffline.add(room.id);
          break;
        }
      }
    }
    const changed = newOffline.size !== offlineRooms.size ||
      [...newOffline].some(id => !offlineRooms.has(id)) ||
      [...offlineRooms].some(id => !newOffline.has(id));
    if (changed) { offlineRooms = newOffline; if (fpBuildLabelsRef) fpBuildLabelsRef(); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SVG FLOORPLAN ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function fpBuildSVG() {
    const isDown = fpFloor === 'down';
    const imgUrl = isDown
      ? 'https://cdn.fishtank.live/images/map/s5/lower.png'
      : 'https://cdn.fishtank.live/images/map/s5/upper.png';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;line-height:0;';

    // ── Map image ──────────────────────────────────────────────────────────
    const img = document.createElement('img');
    img.src = imgUrl;
    img.style.cssText = 'width:100%;height:auto;display:block;mix-blend-mode:darken;pointer-events:none;';
    wrap.appendChild(img);

    // ── Room hit zones ─────────────────────────────────────────────────────
    // Positions derived from fishtank's own map HTML
    const ZONES_DOWN = [
      { id:'GLASS',  pos:'top:3.9%;left:20.4%;width:20.4%;height:35.3%' },
      { id:'FOYER',  pos:'top:3.9%;left:40.8%;width:18.4%;height:35.3%' },
      { id:'MARKET', pos:'top:3.9%;left:59.1%;width:10.2%;height:27.5%' },
      { id:'JACUZ',  pos:'top:3.9%;left:69.3%;width:10.9%;height:27.5%' },
      { id:'HALLD',  pos:'top:39.2%;left:40.8%;width:39.4%;height:11.8%' },
      { id:'DINING', pos:'top:51.0%;left:2.0%;width:18.4%;height:47.1%' },
      { id:'KITCH',  pos:'top:51.0%;left:20.4%;width:20.4%;height:47.1%' },
      { id:'BAR',    pos:'top:51.0%;left:40.8%;width:20.4%;height:47.1%' },
      { id:'CLOS',   pos:'top:66.7%;left:61.2%;width:8.2%;height:19.6%' },
      { id:'DORM',   pos:'top:51.0%;left:69.3%;width:29.9%;height:47.1%' },
      { id:'BPTZ',   pos:'top:51.0%;left:40.8%;width:8%;height:15%',      isSub:true },
      { id:'BALT',   pos:'top:51.0%;left:49%;width:8%;height:15%',        isSub:true },
      { id:'DALT',   pos:'top:51.0%;left:69.3%;width:8%;height:13%',      isSub:true },
      { id:'MALT',   pos:'top:3.9%;left:59.1%;width:8%;height:11%',       isSub:true },
    ];
    const ZONES_UP = [
      { id:'JNDL',   pos:'top:3.9%;left:2.0%;width:38.7%;height:47.1%'  },
      { id:'BALC',   pos:'top:3.9%;left:59.1%;width:21.1%;height:47.1%' },
      { id:'CORR',   pos:'top:51.0%;left:2.0%;width:18.4%;height:47.1%' },
      { id:'HALLU',  pos:'top:51.0%;left:20.4%;width:38.7%;height:47.1%' },
      { id:'CONF',   pos:'top:51.0%;left:59.1%;width:21.1%;height:47.1%' },
    ];
    // Stair zones
    const STAIRS_DOWN = [
      'top:3.9%;left:38.7%;width:12.9%;height:31.4%',
    ];
    const STAIRS_UP = [
      'top:3.9%;left:36.7%;width:22.4%;height:47.1%',
      'top:51.0%;left:2.0%;width:14.3%;height:15.7%',
    ];

    const zones = isDown ? ZONES_DOWN : ZONES_UP;
    const stairs = isDown ? STAIRS_DOWN : STAIRS_UP;

    for (const z of zones) {
      const isOff = offlineRooms.has(z.id);
      const isActive = fpActiveRoom === z.id;
      const btn = document.createElement('div');
      btn.id = 'ftfp-fill-' + z.id;
      btn.style.cssText = [
        'position:absolute', z.pos,
        'display:flex', 'align-items:center', 'justify-content:center',
        'border-radius:2px',
        'transition:background 0.12s,opacity 0.12s',
        isOff    ? 'background:rgba(0,0,0,0.35);cursor:default;' :
        isActive ? 'background:color-mix(in srgb,var(--base-primary,#df4e1e) 35%,transparent);cursor:pointer;' :
                   'background:transparent;cursor:pointer;',
      ].join(';');

      if (!isOff) {
        btn.addEventListener('mouseenter', () => {
          if (fpActiveRoom !== z.id) btn.style.background = 'color-mix(in srgb,var(--base-primary,#df4e1e) 20%,transparent)';
        });
        btn.addEventListener('mouseleave', () => {
          if (fpActiveRoom !== z.id) btn.style.background = 'transparent';
        });
        btn.addEventListener('click', () => {
          if (z.id in ALT_CAMERAS) {
            const room = ROOMS.find(r => r.id === z.id);
            if (room?.slug) switchToSlug(room.slug);
          } else {
            onRoomSelected(z.id);
          }
        });
      }
      wrap.appendChild(btn);
    }

    // Stair zones
    for (const pos of stairs) {
      const btn = document.createElement('div');
      btn.style.cssText = `position:absolute;${pos};cursor:pointer;border-radius:2px;transition:background 0.12s;`;
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255,255,255,0.15)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fpFloor = isDown ? 'up' : 'down';
        fpRebuildSVG();
        if (fpBuildLabelsRef) fpBuildLabelsRef();
      });
      wrap.appendChild(btn);
    }

    return wrap;
  }

  function fpRebuildSVG() {
    if (!fpMapEl) return;
    fpMapEl.innerHTML = '';
    fpMapEl.appendChild(fpBuildSVG());
    if (fpBuildLabelsRef) fpBuildLabelsRef();
  }

  function fpFindTabBar() {
    const grids = document.querySelectorAll('div.grid-cols-5, div.grid-cols-4');
    for (const grid of grids) {
      const btns = grid.querySelectorAll('button');
      let matches = 0;
      for (const btn of btns) {
        if (ROOMS.some(r => r.tab && btn.textContent.trim() === r.tab)) matches++;
      }
      if (matches >= 3) return grid;
    }
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const btns = div.querySelectorAll(':scope > button');
      if (btns.length < 3) continue;
      let matches = 0;
      for (const btn of btns) {
        if (ROOMS.some(r => r.tab && btn.textContent.trim() === r.tab)) matches++;
      }
      if (matches >= 3) return div;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INJECT ─────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function fpInject() {
    if (document.getElementById('ftfp-map')) return;
    fpContainer = fpFindTabBar();
    if (!fpContainer) return;

    fpContainer.style.position      = 'fixed';
    fpContainer.style.left          = '-9999px';
    fpContainer.style.top           = '0';
    fpContainer.style.opacity       = '0';
    fpContainer.style.pointerEvents = 'auto';
    fpContainer.style.height        = 'auto';
    fpContainer.style.overflow      = 'visible';
    fpContainer.style.visibility    = 'hidden';

    const wrapper = document.createElement('div');
    wrapper.id = 'ftfp-map';
    wrapper.style.cssText = 'width:100%;position:relative;user-select:none;';

    // ── Top bar ─────────────────────────────────────────────────────────────
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;padding:0px 3.2px 1.6px;gap:6px;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border-bottom:1px solid rgba(0,0,0,0.15);box-shadow:rgba(255,255,255,0.5) 0px 1px 0px;flex-shrink:0;user-select:none;margin-bottom:0;';

    const fishIcon = document.createElement('span');
    fishIcon.innerHTML = `<svg style="width:14px;height:14px;margin-right:3.2px;flex-shrink:0;color:var(--base-primary,#df4e1e);filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24"><path d="M2 2v18h3v-1H3v-6h3V9h5V8H6V3h15v5h-6v1h6v5h-4v1h4v6H11v-7h-1v5H8v1h2v2h12V2zm3 4H3V5h2zm-2 6v-1h2v1zm2-2H3V9h2zM3 8V7h2v1zm2-4H3V3h2z" stroke-width="0"/></svg>`;

    const title = document.createElement('span');
    title.textContent = 'Map';
    title.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:14px;font-weight:700;color:rgb(25,28,32);flex:1;';

    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:13px;font-weight:400;padding:1px 6px;border:1px solid rgba(0,0,0,0.25);border-radius:3px;background:transparent;color:rgba(0,0,0,0.65);cursor:pointer;line-height:1.4;transition:color 0.12s,border-color 0.12s;';
    toggleBtn.textContent = 'TABS';
    toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.borderColor='var(--base-primary,#df4e1e)'; toggleBtn.style.color='var(--base-primary,#df4e1e)'; });
    toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.borderColor='rgba(0,0,0,0.25)'; toggleBtn.style.color='rgba(0,0,0,0.65)'; });

    const minimiseBtn = document.createElement('button');
    minimiseBtn.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:13px;font-weight:400;padding:1px 5px;border:1px solid rgba(0,0,0,0.25);border-radius:3px;background:transparent;color:rgba(0,0,0,0.65);cursor:pointer;line-height:1;transition:color 0.12s,border-color 0.12s;';
    minimiseBtn.textContent = '−';
    minimiseBtn.title = 'Minimise map';
    minimiseBtn.addEventListener('mouseenter', () => { minimiseBtn.style.borderColor='var(--base-primary,#df4e1e)'; minimiseBtn.style.color='var(--base-primary,#df4e1e)'; });
    minimiseBtn.addEventListener('mouseleave', () => { minimiseBtn.style.borderColor='rgba(0,0,0,0.25)'; minimiseBtn.style.color='rgba(0,0,0,0.65)'; });
    minimiseBtn.addEventListener('click', () => {
      fpMinimised = !fpMinimised;
      if (fpMapVisible) fpMapWrap.style.display = fpMinimised ? 'none' : '';
      minimiseBtn.textContent = fpMinimised ? '+' : '−';
      minimiseBtn.title = fpMinimised ? 'Expand map' : 'Minimise map';
    });

    // ── Director Mode button ─────────────────────────────────────────────────
    const dirBtn = document.createElement('button');
    dirBtn.dataset.fpRoom = 'DIR';
    dirBtn.textContent = 'DIRECTOR MODE';
    dirBtn.style.cssText = [
      'width:calc(100% - 16px)', 'display:block', 'margin:6px 8px', 'padding:5px 12px',
      'background:var(--base-dark,#191c20)', 'border:none', 'border-radius:20px',
      'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif)',
      'font-size:13px', 'font-weight:500', 'color:rgba(255,255,255,0.7)',
      'cursor:pointer', 'text-align:center',
      'box-shadow:0 2px 4px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.08)',
      'transition:box-shadow 0.1s,color 0.1s,background 0.1s',
    ].join(';');
    dirBtn.addEventListener('mouseenter', () => { if (fpActiveRoom !== 'DIR') { dirBtn.style.background='color-mix(in srgb, var(--base-dark,#191c20) 80%, var(--base-primary,#df4e1e))'; dirBtn.style.color='rgba(255,255,255,0.9)'; } });
    dirBtn.addEventListener('mouseleave', () => { if (fpActiveRoom !== 'DIR') { dirBtn.style.background='var(--base-dark,#191c20)'; dirBtn.style.color='rgba(255,255,255,0.7)'; } });
    dirBtn.addEventListener('click', () => onRoomSelected('DIR'));

    toggleBtn.addEventListener('click', () => {
      fpMapVisible = !fpMapVisible;
      if (fpMapVisible) {
        fpMapWrap.style.display = fpMinimised ? 'none' : '';
        toggleBtn.textContent = 'TABS';
        dirBtn.style.display = '';
        minimiseBtn.style.display = '';
        fpContainer.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:auto;height:auto;overflow:visible;visibility:hidden;';
      } else {
        fpMapWrap.style.display = 'none';
        toggleBtn.textContent = 'MAP';
        dirBtn.style.display = 'none';
        minimiseBtn.style.display = 'none';
        // Restore fishtank's tab bar to visible
        fpContainer.style.cssText = 'position:relative;left:auto;top:auto;opacity:1;pointer-events:auto;height:auto;overflow:visible;visibility:visible;';
      }
    });

    const fpRightGroup = document.createElement('div');
    fpRightGroup.style.cssText = 'display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0;';
    fpRightGroup.appendChild(toggleBtn);
    fpRightGroup.appendChild(minimiseBtn);
    topBar.appendChild(fishIcon);
    topBar.appendChild(title);
    topBar.appendChild(fpRightGroup);

    // ── Map SVG container ────────────────────────────────────────────────────
    fpMapEl = document.createElement('div');
    fpMapEl.style.cssText = 'width:100%;display:block;line-height:0;font-size:0;';
    fpMapEl.appendChild(fpBuildSVG());

    // ── Label overlay ────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.id = 'ftfp-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;';

    const LABELS_DOWN = [
      ['GLASS',   'GLASS ROOM',  20.4,  3.9, 20.4, 35.3],
      ['FOYER',   'FOYER',       40.8,  3.9, 18.4, 35.3],
      ['MARKET',  'MAR',         59.1,  3.9, 10.2, 27.5],
      ['JACUZ',   'JAC',         69.3,  3.9, 10.9, 27.5],
      ['HALLD',   'HALLWAY',     40.8, 39.2, 39.4, 11.8],
      ['DINING',  'DINING',       2.0, 51.0, 18.4, 47.1],
      ['KITCH',   'KITCHEN',     20.4, 51.0, 20.4, 47.1],
      ['BAR',     'BAR',         40.8, 51.0, 20.4, 47.1],
      ['CLOS',    'CLO',         61.2, 66.7,  8.2, 19.6],
      ['BPTZ',    'PTZ',         40.8, 51.0,  8.0, 15.0, true],
      ['BALT',    'ALT',         49.0, 51.0,  8.0, 15.0, true],
      ['DALT',    'ALT',         69.3, 51.0,  8.0, 13.0, true],
      ['MALT',    'ALT',         59.1,  3.9,  8.0, 11.0, true],
      ['DORM',    'DORM',        69.3, 51.0, 29.9, 47.1],
      ['_STRS1b', '',            38.7,  3.9, 12.9, 31.4, true],
    ];
    const LABELS_UP = [
      ['JNDL',    'JUNGLE',       2.0,  3.9, 38.7, 47.1],
      ['BALC',    'EAST WING',   59.1,  3.9, 21.1, 47.1],
      ['CORR',    'COR',          2.0, 51.0, 18.4, 47.1],
      ['HALLU',   'WEST WING',   20.4, 51.0, 38.7, 47.1],
      ['CONF',    'CON',         59.1, 51.0, 21.1, 47.1],
      ['_STRS1',  '',            36.7,  3.9, 22.4, 47.1, true],
    ];

    function fpBuildLabels() {
      overlay.innerHTML = '';
      const isDown = fpFloor === 'down';
      const LABELS = isDown ? LABELS_DOWN : LABELS_UP;
      const T = getTheme();
      for (let i = 0; i < LABELS.length; i++) {
        const [id, label, l, t, w, h] = LABELS[i];
        const isSub    = LABELS[i][6] === true;
        const isStair  = id.startsWith('_');
        const isOff    = !isStair && offlineRooms.has(id);
        const isActive = !isStair && fpActiveRoom === id;
        const btn = document.createElement('button');
        btn.dataset.fpRoom = id;
        btn.textContent = label;
        const activeBg    = 'color-mix(in srgb, var(--base-primary,#df4e1e) 35%, transparent)';
        const hoverBg     = 'color-mix(in srgb, var(--base-primary,#df4e1e) 20%, transparent)';
        const subBg       = 'rgba(0,0,0,0.06)';
        const normalColor = isOff ? 'rgba(255,255,255,0.3)' : isActive ? '#ffffff' : 'rgba(255,255,255,0.9)';
        const subColor    = isOff ? 'rgba(255,255,255,0.25)' : isActive ? '#ffffff' : 'rgba(255,255,255,0.6)';
        btn.style.cssText = [
          'position:absolute',
          `left:${l}%`, `top:${t}%`, `width:${w}%`, `height:${h}%`,
          `background:${isActive ? activeBg : isSub ? subBg : 'transparent'}`,
          `border:${isSub ? '1px solid rgba(255,255,255,0.25)' : 'none'}`,
          'display:flex', 'align-items:center', 'justify-content:center', 'text-align:center',
          `font-family:var(--base-font-secondary,${T.fontSecondary || 'highway-gothic,sans-serif'})`,
          `font-size:${isSub ? 'clamp(4px,0.85vw,6px)' : 'clamp(5px,1.1vw,8px)'}`,
          'font-weight:700', 'letter-spacing:0.08em', 'text-transform:uppercase',
          `color:${isSub ? subColor : normalColor}`,
          `cursor:${isOff ? 'default' : 'pointer'}`,
          'pointer-events:auto', 'line-height:1.0', 'padding:1px',
          'transition:color 0.15s,background 0.15s',
          'white-space:nowrap', 'overflow:hidden',
          isSub ? 'border-radius:3px' : 'border-radius:1px',
          isSub ? 'z-index:1' : '',
          isActive ? `box-shadow:inset 0 0 0 1px ${T.primary}55` : '',
        ].filter(Boolean).join(';');

        if (isStair) {
          btn.addEventListener('mouseenter', () => { btn.style.background = hoverBg; });
          btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            fpFloor = isDown ? 'up' : 'down';
            fpRebuildSVG();
            if (fpBuildLabelsRef) fpBuildLabelsRef();
          });
        } else if (!isOff) {
          btn.addEventListener('mouseenter', () => {
            if (fpActiveRoom !== id) { btn.style.color = '#ffffff'; btn.style.background = hoverBg; if (isSub) btn.style.border = '1px solid rgba(255,255,255,0.35)'; }
          });
          btn.addEventListener('mouseleave', () => {
            if (fpActiveRoom !== id) { btn.style.color = isSub ? subColor : normalColor; btn.style.background = isSub ? subBg : 'transparent'; if (isSub) btn.style.border = '1px solid rgba(255,255,255,0.18)'; }
          });
          btn.addEventListener('click', () => {
            if (id in ALT_CAMERAS) {
              const room = ROOMS.find(r => r.id === id);
              if (room?.slug) switchToSlug(room.slug);
            } else {
              onRoomSelected(id);
            }
          });
        }
        overlay.appendChild(btn);
      }

      // Sync Director button active state
      const _dirBtn = document.querySelector('[data-fp-room="DIR"]');
      if (_dirBtn) {
        if (fpActiveRoom === 'DIR') {
          _dirBtn.style.boxShadow = 'inset 0 2px 4px rgba(0,0,0,0.6),0 1px 0 rgba(255,255,255,0.05)';
          _dirBtn.style.color = 'var(--base-primary,#df4e1e)';
          _dirBtn.style.textShadow = '0 0 8px var(--base-primary,#df4e1e)';
        } else {
          _dirBtn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.08)';
          _dirBtn.style.color = 'rgba(255,255,255,0.7)';
          _dirBtn.style.textShadow = 'none';
        }
      }
    }

    fpBuildLabelsRef = fpBuildLabels;
    fpBuildLabels();

    const fpRightGroup2 = document.createElement('div');
    fpRightGroup2.style.cssText = 'display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0;';

    const mapWrap = document.createElement('div');
    mapWrap.style.cssText = 'position:relative;width:100%;line-height:0;background:var(--base-dark,#191c20);border-radius:0 0 4px 4px;overflow:hidden;';
    fpMapWrap = mapWrap;
    mapWrap.appendChild(fpMapEl);
    mapWrap.appendChild(overlay);

    wrapper.appendChild(topBar);
    wrapper.appendChild(dirBtn);
    wrapper.appendChild(mapWrap);

    fpContainer.parentElement.insertBefore(wrapper, fpContainer);
    fpInjected = true;
    console.log('[SOON] Floorplan injected v2.2.2');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STREAMS ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function clipApplyRoomStream(roomId) {
    if (!allStreams.length) return;
    const room = ROOMS.find(r => r.id === roomId);
    if (!room) return;
    const key = room.streamKey.toLowerCase();
    const match = allStreams.find(s => s.name?.toLowerCase().includes(key));
    if (match) {
      streamId = match.id; streamName = match.name; playbackId = match.playbackId;
      console.log('[FT] clip stream →', match.name, match.id);
      syncMapToStream(match.id); // ← syncs map for any navigation source
    }
  }

  async function clipLoadAndDetect() {
    if (_streamsLoaded) return;
    _streamsLoaded = true;
    try {
      const r = await gmFetch('https://api.fishtank.live/v1/live-streams');
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      allStreams = Array.isArray(data) ? data : (data.liveStreams || data.streams || []);
      console.log('[SOON] streams loaded:', allStreams.length);
      if (fpActiveRoom) clipApplyRoomStream(fpActiveRoom);
    } catch(e) {
      _streamsLoaded = false;
      console.error('[FT] clipLoadAndDetect:', e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INIT ───────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    window.SOON = window.SOON || {};
    window.SOON.ROOMS = ROOMS;
    window.SOON.getStreamToken = getStreamToken;
    window.SOON.slugToM3u8 = slugToM3u8;

    let _injectTimer = null;
    const obs = new MutationObserver(() => {
      if (fpInjected) return;
      clearTimeout(_injectTimer);
      _injectTimer = setTimeout(() => { if (!fpInjected) fpInject(); }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    [500, 1500, 2500, 4000].forEach(ms => setTimeout(() => { if (!fpInjected) fpInject(); }, ms));

    clipLoadAndDetect();

    // Sync map when fishtank's own tab buttons are clicked
    document.addEventListener('click', (e) => {
      let el = e.target;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const cl = typeof el.className === 'string' ? el.className : '';
        if (cl.includes('cursor-pointer') || el.tagName === 'BUTTON') {
          const text = el.textContent?.trim();
          const cleaned = text.replace(/\d+$/, '').trim();
          const room = ROOMS.find(r => r.tab && (cleaned === r.tab || cleaned === r.label));
          if (room && !el.dataset?.fpRoom) {
            fpActiveRoom = room.id;
            if (room.floor && room.floor !== fpFloor) fpFloor = room.floor;
            fpRebuildSVG();
            clipApplyRoomStream(room.id);
            if (room.slug) showZoneOverlay(room.slug);
            break;
          }
        }
        el = el.parentElement;
      }
    }, true);

    fpCheckOfflineFromDOM();
    setInterval(fpCheckOfflineFromDOM, 3000);

    let _removalTimer = null;
    const removalObs = new MutationObserver(() => {
      clearTimeout(_removalTimer);
      _removalTimer = setTimeout(() => {
        if (!document.getElementById('ftfp-map')) { fpInjected = false; fpInject(); }
      }, 500);
    });
    removalObs.observe(document.body, { childList: true, subtree: true });

    console.log('[SOON] Soon Map v2.2.2 ready');
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

})();
