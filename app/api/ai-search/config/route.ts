import { NextResponse } from "next/server"

import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

// Lets the command bar know whether to surface the "Ask AI" affordances for this org.
export async function GET() {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const enabled = await isAiSearchEnabledForOrg({ supabase, orgId })
    return NextResponse.json({ enabled })
  } catch {
    // If we cannot resolve org context, fail closed on the AI affordance but keep search usable.
    return NextResponse.json({ enabled: false }, { status: 200 })
  }
}
