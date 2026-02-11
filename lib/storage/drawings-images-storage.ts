import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { ensureOrgScopedPath } from "@/lib/storage/files-storage"

export type DrawingsImagesStorageProvider = "r2"

const R2_BUCKET = process.env.R2_BUCKET ?? "project-files"
const R2_PREFIX = "drawings-images"
const R2_REGION = process.env.R2_REGION ?? "auto"
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === "true"

let cachedR2Client: S3Client | null = null

function getProvider(): DrawingsImagesStorageProvider {
  const raw =
    process.env.DRAWINGS_IMAGES_STORAGE ??
    process.env.DRAWINGS_TILES_STORAGE ??
    process.env.FILES_STORAGE ??
    "r2"
  if (raw.toLowerCase() !== "r2") {
    throw new Error("DRAWINGS_IMAGES_STORAGE must be set to r2.")
  }
  return "r2"
}

function getR2Client(): S3Client {
  if (cachedR2Client) return cachedR2Client

  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const endpoint =
    process.env.R2_ENDPOINT ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null)

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing R2 credentials or endpoint")
  }

  cachedR2Client = new S3Client({
    region: R2_REGION,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: R2_FORCE_PATH_STYLE,
  })

  return cachedR2Client
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path
}

function normalizeKey(path: string): string {
  return `${R2_PREFIX}/${normalizePath(path)}`
}

export async function createDrawingImageUploadUrl(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  contentType: string
  cacheControl?: string
  expiresIn?: number
}): Promise<{
  storagePath: string
  uploadUrl: string
  provider: DrawingsImagesStorageProvider
}> {
  const { supabase: _supabase, orgId, contentType } = params
  const provider = getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: normalizeKey(storagePath),
    ContentType: contentType,
    CacheControl: params.cacheControl ?? "public, max-age=31536000, immutable",
  })

  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: params.expiresIn ?? 600,
  })

  return {
    storagePath,
    uploadUrl,
    provider,
  }
}
