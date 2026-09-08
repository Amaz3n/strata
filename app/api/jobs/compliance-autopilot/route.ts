import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { runComplianceAutopilot } from "@/lib/services/compliance-autopilot"
import { sweepWaiverChases } from "@/lib/services/waiver-chase"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const metrics = await runComplianceAutopilot()
  // Lien waivers gate payment the same way an expired certificate does, so the
  // job that chases compliance documents daily chases waivers too rather than
  // earning a cron of its own.
  const waiverChases = await sweepWaiverChases().catch((error: unknown) => {
    console.error("[compliance-autopilot] waiver chase sweep failed", error)
    return null
  })

  const supabase = createServiceSupabaseClient()
  const { data: orgs } = await supabase.from("orgs").select("id").eq("status", "active")
  let intelligenceRefreshFailures = 0
  for (const org of orgs ?? []) {
    const { error } = await supabase.rpc("refresh_directory_intelligence", { p_org_id: org.id })
    if (error) intelligenceRefreshFailures += 1
  }

  return NextResponse.json({ ok: true, ...metrics, waiverChases, intelligenceRefreshFailures })
}

export const POST = withCronRun("compliance-autopilot", handler)
export const GET = POST
