import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { getFilesObjectStream } from "@/lib/storage/files-storage"
import { streamZip, uniqueZipName } from "@/lib/files/streaming-zip"

const MAX_ZIP_FILES = 100
const MAX_ZIP_BYTES = 500 * 1024 * 1024
const selectionSchema = z.object({ fileIds: z.array(z.string().uuid()).min(1).max(500), prepare: z.boolean().optional() })
export const maxDuration = 300

async function downloadZip(request: Request, input: unknown) {
  const { fileIds: selected, prepare } = selectionSchema.parse(input)
  const fileIds = [...new Set(selected)]
  const { supabase, orgId, userId } = await requireOrgContext()
  const { data: files, error } = await supabase.from("files")
    .select("id, project_id, file_name, storage_path, size_bytes, folder_path, updated_at")
    .eq("org_id", orgId).in("id", fileIds)
  if (error) throw new Error("Unable to read file selection")
  // An incomplete archive must never silently masquerade as the requested selection.
  if (!files || files.length !== fileIds.length) return Response.json({ error: "Some selected files are no longer accessible." }, { status: 404 })
  const projects = [...new Set(files.map(file => file.project_id).filter((id): id is string => typeof id === "string"))]
  await Promise.all(projects.map(projectId => requireProjectPermission(userId, projectId, "docs.download")))
  if (files.some(file => !file.project_id)) await requirePermission("docs.download", { supabase, orgId, userId })
  if (files.length > MAX_ZIP_FILES || files.reduce((sum, file) => sum + Number(file.size_bytes ?? 0), 0) > MAX_ZIP_BYTES) {
    if (prepare) return Response.json({ exportRequired: true }, { headers: { "Cache-Control": "private, no-store" } })
    return Response.json({ error: "Selected files exceed the 500 MB ZIP limit. Download a smaller selection." }, { status: 413 })
  }
  if (prepare) {
    return Response.json({ downloadUrl: `/api/documents/download-zip?fileIds=${fileIds.join(",")}` }, { headers: { "Cache-Control": "private, no-store" } })
  }
  const used = new Set<string>()
  const entries = files.map(file => ({
    name: uniqueZipName(`${file.folder_path || ""}/${file.file_name}`, used),
    modifiedAt: file.updated_at,
    open: async () => {
      const object = await getFilesObjectStream({ supabase, orgId, path: file.storage_path })
      return object.body
    },
  }))
  return new Response(streamZip(entries, MAX_ZIP_BYTES, request.signal), { headers: {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="arc-documents-${new Date().toISOString().slice(0, 10)}.zip"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } })
}
function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: `Select between 1 and ${MAX_ZIP_FILES} files.` }, { status: 400 })
  if (error instanceof Error && /permission|unauthorized|forbidden/i.test(error.message)) return Response.json({ error: "Forbidden" }, { status: 403 })
  console.error("[documents download-zip]", error)
  return Response.json({ error: "Failed to create ZIP download." }, { status: 500 })
}
export async function POST(request: Request) {
  try { return await downloadZip(request, await request.json()) } catch (error) { return failure(error) }
}
export async function GET(request: Request) {
  try { return await downloadZip(request, { fileIds: new URL(request.url).searchParams.get("fileIds")?.split(",") }) }
  catch (error) { return failure(error) }
}
