# Changelog

## 1.1.0

- Added X (x.com, twitter.com) and Instagram (posts, reels, `/p/`, `/tv/`) support.
- Added image and carousel downloads through a third engine, gallery-dl, installed alongside yt-dlp and ffmpeg by Install engine and refreshed by Update engine.
- New quality choices for X and Instagram posts: Images only and Everything (all files, original quality).
- Multi-image posts are saved in their own numbered subfolder (`01.ext`, `02.ext`, ...); single files go straight into the download folder.
- Preview shows the post kind (video, image, mixed), file counts and up to six carousel thumbnails.
- New "Images" and "Videos" filters (with counts) in the sidebar, plus a kind icon and file count on each download.
- Safer deletes: removing an item deletes only the files LinkGrab downloaded, and its folder only when LinkGrab created it and it is empty. Open file still refuses executables.
- Friendlier login and rate-limit errors for X and Instagram that point to Settings > Use browser cookies.
- Older saved queues from 1.0.0 load unchanged.

## 1.0.0

- First release: desktop download manager for YouTube, Facebook and LinkedIn videos, powered by yt-dlp and ffmpeg.
- Queue with pause, resume, cancel and remove; quality picker (best, 1080p, 720p, 480p, 360p, audio only).
- Parallel downloads with a configurable limit and optional speed limit.
- In-app engine install and update, optional browser cookies, drag and drop, clipboard suggestion, dark theme.
- Windows NSIS installer and portable exe, built locally or with GitHub Actions.
