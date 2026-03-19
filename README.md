# 🐟 Soon Tools

> A Tampermonkey userscript for **[fishtank.live](https://fishtank.live)** — floorplan room switcher, clip & post to X, and more.

---

## ✨ Features

- 🗺️ **Floorplan Room Switcher** — interactive floorplan overlay that lets you switch rooms on fishtank.live
- 📎 **Clip & Post to X** — clip moments and share them directly to X (Twitter)
- 🎨 **Theme-aware** — inherits fishtank.live's CSS variables for a native look & feel
- 🔄 **Auto-Update** — always stay on the latest version via Tampermonkey's built-in updater

---

## 📦 Installation

### Requirements

- A Chromium-based browser (Chrome, Edge, Brave, etc.) or Firefox
- [Tampermonkey](https://www.tampermonkey.net/) browser extension installed

### Step-by-step

1. **Install Tampermonkey** if you haven't already:
   - [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
   - [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. **Click the install link below** to open the script directly in Tampermonkey:

   ### 👉 [Install Soon Tools](https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js)

3. Tampermonkey will open an installation dialog — click **"Install"**.

4. Visit [fishtank.live](https://fishtank.live) and the script will activate automatically.

---

## 🔄 Auto-Update

Soon Tools is configured to **auto-update** through Tampermonkey. Every time Tampermonkey performs its periodic update check, it will compare the version in your installed script against the latest version on this repository.

The script's metadata block includes:

```javascript
// @updateURL    https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js
// @downloadURL  https://raw.githubusercontent.com/michaety/soontools/main/Soon%20Tools-1.9.1.user.js
```

### How to configure update checks in Tampermonkey

1. Click the **Tampermonkey icon** in your browser toolbar
2. Go to **Dashboard → Settings**
3. Under **"Script Update"**, set **"Check Interval"** to your preference (e.g. every day)
4. Make sure **"Check for script updates"** is enabled

> Updates are checked automatically in the background. You'll get a notification when a new version is available.

### Manual update check

1. Open the **Tampermonkey Dashboard**
2. Find **"Soon Tools"** in your scripts list
3. Click the **"Check for userscript updates"** button (circular arrow icon)

---

## 🛠️ Development

The userscript file follows the standard `.user.js` naming convention and includes a full Tampermonkey metadata block at the top. To modify it locally:

1. Fork this repository
2. Edit `Soon Tools-1.9.1.user.js`
3. In Tampermonkey, you can point your `@updateURL` / `@downloadURL` to your fork's raw URL for testing

---

## 📄 License

This project is provided as-is. See the script header for author and namespace info.

---

*Built for [fishtank.live](https://fishtank.live) fans 🐠*