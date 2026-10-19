# LinkGrab

A small desktop download manager (IDM-style) for videos and images from YouTube, Facebook, LinkedIn, X and Instagram. Paste or drop a link, pick what to download, and LinkGrab fetches it with open-source engines: [yt-dlp](https://github.com/yt-dlp/yt-dlp) for videos, [ffmpeg](https://ffmpeg.org) for merging and audio, and [gallery-dl](https://github.com/mikf/gallery-dl) for images and mixed posts. Windows 10/11 x64 is the target; the app also runs from source on Linux.

## Supported sites

- YouTube: youtube.com, youtu.be, m.youtube.com, music.youtube.com
- Facebook: facebook.com, m.facebook.com, fb.watch
- LinkedIn: linkedin.com posts, feed and video links
- X: x.com, twitter.com and mobile subdomains (`/<user>/status/<id>` links)
- Instagram: instagram.com and instagr.am (`/p/`, `/reel/`, `/tv/` links)

Any other host is rejected with a clear error.

## Media types

- **Videos** (all sites): downloaded with yt-dlp.
- **Images and mixed carousels** (X and Instagram): downloaded with gallery-dl. Posts with both photos and videos are "mixed".
- Extra choices for X and Instagram posts: **Images only** and **Everything** (every file of the post, original quality). Video-only posts keep using yt-dlp.

### Where multi-file posts are saved

- A post with exactly one file is saved directly in the download folder as `<Site> <postid>.<ext>`.
- A post with several files gets its own subfolder, `<download folder>\<Site> <postid or user>\`, with files named `01.ext`, `02.ext`, and so on.
- Removing an item with "delete file" removes every file of the item, and the subfolder too if LinkGrab created it and it is empty.

## Features

- Queue with pause, resume, cancel and remove (pause keeps partial files, resume continues them)
- Quality picker: best, 1080p, 720p, 480p, 360p or audio only, plus Images and Everything for image and carousel posts
- Parallel downloads with a configurable limit, optional speed limit
- Status filters (All / Downloading / Completed / Failed), media filters (Images / Videos), progress, speed and ETA per item
- Drag and drop links, clipboard-link suggestion, dark theme, works offline apart from downloading
- Queue is saved between runs

## Get the .exe

### Option A: build on your own Windows PC

1. Install Node.js 20 or newer (LTS) from https://nodejs.org.
2. Double-click `scripts\build-windows.bat` (or run `powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1`).
3. When it finishes, the `dist` folder opens with:
   - `dist\LinkGrab-Setup-<version>.exe` (installer)
   - `dist\LinkGrab-Portable-<version>.exe` (no install, run anywhere)

The first build downloads Electron and NSIS, so it needs internet and can take a few minutes.

### Option B: GitHub Actions

1. Push this project to a GitHub repository (commit `package-lock.json` too).
2. Either open the Actions tab, pick "Build Windows" and click "Run workflow", or push a tag such as `v1.1.0`.
3. Download the `LinkGrab-windows` artifact from the finished run. For tag pushes the `.exe` files are also attached to a GitHub Release.

## Run from source

```
npm install
npm start
```

Run the tests with `npm test` (Node 20+; test files are named `*.test.js`).

## First run: engine install

LinkGrab does not bundle its engines. On first launch a banner says the engine is missing; click **Install engine**. The app downloads all three into its own data folder:

- `yt-dlp.exe` (from the yt-dlp GitHub releases) for videos
- ffmpeg (from the yt-dlp FFmpeg-Builds project) to merge video and audio for higher qualities
- `gallery-dl.exe` (from the gallery-dl GitHub releases) for images and carousels

If only gallery-dl fails to install, video downloads still work and the app tells you; image downloads then ask you to install the engine again. Use **Update engine** to refresh yt-dlp and gallery-dl.

## Usage

1. Click **Add URL** (or paste or drag a link into the window; a link in the clipboard is suggested automatically).
2. LinkGrab fetches the title and thumbnail; choose a quality and confirm.
3. Watch progress in the table. Use Pause, Resume, Cancel, Remove, or open the file or its folder when finished.

Files go to `Downloads\LinkGrab` by default; change this in Settings.

## Settings

- Download folder, maximum simultaneous downloads, optional speed limit
- **Use browser cookies**: pick the browser (Chrome, Edge or Firefox) whose profile is signed in to the site, and LinkGrab passes it to yt-dlp and gallery-dl as `--cookies-from-browser`. Cookies stay on your PC and are only handed to the local engines; LinkGrab never uploads or stores them. Close the browser first if cookies cannot be read.
  - Instagram nearly always needs a logged-in browser.
  - X sometimes needs one (age-restricted, protected or rate-limited posts).
  - Facebook and LinkedIn posts that are private or login-only need it too.

## Troubleshooting

- **SmartScreen says "Windows protected your PC"**: the exe is unsigned. Click **More info**, then **Run anyway**.
- **Antivirus flags or deletes the exe, yt-dlp.exe or gallery-dl.exe**: this is a common false positive for unsigned Electron apps and for standalone engine binaries. Add an exclusion for the LinkGrab install folder and the engine folder if you trust your build.
- **A download suddenly fails**: platforms change often. Use **Update engine** to get the latest yt-dlp and gallery-dl.
- **"Login required" or private post errors**: enable Settings > Use browser cookies and make sure you are signed in to that site in the chosen browser.
- **Private accounts**: posts are only available if the signed-in account follows or can view them.
- **Rate limits or "try again later"**: wait a while, avoid many parallel downloads (lower the limit in Settings), and keep cookies enabled; X and Instagram throttle anonymous and heavy traffic.
- **"Image downloads need the image engine"**: click Install engine to add gallery-dl.
- **Video and audio not merged / only low quality**: ffmpeg is missing; run the engine install again.
- **Build fails on Windows**: check internet access, delete `node_modules` and `dist`, and run the build script again.

## Legal note

Only download content you own or have permission to download, and respect the terms of service of each site and applicable copyright law. You are responsible for how you use this tool.

## Test checklist (verify on your machine)

Basics
- [ ] Installer runs (after the SmartScreen prompt) and a LinkGrab shortcut appears; portable exe also starts
- [ ] Engine banner appears on first run; Install completes and shows yt-dlp, ffmpeg and gallery-dl versions
- [ ] A public YouTube link: fetch preview, download at 720, file plays
- [ ] Audio-only download produces an audio file
- [ ] Pause then Resume continues rather than restarting
- [ ] Cancel removes the partial file
- [ ] A public Facebook video link downloads (or shows a clear message)
- [ ] An unsupported link (e.g. example.com) is rejected with an error
- [ ] Closing and reopening the app keeps the list

X and Instagram (v1.1)
- [ ] One public X video post: preview shows video qualities, download plays
- [ ] One public X image post: quality shows "Images (N)", file saved as `X <id>.<ext>` (or a numbered subfolder for several images)
- [ ] One Instagram reel while logged in (cookies enabled): downloads and plays
- [ ] One Instagram carousel while logged in: preview shows several thumbnails, Images/Everything options appear, a subfolder with `01.ext, 02.ext, ...` is created
- [ ] Instagram link with cookies disabled shows the "enable browser cookies" hint; with cookies enabled it works
- [ ] Remove with "delete file" on a carousel removes all files and the empty subfolder
- [ ] Open file and Show in folder work for a multi-file item

## Rebuilding the icon

`python3 scripts/make-icon.py` (needs Pillow) regenerates `build/icon.png` and `build/icon.ico`.
