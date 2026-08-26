# CLIPPER MVP

CLIPPER turns uploaded local video files into persistent MP4 clips. It uses:

- Node.js's built-in HTTP server and SQLite (`node:sqlite`)
- FFmpeg/FFprobe installed on the host machine
- `storage/` for persistent source videos, generated clips, and thumbnails
- `data/clipper.db` for projects, videos, candidates, jobs, and clips

## Run

```powershell
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Production configuration

The app has production-safe defaults for its local data, but its mutable paths can be moved to a persistent volume with environment variables:

```text
PORT=3000
CLIPPER_DATA_DIR=/data/database
CLIPPER_STORAGE_DIR=/data/storage
CLIPPER_LOG_DIR=/data/logs
# Optional: overrides the database file inside CLIPPER_DATA_DIR
CLIPPER_DATABASE_PATH=/data/database/clipper.db
```

`/health` returns `{"status":"ok"}` and is intended for the hosting platform's health check. The application listens on `0.0.0.0` in both local and container environments; locally, you still open it through `http://localhost:3000`.

The included Dockerfile uses Node 22 LTS and installs FFmpeg (which includes FFprobe). Its container defaults put the SQLite database, source videos, generated clips, thumbnails, and logs under `/data`, so a future Railway volume can persist them. No Railway account or service has been connected by this change.

## Local MP4 flow

1. Create a project and upload a real local MP4.
2. CLIPPER stores it, extracts metadata with FFprobe, then exposes **Run analysis**.
3. Analysis derives valid timestamp candidates from the video's actual duration.
4. Generate a candidate. FFmpeg creates an MP4 and JPEG thumbnail, then FFprobe validates the MP4 before it is recorded in SQLite.
5. Use the File Manager to play, seek, download, or delete the persisted clip.

The implementation is deliberately single-user for local development (`local-user`). It applies ownership checks against that local user on every project/video/clip lookup, so a multi-user authentication layer can replace that identity boundary later.

## Source URLs

Direct public HTTP(S) `.mp4` URLs are supported as a separate source adapter. YouTube URLs are recognized and rejected with a clear message: this MVP does not download YouTube videos, avoiding any attempt to bypass platform restrictions. Use a local MP4 to validate the processing pipeline.

## Persistence locations

Files follow this shape and persist across browser refreshes and server restarts:

```text
storage/users/local-user/projects/<project-id>/
  source/source.mp4
  clips/clip_001.mp4
  thumbnails/clip_001.jpg
```

The server streams video with HTTP Range support at the API endpoint used by the player. Downloads send the same persisted MP4 as an attachment.
