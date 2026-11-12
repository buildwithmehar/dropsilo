import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { CONFIG } from '../config';
import { tempDirBytes, tempDirFiles } from './metrics.service';
import { isPathInsideDir } from '../utils/sanitizer';

/**
 * Pluggable Storage Adapter interface.
 */
export interface StorageAdapter {
  readonly driverName: 'local' | 's3';
  saveFile(key: string, localFilePath: string): Promise<string>;
  getFileStream(keyOrPath: string): Promise<Readable>;
  deleteFile(keyOrPath: string): Promise<void>;
  hasSpaceFor(bytes: number): boolean;
  runGc?(): { deletedFiles: number; freedBytes: number };
  refreshMetrics?(): void;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly driverName = 'local' as const;

  constructor(private tempDir: string = CONFIG.TEMP_DIR) {
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private resolveSafePath(keyOrPath: string): string {
    const fullPath = path.isAbsolute(keyOrPath) ? keyOrPath : path.resolve(this.tempDir, keyOrPath);
    if (!isPathInsideDir(this.tempDir, fullPath)) {
      throw new Error(`Access denied: path traversal restricted for '${keyOrPath}'.`);
    }
    return fullPath;
  }

  async saveFile(key: string, localFilePath: string): Promise<string> {
    const dest = this.resolveSafePath(key);
    if (localFilePath !== dest && fs.existsSync(localFilePath)) {
      fs.copyFileSync(localFilePath, dest);
    }
    return dest;
  }

  async getFileStream(keyOrPath: string): Promise<Readable> {
    const fullPath = this.resolveSafePath(keyOrPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Local file not found: ${fullPath}`);
    }
    return fs.createReadStream(fullPath);
  }

  async deleteFile(keyOrPath: string): Promise<void> {
    try {
      const fullPath = this.resolveSafePath(keyOrPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch {}
  }

  hasSpaceFor(bytes: number): boolean {
    const reservedBytes = CONFIG.DISK_RESERVED_MB * 1024 * 1024;
    try {
      const stat: any = (fs as any).statfsSync(this.tempDir);
      const freeBytes = stat.bavail * stat.bsize;
      return freeBytes >= bytes + reservedBytes;
    } catch {
      return true;
    }
  }

  runGc(): { deletedFiles: number; freedBytes: number } {
    let deletedFiles = 0;
    let freedBytes = 0;
    const now = Date.now();

    let entries: Array<{ name: string; fullPath: string; mtime: number; size: number }>;

    try {
      const names = fs.readdirSync(this.tempDir);
      entries = names
        .map((name) => {
          const fullPath = path.join(this.tempDir, name);
          try {
            const stat = fs.statSync(fullPath);
            return { name, fullPath, mtime: stat.mtimeMs, size: stat.size };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    } catch {
      return { deletedFiles, freedBytes };
    }

    for (const e of entries) {
      if (now - e.mtime > CONFIG.TEMP_FILE_MAX_AGE_MS) {
        try {
          fs.unlinkSync(e.fullPath);
          deletedFiles++;
          freedBytes += e.size;
        } catch {}
      }
    }

    entries = entries.filter((e) => fs.existsSync(e.fullPath));
    entries.sort((a, b) => a.mtime - b.mtime);

    let totalSize = entries.reduce((sum, e) => sum + e.size, 0);

    for (const e of entries) {
      if (totalSize <= CONFIG.TEMP_DIR_MAX_BYTES) break;
      try {
        fs.unlinkSync(e.fullPath);
        deletedFiles++;
        freedBytes += e.size;
        totalSize -= e.size;
      } catch {}
    }

    return { deletedFiles, freedBytes };
  }

  refreshMetrics(): void {
    try {
      const names = fs.readdirSync(this.tempDir);
      let totalBytes = 0;
      let count = 0;
      for (const name of names) {
        try {
          const stat = fs.statSync(path.join(this.tempDir, name));
          totalBytes += stat.size;
          count++;
        } catch {}
      }
      tempDirBytes.set(totalBytes);
      tempDirFiles.set(count);
    } catch {
      tempDirBytes.set(0);
      tempDirFiles.set(0);
    }
  }
}

export class S3StorageAdapter implements StorageAdapter {
  readonly driverName = 's3' as const;
  private s3Client: any;
  private bucket: string;

  constructor() {
    this.bucket = CONFIG.AWS_S3_BUCKET;
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      this.s3Client = new S3Client({
        region: CONFIG.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: CONFIG.AWS_ACCESS_KEY_ID,
          secretAccessKey: CONFIG.AWS_SECRET_ACCESS_KEY,
        },
        endpoint: CONFIG.AWS_S3_ENDPOINT || undefined,
        forcePathStyle: CONFIG.AWS_S3_FORCE_PATH_STYLE,
      });
    } catch {
      this.s3Client = null;
    }
  }

  async saveFile(key: string, localFilePath: string): Promise<string> {
    if (!this.s3Client) throw new Error('@aws-sdk/client-s3 package is missing or not installed.');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const fileStream = fs.createReadStream(localFilePath);
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileStream,
      })
    );
    if (fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
      } catch {}
    }
    return key;
  }

  async getFileStream(keyOrPath: string): Promise<Readable> {
    if (!this.s3Client) throw new Error('@aws-sdk/client-s3 package is missing or not installed.');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const key = path.basename(keyOrPath);
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
    if (!response.Body) {
      throw new Error(`S3 key ${key} returned empty body.`);
    }
    return response.Body as Readable;
  }

  async deleteFile(keyOrPath: string): Promise<void> {
    if (!this.s3Client) return;
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const key = path.basename(keyOrPath);
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  hasSpaceFor(_bytes: number): boolean {
    return true; // Cloud storage handles high scale
  }

  runGc(): { deletedFiles: number; freedBytes: number } {
    return { deletedFiles: 0, freedBytes: 0 };
  }

  refreshMetrics(): void {}
}

let gcTimer: NodeJS.Timeout | undefined;
let metricsTimer: NodeJS.Timeout | undefined;

export class StorageService {
  private adapter: StorageAdapter;

  constructor() {
    if (CONFIG.STORAGE_DRIVER === 's3') {
      this.adapter = new S3StorageAdapter();
    } else {
      this.adapter = new LocalStorageAdapter();
    }
  }

  get driverName(): 'local' | 's3' {
    return this.adapter.driverName;
  }

  hasSpaceFor(bytes: number): boolean {
    return this.adapter.hasSpaceFor(bytes);
  }

  async saveFile(key: string, localFilePath: string): Promise<string> {
    return this.adapter.saveFile(key, localFilePath);
  }

  async getFileStream(keyOrPath: string): Promise<Readable> {
    return this.adapter.getFileStream(keyOrPath);
  }

  async deleteFile(keyOrPath: string): Promise<void> {
    return this.adapter.deleteFile(keyOrPath);
  }

  runGc(): { deletedFiles: number; freedBytes: number } {
    return this.adapter.runGc ? this.adapter.runGc() : { deletedFiles: 0, freedBytes: 0 };
  }

  unlinkIfExists(filePath: string): void {
    this.adapter.deleteFile(filePath).catch(() => {});
  }

  refreshMetrics(): void {
    if (this.adapter.refreshMetrics) {
      this.adapter.refreshMetrics();
    }
  }

  startGcTimer(): void {
    if (gcTimer) clearInterval(gcTimer);
    if (metricsTimer) clearInterval(metricsTimer);

    gcTimer = setInterval(() => {
      try {
        this.runGc();
      } catch {}
    }, CONFIG.CLEANUP_INTERVAL_MS);
    gcTimer.unref?.();

    metricsTimer = setInterval(() => {
      try {
        this.refreshMetrics();
      } catch {}
    }, 30 * 1000);
    metricsTimer.unref?.();

    setImmediate(() => {
      this.runGc();
      this.refreshMetrics();
    });
  }

  stopGcTimer(): void {
    if (gcTimer) {
      clearInterval(gcTimer);
      gcTimer = undefined;
    }
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = undefined;
    }
  }
}

export const storageService = new StorageService();
