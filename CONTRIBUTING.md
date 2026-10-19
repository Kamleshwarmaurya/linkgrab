# Contributing

Thanks for helping. LinkGrab is a small project; the goal is a safe, simple download manager.

## Setup

```
npm install
npm start        # run the app
npm test         # node --test, about 60 seconds
```

Node.js 20 or newer. For the integration tests install the engines on your PATH (`pip install yt-dlp gallery-dl`) and make sure `ffmpeg` is available.

## Ground rules

- No shell: start engines with an arguments array, and keep the link after `--`.
- Treat everything from a post (titles, ids, file names) and from `downloads.json` as untrusted. Use `textContent`, never `innerHTML`, in the renderer.
- Keep modules testable without Electron: `src/main/*` except `main.js` must not require `electron` at import time.
- Add or update a test for every fix. Tests never use the real social sites; use the local-server helpers in `tests/_helpers.js`.
- Do not set `LINKGRAB_ALLOW_ANY_HOST` anywhere in app code.

## Building the Windows installer

See the README ("Get the .exe"). `npm run dist` builds the installer and portable exe into `dist/`.

## Reporting problems

Use the bug report template. Please do not post private links or cookies.
