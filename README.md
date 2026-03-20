# Soon Tools 🐟

> Tampermonkey userscripts for [fishtank.live](https://www.fishtank.live) — built by [fishtank.news](https://fishtank.news)

Soon Tools is split into two independent scripts. Install one or both.

---

## 🗺️ Soon Tools — Map

Navigate the house using an interactive architectural floorplan overlay. Click any room to switch cameras instantly — no hunting through the tab bar.

**Features:**
- Clickable floorplan for downstairs and upstairs
- Staircase zones toggle between floors
- Offline rooms shown as greyed out automatically
- Director Mode and alt cam support (Bar PTZ, Bar Alt, Dorm Alt, Market Alt)
- Inherits fishtank.live's theme — looks native
- Toggle between Map and Tabs view at any time

[![Install Map](https://img.shields.io/badge/Install%20Map-v2.0.0-brightgreen?style=for-the-badge&logo=tampermonkey)](https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-map.user.js)

---

## 🎬 Soon Tools — Clipper

Clip moments from the live stream and download them directly to your device. No Fishtank account required, no third-party upload — everything runs in your browser.

**Features:**
- **Rolling 2-minute buffer** — always ready to clip the last 30s, 60s, 90s, or 2min
- **Trim** — clip exactly what you want from the buffer
- **Crop** — cut to a section of the frame (% based, works at any resolution)
- **Watermark** — add custom text in any corner (defaults to `fishtank.news`)
- **Clip queue** — add multiple clips, they encode and download one by one
- **Fully offline** — no server, no upload, no Fishtank API. Runs entirely in your browser using FFmpeg compiled to WebAssembly

[![Install Clipper](https://img.shields.io/badge/Install%20Clipper-v2.0.0-brightgreen?style=for-the-badge&logo=tampermonkey)](https://raw.githubusercontent.com/michaety/soontools/main/soon-tools-clipper.user.js)

> **Note:** The clipper downloads ~30MB of FFmpeg on first use. This is a one-time download cached by your browser. Encoding a 60s clip takes roughly 30–90s depending on your machine.

---

## ⚡ Installation

### 1. Install Tampermonkey

| Browser | Link |
| ------- | ---- |
| Chrome  | [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Edge    | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Safari  | [App Store](https://apps.apple.com/us/app/tampermonkey/id1482490089) |

### 2. Install the scripts you want

Click the install buttons above — Tampermonkey will open a confirmation dialog.

You can install **Map only**, **Clipper only**, or **both**. If both are installed, selecting a room on the map automatically switches the clipper to that room's stream.

### 3. Use it

Navigate to [fishtank.live](https://www.fishtank.live) — Soon Tools appears automatically in the left panel.

---

## 🛠️ How the Clipper Works

Unlike the old v1 clip tool which relied on Fishtank's own clipping API, v2 is fully self-contained:

1. **HLS segment buffering** — the clipper silently taps into the live HLS stream (the same `.m3u8` feed your browser is already playing) and buffers the raw video segments in memory, keeping the last 2 minutes
2. **FFmpeg.wasm** — when you queue a clip, [FFmpeg](https://ffmpeg.org) running as WebAssembly in your browser handles all the processing: concatenating segments, trimming, cropping, and watermarking
3. **Direct download** — the encoded `.mp4` is handed straight to your browser's download system. Nothing leaves your machine except what you choose to share

This means clips are higher quality (original stream data, not re-encoded screen capture) and work even if Fishtank changes or removes their clipping infrastructure.

---

## 📁 Repository

```
soontools/
  soon-tools-map.user.js         ← Floorplan room switcher
  soon-tools-clipper.user.js     ← Stream clipper
  fishtank-floorplan.drawio.svg  ← Floorplan source (editable in draw.io)
  fishtank-floorplan.drawio.xml  ← Floorplan source XML
  README.md
```

The floorplan `.drawio` files are included if you want to update the map layout when Fishtank changes the house.

---

*Made with ❤️ by [fishtank.news](https://fishtank.news)*
