import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import webSocket from '@fastify/websocket';
import os from 'os';
import fs from 'fs';
import * as crypto from 'crypto';
import { CONFIG } from './config';
import { extractRoute } from './routes/extract';
import { downloadRoute } from './routes/download';
import { playlistRoute } from './routes/playlist';
import { jobQueueService } from './services/jobQueue.service';
import { getYtDlpPath, getFfmpegPath, getAria2cPath } from './services/ytdl.service';
import { getGalleryEnginePath, getNMediaPath, getStreamlinkPath } from './services/source-engines';
import { advancedRoute } from './routes/advanced';
import { attachRequestId, getRateLimitKey, requireApiKey } from './utils/auth';
import { metricsRegistry, metricsText } from './services/metrics.service';
import { storageService } from './services/storage.service';
import { startYtDlpAutoUpdateWorker, stopYtDlpAutoUpdateWorker } from './services/ytdlUpdateWorker';
import { ErrorCode } from './utils/errors';

const server = Fastify({
  logger: CONFIG.IS_DEV
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }
    : true,
  trustProxy: CONFIG.TRUSTED_PROXIES,
  // Custom request-id generator — used for log correlation across the
  // entire request lifecycle. Falls back to X-Request-Id header if present.
  genReqId: (req) => {
    const hdr = (req.headers['x-request-id'] as string) || '';
    return hdr && /^[a-zA-Z0-9_-]{4,64}$/.test(hdr) ? hdr : 'req_' + crypto.randomBytes(4).toString('hex');
  },
});

async function bootstrap() {
  // ── Security headers ──────────────────────────────────────────────────────
  await server.register(helmet, {
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false, // frontend sets its own CSP
  });

  // ── CORS — configurable allowlist ─────────────────────────────────────────
  await server.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin / no-origin (curl, server-to-server) unconditionally.
      if (!origin) return cb(null, true);
      if (
        CONFIG.IS_DEV ||
        CONFIG.ALLOWED_ORIGINS.includes('*') ||
        CONFIG.ALLOWED_ORIGINS.includes(origin)
      ) {
        return cb(null, true);
      }
      // Check for configured domain matches (including wildcard subdomains)
      const isAllowed = CONFIG.ALLOWED_ORIGINS.some((allowed) => {
        if (allowed === origin) return true;
        if (allowed.startsWith('*.')) {
          const domain = allowed.slice(2);
          return origin.endsWith('.' + domain) || origin === `https://${domain}` || origin === `http://${domain}`;
        }
        return false;
      });
      if (isAllowed) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Advanced-Key', 'X-Request-Id', 'Range', 'Last-Event-ID'],
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'X-Request-Id', 'Content-Range'],
    credentials: true,
  });

  // ── Global rate limit (fallback bucket) ───────────────────────────────────
  // Per-route limits are layered on top via the `config.rateLimit` option
  // on individual route definitions below.
  await server.register(rateLimit, {
    global: true,
    max: CONFIG.RATE_LIMIT_GLOBAL,
    timeWindow: '1 minute',
    keyGenerator: getRateLimitKey,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      status: 'error',
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      retryable: true,
    }),
  });

  // ── WebSocket plugin (for /api/download/ws) ──────────────────────────────
  await server.register(webSocket, {
    options: {
      maxPayload: 8 * 1024, // WS messages are tiny (subscribe/cancel/ping)
    },
  });

  // ── Request-ID middleware ──────────────────────────────────────────────────
  server.addHook('onRequest', attachRequestId);

  // ── Schema validation error handler ─────────────────────────────────────────
  server.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.status(400).send({
        status: 'error',
        code: ErrorCode.INVALID_PARAMETER,
        message: `Invalid parameter: ${error.message}`,
        requestId: (request as any).id,
        retryable: false,
      });
    }
    return reply.status(error.statusCode || 500).send(error);
  });

  // ── Optional API-key auth ──────────────────────────────────────────────────
  if (CONFIG.API_KEYS.length > 0) {
    server.addHook('onRequest', (request, reply, done) => {
      if (request.routeOptions.url?.startsWith('/api/advanced/')) return done();
      return requireApiKey(request, reply, done);
    });
  }

  // ── Health endpoint ──────────────────────────────────────────────────────────
  server.get('/health', {
    config: {
      rateLimit: { max: CONFIG.RATE_LIMIT_HEALTH, timeWindow: '1 minute' },
    },
  }, async () => {
    const mem = process.memoryUsage();
    const ytDlpExists = fs.existsSync(getYtDlpPath());
    const ffmpegExists = fs.existsSync(getFfmpegPath());

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      queueDriver: CONFIG.QUEUE_DRIVER,
      system: {
        platform: process.platform,
        cpuCores: os.cpus().length,
        freeMemMB: Math.round(os.freemem() / (1024 * 1024)),
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
        rssMB: Math.round(mem.rss / (1024 * 1024)),
      },
      binaries: {
        ytDlpAvailable: ytDlpExists,
        ffmpegAvailable: ffmpegExists,
        aria2Available: !!getAria2cPath(),
        nm3u8dlAvailable: !!getNMediaPath(),
        streamlinkAvailable: !!getStreamlinkPath(),
        galleryDlAvailable: !!getGalleryEnginePath(),
      },
      features: {
        cookieFile: !!CONFIG.COOKIES_FILE_PATH && fs.existsSync(CONFIG.COOKIES_FILE_PATH),
        proxyRotation: CONFIG.PROXY_URLS.length,
        apiAuth: CONFIG.API_KEYS.length > 0,
      },
      queueStats: jobQueueService.getStats(),
    };
  });

  // ── Prometheus metrics ─────────────────────────────────────────────────────
  server.get('/metrics', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (_req, reply) => {
    // Refresh gauges right before scrape for accurate numbers.
    storageService.refreshMetrics();
    return reply
      .header('Content-Type', metricsRegistry.contentType)
      .send(await metricsText());
  });

  // ── API routes ─────────────────────────────────────────────────────────────
  // Per-route rate limits layered on top of the global limiter.
  await server.register(async (api) => {
    await api.register(extractRoute, { prefix: '/api' });
    await api.register(downloadRoute, { prefix: '/api' });
    await api.register(playlistRoute, { prefix: '/api' });
    await api.register(advancedRoute, { prefix: '/api/advanced' });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const gracefulShutdown = async (signal: string) => {
    server.log.info({ signal }, '[SHUTDOWN] Initiating graceful shutdown');
    try {
      stopYtDlpAutoUpdateWorker();
      await jobQueueService.shutdown();
      await server.close();
      server.log.info('[SHUTDOWN] Done.');
      process.exit(0);
    } catch (err) {
      server.log.error(err, '[SHUTDOWN] Error during close');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // ── Start ──────────────────────────────────────────────────────────────────
  try {
    await server.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
    startYtDlpAutoUpdateWorker(server.log);
    console.log(`\n🚀 DropSilo backend v2 running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
    console.log(`   queue driver: ${CONFIG.QUEUE_DRIVER}`);
    console.log(`   max concurrent jobs: ${CONFIG.MAX_CONCURRENT_JOBS}`);
    console.log(`   proxy urls: ${CONFIG.PROXY_URLS.length}`);
    console.log(`   cookie file: ${CONFIG.COOKIES_FILE_PATH ? 'yes' : 'no'}`);
    console.log(`   api auth: ${CONFIG.API_KEYS.length > 0 ? 'on' : 'off'}`);
    console.log(`   health:    GET http://localhost:${CONFIG.PORT}/health`);
    console.log(`   metrics:   GET http://localhost:${CONFIG.PORT}/metrics`);
    console.log(`   extract:   POST http://localhost:${CONFIG.PORT}/api/extract`);
    console.log(`   download:  POST http://localhost:${CONFIG.PORT}/api/download\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap();
