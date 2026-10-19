# LinkGrab IPC channels (owned by CORE)

Request/response: preload uses `ipcRenderer.invoke(channel, ...args)`; main registers with `ipcMain.handle`.
Return values are exactly as in design/CONTRACT-v1.0.md (every handler resolves, never rejects; failures are `{ ok:false, error }`).

| window.api method        | channel                  | args                       | resolves with                          |
|--------------------------|--------------------------|----------------------------|----------------------------------------|
| getInfo(url)             | api:getInfo              | url                        | { ok, info? , error? }                 |
| add(url, quality)        | api:add                  | url, quality               | { ok, item? , error? }                 |
| list()                   | api:list                 | -                          | item[]                                 |
| pause(id)                | api:pause                | id                         | { ok, error? }                         |
| resume(id)               | api:resume               | id                         | { ok, error? }                         |
| cancel(id)               | api:cancel               | id                         | { ok, error? }                         |
| remove(id, deleteFile)   | api:remove               | id, deleteFile (boolean)   | { ok, error? }                         |
| openFile(id)             | api:openFile             | id                         | { ok, error? }                         |
| showInFolder(id)         | api:showInFolder         | id                         | { ok, error? }                         |
| getSettings()            | api:getSettings          | -                          | settings                               |
| setSettings(partial)     | api:setSettings          | partial object             | settings (merged)                      |
| chooseFolder()           | api:chooseFolder         | -                          | string or null                         |
| engineStatus()           | api:engineStatus         | -                          | { ytdlp:{installed,version,path}, ffmpeg:{installed,path} } |
| installEngine()          | api:installEngine        | -                          | { ok, error? }                         |
| updateEngine()           | api:updateEngine         | -                          | { ok, version?, error? }               |
| readClipboardUrl()       | api:readClipboardUrl     | -                          | string or null                         |

Events (main -> renderer via `webContents.send`; preload wraps `ipcRenderer.on` and returns an unsubscribe fn):

| window.api method        | channel        | payload                                           |
|--------------------------|----------------|---------------------------------------------------|
| onUpdate(cb)             | evt:update     | item (full download item shape)                   |
| onRemoved(cb)            | evt:removed    | id (string)                                       |
| onEngineProgress(cb)     | evt:engine     | { stage:'ytdlp'\|'ffmpeg', percent, message }     |

Note: the `ipcRenderer.on` listener receives `(event, payload)`; the cb should get only `payload`.

Settings shape: { downloadDir, maxConcurrent (1-10), speedLimit ('' or e.g. '2M', '500K'), cookiesFrom ('' or 'chrome'|'firefox'|'edge'|'brave'|'opera'|'vivaldi'|'safari'|'chromium') }

## Behaviour notes for the UI
- Item fields: `speed` is 0 and `eta` is null when unknown; `size` is 0 until yt-dlp reports it; `filePath` and `error` are null when unset; `thumbnail` may be ''. `error` is a friendly, user-readable string.
- `percent` has one decimal. For video+audio downloads the two streams are summed, so percent can dip once when the second stream starts.
- status 'merging' covers ffmpeg merge/audio extraction. Update events for one item are throttled to ~4/s except on status changes.
- `resume(id)` also restarts items in status 'paused', 'error' (retry) and 'canceled' (start over). `pause(id)` works on queued items too.
- `cancel(id)` deletes partial files and leaves the row with status 'canceled'. `remove(id, true)` deletes the finished file (or the partials for unfinished items); `remove(id, false)` only drops the row.
- `showInFolder(id)` reveals the finished file; with no id (or an unfinished item) it opens the download folder, so the toolbar "Open folder" button can call `showInFolder()`.
- `openFile` refuses executable file types (returns ok:false with a message).
- `add` returns `{ok:false,error}` when yt-dlp is not installed yet (error text points to the setup banner) or the link duplicates an active download.
- `getInfo` results are cached for 10 minutes and reused by `add`, so the list shows the real title immediately.
- `installEngine()` resolves `{ok:true, note?}`; on Linux/macOS `note` says ffmpeg must come from the package manager. Progress arrives on `evt:engine` with stage 'ytdlp' then 'ffmpeg' (percent 0-100 per stage).
- getInfo `qualities` only contains heights that exist (keys: best, 1080, 720, 480, 360, audio). Sites that report no heights yield just best + audio.
- Settings: `speedLimit` accepts e.g. '500K', '2M'; invalid values are ignored by setSettings (the returned object shows what was kept).

## v1.1 info/item fields

Added for X / Instagram image support (gallery-dl). Channels and `window.api` method names are unchanged; only payload fields grow. Old data without the new fields keeps working (defaults in brackets).

`getInfo(url)` -> `info` gains:
- `kind` : `'video'` | `'image'` | `'mixed'` [video]
- `videoCount`, `imageCount`, `fileCount` : numbers (`fileCount` = videoCount + imageCount)
- `engine` : `'yt-dlp'` | `'gallery-dl'` | `'both'`
- `thumbnails` : up to 6 image URLs (carousel preview); `thumbnail` stays the single best one
- `qualities` depends on `kind`:
  - video -> the usual `best/1080/720/480/360/audio` entries
  - image -> `[{key:'images', label:'Images (N)'}]` (default pick = first entry)
  - mixed -> `[{key:'media', label:'Everything (N files)'}, {key:'images', label:'Images only (N)'}, ...video qualities, audio]`; if yt-dlp could not read the post only the first two are offered
  - `'images'` / `'media'` are only valid for X, Instagram (and the test hook); other sites are rejected with an error.
- `needsGallerydl: true` (optional) : the video was read by yt-dlp but gallery-dl is not installed, so images in the post (if any) are unknown. A failed lookup of an image-only post returns `{ ok:false, error:'Image downloads need the image engine. Click Install engine in the banner.', needsGallerydl:true }`.

Download item (`list()`, `onUpdate`) gains:
- `kind` : `'video'` | `'image'` | `'mixed'` [video]
- `fileCount` : number of files in the post, 0 until known [1 for completed old items]
- `files` : string[] of absolute paths finished so far (capped at 200) [[] or `[filePath]`]
- `folder` : directory that contains the files, or null [dirname(filePath)]
- `filePath` is still the first file.

On-disk layout written by gallery-dl: exactly one file -> directly in the download folder as `<Site> <postid>.<ext>` (e.g. `X 1790000000000000000.jpg`); more than one file -> subfolder `<download folder>/<Site> <postid or user>/` holding `01.<ext>`, `02.<ext>`, ... (e.g. `Instagram CxYz123/01.jpg`). Names are restricted to Windows-safe characters.

Runner events (queue side): `{type:'progress', percent, downloaded, size:null, speed, eta}` and `{type:'files', files, folder, fileCount}` after every finished (or already present) file. Final result: `{code, signal, killed, error, filePath, stderr, files, folder, fileCount}`.
