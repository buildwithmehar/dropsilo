"""Keep streamrip's SoundCloud metadata and tagging with SoundCloud's AAC HLS."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

from streamrip.client.downloadable import Downloadable
from streamrip.client.soundcloud import SoundcloudClient
from streamrip.rip.cli import rip


AAC_MARKER = "easysave-aac:"
legacy_id = SoundcloudClient._get_custom_id
legacy_downloadable = SoundcloudClient.get_downloadable


def https_host(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("SoundCloud returned an invalid HTTPS URL.")
    return parsed.hostname or ""


def soundcloud_id(cls, track):
    if track.get("streamable") and track.get("policy") != "BLOCK" and not (
        track.get("downloadable") and track.get("has_downloads_left")
    ):
        for candidate in track.get("media", {}).get("transcodings", []):
            fmt = candidate.get("format", {})
            if (
                not candidate.get("snipped")
                and fmt.get("protocol") == "hls"
                and fmt.get("mime_type", "").split(";")[0] == "audio/mp4"
                and https_host(candidate.get("url", "")) == "api-v2.soundcloud.com"
            ):
                return f"{track['id']}|{AAC_MARKER}{candidate['url']}"
    return legacy_id(track)


class SoundcloudAAC(Downloadable):
    async def size(self):
        return 0

    async def _download(self, output, callback):
        args = [
            os.environ["EASYSAVE_STREAMRIP_FFMPEG"], "-hide_banner", "-loglevel", "error",
            "-nostdin", "-n", "-rw_timeout", "15000000", "-protocol_whitelist",
            "http,https,tcp,tls,crypto,httpproxy",
        ]
        proxy = os.environ.get("HTTPS_PROXY")
        if proxy:
            args.extend(["-http_proxy", proxy])
        args.extend(["-i", self.url, "-map", "0:a:0", "-c:a", "copy", "-movflags", "+faststart", output])
        await asyncio.to_thread(subprocess.run, args, timeout=120, check=True)
        callback(Path(output).stat().st_size)


async def soundcloud_downloadable(self, item_info, quality):
    _, _, link = item_info.partition("|")
    if not link.startswith(AAC_MARKER):
        return await legacy_downloadable(self, item_info, quality)
    result, status = await self._request(link.removeprefix(AAC_MARKER))
    manifest = result.get("url", "") if status == 200 else ""
    host = https_host(manifest)
    if not any(host == domain or host.endswith("." + domain) for domain in ("soundcloud.cloud", "sndcdn.com")):
        raise ValueError("SoundCloud returned an unexpected media host.")
    return SoundcloudAAC(self.session, manifest, "m4a", "soundcloud")


if __name__ == "__main__":
    SoundcloudClient._get_custom_id = classmethod(soundcloud_id)
    SoundcloudClient.get_downloadable = soundcloud_downloadable
    sys.argv[0] = "rip"
    rip()
