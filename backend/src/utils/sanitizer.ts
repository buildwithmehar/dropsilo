import { URL } from 'url';
import dns from 'dns/promises';
import net from 'net';
import path from 'path';

/**
 * Returns true if targetPath is strictly inside parentDir.
 * Protects against path traversal attacks (e.g. "../", absolute path overrides).
 */
export function isPathInsideDir(parentDir: string, targetPath: string): boolean {
  const absoluteParent = path.resolve(parentDir);
  const absoluteTarget = path.resolve(parentDir, targetPath);
  return absoluteTarget === absoluteParent || absoluteTarget.startsWith(absoluteParent + path.sep);
}

/**
 * Returns true if the IP string is private, loopback, link-local, multicast,
 * cloud metadata, or otherwise unsafe to fetch from a server-side context.
 *
 * Handles IPv4 literals, IPv4-mapped IPv6 (::ffff:1.2.3.4), and IPv6 loopback.
 */
export function isPrivateIp(ip: string): boolean {
  let normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv6(normalized) && !normalized.includes('%')) {
    normalized = new URL('http://[' + normalized + ']').hostname.slice(1, -1);
  }
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const a = parseInt(mapped[1], 16);
    const b = parseInt(mapped[2], 16);
    return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.'));
  }

  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '127.0.0.1'
  ) {
    return true;
  }

  // AWS / cloud metadata endpoint
  if (normalized === '169.254.169.254' || normalized.startsWith('169.254.')) {
    return true;
  }

  // IPv4 dotted quad
  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    const [a, b, c] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224 || a === 198 && (b === 18 || b === 19)) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return true;
  }

  // IPv6
  if (net.isIPv6(normalized)) {
    if (!/^[23]/.test(normalized) || normalized.includes('%')) return true;
    if (/^(2001:(db8|0):|2002:|3fff:)/.test(normalized)) return true;
  }

  return false;
}

export type AssertPublicUrlOk = { isValid: true; sanitizedUrl: string; ips: string[]; resolvedIp: string };
export type AssertPublicUrlErr = { isValid: false; error: string };
export type AssertPublicUrlResult = AssertPublicUrlOk | AssertPublicUrlErr;

export async function assertPublicUrl(inputUrl: string): Promise<AssertPublicUrlResult> {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { isValid: false, error: 'URL is required.' };
  }

  const trimmed = inputUrl.trim();
  if (trimmed.length > 2048) {
    return { isValid: false, error: 'URL length exceeds limit.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { isValid: false, error: 'Invalid URL format.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { isValid: false, error: 'Only HTTP and HTTPS protocols are supported.' };
  }

  if (parsed.username || parsed.password || parsed.port) {
    return { isValid: false, error: 'Use a web URL without embedded credentials or a custom port.' };
  }
  parsed.hash = '';
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // If hostname is already a literal IP, check it directly without DNS.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { isValid: false, error: 'Access to private or local network resources is restricted.' };
    }
    return { isValid: true, sanitizedUrl: parsed.toString(), ips: [hostname], resolvedIp: hostname };
  }

  // Callers opening a socket should pin the connection to a validated address.
  let addresses: string[];
  try {
    const lookup = await dns.lookup(hostname, { all: true });
    addresses = lookup.map((a) => a.address);
  } catch {
    return { isValid: false, error: 'Unable to resolve hostname.' };
  }

  if (addresses.length === 0) {
    return { isValid: false, error: 'Hostname did not resolve to any address.' };
  }

  const anyPrivate = addresses.some((ip) => isPrivateIp(ip));

  if (anyPrivate) {
    return { isValid: false, error: 'Access to private or local network resources is restricted.' };
  }

  return { isValid: true, sanitizedUrl: parsed.toString(), ips: addresses, resolvedIp: addresses[0] };
}

export type ValidateUrlOk = { isValid: true; sanitizedUrl: string };
export type ValidateUrlErr = { isValid: false; error: string };
export type ValidateUrlResult = ValidateUrlOk | ValidateUrlErr;

/**
 * Backwards-compatible synchronous wrapper. Only validates URL shape and
 * literal-IP hostnames. **Callers that can await should use `assertPublicUrl`
 * instead**, which performs the actual DNS resolution.
 *
 * Kept here so existing code that calls validateAndSanitizeUrl() continues to
 * compile while we migrate every caller to the async variant.
 */
export function validateAndSanitizeUrl(inputUrl: string): ValidateUrlResult {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { isValid: false, error: 'URL is required.' };
  }

  const trimmed = inputUrl.trim();
  if (trimmed.length > 2048) {
    return { isValid: false, error: 'URL length exceeds limit.' };
  }

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { isValid: false, error: 'Only HTTP and HTTPS protocols are supported.' };
    }
    const hostname = parsed.hostname.toLowerCase();
    if (net.isIP(hostname) && isPrivateIp(hostname)) {
      return { isValid: false, error: 'Access to private or local network resources is restricted.' };
    }
    return { isValid: true, sanitizedUrl: parsed.toString() };
  } catch {
    return { isValid: false, error: 'Invalid URL format.' };
  }
}

/**
 * Sanitizes filenames to prevent path traversal and header corruption.
 * (Unchanged from the original implementation — it was already solid.)
 */
export function sanitizeFilename(filename: string, fallback = 'media'): string {
  if (!filename || typeof filename !== 'string') return fallback;

  let sanitized = filename
    .replace(/[\x00-\x1F\x7F/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  sanitized = sanitized.replace(/\.\./g, '_');

  return sanitized.length > 0 ? sanitized.substring(0, 150) : fallback;
}
