// ==UserScript==
// @name         Soon Tools
// @namespace    https://fishtank.news
// @version      2.0.0
// @description  Interactive floorplan map for fishtank.live — click any room to switch cam, syncs with the tab bar. By fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.fishtank.live
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

  // GM_xmlhttpRequest wrapper — anonymous:false sends the browser's real session cookies
  // fetch() in userscript sandboxes uses an isolated cookie jar, causing 401/500 on auth endpoints
  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url,
        anonymous: false,          // send real browser cookies
        withCredentials: true,     // belt-and-suspenders
        headers: {
          'Accept': 'application/json',
          ...(opts.headers || {})
        },
        responseType: 'text',
        onload(r) {
          if (r.status === 0) {
            reject(new Error('gmFetch status 0 — possible CORS or network block'));
            return;
          }
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            _body: r.responseText,
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

  // Read fishtank's CSS variables so floorplan inherits user theme customisations
  function getCSSVar(name, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  }
  function getTheme() {
    return {
      primary:    getCSSVar('--base-primary',    '#df4e1e'),
      secondary:  getCSSVar('--base-secondary',  '#26b64b'),
      dark:       getCSSVar('--base-dark',        '#191c20'),
      light:      getCSSVar('--base-light',       '#dddec4'),
      background: getCSSVar('--base-background',  '#557194'),
      fontPrimary:   getCSSVar('--base-font-primary',   'sofia-pro-variable, sans-serif'),
      fontSecondary: getCSSVar('--base-font-secondary', 'highway-gothic, sans-serif'),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FLOORPLAN ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // "tab"      = exact text in fishtank's room tab buttons
  // "streamKey" = partial match against stream name from the API (case-insensitive)
  const ROOMS = [
    // ── DOWNSTAIRS ─────────────────────────────────────────────────────────
    { id: 'GLASS',  label: 'Glass Room',   tab: 'Glassroom',   floor: 'down', streamKey: 'glass'        },
    { id: 'FOYER',  label: 'Foyer',        tab: 'Foyer',        floor: 'down', streamKey: 'foyer'        },
    { id: 'MARKET', label: 'Market',       tab: 'Market',       floor: 'down', streamKey: 'market'       },
    { id: 'JACUZ',  label: 'Jacuzzi',      tab: 'Jacuzzi',      floor: 'down', streamKey: 'jacuzzi'      },
    { id: 'HALLD',  label: 'Hallway Down', tab: 'Hallway Down', floor: 'down', streamKey: 'hallway down' },
    { id: 'DINING', label: 'Dining Room',  tab: 'Dining Room',  floor: 'down', streamKey: 'dining'       },
    { id: 'KITCH',  label: 'Kitchen',      tab: 'Kitchen',      floor: 'down', streamKey: 'kitchen'      },
    { id: 'BAR',    label: 'Bar',          tab: 'Bar',          floor: 'down', streamKey: 'bar'          },
    { id: 'CLOS',   label: 'Closet',       tab: 'Closet',       floor: 'down', streamKey: 'closet'       },
    { id: 'DORM',   label: 'Dorm',         tab: 'Dorm',         floor: 'down', streamKey: 'dorm'         },
    // ── UPSTAIRS ───────────────────────────────────────────────────────────
    { id: 'CONF',   label: 'Confessional', tab: 'Confessional', floor: 'up',   streamKey: 'confess'      },
    { id: 'CORR',   label: 'Corridor',     tab: 'Corridor',     floor: 'up',   streamKey: 'corridor'     },
    { id: 'JNDL',   label: 'Jungle Room',  tab: 'Jungle Room',  floor: 'up',   streamKey: 'jungle'       },
    { id: 'HALLU',  label: 'Hallway Up',   tab: 'Hallway Up',   floor: 'up',   streamKey: 'hallway up'   },
    { id: 'BALC',   label: 'Balcony',      tab: 'Balcony',      floor: 'up',   streamKey: 'balcony'      },
    // ── MISC (no map position) ─────────────────────────────────────────────
    { id: 'DIR',    label: 'Director Mode',tab: 'Director Mode',floor: null,   streamKey: 'director'     },
    // Alt cams — sub-zones within parent rooms
    { id: 'BPTZ',   label: 'Bar PTZ',      tab: 'Bar PTZ',        floor: 'down', streamKey: 'bar ptz'      },
    { id: 'CAM',    label: 'Cameraman',    tab: 'Cameraman',    floor: null,   streamKey: 'cameraman'    },
  ];

  let fpActiveRoom  = null;
  let fpFloor = 'down'; // 'down' or 'up'
  let fpMapVisible  = true;
  let fpMinimised   = false;
  let fpContainer   = null;
  let fpMapEl       = null;
  let fpMapWrap     = null;
  let fpInjected    = false;

  // Track which rooms are offline
  let offlineRooms = new Set();
  let fpBuildLabelsRef = null; // set after inject, called when offline/active state changes

  // Fast DOM check — read offline state directly from fishtank's button classes
  // Their offline buttons have: cursor-not-allowed opacity-60
  function fpCheckOfflineFromDOM() {
    const grid = document.querySelector('div.grid-cols-5, div.grid-cols-4');
    if (!grid) return;
    const newOffline = new Set();
    for (const room of ROOMS) {
      for (const btn of grid.querySelectorAll('button')) {
        const _t = btn.textContent.trim();
        if (_t === room.tab || _t.startsWith(room.tab)) {
          const cl = btn.className || '';
          if (cl.includes('cursor-not-allowed') || cl.includes('opacity-60')) {
            newOffline.add(room.id);
          }
          break;
        }
      }
    }
    const changed = newOffline.size !== offlineRooms.size ||
      [...newOffline].some(id => !offlineRooms.has(id)) ||
      [...offlineRooms].some(id => !newOffline.has(id));
    if (changed) { offlineRooms = newOffline; if (fpBuildLabelsRef) fpBuildLabelsRef(); }
  }

  // Called when a room is clicked — switches cam AND sets clip stream
  function onRoomSelected(roomId) {
    fpActiveRoom = roomId;
    // Auto-switch floor if the selected room is on a different floor
    const room = ROOMS.find(r => r.id === roomId);
    if (room?.floor && room.floor !== fpFloor) {
      fpFloor = room.floor;
    }
    fpRebuildSVG();
    fpClickTab(roomId);
    clipApplyRoomStream(roomId);
  }

  function fpClickTab(roomId) {
    const room = ROOMS.find(r => r.id === roomId);
    if (!room) return false;

    // Fire full React-compatible event sequence
    function fireClick(el) {
      el.focus();
      ['mousedown','mouseup','click'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) }))
      );
    }

    // Container is rendered off-screen (position:fixed; left:-9999px) so buttons
    // are fully mounted in React and events fire normally
    if (fpContainer) {
      for (const btn of fpContainer.querySelectorAll('button')) {
        const _t = btn.textContent.trim();
        if (_t === room.tab || _t.startsWith(room.tab)) {
          fireClick(btn);
          return true;
        }
      }
    }

    // Fallback: scan whole document
    // Use startsWith to handle viewer-count suffixes e.g. "Bar Alternate16"
    for (const btn of document.querySelectorAll('button')) {
      const t = btn.textContent.trim();
      if (t === room.tab || t === room.label ||
          (room.tab && t.startsWith(room.tab)) ||
          (room.label && t.startsWith(room.label))) {
        fireClick(btn);
        return true;
      }
    }


    console.warn('[SOON] fpClickTab: no button found for', room.tab);
    return false;
  }

  function fpDetectActiveTab() {
    // Find the active button in fishtank's tab bar
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const cl = btn.className || '';
      if (!cl.includes('from-primary') && !cl.includes('bg-primary') && !cl.includes('active')) continue;
      const text = btn.textContent.trim();
      const room = ROOMS.find(r => r.tab && (text === r.tab || text.startsWith(r.tab)));
      if (room && room.id !== fpActiveRoom) {
        fpActiveRoom = room.id;
        if (room.floor === fpFloor || !room.floor) {
          if (fpMapEl) {
            fpMapEl.querySelectorAll('[id^="ftfp-fill-"]').forEach(f => {
              const id = f.id.replace('ftfp-fill-','');
              f.setAttribute('fill', id === fpActiveRoom ? FP_FILL_ACTIVE : 'transparent');
              f.setAttribute('opacity', id === fpActiveRoom ? '0.45' : '0');
            });
          }
          if (fpBuildLabelsRef) fpBuildLabelsRef();
        }
        clipApplyRoomStream(room.id);
        return;
      }
    }
  }

  // ── Architectural floorplan SVG ───────────────────────────────────────────
  // Colours for active / offline / hover states
  const FP_FILL_ACTIVE   = 'var(--base-primary,#df4e1e)';
  const FP_FILL_OFFLINE  = 'rgba(0,0,0,0.25)';
  const FP_FILL_HOVER    = 'var(--base-primary,#df4e1e)';

  function fpBuildSVG() {
    const NS = 'http://www.w3.org/2000/svg';
    const isDown = fpFloor === 'down';
    const VB = isDown ? '0 0 1314 620' : '250 760 781 300';

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', VB);
    svg.style.cssText = 'width:100%;display:block;cursor:default;background:transparent;';

    function mk(tag, attrs) {
      const el = document.createElementNS(NS, tag);
      for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    }

    // Load SVG inline so we can strip its white background rect
    const _svgUrl = 'https://raw.githubusercontent.com/michaety/soontools/main/fishtank-floorplan.drawio.svg';
    const _imgPlaceholder = mk('rect', {x:0, y:0, width:1314, height:1419, fill:'#dddec4'});
    svg.appendChild(_imgPlaceholder);
    const _doEmbed = (svgText) => {
      // Remove white background rect so our cream mapWrap bg shows through
            // Strip white bg BEFORE parsing — simplest and most reliable
      const stripped = svgText
        .replace(/(<svg[^>]*) style="[^"]*"/g, '$1 style="background:transparent"')
        .replace(/<rect[^>]*width="100%"[^>]*\/>/g, '');
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(stripped, 'image/svg+xml');
      const inner = svgDoc.documentElement;
      inner.removeAttribute('style');
      inner.style.background = 'transparent';
      inner.style.mixBlendMode = 'multiply';
      [...inner.querySelectorAll('rect')].forEach(r => {
        if (r.getAttribute('width') === '100%' || r.getAttribute('height') === '100%') r.remove();
      });
      inner.setAttribute('width', '1314');
      inner.setAttribute('height', '1419');
      inner.style.cssText = 'pointer-events:none;overflow:visible;';
      if (_imgPlaceholder.parentNode) _imgPlaceholder.parentNode.replaceChild(inner, _imgPlaceholder);
    };
    if (_svgTextCache) { _doEmbed(_svgTextCache); } else { gmFetch(_svgUrl).then(r => r.text()).then(svgText => { _svgTextCache = svgText; _doEmbed(svgText); }).catch(() => {
      const imgEl = mk('image', {href:_svgUrl, x:0, y:0, width:1314, height:1419, preserveAspectRatio:'xMinYMin meet'});
      imgEl.style.pointerEvents = 'none';
      imgEl.style.mixBlendMode = 'multiply';
      if (_imgPlaceholder.parentNode) _imgPlaceholder.parentNode.replaceChild(imgEl, _imgPlaceholder);
    }); }

    // ── BASE CREAM FILLS — exact room coords from drawio XML (offset x-1620, y-80) ──
    const CREAM = 'var(--base-dark,#191c20)';
    function addBase(x, y, w, h) {
      svg.appendChild(mk('rect', {x, y, width:w, height:h, fill:CREAM}));
    }
    if (isDown) {
      addBase( 310,  10, 230, 290); // Glass Room
      addBase( 542,  10, 169, 130); // Foyer top-left
      addBase( 601, 140, 109, 110); // Foyer bottom
      addBase( 711,  10,  89, 300); // Foyer right
      addBase( 811,  80, 109, 120); // Market (inside walls)
      addBase(1211, 211,  89,  99); // Jacuzzi
      addBase( 550, 310, 560,  60); // Hallway Down
      addBase( 300, 310, 240, 280); // Kitchen
      addBase(  10, 370, 290, 220); // Dining
      addBase( 550, 380, 310, 210); // Bar
      addBase(1050, 480,  50,  70); // Closet
      addBase(1100, 310, 200, 280); // Dorm
    } else {
      addBase( 260, 800,  80,  87); // Jungle
      addBase( 260, 887,  80,  83); // Corridor
      addBase( 400, 803, 100,  87); // Confessional
      addBase( 340, 800, 163,  87); // Gap jungle-to-stairs top
      addBase( 340, 828, 163,  59); // Left of upper staircase
      addBase( 341, 890, 479,  82); // Hallway Up
      addBase( 630, 892, 100,  80); // Balcony
      addBase( 730, 883, 180,  80); // Gap balcony-to-???1
      addBase( 823, 770,  80, 110); // ???2
      addBase( 910, 883, 111,  80); // ???1
      addBase( 401, 979,  99,  80); // ???3
    }

    // ── ROOM FILLS ───────────────────────────────────────────────────────────
    function addFill(id, x, y, w, h, isOffline) {
      const fill = isOffline ? FP_FILL_OFFLINE :
                   fpActiveRoom === id ? FP_FILL_ACTIVE : 'transparent';
      const opacity = (isOffline || fpActiveRoom === id) ? '0.45' : '0';
      const r = mk('rect', {id:'ftfp-fill-'+id, x, y, width:w, height:h, fill, opacity});
      r.style.transition = 'fill 0.12s, opacity 0.12s';
      svg.appendChild(r);
    }

    if (isDown) {
      // Exact coords from drawio XML (offset x-1620, y-80)
      addFill('GLASS',  310,  10, 230, 290, offlineRooms.has('GLASS'));
      addFill('FOYER',  542,  10, 258, 190, offlineRooms.has('FOYER'));
      addFill('MARKET', 811,  80, 109, 120, offlineRooms.has('MARKET'));
      addFill('JACUZ', 1211, 211,  89,  99, offlineRooms.has('JACUZ'));
      addFill('HALLD',  540, 300, 560,  80, offlineRooms.has('HALLD'));
      addFill('DINING',  10, 370, 290, 220, offlineRooms.has('DINING'));
      addFill('KITCH',  300, 310, 240, 280, offlineRooms.has('KITCH'));
      addFill('BAR',    550, 380, 310, 210, offlineRooms.has('BAR'));
      addFill('BPTZ',   550, 451,  70,  68, offlineRooms.has('BPTZ')); // Bar PTZ sub-zone
      addFill('CLOS',  1050, 480,  50,  70, offlineRooms.has('CLOS'));
      addFill('DORM',  1100, 310, 200, 280, offlineRooms.has('DORM'));
    } else {
      addFill('CONF',   260, 800,  80,  87, offlineRooms.has('CONF'));
      addFill('CORR',   260, 887,  80,  83, offlineRooms.has('CORR'));
      addFill('JNDL',   400, 803, 100,  87, offlineRooms.has('JNDL'));
      addFill('HALLU',  341, 890, 289,  82, offlineRooms.has('HALLU'));
      addFill('BALC',   630, 892, 190,  80, offlineRooms.has('BALC'));
    }



    function addHit(id, x, y, w, h) {
      const isOff = offlineRooms.has(id);
      const r = mk('rect',{x,y,width:w,height:h,fill:'transparent'});
      if (!isOff) {
        r.style.cursor = 'pointer';
        r.addEventListener('mouseenter', () => {
          const f = document.getElementById('ftfp-fill-'+id);
          if (f && fpActiveRoom !== id) { f.setAttribute('fill',FP_FILL_HOVER); f.setAttribute('opacity','0.35'); }
        });
        r.addEventListener('mouseleave', () => {
          const f = document.getElementById('ftfp-fill-'+id);
          if (f && fpActiveRoom !== id) { f.setAttribute('fill','transparent'); f.setAttribute('opacity','0'); }
        });
        r.addEventListener('click', () => onRoomSelected(id));
      }
      svg.appendChild(r);
    }

    if (isDown) {
      addHit('GLASS',  310,  10, 230, 290);
      addHit('FOYER',  542,  10, 258, 190);
      addHit('MARKET', 811,  80, 109, 120);
      addHit('JACUZ', 1211, 211,  89,  99);
      addHit('HALLD',  540, 300, 560,  80);
      addHit('DINING',  10, 370, 290, 220);
      addHit('KITCH',  300, 310, 240, 280);
      addHit('BAR',    550, 380, 310, 210);
      addHit('BPTZ',   550, 451,  70,  68);
      addHit('CLOS',  1050, 480,  50,  70);
      addHit('DORM',  1100, 310, 200, 280);
    } else {
      addHit('CONF',   260, 800,  80,  87);
      addHit('CORR',   260, 887,  80,  83);
      addHit('JNDL',   400, 803, 100,  87);
      addHit('HALLU',  341, 890, 289,  82);
      addHit('BALC',   630, 892, 190,  80);
    }

    // Stairs — toggle floor
    function addStair(x, y, w, h) {
      const r = mk('rect',{x,y,width:w,height:h,fill:'transparent'});
      r.style.cursor = 'pointer';
      r.addEventListener('mouseenter', () => r.setAttribute('fill','rgba(0,0,0,0.09)'));
      r.addEventListener('mouseleave', () => r.setAttribute('fill','transparent'));
      r.addEventListener('click', (e) => {
        e.stopPropagation();
        fpFloor = isDown ? 'up' : 'down';
        fpRebuildSVG();
        if (fpBuildLabelsRef) fpBuildLabelsRef();
      });
      svg.appendChild(r);
    }

    if (isDown) {
      addStair(489, 199,  52, 160); // stair L — vertical arm
      addStair(545, 250, 160,  55); // stair L — horizontal arm
      addStair( 10, 311, 290,  59);
    } else {
      addStair(503, 828, 250,  59); // upper staircase — horizontal
      addStair(264, 977,  86,  59); // lower staircase — horizontal
    }

    return svg;
  }

  // Full rebuild — replaces SVG (needed because viewBox changes on floor switch)
  function fpRebuildSVG() {
    if (!fpMapEl) return;
    fpMapEl.innerHTML = '';
    fpMapEl.appendChild(fpBuildSVG());
    if (fpBuildLabelsRef) fpBuildLabelsRef();
  }

  // Finds fishtank's room-tab-bar container (the div holding the camera-select buttons)
  function fpFindTabBar() {
    // fishtank renders a grid of room buttons — must verify it contains room tabs, not the contestant grid
    const grids = document.querySelectorAll('div.grid-cols-5, div.grid-cols-4');
    for (const grid of grids) {
      const btns = grid.querySelectorAll('button');
      let matches = 0;
      for (const btn of btns) {
        if (ROOMS.some(r => r.tab && btn.textContent.trim() === r.tab)) matches++;
      }
      if (matches >= 3) return grid;
    }
    // Fallback: find a div that directly contains buttons matching known room tab names
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

  function fpInject() {
    if (document.getElementById('ftfp-map')) return;
    fpContainer = fpFindTabBar();
    if (!fpContainer) return;

    fpContainer.style.position    = 'fixed';
    fpContainer.style.left        = '-9999px';
    fpContainer.style.top         = '0';
    fpContainer.style.opacity     = '0';
    fpContainer.style.pointerEvents = 'auto';
    fpContainer.style.height      = 'auto';
    fpContainer.style.overflow    = 'visible';
    fpContainer.style.visibility  = 'hidden';

    const wrapper = document.createElement('div');
    wrapper.id = 'ftfp-map';
    wrapper.style.cssText = 'width:100%;position:relative;user-select:none;';

    // Header
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;padding:0px 3.2px 1.6px;gap:6px;background:var(--base-light,#dddec4);background-image:var(--base-texture-background);border-bottom:1px solid rgba(0,0,0,0.15);box-shadow:rgba(255,255,255,0.5) 0px 1px 0px;flex-shrink:0;cursor:pointer;user-select:none;margin-bottom:0;';

    const title = document.createElement('span');
    title.textContent = 'Map';
    title.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:14px;font-weight:700;letter-spacing:normal;text-transform:none;color:rgb(25,28,32);flex:1;';

    const fishIcon = document.createElement('span');
    fishIcon.className = 'ftc-hdr-fish';
    fishIcon.innerHTML = `<svg style="width:14px;height:14px;margin-right:3.2px;flex-shrink:0;color:var(--base-primary,#df4e1e);filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 2v18h3v-1H3v-6h3V9h5V8H6V3h15v5h-6v1h6v5h-4v1h4v6H11v-7h-1v5H8v1h2v2h12V2zm3 4H3V5h2zm-2 6v-1h2v1zm2-2H3V9h2zM3 8V7h2v1zm2-4H3V3h2z" stroke-width="0"/></svg>`;

    const toggleBtn = document.createElement('button');
    toggleBtn.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:13px;font-weight:400;letter-spacing:normal;padding:1px 6px;border:1px solid rgba(0,0,0,0.25);border-radius:3px;background:transparent;color:rgba(0,0,0,0.65);cursor:pointer;line-height:1.4;transition:color 0.12s,border-color 0.12s;';
    toggleBtn.textContent = 'TABS';
    toggleBtn.style.color = 'rgba(0,0,0,0.65)';
    toggleBtn.style.borderColor = 'rgba(0,0,0,0.25)';
    toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.borderColor='var(--base-primary,#df4e1e)'; toggleBtn.style.color='var(--base-primary,#df4e1e)'; });
    toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.borderColor='rgba(0,0,0,0.25)'; toggleBtn.style.color='rgba(0,0,0,0.65)'; });
    toggleBtn.addEventListener('click', () => {
      fpMapVisible = !fpMapVisible;
      if (fpMapVisible) {
        fpMapWrap.style.display = fpMinimised ? 'none' : '';
        toggleBtn.textContent = 'TABS';
        dirBtn.style.display = '';
        fpContainer.style.position='fixed'; fpContainer.style.left='-9999px'; fpContainer.style.top='0';
        fpContainer.style.opacity='0'; fpContainer.style.pointerEvents='auto';
        fpContainer.style.height='auto'; fpContainer.style.overflow='visible'; fpContainer.style.visibility='hidden';
        minimiseBtn.style.display = '';
      } else {
        fpMapWrap.style.display = 'none';
        toggleBtn.textContent = 'MAP';
        dirBtn.style.display = 'none';
        minimiseBtn.style.display = 'none';
        fpContainer.style.position=''; fpContainer.style.left=''; fpContainer.style.top='';
        fpContainer.style.opacity=''; fpContainer.style.pointerEvents='';
        fpContainer.style.height=''; fpContainer.style.overflow=''; fpContainer.style.visibility='';
      }
    });

    // Minimise button
    const minimiseBtn = document.createElement('button');
    minimiseBtn.style.cssText = 'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif);font-size:13px;font-weight:400;letter-spacing:normal;padding:1px 5px;border:1px solid rgba(0,0,0,0.25);border-radius:3px;background:transparent;color:rgba(0,0,0,0.65);cursor:pointer;line-height:1;transition:color 0.12s,border-color 0.12s;';
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

    const fpRightGroup = document.createElement('div');
    fpRightGroup.style.cssText = 'display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0;';
    fpRightGroup.appendChild(toggleBtn);
    fpRightGroup.appendChild(minimiseBtn);

    topBar.appendChild(fishIcon);
    topBar.appendChild(title);
    topBar.appendChild(fpRightGroup);

    fpMapEl = document.createElement('div');
    fpMapEl.style.cssText = 'width:100%;display:block;line-height:0;font-size:0;';
    fpMapEl.appendChild(fpBuildSVG());

    wrapper.appendChild(topBar);

    // ── LABEL OVERLAY: transparent HTML buttons positioned over each room ──
    // Positions are % of SVG viewBox (595x350), so they scale with container width.
    // Each button fires onRoomSelected and shows/hides based on offline state.
    const overlay = document.createElement('div');
    overlay.id = 'ftfp-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2;';

    // [id, label, left%, top%, width%, height%]
    const LABELS_DOWN = [
      // Sub-zones: [id, label, l%, t%, w%, h%, isSub]
      // (isSub=true renders with border + smaller text)
      ['GLASS',  'GLASS ROOM',   23.6,  1.6, 17.5, 46.8],
      ['FOYER',  'FOYER',        41.2,  1.6, 19.6, 48.4],
      ['MARKET', 'MAR',          61.7, 12.9,  8.3, 19.4],
      ['JACUZ',  'JAC',          92.2, 34.0,  6.8, 16.0],
      ['HALLD',  'HALLWAY DOWN', 41.2, 51.6, 42.6,  9.7],  // shifted down to vertical centre of hallway
      ['DINING', 'DINING',        0.8, 59.7, 22.1, 35.5],
      ['KITCH',  'KITCHEN',      22.8, 50.0, 18.3, 45.2],
      ['BAR',    'BAR',          41.9, 61.3, 23.6, 33.9],
      ['CLOS',   'CLO',          79.9, 77.4,  5.5, 11.3],
      ['BPTZ',   'PTZ',          41.9, 72.7,  5.3, 11.0, true],
      ['DORM',   'DORM',         83.7, 50.0, 15.2, 45.2],
      ['_STRS1b','',             41.5, 40.3, 12.2,  8.9, true],  // stair L — horizontal arm
    ];
    const LABELS_UP = [
      ['CONF',  'CON',         1.3, 13.3, 10.2, 29.0],
      ['CORR',  'COR',         1.3, 42.3, 10.2, 27.7],
      ['JNDL',  'JUNGLE',     19.2, 14.3, 12.8, 29.0],
      ['HALLU', 'HALLWAY UP', 11.7, 43.3, 37.0, 27.3],
      ['BALC',  'BALCONY',    48.7, 44.0, 24.3, 26.7],
      ['_STRS1','',        32.4, 22.7, 32.0, 19.7, true], // upper horizontal staircase
    ];

    function fpBuildLabels() {
      overlay.innerHTML = '';
      const isDown = fpFloor === 'down';
      const LABELS = isDown ? LABELS_DOWN : LABELS_UP;
      const T = getTheme();
      for (let i = 0; i < LABELS.length; i++) {
        const [id, label, l, t, w, h] = LABELS[i];
        const isSub = LABELS[i][6] === true;
        const isStair = id.startsWith('_');
        const isOff = !isStair && offlineRooms.has(id);
        const isActive = !isStair && fpActiveRoom === id;
        const btn = document.createElement('button');
        btn.dataset.fpRoom = id;
        btn.textContent = label;
        // Active: orange tint. Hover: subtle highlight keeping text readable. Offline: muted.
        const activeBg   = 'color-mix(in srgb, var(--base-primary,#df4e1e) 35%, transparent)';
        const hoverBg    = 'color-mix(in srgb, var(--base-primary,#df4e1e) 20%, transparent)';
        const subBg      = 'rgba(0,0,0,0.06)';
        const activeColor = '#ffffff';
        const normalColor = isOff ? 'rgba(255,255,255,0.3)' : isActive ? activeColor : 'rgba(255,255,255,0.9)';
        const subColor    = isOff ? 'rgba(255,255,255,0.25)' : isActive ? activeColor : 'rgba(255,255,255,0.6)';

        btn.style.cssText = [
          'position:absolute',
          `left:${l}%`, `top:${t}%`, `width:${w}%`, `height:${h}%`,
          `background:${isActive ? activeBg : isSub ? subBg : 'transparent'}`,
          `border:${isSub ? '1px solid rgba(255,255,255,0.25)' : 'none'}`,
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'text-align:center',
          `font-family:var(--base-font-secondary,${T.fontSecondary || 'highway-gothic,sans-serif'})`,
          `font-size:${isSub ? 'clamp(4px,0.85vw,6px)' : 'clamp(5px,1.1vw,8px)'}`,
          'font-weight:700',
          'letter-spacing:0.08em',
          'text-transform:uppercase',
          `color:${isSub ? subColor : normalColor}`,
          `cursor:${isOff ? 'default' : 'pointer'}`,
          'pointer-events:auto',
          'line-height:1.0',
          'padding:1px',
          'transition:color 0.15s,background 0.15s',
          'white-space:nowrap',   // prevent wrapping on short labels like CLO
          'overflow:hidden',
          isSub ? 'border-radius:3px' : 'border-radius:1px',
          isSub ? 'z-index:1' : '',
          isActive ? `box-shadow:inset 0 0 0 1px ${T.primary}55` : '',
        ].filter(Boolean).join(';');
        if (isStair) {
          btn.addEventListener('mouseenter', () => { if (fpActiveRoom !== id) btn.style.background = hoverBg; });
          btn.addEventListener('mouseleave', () => { if (fpActiveRoom !== id) btn.style.background = isSub ? subBg : 'transparent'; });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            fpFloor = isDown ? 'up' : 'down';
            fpRebuildSVG();
            if (fpBuildLabelsRef) fpBuildLabelsRef();
          });
        } else if (!isOff) {
          btn.addEventListener('mouseenter', () => {
            if (fpActiveRoom !== id) {
              btn.style.color = '#ffffff';
              btn.style.background = hoverBg;
              if (isSub) btn.style.border = '1px solid rgba(255,255,255,0.35)';
            }
          });
          btn.addEventListener('mouseleave', () => {
            if (fpActiveRoom !== id) {
              btn.style.color = isSub ? subColor : normalColor;
              btn.style.background = isSub ? subBg : 'transparent';
              if (isSub) btn.style.border = '1px solid rgba(255,255,255,0.18)';
            }
          });
          btn.addEventListener('click', () => onRoomSelected(id));
        }
        overlay.appendChild(btn);
      }
      // Update dirBtn active/inactive state (only when changed to avoid flash)
      const _dirBtn = document.querySelector('[data-fp-room="DIR"]');
      if (_dirBtn) {
        const _dirActive = fpActiveRoom === 'DIR';
        const _dirWasActive = _dirBtn.dataset.wasActive === '1';
        if (_dirActive !== _dirWasActive) {
          _dirBtn.dataset.wasActive = _dirActive ? '1' : '0';
          if (_dirActive) {
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
    }

    fpBuildLabels();

    // Wrap mapEl + overlay in a relative container so overlay positions correctly
    // Director Mode button — standalone HTML, above the map
    const dirBtn = document.createElement('button');
    dirBtn.dataset.fpRoom = 'DIR';
    dirBtn.textContent = 'DIRECTOR MODE';
    dirBtn.style.cssText = [
      'width:calc(100% - 16px)',
      'display:block',
      'margin:6px 8px',
      'padding:5px 12px',
      'background:var(--base-dark,#191c20)',
      'border:none',
      'border-radius:20px',
      'font-family:var(--base-font-primary,sofia-pro-variable,sans-serif)',
      'font-size:13px',
      'font-weight:500',
      'letter-spacing:normal',
      'text-transform:none',
      'color:rgba(255,255,255,0.7)',
      'cursor:pointer',
      'text-align:center',
      'box-shadow:0 2px 4px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.08)',
      'transition:box-shadow 0.1s,color 0.1s,background 0.1s',
    ].join(';');
    dirBtn.addEventListener('mouseenter', () => {
      if (fpActiveRoom !== 'DIR') { dirBtn.style.background='color-mix(in srgb, var(--base-dark,#191c20) 80%, var(--base-primary,#df4e1e))'; dirBtn.style.color='rgba(255,255,255,0.9)'; }
    });
    dirBtn.addEventListener('mouseleave', () => {
      if (fpActiveRoom !== 'DIR') { dirBtn.style.background='var(--base-dark,#191c20)'; dirBtn.style.color='rgba(255,255,255,0.7)'; }
    });
    dirBtn.addEventListener('click', () => onRoomSelected('DIR'));
    wrapper.appendChild(dirBtn);

    const mapWrap = document.createElement('div');
    mapWrap.style.cssText = 'position:relative;width:100%;line-height:0;background:var(--base-light,#dddec4);border-radius:0 0 4px 4px;overflow:hidden;';
    fpMapWrap = mapWrap;
    mapWrap.appendChild(fpMapEl);
    mapWrap.appendChild(overlay);
    wrapper.appendChild(mapWrap);

    // Store ref so fpRebuildSVG can refresh labels without global pollution
    fpBuildLabelsRef = fpBuildLabels;

    fpContainer.parentElement.insertBefore(wrapper, fpContainer);

    // Clicking the stairs on the architectural map fires this event
    document.addEventListener('ftfp-go-upstairs', () => {
      // Switch to TABS view — fishtank's own tab grid shows upstairs rooms too
      fpMapWrap.style.display = 'none';
      toggleBtn.textContent = 'MAP';
      minimiseBtn.style.display = 'none';
      fpContainer.style.position=''; fpContainer.style.left=''; fpContainer.style.top='';
      fpContainer.style.opacity=''; fpContainer.style.pointerEvents='';
      fpContainer.style.height=''; fpContainer.style.overflow=''; fpContainer.style.visibility='';
      fpMapVisible = false;
    });

    fpInjected = true;
    console.log('[SOON] Floorplan injected v2.0.0');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLIP TOOL ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let playbackId = null, streamName = null, streamId = null;
  let allStreams = [];
  let _svgTextCache = null; // cache fetched SVG so rebuild doesn't re-fetch
  let _streamsLoaded = false;
  // Direct clip ID from XHR intercept — most reliable source

  // ── Called from floorplan when room is selected ────────────────────────────
  // Finds the stream matching this room and applies it to the clip tool
  function clipApplyRoomStream(roomId) {
    if (!allStreams.length) return;
    const room = ROOMS.find(r => r.id === roomId);
    if (!room) return;
    const key = room.streamKey.toLowerCase();
    const match = allStreams.find(s => s.name?.toLowerCase().includes(key));
    if (match) {
      streamId = match.id;
      streamName = match.name;
      playbackId = match.playbackId;
      console.log('[FT] clip stream → ', match.name, match.id);
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
      // If a room is already active on the map, apply it now
      if (fpActiveRoom) clipApplyRoomStream(fpActiveRoom);
      // Pre-fetch zone indices for all alt cams so clicks are instant
    } catch (e) {
      _streamsLoaded = false; // allow retry on failure
      console.error('[FT] loadAndDetect:', e);
    }
  }


  function clipApplyById(id) {
    const cleanId = (id || '').replace(/^2[Bb]/, '').toLowerCase().trim();
    const match = allStreams.find(s => s.id === cleanId || s.id === id || s.playbackId === id);
    if (match) {
      streamId = match.id; streamName = match.name; playbackId = match.playbackId;
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INIT ───────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {

    // Single shared MutationObserver for both injections — debounced to prevent
    // rapid DOM mutations (e.g. during React renders) from triggering multiple injects
    let _injectTimer = null;
    const obs = new MutationObserver(() => {
      if (fpInjected) return;
      clearTimeout(_injectTimer);
      _injectTimer = setTimeout(() => {
        if (!fpInjected) fpInject();
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Staggered retries
    [500, 1500, 2500, 4000].forEach(ms => setTimeout(() => {
      if (!fpInjected) fpInject();
    }, ms));

    clipLoadAndDetect();

    // Watch for clicks on fishtank's camera grid tiles to sync map highlight
    document.addEventListener('click', (e) => {
      let el = e.target;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const cl = typeof el.className === 'string' ? el.className : '';
        if (cl.includes('cursor-pointer') || el.tagName === 'BUTTON') {
          const text = el.textContent?.trim();
          const room = ROOMS.find(r => r.tab && (text === r.tab || text.startsWith(r.tab)));
          if (room && !el.dataset?.fpRoom) {
            fpActiveRoom = room.id;
            if (room.floor === fpFloor || !room.floor) {
              if (fpMapEl) {
                fpMapEl.querySelectorAll('[id^="ftfp-fill-"]').forEach(f => {
                  const id = f.id.replace('ftfp-fill-','');
                  f.setAttribute('fill', id === fpActiveRoom ? FP_FILL_ACTIVE : 'transparent');
                  f.setAttribute('opacity', id === fpActiveRoom ? '0.45' : '0');
                });
              }
              if (fpBuildLabelsRef) fpBuildLabelsRef();
            }
            clipApplyRoomStream(room.id);
            break;
          }

        }
        el = el.parentElement;
      }
    }, true);

      // Poll stream online/offline status — use their own button states as source of truth
    fpCheckOfflineFromDOM();
    setInterval(fpCheckOfflineFromDOM, 3000); // check DOM every 3s (fast, no network)

    // Watch for our elements being removed from the DOM.
    // Debounced: React transiently removes/re-adds nodes during renders,
    // which would cause double-inject without the delay.
    let _removalTimer = null;
    const removalObs = new MutationObserver(() => {
      clearTimeout(_removalTimer);
      _removalTimer = setTimeout(() => {
        const mapGone  = !document.getElementById('ftfp-map');
        if (mapGone)  { fpInjected = false;   fpInject(); }
      }, 500);
    });
    removalObs.observe(document.body, { childList: true, subtree: true });

    console.log('[SOON] Soon Tools v2.0.0 ready');
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

})();
