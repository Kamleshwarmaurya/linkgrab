# Architecture

LinkGrab is an Electron app. The renderer (UI) never touches the network or the disk; it talks to the main process through a small, fixed bridge (`window.api`). The main process validates every link, then drives two command-line engines as child processes.

```
 renderer (src/renderer)            main process (src/main)                      engines (child processes)
 ┌───────────────────┐  window.api  ┌────────────┐      ┌──────────────┐
 │ index.html        │─────────────▶│ api.js     │─────▶│ queue.js     │──┐
 │ app.js, styles.css│◀─────────────│ (IPC)      │      │ (downloads)  │  │   ┌────────────┐   yt-dlp  (+ ffmpeg)
 └───────────────────┘  events      └─────┬──────┘      └──────────────┘  ├──▶│ router.js  │──▶ gallery-dl
        ▲ preload.js                      │ sites.js, settings.js, engine.js  │   └────────────┘
        │ (contextBridge)                 ▼                                   │
        └─────────────────────────  userData: settings.json, downloads.json, bin/
```

## Modules (`src/main`)

| File | Responsibility |
|---|---|
| `main.js` | App entry: single-instance lock, window, wiring, `--smoke-test` flag (starts the services without a window and prints `LINKGRAB_SMOKE_OK`). |
| `api.js` | Every `window.api` handler (`api:<method>` IPC channels). Validates input, applies per-site rules, caches link previews, refuses to open executable files. |
| `sites.js` | Link validation and site detection (YouTube, Facebook, LinkedIn, X, Instagram). Rejects look-alike hosts, non-http(s) links and links with embedded credentials. |
| `router.js` | Chooses the engine per request. Images and "everything" go to gallery-dl, videos to yt-dlp. For X and Instagram it asks both engines for metadata in parallel and merges the answers into one preview (`kind`: video / image / mixed). |
| `ytdlp.js` | Builds yt-dlp arguments, runs it, parses progress, maps errors to readable messages. Always passes `--ignore-config`. |
| `gallerydl.js` | Same for gallery-dl: lists the files of a post, downloads them, reports each finished file, lays them out on disk. Always passes `--config-ignore`. |
| `queue.js` | The download queue: concurrency limit, pause (kill, keep partial files), resume, cancel (kill, clean partial files), remove, persistence to `downloads.json`, safe deletion. |
| `engine.js` | Finds, installs and updates the engines in the app's data folder (`yt-dlp`, `ffmpeg`, `gallery-dl`) and reports their versions. |
| `zip.js` | Minimal zip reader used to unpack ffmpeg on Windows, with size limits and path checks. |
| `settings.js` | `settings.json`: download folder, concurrency, speed limit, browser for cookies. |

## One download, end to end

1. The user pastes a link. `api.getInfo` validates it with `sites.js`, then the router fetches metadata (yt-dlp `-J`, and gallery-dl `-j` for X and Instagram) and returns title, thumbnails, `kind`, counts and the available qualities.
2. The user picks a quality. `api.add` creates a queue item.
3. The queue starts it when a slot is free. The router sends `images` / `media` qualities to gallery-dl and everything else to yt-dlp.
4. The engine runs as a child process (arguments array, no shell). Progress lines are parsed into `progress` and `files` events, which the queue turns into item updates pushed to the renderer (`evt:update`).
5. Pause kills the process tree and keeps the partial files; resume starts the engine again and it continues or skips what exists.

## Files on disk

- Download folder (default `Downloads\LinkGrab`): one file directly, or a subfolder `<Site> <post id or user>\01.ext, 02.ext, …` for multi-file posts.
- App data folder: `settings.json`, `downloads.json` (the saved queue), `bin\` (the engines).

## Security decisions

- `contextIsolation` on, `nodeIntegration` off, renderer sandboxed, strict Content-Security-Policy, no `innerHTML` with data (all text is inserted with `textContent`).
- Engines are started with argument arrays only; the link always comes after `--`; the cookie browser name is checked against an allow-list; engines ignore user config files so a planted config cannot add options.
- Deleting files only touches paths that resolve inside the item's download folder or the configured download folder (symlinks and `..` are rejected). The saved queue is re-validated on load.
- "Open file" refuses executable and script file types.
- Engine downloads come only from GitHub release URLs, are verified by running `--version`, and are installed atomically.

## Tests

`npm test` runs about 185 tests with Node's built-in runner. The integration tests run the real yt-dlp and gallery-dl against a local web server; no test talks to YouTube, Facebook, LinkedIn, X or Instagram. The internal test hook `LINKGRAB_ALLOW_ANY_HOST=1` (used only by the tests, never set by the app) lets local URLs through the site check.

## Design history

`docs/design/` holds the contracts the modules were built against (v1.0, and the v1.1 extension for X, Instagram and images). `docs/IPC_CHANNELS.md` lists the bridge methods, IPC channels and item fields.
