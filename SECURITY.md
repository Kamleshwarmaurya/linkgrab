# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security > Report a vulnerability** on this repository. Do not open a public issue for something exploitable. Include the version, steps to reproduce, and the impact.

## What is in scope

- Running unintended commands or reading/deleting files outside the download folder through crafted links, post titles, file names or a tampered `downloads.json`.
- Bypassing the "open file" executable check.
- Anything in the renderer that lets web content run code (it should be impossible; the page uses a strict CSP and only `textContent`).
- The engine installer fetching or running something other than yt-dlp, ffmpeg or gallery-dl.

## Known limitations (not vulnerabilities)

- The Windows builds are **unsigned**, so SmartScreen warns on first run.
- The engines are downloaded without a published checksum comparison. gallery-dl's stable releases no longer include a Windows binary, so the installer falls back to the gallery-dl project's own daily builds (`gdl-org/builds`). If you want a pinned engine, install it yourself and point the app at it with the `LINKGRAB_YTDLP`, `LINKGRAB_FFMPEG` and `LINKGRAB_GALLERYDL` environment variables.
- Browser cookies, when you enable them in Settings, are read by the engines on your PC to sign in to the site. LinkGrab does not upload them.
