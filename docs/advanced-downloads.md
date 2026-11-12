# Advanced downloads

Open `/advanced` in DropSilo. Unlock it with your operator key, paste a source, and choose **Auto detect** or a specific tool. The public downloader stays on its existing path.

For local development, run the backend from `backend` with `HOST=127.0.0.1`. The Advanced API reads `backend/.local/advanced.key` if present. Use a random key of at least 32 characters. For other listeners set `ADVANCED_API_KEY_FILE` to a private file or supply `ADVANCED_API_KEY` through your deployment's secret configuration. The frontend keeps the supplied key in memory. Provider credentials belong in backend files, not the frontend form.

| Tool | Input | Setup |
| --- | --- | --- |
| [RipMe](https://github.com/RipMeApp/ripme) | Supported album or gallery URL | Install Java and place `ripme.jar` in `backend/bin/advanced` or set `RIPME_JAR_PATH`. |
| [GNU Wget](https://www.gnu.org/software/wget/) / [HTTrack](https://www.httrack.com/html/cmdguide.html) | An explicitly selected HTTP(S) site to mirror | Set `WGET_PATH` / `HTTRACK_PATH` if not installed in `bin/advanced` or on PATH. The archive is limited to the source host. |
| [coursera-dl](https://github.com/coursera-dl/coursera-dl) | Coursera URL or course slug | Install in the course Python environment. `COURSERA_CAUTH_FILE` points to the file containing the account's CAUTH value. |
| [Udemy Downloader](https://github.com/Puyodead1/udemy-downloader) | Udemy course URL | The original GUI repository is unavailable. The replacement CLI uses `UDEMY_BEARER_FILE` and an account enrolled in the course. Device files and browser profiles are not loaded. |
| Course routing | Coursera or Udemy URL | Replaces the unavailable `curs-dl` repository by dispatching to the corresponding CLI. |
| [streamrip](https://github.com/nathom/streamrip) | SoundCloud, Bandcamp, Tidal, Deezer, or Qobuz URL | Install `rip`. Supply `STREAMRIP_CONFIG_PATH` for authenticated sources. The job uses a private copy. Public single tracks can fall back to yt-dlp if streamrip fails. |
| [OpenAudible](https://openaudible.org/docs) | Exported filename, ASIN, or Audible URL | Export audio with the desktop application and point `OPENAUDIBLE_EXPORT_DIR` at those files. An ASIN must appear as a separate token in the export filename. |
| LibGen mirrors | Selected book MD5 hash or URL containing it | DropSilo downloads from a mirror and checks the complete file against the requested hash before serving it. |
| [Anna’s Archive CLI/MCP](https://github.com/SokolskyNikita/annas-mcp) | Selected archive MD5 hash or book URL | Install the CLI and set `ANNAS_SECRET_KEY_FILE` to the membership key file. DropSilo uses the noninteractive CLI mode. |
| [Sci-Hub CLI](https://github.com/zaytoun/scihub.py) | DOI, PMID, or recognized link | Install upstream dependencies and set `SCIHUB_SCRIPT_PATH` and `SCIHUB_BASE_URL` as needed. DropSilo uses the upstream client with a configured mirror and certificate validation. |
| [SpotDL](https://github.com/spotDL/spotify-downloader) | Spotify track, album, or playlist URL | Install `spotdl` and FFmpeg. If SpotDL stalls on a single track, DropSilo can download a public YouTube result that matches its title, artist, and duration. The job reports the worker used. |

On Windows the packaged binaries are discoverable under `backend/bin/advanced`. The default course Python location is `backend/bin/advanced-python`; install `coursera-dl==0.11.5`, `setuptools` (for distutils compatibility), the Udemy CLI, and the Sci-Hub requirements in that environment. The default streamrip environment is `backend/bin/streamrip-python`; use Python 3.11 with `streamrip==2.1.0` so its Pillow dependency has a supported wheel. Set `COURSE_PYTHON_PATH`, `SCIHUB_PYTHON_PATH`, or `STREAMRIP_PATH` for different installations.

The Advanced API:

- `GET /api/advanced/engines`: local installation and account setup status. This does not probe providers.
- `POST /api/advanced/jobs`: `{"input":"https://example.com/","engine":"wget"}`. Omit `engine` for auto routing; mirror tools require an explicit selection.
- `GET /api/advanced/jobs/:id`: job status; `DELETE` cancels an active job.
- `GET /api/advanced/jobs/:id/file`: fetch the resulting file or ZIP after the job is ready.

Every request uses the `X-Advanced-Key` header. Jobs run two at a time in private work directories. Files are retained for ten minutes. The advanced queue runs in one backend process; use that same instance for job creation, status, and file retrieval. Mirrors use a separate same-host egress guard, shallow depth, and transfer and time limits. Other adapters have bounded output; install the tools under an isolated OS account and apply network egress rules for deployments where operators are not fully trusted.
