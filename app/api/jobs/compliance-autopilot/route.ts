import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runComplianceAutopilot } from "@/lib/services/compliance-autopilot"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const metrics = await runComplianceAutopilot()

  const supabase = createServiceSupabaseClient()
  const { data: orgs } = await supabase.from("orgs").select("id").eq("status", "active")
  let intelligenceRefreshFailures = 0
  for (const org of orgs ?? []) {
    const { error } = await supabase.rpc("refresh_directory_intelligence", { p_org_id: org.id })
    if (error) intelligenceRefreshFailures += 1
  }

  return NextResponse.json({ ok: true, ...metrics, intelligenceRefreshFailures })
}

export const POST = withCronRun("compliance-autopilot", handler)
export const GET = POST
