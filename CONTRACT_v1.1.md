# LinkGrab v1.1 - extension contract: X (Twitter) + Instagram, videos AND images

Builds on CONTRACT.md (v1.0, still valid). The existing code in /home/claude/linkgrab is working (71 passing tests). Do not rewrite it; extend it. Run `cd /home/claude/linkgrab && node --test` before and after your changes.

## Product change
- New supported sites: **X** (x.com, twitter.com, mobile.twitter.com, www./mobile. subdomains) and **Instagram** (instagram.com, instagr.am, www.). Post/status URLs, reels, `/p/`, `/reel/`, `/tv/`, X `/<user>/status/<id>`. Keep YouTube/Facebook/LinkedIn exactly as they are.
- Videos from X/Instagram: yt-dlp (already installed engine).
- **Images** (and mixed posts / carousels): new second engine **gallery-dl** (https://github.com/mikf/gallery-dl). Windows: standalone `gallery-dl.exe` from https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe ; Linux standalone asset is `gallery-dl.bin`. For sandbox testing `pip install --break-system-packages gallery-dl` provides a `gallery-dl` on PATH.
- gallery-dl is only used for sites x and instagram (and the test hook). Video-only posts keep using yt-dlp.
- Instagram nearly always needs login; X often does. Friendly errors must say: enable Settings > Use browser cookies (maps to `--cookies-from-browser <name>` for both engines).

## New quality keys (in addition to best/1080/720/480/360/audio)
- `images`  : download only the image files of the post (gallery-dl)
- `media`   : download every file of the post, images and videos, original quality (gallery-dl)
`isValidQuality` must accept both. They are valid for any site that gallery-dl supports (x, instagram, test); for other sites the API must reject them with a clear error.

## getInfo result additions (`info` object)
`kind`: 'video' | 'image' | 'mixed' ; `videoCount`, `imageCount` (numbers) ; `engine`: 'yt-dlp' | 'gallery-dl' | 'both' ; `thumbnails`: up to 6 image URLs (carousel preview) ; `qualities` depends on kind:
- video  -> existing video qualities (+ audio)
- image  -> [{key:'images',label:'Images (N)'}]            (default pick for the UI = first entry)
- mixed  -> [{key:'media',label:'Everything (N files)'},{key:'images',label:'Images only (N)'}, ...video qualities, audio]
If gallery-dl is missing, getInfo still returns the yt-dlp result for video posts; for an image-only post it returns `{ok:false, error:'Image downloads need the image engine. Click Install engine in the banner.'}` and sets `info.needsGallerydl` only when partially known.
For x/instagram the router runs `yt-dlp -J --no-playlist` and `gallery-dl -j` (metadata only, no download) concurrently and merges: yt-dlp "no video"/"There is no video in this post" style failure + gallery-dl images => kind 'image'. Both succeed with videos and images => 'mixed'. Cookies are passed to both.

## Download item additions (renderer-visible item shape)
`kind` ('video'|'image'|'mixed'), `fileCount` (number, 0 until known), `files` (string[] absolute paths, capped to 200), `folder` (string|null, directory containing the files). `filePath` stays = first file. Existing fields unchanged. Old persisted items without the new fields must still load (defaults: kind 'video', fileCount 0 or 1 when completed, files [] or [filePath], folder = dirname(filePath)).
Layout on disk (gallery-dl): exactly 1 file -> directly in the download dir named `<Site> <postid>.<ext>` ; more than 1 file -> subfolder `<download dir>/<Site> <postid or user>/` with `01.ext, 02.ext, ...`. Windows-safe names only.

## Engine/runner interfaces (so the agents can work in parallel)
engine.js (owner SITES+ENGINE):
- `engine.getGallerydlPath()` -> string|null (sync; order: env LINKGRAB_GALLERYDL, userData/bin, PATH)
- `engine.status()` result gains `gallerydl: { installed, version, path }`
- `installEngine()` installs yt-dlp, ffmpeg (Windows) AND gallery-dl (Windows: gallery-dl.exe ; Linux: gallery-dl.bin saved as `gallery-dl`); failing to install gallery-dl must not make yt-dlp's install fail: return ok:true with `note` when only the image engine failed. `updateEngine()` also refreshes gallery-dl (re-download latest). Progress events use stage 'gallerydl'.
gallerydl.js (owner GALLERY): `createGalleryRunner({ getBinary, getFfmpeg })` returns `{ download(p, onEvent), getInfo(url, opts) }` with the SAME signatures and event/result shapes as `ytdlp.createRunner` (read src/main/ytdlp.js runDownload/parseLine for the shapes), plus: 
- progress events `{type:'progress', percent, downloaded, size, speed, eta}` (same as existing; if byte totals unknown derive percent from files done / total from a prior `-j` count)
- `{type:'files', files:[abs paths done so far], folder, fileCount}` after every finished file
- final result adds `files` and `folder`.
- pause = kill tree (reuse ytdlp.killTree); resume = re-run, gallery-dl skips files that exist (`--no-skip` NOT used); cancel (queue) deletes partial files.
- args: array only, no shell, URL last after `--` where gallery-dl supports it; `-D <dir>` / filename template as needed; `--cookies-from-browser`; `--limit-rate` if the p.limitRate is set; never pass user text as an option.
router.js (owner GALLERY): `createRouter({ ytdlp, gallery, getSiteOf })` -> `{ download, getInfo }`: `download` picks gallery for quality 'images'/'media', else ytdlp; `getInfo` merges as described. Test hook: when env LINKGRAB_ALLOW_ANY_HOST=1 and site is 'test', URLs ending in `/gallery.html` use gallery-dl with the `generic:` prefix (so tests can serve an HTML page of images from 127.0.0.1); other test URLs use yt-dlp as before.
queue/api/main wiring (owner INTEGRATION): `createServices` builds both runners + router and hands the router to DownloadQueue as before (`ytdlp` option name may stay). The queue persists/forwards the new item fields, handles `files` events and the new result fields; `remove(id,true)` deletes all `files` (and the folder if it becomes empty and was created by LinkGrab); `openFile` opens the first file (still refuses executables), `showInFolder` selects the first file/opens the folder. Settings unchanged. IPC channels and window.api methods unchanged (no preload change).

## File ownership (never edit another agent's files)
- SITES+ENGINE: src/main/sites.js, src/main/engine.js, tests/sites.test.js, tests/engine.test.js
- GALLERY: src/main/gallerydl.js (new), src/main/router.js (new), small additive edit allowed in src/main/ytdlp.js (QUALITIES/isValidQuality/friendlyError for the new keys and X/Instagram login hints ONLY), tests/gallerydl.test.js, tests/router.test.js, tests/integration-images.test.js (new)
- INTEGRATION: src/main/queue.js, src/main/api.js, src/main/main.js, src/main/settings.js, tests/queue.test.js, tests/main.test.js, tests/settings.test.js, tests/integration.test.js
- UI: src/renderer/*, src/preload/preload.js (only if strictly needed)
- DOCS: README.md, package.json (version 1.1.0, description), scripts/*, CONTRACT*.md and IPC_CHANNELS.md notes
Tests of one owner must not depend on unfinished code of another beyond the interfaces above: use small fakes. Final integration is verified by the lead afterwards.

## Sub-agents
Each agent may spawn its own sub-agents when the Agent tool is available to it (for example an independent test-writer or a reviewer of your own diff). Keep ownership rules for sub-agents too.

## Safety/Quality
No shell, args arrays only, validated http(s) URLs, never set LINKGRAB_ALLOW_ANY_HOST in app code. The sandbox network allowlist blocks YouTube/X/Instagram: real downloads cannot be tested here, so test through local HTTP servers and say so in your report. UI strings that list supported sites must mention YouTube, Facebook, LinkedIn, X and Instagram. Keep the footer note about downloading only content you have the right to save.
