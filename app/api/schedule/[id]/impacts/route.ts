import { NextRequest, NextResponse } from "next/server"
import { requireOrgContext } from "@/lib/services/context"
import { getScheduleChangeOrderImpacts, getDrawsByMilestone } from "@/lib/services/schedule"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: scheduleItemId } = await params

  try {
    const { supabase, orgId } = await requireOrgContext()

    // First, get the schedule item to check if it's a milestone
    const { data: scheduleItem, error: itemError } = await supabase
      .from("schedule_items")
      .select("id, item_type")
      .eq("org_id", orgId)
      .eq("id", scheduleItemId)
      .single()

    if (itemError || !scheduleItem) {
      return NextResponse.json({ error: "Schedule item not found" }, { status: 404 })
    }

    // Get CO impacts for this schedule item
    const impacts = await getScheduleChangeOrderImpacts(scheduleItemId, orgId)

    // If it's a milestone, also get linked draws
    let draws: Awaited<ReturnType<typeof getDrawsByMilestone>> = []
    if (scheduleItem.item_type === "milestone") {
      draws = await getDrawsByMilestone(scheduleItemId, orgId)
    }

    return NextResponse.json({
      schedule_item_id: scheduleItemId,
      impacts,
      draws,
    })
  } catch (error) {
    console.error("Error fetching schedule item impacts:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch impacts" },
      { status: 500 }
    )
  }
}
