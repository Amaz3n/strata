import { requireOrgContext } from "@/lib/services/context"

export interface DocumentHealthReport {
  unsigned_contracts: number
  pending_change_orders: number
  missing_drawing_sets: boolean
  pending_lien_waivers: number
  items: Array<{
    type: string
    id: string
    label: string
    severity: "low" | "medium" | "high"
    reason: string
  }>
}

/**
 * Get document health summary for a project
 */
export async function getProjectDocumentHealth(
  projectId: string,
  orgId?: string
): Promise<DocumentHealthReport> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const items: DocumentHealthReport["items"] = []

  // 1. Check for unsigned contracts
  const { data: contracts, error: contractsError } = await supabase
    .from("contracts")
    .select("id, title, status")
    .eq("project_id", projectId)
    .neq("status", "signed")

  if (contractsError) {
    console.error("Health check: contracts error", contractsError)
  } else if (contracts && contracts.length > 0) {
    contracts.forEach(c => {
      items.push({
        type: "contract",
        id: c.id,
        label: c.title || "Untitled Contract",
        severity: "high",
        reason: "Contract is not signed",
      })
    })
  }

  // 2. Check for pending change orders
  const { data: changeOrders, error: coError } = await supabase
    .from("change_orders")
    .select("id, title, status")
    .eq("project_id", projectId)
    .in("status", ["draft", "pending"])

  if (coError) {
    console.error("Health check: change orders error", coError)
  } else if (changeOrders && changeOrders.length > 0) {
    changeOrders.forEach(co => {
      items.push({
        type: "change_order",
        id: co.id,
        label: co.title || "Untitled Change Order",
        severity: "medium",
        reason: `Change order is in ${co.status} status`,
      })
    })
  }

  // 3. Check for drawing sets
  const { count: drawingSetCount, error: dsError } = await supabase
    .from("drawing_sets")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)

  if (dsError) {
    console.error("Health check: drawing sets error", dsError)
  } else if (!drawingSetCount || drawingSetCount === 0) {
    items.push({
      type: "drawing_set",
      id: projectId,
      label: "Project Drawings",
      severity: "medium",
      reason: "No drawing sets uploaded for this project",
    })
  }

  // 4. Check for pending lien waivers
  const { data: lienWaivers, error: lwError } = await supabase
    .from("lien_waivers")
    .select("id, claimant_name, status")
    .eq("project_id", projectId)
    .eq("status", "pending")

  if (lwError) {
    console.error("Health check: lien waivers error", lwError)
  } else if (lienWaivers && lienWaivers.length > 0) {
    lienWaivers.forEach(lw => {
      items.push({
        type: "lien_waiver",
        id: lw.id,
        label: `Waiver: ${lw.claimant_name || "Unknown"}`,
        severity: "medium",
        reason: "Lien waiver is pending signature",
      })
    })
  }

  return {
    unsigned_contracts: contracts?.length ?? 0,
    pending_change_orders: changeOrders?.length ?? 0,
    missing_drawing_sets: !drawingSetCount || drawingSetCount === 0,
    pending_lien_waivers: lienWaivers?.length ?? 0,
    items,
  }
}
