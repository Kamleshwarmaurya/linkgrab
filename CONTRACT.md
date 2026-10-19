# LinkGrab - shared contract (all agents must follow this exactly)

Electron desktop app (IDM-style download manager) for YouTube, Facebook and LinkedIn video links, powered by the yt-dlp binary. Windows x64 is the target; code must also run on Linux for testing.
Project root: /home/claude/linkgrab. Plain CommonJS JavaScript, no bundler, no frameworks, no CDN/network assets in the UI (works offline).

## File ownership (do not edit files owned by another agent)
- Agent CORE owns: src/main/*.js, tests/*
- Agent UI owns: src/preload/preload.js, src/renderer/*
- Agent BUILD owns: package.json, build/*, scripts/*, .github/*, README.md, .gitignore

## Layout
- src/main/main.js      Electron entry: window, IPC handlers, wires queue + engine + settings
- src/main/engine.js    locate/install yt-dlp and ffmpeg into app userData/bin (Windows: yt-dlp.exe from GitHub releases `yt-dlp/yt-dlp` latest, ffmpeg from `yt-dlp/FFmpeg-Builds` win64 gpl zip; Linux: yt-dlp binary). Honour env LINKGRAB_YTDLP / LINKGRAB_FFMPEG overrides (absolute paths) for tests. Also update check.
- src/main/ytdlp.js     build args, spawn yt-dlp, parse `--progress-template` output, getInfo via `-J --no-playlist`
- src/main/queue.js     DownloadQueue (EventEmitter): add/start/pause/resume/cancel/remove, concurrency limit, persistence to userData/downloads.json
- src/main/settings.js  settings json in userData (downloadDir default = app.getPath('downloads')/LinkGrab, maxConcurrent=3, speedLimit='' , cookiesFrom='' e.g. 'chrome')
- src/main/sites.js     detectSite(url) -> 'youtube'|'facebook'|'linkedin'|null ; extractUrls(text) -> string[]
- src/preload/preload.js  contextBridge exposes `window.api` (contextIsolation true, nodeIntegration false)
- src/renderer/index.html, styles.css, app.js

## Download item shape (sent to the renderer)
{ id, url, site, title, thumbnail, status, percent (0-100), speed (bytes/s), eta (s), size (bytes), downloaded (bytes), filePath, error, quality, addedAt }
status in: 'queued' | 'fetching' | 'downloading' | 'paused' | 'merging' | 'completed' | 'error' | 'canceled'
quality in: 'best' | '1080' | '720' | '480' | '360' | 'audio'

## window.api (all return Promises unless noted)
- getInfo(url) -> { ok:true, info:{ title, thumbnail, duration, uploader, site, qualities:[{key,label}] } } | { ok:false, error }
- add(url, quality) -> { ok:true, item } | { ok:false, error }     (adds and starts when a slot is free)
- list() -> item[]
- pause(id), resume(id), cancel(id) -> { ok }
- remove(id, deleteFile:boolean) -> { ok }
- openFile(id), showInFolder(id) -> { ok }
- getSettings() -> settings ; setSettings(partial) -> settings ; chooseFolder() -> string|null
- engineStatus() -> { ytdlp:{installed,version,path}, ffmpeg:{installed,path} }
- installEngine() -> { ok, error? }   (emits engine progress)
- updateEngine() -> { ok, version?, error? }
- readClipboardUrl() -> string|null   (first supported URL found in clipboard text)
- Events (return an unsubscribe fn): onUpdate(cb(item)), onRemoved(cb(id)), onEngineProgress(cb({stage:'ytdlp'|'ffmpeg', percent, message}))

## Behaviour requirements
- Supported hosts: youtube.com, youtu.be, m.youtube.com, music.youtube.com, facebook.com, fb.watch, m.facebook.com, linkedin.com (posts/feed/videos). Reject anything else with a clear error. Never run a shell; spawn with an args array only; validate URL with `new URL` and require http(s).
- Pause = kill the process, keep .part files; resume = respawn with `--continue`. Cancel = kill + delete partial files.
- Private/login-only posts (common on Facebook/LinkedIn): the error text must suggest enabling Settings > "Use browser cookies" (maps to `--cookies-from-browser <name>`).
- Only for content the user is allowed to download; the UI footer shows a short note saying so.
- Dark theme default, clean IDM-like layout: top toolbar (Add URL, Pause, Resume, Cancel, Remove, Open folder, Settings), status sidebar filters (All / Downloading / Completed / Failed), main table (title, site, size, progress bar, speed, ETA, status), Add-URL modal with fetched preview and quality picker, settings modal, engine-setup banner when yt-dlp is missing, drag-and-drop of links, clipboard-link suggestion.
