import "server-only"
import { resolveDrawingPdfSourceKey } from "./drawing-pdf-source"

import type { SupabaseClient } from "@supabase/supabase-js"
import { Readable } from "node:stream"
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { ensureOrgScopedPath } from "@/lib/storage/files-storage"

type PdfsStorageProvider = "r2"

const R2_BUCKET = process.env.R2_BUCKET ?? "project-files"
const R2_PREFIX = "drawings-pdfs"
const R2_REGION = process.env.R2_REGION ?? "auto"
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === "true"

let cachedR2Client: S3Client | null = null

function getProvider(): PdfsStorageProvider {
  const raw =
    process.env.DRAWINGS_PDFS_STORAGE ??
    process.env.FILES_STORAGE ??
    "r2"
  if (raw.toLowerCase() !== "r2") {
    throw new Error("DRAWINGS_PDFS_STORAGE must be set to r2.")
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
  const normalized = normalizePath(path)
  return `${R2_PREFIX}/${normalized}`
}

async function resolveReadKey(path: string): Promise<string> {
  return resolveDrawingPdfSourceKey(path, async (Key) => {
    try {
      await getR2Client().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key }));
      return true;
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return false;
      throw error;
    }
  });
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (stream instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  if (stream?.arrayBuffer) {
    const ab = await stream.arrayBuffer()
    return Buffer.from(ab)
  }

  return Buffer.from(stream ?? [])
}

export async function createDrawingPdfUploadUrl(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  contentType: string
  cacheControl?: string
  expiresIn?: number
}): Promise<{ storagePath: string; uploadUrl: string; provider: PdfsStorageProvider }> {
  const { supabase: _supabase, orgId, contentType } = params
  const provider = getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: normalizeKey(storagePath),
    ContentType: contentType,
    CacheControl: params.cacheControl ?? "private, max-age=3600",
  })
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: params.expiresIn ?? 600,
  })

  return { storagePath, uploadUrl, provider }
}

export async function createDrawingPdfMultipartUpload(params: {
  transferId?: string
  identity?: string
  operationId?: string
  generation?: string
  orgId: string
  path: string
  contentType: string
  cacheControl?: string
}): Promise<{ storagePath: string; uploadId: string; provider: PdfsStorageProvider }> {
  const { orgId, contentType } = params
  const provider = getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const result = await client.send(
    new CreateMultipartUploadCommand({
      Metadata: params.transferId && params.identity ? { "transfer-id": params.transferId, "content-identity": params.identity, ...(params.operationId ? { operation_id: params.operationId, generation: params.generation! } : {}) } : undefined,
      Bucket: R2_BUCKET,
      Key: normalizeKey(storagePath),
      ContentType: contentType,
      CacheControl: params.cacheControl ?? "private, max-age=3600",
    })
  )

  if (!result.UploadId) {
    throw new Error("R2 did not return a multipart upload id")
  }

  return { storagePath, uploadId: result.UploadId, provider }
}

export async function createDrawingPdfMultipartPartUrl(params: {
  orgId: string
  path: string
  uploadId: string
  partNumber: number
  expiresIn?: number
}): Promise<{ uploadUrl: string }> {
  const { orgId } = params
  getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const command = new UploadPartCommand({
    Bucket: R2_BUCKET,
    Key: normalizeKey(storagePath),
    UploadId: params.uploadId,
    PartNumber: params.partNumber,
  })
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: params.expiresIn ?? 900,
  })
  return { uploadUrl }
}

export async function completeDrawingPdfMultipartUpload(params: {
  orgId: string
  path: string
  uploadId: string
  parts: Array<{ partNumber: number; etag: string }>
}): Promise<{ storagePath: string }> {
  const { orgId } = params
  getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(storagePath),
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: params.parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
      },
    })
  )
  return { storagePath }
}

export async function abortDrawingPdfMultipartUpload(params: {
  orgId: string
  path: string
  uploadId: string
}): Promise<void> {
  const { orgId } = params
  getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  try {
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(storagePath),
      UploadId: params.uploadId,
    })
  )
  } catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (failure.name !== "NoSuchUpload" && failure.$metadata?.httpStatusCode !== 404) throw error
  }
}

export async function uploadDrawingPdfObject(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  bytes: Uint8Array | Buffer
  contentType: string
  cacheControl?: string
}): Promise<{ storagePath: string; provider: PdfsStorageProvider }> {
  const { supabase: _supabase, orgId, bytes, contentType } = params
  const provider = getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(storagePath),
      Body: bytes,
      ContentType: contentType,
      CacheControl: params.cacheControl ?? "private, max-age=3600",
    })
  )

  return { storagePath, provider }
}

export async function downloadDrawingPdfObject(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
}): Promise<Buffer> {
  const { supabase: _supabase, orgId } = params
  getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const result = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: await resolveReadKey(storagePath),
    })
  )
  if (!result.Body) {
    throw new Error(`Failed to download ${storagePath}: empty body`)
  }
  return streamToBuffer(result.Body)
}

export async function getDrawingPdfSignedUrl(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  expiresIn?: number
}): Promise<string | null> {
  const { supabase: _supabase, orgId } = params
  getProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: await resolveReadKey(storagePath),
  })
  return getSignedUrl(client, command, {
    expiresIn: params.expiresIn ?? 3600,
  })
}

/** HEAD native uploads only; library fallback cannot prove transfer completion. */
export async function headDrawingPdfObject(params: { orgId: string; path: string; resolveSource?: boolean }): Promise<{ size: number; etag?: string; metadata?: Record<string, string> }> {
  getProvider()
  const path = ensureOrgScopedPath(params.orgId, params.path)
  const result = await getR2Client().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: params.resolveSource ? await resolveReadKey(path) : normalizeKey(path) }))
  if (typeof result.ContentLength !== "number") throw new Error("Storage omitted object length")
  return { size: result.ContentLength, etag: result.ETag, metadata: result.Metadata }
}

export async function getDrawingPdfMultipartStatus(params: { orgId: string; path: string; uploadId: string; transferId: string; identity: string; fileSize: number }): Promise<{ state: "uploading" | "completed" | "unknown"; parts?: Array<{ partNumber: number; etag: string; size: number }> }> {
  getProvider()
  const path = ensureOrgScopedPath(params.orgId, params.path)
  try {
    const object = await headDrawingPdfObject({ orgId: params.orgId, path })
    if (object.size === params.fileSize && object.metadata?.["transfer-id"] === params.transferId && object.metadata?.["content-identity"] === params.identity) return { state: "completed" }
    return { state: "unknown" }
  } catch (error) {
    const storageError = error as { name?: string; $metadata?: { httpStatusCode?: number } }
    if (storageError.$metadata?.httpStatusCode !== 404 && storageError.name !== "NotFound" && storageError.name !== "NoSuchKey") throw error
  }
  const parts: Array<{ partNumber: number; etag: string; size: number }> = []
  let marker: string | undefined
  do {
    let result
    try {
      result = await getR2Client().send(new ListPartsCommand({ Bucket: R2_BUCKET, Key: normalizeKey(path), UploadId: params.uploadId, PartNumberMarker: marker, MaxParts: 1000 }))
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchUpload") return { state: "unknown" }
      throw error
    }
    for (const part of result.Parts ?? []) {
      if (!part.PartNumber || !part.ETag || typeof part.Size !== "number") throw new Error("Invalid remote part inventory")
      parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size })
    }
    if (!result.IsTruncated) break
    if (!result.NextPartNumberMarker || result.NextPartNumberMarker === marker || parts.length > 10000) throw new Error("Invalid remote pagination")
    marker = result.NextPartNumberMarker
  } while (true)
  return { state: "uploading", parts }
}

/** Deletes only an explicitly org-scoped native generation, never a library fallback. */
export async function deleteDrawingPdfObject(params: { orgId: string; path: string }): Promise<void> {
  const segments = params.path.split("/")
  if (segments.length !== 6 || segments[0] !== params.orgId || segments[2] !== "drawings" || segments[3] !== "uploads" || segments.some(segment => !segment || segment === "." || segment === "..") || params.path.includes("\\")) throw new Error("Invalid native drawing upload path")
  getProvider()
  await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: normalizeKey(params.path) }))
}
