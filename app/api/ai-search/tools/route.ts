import { NextResponse } from "next/server"

import { getAiToolCatalog } from "@/lib/services/ai-search/tool-catalog"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

export async function GET() {
  try {
    await requireOrgContext()
    const catalog = getAiToolCatalog()
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalTools: catalog.length,
      catalog,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load AI tool catalog."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
