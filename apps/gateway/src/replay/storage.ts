import { gunzipSync } from 'node:zlib';
import { getStorage } from 'firebase-admin/storage';

export interface ReplayStorage {
  upload(storagePath: string, data: Buffer): Promise<void>;
  getSignedUrl(storagePath: string, expiresInMs: number): Promise<string>;
}

export class InMemoryReplayStorage implements ReplayStorage {
  private files = new Map<string, Buffer>();

  async upload(storagePath: string, data: Buffer): Promise<void> {
    this.files.set(storagePath, data);
  }

  async getSignedUrl(storagePath: string, _expiresInMs: number): Promise<string> {
    if (!this.files.has(storagePath)) {
      throw new Error(`File not found in storage: ${storagePath}`);
    }
    return `https://storage.example.com/signed/${storagePath}?expires=mock`;
  }

  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /** Returns the decompressed JSONL text for a stored file (test helper). */
  getFileData(storagePath: string): string {
    const buf = this.files.get(storagePath);
    if (!buf) {
      throw new Error(`File not found: ${storagePath}`);
    }
    return gunzipSync(buf).toString('utf8');
  }
}

export class FirebaseReplayStorage implements ReplayStorage {
  private bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>;

  constructor(bucketName?: string) {
    this.bucket = getStorage().bucket(bucketName);
  }

  async upload(storagePath: string, data: Buffer): Promise<void> {
    const file = this.bucket.file(storagePath);
    await file.save(data, {
      contentType: 'application/gzip',
      metadata: { contentEncoding: 'gzip' },
    });
  }

  async getSignedUrl(storagePath: string, expiresInMs: number): Promise<string> {
    const file = this.bucket.file(storagePath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInMs,
    });
    return url;
  }
}
