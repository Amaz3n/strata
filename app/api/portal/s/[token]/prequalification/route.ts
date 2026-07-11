import { NextRequest, NextResponse } from "next/server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getLatestPrequalificationWithClient, submitPrequalificationFromPortal } from "@/lib/services/prequalification"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
    if (!access.company_id) return NextResponse.json({ error: "Company is required" }, { status: 403 })
    return NextResponse.json(await getLatestPrequalificationWithClient(createServiceSupabaseClient(), access.org_id, access.company_id))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Access denied" }, { status: 403 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true, permission: "can_upload_compliance_docs" })
    if (!access.company_id) return NextResponse.json({ error: "Company is required" }, { status: 403 })
    const result = await submitPrequalificationFromPortal({ supabase: createServiceSupabaseClient(), orgId: access.org_id, companyId: access.company_id, portalTokenId: access.id, input: await request.json() })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit prequalification" }, { status: 400 })
  }
}
