import { NextRequest, NextResponse } from "next/server"
import { loadSettingsPanel } from "@/lib/services/settings-page"
import { isSettingsTab } from "@/lib/settings/sections"
import { runAction } from "@/lib/action-result"

export async function GET(request: NextRequest) {
  const tab = request.nextUrl.searchParams.get("tab")
  const orgId = request.nextUrl.searchParams.get("orgId")
  if (!isSettingsTab(tab) || !orgId)
    return NextResponse.json(
      { success: false, error: "Invalid settings section." },
      { status: 400 },
    )
  const result = await runAction(() => loadSettingsPanel(tab, orgId))
  return NextResponse.json(result, {
    status: result.success ? 200 : 400,
    headers: { "Cache-Control": "private, no-store" },
  })
}
