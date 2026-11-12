// File storage: club and league logos, covers and story photos (public), and certificates and
// rules documents (private, streamed through the API to people allowed to see them).
//
// STORAGE_DRIVER=local (the default) writes to STORAGE_DIR on this machine's disk: fine for one
// server with a disk that survives deploys. STORAGE_DRIVER=s3 writes to any S3-compatible store
// (Cloudflare R2, AWS S3, Backblaze B2, DigitalOcean Spaces), which several servers can share.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** A URL for public files (logos, story photos). Private files are streamed through the API instead. */
  publicUrl(key: string): string;
}

/** Anyone may load these by URL. Everything else (certificates/, rules/) is private. */
const PUBLIC_PREFIXES = ['logos/', 'stories/'];
export const isPublicKey = (key: string) => PUBLIC_PREFIXES.some((p) => key.startsWith(p));

const root = path.resolve(process.env.STORAGE_DIR ?? './uploads');

export const localStorage: Storage = {
  async put(key, data) {
    const file = path.join(root, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  },
  get: (key) => readFile(path.join(root, key)),
  publicUrl: (key) => `${process.env.PUBLIC_URL ?? 'http://localhost:4000'}/files/${key}`,
};

/**
 * S3-compatible storage. Public files go to S3_BUCKET, served from STORAGE_PUBLIC_URL (the
 * bucket's public address or a CDN in front of it). Private files go to S3_PRIVATE_BUCKET, which
 * should not be public; without one they share S3_BUCKET under keys nobody can guess.
 */
function s3Storage(): Storage {
  const bucket = process.env.S3_BUCKET!;
  const privateBucket = process.env.S3_PRIVATE_BUCKET || bucket;
  const publicBase = (process.env.STORAGE_PUBLIC_URL ?? '').replace(/\/$/, '');
  // Loaded when first used, so development never needs the AWS SDK.
  let client: Promise<{ send: (cmd: unknown) => Promise<unknown>; Put: new (i: object) => unknown; Get: new (i: object) => unknown }> | undefined;
  const s3 = () =>
    (client ??= import('@aws-sdk/client-s3').then(({ S3Client, PutObjectCommand, GetObjectCommand }) => {
      const c = new S3Client({
        region: process.env.S3_REGION || 'auto',
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: !!process.env.S3_ENDPOINT,
        credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
      });
      return { send: (cmd: unknown) => c.send(cmd as never), Put: PutObjectCommand as never, Get: GetObjectCommand as never };
    }));
  return {
    async put(key, data, contentType) {
      const { send, Put } = await s3();
      await send(
        new Put({
          Bucket: isPublicKey(key) ? bucket : privateBucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          // Public files never change under the same key (each upload gets a new one), so caches may keep them.
          CacheControl: isPublicKey(key) ? 'public, max-age=31536000, immutable' : 'private, no-store',
        }),
      );
    },
    async get(key) {
      const { send, Get } = await s3();
      const r = (await send(new Get({ Bucket: isPublicKey(key) ? bucket : privateBucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!r.Body) throw new Error(`Empty file: ${key}`);
      return Buffer.from(await r.Body.transformToByteArray());
    },
    publicUrl: (key) => `${publicBase}/${key}`,
  };
}

export const storageDriver = process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
export const storage: Storage = storageDriver === 's3' ? s3Storage() : localStorage;
export const storageRoot = root;
