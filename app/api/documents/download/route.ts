import { z } from "zod"
import { unstable_rethrow } from "next/navigation"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"

export async function GET(request: Request) {
  try {
    const fileId = z.string().uuid().parse(new URL(request.url).searchParams.get("fileId"))
    const { supabase, orgId, userId } = await requireOrgContext()
    const { data: file, error } = await supabase.from("files")
      .select("id, project_id, storage_path, file_name, mime_type").eq("org_id", orgId).eq("id", fileId).maybeSingle()
    if (error) throw new Error("Unable to read file")
    if (!file) return Response.json({ error: "File not found" }, { status: 404 })
    if (file.project_id) await requireProjectPermission(userId, file.project_id, "docs.download")
    else await requirePermission("docs.download", { supabase, orgId, userId })
    const { downloadUrl } = await createFilesDownloadUrl({
      supabase, orgId, path: file.storage_path, fileName: file.file_name,
      contentType: file.mime_type || undefined, disposition: "attachment", expiresIn: 600,
    })
    return new Response(null, { status: 303, headers: { Location: downloadUrl, "Cache-Control": "private, no-store" } })
  } catch (error) {
    unstable_rethrow(error)
    if (error instanceof z.ZodError) return Response.json({ error: "Invalid file" }, { status: 400 })
    if (error instanceof Error && /permission|unauthorized|forbidden/i.test(error.message)) return Response.json({ error: "Forbidden" }, { status: 403 })
    console.error("[documents download]", error)
    return Response.json({ error: "Unable to download file" }, { status: 500 })
  }
}
