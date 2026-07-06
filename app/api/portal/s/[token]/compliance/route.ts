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
    const status = await getCompanyComplianceStatusWithClient(
      supabase,
      portalToken.org_id,
      portalToken.company_id
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

    if (!body.file_id) {
      return NextResponse.json({ error: "file_id is required" }, { status: 400 })
    }

    const supabase = createServiceSupabaseClient()
    const document = await uploadComplianceDocumentFromPortal({
      supabase,
      orgId: portalToken.org_id,
      companyId: portalToken.company_id,
      input: parsed.data,
      fileId: body.file_id,
      portalTokenId: portalToken.id,
    })

    return NextResponse.json(document)
  } catch (err) {
    return portalAccessErrorResponse(err)
  }
}
