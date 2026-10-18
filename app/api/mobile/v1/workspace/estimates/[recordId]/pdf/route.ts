import { z } from "zod"
import { MobileAPIError, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { requireModule } from "@/lib/mobile/workspace"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { downloadFilesObject } from "@/lib/storage/files-storage"

export async function GET(request: Request, { params }: { params: Promise<{ recordId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const recordId = z.string().uuid().parse((await params).recordId)
    const projectId = z.string().uuid().parse(new URL(request.url).searchParams.get("project_id"))
    await requireModule(context, "estimates", projectId)
    const { data: document, error } = await context.serviceSupabase.from("estimates").select("id,executed_file_id")
      .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", recordId).maybeSingle()
    if (error || !document) throw new MobileAPIError(404, "estimate_not_found", "Estimate not found in this project.")
    // An executed document must use its stored snapshot, never a live re-render.
    if (document.executed_file_id) {
      const { data: file, error: fileError } = await context.serviceSupabase.from("files").select("storage_path")
        .eq("org_id", context.orgId).eq("id", document.executed_file_id).maybeSingle()
      if (fileError || !file?.storage_path) throw new MobileAPIError(404, "executed_file_unavailable", "The executed PDF is unavailable.")
      const bytes = await downloadFilesObject({ supabase: context.serviceSupabase, orgId: context.orgId, path: file.storage_path })
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Request-ID": requestId } })
    }
    return await runWithServiceOrgContext(context.serviceContext, async () => {
      const response = await (await import("@/app/(app)/estimates/[id]/export/route")).GET(request, { params: Promise.resolve({ id: recordId }) })
      response.headers.set("Cache-Control", "private, no-store")
      response.headers.set("X-Request-ID", requestId)
      return response
    })
  } catch (error) {
    return mobileErrorResponse(error instanceof z.ZodError ? new MobileAPIError(422, "invalid_identifier", "Choose a valid estimate and project.") : error, requestId)
  }
}
