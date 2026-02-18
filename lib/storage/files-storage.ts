import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { Readable } from "node:stream"
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export type FilesStorageProvider = "r2"

const R2_BUCKET = process.env.R2_BUCKET ?? "project-files"
const R2_PREFIX = "project-files"
const R2_REGION = process.env.R2_REGION ?? "auto"
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === "true"

let cachedR2Client: S3Client | null = null

export function getFilesStorageProvider(): FilesStorageProvider {
  const raw = (process.env.FILES_STORAGE ?? "r2").toLowerCase()
  if (raw !== "r2") {
    throw new Error("FILES_STORAGE must be set to r2.")
  }
  return "r2"
}

function normalizeBaseUrl(value?: string | null): string | null {
  if (!value) return null
  return value.endsWith("/") ? value.slice(0, -1) : value
}

export function buildFilesBaseUrl(): string | null {
  const override =
    process.env.NEXT_PUBLIC_FILES_BASE_URL ?? process.env.FILES_BASE_URL
  if (override) return normalizeBaseUrl(override)

  return null
}

function requireFilesBaseUrl(): string {
  const baseUrl = buildFilesBaseUrl()
  if (!baseUrl) {
    throw new Error("Missing FILES_BASE_URL/NEXT_PUBLIC_FILES_BASE_URL")
  }
  return baseUrl
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

function assertSafePath(path: string): void {
  const normalized = normalizePath(path)
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("Invalid storage path")
  }
}

function joinPath(parts: string[]): string {
  const cleaned = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
  const joined = cleaned.join("/")
  assertSafePath(joined)
  return joined
}

export function buildOrgScopedPath(orgId: string, ...parts: string[]): string {
  if (!orgId) throw new Error("Missing orgId for storage path")
  return joinPath([orgId, ...parts])
}

export function ensureOrgScopedPath(orgId: string, path: string): string {
  const normalized = normalizePath(path)
  assertSafePath(normalized)

  const prefix = `${orgId}/`
  if (normalized === orgId || normalized.startsWith(prefix)) return normalized
  return joinPath([orgId, normalized])
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

export function buildFilesPublicUrl(path?: string | null): string | null {
  if (!path) return null
  const baseUrl = requireFilesBaseUrl()
  const normalized = normalizePath(path)
  return `${baseUrl}/${encodeURI(normalized)}`
}

export async function uploadFilesObject(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  bytes: Uint8Array | Buffer
  contentType: string
  cacheControl?: string
  upsert?: boolean
}): Promise<{ storagePath: string }> {
  const { supabase: _supabase, orgId, bytes, contentType } = params
  const cacheControl = params.cacheControl
  const provider = getFilesStorageProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  if (provider !== "r2") {
    throw new Error("R2 uploads are required. Set FILES_STORAGE=r2.")
  }

  const client = getR2Client()
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(storagePath),
      Body: bytes,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  )

  return { storagePath }
}

export async function createFilesUploadUrl(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
  contentType: string
  cacheControl?: string
  expiresIn?: number
}): Promise<{ storagePath: string; uploadUrl: string; provider: FilesStorageProvider }> {
  const { supabase: _supabase, orgId, contentType } = params
  const provider = getFilesStorageProvider()
  const storagePath = ensureOrgScopedPath(orgId, params.path)

  if (provider !== "r2") {
    throw new Error("R2 uploads are required. Set FILES_STORAGE=r2.")
  }

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

export async function deleteFilesObjects(params: {
  supabase: SupabaseClient
  orgId: string
  paths: string[]
}): Promise<void> {
  const { supabase: _supabase, orgId } = params
  const keys = params.paths.map((path) => ensureOrgScopedPath(orgId, path))

  const client = getR2Client()
  await client.send(
    new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key: normalizeKey(Key) })), Quiet: true },
    })
  )
}

export async function listFilesObjects(params: {
  supabase: SupabaseClient
  orgId: string
  prefix?: string
  limit?: number
}): Promise<Array<{ name: string; size: number; lastModified?: string }>> {
  const { supabase: _supabase, orgId } = params
  const limit = params.limit ?? 100
  const prefix = params.prefix ? ensureOrgScopedPath(orgId, params.prefix) : `${orgId}/`

  const client = getR2Client()
  const result = await client.send(
    new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: normalizeKey(prefix),
      MaxKeys: limit,
    })
  )

  return (
    result.Contents?.map((item) => ({
      name: (item.Key ?? "").replace(new RegExp(`^${R2_PREFIX}/`), ""),
      size: item.Size ?? 0,
      lastModified: item.LastModified?.toISOString(),
    })) ?? []
  )
}

export async function downloadFilesObject(params: {
  supabase: SupabaseClient
  orgId: string
  path: string
}): Promise<Buffer> {
  const { supabase: _supabase, orgId } = params
  const key = ensureOrgScopedPath(orgId, params.path)

  const client = getR2Client()
  const result = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: normalizeKey(key),
    })
  )
  if (!result.Body) {
    throw new Error(`Failed to download ${key}: empty body`)
  }
  return streamToBuffer(result.Body)
}
