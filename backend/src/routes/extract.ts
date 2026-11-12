import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { extractMediaInfo, expandPlaylistUrl } from '../services/ytdl-runner';
import { isGalleryUrl, extractGalleryInfo } from '../services/gallery.service';
import { isSpotifyUrl, getSpotifyInfo } from '../services/spotify.service';
import { isCobaltSupported, extractCobaltMediaInfo } from '../services/cobalt.service';
import { validateAndSanitizeUrl, assertPublicUrl } from '../utils/sanitizer';
import { extractSchema, proxyStreamSchema } from '../schemas';
import { ErrorCode, buildApiError, DEFAULT_MESSAGES, classifyYtDlpError } from '../utils/errors';
import { extractTotal, extractErrors, extractDuration } from '../services/metrics.service';
import { fetchCdnStream, PublicTargetError } from '../services/proxy.service';
import { verifyTurnstileToken } from '../utils/turnstile';
import { CONFIG } from '../config';
import { isLiveChannel, probeDirectSource, resolvePublicDocumentUrl } from '../services/source-discovery';
import { describeLiveSource, getNMediaPath, getStreamlinkPath, LiveSourceProbeError } from '../services/source-engines';

interface ExtractBody {
  url: string;
}

export async function extractRoute(fastify: FastifyInstance) {
  /**
   * POST /api/extract
   * Body: { url: string }
   */
  fastify.post<{ Body: ExtractBody }>(
    '/extract',
    { schema: extractSchema, preHandler: verifyTurnstileToken },
    async (request: FastifyRequest<{ Body: ExtractBody }>, reply: FastifyReply) => {
      const requestId = (request as any).id as string | undefined;
      const startTime = Date.now();
      const { url } = request.body || {};

      const ssrfCheck = await assertPublicUrl(url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }
      const sanitizedUrl = ssrfCheck.sanitizedUrl;

      fastify.log.info({ reqId: requestId, host: new URL(sanitizedUrl).hostname }, '[EXTRACT] requested');

      if (isLiveChannel(sanitizedUrl) && getStreamlinkPath()) {
        let live;
        try {
          live = await describeLiveSource(sanitizedUrl);
        } catch (error) {
          if (!(error instanceof LiveSourceProbeError)) throw error;
          return reply.status(502).send(buildApiError(ErrorCode.EXTRACTION_FAILED, error.message, { requestId }));
        }
        if (!live) {
          return reply.status(400).send(buildApiError(ErrorCode.VIDEO_UNAVAILABLE,
            'No public live stream is available on this channel right now.', { requestId }));
        }
        return reply.send({ status: 'success', url: sanitizedUrl, title: live.title, platform: live.platform,
          thumbnail: '', isLive: true, qualities: [], audioQualities: [],
          original: { category: 'stream', filename: live.filename, extension: 'mp4', recordSeconds: CONFIG.LIVE_RECORD_SECONDS } });
      }

      const host = new URL(sanitizedUrl).hostname;
      const knownMediaPage = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|spotify\.com|soundcloud\.com|x\.com|twitter\.com|vimeo\.com)$/.test(host);
      if (!knownMediaPage || /\.(m3u8|mpd|mp3|mp4|pdf|jpg|png|zip|epub)$/i.test(new URL(sanitizedUrl).pathname)) {
        const documentUrl = resolvePublicDocumentUrl(sanitizedUrl);
        const source = await probeDirectSource(documentUrl).catch((err: unknown) => err instanceof PublicTargetError ? err : null);
        if (source instanceof PublicTargetError) {
          return reply.status(400).send(buildApiError(ErrorCode.INVALID_URL, source.message, { requestId }));
        }
        if (source) {
          if (source.kind !== 'file' && !getNMediaPath() && !getStreamlinkPath()) {
            return reply.status(503).send(buildApiError(ErrorCode.EXTRACTION_FAILED,
              'This server does not have a downloader for this stream.', { requestId }));
          }
          const platform = documentUrl !== sanitizedUrl ? (host.endsWith('arxiv.org') ? 'arXiv' : 'Project Gutenberg')
            : source.kind === 'file' ? 'Direct link' : source.kind === 'hls' ? 'HLS stream' : 'DASH stream';
          extractTotal.inc({ platform });
          return reply.send({ status: 'success', url: documentUrl, title: source.filename, platform,
            thumbnail: '', qualities: [], audioQualities: [],
            original: source.kind === 'file' ? source : { category: 'stream', filename: source.filename, extension: 'mp4' } });
        }
      }

      // ── 1. Check if URL is an Image Gallery (Pinterest, Reddit, Imgur, Instagram Photos) ──
      if (isGalleryUrl(sanitizedUrl)) {
        try {
          const gallery = await extractGalleryInfo(sanitizedUrl);
          extractTotal.inc({ platform: gallery.platform || 'Gallery' });
          return reply.status(200).send({
            status: 'success',
            isGallery: true,
            qualities: [],
            audioQualities: [],
            ...gallery,
          });
        } catch (galleryErr: any) {
          fastify.log.warn({ reqId: requestId, err: galleryErr.message }, '[GALLERY EXTRACT] failed, falling back to standard extractor');
        }
      }

      // ── 2. Fast Path: Cobalt Engine (0 CPU load, 0.3s response for TikTok, IG, Twitter, YouTube) ──
      if (
        CONFIG.COBALT_ENABLED &&
        CONFIG.COBALT_API_URL &&
        isCobaltSupported(sanitizedUrl) &&
        !isSpotifyUrl(sanitizedUrl)
      ) {
        try {
          const cobaltStart = Date.now();
          const cobaltResult = await extractCobaltMediaInfo(sanitizedUrl);
          const elapsed = Date.now() - cobaltStart;
          fastify.log.info(
            { reqId: requestId, elapsedMs: elapsed, platform: cobaltResult.platform },
            '[COBALT EXTRACT] fast path success'
          );
          extractTotal.inc({ platform: cobaltResult.platform || 'Cobalt' });
          return reply.status(200).send({
            status: 'success',
            ...cobaltResult,
          });
        } catch (cobaltErr: any) {
          fastify.log.warn(
            { reqId: requestId, err: cobaltErr.message },
            '[COBALT EXTRACT] fast path skipped/failed, falling back to yt-dlp'
          );
        }
      }

      // ── 2. Standard Media Extractor (YouTube, Spotify, SoundCloud, TikTok, FB, etc.) ──
      try {
        const start = Date.now();
        const result = await extractMediaInfo(sanitizedUrl);
        const elapsed = Date.now() - start;

        fastify.log.info(
          { reqId: requestId, elapsedMs: elapsed, platform: result.platform, qualities: result.qualities.length },
          '[EXTRACT] success'
        );

        extractTotal.inc({ platform: result.platform || 'unknown' });
        extractDuration.observe({ platform: result.platform || 'unknown', cache: 'any' }, elapsed / 1000);

        return reply.status(200).send({
          status: 'success',
          ...result,
        });
      } catch (err: unknown) {
        // Social posts can be video or photos. Keep video extraction first on
        // mixed-media sites, then try the gallery extractor when it finds none.
        if (isGalleryUrl(sanitizedUrl, true) && !isGalleryUrl(sanitizedUrl)) {
          try {
            const gallery = await extractGalleryInfo(sanitizedUrl);
            extractTotal.inc({ platform: gallery.platform });
            return reply.send({ status: 'success', isGallery: true, qualities: [], audioQualities: [], ...gallery });
          } catch {}
        }
        const error = err as Error;
        fastify.log.error({ reqId: requestId, err: error.message }, '[EXTRACT] failed');

        const code = classifyYtDlpError(error.message);
        extractErrors.inc({ platform: 'unknown', code });

        return reply.status(400).send(
          buildApiError(code, DEFAULT_MESSAGES[code] || error.message, {
            requestId,
            detail: error.message,
          })
        );
      }
    }
  );

  /**
   * POST /api/playlist/expand
   * Body: { url: string }
   */
  fastify.post<{ Body: ExtractBody }>(
    '/playlist/expand',
    { schema: extractSchema, preHandler: verifyTurnstileToken },
    async (request: FastifyRequest<{ Body: ExtractBody }>, reply: FastifyReply) => {
      const requestId = (request as any).id as string | undefined;
      const { url } = request.body || {};

      const ssrfCheck = await assertPublicUrl(url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }

      // ── Spotify Playlist / Album Support ──
      if (isSpotifyUrl(ssrfCheck.sanitizedUrl)) {
        try {
          const spotifyInfo = await getSpotifyInfo(ssrfCheck.sanitizedUrl);
          if (spotifyInfo.trackList && spotifyInfo.trackList.length > 0) {
            return reply.status(200).send({
              status: 'success',
              playlistTitle: `${spotifyInfo.artist} - ${spotifyInfo.title}`,
              totalEntries: spotifyInfo.trackList.length,
              entries: spotifyInfo.trackList.map((t, idx) => ({
                id: t.id || `sp_${idx}`,
                title: `${t.artist} - ${t.title}`,
                url: t.url,
                duration: t.durationSec,
                thumbnail: spotifyInfo.coverUrl,
              })),
            });
          }
        } catch (spErr: any) {
          fastify.log.error({ reqId: requestId, err: spErr.message }, '[SPOTIFY PLAYLIST] Expand error');
        }
      }

      try {
        const result = await expandPlaylistUrl(ssrfCheck.sanitizedUrl);
        return reply.status(200).send({
          status: 'success',
          ...result,
        });
      } catch (err: any) {
        fastify.log.error({ reqId: requestId, err: err.message }, '[PLAYLIST EXPAND] failed');
        return reply.status(400).send(
          buildApiError(ErrorCode.EXTRACTION_FAILED, 'Failed to expand playlist URL.', {
            requestId,
            detail: err.message,
          })
        );
      }
    }
  );

  /**
   * GET /api/proxy-stream?url=...
   * Pass-through CDN stream proxy with SSRF validation (DNS-resolved) and
   * Range header support. Bot-protected to prevent open proxy relay abuse.
   */
  fastify.get<{ Querystring: { url: string } }>(
    '/proxy-stream',
    { schema: proxyStreamSchema, preHandler: verifyTurnstileToken },
    async (request: FastifyRequest<{ Querystring: { url: string } }>, reply: FastifyReply) => {
      const requestId = (request as any).id as string | undefined;
      const { url } = request.query || {};

      const ssrfCheck = await assertPublicUrl(url);
      if (!ssrfCheck.isValid) {
        return reply.status(400).send(
          buildApiError(ErrorCode.INVALID_URL, ssrfCheck.error, { requestId })
        );
      }
      const sanitizedUrl = ssrfCheck.sanitizedUrl;

      try {
        const incomingUserAgent = (request.headers['user-agent'] as string) || '';
        const reqHeaders: Record<string, string> = {
          'User-Agent':
            incomingUserAgent.length > 5
              ? incomingUserAgent
              : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          Referer: 'https://www.youtube.com/',
          Origin: 'https://www.youtube.com',
        };

        if (request.headers.range) {
          reqHeaders.Range = request.headers.range as string;
        }

        const { statusCode, headers, stream } = await fetchCdnStream(sanitizedUrl, reqHeaders);

        if (statusCode >= 400) {
          fastify.log.error({ reqId: requestId, statusCode }, '[PROXY STREAM] CDN error');
          return reply.status(statusCode).send(`CDN fetch failed (${statusCode})`);
        }

        const requestOrigin = request.headers.origin as string;
        if (requestOrigin && CONFIG.ALLOWED_ORIGINS.includes(requestOrigin)) {
          reply.header('Access-Control-Allow-Origin', requestOrigin);
        }
        reply.header('Access-Control-Allow-Headers', 'Range, Content-Type');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Type', headers['content-type'] || 'application/octet-stream');

        if (headers['content-length']) reply.header('Content-Length', headers['content-length']);
        if (headers['content-range']) {
          reply.header('Content-Range', headers['content-range']);
          reply.status(206);
        } else {
          reply.status(statusCode);
        }

        return reply.send(stream);
      } catch (err: any) {
        fastify.log.error({ reqId: requestId, err: err.message }, '[PROXY STREAM] exception');
        return reply.status(500).send(
          buildApiError(ErrorCode.INTERNAL, 'Stream proxy error.', { requestId, detail: err.message })
        );
      }
    }
  );
}
