import https from 'https';
import http from 'http';
import net from 'net';
import { URL } from 'url';
import { assertPublicUrl } from '../utils/sanitizer';

export interface ProxyStreamResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
  finalUrl: string;
}

export class PublicTargetError extends Error {}

export async function fetchCdnStream(
  targetUrl: string,
  reqHeaders: Record<string, string>,
  maxRedirects = 5,
  options: { method?: 'GET' | 'HEAD'; signal?: AbortSignal; followRedirects?: boolean } = {}
): Promise<ProxyStreamResponse> {
  const check = await assertPublicUrl(targetUrl);
  if (!check.isValid) {
    throw new PublicTargetError(check.error || 'Invalid or prohibited target URL for stream proxy.');
  }
  const sanitizedUrl = check.sanitizedUrl;
  const pinnedIp = check.resolvedIp;

  if (maxRedirects <= 0) {
    throw new Error('Too many HTTP redirects encountered while proxying stream.');
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(sanitizedUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const customAgent = new (isHttps ? https.Agent : http.Agent)({
      lookup: (_hostname, lookupOptions, cb) => {
        const family = net.isIPv6(pinnedIp) ? 6 : 4;
        if (lookupOptions.all) cb(null, [{ address: pinnedIp, family }]);
        else cb(null, pinnedIp, family);
      },
    });

    const req = client.request(
      sanitizedUrl,
      {
        headers: { 'User-Agent': 'EasySave/2.0 (public file downloader)', ...reqHeaders },
        agent: customAgent,
        method: options.method || 'GET',
        signal: options.signal,
        timeout: 20000,
      },
      (res) => {
        // Handle HTTP redirects (301, 302, 303, 307, 308)
        if (options.followRedirects !== false && res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.destroy();
          let redirectUrl: string;
          try { redirectUrl = new URL(res.headers.location, sanitizedUrl).toString(); }
          catch (error) { reject(error); return; }
          // Recursively call fetchCdnStream which invokes assertPublicUrl on redirectUrl
          fetchCdnStream(redirectUrl, reqHeaders, maxRedirects - 1, options)
            .then(resolve)
            .catch(reject);
          return;
        }

        resolve({
          statusCode: res.statusCode || 200,
          headers: res.headers,
          stream: res,
          finalUrl: sanitizedUrl,
        });
      }
    );

    req.on('socket', (socket) => {
      socket.setNoDelay(true);
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy(new Error('CDN stream connection timed out.'));
    });
    req.end();
  });
}
