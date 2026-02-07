import { NextResponse } from "next/server"

import { parseExecutedFileAccessToken } from "@/lib/services/esign-executed-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

function buildInlineDisposition(filename?: string | null) {
  const safe = (filename ?? "executed-document.pdf").replace(/[\r\n"]/g, "_")
  return `inline; filename="${safe}"`
}

export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const parsed = parseExecutedFileAccessToken(token)
    if (!parsed) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const supabase = createServiceSupabaseClient()
    const { data: file, error } = await supabase
      .from("files")
      .select("id, org_id, storage_path, file_name, mime_type")
      .eq("id", parsed.fileId)
      .maybeSingle()

    if (error || !file) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const bytes = await downloadFilesObject({
      supabase,
      orgId: file.org_id,
      path: file.storage_path,
    })

    const headers = new Headers()
    headers.set("Content-Type", file.mime_type ?? "application/pdf")
    headers.set("Content-Disposition", buildInlineDisposition(file.file_name))
    headers.set("Content-Length", String(bytes.length))
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Cache-Control", "private, max-age=120")

    return new Response(new Uint8Array(bytes), { status: 200, headers })
  } catch (error) {
    console.error("[api/esign/executed/[token]] Failed:", error)
    return NextResponse.json({ error: "Unable to serve file" }, { status: 500 })
  }
}
