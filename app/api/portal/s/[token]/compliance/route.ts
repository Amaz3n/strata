import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import {
  getCompanyComplianceStatusWithClient,
  uploadComplianceDocumentFromPortal,
} from "@/lib/services/compliance-documents"
import { complianceDocumentUploadSchema } from "@/lib/validation/compliance-documents"

function portalAccessErrorResponse(err: unknown) {
  if (err instanceof Error) {
    return NextResponse.json({ error: err.message }, { status: 403 })
  }
  return NextResponse.json({ error: "Access denied" }, { status: 403 })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const portalToken = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true }).catch(portalAccessErrorResponse)
  if (portalToken instanceof NextResponse) return portalToken
  if (!portalToken.company_id) {
    return NextResponse.json({ error: "Invalid portal type" }, { status: 403 })
  }

  try {
    const supabase = createServiceSupabaseClient()
    // The token is one person's access to one job, so the vendor is told what
    // THAT job demands — the same terms the builder's tab and the payment gate
    // read. An account-level link carries no project and asks the standing
    // question instead.
    const status = await getCompanyComplianceStatusWithClient(
      supabase,
      portalToken.org_id,
      portalToken.company_id,
      { projectIds: portalToken.project_id ? [portalToken.project_id] : [] }
    )

    return NextResponse.json(status)
  } catch (err) {
    console.error("Failed to get compliance status:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get compliance status" },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const portalToken = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_upload_compliance_docs",
  }).catch(portalAccessErrorResponse)
  if (portalToken instanceof NextResponse) return portalToken
  if (!portalToken.company_id) {
    return NextResponse.json({ error: "Invalid portal type" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const parsed = complianceDocumentUploadSchema.safeParse(body)

    if (!parsed.success) {
      const firstError = parsed.error.errors[0]
      return NextResponse.json(
        { error: firstError?.message ?? "Invalid input" },
        { status: 400 }
      )
    }

    if (!body.file_id || typeof body.file_id !== "string") {
      return NextResponse.json({ error: "file_id is required" }, { status: 400 })
    }

    const supabase = createServiceSupabaseClient()

    // The file must be one this portal just uploaded. Taking the caller's word
    // for it would let a vendor attach any file id in the builder's org to
    // their own compliance record — and now that they can read their documents
    // back, that would hand them the file's contents.
    const { data: file } = await supabase
      .from("files")
      .select("id, metadata")
      .eq("org_id", portalToken.org_id)
      .eq("id", body.file_id)
      .maybeSingle()
    const fileMetadata = (file?.metadata ?? {}) as Record<string, unknown>
    if (!file || fileMetadata.company_id !== portalToken.company_id) {
      return NextResponse.json({ error: "File not available" }, { status: 404 })
    }

    const document = await uploadComplianceDocumentFromPortal({
      supabase,
      orgId: portalToken.org_id,
      companyId: portalToken.company_id,
      input: parsed.data,
      fileId: body.file_id,
      portalTokenId: portalToken.id,
      // Present when the upload came from the prequalification form, so the
      // reviewer sees it against the package they asked for.
      prequalificationId:
        typeof body.prequalification_id === "string" ? body.prequalification_id : null,
    })

    return NextResponse.json(document)
  } catch (err) {
    return portalAccessErrorResponse(err)
  }
}
