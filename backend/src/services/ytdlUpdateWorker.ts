import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getYtDlpPath } from './ytdl.service';

const execFileAsync = promisify(execFile);
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let updateTimer: NodeJS.Timeout | undefined;

/** Verify SHA256 checksum of a file buffer against an expected hash string. */
export function verifySha256(data: Buffer, expectedHash: string): boolean {
  const actualHash = crypto.createHash('sha256').update(data).digest('hex').toLowerCase();
  return actualHash === expectedHash.trim().toLowerCase();
}

/** Check if a binary path or its parent directory is writable by the current process. */

function isWritablePath(filePath: string): boolean {
  try {
    const targetDir = fs.existsSync(filePath) ? path.dirname(filePath) : filePath;
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkAndUpgradeYtDlp(): Promise<string> {
  const binary = getYtDlpPath();

  if (!isWritablePath(binary)) {
    return `yt-dlp update check skipped: Binary path or directory "${binary}" is not writable by app user. (Ensure Dockerfile configures writable /app/bin owned by app user).`;
  }

  try {
    const { stdout, stderr } = await execFileAsync(binary, ['-U'], { timeout: 60000 });
    const output = (stdout || stderr || '').trim();
    return output || 'yt-dlp update check completed successfully.';
  } catch (err: any) {
    const errorMsg = (err?.stderr || err?.message || 'Unknown error').trim();
    return `yt-dlp update check warning: ${errorMsg}`;
  }
}

export function startYtDlpAutoUpdateWorker(logger?: { info: (msg: any, title?: string) => void; warn: (msg: any, title?: string) => void }): void {
  const runCheck = async () => {
    const result = await checkAndUpgradeYtDlp();
    if (logger) {
      logger.info({ result }, '[YTDLP AUTO-UPDATE] Periodic update check finished.');
    }
  };

  // Immediate check on startup (non-blocking)
  void runCheck();

  // Recurring 24-hour interval
  updateTimer = setInterval(() => {
    void runCheck();
  }, UPDATE_INTERVAL_MS);

  updateTimer.unref?.();
}

export function stopYtDlpAutoUpdateWorker(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = undefined;
  }
}
