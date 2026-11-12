import IORedis from 'ioredis';
import { CONFIG } from '../config';

const memoryQuotaStore = new Map<string, { bytes: number; resetAt: number }>();

let redisClient: IORedis | null = null;

function getRedis(): IORedis | null {
  if (CONFIG.QUEUE_DRIVER === 'redis' && CONFIG.REDIS_URL) {
    if (!redisClient) {
      redisClient = new IORedis(CONFIG.REDIS_URL, { maxRetriesPerRequest: null });
    }
    return redisClient;
  }
  return null;
}

function getTodayKey(ip: string): string {
  const dateStr = new Date().toISOString().split('T')[0];
  const safeIp = ip.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `easysave:quota:${safeIp}:${dateStr}`;
}

export async function checkQuota(
  ip: string,
  additionalBytes = 0
): Promise<{ allowed: boolean; usedBytes: number; limitBytes: number }> {
  const limitBytes = CONFIG.DAILY_IP_BANDWIDTH_LIMIT_BYTES;
  const redis = getRedis();
  const key = getTodayKey(ip);

  if (redis) {
    try {
      const val = await redis.get(key);
      const usedBytes = val ? parseInt(val, 10) : 0;
      const allowed = usedBytes + additionalBytes <= limitBytes;
      return { allowed, usedBytes, limitBytes };
    } catch {
      // Fallback to allowed on redis failure
      return { allowed: true, usedBytes: 0, limitBytes };
    }
  }

  // Memory fallback
  const now = Date.now();
  const entry = memoryQuotaStore.get(key);
  if (!entry || now > entry.resetAt) {
    return { allowed: true, usedBytes: 0, limitBytes };
  }
  const allowed = entry.bytes + additionalBytes <= limitBytes;
  return { allowed, usedBytes: entry.bytes, limitBytes };
}

export async function recordBandwidth(ip: string, bytes: number): Promise<number> {
  if (bytes <= 0) return 0;
  const limitBytes = CONFIG.DAILY_IP_BANDWIDTH_LIMIT_BYTES;
  const redis = getRedis();
  const key = getTodayKey(ip);

  if (redis) {
    try {
      const newTotal = await redis.incrby(key, bytes);
      await redis.expire(key, 86400); // 24 hours TTL
      return newTotal;
    } catch {}
  }

  // Memory fallback
  const now = Date.now();
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 0);

  const entry = memoryQuotaStore.get(key);
  if (!entry || now > entry.resetAt) {
    const newTotal = bytes;
    memoryQuotaStore.set(key, { bytes: newTotal, resetAt: nextMidnight.getTime() });
    return newTotal;
  }
  entry.bytes += bytes;
  return entry.bytes;
}
