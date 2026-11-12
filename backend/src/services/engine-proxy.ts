import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { assertPublicUrl } from '../utils/sanitizer';
import { fetchCdnStream } from './proxy.service';

/**
 * Per-command loopback proxy for tools that follow manifests or redirects.
 * Pin public DNS results for both HTTP and HTTPS (CONNECT), and close every
 * socket when the command ends. This is an egress guard, not a process sandbox.
 */
export async function openEngineProxy(signal: AbortSignal, byteLimit: number, options: { allowedHost?: string } = {}) {
  const allowedHost = options.allowedHost?.toLowerCase();
  const hostAllowed = (host: string) => !allowedHost || host.toLowerCase() === allowedHost;
  const sockets = new Set<net.Socket>();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let transferred = 0;
  const count = (chunk: Buffer) => {
    transferred += chunk.length;
    if (transferred > byteLimit) controller.abort(new Error('Download exceeded its transfer limit.'));
  };
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!req.url?.startsWith('http://') || !['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405).end();
        return;
      }
      let target: URL;
      try { target = new URL(req.url); }
      catch { res.writeHead(400).end(); return; }
      if (!hostAllowed(target.hostname)) { res.writeHead(403).end(); return; }
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (typeof val === 'string' && /^(accept(-encoding|-language)?|range|user-agent|referer|origin|cookie|authorization)$/i.test(key)) headers[key] = val;
      }
      try {
        const upstream = await fetchCdnStream(req.url, headers, 1, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET', signal: combined, followRedirects: false,
        });
        const out = { ...upstream.headers };
        delete out.connection;
        delete out['transfer-encoding'];
        upstream.stream.on('data', count);
        res.writeHead(upstream.statusCode, out);
        pipeline(upstream.stream, res, () => {});
      } catch { res.writeHead(502).end(); }
    })();
  });
  server.on('connection', track);
  server.on('connect', (req, socket: net.Socket, head) => {
    void (async () => {
      const authority = req.url || '';
      if (!/^(\[[\da-f:.]+\]|[\w.-]+):443$/i.test(authority)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (!hostAllowed(authority.slice(0, -4))) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const check = await assertPublicUrl('https://' + authority);
      if (!check.isValid || combined.aborted || socket.destroyed) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const remote = net.connect(443, check.resolvedIp);
      track(remote);
      remote.setTimeout(30_000, () => remote.destroy());
      remote.once('close', () => socket.destroy());
      socket.once('close', () => remote.destroy());
      remote.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        remote.on('data', count);
        socket.pipe(remote).pipe(socket);
      });
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  const close = () => {
    combined.removeEventListener('abort', close);
    if (server.listening) server.close();
    for (const socket of sockets) socket.destroy();
  };
  combined.addEventListener('abort', close, { once: true });
  if (combined.aborted) close();
  return { url: 'http://127.0.0.1:' + port, close, signal: combined };
}
