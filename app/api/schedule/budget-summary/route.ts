import { NextRequest, NextResponse } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { getScheduleBudgetSummary } from "@/lib/services/schedule"

export async function GET(request: NextRequest) {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get("projectId")

    if (!projectId) {
      return NextResponse.json({ error: "Project ID is required" }, { status: 400 })
    }

    const budgetSummary = await getScheduleBudgetSummary(projectId, orgId)

    return NextResponse.json(budgetSummary)
  } catch (error) {
    console.error("Error fetching budget summary:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch budget summary" },
      { status: 500 }
    )
  }
}
