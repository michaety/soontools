# Soon Tools 🐟

> A Tampermonkey userscript for [fishtank.live](https://www.fishtank.live) — adds a **floorplan room switcher** and a **clip & post to X** feature, built by [fishtank.news](https://fishtank.news).

---

## ⚡ One-Click Install

> **Requires [Tampermonkey](https://www.tampermonkey.net/) to be installed in your browser first.**

[![Install Soon Tools](https://img.shields.io/badge/Install%20Soon%20Tools-v1.9.3-brightgreen?style=for-the-badge&logo=tampermonkey)](https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js)

Click the button above — Tampermonkey will open an install dialog automatically.

---

## 📦 Installation (Step-by-Step)

### 1. Install Tampermonkey

Install the Tampermonkey browser extension for your browser:

| Browser | Link |
|---------|------|
| Chrome | [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Safari | [App Store](https://apps.apple.com/us/app/tampermonkey/id1482490089) |

### 2. Install the Script

**Option A — One-click (recommended):**

Click the install link below, Tampermonkey will prompt you to confirm:

👉 [Install Soon Tools](https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js)

**Option B — Manual:**

1. Open Tampermonkey → click **Create a new script**
2. Delete the default content
3. Copy and paste the raw contents from [`Soon Tools-1.9.1.user.js`](https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js)
4. Press **Ctrl+S** (or **Cmd+S**) to save

### 3. Use It

Navigate to [fishtank.live](https://www.fishtank.live) — the Soon Tools UI will appear automatically.

---

## 🔄 Auto-Update

Soon Tools is configured for **automatic updates** via Tampermonkey. The script's metadata block includes:

```javascript
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js
```

- **`@updateURL`** — Tampermonkey checks this URL periodically for a newer `@version` value.
- **`@downloadURL`** — If an update is detected, Tampermonkey downloads the new script from this URL.

### Configure Update Frequency

By default, Tampermonkey checks for updates every **24 hours**. To change this:

1. Click the **Tampermonkey icon** in your browser toolbar
2. Go to **Dashboard** → **Settings**
3. Scroll to **Script Update** section
4. Set **Check Interval** to your preference (e.g., every hour, every day, never)

### Manually Check for Updates

1. Click the **Tampermonkey icon** → **Dashboard**
2. Find **Soon Tools** in the list
3. Click the **name** to open script details
4. Click **Check for Updates** (or look for the refresh icon)

---

## ✨ Features

- 🗺️ **Floorplan Room Switcher** — navigate between fishtank.live rooms using an interactive floorplan overlay
- 🎬 **Clip & Post to X** — clip moments from the stream and share directly to X (Twitter)
- 🎨 **Theme-aware** — inherits fishtank.live's CSS custom properties for seamless styling

---

## 🛠️ Compatibility

| Item | Detail |
|------|--------|
| Site | `https://fishtank.live/*` and `https://www.fishtank.live/*` |
| Script Manager | Tampermonkey (recommended), Violentmonkey |
| Browsers | Chrome, Firefox, Edge, Safari |
| Current Version | 1.9.3 |

---

## 📁 Repository

| File | Description |
|------|-------------|
| [`Soon Tools-1.9.1.user.js`](./Soon%20Tools-1.9.1.user.js) | Main userscript |
| [`fishtank-floorplan.drawio.svg`](./fishtank-floorplan.drawio.svg) | Floorplan diagram (SVG) |
| [`fishtank-floorplan.drawio.xml`](./fishtank-floorplan.drawio.xml) | Floorplan diagram source (draw.io XML) |

---

## 📝 License

This project is provided as-is for use with [fishtank.live](https://www.fishtank.live).

---

*Made with ❤️ by [fishtank.news](https://fishtank.news)*