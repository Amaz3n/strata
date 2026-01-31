import type { SupabaseClient } from '@supabase/supabase-js';
import { Readable } from 'stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

type PdfsStorageProvider = 'supabase' | 'r2';

const SUPABASE_BUCKET = process.env.DRAWINGS_PDFS_SUPABASE_BUCKET ?? 'project-files';
const R2_BUCKET = process.env.R2_BUCKET ?? 'project-files';
const R2_PREFIX = 'drawings-pdfs';
const R2_REGION = process.env.R2_REGION ?? 'auto';
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === 'true';

let cachedR2Client: S3Client | null = null;

function getProvider(): PdfsStorageProvider {
  const raw =
    process.env.DRAWINGS_PDFS_STORAGE ??
    process.env.DRAWINGS_TILES_STORAGE ??
    'supabase';
  return raw.toLowerCase() === 'r2' ? 'r2' : 'supabase';
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

export async function downloadPdfObject(params: {
  supabase: SupabaseClient;
  path: string;
}): Promise<Buffer> {
  const { supabase, path } = params;
  const provider = getProvider();
  const key = normalizeKey(path);

  if (provider === 'r2') {
    const client = getR2Client();
    const result = await client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );
    if (!result.Body) {
      throw new Error(`Failed to download PDF: empty body for ${key}`);
    }
    return streamToBuffer(result.Body);
  }

  const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(key);
  if (error || !data) {
    throw new Error(`Failed to download PDF: ${error?.message}`);
  }

  const bytes = new Uint8Array(await data.arrayBuffer());
  return Buffer.from(bytes);
}
