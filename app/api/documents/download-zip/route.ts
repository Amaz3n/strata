import { NextResponse } from "next/server"

import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

const MAX_ZIP_FILES = 100
const MAX_ZIP_BYTES = 500 * 1024 * 1024

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980)
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  return { dosDate, dosTime }
}

function sanitizeZipName(name: string, usedNames: Set<string>) {
  const cleaned = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .replace(/[\x00-\x1f]/g, "_")
    .trim() || "file"
  const parts = cleaned.split("/")
  const basename = parts.pop() || "file"
  const folder = parts.length ? `${parts.join("/")}/` : ""
  const dotIndex = basename.lastIndexOf(".")
  const stem = dotIndex > 0 ? basename.slice(0, dotIndex) : basename
  const extension = dotIndex > 0 ? basename.slice(dotIndex) : ""

  let candidate = `${folder}${basename}`
  let index = 2
  while (usedNames.has(candidate)) {
    candidate = `${folder}${stem} (${index})${extension}`
    index += 1
  }
  usedNames.add(candidate)
  return candidate
}

function u16(value: number) {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value & 0xffff, 0)
  return buffer
}

function u32(value: number) {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function buildZip(entries: Array<{ name: string; bytes: Buffer; modifiedAt?: string | null }>) {
  const chunks: Buffer[] = []
  const centralDirectory: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8")
    const crc = crc32(entry.bytes)
    const { dosDate, dosTime } = dosDateTime(entry.modifiedAt ? new Date(entry.modifiedAt) : undefined)
    const size = entry.bytes.length

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ])

    chunks.push(localHeader, entry.bytes)

    centralDirectory.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]))

    offset += localHeader.length + entry.bytes.length
  }

  const centralStart = offset
  const central = Buffer.concat(centralDirectory)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(centralStart),
    u16(0),
  ])

  return Buffer.concat([...chunks, central, end])
}

function buildDisposition(filename: string) {
  const fallback = filename.replace(/[\r\n"]/g, "_").replace(/[^\x20-\x7e]/g, "_")
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export async function POST(request: Request) {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const body = await request.json()
    const fileIds = Array.isArray(body?.fileIds)
      ? Array.from(new Set(body.fileIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)))
      : []

    if (fileIds.length === 0) {
      return NextResponse.json({ error: "No files selected." }, { status: 400 })
    }
    if (fileIds.length > MAX_ZIP_FILES) {
      return NextResponse.json({ error: `Select ${MAX_ZIP_FILES} files or fewer.` }, { status: 400 })
    }

    const { data: files, error } = await supabase
      .from("files")
      .select("id, file_name, storage_path, size_bytes, folder_path, updated_at")
      .eq("org_id", orgId)
      .in("id", fileIds)

    if (error) {
      throw new Error(`Failed to load files: ${error.message}`)
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No accessible files found." }, { status: 404 })
    }

    const totalBytes = files.reduce((sum, file) => sum + Number(file.size_bytes ?? 0), 0)
    if (totalBytes > MAX_ZIP_BYTES) {
      return NextResponse.json({ error: "Selected files are too large for one ZIP package." }, { status: 413 })
    }

    const service = createServiceSupabaseClient()
    const usedNames = new Set<string>()
    const entries = []

    for (const file of files) {
      const bytes = await downloadFilesObject({
        supabase: service,
        orgId,
        path: file.storage_path,
      })
      const folder = typeof file.folder_path === "string" && file.folder_path !== "/"
        ? file.folder_path.replace(/^\/+|\/+$/g, "")
        : ""
      entries.push({
        name: sanitizeZipName(folder ? `${folder}/${file.file_name}` : file.file_name, usedNames),
        bytes,
        modifiedAt: file.updated_at,
      })
    }

    const zip = buildZip(entries)
    const now = new Date().toISOString().slice(0, 10)
    const headers = new Headers()
    headers.set("Content-Type", "application/zip")
    headers.set("Content-Disposition", buildDisposition(`arc-documents-${now}.zip`))
    headers.set("Content-Length", String(zip.length))
    headers.set("Cache-Control", "private, no-store")

    return new Response(new Uint8Array(zip), { status: 200, headers })
  } catch (error) {
    console.error("[api/documents/download-zip] failed:", error)
    return NextResponse.json({ error: "Failed to create ZIP download." }, { status: 500 })
  }
}

export const runtime = "nodejs"
