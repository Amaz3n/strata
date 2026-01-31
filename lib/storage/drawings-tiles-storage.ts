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

import { getDrawingsTilesBaseUrl } from "@/lib/storage/drawings-urls"

type TilesStorageProvider = "supabase" | "r2"

const SUPABASE_BUCKET = process.env.DRAWINGS_TILES_SUPABASE_BUCKET ?? "drawings-tiles"
const R2_BUCKET = process.env.R2_BUCKET ?? "project-files"
const R2_PREFIX = "drawings-tiles"
const R2_REGION = process.env.R2_REGION ?? "auto"
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === "true"

let cachedR2Client: S3Client | null = null

export function getTilesStorageProvider(): TilesStorageProvider {
  const raw = process.env.DRAWINGS_TILES_STORAGE ?? "supabase"
  return raw.toLowerCase() === "r2" ? "r2" : "supabase"
}

function requireTilesBaseUrl(): string {
  const override =
    process.env.DRAWINGS_TILES_BASE_URL ??
    process.env.NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL
  const provider = getTilesStorageProvider()
  if (provider === "r2" && !override) {
    throw new Error("Missing DRAWINGS_TILES_BASE_URL for R2 storage")
  }

  const baseUrl = getDrawingsTilesBaseUrl()
  if (!baseUrl) {
    throw new Error("Missing DRAWINGS_TILES_BASE_URL/NEXT_PUBLIC_DRAWINGS_TILES_BASE_URL")
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
  return getTilesStorageProvider() === "r2" ? `${R2_PREFIX}/${normalized}` : normalized
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

export function getTilesPublicBaseUrl(): string {
  return requireTilesBaseUrl()
}

export async function uploadTilesObject(params: {
  supabase: SupabaseClient
  path: string
  bytes: Uint8Array | Buffer
  contentType: string
  cacheControl?: string
}): Promise<void> {
  const { supabase, path, bytes, contentType } = params
  const cacheControl = params.cacheControl ?? "public, max-age=31536000, immutable"
  const provider = getTilesStorageProvider()
  const key = normalizeKey(path)

  if (provider === "r2") {
    const client = getR2Client()
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: cacheControl,
      })
    )
    return
  }

  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, bytes, {
    contentType,
    cacheControl,
    upsert: false,
  })

  if (!error) return

  const msg = (error as any)?.message?.toLowerCase?.() ?? ""
  if (msg.includes("already exists") || msg.includes("409")) {
    return
  }

  throw new Error(`storage upload failed (${key}): ${(error as any)?.message ?? "unknown error"}`)
}

export async function deleteTilesObjects(params: {
  supabase: SupabaseClient
  paths: string[]
}): Promise<void> {
  const { supabase, paths } = params
  const provider = getTilesStorageProvider()
  const keys = paths.map(normalizeKey)

  if (provider === "r2") {
    const client = getR2Client()
    await client.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      })
    )
    return
  }

  await supabase.storage.from(SUPABASE_BUCKET).remove(keys)
}

export async function listTilesObjects(params: {
  supabase: SupabaseClient
  prefix?: string
  limit?: number
}): Promise<Array<{ name: string; size: number; lastModified?: string }>> {
  const { supabase } = params
  const provider = getTilesStorageProvider()
  const prefix = params.prefix ? normalizePath(params.prefix) : undefined
  const limit = params.limit ?? 100

  if (provider === "r2") {
    const client = getR2Client()
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: prefix ? normalizeKey(prefix) : undefined,
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

  const { data } = await supabase.storage.from(SUPABASE_BUCKET).list(prefix ?? "", {
    limit,
    sortBy: { column: "name", order: "asc" },
  })

  return (
    data?.map((item) => ({
      name: item.name,
      size: item.metadata?.size || 0,
      lastModified: item.updated_at ?? undefined,
    })) ?? []
  )
}

export async function downloadTilesObject(params: {
  supabase: SupabaseClient
  path: string
}): Promise<Buffer> {
  const { supabase, path } = params
  const provider = getTilesStorageProvider()
  const key = normalizeKey(path)

  if (provider === "r2") {
    const client = getR2Client()
    const result = await client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    )
    return streamToBuffer(result.Body)
  }

  const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(key)
  if (error || !data) {
    throw new Error(`Failed to download ${key}: ${error?.message ?? "unknown error"}`)
  }
  const arrayBuffer = await data.arrayBuffer()
  return Buffer.from(arrayBuffer)
}
