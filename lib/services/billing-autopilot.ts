import { createHash } from "node:crypto"

import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { isFeatureEnabledForOrg } from "@/lib/services/feature-flags"
import type { ProjectFinancialSettings } from "@/lib/types"

export type BillingAutopilotItem = {
  id?: string
  item_type:
    | "draw_ready"
    | "draw_due"
    | "approved_unbilled_cost"
    | "fee_ready"
    | "retainage_ready"
    | "change_order_pending"
    | "missing_proof"
    | "progress_confirmation"
    | "reconciliation_exception"
  status: "suggested" | "needs_review" | "blocked" | "accepted" | "dismissed" | "executed"
  source_type?: string | null
  source_id?: string | null
  title: string
  description?: string | null
  amount_cents: number
  confidence?: number | null
  blocker_codes: string[]
  evidence: Record<string, unknown>[]
  proposed_action: Record<string, unknown>
}

export type BillingAutopilotRun = {
  id: string
  billing_model: ProjectFinancialSettings["billing_model"]
  status: string
  proposed_invoice_cents: number
  readiness_score: number
  blocker_count: number
  summary: Record<string, unknown>
  created_at: string
  items: BillingAutopilotItem[]
}

export type BillingAutopilotState = {
  enabled: boolean
  run: BillingAutopilotRun | null
}

const FLAG_KEY = "billing_autopilot"

export async function getBillingAutopilotState(projectId: string): Promise<BillingAutopilotState> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "billing_autopilot",
    resourceId: projectId,
  })

  const enabled = await isFeatureEnabledForOrg({
    supabase,
    orgId,
    flagKey: FLAG_KEY,
    defaultEnabled: false,
  })
  if (!enabled) return { enabled: false, run: null }

  const { data: run, error } = await supabase
    .from("billing_autopilot_runs")
    .select("*")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Unable to load Arc Autopilot: ${error.message}`)
  if (!run) return { enabled: true, run: null }

  const { data: items, error: itemsError } = await supabase
    .from("billing_autopilot_items")
    .select("*")
    .eq("org_id", orgId)
    .eq("run_id", run.id)
    .order("created_at", { ascending: true })

  if (itemsError) throw new Error(`Unable to load Arc Autopilot items: ${itemsError.message}`)
  return { enabled: true, run: mapRun(run, items ?? []) }
}

export async function prepareBillingAutopilotRun(projectId: string): Promise<BillingAutopilotState> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "billing_autopilot",
    resourceId: projectId,
  })

  const enabled = await isFeatureEnabledForOrg({
    supabase,
    orgId,
    flagKey: FLAG_KEY,
    defaultEnabled: false,
  })
  if (!enabled) throw new Error("Arc Autopilot is not enabled for this organization.")

  const [projectResult, settingsResult, drawsResult, costsResult, retainageResult, changesResult, scheduleResult] = await Promise.all([
    supabase.from("projects").select("id, status, updated_at").eq("org_id", orgId).eq("id", projectId).single(),
    supabase
      .from("project_financial_settings")
      .select("billing_model, proof_required, paid_costs_required, client_cost_approval_required, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("draw_schedules")
      .select("id, draw_number, title, amount_cents, due_date, due_trigger, milestone_id, status, metadata, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "pending"),
    supabase
      .from("billable_costs")
      .select("id, source_type, occurred_on, description, billable_cents, metadata, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "open")
      .eq("is_billable", true),
    supabase
      .from("retainage")
      .select("id, amount_cents, status, held_at, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "held"),
    supabase
      .from("change_orders")
      .select("id, title, total_cents, status, metadata, approved_at, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved"),
    supabase
      .from("schedule_items")
      .select("id, name, status, progress, updated_at")
      .eq("org_id", orgId)
      .eq("project_id", projectId),
  ])

  const queryError = [
    projectResult.error,
    settingsResult.error,
    drawsResult.error,
    costsResult.error,
    retainageResult.error,
    changesResult.error,
    scheduleResult.error,
  ].find(Boolean)
  if (queryError || !projectResult.data) {
    throw new Error(`Unable to analyze project billing: ${queryError?.message ?? "Project not found"}`)
  }

  const settings = settingsResult.data
  const billingModel =
    (settings?.billing_model as ProjectFinancialSettings["billing_model"] | undefined) ?? "fixed_price"
  const today = new Date().toISOString().slice(0, 10)
  const items: BillingAutopilotItem[] = []
  const scheduleById = new Map((scheduleResult.data ?? []).map((item) => [item.id, item]))

  if (billingModel === "fixed_price") {
    for (const draw of drawsResult.data ?? []) {
      const due = Boolean(draw.due_date && draw.due_date <= today)
      const milestone = draw.milestone_id ? scheduleById.get(draw.milestone_id) : null
      const milestoneComplete = Boolean(
        milestone &&
          (milestone.status === "completed" ||
            milestone.status === "done" ||
            Number(milestone.progress ?? 0) >= 100),
      )
      const approvalRequired = draw.due_trigger === "approval"
      const milestoneConfirmationRequired = draw.due_trigger === "milestone" && !milestoneComplete
      const ready = (draw.due_trigger === "date" && due) || (draw.due_trigger === "milestone" && milestoneComplete)
      const blockerCodes = approvalRequired
        ? ["owner_approval_required"]
        : milestoneConfirmationRequired
          ? ["progress_confirmation_required"]
          : []
      items.push({
        item_type: ready ? "draw_ready" : "draw_due",
        status: ready ? "suggested" : "needs_review",
        source_type: "draw_schedule",
        source_id: draw.id,
        title: `Draw ${draw.draw_number}: ${draw.title}`,
        description: ready
          ? draw.due_trigger === "milestone"
            ? `Linked milestone "${milestone?.name ?? "Milestone"}" is complete. Review the draw before preparing its invoice.`
            : "The scheduled billing date has arrived and this draw is not yet invoiced."
          : approvalRequired
            ? "Owner approval is still required before this draw can be invoiced."
            : milestoneConfirmationRequired
              ? `Linked milestone "${milestone?.name ?? "Milestone"}" is not complete yet.`
            : "This draw remains scheduled for a future billing date.",
        amount_cents: Number(draw.amount_cents ?? 0),
        confidence: ready ? 0.96 : 0.65,
        blocker_codes: blockerCodes,
        evidence: [{
          due_date: draw.due_date,
          due_trigger: draw.due_trigger,
          status: draw.status,
          milestone_id: draw.milestone_id,
          milestone_status: milestone?.status ?? null,
          milestone_progress: milestone?.progress ?? null,
        }],
        proposed_action: { action: "prepare_draw_invoice", draw_id: draw.id },
      })
    }
  } else {
    const costs = costsResult.data ?? []
    const proofRequired = Boolean(settings?.proof_required)
    const blockedCosts = costs.filter((cost) => proofRequired && cost.metadata?.proof_complete !== true)
    const readyCosts = costs.filter((cost) => !blockedCosts.some((blocked) => blocked.id === cost.id))
    if (readyCosts.length > 0) {
      items.push({
        item_type: "approved_unbilled_cost",
        status: "suggested",
        source_type: "billable_cost",
        title: `${readyCosts.length} approved costs ready to bill`,
        description: "Arc grouped eligible open costs into a reviewable owner-billing candidate.",
        amount_cents: readyCosts.reduce((sum, cost) => sum + Number(cost.billable_cents ?? 0), 0),
        confidence: 0.92,
        blocker_codes: [],
        evidence: readyCosts.map((cost) => ({ id: cost.id, occurred_on: cost.occurred_on, source_type: cost.source_type })),
        proposed_action: { action: "prepare_cost_invoice", cost_ids: readyCosts.map((cost) => cost.id) },
      })
    }
    if (blockedCosts.length > 0) {
      items.push({
        item_type: "missing_proof",
        status: "blocked",
        source_type: "billable_cost",
        title: `${blockedCosts.length} billable costs need backup`,
        description: "Required receipts or supporting documents are missing.",
        amount_cents: blockedCosts.reduce((sum, cost) => sum + Number(cost.billable_cents ?? 0), 0),
        confidence: 1,
        blocker_codes: ["missing_proof"],
        evidence: blockedCosts.map((cost) => ({ id: cost.id, description: cost.description })),
        proposed_action: { action: "open_cost_review", cost_ids: blockedCosts.map((cost) => cost.id) },
      })
    }
  }

  for (const change of changesResult.data ?? []) {
    if (change.metadata?.invoice_id || change.metadata?.billed_at) continue
    items.push({
      item_type: "change_order_pending",
      status: "needs_review",
      source_type: "change_order",
      source_id: change.id,
      title: change.title,
      description: "Approved change order has no recorded billing reference.",
      amount_cents: Number(change.total_cents ?? 0),
      confidence: 0.8,
      blocker_codes: ["billing_treatment_confirmation"],
      evidence: [{ approved_at: change.approved_at, status: change.status }],
      proposed_action: { action: "review_change_order_billing", change_order_id: change.id },
    })
  }

  const heldRetainage = (retainageResult.data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0)
  if (heldRetainage > 0) {
    const projectComplete = projectResult.data.status === "completed"
    items.push({
      item_type: "retainage_ready",
      status: projectComplete ? "needs_review" : "blocked",
      source_type: "retainage",
      title: projectComplete ? "Retainage may be ready for release" : "Retainage remains held",
      description: projectComplete
        ? "The project is complete. Confirm contractual closeout conditions before releasing retainage."
        : "Arc will keep retainage held until the project and contractual release conditions are confirmed.",
      amount_cents: heldRetainage,
      confidence: projectComplete ? 0.8 : 1,
      blocker_codes: ["retainage_release_confirmation"],
      evidence: [{ project_status: projectResult.data.status, held_cents: heldRetainage }],
      proposed_action: { action: "review_retainage_release" },
    })
  }

  if (items.length === 0) {
    items.push({
      item_type: "progress_confirmation",
      status: "needs_review",
      title: "No billing event is ready",
      description: "Arc found no due draw, eligible cost, approved change, or retainage release candidate.",
      amount_cents: 0,
      confidence: 1,
      blocker_codes: [],
      evidence: [{ analyzed_at: new Date().toISOString() }],
      proposed_action: { action: "none" },
    })
  }

  const blockers = items.filter((item) => item.status === "blocked" || item.blocker_codes.length > 0)
  const readyItems = items.filter((item) => item.status === "suggested")
  const proposedCents = readyItems.reduce((sum, item) => sum + item.amount_cents, 0)
  const readinessScore = Math.max(0, Math.round((readyItems.length / Math.max(items.length, 1)) * 100 - blockers.length * 10))
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      project: projectResult.data.updated_at,
      settings: settings?.updated_at,
      draws: (drawsResult.data ?? []).map((row) => [row.id, row.updated_at]),
      costs: (costsResult.data ?? []).map((row) => [row.id, row.updated_at]),
      retainage: (retainageResult.data ?? []).map((row) => [row.id, row.updated_at]),
      changes: (changesResult.data ?? []).map((row) => [row.id, row.updated_at]),
      schedule: (scheduleResult.data ?? []).map((row) => [row.id, row.updated_at]),
    }))
    .digest("hex")

  const { data: run, error: runError } = await supabase
    .from("billing_autopilot_runs")
    .upsert({
      org_id: orgId,
      project_id: projectId,
      billing_model: billingModel,
      status: "prepared",
      proposed_invoice_cents: proposedCents,
      readiness_score: readinessScore,
      blocker_count: blockers.length,
      summary: {
        ready_item_count: readyItems.length,
        review_item_count: items.filter((item) => item.status === "needs_review").length,
        blocked_item_count: items.filter((item) => item.status === "blocked").length,
        experimental: true,
      },
      idempotency_key: `billing-autopilot:${projectId}:${fingerprint}`,
      prepared_by: userId,
    }, { onConflict: "org_id,idempotency_key" })
    .select("*")
    .single()

  if (runError || !run) throw new Error(`Unable to save Arc Autopilot run: ${runError?.message}`)

  const { count } = await supabase
    .from("billing_autopilot_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id)
  if (!count) {
    const { error: itemError } = await supabase.from("billing_autopilot_items").insert(
      items.map((item) => ({
        ...item,
        org_id: orgId,
        project_id: projectId,
        run_id: run.id,
      })),
    )
    if (itemError) throw new Error(`Unable to save Arc Autopilot findings: ${itemError.message}`)
  }

  return getBillingAutopilotState(projectId)
}

function mapRun(run: any, items: any[]): BillingAutopilotRun {
  return {
    id: run.id,
    billing_model: run.billing_model,
    status: run.status,
    proposed_invoice_cents: Number(run.proposed_invoice_cents ?? 0),
    readiness_score: Number(run.readiness_score ?? 0),
    blocker_count: Number(run.blocker_count ?? 0),
    summary: run.summary ?? {},
    created_at: run.created_at,
    items: items.map((item) => ({
      ...item,
      amount_cents: Number(item.amount_cents ?? 0),
      confidence: item.confidence == null ? null : Number(item.confidence),
      blocker_codes: item.blocker_codes ?? [],
      evidence: item.evidence ?? [],
      proposed_action: item.proposed_action ?? {},
    })),
  }
}
