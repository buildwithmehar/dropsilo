import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { CONFIG } from '../config';
import { ADVANCED_ENGINES, selectAdvancedEngine, type EngineName } from '../services/advanced-input';
import { engineReadiness, listAdvancedEngines } from '../services/advanced-engines';
import { AdvancedJobs } from '../services/advanced-jobs';

const uuid = '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
const jobIdSchema = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuid } } } };
const hash = (value: string) => createHash('sha256').update(value).digest();
const err = (code: string, message: string) => ({ status: 'error', code, message });

function configuredKey(): string | undefined {
  if (process.env.ADVANCED_API_KEY) return process.env.ADVANCED_API_KEY;
  const file = process.env.ADVANCED_API_KEY_FILE || (CONFIG.IS_DEV && ['127.0.0.1', 'localhost', '::1'].includes(CONFIG.HOST)
    ? path.join(process.cwd(), '.local', 'advanced.key') : '');
  try { if (file && fs.statSync(file).size < 1024) return fs.readFileSync(file, 'utf8').trim(); } catch {}
}

export async function advancedRoute(app: FastifyInstance, options: FastifyPluginOptions & { key?: () => string | undefined }) {
  const jobs = new AdvancedJobs();
  app.addHook('onClose', async () => jobs.close());
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const key = (options.key || configuredKey)();
    if (!key || key.length < 32) {
      return reply.code(503).send(err('ADVANCED_DISABLED', 'The operator has not enabled advanced downloads.'));
    }
    const supplied = request.headers['x-advanced-key'];
    if (typeof supplied !== 'string' || supplied.length > 256 || !timingSafeEqual(hash(supplied), hash(key))) {
      return reply.code(401).send(err('ADVANCED_KEY_REQUIRED', 'Enter the advanced download key.'));
    }
  });

  app.get('/engines', async () => ({ engines: listAdvancedEngines() }));

  app.post<{ Body: { input: string; engine?: EngineName | 'auto' } }>('/jobs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['input'],
      properties: { input: { type: 'string', minLength: 1, maxLength: 2048 },
        engine: { type: 'string', enum: ['auto', ...ADVANCED_ENGINES] } } } },
  }, async (request, reply) => {
    let selected;
    try { selected = selectAdvancedEngine(request.body.input, request.body.engine); }
    catch (error) {
      return reply.code(400).send(err('INVALID_SOURCE', error instanceof Error ? error.message : 'Invalid source.'));
    }
    const missing = engineReadiness(selected);
    if (missing) return reply.code(503).send(err('ENGINE_SETUP_REQUIRED', missing));
    const job = jobs.submit(selected);
    if (!job) return reply.code(429).send(err('ADVANCED_QUEUE_FULL', 'The advanced queue is full. Try again later.'));
    return reply.code(202).send(job);
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', { schema: jobIdSchema }, async (request, reply) =>
    jobs.summary(request.params.id) ?? reply.code(404).send(err('JOB_NOT_FOUND', 'This job has expired or does not exist.')));

  app.delete<{ Params: { id: string } }>('/jobs/:id', { schema: jobIdSchema }, async (request, reply) =>
    jobs.cancel(request.params.id) ? { status: 'cancelled' } : reply.code(409).send(err('JOB_NOT_ACTIVE', 'This job is not running.')));

  app.get<{ Params: { id: string } }>('/jobs/:id/file', { schema: jobIdSchema }, async (request, reply) => {
    const artifact = jobs.artifact(request.params.id);
    if (!artifact) return reply.code(404).send(err('FILE_NOT_AVAILABLE', 'This download is not ready or has expired.'));
    let handle;
    try { handle = await fs.promises.open(artifact.path, 'r'); }
    catch { return reply.code(404).send(err('FILE_NOT_AVAILABLE', 'This download is no longer available.')); }
    return reply.type(artifact.mime).header('X-Content-Type-Options', 'nosniff')
      .header('Content-Length', artifact.bytes)
      .header('Content-Disposition', `attachment; filename="${artifact.filename.replace(/[^\w .-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`)
      .send(handle.createReadStream());
  });
}
