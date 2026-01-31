import type { SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type TilesStorageProvider = 'supabase' | 'r2';

const SUPABASE_BUCKET = process.env.DRAWINGS_TILES_SUPABASE_BUCKET ?? 'drawings-tiles';
const R2_BUCKET = process.env.R2_BUCKET ?? 'project-files';
const R2_PREFIX = 'drawings-tiles';
const R2_REGION = process.env.R2_REGION ?? 'auto';
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === 'true';

let cachedR2Client: S3Client | null = null;

function getProvider(): TilesStorageProvider {
  const raw = process.env.DRAWINGS_TILES_STORAGE ?? 'supabase';
  return raw.toLowerCase() === 'r2' ? 'r2' : 'supabase';
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
  return getProvider() === 'r2' ? `${R2_PREFIX}/${normalized}` : normalized;
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
  const provider = getProvider();
  if (provider === 'r2' && !override) {
    throw new Error('Missing DRAWINGS_TILES_BASE_URL for R2 storage');
  }
  if (override) {
    debugLog('Using override tiles base URL', { provider, baseUrl: override });
    return `${override.replace(/\/$/, '')}/${normalizePath(basePath)}`;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('Missing SUPABASE_URL or DRAWINGS_TILES_BASE_URL');
  }

  debugLog('Using Supabase tiles base URL', { provider, supabaseUrl });
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${SUPABASE_BUCKET}/${normalizePath(basePath)}`;
}

export async function uploadTileObject(params: {
  supabase: SupabaseClient;
  path: string;
  bytes: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  const { supabase, path, bytes, contentType } = params;
  const cacheControl = params.cacheControl ?? 'public, max-age=31536000, immutable';
  const provider = getProvider();
  const key = normalizeKey(path);

  debugLog('Uploading tile object', { provider, key, contentType });

  if (provider === 'r2') {
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
    return;
  }

  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, bytes, {
    contentType,
    cacheControl,
    upsert: true,
  });

  if (error && !error.message?.includes?.('already exists')) {
    throw new Error(`Upload failed: ${error.message}`);
  }
}

export async function downloadTileObject(params: {
  supabase: SupabaseClient;
  path: string;
}): Promise<Buffer> {
  const { supabase, path } = params;
  const provider = getProvider();
  const key = normalizeKey(path);

  debugLog('Downloading tile object', { provider, key });

  if (provider === 'r2') {
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

  const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(key);
  if (error || !data) {
    throw new Error(`Failed to download pre-rendered PNG: ${error?.message}`);
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  return Buffer.from(bytes);
}

export async function deleteTileObjects(params: {
  supabase: SupabaseClient;
  paths: string[];
}): Promise<void> {
  const { supabase, paths } = params;
  const provider = getProvider();
  const keys = paths.map(normalizeKey);

  debugLog('Deleting tile objects', { provider, count: keys.length });

  if (provider === 'r2') {
    const client = getR2Client();
    await client.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      })
    );
    return;
  }

  await supabase.storage.from(SUPABASE_BUCKET).remove(keys);
}
