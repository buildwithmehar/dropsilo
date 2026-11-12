# DropSilo download engines

Run the backend from the `backend` directory. `GET /health` reports which engines the server found.

| Engine | Use | Install |
| --- | --- | --- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) and [FFmpeg](https://ffmpeg.org/download.html) | Video sites, selected video quality and audio conversion | `bin/yt-dlp.exe` on Windows, or set `YTDLP_PATH`. The backend can use its bundled FFmpeg. |
| [aria2](https://github.com/aria2/aria2/releases) | Parallel HTTP transfers in yt-dlp | `bin/aria2c.exe` or `ARIA2C_PATH`. Default: 8 connections; set `ARIA2_CONNECTIONS` from 1 to 16. Speed depends on the source and range support. |
| [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE/releases) | Public HLS and DASH manifests | Extract the platform release into `bin/nm3u8dl/` or set `NM3U8DL_RE_PATH`. |
| [Streamlink](https://streamlink.github.io/) | Public Twitch/Kick live recordings and manifest fallback | Install into the Python environment below or set `STREAMLINK_PATH`. |
| [gallery-dl](https://github.com/mikf/gallery-dl) | Supported public photo galleries | Install into the Python environment below or set `GALLERY_DL_PATH`. |

Windows, from `backend`:

```powershell
python -m venv bin/python-engines
& ./bin/python-engines/Scripts/python.exe -m pip install "streamlink==8.6.3" "gallery-dl==1.32.19"
npm run dev
```

On Linux use `bin/python-engines/bin/python` and the matching N_m3u8DL-RE release.

- `POST /api/extract` with `{"url":"https://…"}` classifies the source. `original` describes files and streams that need no format picker. Existing video/audio results keep their quality lists. Gallery results contain the discovered images.
- `POST /api/download` with `{"url":"https://…","format":{"kind":"original"}}` queues a detected file or stream. Omit `format` to use automatic detection. Use the returned job ID and token with the existing progress and signed file endpoints. For image albums use `POST /api/gallery/download` with the returned images.
- Public file requests validate and pin every HTTP(S) hop. The manifest and gallery workers use a loopback egress guard for their HTTP(S) connections. Isolate downloader processes and enforce a network egress policy at deployment for untrusted traffic.
- Direct files and manifest transfers default to 512 MB. Twitch/Kick captures default to 60 seconds. Set `DIRECT_DOWNLOAD_MAX_MB` and `LIVE_RECORD_SECONDS` to adjust these limits. Gallery ZIPs are capped at 50 images and 128 MB.
- Direct PDF, EPUB and course attachment URLs can use the original file path. Public arXiv abstract links resolve to PDF; Project Gutenberg book links resolve to EPUB. Account-based tools and website mirroring are available separately through [Advanced downloads](../../docs/advanced-downloads.md).
