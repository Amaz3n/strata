import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import {
  getLatestPrequalificationWithClient,
  submitPrequalificationFromPortal,
} from "@/lib/services/prequalification"
import { notifyPrequalificationSubmitted } from "@/lib/services/prequalification-invite"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
    if (!access.company_id) return NextResponse.json({ error: "Company is required" }, { status: 403 })
    return NextResponse.json(
      await getLatestPrequalificationWithClient(
        createServiceSupabaseClient(),
        access.org_id,
        access.company_id,
      ),
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Access denied" },
      { status: 403 },
    )
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_upload_compliance_docs",
    })
    if (!access.company_id) return NextResponse.json({ error: "Company is required" }, { status: 403 })

    const supabase = createServiceSupabaseClient()
    const existing = await getLatestPrequalificationWithClient(
      supabase,
      access.org_id,
      access.company_id,
    )
    const result = await submitPrequalificationFromPortal({
      supabase,
      orgId: access.org_id,
      companyId: access.company_id,
      portalTokenId: access.id,
      input: await request.json(),
    })

    // The builder asked for this package; telling them it arrived is the whole
    // point of the request. Never let a failed notification fail the submission.
    await notifyPrequalificationSubmitted({
      supabase,
      orgId: access.org_id,
      companyId: access.company_id,
      prequalificationId: result.id,
      requestedBy: existing?.requested_by ?? null,
    }).catch(() => undefined)

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to submit prequalification" },
      { status: 400 },
    )
  }
}
