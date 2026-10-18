import { z } from "zod"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { MobileAPIError } from "@/lib/mobile/api"
import { field, section, type Action } from "@/lib/mobile/workspace-detail"
import { parseWorkspaceRows } from "@/lib/mobile/workspace-authoring"
import { estimateInputSchema } from "@/lib/validation/estimates"
import { DEFAULT_ESTIMATE_COMMERCIAL, canIssueEstimate } from "@/lib/financials/estimate-commercial"

import { budgetDraftFields } from "@/lib/mobile/workspace-estimate-fields"

type Snapshot = Extract<Awaited<ReturnType<typeof import("@/app/(app)/estimates/actions").getEstimateForEditAction>>, { success: true }>["data"]
const numeric = (value: unknown, fallback = 0) => value === "" || value == null ? fallback : Number(value)

export function parseBudgetDraft(values: Record<string, unknown>, previous?: Snapshot) {
  const ids = new Set<string>()
  const lines = parseWorkspaceRows(values.lines).map(row => {
    const existing = row.id ? previous?.lines.find(line => line.id === row.id) : undefined
    if (row.id && (!existing || ids.has(row.id))) throw new MobileAPIError(422, "invalid_estimate_line", "An estimate line is unavailable or repeated. Reopen the draft.")
    if (row.id) ids.add(row.id)
    const quantity = z.number().finite().min(0).max(1_000_000).parse(numeric(row.quantity))
    const unit_cost_cents = Math.round(z.number().finite().min(-1_000_000_000).max(1_000_000_000).parse(numeric(row.unit_price)) * 100)
    if (!Number.isSafeInteger(Math.round(quantity * unit_cost_cents))) throw new MobileAPIError(422, "amount_too_large", "An estimate line amount is too large.")
    return {
      description: z.string().trim().min(1).max(1000).parse(row.description), quantity, unit_cost_cents,
      unit: row.unit, markup_pct: z.number().finite().min(0).max(100).parse(numeric(row.markup_pct)),
      notes: row.notes, is_optional: row.is_optional === "true", is_allowance: row.is_allowance === "true",
      // Accounting and takeoff/bid provenance comes only from the original server line.
      cost_code_id: existing?.cost_code_id ?? undefined, item_type: existing?.item_type ?? "line",
      option_group: existing?.option_group ?? undefined, source_bid_submission_id: existing?.metadata?.source_bid_submission_id,
      metadata: existing?.metadata,
    }
  })
  const money = (value: unknown, fallback = 0) => value === undefined ? fallback : Math.round(z.number().finite().min(0).max(1_000_000_000).parse(numeric(value)) * 100)
  const purpose = previous?.precon.purpose ?? z.enum(["budget", "preconstruction_agreement"]).parse(values.purpose ?? "budget")
  const recipientChanged = previous && ((values.recipient_name || null) !== previous.recipient_name || (values.recipient_email || null) !== previous.recipient_email)
  return estimateInputSchema.parse({
    title: values.title, summary: values.summary, recipient_name: values.recipient_name || undefined,
    recipient_email: values.recipient_email || undefined, recipient_contact_id: recipientChanged ? null : previous?.recipient_contact_id,
    valid_until: values.valid_until ? z.string().date().parse(values.valid_until) : undefined,
    tax_rate: z.number().finite().min(0).max(20).parse(numeric(values.tax_rate)),
    contingency_percent: z.number().finite().min(0).max(100).parse(numeric(values.contingency_percent)),
    inclusions: values.inclusions, exclusions: values.exclusions,
    terms: values.terms ?? previous?.terms, intro: previous?.intro, pricing_display: previous?.pricing_display,
    photos: previous?.photos, markup_percent: previous?.markup_percent,
    precon: { ...(previous?.precon ?? { ...DEFAULT_ESTIMATE_COMMERCIAL, maturity: "conceptual" }), purpose,
      maturity: values.maturity ?? previous?.precon.maturity ?? "conceptual",
      billing_model: values.billing_model ?? previous?.precon.billing_model ?? "fixed_price",
      fixed_fee_cents: money(values.fixed_fee, previous?.precon.fixed_fee_cents), gmp_cents: money(values.gmp, previous?.precon.gmp_cents),
      retainage_percent: z.number().finite().min(0).max(100).parse(numeric(values.retainage_percent, previous?.precon.retainage_percent ?? 0)),
      payment_terms: values.payment_terms ?? previous?.precon.payment_terms ?? "", allowance_policy: values.allowance_policy ?? previous?.precon.allowance_policy ?? "",
      contingency_treatment: values.contingency_treatment ?? previous?.precon.contingency_treatment ?? "included_in_price",
      pricing_basis: values.pricing_basis ?? "" }, lines,
  })
}

export async function createWorkspaceBudget(context: MobileOrgContext, projectId: string, values: Record<string, unknown>) {
  const { data: project, error } = await context.serviceSupabase.from("projects").select("id,prospect_id").eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (error || !project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  const input = parseBudgetDraft(values)
  return (await import("@/lib/services/estimates")).createEstimate({ ...input, orgId: context.orgId, project_id: projectId, prospect_id: project.prospect_id, lines: input.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })) })
}

async function loadDocument(context: MobileOrgContext, projectId: string, recordId: string) {
  const { data: document, error } = await context.serviceSupabase.from("estimates")
    .select("id,project_id,status,sent_at,is_current_version,client_signed_at,executed_at,metadata,updated_at")
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", recordId).maybeSingle()
  if (error || !document) throw new MobileAPIError(404, "estimate_not_found", "Estimate not found in this project.")
  const result = await (await import("@/app/(app)/estimates/actions")).getEstimateForEditAction(recordId)
  if (!result.success) throw new MobileAPIError(422, "estimate_unavailable", result.error)
  return { document, snapshot: result.data }
}

export async function loadEstimateDetail(context: MobileOrgContext, projectId: string, recordId: string) {
  const { document, snapshot } = await loadDocument(context, projectId, recordId)
  const actions: Action[] = [{ id: "preview-estimate", title: "View PDF", fields: [] }]
  const sections = [section("estimate-lines", "Estimate Lines", snapshot.lines, ["description"], [field("quantity", "Quantity", "number"), field("unit", "Unit"), field("unit_cost_cents", "Unit cost", "money"), field("markup_pct", "Markup (%)", "number"), field("is_optional", "Optional"), field("is_allowance", "Allowance")])]
  if (document.status === "draft" && !document.sent_at && document.is_current_version !== false) {
    const values: Record<string, string> = { maturity: snapshot.precon.maturity, billing_model: snapshot.precon.billing_model, fixed_fee: String(snapshot.precon.fixed_fee_cents / 100), gmp: String(snapshot.precon.gmp_cents / 100), retainage_percent: String(snapshot.precon.retainage_percent), payment_terms: snapshot.precon.payment_terms, allowance_policy: snapshot.precon.allowance_policy, terms: snapshot.terms, contingency_treatment: snapshot.precon.contingency_treatment, title: snapshot.title, summary: snapshot.summary, recipient_name: snapshot.recipient_name ?? "", recipient_email: snapshot.recipient_email ?? "", valid_until: snapshot.valid_until ?? "", pricing_basis: snapshot.precon.pricing_basis, inclusions: snapshot.inclusions, exclusions: snapshot.exclusions, tax_rate: String(snapshot.tax_rate), contingency_percent: String(snapshot.contingency_percent), lines: JSON.stringify(snapshot.lines.map(line => ({ id: line.id, description: line.description, quantity: String(line.quantity), unit: line.unit ?? "", unit_price: String(line.unit_cost_cents / 100), markup_pct: String(line.markup_pct), is_optional: String(line.is_optional), is_allowance: String(line.is_allowance), notes: String(line.metadata?.notes ?? "") }))) }
    actions.push({ id: "edit-budget-draft", title: "Edit Document Draft", revision: document.updated_at, fields: budgetDraftFields.filter(f => f.key !== "purpose").map(f => ({ ...f, value: values[f.key] })) })
  }
  if (document.status === "approved" && document.is_current_version !== false && snapshot.precon.purpose === "budget") actions.push({ id: "prepare-agreement", title: "Create Agreement Draft from Approved Budget", revision: document.updated_at, fields: [] })
  if (canIssueEstimate(document) && snapshot.recipient_email) actions.push({ id: "send-estimate", title: `Send to ${snapshot.recipient_email}`, revision: document.updated_at, fields: [field("message", "Message to recipient", "multiline")] })
  if (document.is_current_version !== false && ["sent", "changes_requested", "rejected"].includes(document.status)) actions.push({ id: "revise-estimate", title: "Create Revised Draft", revision: document.updated_at, fields: [] })
  return { actions, sections }
}

export async function performEstimateAction(context: MobileOrgContext, projectId: string, recordId: string, actionId: string, values: Record<string, string>, revision?: string) {
  const { document, snapshot } = await loadDocument(context, projectId, recordId)
  if (document.updated_at !== revision) throw new MobileAPIError(409, "estimate_changed", "This estimate changed. Reopen it before continuing.")
  if (actionId === "edit-budget-draft") {
    return (await import("@/lib/services/estimates")).saveEstimateDraft({ estimateId: recordId, expectedUpdatedAt: revision!, input: parseBudgetDraft(values, snapshot) })
  }
  if (actionId === "prepare-agreement") {
    const seed = await (await import("@/app/(app)/estimates/actions")).prepareConstructionAgreementDraftAction(recordId)
    if (!seed.success) throw new MobileAPIError(422, "agreement_unavailable", seed.error)
    const parsed = estimateInputSchema.parse(seed.data)
    const { data: parent, error } = await context.serviceSupabase.from("estimates").select("project_id,prospect_id").eq("org_id", context.orgId).eq("id", recordId).single()
    if (error || !parent || parent.project_id !== projectId) throw new MobileAPIError(404, "estimate_not_found", "Estimate not found in this project.")
    return (await import("@/lib/services/estimates")).createEstimate({ ...parsed, project_id: projectId, prospect_id: parent.prospect_id, orgId: context.orgId, lines: parsed.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })) })
  }
  if (actionId === "send-estimate") return (await import("@/lib/services/estimate-portal")).sendEstimate({ estimateId: recordId, orgId: context.orgId, message: values.message })
  if (actionId === "revise-estimate") return (await import("@/lib/services/estimates")).reviseEstimate({ estimateId: recordId, orgId: context.orgId })
  throw new MobileAPIError(405, "action_unavailable", "This estimate action is not available.")
}
