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

type TilesStorageProvider = "r2"
const R2_BUCKET = process.env.R2_BUCKET ?? "project-files"
const R2_PREFIX = "drawings-tiles"
const R2_REGION = process.env.R2_REGION ?? "auto"
const R2_FORCE_PATH_STYLE = process.env.R2_FORCE_PATH_STYLE === "true"

let cachedR2Client: S3Client | null = null

export function getTilesStorageProvider(): TilesStorageProvider {
  const raw = process.env.DRAWINGS_TILES_STORAGE ?? "r2"
  if (raw.toLowerCase() !== "r2") {
    throw new Error("DRAWINGS_TILES_STORAGE must be set to r2.")
  }
  return "r2"
}

function requireTilesBaseUrl(): string {
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
  return `${R2_PREFIX}/${normalized}`
}

async function streamToBuffer(stream: any, maxBytes?: number): Promise<Buffer> {
  if (stream instanceof Readable) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (maxBytes !== undefined && size > maxBytes) throw new Error("Drawing object exceeds its byte budget")
      chunks.push(bytes)
    }
    return Buffer.concat(chunks)
  }

  if (stream?.arrayBuffer) {
    const ab = await stream.arrayBuffer()
    if (maxBytes !== undefined && ab.byteLength > maxBytes) throw new Error("Drawing object exceeds its byte budget")
    return Buffer.from(ab)
  }

  const bytes = Buffer.from(stream ?? [])
  if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error("Drawing object exceeds its byte budget")
  return bytes
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
  const { supabase: _supabase, path, bytes, contentType } = params
  const cacheControl = params.cacheControl ?? "public, max-age=31536000, immutable"
  getTilesStorageProvider()
  const key = normalizeKey(path)

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
}

export async function deleteTilesObjects(params: {
  supabase: SupabaseClient
  paths: string[]
}): Promise<void> {
  const { supabase: _supabase, paths } = params
  getTilesStorageProvider()
  const client = getR2Client()
  for (let offset = 0; offset < paths.length; offset += 1000) {
    const keys = paths.slice(offset, offset + 1000).map(normalizeKey)
    const result = await client.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET,
      Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true },
    }))
    if (result.Errors?.length) throw new Error(`Failed to delete ${result.Errors.length} drawing objects`)
  }
}

export async function listTilesObjects(params: {
  supabase: SupabaseClient
  prefix?: string
  limit?: number
}): Promise<Array<{ name: string; size: number; lastModified?: string }>> {
  const { supabase: _supabase } = params
  getTilesStorageProvider()
  const prefix = params.prefix ? normalizePath(params.prefix) : undefined
  const limit = params.limit ?? 100

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

export async function downloadTilesObject(params: {
  supabase: SupabaseClient
  path: string
  maxBytes?: number
}): Promise<Buffer> {
  const { supabase: _supabase, path } = params
  const maxBytes = params.maxBytes
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("Invalid drawing object byte budget")
  getTilesStorageProvider()
  const key = normalizeKey(path)

  const client = getR2Client()
  const result = await client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    })
  )
  if (!result.Body) {
    throw new Error(`Failed to download ${key}: empty body`)
  }
  if (maxBytes !== undefined && result.ContentLength !== undefined && result.ContentLength > maxBytes) {
    if (result.Body instanceof Readable) result.Body.destroy()
    throw new Error("Drawing object exceeds its byte budget")
  }
  return streamToBuffer(result.Body, maxBytes)
}

/** Negative cache lookups and complete source-vote history require an explicit
 * completion flag. A short S3 page alone does not establish that it is final. */
export async function listTilesObjectsBounded(params: {supabase:SupabaseClient;prefix:string;limit:number}): Promise<{objects:Array<{name:string;size:number}>;complete:boolean}> {
  if(!Number.isInteger(params.limit)||params.limit<1||params.limit>1000)throw new Error("Invalid drawing object listing budget")
  getTilesStorageProvider()
  const result=await getR2Client().send(new ListObjectsV2Command({Bucket:R2_BUCKET,Prefix:normalizeKey(params.prefix),MaxKeys:params.limit}))
  return {objects:(result.Contents??[]).flatMap(item=>item.Key?[{name:item.Key.slice(R2_PREFIX.length+1),size:item.Size??0}]:[]),complete:result.IsTruncated===false}
}

/** Continuation-token listing for bounded durable garbage collection. */
export async function listTilesObjectsPage(params: {prefix:string;continuationToken?:string}): Promise<{objects:Array<{name:string}>;continuationToken?:string}> {
  const result=await getR2Client().send(new ListObjectsV2Command({Bucket:R2_BUCKET,Prefix:normalizeKey(params.prefix),MaxKeys:1000,ContinuationToken:params.continuationToken}))
  return {objects:(result.Contents??[]).flatMap(item=>item.Key?[{name:item.Key.slice(R2_PREFIX.length+1)}]:[]),continuationToken:result.IsTruncated?result.NextContinuationToken:undefined}
}
