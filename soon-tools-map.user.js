// ==UserScript==
// @name         Soon Map
// @namespace    https://fishtank.news
// @version      4.0.0
// @description  Enhances Fishtank's native map — click any room to switch cam, syncs with stream. By fishtank.news
// @author       fishtank.news
// @match        https://www.fishtank.live/*
// @match        https://fishtank.live/*
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'soon-map-deprecated-dismissed';
  if (localStorage.getItem(STORAGE_KEY)) return;

  GM_addStyle(`
    #soon-map-deprecated {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a1a;
      color: #e8e8e8;
      font-family: sofia-pro-variable, sans-serif;
      font-size: 13px;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 420px;
      white-space: nowrap;
    }
    #soon-map-deprecated strong { color: #fff; }
    #soon-map-deprecated-dismiss {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.18);
      color: #e8e8e8;
      border-radius: 5px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
    }
    #soon-map-deprecated-dismiss:hover { background: rgba(255,255,255,0.18); }
  `);

  const banner = document.createElement('div');
  banner.id = 'soon-map-deprecated';
  banner.innerHTML = `
    <span><strong>Soon Map</strong> has been discontinued — please uninstall it.</span>
    <button id="soon-map-deprecated-dismiss">Dismiss</button>
  `;

  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner), { once: true });
  if (document.body) document.body.appendChild(banner);

  document.getElementById('soon-map-deprecated-dismiss')?.addEventListener('click', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    banner.remove();
  });
})();
