/**
 * Fastify JSON-schema definitions for input validation.
 *
 * Every schema is intentionally permissive on optional fields (we re-validate
 * at the route handler level for type-shape concerns that JSON Schema can't
 * express, e.g. `format.trim.start` must be a valid HH:MMSS or seconds string).
 */

const URL_FIELD = { type: 'string', minLength: 1, maxLength: 2048 };
const FORMAT_ID_FIELD = { type: 'string', maxLength: 256, pattern: '^[a-zA-Z0-9_+-]+$' };
const TIME_STAMP_OR_SECONDS_FIELD = {
  type: 'string',
  maxLength: 16,
  pattern: '^(\\d{1,2}:\\d{2}(:\\d{2})?(\\.\\d+)?|\\d+(\\.\\d+)?)$',
};
const FILENAME_TEMPLATE_FIELD = {
  type: 'string',
  maxLength: 100,
  pattern: '^(?![-\\s])[a-zA-Z0-9 _\\-\\.]{1,100}$',
};

export const extractSchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: {
      url: URL_FIELD,
    },
  },
};

export const proxyStreamSchema = {
  querystring: {
    type: 'object',
    required: ['url'],
    properties: {
      url: URL_FIELD,
    },
  },
};

/** Legacy GET /api/download/start querystring (kept for backwards compat). */
export const downloadStartSchema = {
  querystring: {
    type: 'object',
    required: ['url'],
    properties: {
      url: URL_FIELD,
      height: { type: 'string' },
      fps: { type: 'string' },
      format_id: FORMAT_ID_FIELD,
      type: { type: 'string', enum: ['video', 'audio'] },
      audioFormat: { type: 'string', enum: ['mp3', 'm4a', 'flac', 'wav', 'aac', 'opus'] },
      title: { type: 'string' },
      duration: { type: 'string' },
    },
  },
};

/** New canonical POST /api/download body. */
export const downloadCreateSchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: {
      url: URL_FIELD,
      cancellable: { type: 'boolean' },
      format: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['video', 'audio', 'original'] },
          height: { type: 'number', minimum: 144, maximum: 4320 },
          fps: { type: 'number', minimum: 24, maximum: 120 },
          format_id: FORMAT_ID_FIELD,
          container: { type: 'string', enum: ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'flac', 'wav', 'aac', 'opus'] },
          audioFormat: { type: 'string', enum: ['mp3', 'm4a', 'flac', 'wav', 'aac', 'opus'] },
          vcodec: { type: 'string', enum: ['avc1', 'vp9', 'av1', 'h264', 'hevc'] },
          hdr: { type: 'boolean' },
          subtitles: { type: 'boolean' },
          subtitleLangs: {
            type: 'array',
            items: {
              type: 'string',
              pattern: '^[a-z]{2}(-[A-Z]{2})?$',
              maxLength: 10,
            },
            maxItems: 10,
          },
          thumbnail: { type: 'boolean' },
          trim: {
            type: 'object',
            properties: {
              start: TIME_STAMP_OR_SECONDS_FIELD,
              end: TIME_STAMP_OR_SECONDS_FIELD,
            },
          },
          filenameTemplate: FILENAME_TEMPLATE_FIELD,
        },
      },
      meta: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 300 },
          duration: { type: 'number', minimum: 0 },
        },
      },
    },
  },
};

export const downloadProgressSchema = {
  querystring: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', minLength: 1 },
      // Optional: Last-Event-ID for SSE resume. The client sends the last
      // event ID it received; the server replays events from index N+1.
      lastEventId: { type: 'string' },
      // Optional: download token for /download/file. For /progress it is
      // not required — progress is observable by anyone with the jobId,
      // but the actual file stream is gated.
    },
  },
};

export const downloadFileSchema = {
  querystring: {
    type: 'object',
    required: ['jobId', 'token'],
    properties: {
      jobId: { type: 'string', minLength: 1 },
      token: { type: 'string', minLength: 1 },
    },
  },
};

export const downloadCancelSchema = {
  body: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', minLength: 1 },
    },
  },
};

export const playlistDownloadSchema = {
  body: {
    type: 'object',
    required: ['url'],
    properties: {
      url: URL_FIELD,
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url'],
          properties: {
            url: URL_FIELD,
            title: { type: 'string' },
          },
        },
      },
      format: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['video', 'audio'] },
          container: { type: 'string', enum: ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'flac', 'wav', 'aac', 'opus'] },
          audioFormat: { type: 'string', enum: ['mp3', 'm4a', 'flac', 'wav', 'aac', 'opus'] },
          format_id: FORMAT_ID_FIELD,
        },
      },
    },
  },
};
