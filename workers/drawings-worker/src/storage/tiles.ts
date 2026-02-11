import type { SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type TilesStorageProvider = 'r2';
const R2_BUCKET = process.env.R2_BUCKET ?? 'project-files';
const R2_PREFIX = 'drawings-tiles';
const R2_REGION = process.env.R2_REGION ?? 'auto';
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === 'true';

let cachedR2Client: S3Client | null = null;

function getProvider(): TilesStorageProvider {
  const raw = process.env.DRAWINGS_TILES_STORAGE ?? 'r2';
  if (raw.toLowerCase() !== 'r2') {
    throw new Error('DRAWINGS_TILES_STORAGE must be set to r2.');
  }
  return 'r2';
}

function isDebugEnabled() {
  return process.env.DRAWINGS_TILES_DEBUG === 'true';
}

function debugLog(message: string, meta?: Record<string, any>) {
  if (!isDebugEnabled()) return;
  if (meta) {
    console.log(`[tiles] ${message}`, meta);
  } else {
    console.log(`[tiles] ${message}`);
  }
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function normalizeKey(path: string): string {
  const normalized = normalizePath(path);
  return `${R2_PREFIX}/${normalized}`;
}

function getR2Client(): S3Client {
  if (cachedR2Client) return cachedR2Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint =
    process.env.R2_ENDPOINT ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 credentials or endpoint');
  }

  cachedR2Client = new S3Client({
    region: R2_REGION,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: R2_FORCE_PATH_STYLE,
  });

  return cachedR2Client;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (stream instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (stream?.arrayBuffer) {
    const ab = await stream.arrayBuffer();
    return Buffer.from(ab);
  }

  return Buffer.from(stream ?? []);
}

export function buildTilesBaseUrl(basePath: string): string {
  const override =
    process.env.DRAWINGS_TILES_BASE_URL ?? process.env.NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL;
  getProvider();
  if (override) {
    debugLog('Using override tiles base URL', { provider: 'r2', baseUrl: override });
    return `${override.replace(/\/$/, '')}/${normalizePath(basePath)}`;
  }
  throw new Error('Missing DRAWINGS_TILES_BASE_URL or NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL');
}

export async function uploadTileObject(params: {
  supabase: SupabaseClient;
  path: string;
  bytes: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  const { supabase: _supabase, path, bytes, contentType } = params;
  const cacheControl = params.cacheControl ?? 'public, max-age=31536000, immutable';
  getProvider();
  const key = normalizeKey(path);

  debugLog('Uploading tile object', { provider: 'r2', key, contentType });

  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
}

export async function downloadTileObject(params: {
  supabase: SupabaseClient;
  path: string;
}): Promise<Buffer> {
  const { supabase: _supabase, path } = params;
  getProvider();
  const key = normalizeKey(path);

  debugLog('Downloading tile object', { provider: 'r2', key });

  const client = getR2Client();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    })
  );
  if (!result.Body) {
    throw new Error(`Failed to download tile object: empty body for ${key}`);
  }
  return streamToBuffer(result.Body);
}

export async function deleteTileObjects(params: {
  supabase: SupabaseClient;
  paths: string[];
}): Promise<void> {
  const { supabase: _supabase, paths } = params;
  getProvider();
  const keys = paths.map(normalizeKey);

  debugLog('Deleting tile objects', { provider: 'r2', count: keys.length });

  const client = getR2Client();
  await client.send(
    new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    })
  );
}
