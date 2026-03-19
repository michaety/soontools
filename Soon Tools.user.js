// ==UserScript==
// @name         Soon Tools
// @namespace    https://fishtank.news
// @version      1.9.3
// @description  Floorplan room switcher + clip & post to X — fishtank.news | soon tools
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.fishtank.live
// @connect      fishtank-clips.b-cdn.net
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
    { id: 'BALT',   label: 'Bar Alt',      tab: 'Bar Alternate',  floor: 'down', streamKey: 'bar alternate' },
    { id: 'BPTZ',   label: 'Bar PTZ',      tab: 'Bar PTZ',        floor: 'down', streamKey: 'bar ptz'      },
    { id: 'DALT',   label: 'Dorm Alt',     tab: 'Dorm Alternate', floor: 'down', streamKey: 'dorm alternate'},
    { id: 'MALT',   label: 'Market Alt',   tab: 'Market Alternate',floor: 'down',streamKey: 'market alternate'},
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
        if (btn.textContent.trim() === room.tab) {
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
    if (changed) { offlineRooms = newOffline; fpRebuildSVG(); }
  }

  // Called when a room is clicked — switches cam AND sets clip stream
  function onRoomSelected(roomId) {
    fpActiveRoom = roomId;
    fpRebuildSVG();
    fpClickTab(roomId);
    clipApplyRoomStream(roomId); // ← integration point
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
      console.log('[SOON] fpClickTab fired:', room.tab, el.tagName, el.className.slice(0,40));
    }

    // Container is rendered off-screen (position:fixed; left:-9999px) so buttons
    // are fully mounted in React and events fire normally
    if (fpContainer) {
      for (const btn of fpContainer.querySelectorAll('button')) {
        if (btn.textContent.trim() === room.tab) {
          fireClick(btn);
          return true;
        }
      }
    }

    // Fallback: scan whole document
    for (const btn of document.querySelectorAll('button')) {
      const t = btn.textContent.trim();
      if (t === room.tab || t === room.label) {
        fireClick(btn);
        return true;
      }
    }

    // Fallback: for alt-cam sub-zones, click the parent room tab
    const PARENT = { BALT: 'BAR', BPTZ: 'BAR', DALT: 'DORM', MALT: 'MARKET' };
    if (PARENT[roomId]) {
      console.warn('[SOON] fpClickTab: alt cam tab not found, falling back to parent', PARENT[roomId]);
      return fpClickTab(PARENT[roomId]);
    }

    console.warn('[SOON] fpClickTab: no button found for', room.tab);
    return false;
  }

  function fpDetectActiveTab() {
    // Check tab bar for active state
    const allDivs = document.querySelectorAll('div.tracking-tighter, div.tracking-normal');
    for (const div of allDivs) {
      const text = div.textContent.trim();
      const room = ROOMS.find(r => r.tab === text);
      if (!room) continue;
      const style = window.getComputedStyle(div);
      const bg = style.backgroundImage + style.backgroundColor + style.borderColor;
      if (bg.includes('link') || div.closest('[class*="active"]') || div.closest('[class*="selected"]')) {
        if (fpActiveRoom !== room.id) {
          fpActiveRoom = room.id;
          fpRebuildSVG();
          clipApplyRoomStream(room.id);
        }
        return;
      }
    }
    // Cross-ref WebSocket stream ID with rooms
    if (wsDetectedId && allStreams.length) {
      const stream = allStreams.find(s => s.id === wsDetectedId);
      if (stream) {
        const room = ROOMS.find(r => stream.name?.toLowerCase().includes(r.streamKey.toLowerCase()));
        if (room && fpActiveRoom !== room.id) {
          fpActiveRoom = room.id;
          fpRebuildSVG();
        }
      }
    }
  }

  // ── Architectural floorplan SVG ───────────────────────────────────────────
  // Colours for active / offline / hover states
  const FP_FILL_ACTIVE   = '#ffe8d6'; // warm orange tint — matches fishtank primary
  const FP_FILL_OFFLINE  = '#d8d5d0';
  const FP_FILL_HOVER    = '#f5efea';

  function fpBuildSVG() {
    const NS = 'http://www.w3.org/2000/svg';
    const isDown = fpFloor === 'down';
    const VB = isDown ? '0 0 1314 620' : '250 760 781 369';

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', VB);
    svg.style.cssText = 'width:100%;display:block;cursor:default;background:transparent;';

    function mk(tag, attrs) {
      const el = document.createElementNS(NS, tag);
      for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    }

    svg.appendChild(mk('image', {href: 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCEtLSBEbyBub3QgZWRpdCB0aGlzIGZpbGUgd2l0aCBlZGl0b3JzIG90aGVyIHRoYW4gZHJhdy5pbyAtLT4KPCFET0NUWVBFIHN2ZyBQVUJMSUMgIi0vL1czQy8vRFREIFNWRyAxLjEvL0VOIiAiaHR0cDovL3d3dy53My5vcmcvR3JhcGhpY3MvU1ZHLzEuMS9EVEQvc3ZnMTEuZHRkIj4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHN0eWxlPSJiYWNrZ3JvdW5kOiAjZmZmZmZmOyBiYWNrZ3JvdW5kLWNvbG9yOiBsaWdodC1kYXJrKCNmZmZmZmYsIHZhcigtLWdlLWRhcmstY29sb3IsICMxMjEyMTIpKTsgY29sb3Itc2NoZW1lOiBsaWdodCBkYXJrOyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZlcnNpb249IjEuMSIgd2lkdGg9IjEzMTRweCIgaGVpZ2h0PSIxNDE5cHgiIHZpZXdCb3g9IjAgMCAxMzE0IDE0MTkiIGNvbnRlbnQ9IiZsdDtteGZpbGUgaG9zdD0mcXVvdDthcHAuZGlhZ3JhbXMubmV0JnF1b3Q7IGFnZW50PSZxdW90O01vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQpIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xNDYuMC4wLjAgU2FmYXJpLzUzNy4zNiZxdW90OyB2ZXJzaW9uPSZxdW90OzI5LjYuNCZxdW90OyBzY2FsZT0mcXVvdDsxJnF1b3Q7IGJvcmRlcj0mcXVvdDswJnF1b3Q7Jmd0OyYjMTA7ICAmbHQ7ZGlhZ3JhbSBuYW1lPSZxdW90O1BhZ2UtMSZxdW90OyBpZD0mcXVvdDs1UkpSM2lfUVVSTTc3SExrUVVzciZxdW90OyZndDsmIzEwOyAgICAmbHQ7bXhHcmFwaE1vZGVsIGR4PSZxdW90OzIyOSZxdW90OyBkeT0mcXVvdDs1NzYmcXVvdDsgZ3JpZD0mcXVvdDsxJnF1b3Q7IGdyaWRTaXplPSZxdW90OzEwJnF1b3Q7IGd1aWRlcz0mcXVvdDsxJnF1b3Q7IHRvb2x0aXBzPSZxdW90OzEmcXVvdDsgY29ubmVjdD0mcXVvdDsxJnF1b3Q7IGFycm93cz0mcXVvdDsxJnF1b3Q7IGZvbGQ9JnF1b3Q7MSZxdW90OyBwYWdlPSZxdW90OzEmcXVvdDsgcGFnZVNjYWxlPSZxdW90OzEmcXVvdDsgcGFnZVdpZHRoPSZxdW90OzgyNyZxdW90OyBwYWdlSGVpZ2h0PSZxdW90OzExNjkmcXVvdDsgbWF0aD0mcXVvdDswJnF1b3Q7IHNoYWRvdz0mcXVvdDswJnF1b3Q7Jmd0OyYjMTA7ICAgICAgJmx0O3Jvb3QmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7MCZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90OzEmcXVvdDsgcGFyZW50PSZxdW90OzAmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsQ29ybmVyO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MTkyMSZxdW90OyB5PSZxdW90OzgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTImcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIwMjEmcXVvdDsgeT0mcXVvdDs4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0zJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyMTIxJnF1b3Q7IHk9JnF1b3Q7ODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNCZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjIyMSZxdW90OyB5PSZxdW90OzgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTUmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIzMjEmcXVvdDsgeT0mcXVvdDs4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC02JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7ODAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyNDIxJnF1b3Q7IHk9JnF1b3Q7ODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNyZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7NjAmcXVvdDsgd2lkdGg9JnF1b3Q7MTE5JnF1b3Q7IHg9JnF1b3Q7MjQyMSZxdW90OyB5PSZxdW90OzEyNSZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC04JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTMwJnF1b3Q7IHdpZHRoPSZxdW90OzM5JnF1b3Q7IHg9JnF1b3Q7MjUyMSZxdW90OyB5PSZxdW90OzE1MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC05JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMTUmcXVvdDsgeD0mcXVvdDsyNDMxJnF1b3Q7IHk9JnF1b3Q7MjgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTEwJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjQyMiZxdW90OyB5PSZxdW90OzI4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xMSZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjQyMiZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xNCZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjUyMSZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xNSZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjYyMSZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xNiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjcyMSZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0xNyZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwMCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzE5MjEmcXVvdDsgeT0mcXVvdDsxODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtMTgmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsxOTIxJnF1b3Q7IHk9JnF1b3Q7MjgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTE5JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsxOTIxJnF1b3Q7IHk9JnF1b3Q7MzgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTIwJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDs3OSZxdW90OyB4PSZxdW90OzIwMjEmcXVvdDsgeT0mcXVvdDszODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtMjUmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyODIxJnF1b3Q7IHk9JnF1b3Q7MjkwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTI2JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyODIxJnF1b3Q7IHk9JnF1b3Q7MjgxJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTI3JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjkyMSZxdW90OyB5PSZxdW90OzI4MSZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0yOCZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwMCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzI5MjEmcXVvdDsgeT0mcXVvdDszODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtMjkmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyOTIxJnF1b3Q7IHk9JnF1b3Q7NDgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTMwJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyODIxJnF1b3Q7IHk9JnF1b3Q7NjcwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTMxJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjkyMiZxdW90OyB5PSZxdW90OzU4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0zMiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MjcyMSZxdW90OyB5PSZxdW90OzY3MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0zMyZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzcwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjY2MCZxdW90OyB5PSZxdW90OzU2MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0zNCZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzQwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjcxMSZxdW90OyB5PSZxdW90OzY0MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC0zNiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7NjEmcXVvdDsgeD0mcXVvdDsyNjYwJnF1b3Q7IHk9JnF1b3Q7NjMwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTM3JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDs2MCZxdW90OyB4PSZxdW90OzI2NjAmcXVvdDsgeT0mcXVvdDs1NTAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtMzgmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyNzIxJnF1b3Q7IHk9JnF1b3Q7NDYwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTM5JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyNjMxJnF1b3Q7IHk9JnF1b3Q7NDUwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTQwJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyNTMxJnF1b3Q7IHk9JnF1b3Q7NDUwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTQxJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyNDMxJnF1b3Q7IHk9JnF1b3Q7NDUwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTQzJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTIwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MjQ4MCZxdW90OyB5PSZxdW90OzQ2MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC00NCZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwMCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzI0ODAmcXVvdDsgeT0mcXVvdDs1NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNDUmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzE1OSZxdW90OyB4PSZxdW90OzIzMzEmcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNDYmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIyMzImcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNDcmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIxMzImcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNDgmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIwMzImcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNDkmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzE5MzEmcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNTAmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzE4MzEmcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNTEmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzE3MzEmcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNTImcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzE2MzAmcXVvdDsgeT0mcXVvdDs2NzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNTMmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsxNjIwJnF1b3Q7IHk9JnF1b3Q7NTgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTU0JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwJnF1b3Q7IHg9JnF1b3Q7MTYyMCZxdW90OyB5PSZxdW90OzQ4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC01NSZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MTgyMCZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC01NiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAwJnF1b3Q7IHg9JnF1b3Q7MTcyMCZxdW90OyB5PSZxdW90OzM4MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC01NyZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbENvcm5lcjtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzE2MjAmcXVvdDsgeT0mcXVvdDszODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNjYmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxNTAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyMTYwJnF1b3Q7IHk9JnF1b3Q7NTIwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTY3JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjtkaXJlY3Rpb249c291dGg7JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7NzAmcXVvdDsgd2lkdGg9JnF1b3Q7MTAmcXVvdDsgeD0mcXVvdDsyMTYwJnF1b3Q7IHk9JnF1b3Q7MzgwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTcwJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi5zdGFpcnM7c3Ryb2tlV2lkdGg9Nztyb3RhdGlvbj05MDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDs1Mi41JnF1b3Q7IHdpZHRoPSZxdW90OzE2MCZxdW90OyB4PSZxdW90OzIxMDkuMjUmcXVvdDsgeT0mcXVvdDsyNzguNzUmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNjkmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLnN0YWlycztzdHJva2VXaWR0aD03OyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzU1JnF1b3Q7IHdpZHRoPSZxdW90OzE2MCZxdW90OyB4PSZxdW90OzIxNjUmcXVvdDsgeT0mcXVvdDszMzAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNzEmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLnN0YWlycztzdHJva2VXaWR0aD03OyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzU5JnF1b3Q7IHdpZHRoPSZxdW90OzI5MCZxdW90OyB4PSZxdW90OzE2MzAmcXVvdDsgeT0mcXVvdDszOTEmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNzImcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIyNTAmcXVvdDsgeT0mcXVvdDs0NTAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtNzMmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIxNjAmcXVvdDsgeT0mcXVvdDs0NTAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtODUmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLnN0YWlycztzdHJva2VXaWR0aD03OyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzU5JnF1b3Q7IHdpZHRoPSZxdW90OzI1MCZxdW90OyB4PSZxdW90OzIxMjMuMjUmcXVvdDsgeT0mcXVvdDs5MDgmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtODYmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLnN0YWlycztzdHJva2VXaWR0aD03OyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzU5JnF1b3Q7IHdpZHRoPSZxdW90Ozg2JnF1b3Q7IHg9JnF1b3Q7MTg3MiZxdW90OyB5PSZxdW90OzEwNTcmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtODcmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGxDb3JuZXI7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzE5MCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsxODcwJnF1b3Q7IHk9JnF1b3Q7ODcwJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTg4JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDs2MCZxdW90OyB4PSZxdW90OzE5NjAmcXVvdDsgeT0mcXVvdDs5NjAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtODkmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDs5MCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzE5NjAmcXVvdDsgeT0mcXVvdDs4ODAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtOTAmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDs5MCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzIwMTAmcXVvdDsgeT0mcXVvdDs4NzcmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtOTEmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGxDb3JuZXI7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMDAmcXVvdDsgd2lkdGg9JnF1b3Q7MTIwJnF1b3Q7IHg9JnF1b3Q7MjAxMCZxdW90OyB5PSZxdW90Ozg3MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtyWHJsVmR0X0dteERDeDNscVpSOC05MiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbENvcm5lcjtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzY1JnF1b3Q7IHdpZHRoPSZxdW90OzMxMCZxdW90OyB4PSZxdW90OzIxMzAmcXVvdDsgeT0mcXVvdDs5MDQmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7clhybFZkdF9HbXhEQ3gzbHFaUjgtOTQmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEzMSZxdW90OyB4PSZxdW90OzIxMjAmcXVvdDsgeT0mcXVvdDsxMDQ2LjU5JnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTk3JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDs5MCZxdW90OyB4PSZxdW90OzIzNTAmcXVvdDsgeT0mcXVvdDsxMDQ2LjU5JnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3FpVms2MzF4bW9JcVlweHR3akdILTMmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGxDb3JuZXI7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj13ZXN0JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyB2ZXJ0ZXg9JnF1b3Q7MSZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7MTAwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzIwMzAmcXVvdDsgeT0mcXVvdDsxMDUyJnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3FpVms2MzF4bW9JcVlweHR3akdILTQmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGxDb3JuZXI7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1ub3J0aCZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyMDEwJnF1b3Q7IHk9JnF1b3Q7MTA1MiZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtxaVZrNjMxeG1vSXFZcHh0d2pHSC02JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDs3JnF1b3Q7IHdpZHRoPSZxdW90OzkwJnF1b3Q7IHg9JnF1b3Q7MjQyMSZxdW90OyB5PSZxdW90OzE0OTAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMTAmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yO2RpcmVjdGlvbj1zb3V0aDsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDs2NSZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzI0MzAmcXVvdDsgeT0mcXVvdDs4NDAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMTEmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90Ozk1JnF1b3Q7IHg9JnF1b3Q7MjQzNSZxdW90OyB5PSZxdW90Ozg0MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtxaVZrNjMxeG1vSXFZcHh0d2pHSC0xMiZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEyMCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzI1MjUmcXVvdDsgeT0mcXVvdDs4NDAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMTMmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzEwMCZxdW90OyB4PSZxdW90OzI0NDAmcXVvdDsgeT0mcXVvdDsxMDQ3JnF1b3Q7IGFzPSZxdW90O2dlb21ldHJ5JnF1b3Q7IC8mZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgICAmbHQ7bXhDZWxsIGlkPSZxdW90O3FpVms2MzF4bW9JcVlweHR3akdILTE0JnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O3ZlcnRpY2FsTGFiZWxQb3NpdGlvbj1ib3R0b207aHRtbD0xO3ZlcnRpY2FsQWxpZ249dG9wO2FsaWduPWNlbnRlcjtzaGFwZT1teGdyYXBoLmZsb29ycGxhbi53YWxsO2ZpbGxDb2xvcj1zdHJva2VDb2xvcjsmcXVvdDsgdmFsdWU9JnF1b3Q7JnF1b3Q7IHZlcnRleD0mcXVvdDsxJnF1b3Q7Jmd0OyYjMTA7ICAgICAgICAgICZsdDtteEdlb21ldHJ5IGhlaWdodD0mcXVvdDsxMCZxdW90OyB3aWR0aD0mcXVvdDsxMDAmcXVvdDsgeD0mcXVvdDsyNTQwJnF1b3Q7IHk9JnF1b3Q7MTA0NyZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyAvJmd0OyYjMTA7ICAgICAgICAmbHQ7L214Q2VsbCZndDsmIzEwOyAgICAgICAgJmx0O214Q2VsbCBpZD0mcXVvdDtxaVZrNjMxeG1vSXFZcHh0d2pHSC0xNSZxdW90OyBwYXJlbnQ9JnF1b3Q7MSZxdW90OyBzdHlsZT0mcXVvdDt2ZXJ0aWNhbExhYmVsUG9zaXRpb249Ym90dG9tO2h0bWw9MTt2ZXJ0aWNhbEFsaWduPXRvcDthbGlnbj1jZW50ZXI7c2hhcGU9bXhncmFwaC5mbG9vcnBsYW4ud2FsbDtmaWxsQ29sb3I9c3Ryb2tlQ29sb3I7ZGlyZWN0aW9uPXNvdXRoOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwMCZxdW90OyB3aWR0aD0mcXVvdDsxMCZxdW90OyB4PSZxdW90OzI2NDAmcXVvdDsgeT0mcXVvdDs5NTcmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMTYmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzExNSZxdW90OyB4PSZxdW90OzI1MzUmcXVvdDsgeT0mcXVvdDs5NTAmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMjAmcXVvdDsgcGFyZW50PSZxdW90OzEmcXVvdDsgc3R5bGU9JnF1b3Q7dmVydGljYWxMYWJlbFBvc2l0aW9uPWJvdHRvbTtodG1sPTE7dmVydGljYWxBbGlnbj10b3A7YWxpZ249Y2VudGVyO3NoYXBlPW14Z3JhcGguZmxvb3JwbGFuLndhbGw7ZmlsbENvbG9yPXN0cm9rZUNvbG9yOyZxdW90OyB2YWx1ZT0mcXVvdDsmcXVvdDsgdmVydGV4PSZxdW90OzEmcXVvdDsmZ3Q7JiMxMDsgICAgICAgICAgJmx0O214R2VvbWV0cnkgaGVpZ2h0PSZxdW90OzEwJnF1b3Q7IHdpZHRoPSZxdW90OzYwJnF1b3Q7IHg9JnF1b3Q7MTk2MCZxdW90OyB5PSZxdW90OzExMDkmcXVvdDsgYXM9JnF1b3Q7Z2VvbWV0cnkmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgJmx0Oy9teENlbGwmZ3Q7JiMxMDsgICAgICAgICZsdDtteENlbGwgaWQ9JnF1b3Q7cWlWazYzMXhtb0lxWXB4dHdqR0gtMjQmcXVvdDsgZWRnZT0mcXVvdDsxJnF1b3Q7IHBhcmVudD0mcXVvdDsxJnF1b3Q7IHN0eWxlPSZxdW90O2VuZEFycm93PW5vbmU7ZGFzaGVkPTE7aHRtbD0xO3JvdW5kZWQ9MDtlbnRyeVg9MC4wOTM7ZW50cnlZPTAuMzM0O2VudHJ5RHg9MDtlbnRyeUR5PTA7ZW50cnlQZXJpbWV0ZXI9MDsmcXVvdDsgdGFyZ2V0PSZxdW90O3JYcmxWZHRfR214REN4M2xxWlI4LTk3JnF1b3Q7IHZhbHVlPSZxdW90OyZxdW90OyZndDsmIzEwOyAgICAgICAgICAmbHQ7bXhHZW9tZXRyeSBoZWlnaHQ9JnF1b3Q7NTAmcXVvdDsgcmVsYXRpdmU9JnF1b3Q7MSZxdW90OyB3aWR0aD0mcXVvdDs1MCZxdW90OyBhcz0mcXVvdDtnZW9tZXRyeSZxdW90OyZndDsmIzEwOyAgICAgICAgICAgICZsdDtteFBvaW50IHg9JnF1b3Q7MjI1MCZxdW90OyB5PSZxdW90OzEwNTAmcXVvdDsgYXM9JnF1b3Q7c291cmNlUG9pbnQmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgICAgICZsdDtteFBvaW50IHg9JnF1b3Q7MjMwMCZxdW90OyB5PSZxdW90OzEwMDAmcXVvdDsgYXM9JnF1b3Q7dGFyZ2V0UG9pbnQmcXVvdDsgLyZndDsmIzEwOyAgICAgICAgICAmbHQ7L214R2VvbWV0cnkmZ3Q7JiMxMDsgICAgICAgICZsdDsvbXhDZWxsJmd0OyYjMTA7ICAgICAgJmx0Oy9yb290Jmd0OyYjMTA7ICAgICZsdDsvbXhHcmFwaE1vZGVsJmd0OyYjMTA7ICAmbHQ7L2RpYWdyYW0mZ3Q7JiMxMDsmbHQ7L214ZmlsZSZndDsmIzEwOyI+PGRlZnMvPjxyZWN0IGZpbGw9IiNmZmZmZmYiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIHg9IjAiIHk9IjAiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKCNmZmZmZmYsIHZhcigtLWdlLWRhcmstY29sb3IsICMxMjEyMTIpKTsiLz48Zz48ZyBkYXRhLWNlbGwtaWQ9IjAiPjxnIGRhdGEtY2VsbC1pZD0iMSI+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0xIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHBhdGggZD0iTSAzMDEgMTAwIEwgMzAxIDAgTCA0MDEgMCBMIDQwMSAxMCBMIDMxMSAxMCBMIDMxMSAxMDAgWiIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjQwMSIgeT0iMCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTMiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI1MDEiIHk9IjAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC00Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNjAxIiB5PSIwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjcwMSIgeT0iMCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTYiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI3NjYiIHk9IjM1IiB3aWR0aD0iODAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsODA2LDQwKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC03Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iODAxIiB5PSI3MCIgd2lkdGg9IjExOSIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTgiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI4NTUuNSIgeT0iMTMwIiB3aWR0aD0iMTMwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDkyMC41LDEzNSkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtOSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjgxMSIgeT0iMjAwIiB3aWR0aD0iMTE1IiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMTAiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI3NTciIHk9IjI0NSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw4MDcsMjUwKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0xMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjgwMiIgeT0iMzAwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMTQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI5MDEiIHk9IjMwMCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTE1Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTAwMSIgeT0iMzAwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMTYiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMTAxIiB5PSIzMDAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0xNyI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjI1NiIgeT0iMTQ1IiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDMwNiwxNTApIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTE4Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMjU2IiB5PSIyNDUiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsMzA2LDI1MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMTkiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIzMDEiIHk9IjMwMCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTIwIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNDAxIiB5PSIzMDAiIHdpZHRoPSI3OSIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTI1Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTE1NiIgeT0iMjU1IiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDEyMDYsMjYwKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0yNiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjEyMDEiIHk9IjIwMSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTI3Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTI1NiIgeT0iMjQ2IiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDEzMDYsMjUxKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0yOCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjEyNTYiIHk9IjM0NSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCwxMzA2LDM1MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMjkiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMjU2IiB5PSI0NDUiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsMTMwNiw0NTApIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTMwIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTIwMSIgeT0iNTkwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMzEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMjU3IiB5PSI1NDUiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsMTMwNyw1NTApIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTMyIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTEwMSIgeT0iNTkwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMzMiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMDEwIiB5PSI1MTAiIHdpZHRoPSI3MCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCwxMDQ1LDUxNSkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMzQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMDc2IiB5PSI1NzUiIHdpZHRoPSI0MCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCwxMDk2LDU4MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMzYiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMDQwIiB5PSI1NTAiIHdpZHRoPSI2MSIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTM3Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTA0MCIgeT0iNDcwIiB3aWR0aD0iNjAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC0zOCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjEwNTYiIHk9IjQyNSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCwxMTA2LDQzMCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtMzkiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMDExIiB5PSIzNzAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC00MCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjkxMSIgeT0iMzcwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNDEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI4MTEiIHk9IjM3MCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTQzIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iODA1IiB5PSI0MzUiIHdpZHRoPSIxMjAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsODY1LDQ0MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNDQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI4MTUiIHk9IjUzNSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw4NjUsNTQwKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC00NSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjcxMSIgeT0iNTkwIiB3aWR0aD0iMTU5IiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNDYiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI2MTIiIHk9IjU5MCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTQ3Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNTEyIiB5PSI1OTAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC00OCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjQxMiIgeT0iNTkwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNDkiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIzMTEiIHk9IjU5MCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTUwIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMjExIiB5PSI1OTAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC01MSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjExMSIgeT0iNTkwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNTIiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIxMCIgeT0iNTkwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNTMiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSItNDUiIHk9IjU0NSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw1LDU1MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNTQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSItNDUiIHk9IjQ0NSIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw1LDQ1MCkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNTUiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIyMDAiIHk9IjMwMCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTU2Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iMTAwIiB5PSIzMDAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC01NyI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxwYXRoIGQ9Ik0gMCA0MDAgTCAwIDMwMCBMIDEwMCAzMDAgTCAxMDAgMzEwIEwgMTAgMzEwIEwgMTAgNDAwIFoiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTY2Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNDcwIiB5PSI1MTAiIHdpZHRoPSIxNTAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsNTQ1LDUxNSkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNjciPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI1MTAiIHk9IjMzMCIgd2lkdGg9IjcwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDU0NSwzMzUpIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTcwIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNDg5LjI1IiB5PSIxOTguNzUiIHdpZHRoPSIxNjAiIGhlaWdodD0iNTIuNSIgZmlsbD0iI2ZmZmZmZiIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjciIHRyYW5zZm9ybT0icm90YXRlKDkwLDU2OS4yNSwyMjUpIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyaygjZmZmZmZmLCB2YXIoLS1nZS1kYXJrLWNvbG9yLCAjMTIxMjEyKSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PHBhdGggZD0iTSA1MTQuMjUgMTk4Ljc1IEwgNTE0LjI1IDI1MS4yNSBNIDUzOS4yNSAxOTguNzUgTCA1MzkuMjUgMjUxLjI1IE0gNTY0LjI1IDE5OC43NSBMIDU2NC4yNSAyNTEuMjUgTSA1ODkuMjUgMTk4Ljc1IEwgNTg5LjI1IDI1MS4yNSBNIDYxNC4yNSAxOTguNzUgTCA2MTQuMjUgMjUxLjI1IE0gNjM5LjI1IDE5OC43NSBMIDYzOS4yNSAyNTEuMjUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDU2OS4yNSwyMjUpIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0ic3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48cGF0aCBkPSJNIDQ4OS4yNSAyMjUgTCA2NDkuMjUgMjI1IE0gNjI0LjI1IDE5OC43NSBMIDY0OS4yNSAyMjUgTCA2MjQuMjUgMjUxLjI1IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw1NjkuMjUsMjI1KSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9InN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTY5Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNTQ1IiB5PSIyNTAiIHdpZHRoPSIxNjAiIGhlaWdodD0iNTUiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyaygjZmZmZmZmLCB2YXIoLS1nZS1kYXJrLWNvbG9yLCAjMTIxMjEyKSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PHBhdGggZD0iTSA1NzAgMjUwIEwgNTcwIDMwNSBNIDU5NSAyNTAgTCA1OTUgMzA1IE0gNjIwIDI1MCBMIDYyMCAzMDUgTSA2NDUgMjUwIEwgNjQ1IDMwNSBNIDY3MCAyNTAgTCA2NzAgMzA1IE0gNjk1IDI1MCBMIDY5NSAzMDUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjxwYXRoIGQ9Ik0gNTQ1IDI3Ny41IEwgNzA1IDI3Ny41IE0gNjgwIDI1MCBMIDcwNSAyNzcuNSBMIDY4MCAzMDUiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC03MSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjEwIiB5PSIzMTEiIHdpZHRoPSIyOTAiIGhlaWdodD0iNTkiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyaygjZmZmZmZmLCB2YXIoLS1nZS1kYXJrLWNvbG9yLCAjMTIxMjEyKSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PHBhdGggZD0iTSAzNSAzMTEgTCAzNSAzNzAgTSA2MCAzMTEgTCA2MCAzNzAgTSA4NSAzMTEgTCA4NSAzNzAgTSAxMTAgMzExIEwgMTEwIDM3MCBNIDEzNSAzMTEgTCAxMzUgMzcwIE0gMTYwIDMxMSBMIDE2MCAzNzAgTSAxODUgMzExIEwgMTg1IDM3MCBNIDIxMCAzMTEgTCAyMTAgMzcwIE0gMjM1IDMxMSBMIDIzNSAzNzAgTSAyNjAgMzExIEwgMjYwIDM3MCBNIDI4NSAzMTEgTCAyODUgMzcwIiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0ic3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48cGF0aCBkPSJNIDEwIDM0MC41IEwgMzAwIDM0MC41IE0gMjc1IDMxMSBMIDMwMCAzNDAuNSBMIDI3NSAzNzAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC03MiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjYzMCIgeT0iMzcwIiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtNzMiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI1NDAiIHk9IjM3MCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTg1Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iNTAzLjI1IiB5PSI4MjgiIHdpZHRoPSIyNTAiIGhlaWdodD0iNTkiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyaygjZmZmZmZmLCB2YXIoLS1nZS1kYXJrLWNvbG9yLCAjMTIxMjEyKSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PHBhdGggZD0iTSA1MjguMjUgODI4IEwgNTI4LjI1IDg4NyBNIDU1My4yNSA4MjggTCA1NTMuMjUgODg3IE0gNTc4LjI1IDgyOCBMIDU3OC4yNSA4ODcgTSA2MDMuMjUgODI4IEwgNjAzLjI1IDg4NyBNIDYyOC4yNSA4MjggTCA2MjguMjUgODg3IE0gNjUzLjI1IDgyOCBMIDY1My4yNSA4ODcgTSA2NzguMjUgODI4IEwgNjc4LjI1IDg4NyBNIDcwMy4yNSA4MjggTCA3MDMuMjUgODg3IE0gNzI4LjI1IDgyOCBMIDcyOC4yNSA4ODciIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjxwYXRoIGQ9Ik0gNTAzLjI1IDg1Ny41IEwgNzUzLjI1IDg1Ny41IE0gNzI4LjI1IDgyOCBMIDc1My4yNSA4NTcuNSBMIDcyOC4yNSA4ODciIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC04NiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjI1MiIgeT0iOTc3IiB3aWR0aD0iODYiIGhlaWdodD0iNTkiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyaygjZmZmZmZmLCB2YXIoLS1nZS1kYXJrLWNvbG9yLCAjMTIxMjEyKSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PHBhdGggZD0iTSAyNzcgOTc3IEwgMjc3IDEwMzYgTSAzMDIgOTc3IEwgMzAyIDEwMzYgTSAzMjcgOTc3IEwgMzI3IDEwMzYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMDAwMCIgc3Ryb2tlLXdpZHRoPSI3IiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjxwYXRoIGQ9Ik0gMjUyIDEwMDYuNSBMIDMzOCAxMDA2LjUgTSAzMTMgOTc3IEwgMzM4IDEwMDYuNSBMIDMxMyAxMDM2IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLW1pdGVybGltaXQ9IjEwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0ic3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtODciPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cGF0aCBkPSJNIDI1MCA5ODAgTCAyNTAgNzkwIEwgMzUwIDc5MCBMIDM1MCA4MDAgTCAyNjAgODAwIEwgMjYwIDk4MCBaIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC04OCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjM0MCIgeT0iODgwIiB3aWR0aD0iNjAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC04OSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjMwMCIgeT0iODQwIiB3aWR0aD0iOTAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsMzQ1LDg0NSkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtOTAiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSIzNTAiIHk9IjgzNyIgd2lkdGg9IjkwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDM5NSw4NDIpIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTkxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHBhdGggZD0iTSA0MDAgOTAwIEwgNDAwIDc4MCBMIDUwMCA3ODAgTCA1MDAgNzkwIEwgNDEwIDc5MCBMIDQxMCA5MDAgWiIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDQ1MCw4NDApIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InJYcmxWZHRfR214REN4M2xxWlI4LTkyIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHBhdGggZD0iTSA2MzIuNSAxMDExLjUgTCA2MzIuNSA3MDEuNSBMIDY5Ny41IDcwMS41IEwgNjk3LjUgNzExLjUgTCA2NDIuNSA3MTEuNSBMIDY0Mi41IDEwMTEuNSBaIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsNjY1LDg1Ni41KSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJyWHJsVmR0X0dteERDeDNscVpSOC05NCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjUwMCIgeT0iOTY2LjU5IiB3aWR0aD0iMTMxIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0iclhybFZkdF9HbXhEQ3gzbHFaUjgtOTciPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI3MzAiIHk9Ijk2Ni41OSIgd2lkdGg9IjkwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtMyI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxwYXRoIGQ9Ik0gNDEwIDEwNzIgTCA0MTAgOTcyIEwgNTEwIDk3MiBMIDUxMCA5ODIgTCA0MjAgOTgyIEwgNDIwIDEwNzIgWiIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHRyYW5zZm9ybT0icm90YXRlKDE4MCw0NjAsMTAyMikiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtNCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxwYXRoIGQ9Ik0gMzkwIDEwNzIgTCAzOTAgOTcyIEwgNDkwIDk3MiBMIDQ5MCA5ODIgTCA0MDAgOTgyIEwgNDAwIDEwNzIgWiIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2UtbWl0ZXJsaW1pdD0iMTAiIHRyYW5zZm9ybT0icm90YXRlKDI3MCw0NDAsMTAyMikiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtNiI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjgwMSIgeT0iMTQwOC41IiB3aWR0aD0iOTAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJxaVZrNjMxeG1vSXFZcHh0d2pHSC0xMCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9Ijc4Mi41IiB5PSI3ODcuNSIgd2lkdGg9IjY1IiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHRyYW5zZm9ybT0icm90YXRlKDkwLDgxNSw3OTIuNSkiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtMTEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI4MTUiIHk9Ijc2MCIgd2lkdGg9Ijk1IiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtMTIiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI4NTAiIHk9IjgxNSIgd2lkdGg9IjEyMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiB0cmFuc2Zvcm09InJvdGF0ZSg5MCw5MTAsODIwKSIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJxaVZrNjMxeG1vSXFZcHh0d2pHSC0xMyI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjgyMCIgeT0iOTY3IiB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtMTQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cmVjdCB4PSI5MjAiIHk9Ijk2NyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzAwMDAwMCIgc3Ryb2tlPSIjMDAwMDAwIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InFpVms2MzF4bW9JcVlweHR3akdILTE1Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iOTc1IiB5PSI5MjIiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgdHJhbnNmb3JtPSJyb3RhdGUoOTAsMTAyNSw5MjcpIiBwb2ludGVyLWV2ZW50cz0iYWxsIiBzdHlsZT0iZmlsbDogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7IHN0cm9rZTogbGlnaHQtZGFyayhyZ2IoMCwgMCwgMCksIHJnYigyNTUsIDI1NSwgMjU1KSk7Ii8+PC9nPjwvZz48ZyBkYXRhLWNlbGwtaWQ9InFpVms2MzF4bW9JcVlweHR3akdILTE2Ij48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgwLjUsMC41KSI+PHJlY3QgeD0iOTE1IiB5PSI4NzAiIHdpZHRoPSIxMTUiIGhlaWdodD0iMTAiIGZpbGw9IiMwMDAwMDAiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIgc3R5bGU9ImZpbGw6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyBzdHJva2U6IGxpZ2h0LWRhcmsocmdiKDAsIDAsIDApLCByZ2IoMjU1LCAyNTUsIDI1NSkpOyIvPjwvZz48L2c+PGcgZGF0YS1jZWxsLWlkPSJxaVZrNjMxeG1vSXFZcHh0d2pHSC0yMCI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMC41LDAuNSkiPjxyZWN0IHg9IjM0MCIgeT0iMTAyOSIgd2lkdGg9IjYwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDAwMDAwIiBzdHJva2U9IiMwMDAwMDAiIHBvaW50ZXItZXZlbnRzPSJhbGwiIHN0eWxlPSJmaWxsOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsgc3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjxnIGRhdGEtY2VsbC1pZD0icWlWazYzMXhtb0lxWXB4dHdqR0gtMjQiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDAuNSwwLjUpIj48cGF0aCBkPSJNIDYzMCA5NzAgTCA3MzguMzcgOTY5LjkzIiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAwMDAiIHN0cm9rZS1taXRlcmxpbWl0PSIxMCIgc3Ryb2tlLWRhc2hhcnJheT0iMyAzIiBwb2ludGVyLWV2ZW50cz0ic3Ryb2tlIiBzdHlsZT0ic3Ryb2tlOiBsaWdodC1kYXJrKHJnYigwLCAwLCAwKSwgcmdiKDI1NSwgMjU1LCAyNTUpKTsiLz48L2c+PC9nPjwvZz48L2c+PC9nPjwvc3ZnPg==',
      x:0, y:0, width:1314, height:1038,
      preserveAspectRatio:'xMinYMin meet'
    }));
    svg.lastChild.style.pointerEvents = 'none'; // background image should not capture clicks

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
      addFill('MARKET', 800,  10, 100,  90, offlineRooms.has('MARKET'));
      addFill('MALT',   860, 162,  40,  37, offlineRooms.has('MALT')); // Market Alt sub-zone
      addFill('JACUZ', 1211, 211,  89,  99, offlineRooms.has('JACUZ'));
      addFill('HALLD',  540, 300, 560,  80, offlineRooms.has('HALLD'));
      addFill('DINING',  10, 370, 290, 220, offlineRooms.has('DINING'));
      addFill('KITCH',  300, 310, 240, 280, offlineRooms.has('KITCH'));
      addFill('BAR',    550, 380, 310, 210, offlineRooms.has('BAR'));
      addFill('BPTZ',   550, 451,  70,  68, offlineRooms.has('BPTZ')); // Bar PTZ sub-zone
      addFill('BALT',   670, 520,  80,  70, offlineRooms.has('BALT')); // Bar Alt sub-zone
      addFill('CLOS',  1050, 480,  50,  70, offlineRooms.has('CLOS'));
      addFill('DORM',  1100, 310, 200, 280, offlineRooms.has('DORM'));
      addFill('DALT',  1100, 450,  80,  70, offlineRooms.has('DALT')); // Dorm Alt sub-zone
    } else {
      addFill('CONF',   260, 800,  80,  87, offlineRooms.has('CONF'));
      addFill('CORR',   260, 887,  80,  83, offlineRooms.has('CORR'));
      addFill('JNDL',   400, 803, 100,  87, offlineRooms.has('JNDL'));
      addFill('HALLU',  341, 890, 479,  82, offlineRooms.has('HALLU'));
      addFill('BALC',   630, 892, 100,  80, offlineRooms.has('BALC'));
    }

    // Active dot — uses label center positions from the SVG (ground truth)
    if (fpActiveRoom) {
      const T = getTheme();
      const centres = {
        GLASS:{x:425,y:155},  FOYER:{x:671,y:160},  MARKET:{x:850,y: 55},
        JACUZ:{x:1255,y:260}, HALLD:{x:820,y:340},
        DINING:{x:155,y:480}, KITCH:{x:420,y:450},  BAR:{x:705,y:485},
        CLOS: {x:1075,y:515}, DORM:{x:1200,y:450},
        BPTZ: {x:585,y:485},  BALT:{x:710,y:555},
        DALT: {x:1140, y:490}, MALT:{x:880,y:180},
        CONF:{x:300,y:843},   CORR:{x:300,y:928},   JNDL:{x:450,y:846},
        HALLU:{x:580,y:931},  BALC:{x:680,y:932},
      };
      const downRooms = ['GLASS','FOYER','MARKET','JACUZ','HALLD','DINING','KITCH','BAR','CLOS','DORM','BPTZ','BALT','DALT','MALT'];
      const upRooms   = ['CONF','CORR','JNDL','HALLU','BALC'];
      const c = centres[fpActiveRoom];
      const onFloor = isDown ? downRooms.includes(fpActiveRoom) : upRooms.includes(fpActiveRoom);
      if (c && onFloor) {
        const dot = mk('circle',{cx:c.x,cy:c.y,r:'16',fill:T.primary});
        const anim = mk('animate',{attributeName:'opacity',values:'1;0.2;1',dur:'1.4s',repeatCount:'indefinite'});
        dot.appendChild(anim);
        svg.appendChild(dot);
      }
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
      addHit('MARKET', 800,  10, 100,  90);
      addHit('MALT',   860, 162,  40,  37);
      addHit('JACUZ', 1211, 211,  89,  99);
      addHit('HALLD',  540, 300, 560,  80);
      addHit('DINING',  10, 370, 290, 220);
      addHit('KITCH',  300, 310, 240, 280);
      addHit('BAR',    550, 380, 310, 210);
      addHit('BPTZ',   550, 451,  70,  68);
      addHit('BALT',   670, 520,  80,  70);
      addHit('CLOS',  1050, 480,  50,  70);
      addHit('DORM',  1100, 310, 200, 280);
      addHit('DALT',  1100, 450,  80,  70);
    } else {
      addHit('CONF',   260, 800,  80,  87);
      addHit('CORR',   260, 887,  80,  83);
      addHit('JNDL',   400, 803, 100,  87);
      addHit('HALLU',  341, 890, 479,  82);
      addHit('BALC',   630, 892, 100,  80);
    }

    // Stairs — toggle floor
    function addStair(x, y, w, h) {
      const r = mk('rect',{x,y,width:w,height:h,fill:'transparent'});
      r.style.cursor = 'pointer';
      r.addEventListener('mouseenter', () => r.setAttribute('fill','rgba(0,0,0,0.08)'));
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
      addStair(489, 198, 216, 107);
      addStair( 10, 311, 290,  59);
    } else {
      addStair(602, 760, 59, 218); // big stairwell — clipped to viewBox top
      addStair(264, 963,  59,  87);
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
    // fishtank renders a grid of room buttons — look for a div with grid-cols-5 or grid-cols-4
    const grid = document.querySelector('div.grid-cols-5, div.grid-cols-4');
    if (grid) return grid;
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
    title.className = 'ftc-hdr-title';
    title.textContent = 'Map';

    const fishIcon = document.createElement('span');
    fishIcon.className = 'ftc-hdr-fish';
    fishIcon.innerHTML = `<svg style="width:14px;height:14px;margin-right:3.2px;flex-shrink:0;color:var(--base-primary,#df4e1e);filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 2v18h3v-1H3v-6h3V9h5V8H6V3h15v5h-6v1h6v5h-4v1h4v6H11v-7h-1v5H8v1h2v2h12V2zm3 4H3V5h2zm-2 6v-1h2v1zm2-2H3V9h2zM3 8V7h2v1zm2-4H3V3h2z" stroke-width="0"/></svg>`;

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ftc-hdr-btn';
    toggleBtn.textContent = 'TABS';
    toggleBtn.style.color = 'rgba(255,255,255,0.85)';
    toggleBtn.style.borderColor = 'rgba(255,255,255,0.35)';
    toggleBtn.addEventListener('mouseenter', () => { toggleBtn.style.borderColor='rgba(255,255,255,0.6)'; toggleBtn.style.color='#fff'; });
    toggleBtn.addEventListener('mouseleave', () => { toggleBtn.style.borderColor='rgba(255,255,255,0.35)'; toggleBtn.style.color='rgba(255,255,255,0.85)'; });
    toggleBtn.addEventListener('click', () => {
      fpMapVisible = !fpMapVisible;
      if (fpMapVisible) {
        fpMapWrap.style.display = fpMinimised ? 'none' : '';
        toggleBtn.textContent = 'TABS';
        fpContainer.style.position='fixed'; fpContainer.style.left='-9999px'; fpContainer.style.top='0';
        fpContainer.style.opacity='0'; fpContainer.style.pointerEvents='auto';
        fpContainer.style.height='auto'; fpContainer.style.overflow='visible'; fpContainer.style.visibility='hidden';
        minimiseBtn.style.display = '';
      } else {
        fpMapWrap.style.display = 'none';
        toggleBtn.textContent = 'MAP';
        minimiseBtn.style.display = 'none';
        fpContainer.style.position=''; fpContainer.style.left=''; fpContainer.style.top='';
        fpContainer.style.opacity=''; fpContainer.style.pointerEvents='';
        fpContainer.style.height=''; fpContainer.style.overflow=''; fpContainer.style.visibility='';
      }
    });

    // Minimise button
    const minimiseBtn = document.createElement('button');
    minimiseBtn.className = 'ftc-hdr-btn';
    minimiseBtn.textContent = '−';
    minimiseBtn.title = 'Minimise map';
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
      ['FOYER',  'FOYER',        41.1,  1.6, 19.8, 46.8],
      ['MARKET', 'MAR',          60.9,  1.6,  7.6, 14.5],
      ['JACUZ',  'JAC',          92.2, 34.0,  6.8, 16.0],
      ['HALLD',  'HALLWAY DOWN', 41.1, 48.4, 42.6, 12.9],
      ['DINING', 'DINING',        0.8, 59.7, 22.1, 35.5],
      ['KITCH',  'KITCHEN',      22.8, 50.0, 18.3, 45.2],
      ['BAR',    'BAR',          41.9, 61.3, 23.6, 33.9],
      ['CLOS',   'CLO',          79.9, 77.4,  3.8, 11.3],
      ['BPTZ',   'PTZ',           41.9, 72.7,  5.3, 11.0, true],
      ['BALT',   'ALT',           51.0, 83.9,  6.1, 11.3, true],
      ['DALT',   'ALT',           84.0, 85.0,  5.8,  9.0, true],
      ['MALT',   'ALT',           65.5, 15.6,  3.0,  3.6, true],
      ['DORM',   'DORM',         83.7, 50.0, 15.2, 45.2],
      ['_STRS1', 'STRS',         37.2, 31.9, 16.4, 17.3, true],
      ['_STRS2', 'STRS',          0.8, 50.2, 22.1,  9.5, true],
    ];
    const LABELS_UP = [
      ['CONF',  'CON',         1.3, 10.8, 10.2, 23.6],
      ['CORR',  'CORR',        1.3, 34.4, 10.2, 22.5],
      ['JNDL',  'JUNGLE',     19.2, 11.7, 12.8, 23.6],
      ['HALLU', 'HALLWAY UP', 11.7, 35.2, 61.3, 22.2],
      ['BALC',  'BALCONY',    48.7, 35.8, 12.8, 21.7],
      ['_STRS1','STRS',       45.1,  0.0,  7.6, 59.1, true], // big stairwell column
      ['_STRS2','STRS',        1.8, 55.0,  7.6, 23.6, true], // small stair bottom-left
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
        btn.style.cssText = [
          'position:absolute',
          `left:${l}%`, `top:${t}%`, `width:${w}%`, `height:${h}%`,
          `background:${isActive ? 'rgba(255,232,214,0.45)' : isSub ? 'rgba(0,0,0,0.06)' : 'transparent'}`,
          `border:${isSub ? '1px solid rgba(0,0,0,0.25)' : 'none'}`,
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'text-align:center',
          `font-family:${T.fontSecondary || 'highway-gothic,sans-serif'}`,
          `font-size:${isSub ? 'clamp(4px,0.9vw,7px)' : 'clamp(5px,1.2vw,9px)'}`,
          'font-weight:700',
          'letter-spacing:0.06em',
          'text-transform:uppercase',
          `color:${isOff ? 'rgba(0,0,0,0.2)' : isActive ? T.primary : isSub ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.65)'}`,
          `cursor:${isOff ? 'default' : 'pointer'}`,
          'pointer-events:auto',
          'line-height:1.1',
          'padding:1px',
          'transition:color 0.12s,background 0.12s',
          'white-space:normal',
          'word-break:break-word',
          'overflow:hidden',
          isSub ? 'border-radius:2px' : '',
        ].filter(Boolean).join(';');
        if (isStair) {
          btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(245,239,234,0.55)'; });
          btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(0,0,0,0.06)'; });
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            fpFloor = isDown ? 'up' : 'down';
            fpRebuildSVG();
            if (fpBuildLabelsRef) fpBuildLabelsRef();
          });
        } else if (!isOff) {
          btn.addEventListener('mouseenter', () => {
            if (fpActiveRoom !== id) {
              btn.style.color = T.primary;
              btn.style.background = 'rgba(245,239,234,0.55)';
            }
          });
          btn.addEventListener('mouseleave', () => {
            if (fpActiveRoom !== id) {
              btn.style.color = 'rgba(0,0,0,0.65)';
              btn.style.background = isSub ? 'rgba(0,0,0,0.06)' : 'transparent';
            }
          });
          btn.addEventListener('click', () => onRoomSelected(id));
        }
        overlay.appendChild(btn);
      }
    }

    fpBuildLabels();

    // Wrap mapEl + overlay in a relative container so overlay positions correctly
    // Director Mode button — standalone HTML, above the map
    const dirBtn = document.createElement('button');
    dirBtn.dataset.fpRoom = 'DIR';
    dirBtn.textContent = 'DIRECTOR MODE';
    dirBtn.style.cssText = [
      'width:100%',
      'display:block',
      'padding:5px 8px',
      'background:transparent',
      'border:none',
      'border-bottom:1px solid rgba(0,0,0,0.12)',
      'font-family:highway-gothic,sans-serif',
      'font-size:clamp(8px,2vw,13px)',
      'font-weight:700',
      'letter-spacing:0.08em',
      'text-transform:uppercase',
      'color:rgba(0,0,0,0.55)',
      'cursor:pointer',
      'text-align:center',
      'transition:background 0.12s,color 0.12s',
    ].join(';');
    dirBtn.addEventListener('mouseenter', () => {
      if (fpActiveRoom !== 'DIR') { dirBtn.style.background='rgba(0,0,0,0.05)'; dirBtn.style.color='rgba(0,0,0,0.8)'; }
    });
    dirBtn.addEventListener('mouseleave', () => {
      if (fpActiveRoom !== 'DIR') { dirBtn.style.background='transparent'; dirBtn.style.color='rgba(0,0,0,0.55)'; }
    });
    dirBtn.addEventListener('click', () => onRoomSelected('DIR'));
    wrapper.appendChild(dirBtn);

    const mapWrap = document.createElement('div');
    mapWrap.style.cssText = 'position:relative;width:100%;line-height:0;';
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
    console.log('[SOON] Floorplan injected (architectural style v1.1)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── CLIP TOOL ──────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  let playbackId = null, streamName = null, streamId = null;
  let allStreams = [];
  let previewUrl = null, previewClipId = null; // previewUrl = MP4 for download
  let wsDetectedId = null;
  let clipInjected = false;
  // Called by clipWatchPopover to signal bg poller a new clip is coming
  let _bgResetBaseline = null;
  // Direct clip ID from XHR intercept — most reliable source
  let _interceptedClipId = null;

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
      clipUpdateStreamDisplay();
      clipHideDropdown();
      clipSetStatus(`Clipping from: ${match.name}`, 'ok');
      console.log('[FT] clip stream → ', match.name, match.id);
    } else {
      // Stream not found — show dropdown so user can pick manually
      clipShowDropdown();
      clipSetStatus(`No stream found for ${room.label} — select manually`, '');
    }
  }

  // ── WS intercept ──────────────────────────────────────────────────────────
  ;(function() {
    const Orig = unsafeWindow.WebSocket;
    function FTCWS(url, p) {
      const ws = p ? new Orig(url, p) : new Orig(url);
      if (typeof url === 'string' && url.includes('fishtank')) {
        // Detect stream ID from URL
        const m = url.match(/\/(?:json_)?live[%+]2[Bb]([a-z0-9]+-\d+)/i);
        if (m) { wsDetectedId = m[1]; if (allStreams.length) clipApplyById(wsDetectedId); }
        // Listen to messages for clip save events
        ws.addEventListener('message', evt => {
          try {
            const raw = evt.data;
            if (typeof raw !== 'string') return;
            // Socket.io frames start with digit + optional namespace
            // Strip the socket.io framing to get JSON
            const jsonStart = raw.indexOf('{');
            const jsonEnd = raw.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) return;
            const text = raw.slice(jsonStart, jsonEnd + 1);
            const data = JSON.parse(text);
            // Look for clip ID in any shape the response might take
            const clipId = data.id || data.clipId || data.clip?.id ||
                           data.data?.id || data.data?.clipId ||
                           data.payload?.id || data.payload?.clipId;
            // Only fire if it looks like a clip (numeric ID, not a stream ID)
            if (clipId && /^\d+$/.test(String(clipId)) && String(clipId) !== String(_interceptedClipId)) {
              // Check it's actually clip-related (has clip-like fields or came with clip event)
              const isClipEvent = raw.includes('clip') || raw.includes('Clip') ||
                                  data.type?.toLowerCase().includes('clip') ||
                                  data.event?.toLowerCase().includes('clip');
              if (!isClipEvent) return;
              _interceptedClipId = String(clipId);
              console.log('[SOON] WS clip id detected:', _interceptedClipId, '| raw snippet:', raw.slice(0, 120));
              const playbackId = data.playbackId || data.clip?.playbackId || data.data?.playbackId;
              setTimeout(() => {
                const id = _interceptedClipId;
                previewClipId = id;
                previewUrl = playbackId ? `https://streams-c.fishtank.live/vod/${playbackId}/index.m3u8` : null;
                clipSetStatus(`✓ Clip ${id} detected — ${previewUrl ? 'loading preview…' : 'waiting for playbackId…'}`, 'ok');
                const ph = document.querySelector('#ftc-preview-hdr');
                const pb = document.querySelector('#ftc-preview-body');
                if (ph) ph.style.display = 'flex';
                if (pb) { pb.classList.remove('collapsed'); pb.style.maxHeight = '600px'; }
                document.querySelector('#ftc-preview-chevron')?.classList.add('open');
                const vid = document.querySelector('#ftc-video');
                if (vid && previewUrl) { if (vid._hls) { vid._hls.destroy(); vid._hls = null; } playClipInVideo(vid, previewUrl); }
                const clipBody = document.querySelector('#ftc-clip-body');
                const clipHdr  = document.querySelector('#ftc-clip-hdr');
                if (clipBody) { clipBody.classList.remove('collapsed'); clipBody.style.maxHeight = '600px'; }
                if (clipHdr) clipHdr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                setTimeout(() => pb?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
              }, 300);
            }
          } catch(e) {}
        });
      }
      return ws;
    }
    FTCWS.prototype = Orig.prototype;
    FTCWS.CONNECTING=0; FTCWS.OPEN=1; FTCWS.CLOSING=2; FTCWS.CLOSED=3;
    unsafeWindow.WebSocket = FTCWS;
  })();

  // ── XHR intercept — watch for Fishtank's own clip creation API calls ────────
  // When user clicks "Save the last minute", Fishtank POSTs to their clips API.
  // The response contains the clip ID. We intercept this to get the ID instantly.
  ;(function() {
    const OrigXHR = unsafeWindow.XMLHttpRequest;
    function FTCXhr() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      let _url = '';
      xhr.open = function(method, url, ...rest) {
        _url = url || '';
        return origOpen(method, url, ...rest);
      };
      xhr.addEventListener('load', function() {
        // Watch for clip creation (POST) or clip list responses
        if (!_url.includes('api.fishtank.live')) return;
        if (!(_url.includes('/clips') || _url.includes('/v1/clip'))) return;
        try {
          const text = xhr.responseText;
          if (!text || !text.includes('{')) return;
          const data = JSON.parse(text);
          // Single clip creation response: {id, playbackId, ...}
          const clipId = data.id || data.clipId || data.clip?.id;
          if (clipId && String(clipId) !== String(_interceptedClipId)) {
            _interceptedClipId = String(clipId);
            console.log('[SOON] XHR intercepted clip id:', _interceptedClipId, 'from', _url);
            // Trigger load after short delay to let Fishtank finish its own processing
            setTimeout(() => {
              if (_interceptedClipId) {
                const id = _interceptedClipId;
                previewClipId = id;
                previewUrl = data.playbackId ? getClipMp4(data) : null;
                const _hlsUrl = data.playbackId ? getClipVideoUrl(data) : null;
                clipSetStatus(`✓ Clip ${id} captured — ${_hlsUrl ? 'loading preview…' : 'waiting for playbackId…'}`, 'ok');
                const ph = document.querySelector('#ftc-preview-hdr');
                const pb = document.querySelector('#ftc-preview-body');
                if (ph) ph.style.display = 'flex';
                if (pb) { pb.classList.remove('collapsed'); pb.style.maxHeight = '600px'; }
                document.querySelector('#ftc-preview-chevron')?.classList.add('open');
                const vid = document.querySelector('#ftc-video');
                if (vid && previewUrl) { if (vid._hls) { vid._hls.destroy(); vid._hls = null; } playClipInVideo(vid, previewUrl); }
                const clipBody = document.querySelector('#ftc-clip-body');
                const clipHdr  = document.querySelector('#ftc-clip-hdr');
                if (clipBody) { clipBody.classList.remove('collapsed'); clipBody.style.maxHeight = '600px'; }
                if (clipHdr) clipHdr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                setTimeout(() => pb?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
              }
            }, 500);
          }
        } catch(e) {}
      });
      return xhr;
    }
    FTCXhr.prototype = OrigXHR.prototype;
    FTCXhr.UNSENT=0; FTCXhr.OPENED=1; FTCXhr.HEADERS_RECEIVED=2; FTCXhr.LOADING=3; FTCXhr.DONE=4;
    unsafeWindow.XMLHttpRequest = FTCXhr;
  })();

  // Also intercept fetch() on the page (not our sandbox fetch, the page's fetch)
  ;(function() {
    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function(url, opts) {
      const p = origFetch.call(this, url, opts);
      const urlStr = String(url);
      if (urlStr.includes('api.fishtank.live') && urlStr.includes('/clip')) {
        p.then(r => {
          const clone = r.clone();
          clone.text().then(text => {
            if (!text || !text.includes('{')) return;
            try {
              const data = JSON.parse(text);
              const clipId = data.id || data.clipId || data.clip?.id;
              if (clipId && String(clipId) !== String(_interceptedClipId)) {
                _interceptedClipId = String(clipId);
                console.log('[SOON] fetch intercepted clip id:', _interceptedClipId, 'from', urlStr);
                setTimeout(() => {
                  if (_interceptedClipId) {
                    const id = _interceptedClipId;
                    previewClipId = id;
                    previewUrl = data.playbackId ? getClipMp4(data) : null;
                    clipSetStatus(`✓ Clip ${id} captured — loading preview…`, 'ok');
                    const ph = document.querySelector('#ftc-preview-hdr');
                    const pb = document.querySelector('#ftc-preview-body');
                    if (ph) ph.style.display = 'flex';
                    if (pb) { pb.classList.remove('collapsed'); pb.style.maxHeight = '600px'; }
                    document.querySelector('#ftc-preview-chevron')?.classList.add('open');
                    const vid = document.querySelector('#ftc-video');
                    const _fetchHlsUrl = data.playbackId ? getClipVideoUrl(data) : null;
                    if (vid && _fetchHlsUrl) { if (vid._hls) { vid._hls.destroy(); vid._hls = null; } playClipInVideo(vid, _fetchHlsUrl); }
                    const clipBody = document.querySelector('#ftc-clip-body');
                    if (clipBody) { clipBody.classList.remove('collapsed'); clipBody.style.maxHeight = '600px'; }
                    setTimeout(() => pb?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
                  }
                }, 500);
              }
            } catch(e) {}
          }).catch(() => {});
        }).catch(() => {});
      }
      return p;
    };
  })();

  // ── Styles ─────────────────────────────────────────────────────────────────
  // Load hls.js for HLS stream playback in Chrome
  function loadHlsJs(cb) {
    if (window.Hls) { cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
    s.onload = cb;
    s.onerror = () => console.warn('[SOON] hls.js failed to load');
    document.head.appendChild(s);
  }

  function playClipInVideo(videoEl, url) {
    if (!url) { console.warn('[SOON] playClipInVideo: no URL'); return; }
    console.log('[SOON] playClipInVideo:', url.slice(-40), '| Hls:', !!window.Hls, '| supported:', window.Hls ? Hls.isSupported() : 'n/a');
    const isHls = url.includes('.m3u8');
    if (isHls && window.Hls && Hls.isSupported()) {
      const hls = new Hls({ debug: false });
      hls.on(Hls.Events.ERROR, (e, data) => {
        console.warn('[SOON] hls.js error:', data.type, data.details, data.fatal);
        if (data.fatal) clipSetStatus('Preview error: ' + data.details, 'err');
      });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[SOON] hls.js manifest parsed — playing');
        videoEl.play().catch(e => console.warn('[SOON] play() rejected:', e.message));
      });
      videoEl._hls = hls;
    } else if (isHls && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      console.log('[SOON] using native HLS');
      videoEl.src = url;
      videoEl.play().catch(() => {});
    } else {
      console.log('[SOON] using direct src:', url.slice(-30));
      videoEl.src = url;
      videoEl.play().catch(() => {});
    }
  }

  function clipAddStyles() {
    GM_addStyle(`
      #ftfp-map svg text { pointer-events: none; }
      #ftc-root {
        font-family: var(--base-font-primary, sofia-pro-variable, sans-serif);
        flex-shrink: 0; display: flex; flex-direction: column;
        overflow: visible;
      }
      .ftc-section-hdr {
        display:flex;align-items:center;padding:0px 3.2px 1.6px;gap:6px;
        background:var(--base-light, #dddec4);
        background-image:var(--base-texture-background);
        border-bottom:1px solid rgba(0,0,0,0.15);
        box-shadow:rgba(255,255,255,0.5) 0px 1px 0px;
        flex-shrink:0;cursor:pointer;user-select:none;
      }
      .ftc-section-hdr:hover { filter:brightness(1.1); }
      .ftc-hdr-fish {
        color:var(--base-primary,#df4e1e);
        filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));
        flex-shrink:0;margin-right:3.2px;
        display:inline-flex;align-items:center;
        width:14px;height:14px;
      }
      .ftc-hdr-title {
        font-family:var(--base-font-primary, sofia-pro-variable, sans-serif);
        font-size:14px;font-weight:700;line-height:19.2px;
        letter-spacing:normal;font-style:normal;
        font-variation-settings:"wght" 700;
        color:var(--base-dark-text, #191c20);
        text-shadow:none;
        margin-right:4px;flex-shrink:0;
      }
      .ftc-hdr-pill {
        cursor:pointer;padding:1px 8px;font-size:0.75rem;
        color:var(--base-light-text,#555);
        text-shadow:var(--base-text-shadow-input,none);
        border-radius:6px;
        background:linear-gradient(to top,rgba(0,0,0,0.08),rgba(0,0,0,0.04));
        border:1px solid rgba(0,0,0,0.15);
        box-shadow:0 2px 4px rgba(0,0,0,0.1);
      }
      .ftc-hdr-pill:hover { border-color:rgba(0,0,0,0.3); }
      .ftc-hdr-right { display:flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0; }
            .ftc-hdr-btn {
        background:rgba(0,0,0,0.25);border:1px solid rgba(0,0,0,0.4);border-radius:3px;
        color:rgba(0,0,0,0.75);font-size:9px;
        font-family:var(--base-font-secondary,highway-gothic,sans-serif);
        font-weight:700;letter-spacing:0.08em;
        padding:1px 7px;cursor:pointer;transition:all 0.15s;line-height:1.5;
      }
      .ftc-hdr-btn:hover { background:rgba(0,0,0,0.4);border-color:rgba(0,0,0,0.6);color:rgba(0,0,0,0.95); }
      .ftc-hdr-badge {
        font-size:8px;letter-spacing:0.08em;color:rgba(255,255,255,0.3);
        padding:1px 5px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);
      }
      .ftc-hdr-badge.live { color:var(--base-secondary,#26b64b);border-color:var(--base-secondary,#26b64b); }
      .ftc-chevron { font-size:9px;color:rgba(255,255,255,0.3);transition:transform 0.2s; }
      .ftc-chevron.open { transform:rotate(180deg); }
      .ftc-section-body {
        overflow:hidden;transition:max-height 0.3s ease;
        background:var(--base-background,#557194);background-image:var(--base-texture-background);
      }
      .ftc-section-body.collapsed { max-height:0 !important;overflow:hidden; }
      .ftc-section-inner { padding:10px;display:flex;flex-direction:column;gap:8px; }
      .ftc-lbl { font-size:8px;font-weight:700;letter-spacing:0.18em;color:rgba(0,0,0,0.4);text-transform:uppercase;margin-bottom:4px; }
      #ftc-stream-row { display:flex;align-items:center;gap:6px; }
      #ftc-stream-dot {
        width:6px;height:6px;border-radius:50%;
        background:var(--base-secondary,#26b64b);
        box-shadow:0 0 5px var(--base-secondary,#26b64b);
        flex-shrink:0;animation:ftc-pulse 2s ease-in-out infinite;
      }
      @keyframes ftc-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
      #ftc-stream-name { flex:1;font-size:12px;font-weight:700;color:var(--base-light,#dddec4);font-family:var(--base-font-secondary,highway-gothic,sans-serif); }
      #ftc-stream-sub { font-size:9px;color:rgba(255,255,255,0.2); }
      #ftc-stream-refresh {
        background:none;border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.25);
        cursor:pointer;font-size:11px;width:20px;height:20px;border-radius:4px;
        display:flex;align-items:center;justify-content:center;transition:all 0.15s;
      }
      #ftc-stream-refresh:hover { border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }
      #ftc-stream-dropdown { display:none; }
      #ftc-stream-sel, #ftc-manual-id {
        width:100%;box-sizing:border-box;background:rgba(0,0,0,0.25);
        border:1px solid rgba(255,255,255,0.08);border-radius:5px;
        color:var(--base-light,#dddec4);font-family:var(--base-font-primary,sans-serif);
        font-size:11px;padding:6px 8px;outline:none;
      }
      #ftc-stream-sel:focus, #ftc-manual-id:focus { border-color:var(--base-primary,#df4e1e); }
      #ftc-manual-row { display:flex;gap:5px;margin-top:5px; }
      #ftc-manual-id { flex:1; }

      #ftc-status { font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:0.04em;padding:6px 8px;background:rgba(0,0,0,0.2);border-radius:5px;display:none; }
      #ftc-status.show { display:block; }
      #ftc-status.err  { color:var(--base-danger,#c92a2a); }
      #ftc-status.ok   { color:var(--base-secondary,#26b64b); }
      #ftc-status.busy { color:var(--base-primary,#df4e1e); }
      #ftc-progress { height:2px;background:rgba(0,0,0,0.2);border-radius:1px;margin-top:5px;overflow:hidden; }
      #ftc-progress-fill { height:100%;background:var(--base-primary,#df4e1e);border-radius:1px;animation:ftc-slide 1.4s ease-in-out infinite; }
      @keyframes ftc-slide { 0%{transform:translateX(-120%) scaleX(.4)} 100%{transform:translateX(320%) scaleX(.4)} }
      .ftc-btn {
        width:100%;padding:9px;background:var(--base-primary,#df4e1e);background-image:var(--base-texture-metal);
        border:1px solid rgba(0,0,0,0.3);border-radius:20px;color:#fff;
        font-family:var(--base-font-secondary,highway-gothic,sans-serif);
        font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
        cursor:pointer;transition:opacity 0.15s;box-shadow:0 2px 8px rgba(0,0,0,0.3);
      }
      .ftc-btn:hover { opacity:.88; }
      .ftc-btn:disabled { background:rgba(0,0,0,0.2);background-image:none;color:rgba(255,255,255,0.15);cursor:not-allowed;box-shadow:none; }
      .ftc-btn.green { background:var(--base-secondary,#26b64b); }
      #ftc-video-wrap { position:relative;background:#000;border-radius:5px;overflow:hidden;aspect-ratio:16/9;border:1px solid rgba(0,0,0,0.4); }
      #ftc-video { width:100%;height:100%;display:block; }

      #ftc-scrub-outer { position:relative;height:32px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,0,0,0.4);border-radius:5px;overflow:visible;user-select:none;cursor:pointer; }
      #ftc-scrub-sel { position:absolute;top:0;height:100%;background:color-mix(in srgb,var(--base-primary,#df4e1e) 20%,transparent);border-top:2px solid var(--base-primary,#df4e1e);border-bottom:2px solid var(--base-primary,#df4e1e);pointer-events:none; }
      #ftc-playhead { position:absolute;top:0;bottom:0;width:2px;background:var(--base-light,#dddec4);pointer-events:none;z-index:8; }
      #ftc-playhead::after { content:'';position:absolute;top:-3px;left:50%;transform:translateX(-50%);width:8px;height:8px;border-radius:50%;background:var(--base-light,#dddec4); }
      .ftc-scrub-handle { position:absolute;top:0;bottom:0;width:12px;background:var(--base-primary,#df4e1e);cursor:ew-resize;z-index:10;border-radius:2px;display:flex;align-items:center;justify-content:center; }
      .ftc-scrub-handle::after { content:'';width:2px;height:10px;background:rgba(255,255,255,0.4);border-radius:1px; }
      #ftc-scrub-in  { left:0%;transform:translateX(-50%); }
      #ftc-scrub-out { left:100%;transform:translateX(-50%); }
      #ftc-scrub-times { display:flex;justify-content:space-between;margin-top:3px; }
      .ftc-st { font-size:8px;color:rgba(255,255,255,0.25); }
      #ftc-st-dur { font-size:8px;color:var(--base-primary,#df4e1e);font-weight:700; }
      #ftc-tweet { width:100%;box-sizing:border-box;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.08);border-radius:5px;color:var(--base-light,#dddec4);font-family:var(--base-font-primary,sans-serif);font-size:11px;padding:7px 9px;resize:none;height:52px;outline:none;line-height:1.4; }
      #ftc-tweet:focus { border-color:var(--base-primary,#df4e1e); }
      #ftc-cc { font-size:8px;color:rgba(255,255,255,0.2);text-align:right;margin-top:2px; }
      #ftc-cc.warn { color:var(--base-link,#efc820); }
      #ftc-cc.over { color:var(--base-danger,#c92a2a); }
      .ftc-small-btn { padding:5px 10px;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.08);border-radius:20px;color:rgba(255,255,255,0.4);font-family:var(--base-font-primary,sans-serif);font-size:9px;font-weight:700;cursor:pointer;transition:all 0.15s;letter-spacing:0.06em; }
      .ftc-small-btn:hover { border-color:var(--base-primary,#df4e1e);color:var(--base-primary,#df4e1e); }
    `);
  }

  function clipFindColumn() {
    for (const el of document.querySelectorAll('div')) {
      const cl = typeof el.className === 'string' ? el.className : '';
      if (!cl.includes('flex-col') || !cl.includes('h-full') || !cl.includes('min-h-0')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 400) continue;
      if (Array.from(el.children).length < 2) continue;
      return el;
    }
    for (const el of document.querySelectorAll('div')) {
      const cl = typeof el.className === 'string' ? el.className : '';
      if (!cl.includes('shadow-panel')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 400) continue;
      for (const child of el.querySelectorAll('div')) {
        const cc = typeof child.className === 'string' ? child.className : '';
        if (cc.includes('flex-col') && cc.includes('h-full') && cc.includes('min-h-0')) {
          const cr = child.getBoundingClientRect();
          if (cr.width > 300 && cr.height > 400) return child;
        }
      }
    }
    return null;
  }

  function clipInjectIntoColumn() {
    if (clipInjected) return;
    const col = clipFindColumn();
    if (!col) return;
    let chatEl = null;
    for (const child of col.children) {
      const cl = typeof child.className === 'string' ? child.className : '';
      if (cl.includes('flex-1') || cl.includes('h-full')) chatEl = child;
    }
    if (!chatEl) chatEl = col.children[col.children.length - 1];
    if (!chatEl) return;
    clipInjected = true;
    col.style.overflowY = 'auto';
    col.style.overflowX = 'hidden';
    clipBuildUI(col, chatEl);
    clipLoadAndDetect();
  }

  function clipBuildUI(col, chatEl) {
    const root = document.createElement('div');
    root.id = 'ftc-root';
    const clipOpen    = LS.get('clip_open')    !== 'false';
    const previewOpen = LS.get('preview_open') !== 'false';

    root.innerHTML = `
      <div class="ftc-section-hdr" id="ftc-clip-hdr">
        <span class="ftc-hdr-fish"><svg style="width:14px;height:14px;margin-right:3.2px;flex-shrink:0;color:var(--base-primary,#df4e1e);filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));" fill="currentColor" stroke="currentColor" viewBox="0 0 387 387" xmlns="http://www.w3.org/2000/svg"><path d="M333,288c-10-18-27-31-45-36c-13-4-25-3-36,2l-32-57c29-53,71-131,77-141c13-23-8-49-9-50L281,0l-87,152L107,0l-6,7c-1,1-23,27-9,50c5,9,48,88,77,141l-32,57c-11-4-24-5-36-2c-18,5-35,18-45,36c-19,34-12,75,17,92c8,5,17,7,27,7c5,0,11,0,16-2c31-11,47-36,55-62c0-1,16-63,24-77c0,0,0,0,1-1c0,1,1,1,1,1c9,14,24,76,24,77c8,26,24,52,55,62c5,2,11,2,16,2c10,0,19-2,27-7C345,363,353,322,333,288zM134,334c-6,11-17,20-28,23c-3,1-6,1-8,1c-5,0-9-1-12-3c-15-9-18-32-7-52c7-11,17-20,28-23c7-2,15-1,21,2C143,291,146,314,134,334zM302,355c-4,2-8,3-12,3c-3,0-6,0-8-1c-11-3-21-11-28-23c-11-20-8-43,7-52c6-3,13-4,21-2c11,3,21,11,28,23C319,323,317,346,302,355z" stroke-width="0"/></svg></span>
        <span class="ftc-hdr-title">Clip</span>
        <span class="ftc-hdr-pill" id="ftc-badge">detecting…</span>
        <div class="ftc-hdr-right">
          <span class="ftc-chevron ${clipOpen ? 'open' : ''}" id="ftc-clip-chevron">▼</span>
          <button class="ftc-hdr-btn" id="ftc-min-btn" title="Minimise Soon Tools">−</button>
        </div>
      </div>
      <div class="ftc-section-body ${clipOpen ? '' : 'collapsed'}" id="ftc-clip-body" style="max-height:${clipOpen ? '600px' : '0'}">
        <div class="ftc-section-inner">
          <div>
            <div class="ftc-lbl">Stream</div>
            <div id="ftc-stream-row" style="display:none">
              <div id="ftc-stream-dot"></div>
              <div id="ftc-stream-name">—</div>
              <div id="ftc-stream-sub"></div>
              <button id="ftc-stream-refresh" title="Re-detect">↻</button>
            </div>
            <div id="ftc-stream-dropdown">
              <select id="ftc-stream-sel"></select>
              <div id="ftc-manual-row">
                <input id="ftc-manual-id" placeholder="stream ID (e.g. dirc-5)" />
                <button class="ftc-small-btn" id="ftc-manual-set">Set</button>
              </div>
            </div>
          </div>
          <div id="ftc-status"></div>
          <div style="font-size:9px;color:rgba(255,255,255,0.35);line-height:1.5;padding:6px 8px;background:rgba(0,0,0,0.15);border-radius:5px;letter-spacing:0.04em;">
            Use fishtank's <strong style="color:rgba(255,255,255,0.6)">Start recording</strong> or <strong style="color:rgba(255,255,255,0.6)">Save the last minute</strong> on any camera — clips load automatically.
          </div>
        </div>
      </div>

      <div class="ftc-section-hdr" id="ftc-preview-hdr" style="display:none">
        <span class="ftc-hdr-fish"><svg style="width:14px;height:14px;margin-right:3.2px;flex-shrink:0;color:var(--base-primary,#df4e1e);filter:drop-shadow(1px 1px 0 rgba(0,0,0,0.1));" fill="currentColor" stroke="currentColor" viewBox="0 0 387 387" xmlns="http://www.w3.org/2000/svg"><path d="M333,288c-10-18-27-31-45-36c-13-4-25-3-36,2l-32-57c29-53,71-131,77-141c13-23-8-49-9-50L281,0l-87,152L107,0l-6,7c-1,1-23,27-9,50c5,9,48,88,77,141l-32,57c-11-4-24-5-36-2c-18,5-35,18-45,36c-19,34-12,75,17,92c8,5,17,7,27,7c5,0,11,0,16-2c31-11,47-36,55-62c0-1,16-63,24-77c0,0,0,0,1-1c0,1,1,1,1,1c9,14,24,76,24,77c8,26,24,52,55,62c5,2,11,2,16,2c10,0,19-2,27-7C345,363,353,322,333,288zM134,334c-6,11-17,20-28,23c-3,1-6,1-8,1c-5,0-9-1-12-3c-15-9-18-32-7-52c7-11,17-20,28-23c7-2,15-1,21,2C143,291,146,314,134,334zM302,355c-4,2-8,3-12,3c-3,0-6,0-8-1c-11-3-21-11-28-23c-11-20-8-43,7-52c6-3,13-4,21-2c11,3,21,11,28,23C319,323,317,346,302,355z" stroke-width="0"/></svg></span>
        <span class="ftc-hdr-title">Preview</span>
        <span class="ftc-hdr-pill">Trim</span>
        <div class="ftc-hdr-right">
          <span class="ftc-chevron ${previewOpen ? 'open' : ''}" id="ftc-preview-chevron">▼</span>
        </div>
      </div>
      <div class="ftc-section-body ${previewOpen ? '' : 'collapsed'}" id="ftc-preview-body" style="max-height:${previewOpen ? '600px' : '0'}">
        <div class="ftc-section-inner">
          <div id="ftc-video-wrap">
            <video id="ftc-video" controls autoplay playsinline style="width:100%;height:100%;display:block;background:#000;" preload="metadata"></video>
          </div>
          <div>
            <div id="ftc-scrub-outer">
              <div id="ftc-scrub-sel"></div>
              <div id="ftc-playhead"></div>
              <div class="ftc-scrub-handle" id="ftc-scrub-in"></div>
              <div class="ftc-scrub-handle" id="ftc-scrub-out"></div>
            </div>
            <div id="ftc-scrub-times">
              <span class="ftc-st" id="ftc-t-in">0:00</span>
              <span id="ftc-st-dur">0:00</span>
              <span class="ftc-st" id="ftc-t-out">0:00</span>
            </div>
          </div>
          <div>
            <div class="ftc-lbl">Post Text</div>
            <textarea id="ftc-tweet" placeholder="#fishtanklive #fishtankdotlive"></textarea>
            <div id="ftc-cc">0 / 280</div>
          </div>
          <button class="ftc-btn green" id="ftc-post-btn">⬆ &nbsp;Download &amp; Post to X</button>
        </div>
      </div>

    `;

    col.insertBefore(root, chatEl);
    // Chat always visible — Soon Tools sits above it, not hiding it
    chatEl.style.display = '';
    clipWireEvents(root, chatEl, clipOpen, previewOpen);

    // CSS vars handle all theming — no runtime override needed
  }

  // Singleton bg poller state — module level so re-injection doesn't create duplicates
  let _bgLatestId = null;
  let _bgLoadedId = null;
  let _bgPolling = false;
  let _bgResetAt = 0;
  let _bgFailCount = 0;
  let _bgNextAllowed = 0;
  let _bgIntervalStarted = false; // guard: only start the interval once

  function clipWireEvents(root, chatEl, clipOpen, previewOpen) {
    function makeToggle(hdrId, bodyId, chevronId, lsKey, initialOpen) {
      let open = initialOpen;
      const hdr  = root.querySelector('#' + hdrId);
      const body = root.querySelector('#' + bodyId);
      const chev = root.querySelector('#' + chevronId);
      if (!hdr || !body) return;
      hdr.onclick = () => {
        open = !open; LS.set(lsKey, open);
        body.classList.toggle('collapsed', !open);
        body.style.maxHeight = open ? '600px' : '0';
        chev?.classList.toggle('open', open);
      };
    }
    makeToggle('ftc-clip-hdr',    'ftc-clip-body',    'ftc-clip-chevron',    'clip_open',    clipOpen);
    makeToggle('ftc-preview-hdr', 'ftc-preview-body', 'ftc-preview-chevron', 'preview_open', previewOpen);

    // Wire minimise button (now in HTML, not dynamically inserted)
    let soonMinimised = false;
    const minBtn = root.querySelector('#ftc-min-btn');
    if (minBtn) {
      minBtn.addEventListener('click', e => {
        e.stopPropagation();
        soonMinimised = !soonMinimised;
        // Toggle all section bodies and headers except clip header
        root.querySelectorAll('.ftc-section-body').forEach(el => {
          el.style.display = soonMinimised ? 'none' : '';
        });
        root.querySelectorAll('.ftc-section-hdr:not(#ftc-clip-hdr)').forEach(el => {
          el.style.display = soonMinimised ? 'none' : '';
        });
        // Chat is always visible — no need to toggle it
        minBtn.textContent = soonMinimised ? '+' : '−';
        minBtn.title = soonMinimised ? 'Expand Soon Tools' : 'Minimise Soon Tools';
      });
    }

    root.querySelector('#ftc-stream-refresh').onclick = clipDetectAndSetStream;
    root.querySelector('#ftc-stream-sel').onchange = e => clipApplyById(e.target.value);
    root.querySelector('#ftc-manual-set').onclick = () => {
      const val = root.querySelector('#ftc-manual-id').value.trim();
      if (!val) return;
      if (allStreams.length && clipApplyById(val)) return;
      streamId = val; streamName = val; playbackId = val;
      clipUpdateStreamDisplay(); clipHideDropdown();
      clipSetStatus('Stream set manually.', 'ok');
    };

    const tweet = root.querySelector('#ftc-tweet');
    tweet.value = '#fishtanklive #fishtankdotlive';
    clipUpdateCC(); tweet.oninput = clipUpdateCC;

    // iframe handles playback natively — no click handler needed
    root.querySelector('#ftc-post-btn').onclick = doPost;

    clipSetStatus('Watching for new clips…', 'busy');

    // Background auto-detection: poll every 5s for new clips
    // State is module-level (_bg* vars declared outside) to ensure only one poller ever runs

    async function bgSnapshotLatest() {
      try {
        const r = await gmFetch('https://api.fishtank.live/v1/clips?queryType=MY&sort=created_at&page=1&pageSize=1');
        if (!r.ok) { console.warn('[SOON] clip snapshot HTTP', r.status, r._body?.slice(0, 200)); return; }
        const d = await r.json();
        _bgLatestId = (d.clips || [])[0]?.id || null;
        console.log('[SOON] clip snapshot ok, latest id:', _bgLatestId || 'none');
      } catch(e) { console.warn('[SOON] clip snapshot error:', e.message); }
    }

    async function loadClip(clip) {
      previewClipId = clip.id;
      previewUrl = getClipMp4(clip);       // MP4 for download
      const hlsUrl = getClipVideoUrl(clip); // HLS for preview
      console.log('[SOON] clip loaded:', clip.id, '| mp4:', previewUrl, '| hls:', hlsUrl);
      const label = clip.name ? `"${clip.name}"` : `clip ${clip.id}`;
      clipSetStatus(`✓ ${label} from ${clip.liveStream || ''} — preview loaded`, 'ok');
      const ph = document.querySelector('#ftc-preview-hdr');
      const pb = document.querySelector('#ftc-preview-body');
      if (ph) ph.style.display = 'flex';
      if (pb) { pb.classList.remove('collapsed'); pb.style.maxHeight = '600px'; }
      document.querySelector('#ftc-preview-chevron')?.classList.add('open');
      const vid = document.querySelector('#ftc-video');
      if (vid && hlsUrl) { if (vid._hls) { vid._hls.destroy(); vid._hls = null; } playClipInVideo(vid, hlsUrl); }
      setTimeout(() => pb?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 200);
    }

    // Reset fn: clipWatchPopover calls this when a save is triggered
    _bgResetBaseline = () => {
      // Clear both IDs: a new clip will have a higher ID, so we need to re-baseline
      // If we only clear _bgLoadedId, the condition c.id === _bgLatestId matches the OLD clip
      // and it won't fire again. Clear both so the next poll re-establishes the baseline.
      _bgLatestId = null;
      _bgLoadedId = null;
      _bgResetAt = Date.now();
      console.log('[SOON] bg baseline reset — watching for new clip');
      clipSetStatus('Clip saving… auto-loading…', 'busy');
    };


    // Load hls.js for clip preview playback
    loadHlsJs(() => console.log('[SOON] hls.js ready'));
    // Background poller
    bgSnapshotLatest().then(() => {
      if (_bgIntervalStarted) return;
      _bgIntervalStarted = true;
      setInterval(async () => {
        if (_bgPolling) return;
        if (Date.now() < _bgNextAllowed) return; // backoff suppression
        _bgPolling = true;
        try {
          const r = await gmFetch('https://api.fishtank.live/v1/clips?queryType=MY&sort=created_at&page=1&pageSize=5');
          if (!r.ok) {
            _bgFailCount++;
            _bgNextAllowed = Date.now() + Math.min(10000 * Math.pow(2, _bgFailCount - 1), 60000);
            console.warn('[SOON] clip poll HTTP', r.status, r._body?.slice(0, 200), '— backing off', Math.round((_bgNextAllowed - Date.now()) / 1000) + 's');
            return;
          }
          _bgFailCount = 0;
          const d = await r.json();
          const clips = d.clips || [];
          const latest = clips[0];
          if (!latest) { console.log('[SOON] clip poll ok but no clips returned'); return; }
          console.log('[SOON] clip poll ok — latest:', latest.id, '| playbackId:', latest.playbackId || 'NONE YET', '| baseline:', _bgLatestId);

          if (!_bgLatestId) _bgLatestId = latest.id;

          const resetRecently = _bgResetAt > 0 && (Date.now() - _bgResetAt) < 120000;
          const candidate = clips.find(c => {
            if (!c.playbackId) return false;
            if (parseInt(c.id) > parseInt(_bgLatestId)) return true;
            if (resetRecently && c.id === _bgLoadedId) return false;
            if (resetRecently && !_bgLoadedId) return true;
            return false;
          });
          if (candidate) {
            _bgLatestId = candidate.id;
            _bgLoadedId = candidate.id;
            loadClip(candidate);
          }
        } catch(e) {
          console.warn('[SOON] bg clip poll:', e);
          _bgFailCount++;
          _bgNextAllowed = Date.now() + Math.min(10000 * Math.pow(2, _bgFailCount - 1), 60000);
        } finally {
          _bgPolling = false;
        }
      }, 5000);
    });

  }

  let _streamsLoaded = false;
  async function clipLoadAndDetect() {
    if (_streamsLoaded) return;
    _streamsLoaded = true;
    try {
      const r = await gmFetch('https://api.fishtank.live/v1/live-streams');
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      allStreams = Array.isArray(data) ? data : (data.liveStreams || data.streams || []);
      console.log('[SOON] streams loaded:', allStreams.length);
      clipPopulateDropdown();
      clipDetectAndSetStream();
      clipWatchStreamSwitches();
      // If a room is already active on the map, apply it now
      if (fpActiveRoom) clipApplyRoomStream(fpActiveRoom);
    } catch (e) {
      _streamsLoaded = false; // allow retry on failure
      console.error('[FT] loadAndDetect:', e);
      clipSetStatus('Failed to load streams.', 'err');
    }
  }

  function clipApplyById(id) {
    const cleanId = (id || '').replace(/^2[Bb]/, '').toLowerCase().trim();
    const match = allStreams.find(s => s.id === cleanId || s.id === id || s.playbackId === id);
    if (match) {
      streamId = match.id; streamName = match.name; playbackId = match.playbackId;
      clipUpdateStreamDisplay(); clipHideDropdown();
      return true;
    }
    return false;
  }

  function clipPopulateDropdown() {
    const sel = document.querySelector('#ftc-stream-sel');
    if (!sel) return;
    if (!allStreams.length) { sel.innerHTML = '<option>No streams</option>'; return; }
    sel.innerHTML = allStreams.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    sel.onchange = e => clipApplyById(e.target.value);
  }

  async function clipDetectAndSetStream() {
    if (!allStreams.length) { clipShowDropdown(); return; }
    if (wsDetectedId && clipApplyById(wsDetectedId)) return;
    try {
      const perf = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).performance;
      const entries = perf.getEntriesByType('resource');
      let latestTime = 0, latestId = null;
      for (const e of entries) {
        const m = e.name.match(/live-streams\/zones\/([a-z0-9]+-\d+)/i);
        if (m && e.startTime > latestTime) { latestTime = e.startTime; latestId = m[1]; }
      }
      if (latestId && clipApplyById(latestId)) return;
    } catch (_) {}
    try {
      const results = await Promise.allSettled(
        allStreams.slice(0, 10).map(s =>
          gmFetch(`https://api.fishtank.live/v1/live-streams/zones/${s.id}`)
            .then(r => r.ok ? r.json().then(d => ({ id: s.id, zones: d.clickableZones?.length || 0 })) : null)
        )
      );
      const active = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).sort((a,b) => b.zones - a.zones)[0];
      if (active && active.zones > 0 && clipApplyById(active.id)) return;
    } catch (_) {}
    clipShowDropdown();
  }

  function clipWatchStreamSwitches() {
    let lastWs = wsDetectedId;
    setInterval(() => {
      if (wsDetectedId && wsDetectedId !== lastWs) {
        lastWs = wsDetectedId;
        if (allStreams.length) clipApplyById(wsDetectedId);
      }
    }, 1000);
    setInterval(() => { if (!allStreams.length || streamId) return; clipDetectAndSetStream(); }, 10000);
  }

  function clipShowDropdown() {
    const dd = document.querySelector('#ftc-stream-dropdown');
    const row = document.querySelector('#ftc-stream-row');
    if (dd) dd.style.display = 'block';
    if (row) row.style.display = 'none';
  }
  function clipHideDropdown() {
    const dd = document.querySelector('#ftc-stream-dropdown');
    const row = document.querySelector('#ftc-stream-row');
    if (dd) dd.style.display = 'none';
    if (row) row.style.display = 'flex';
  }
  function clipUpdateStreamDisplay() {
    const name  = document.querySelector('#ftc-stream-name');
    const sub   = document.querySelector('#ftc-stream-sub');
    const badge = document.querySelector('#ftc-badge');
    if (name)  name.textContent  = streamName || '—';
    if (sub)   sub.textContent   = streamId   || '';
    if (badge) { badge.textContent = '● LIVE'; badge.classList.add('live'); }
  }

  function clipUpdateCC() {
    const t = document.querySelector('#ftc-tweet');
    const cc = document.querySelector('#ftc-cc');
    if (!t || !cc) return;
    const n = t.value.length;
    cc.textContent = `${n} / 280`;
    cc.className = n > 260 ? (n > 280 ? 'over' : 'warn') : '';
  }

  async function doPost() {
    const btn = document.querySelector('#ftc-post-btn');
    if (!previewClipId) { clipSetStatus('No clip ready.', 'err'); return; }
    btn.disabled = true;
    clipSetStatus('Fetching clip for download…', 'busy');
    try {
      // Try single clip endpoint first (works even when list API is broken)
      let downloadUrl = previewUrl;
      if (!downloadUrl) {
        const sr = await gmFetch(`https://api.fishtank.live/v1/clips/${previewClipId}`);
        if (sr.ok) {
          const sd = await sr.json();
          if (sd.playbackId) downloadUrl = getClipMp4(sd);
        }
      }
      // Fallback: try the list endpoint
      if (!downloadUrl) {
        const r = await gmFetch('https://api.fishtank.live/v1/clips?queryType=MY&sort=created_at&page=1&pageSize=20');
        if (r.ok) {
          const data = await r.json();
          const clips = data.clips || [];
          const clip = clips.find(c => String(c.id) === String(previewClipId)) || clips[0];
          downloadUrl = getClipMp4(clip);
        }
      }
      const clip = { name: null }; // fallback for filename
      if (!downloadUrl) { clipSetStatus('No download URL — clip may still be processing.', 'err'); btn.disabled = false; return; }
      console.log('[SOON] download URL:', downloadUrl);

      clipSetStatus('Downloading…', 'busy');
      await clipDownloadMP4(downloadUrl, `fishtank-clip-${previewClipId}.mp4`);
      const txt = document.querySelector('#ftc-tweet')?.value || '#fishtanklive #fishtankdotlive';
      window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(txt)}`, '_blank');
      clipSetStatus('✓ Done — drag MP4 into X to attach.', 'ok');
    } catch (err) { clipSetStatus(err.message, 'err'); }
    btn.disabled = false;
  }

  function clipDownloadMP4(url, filename) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method:'GET', url, responseType:'blob',
        onload(r) {
          if (r.status===200) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([r.response],{type:'video/mp4'}));
            a.download = filename;
            document.body.appendChild(a); a.click();
            setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},8000);
            resolve();
          } else reject(new Error(`Download HTTP ${r.status}`));
        },
        onerror: ()=>reject(new Error('Download network error'))
      });
    });
  }

  function clipSetStatus(msg, type='') {
    const el = document.querySelector('#ftc-status');
    if (!el) return;
    el.textContent = msg; el.className = type + ' show';
    const p = document.querySelector('#ftc-progress');
    if (p) p.style.display = type==='busy' ? 'block' : 'none';
  }

  function clipWatchPopover() {
    // Primary method: intercept Fishtank's SPA navigation after clip save.
    // When a clip is saved, Fishtank navigates to /clips/{id}?back=true — we grab the ID
    // directly from the URL. This bypasses the broken /v1/clips API entirely.
    function onUrlChange(url) {
      const m = url.match(/\/clips\/(\d+)/);
      if (!m) return;
      const clipId = m[1];
      console.log('[SOON] clip URL detected:', clipId);
      // Build a minimal clip object from the URL — no API needed
      const clip = { id: clipId, playbackId: null, name: null, liveStream: null };
      // Show the clip immediately using the embed URL
      previewClipId = clipId;
      previewUrl = null; // MP4 not available without API, download will fetch it
      clipSetStatus(`✓ Clip ${clipId} detected — loading preview…`, 'ok');
      const ph = document.querySelector('#ftc-preview-hdr');
      const pb = document.querySelector('#ftc-preview-body');
      if (ph) ph.style.display = 'flex';
      if (pb) { pb.classList.remove('collapsed'); pb.style.maxHeight = '600px'; }
      document.querySelector('#ftc-preview-chevron')?.classList.add('open');
      const vid = document.querySelector('#ftc-video');
      // No playbackId yet from URL intercept — show status, background fetch will update
      if (vid) vid.src = '';
      const clipBody = document.querySelector('#ftc-clip-body');
      const clipHdr  = document.querySelector('#ftc-clip-hdr');
      if (clipBody) { clipBody.classList.remove('collapsed'); clipBody.style.maxHeight = '600px'; }
      if (clipHdr)  clipHdr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => pb?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
      // Also try to fetch the playbackId for MP4 download in the background
      gmFetch(`https://api.fishtank.live/v1/clips/${clipId}`, {})
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d?.playbackId) {
            previewUrl = getClipMp4(d);
            console.log('[SOON] clip playbackId fetched:', d.playbackId);
            const vid = document.querySelector('#ftc-video');
            const hlsUrl2 = d.playbackId ? `https://streams-c.fishtank.live/vod/${d.playbackId}/index.m3u8` : null;
            if (vid && !vid.src && hlsUrl2) {
              if (vid._hls) { vid._hls.destroy(); vid._hls = null; }
              playClipInVideo(vid, hlsUrl2);
              clipSetStatus(`✓ Clip ${clipId} — preview loaded`, 'ok');
            }
          }
        })
        .catch(() => {});
    }

    // Hook pushState and replaceState for SPA navigation
    const _origPush    = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    history.pushState = function(...args) {
      _origPush(...args);
      if (args[2]) onUrlChange(String(args[2]));
    };
    history.replaceState = function(...args) {
      _origReplace(...args);
      if (args[2]) onUrlChange(String(args[2]));
    };

    // Secondary method: watch for "Clip saved!" toast text in the DOM
    const toastObs = new MutationObserver(() => {
      document.querySelectorAll('div,span,p').forEach(el => {
        if (el.dataset.ftcToastSeen) return;
        if (el.textContent?.trim() === 'Clip saved!') {
          el.dataset.ftcToastSeen = '1';
          console.log('[SOON] Clip saved toast detected — checking URL');
          // The URL may already have changed to /clips/{id}
          [500, 1500, 3000, 5000, 8000].forEach(ms =>
            setTimeout(() => onUrlChange(location.href), ms)
          );
        }
      });
    });
    toastObs.observe(document.body, { childList: true, subtree: true });

    // Tertiary: hook button clicks for status messages only
    const SAVE_BTNS = ['Save the last minute', 'Stop recording', 'Save recording'];
    const START_BTN = 'Start recording';
    const btnObs = new MutationObserver(() => {
      document.querySelectorAll('button,[role="menuitem"]').forEach(el => {
        if (el.dataset.ftcSeen) return;
        const txt = el.textContent?.trim();
        if (txt === START_BTN || SAVE_BTNS.includes(txt)) {
          el.dataset.ftcSeen = '1';
          el.addEventListener('click', () => {
            const isRecording = txt === START_BTN;
            clipSetStatus(isRecording ? 'Recording started — click Save when done…' : 'Clip saving… watching URL…', 'busy');
            const clipBody = document.querySelector('#ftc-clip-body');
            const clipHdr  = document.querySelector('#ftc-clip-hdr');
            if (clipBody) { clipBody.classList.remove('collapsed'); clipBody.style.maxHeight = '600px'; }
            if (clipHdr)  clipHdr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        }
      });
    });
    btnObs.observe(document.body, { childList: true, subtree: true });
  }

  // Build playback URL from clip data
  // Clips use mistserver with UUID playbackIds
  // Pattern observed: https://streams-c.fishtank.live/vod/{playbackId}/index.m3u8
  // or the clip embed URL pattern
  // Note: not called directly by the script — available for future use or debugging
  function getClipUrl(clip) {
    return `https://www.fishtank.live/clips/${clip.id}`;
  }

  // Returns the HLS stream URL for preview playback
  function getClipVideoUrl(clip) {
    const pbId = clip.playbackId;
    if (!pbId) return null;
    return `https://streams-c.fishtank.live/vod/${pbId}/index.m3u8`;
  }

  function getClipMp4(clip) {
    const pbId = clip.playbackId;
    if (!pbId) return null;
    // MP4 for download — try without extension first (mistserver auto-negotiates)
    return `https://streams-c.fishtank.live/vod/${pbId}/index.mp4`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INIT ───────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    clipAddStyles();
    clipWatchPopover();

    // Single shared MutationObserver for both injections — debounced to prevent
    // rapid DOM mutations (e.g. during React renders) from triggering multiple injects
    let _injectTimer = null;
    const obs = new MutationObserver(() => {
      if (fpInjected && clipInjected) return; // fast bail if both done
      clearTimeout(_injectTimer);
      _injectTimer = setTimeout(() => {
        if (!fpInjected)   fpInject();
        if (!clipInjected) clipInjectIntoColumn();
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Staggered retries
    [500, 1500, 2500, 4000].forEach(ms => setTimeout(() => {
      if (!fpInjected)   fpInject();
      if (!clipInjected) clipInjectIntoColumn();
    }, ms));

    // Active tab sync
    setInterval(fpDetectActiveTab, 1500);

    // Watch for clicks on fishtank's camera grid tiles to sync map highlight
    document.addEventListener('click', (e) => {
      let el = e.target;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const cl = typeof el.className === 'string' ? el.className : '';
        if (cl.includes('cursor-pointer') || el.tagName === 'BUTTON') {
          const text = el.textContent?.trim();
          const room = ROOMS.find(r => r.tab && text === r.tab);
          if (room && room.id !== fpActiveRoom) {
            fpActiveRoom = room.id;
            fpRebuildSVG();
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
        const rootGone = !document.getElementById('ftc-root');
        if (mapGone)  { fpInjected = false;   fpInject(); }
        if (rootGone) { clipInjected = false; clipInjectIntoColumn(); }
      }, 500);
    });
    removalObs.observe(document.body, { childList: true, subtree: true });

    console.log('[SOON] Soon Tools v1.9.3 ready');
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

})();
