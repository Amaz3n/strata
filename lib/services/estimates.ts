import { estimateAlternateIssue, normalizeCommercialEstimateLines, calculateCommercialEstimateTotals, type EstimateCommercial } from "@/lib/financials/estimate-commercial"
import { z } from "zod"
import type { ProposalDocument } from "@/lib/precon/proposal-documents"
import { authorizeEstimateDocumentWrite } from "./estimate-document-authorization"
import { normalizeEstimateCommercial } from "@/lib/financials/estimate-commercial"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const estimateLineSchema = z.object({
  cost_code_id: z.string().uuid().optional(),
  item_type: z.enum(["line", "group"]).default("line"),
  description: z.string().min(1),
  quantity: z.number().min(0).default(1),
  unit: z.string().optional(),
  unit_cost_cents: z.number().int().default(0),
  markup_pct: z.number().default(0),
  sort_order: z.number().int().default(0),
  notes: z.string().optional(),
  /** Client-selectable upgrade/add-on; excluded from the base total. */
  is_optional: z.boolean().optional(),
  /** Allowance line: included in the total as a placeholder budget the client can reallocate. */
  is_allowance: z.boolean().optional(),
  /** Optional add-ons sharing a group label are mutually exclusive alternates. */
  option_group: z.string().trim().max(80).optional(),
  /** Sub bid this line's cost basis was pulled from (estimate builder "Use bid"). */
  source_bid_submission_id: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
}).superRefine((line, context) => {
  const issue = estimateAlternateIssue(line)
  if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["unit_cost_cents"] })
})

type EstimateLine = z.infer<typeof estimateLineSchema>

/**
 * Builds the persisted `metadata` jsonb for an estimate line, folding the
 * structured `notes`/`is_optional` fields into the bag the portal/PDF read from.
 */
function buildLineMetadata(line: EstimateLine): Record<string, any> {
  const metadata: Record<string, any> = { ...(line.metadata ?? {}) }
  const notes = stripNul(line.notes)
  if (notes) metadata.notes = notes
  else delete metadata.notes
  if (line.is_optional) metadata.is_optional = true
  else delete metadata.is_optional
  if (line.is_allowance) {
    metadata.is_allowance = true
    // The allowance amount is the line's extended price — recorded explicitly
    // so downstream reconciliation (budget, change orders) has a fixed number.
    metadata.allowance_cents = Math.round((line.unit_cost_cents ?? 0) * (line.quantity ?? 1))
  } else {
    delete metadata.is_allowance
    delete metadata.allowance_cents
  }
  if (line.is_optional && line.option_group) metadata.option_group = stripNul(line.option_group)
  else delete metadata.option_group
  if (line.source_bid_submission_id) metadata.source_bid_submission_id = line.source_bid_submission_id
  else delete metadata.source_bid_submission_id
  return metadata
}

/** Maps parsed lines to `estimate_items` insert rows for a given estimate. */
function buildItemsPayload(orgId: string, estimateId: string, lines: EstimateLine[]) {
  return lines.map((line, idx) => ({
    org_id: orgId,
    estimate_id: estimateId,
    cost_code_id: line.cost_code_id ?? null,
    item_type: line.item_type ?? "line",
    description: stripNul(line.description),
    quantity: line.quantity ?? 1,
    unit: stripNul(line.unit) ?? null,
    unit_cost_cents: line.unit_cost_cents ?? 0,
    markup_pct: line.markup_pct ?? 0,
    sort_order: line.sort_order ?? idx,
    metadata: buildLineMetadata(line),
  }))
}

/**
 * Folds the presentation extras (per-estimate cover note, pricing display mode,
 * portal photo gallery) into the estimate `metadata` jsonb. Omits empty values
 * so existing rows stay clean.
 */
function buildPresentationMetadata(input: {
  intro?: string | null
  pricing_display?: string | null
  photos?: Array<{ path: string; caption?: string | null }> | null
}): Record<string, any> {
  const metadata: Record<string, any> = {}
  const intro = stripNul(input.intro)
  if (intro) metadata.intro = intro
  if (input.pricing_display && input.pricing_display !== "itemized") {
    metadata.display = { pricing: input.pricing_display }
  }
  if (input.photos && input.photos.length > 0) {
    metadata.photos = input.photos.map((photo) => ({
      path: photo.path,
      caption: stripNul(photo.caption) ?? null,
    }))
  }
  return metadata
}

// Postgres text and jsonb columns cannot store NUL (U+0000) characters; pasted
// content and some org templates can contain them, which surfaces as a
// "unsupported Unicode escape sequence" insert error. Strip them defensively.
function stripNul(value: string): string
function stripNul(value: string | null | undefined): string | null | undefined
function stripNul(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.split(String.fromCharCode(0)).join("") : value
}

const calculateTotals = calculateCommercialEstimateTotals

export async function createEstimate({
  precon,
  proposal,
  source_budget_estimate_id,
  pricing_worksheet_snapshot,
  project_id,
  prospect_id,
  recipient_contact_id,
  recipient_name,
  recipient_email,
  title,
  summary,
  terms,
  intro,
  pricing_display,
  photos,
  valid_until,
  tax_rate,
  markup_percent,
  contingency_percent,
  inclusions,
  exclusions,
  lines,
  orgId,
}: {
  precon?: EstimateCommercial
  /** A deal proposal's resolved sections; see lib/precon/proposal-documents. */
  proposal?: ProposalDocument
  source_budget_estimate_id?: string
  pricing_worksheet_snapshot?: { version: number; fingerprint: string; proposal_fingerprint?: string; range?: { low_cents: number; high_cents: number } }
  project_id?: string | null
  prospect_id?: string | null
  recipient_contact_id?: string | null
  recipient_name?: string | null
  recipient_email?: string | null
  title: string
  summary?: string
  terms?: string
  intro?: string
  pricing_display?: string
  photos?: Array<{ path: string; caption?: string | null }>
  valid_until?: string
  tax_rate?: number
  markup_percent?: number
  contingency_percent?: number
  inclusions?: string
  exclusions?: string
  lines: z.infer<typeof estimateLineSchema>[]
  orgId?: string
}) {
  const parsedLines = normalizeCommercialEstimateLines(estimateLineSchema.array().min(1).parse(lines), precon)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const totals = calculateTotals(parsedLines, tax_rate ?? 0, contingency_percent ?? 0, precon)

  // A prospect that has entered pricing owns a precon-phase project; estimates
  // land on it so takeoff conditions can sync into them before the job is won.
  let resolvedProjectId = project_id ?? null
  if (!resolvedProjectId && prospect_id) {
    const { data: preconProject, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("prospect_id", prospect_id)
      .eq("phase", "precon")
      .maybeSingle()
    if (projectError) throw new Error(`Unable to verify the pricing workspace: ${projectError.message}`)
    resolvedProjectId = preconProject?.id ?? null
  }

  if (prospect_id && !resolvedProjectId) {
    const { data: prospect, error } = await supabase.from("prospects").select("id").eq("org_id", resolvedOrgId).eq("id", prospect_id).maybeSingle()
    if (error || !prospect) throw new Error("Prospect not found in this organization.")
  }
  const advancesConstructionPricing = precon?.purpose !== "preconstruction_agreement"

  let sourceBudget: Record<string, any> | null = null
  if (source_budget_estimate_id) {
    const { data: source, error: sourceError } = await supabase.from("estimates")
      .select("id, version, org_id, project_id, prospect_id, status, metadata, is_current_version")
      .eq("org_id", resolvedOrgId).eq("id", source_budget_estimate_id).single()
    if (sourceError || !source || source.status !== "approved" || source.is_current_version === false || source.metadata?.precon?.purpose !== "budget" ||
        source.prospect_id !== (prospect_id ?? null) || source.project_id !== resolvedProjectId) {
      throw new Error("Prepare the agreement from an approved budget belonging to this opportunity.")
    }
    sourceBudget = { estimate_id: source.id, version: source.version, accepted_options: source.metadata?.accepted_options ?? null }
  }

  const { data: estimate, error: estimateError } = await supabase
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: resolvedProjectId,
      prospect_id: prospect_id ?? null,
      recipient_contact_id: recipient_contact_id ?? null,
      title: stripNul(title),
      status: "draft",
      version: 1,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
      valid_until: valid_until ?? null,
      metadata: {
        ...(pricing_worksheet_snapshot ? { pricing_worksheet: pricing_worksheet_snapshot } : {}),
        ...(precon ? { precon } : {}),
        ...(proposal ? { proposal } : {}),
        ...(sourceBudget ? { source_budget: sourceBudget } : {}),
        tax_rate: tax_rate ?? 0,
        markup_percent: markup_percent ?? 0,
        contingency_percent: contingency_percent ?? 0,
        inclusions: stripNul(inclusions) ?? null,
        exclusions: stripNul(exclusions) ?? null,
        summary: stripNul(summary) ?? null,
        terms: stripNul(terms) ?? null,
        recipient:
          recipient_name || recipient_email
            ? { name: stripNul(recipient_name) ?? null, email: stripNul(recipient_email) ?? null }
            : null,
        ...buildPresentationMetadata({ intro, pricing_display, photos }),
      },
      created_by: userId,
    })
    .select("*")
    .single()

  if (estimateError || !estimate) {
    throw new Error(`Failed to create estimate: ${estimateError?.message}`)
  }

  const itemsPayload = buildItemsPayload(resolvedOrgId, estimate.id, parsedLines)

  const { error: lineError } = await supabase.from("estimate_items").insert(itemsPayload)
  if (lineError) {
    throw new Error(`Failed to create estimate lines: ${lineError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: estimate.id,
    after: { ...estimate, items: itemsPayload },
  })

  // A services agreement has its own lifecycle; it cannot qualify construction.
  if (prospect_id && advancesConstructionPricing) {
    await updateProspectStatusOnEstimateCreation({
      supabase,
      orgId: resolvedOrgId,
      prospectId: prospect_id,
      estimateId: estimate.id,
      estimateTitle: title,
    })
  }

  return { estimate, items: itemsPayload }
}

async function updateProspectStatusOnEstimateCreation({
  supabase,
  orgId,
  prospectId,
  estimateId,
  estimateTitle,
}: {
  supabase: any
  orgId: string
  prospectId: string
  estimateId: string
  estimateTitle: string
}) {
  try {
    const { data: prospect } = await supabase
      .from("prospects")
      .select("id, name, status")
      .eq("org_id", orgId)
      .eq("id", prospectId)
      .maybeSingle()

    if (!prospect || !["new", "contacted", "qualified"].includes(prospect.status)) return

    await supabase
      .from("prospects")
      .update({ status: "pricing", updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("id", prospectId)

    await recordEvent({
      orgId,
      eventType: "prospect_estimate_created",
      entityType: "prospect",
      entityId: prospectId,
      payload: {
        name: prospect.name,
        estimate_id: estimateId,
        estimate_title: estimateTitle,
        old_status: prospect.status,
        new_status: "pricing",
      },
    })
  } catch (error) {
    console.error("Failed to update prospect status on estimate creation:", error)
  }
}

export async function updateEstimateStatus({
  estimateId,
  status,
  orgId,
}: {
  estimateId: string
  status: "draft" | "sent" | "approved" | "rejected"
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  // Signed/executed estimates are legal documents — their status can only move
  // through the e-sign pipeline, never through this manual bookkeeping path.
  const { data, error } = await supabase
    .from("estimates")
    .update({ status })
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .not("status", "in", '("client_signed","executed","converted_to_project")')
    .select("*")
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to update estimate status: ${error.message}`)
  }
  if (!data) {
    throw new Error("This estimate has been signed and its status can no longer be changed manually.")
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "estimate",
    entityId: estimateId,
    after: data,
  })

  return data
}

export async function duplicateEstimate({ estimateId, orgId }: { estimateId: string; orgId?: string }) {
  const supabase = createServiceSupabaseClient()
  const { supabase: scoped, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase: scoped, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("estimates")
    .select("*, items:estimate_items(*)")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (!existing) {
    throw new Error("Estimate not found")
  }

  const newVersion = (existing.version ?? 1) + 1

  const { data: newEstimate, error: estimateError } = await scoped
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: existing.project_id,
      prospect_id: existing.prospect_id ?? null,
      title: `${existing.title} (v${newVersion})`,
      status: "draft",
      version: newVersion,
      subtotal_cents: existing.subtotal_cents,
      tax_cents: existing.tax_cents,
      total_cents: existing.total_cents,
      currency: existing.currency,
      metadata: { ...existing.metadata, accepted_options: undefined, estimate_execution: undefined, signing_withdrawal: undefined, duplicated_from: estimateId },
      created_by: userId,
    })
    .select("*")
    .single()

  if (estimateError || !newEstimate) {
    throw new Error(`Failed to duplicate estimate: ${estimateError?.message}`)
  }

  const items = (existing as any).items ?? []
  if (items.length > 0) {
    const insertItems = items.map((item: any) => ({
      org_id: resolvedOrgId,
      estimate_id: newEstimate.id,
      cost_code_id: item.cost_code_id ?? null,
      item_type: item.item_type ?? "line",
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_cost_cents: item.unit_cost_cents,
      markup_pct: item.markup_pct,
      sort_order: item.sort_order,
      metadata: item.metadata ?? {},
    }))
    const { error: itemError } = await scoped.from("estimate_items").insert(insertItems)
    if (itemError) {
      throw new Error(`Failed to duplicate estimate lines: ${itemError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: newEstimate.id,
    after: newEstimate,
  })

  return newEstimate
}

/**
 * Creates the next version of an estimate within the same version family.
 * Used after a client requests changes: the builder revises and re-sends a fresh
 * draft while the prior version is preserved (read-only) for history.
 */
async function finalizeEstimateRevision(client: ReturnType<typeof createServiceSupabaseClient>, orgId: string, existing: any, newEstimateId: string) {
  const { data, error } = await client.from("estimates").update({ is_current_version: false })
    .eq("org_id", orgId).eq("id", existing.id).eq("status", existing.status)
    .eq("is_current_version", existing.is_current_version !== false).select("id").maybeSingle()
  if (error || !data) {
    // Only the unpublished draft produced by this call is removed. A concurrent
    // client signature or another revision remains untouched.
    const service = createServiceSupabaseClient()
    await service.from("estimate_items").delete().eq("org_id", orgId).eq("estimate_id", newEstimateId)
    await service.from("estimates").delete().eq("org_id", orgId).eq("id", newEstimateId).eq("status", "draft")
    throw new Error("This estimate changed while revising. Refresh and review its latest decision before continuing.")
  }
}

export async function reviseEstimate({ estimateId, orgId }: { estimateId: string; orgId?: string }) {
  const supabase = createServiceSupabaseClient()
  const { supabase: scoped, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase: scoped, orgId: resolvedOrgId, userId })

  const { data: existing, error: loadError } = await supabase
    .from("estimates")
    .select("*, items:estimate_items(*)")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (loadError || !existing) {
    throw new Error("Estimate not found")
  }

  if (["executed", "converted_to_project"].includes(existing.status) || (existing.status === "client_signed" && !existing.metadata?.signing_withdrawal)) {
    throw new Error("This estimate has been signed. Complete or withdraw its signing process before creating another agreement; executed changes require a change order.")
  }

  if (existing.is_current_version === false) {
    if (!existing.metadata?.signing_withdrawal) throw new Error("Revise the current estimate version.")
    const { data: successor } = await scoped.from("estimates").select("*").eq("org_id", resolvedOrgId)
      .eq("supersedes_estimate_id", existing.id).eq("is_current_version", true).maybeSingle()
    if (successor) return successor
  }

  const versionGroupId = (existing.version_group_id as string | null) ?? existing.id
  const newVersion = (existing.version ?? 1) + 1

  const { data: newEstimate, error: insertError } = await scoped
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: existing.project_id,
      prospect_id: existing.prospect_id ?? null,
      opportunity_id: existing.opportunity_id,
      recipient_contact_id: existing.recipient_contact_id,
      title: existing.title,
      status: "draft",
      version: newVersion,
      version_group_id: versionGroupId,
      supersedes_estimate_id: existing.id,
      is_current_version: true,
      subtotal_cents: existing.subtotal_cents,
      tax_cents: existing.tax_cents,
      total_cents: existing.total_cents,
      currency: existing.currency,
      valid_until: existing.valid_until,
      metadata: { ...existing.metadata, accepted_options: undefined, estimate_execution: undefined, signing_withdrawal: undefined },
      created_by: userId,
    })
    .select("*")
    .single()

  if (insertError || !newEstimate) {
    throw new Error(`Failed to revise estimate: ${insertError?.message}`)
  }

  const items = (existing as any).items ?? []
  if (items.length > 0) {
    const insertItems = items.map((item: any) => ({
      org_id: resolvedOrgId,
      estimate_id: newEstimate.id,
      cost_code_id: item.cost_code_id ?? null,
      item_type: item.item_type ?? "line",
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_cost_cents: item.unit_cost_cents,
      markup_pct: item.markup_pct,
      sort_order: item.sort_order,
      metadata: item.metadata ?? {},
    }))
    const { error: itemError } = await scoped.from("estimate_items").insert(insertItems)
    if (itemError) {
      throw new Error(`Failed to copy estimate lines: ${itemError.message}`)
    }
  }

  // Mark the prior version as superseded so the portal/list show the latest as current.
  await finalizeEstimateRevision(scoped, resolvedOrgId, existing, newEstimate.id)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: newEstimate.id,
    after: { ...newEstimate, supersedes: existing.id },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_revised",
    entityType: "estimate",
    entityId: newEstimate.id,
    payload: { version: newVersion, supersedes_estimate_id: existing.id, title: newEstimate.title },
  })

  return newEstimate
}

/**
 * Creates the next version of an estimate from edited input. Unlike {@link reviseEstimate}
 * (which clones the prior version verbatim), this persists the builder's edited title,
 * recipient, terms and line items — used when the builder revises in response to a client
 * change request. The prior version is preserved (read-only) and marked superseded.
 */
export async function createEstimateVersion({
  estimateId,
  input,
  orgId,
}: {
  estimateId: string
  input: {
    title: string
    pricing_worksheet_snapshot?: { version: number; fingerprint: string; proposal_fingerprint?: string; range?: { low_cents: number; high_cents: number } }
    precon?: EstimateCommercial
    proposal?: ProposalDocument
    recipient_contact_id?: string | null
    recipient_name?: string | null
    recipient_email?: string | null
    summary?: string
    terms?: string
    intro?: string
    pricing_display?: string
    photos?: Array<{ path: string; caption?: string | null }>
    valid_until?: string
    tax_rate?: number
    markup_percent?: number
    contingency_percent?: number
    inclusions?: string
    exclusions?: string
    lines: z.infer<typeof estimateLineSchema>[]
  }
  orgId?: string
}) {
  let parsedLines = estimateLineSchema.array().min(1).parse(input.lines)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: loadError } = await supabase
    .from("estimates")
    .select("id, project_id, prospect_id, opportunity_id, status, is_current_version, version, version_group_id, currency, metadata")
    .eq("id", estimateId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (loadError || !existing) {
    throw new Error("Estimate not found")
  }

  if (["executed", "converted_to_project"].includes(existing.status as string) || (existing.status === "client_signed" && !(existing.metadata as any)?.signing_withdrawal)) {
    throw new Error("This estimate has been signed. Complete or withdraw its signing process before creating another agreement; executed changes require a change order.")
  }

  if (existing.is_current_version === false) throw new Error("Revise the current estimate version.")

  const versionGroupId = (existing.version_group_id as string | null) ?? existing.id
  const newVersion = (existing.version ?? 1) + 1
  const commercial = input.precon ?? (existing.metadata as any)?.precon
  parsedLines = normalizeCommercialEstimateLines(parsedLines, commercial)
  const totals = calculateTotals(parsedLines, input.tax_rate ?? 0, input.contingency_percent ?? 0, commercial)
  const existingMetadata = (existing.metadata as Record<string, any> | null) ?? {}

  const { data: newEstimate, error: insertError } = await supabase
    .from("estimates")
    .insert({
      org_id: resolvedOrgId,
      project_id: existing.project_id,
      prospect_id: existing.prospect_id ?? null,
      opportunity_id: existing.opportunity_id,
      recipient_contact_id: input.recipient_contact_id ?? null,
      title: stripNul(input.title),
      status: "draft",
      version: newVersion,
      version_group_id: versionGroupId,
      supersedes_estimate_id: existing.id,
      is_current_version: true,
      subtotal_cents: totals.subtotal,
      tax_cents: totals.tax,
      total_cents: totals.total,
      currency: existing.currency,
      valid_until: input.valid_until ?? null,
      metadata: {
        ...existingMetadata,
        ...(input.pricing_worksheet_snapshot ? { pricing_worksheet: input.pricing_worksheet_snapshot } : {}),
        accepted_options: undefined,
        signing_withdrawal: undefined,
        estimate_execution: undefined,
        precon: input.precon ?? existingMetadata.precon,
        // Each version carries its own proposal; a revision without one has none.
        proposal: input.proposal ?? null,
        tax_rate: input.tax_rate ?? 0,
        markup_percent: input.markup_percent ?? 0,
        contingency_percent: input.contingency_percent ?? 0,
        inclusions: stripNul(input.inclusions) ?? null,
        exclusions: stripNul(input.exclusions) ?? null,
        summary: stripNul(input.summary) ?? null,
        terms: stripNul(input.terms) ?? null,
        recipient:
          input.recipient_name || input.recipient_email
            ? { name: stripNul(input.recipient_name) ?? null, email: stripNul(input.recipient_email) ?? null }
            : existingMetadata.recipient ?? null,
        // Reset presentation fields from the revision input (drop stale intro/display/photos).
        intro: null,
        display: null,
        photos: null,
        ...buildPresentationMetadata({
          intro: input.intro,
          pricing_display: input.pricing_display,
          photos: input.photos,
        }),
      },
      created_by: userId,
    })
    .select("*")
    .single()

  if (insertError || !newEstimate) {
    throw new Error(`Failed to revise estimate: ${insertError?.message}`)
  }

  const itemsPayload = buildItemsPayload(resolvedOrgId, newEstimate.id, parsedLines)

  const { error: itemError } = await supabase.from("estimate_items").insert(itemsPayload)
  if (itemError) {
    throw new Error(`Failed to save revised estimate lines: ${itemError.message}`)
  }

  // Mark the prior version as superseded so the portal/list show the latest as current.
  await finalizeEstimateRevision(supabase, resolvedOrgId, existing, newEstimate.id)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "estimate",
    entityId: newEstimate.id,
    after: { ...newEstimate, supersedes: existing.id },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "estimate_revised",
    entityType: "estimate",
    entityId: newEstimate.id,
    payload: { version: newVersion, supersedes_estimate_id: existing.id, title: newEstimate.title },
  })

  return newEstimate
}



/** Withdraw the pending offer without erasing the client's signature evidence. */
export async function withdrawSignedEstimateForRevision({ estimateId, reason, orgId }: { estimateId: string; reason: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })
  if (reason.trim().length < 5) throw new Error("Explain why this pending agreement is being withdrawn.")
  const { data: existing, error } = await supabase.from("estimates").select("*")
    .eq("org_id", resolvedOrgId).eq("id", estimateId).single()
  if (error || !existing) throw new Error("Estimate not found")
  if (existing.status !== "client_signed") throw new Error("Only an agreement awaiting builder signature can be withdrawn here. Executed changes require a change order.")
  const metadata = { ...(existing.metadata ?? {}), signing_withdrawal: { reason: reason.trim(), withdrawn_at: new Date().toISOString(), withdrawn_by: userId } }
  // The compare-and-set races safely with execution: execution also requires
  // current=true and client_signed at its final write.
  const { data: withdrawn, error: withdrawError } = await supabase.from("estimates")
    .update({ is_current_version: false, metadata }).eq("id", estimateId).eq("org_id", resolvedOrgId)
    .eq("status", "client_signed").select("id").maybeSingle()
  if (withdrawError || !withdrawn) throw new Error("This agreement changed while withdrawing. Refresh before continuing.")
  const { data: envelopes, error: envelopeError } = await supabase.from("envelopes")
    .select("id, document_id").eq("org_id", resolvedOrgId).eq("source_entity_type", "estimate")
    .eq("source_entity_id", estimateId).in("status", ["draft", "sent", "partially_signed"])
  if (envelopeError) throw new Error(`Agreement withdrawn; retry to cancel its signing delivery: ${envelopeError.message}`)
  for (const envelope of envelopes ?? []) {
    const { error: voidError } = await supabase.from("envelopes").update({ status: "voided", updated_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId).eq("id", envelope.id).in("status", ["draft", "sent", "partially_signed"])
    if (voidError) throw new Error(`Agreement withdrawn; signing delivery needs retry: ${voidError.message}`)
    const { error: requestError } = await supabase.from("document_signing_requests").update({ status: "voided" })
      .eq("org_id", resolvedOrgId).eq("document_id", envelope.document_id).in("status", ["draft", "sent", "viewed"])
    if (requestError) throw new Error(`Agreement withdrawn; signing request needs retry: ${requestError.message}`)
  }
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "estimate_signing_withdrawn", entityType: "estimate", entityId: estimateId, payload: { reason: reason.trim() } })
  return reviseEstimate({ estimateId, orgId: resolvedOrgId })
}

/** Autosave edits to the current draft without issuing or creating another version. */
export async function saveEstimateDraft({ estimateId, expectedUpdatedAt, input }: {
  estimateId: string
  expectedUpdatedAt: string
  input: import("@/lib/validation/estimates").EstimateInput
}) {
  const { orgId, service, document } = await authorizeEstimateDocumentWrite(estimateId)
  if (normalizeEstimateCommercial(document.metadata).purpose !== normalizeEstimateCommercial({ precon: input.precon }).purpose) {
    throw new Error("Prepare a separate document to change its type.")
  }
  if (document.status !== "draft" || document.sent_at || document.is_current_version === false) {
    throw new Error("Only the current unpublished draft can be edited.")
  }
  const parsedLines = normalizeCommercialEstimateLines(estimateLineSchema.array().min(1).parse(
    input.lines.map((line, index) => ({ ...line, sort_order: index, markup_pct: line.markup_pct ?? 0 })),
  ), input.precon)
  const totals = calculateTotals(parsedLines, input.tax_rate ?? 0, input.contingency_percent ?? 0, input.precon)
  const { data, error } = await service.rpc("save_estimate_draft", {
    p_org_id: orgId, p_estimate_id: estimateId, p_expected_updated_at: expectedUpdatedAt,
    p_document: {
      title: stripNul(input.title), recipient_contact_id: input.recipient_contact_id ?? null,
      valid_until: input.valid_until ?? null, subtotal_cents: totals.subtotal,
      tax_cents: totals.tax, total_cents: totals.total,
      metadata: {
        ...(input.precon ? { precon: input.precon } : {}),
        tax_rate: input.tax_rate ?? 0, markup_percent: input.markup_percent ?? 0,
        contingency_percent: input.contingency_percent ?? 0,
        summary: stripNul(input.summary) ?? null, terms: stripNul(input.terms) ?? null,
        inclusions: stripNul(input.inclusions) ?? null, exclusions: stripNul(input.exclusions) ?? null,
        recipient: input.recipient_name || input.recipient_email ? { name: stripNul(input.recipient_name) ?? null, email: stripNul(input.recipient_email) ?? null } : null,
        intro: null, display: null, photos: [],
        ...buildPresentationMetadata(input),
      },
    },
    p_items: buildItemsPayload(orgId, estimateId, parsedLines),
  })
  if (error || !data) throw new Error(error?.message ?? "Unable to save draft")
  return data as { id: string; updated_at: string }
}
