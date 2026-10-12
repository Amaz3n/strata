import { z } from "zod"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { createChangeOrder } from "@/lib/services/change-orders"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { readHomePricingScope } from "@/lib/services/home-pricing-scope"
import { NotificationService } from "@/lib/services/notifications"
import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { announceSelectionExceptions, notifyPermissionHolders, readSelectionChoiceFacts } from "@/lib/services/selection-exceptions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { allocatePackageTotal } from "@/lib/selections/catalog-math"
import { isSelectionPastCutoff } from "@/lib/selections/selection-variance"
import { suggestedScheduleImpactDays, supplyRefusal } from "@/lib/selections/supply-eligibility"
import type { ChangeOrderLineInput } from "@/lib/validation/change-orders"
import { postCutoffChangeSchema, type PostCutoffChangeInput } from "@/lib/validation/selections"

/**
 * What a variance order raised from an executed change order says it is for.
 * A plan change adopted by a released home files its trade half under its own
 * title and reason; a selection change files under "selection after cutoff"
 * inside the approval itself (`tg_change_order_selection_apply`).
 */
export type VarianceOrderSubject = { title: string; reasonCode: string; reasonLabel: string; source: string }

/** The outbox job the approval enqueues for what follows a selection change. */
export const SELECTION_CHANGE_APPLIED_JOB_TYPE = "selection_change_applied"

const SELECTION_CHANGE_REFUSALS: Record<string, string> = {
  SELECTION_CHANGE_ALREADY_OPEN: "already has an open change order",
  SELECTION_CHANGED_SINCE_PRICING: "changed while this change order was being priced",
}

/**
 * A buyer's change the home can no longer take directly — past its cutoff,
 * past the option's order-by date, or already bought on a released purchase
 * order — becomes a change order. It is priced against the home as it stands,
 * carries the post-cutoff fee only when the cutoff has passed, suggests the
 * schedule impact a late order costs, and claims its selections (one open
 * change order per selection) when the change is attached.
 */
export async function createPostCutoffSelectionChangeOrder(raw: PostCutoffChangeInput) {
  const input = postCutoffChangeSchema.parse(raw)
  const context = await requireOrgContext()
  const authorize = (permission: string) => requireAuthorization({
    permission, userId: context.userId, orgId: context.orgId, projectId: input.projectId, supabase: context.supabase,
    logDecision: true, resourceType: "project", resourceId: input.projectId,
  })
  await authorize("selections.write")
  if (input.waiveFee) await authorize("selections.cutoff.override")

  const service = createServiceSupabaseClient()
  const [{ data: selections, error: selectionsError }, { data: lot, error: lotError }, home] = await Promise.all([
    service
      .from("project_selections")
      .select("id, category_id, selected_option_id, price_cents_snapshot, cost_cents_snapshot, group_id, locked_at, category:selection_categories(name)")
      .eq("org_id", context.orgId)
      .eq("project_id", input.projectId)
      .limit(1000),
    service
      .from("lots")
      .select("id, community:communities(name, selection_change_fee_cents)")
      .eq("org_id", context.orgId)
      .eq("project_id", input.projectId)
      .maybeSingle(),
    readHomePricingScope(service, context.orgId, input.projectId),
  ])
  if (selectionsError) throw new Error(`Failed to load project selections: ${selectionsError.message}`)
  if (lotError || !lot) throw new Error("This project is not linked to a production lot")
  const selectionById = new Map((selections ?? []).map((selection) => [selection.id, selection]))
  if (input.changes.some((change) => !selectionById.has(change.selectionId))) throw new Error("One or more selections were not found")

  const packageIds = Array.from(new Set(input.changes.map((change) => change.newPackageId).filter((value): value is string => Boolean(value))))
  const { data: packages, error: packageError } = packageIds.length
    ? await service
        .from("selection_packages")
        .select("id, name, items:selection_package_items(option_id, option:selection_options(category_id))")
        .eq("org_id", context.orgId)
        .in("id", packageIds)
    : { data: [], error: null }
  if (packageError || (packages ?? []).length !== packageIds.length) throw new Error("One or more packages were not found")

  type NormalizedChange = {
    selectionId: string
    optionId: string
    packageId: string | null
    priceCents?: number
    costCents?: number | null
  }
  const normalized: NormalizedChange[] = []
  for (const requested of input.changes) {
    if (requested.newOptionId) {
      normalized.push({ selectionId: requested.selectionId, optionId: requested.newOptionId, packageId: null })
      continue
    }
    const selectionPackage = (packages ?? []).find((candidate) => candidate.id === requested.newPackageId)
    if (!selectionPackage) throw new Error("Selection package was not found")
    const anchor = selectionById.get(requested.selectionId)
    const packageItems = selectionPackage.items ?? []
    const [packagePrice] = await resolveOptionPricing({
      orgId: context.orgId,
      items: [{ packageId: selectionPackage.id }],
      ...home.pricing,
    })
    if (!packagePrice.available) throw new Error(`${selectionPackage.name} is not available for this lot's plan`)
    const memberPrices = packageItems.length ? await resolveOptionPricing({
      orgId: context.orgId,
      items: packageItems.map((item) => ({ optionId: item.option_id })),
      ...home.pricing,
    }) : []
    if (memberPrices.some((price) => !price.available)) throw new Error(`An option in ${selectionPackage.name} is no longer available for this home`)
    const priceAllocations = allocatePackageTotal(packagePrice.priceCents, packageItems.length)
    const costAllocations = packagePrice.costCents == null ? null : allocatePackageTotal(packagePrice.costCents, packageItems.length)
    packageItems.forEach((item, index) => {
      const option = Array.isArray(item.option) ? item.option[0] : item.option
      const memberSelection = (selections ?? []).find((candidate) => candidate.category_id === option?.category_id && candidate.group_id === anchor?.group_id)
      if (!memberSelection) throw new Error(`${selectionPackage.name} does not match this selection group`)
      normalized.push({
        selectionId: memberSelection.id,
        optionId: item.option_id,
        packageId: selectionPackage.id,
        priceCents: priceAllocations[index],
        costCents: costAllocations?.[index] ?? null,
      })
    })
  }

  const deduped = Array.from(new Map(normalized.map((change) => [change.selectionId, change])).values())

  const direct = deduped.filter((change) => change.priceCents == null)
  const directPricing = direct.length ? await resolveOptionPricing({
    orgId: context.orgId,
    items: direct.map((change) => ({ optionId: change.optionId })),
    ...home.pricing,
  }) : []
  if (directPricing.some((price) => !price.available)) throw new Error("One or more options are not available for this lot's plan")
  const directPriceBySelection = new Map(direct.map((change, index) => [change.selectionId, directPricing[index]]))
  const optionIds = Array.from(new Set(deduped.map((change) => change.optionId)))
  const { data: options, error: optionError } = await service
    .from("selection_options")
    .select("id, name, cost_code_id")
    .eq("org_id", context.orgId)
    .in("id", optionIds)
  if (optionError || (options ?? []).length !== optionIds.length) throw new Error("One or more new options were not found")

  // A change order is for what the home can no longer take directly. The
  // post-cutoff fee — or spending the override permission to waive it — is only
  // honest once the cutoff itself has passed; a lead time or a released
  // purchase order makes the change order necessary without making it late.
  const routes = await Promise.all(deduped.map(async (change) => {
    const facts = await readSelectionChoiceFacts(context.orgId, input.projectId, change.selectionId, [change.optionId])
    const pastCutoff = isSelectionPastCutoff({
      selectionLockedAt: facts.selectionLocked ? facts.today : null,
      group: facts.groupStatus ? { status: facts.groupStatus, cutoff_date: facts.cutoffDate } : null,
      today: facts.today,
    })
    const name = (options ?? []).find((option) => option.id === change.optionId)?.name ?? "This option"
    const supply = supplyRefusal(facts, { optionId: change.optionId, name, available: true })
    return { selectionId: change.selectionId, pastCutoff, supply, impactDays: suggestedScheduleImpactDays(facts, change.optionId) }
  }))
  const open = routes.find((route) => !route.pastCutoff && !route.supply)
  if (open) {
    const label = relationName(selectionById.get(open.selectionId)?.category) ?? "This selection"
    throw new Error(`${label} is still open for changes — update the selection directly instead of raising a change order.`)
  }
  const pastCutoff = routes.some((route) => route.pastCutoff)
  if (input.waiveFee && !pastCutoff) throw new Error("There is no post-cutoff fee to waive: these changes are not past their cutoff")
  const daysImpact = Math.max(0, ...routes.map((route) => route.impactDays))

  const community = Array.isArray(lot.community) ? lot.community[0] : lot.community
  const chargesFee = pastCutoff && !input.waiveFee
  const feeCents = chargesFee ? Number(community?.selection_change_fee_cents ?? 25000) : 0
  const changes = deduped.map((change) => {
    const selection = selectionById.get(change.selectionId)
    const resolved = directPriceBySelection.get(change.selectionId)
    const nextOption = (options ?? []).find((option) => option.id === change.optionId)
    const nextPriceCents = change.priceCents ?? resolved?.priceCents ?? 0
    const nextCostCents = change.costCents !== undefined ? change.costCents : resolved?.costCents ?? null
    const oldPriceCents = Number(selection?.price_cents_snapshot ?? 0)
    const oldCostCents = Number(selection?.cost_cents_snapshot ?? 0)
    return {
      selection_id: change.selectionId,
      old_option_id: selection?.selected_option_id ?? null,
      old_price_cents: oldPriceCents,
      old_cost_cents: oldCostCents,
      new_option_id: resolved?.optionId ?? change.optionId,
      new_package_id: change.packageId,
      group_id: selection?.group_id ?? null,
      category_name: relationName(selection?.category) ?? "Selection",
      option_name: nextOption?.name ?? "New option",
      price_cents: nextPriceCents,
      cost_cents: nextCostCents,
      price_delta_cents: nextPriceCents - oldPriceCents,
      cost_delta_cents: Number(nextCostCents ?? 0) - oldCostCents,
      cost_code_id: nextOption?.cost_code_id ?? resolved?.costCodeId ?? null,
    }
  })
  // The buyer signs what the configuration rules accept; nothing is re-checked
  // against the catalog when the signature lands.
  await assertProjectConfiguration(context.orgId, input.projectId, changes.map((change) => ({ selectionId: change.selection_id, optionId: change.new_option_id })))

  const lines: ChangeOrderLineInput[] = changes.map((change) => ({
    description: `Selection change: ${change.category_name} — ${change.option_name}`,
    quantity: 1,
    unit: "ls",
    unit_cost: change.price_delta_cents / 100,
    internal_cost_cents: change.cost_delta_cents,
    cost_code_id: change.cost_code_id ?? undefined,
    allowance: 0,
    taxable: true,
    gmp_classification: "inside_gmp",
    gmp_impact: "none",
  }))
  if (chargesFee) {
    lines.push({ description: "Post-cutoff selection change fee", quantity: 1, unit: "ls", unit_cost: feeCents / 100, internal_cost_cents: 0, allowance: 0, taxable: true, gmp_classification: "inside_gmp", gmp_impact: "none" })
  }
  const created = await createChangeOrder({
    orgId: context.orgId,
    input: {
      project_id: input.projectId,
      title: pastCutoff ? "Post-cutoff selection change" : "Selection change",
      summary: `Selection changes for ${community?.name ?? "production lot"}`,
      description: pastCutoff
        ? "Buyer-requested selection changes after the configured cutoff."
        : "Buyer-requested selection changes the home can no longer take directly (supplier lead time or released purchase order).",
      pricing_display: "itemized",
      requires_signature: true,
      tax_rate: 0,
      markup_percent: 0,
      markup_mode: "percent",
      lifecycle: "draft",
      zero_dollar: false,
      status: "draft",
      client_visible: false,
      days_impact: daysImpact > 0 ? daysImpact : null,
      lines,
    },
  })
  const selectionChange = {
    changes,
    fee_cents: feeCents,
    fee_waived: input.waiveFee,
    past_cutoff: pastCutoff,
    group_ids: Array.from(new Set(changes.map((change) => change.group_id).filter(Boolean))),
  }
  // Attaching claims the selections against the home as priced; a refusal
  // leaves no orphan draft behind.
  const { error: attachError } = await service
    .from("change_orders")
    .update({ metadata: { ...(created.metadata ?? {}), selection_change: selectionChange } })
    .eq("org_id", context.orgId)
    .eq("id", created.id)
  if (attachError) {
    const { error: cleanupError } = await service.from("change_orders").delete().eq("org_id", context.orgId).eq("id", created.id).eq("status", "draft")
    if (cleanupError) throw new Error(`Failed to attach the selection change, and the draft change order could not be removed: ${cleanupError.message}`)
    const refusal = attachError.details ? SELECTION_CHANGE_REFUSALS[attachError.details] : undefined
    throw new Error(refusal ? attachError.message : `Failed to attach selection changes to the change order: ${attachError.message}`)
  }
  await recordAudit({
    orgId: context.orgId, actorId: context.userId, action: "update", entityType: "change_order", entityId: created.id,
    after: { selection_change: selectionChange, days_impact: daysImpact > 0 ? daysImpact : null },
  })
  return { ...created, metadata: { ...(created.metadata ?? {}), selection_change: selectionChange } }
}

function relationName(value: unknown): string | null {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== "object") return null
  const name = (relation as { name?: unknown }).name
  return typeof name === "string" ? name : null
}

const varianceResultSchema = z.object({
  idempotent: z.boolean(),
  created: z.array(z.object({ id: z.string().uuid(), commitment_id: z.string().uuid(), total_cents: z.number() })),
  unrouted: z.array(z.object({ selection_id: z.string(), cost_delta_cents: z.number(), description: z.string(), reason: z.string() }).passthrough()),
})

type CreatedVarianceOrder = z.infer<typeof varianceResultSchema>["created"][number]

async function recordVarianceOrders(input: { orgId: string; projectId: string; changeOrderId: string; orders: CreatedVarianceOrder[] }) {
  for (const order of input.orders) {
    await recordAudit({
      orgId: input.orgId, action: "insert", entityType: "commitment_change_order", entityId: order.id,
      after: { project_id: input.projectId, commitment_id: order.commitment_id, total_cents: order.total_cents, origin: "design_studio_co", prime_change_order_id: input.changeOrderId },
    })
    await recordEvent({
      orgId: input.orgId, eventType: "vpo.requested", entityType: "commitment_change_order", entityId: order.id,
      payload: { project_id: input.projectId, commitment_id: order.commitment_id, origin: "design_studio_co", total_cents: order.total_cents, change_order_id: input.changeOrderId },
    })
  }
}

/**
 * The trade half of an executed plan adoption: each cost delta becomes a draft
 * variance order on the purchase order that owns its cost code
 * (`create_change_order_variance_orders`, idempotent per change order). A
 * delta with no purchase order is put in front of whoever raises variance
 * orders, never dropped.
 */
export async function createChangeOrderVarianceOrders(input: {
  orgId: string
  projectId: string
  changeOrderId: string
  subject: VarianceOrderSubject
  deltas: Array<{ sourceId: string; costCodeId: string | null; costDeltaCents: number; description: string }>
}) {
  const { data, error } = await createServiceSupabaseClient().rpc("create_change_order_variance_orders", {
    p_org_id: input.orgId,
    p_project_id: input.projectId,
    p_change_order_id: input.changeOrderId,
    p_subject: { title: input.subject.title, reason_code: input.subject.reasonCode, reason_label: input.subject.reasonLabel, source: input.subject.source },
    p_deltas: input.deltas.map((delta) => ({ selection_id: delta.sourceId, cost_code_id: delta.costCodeId, cost_delta_cents: delta.costDeltaCents, description: delta.description })),
  })
  if (error) throw new Error(`Failed to raise the variance orders: ${error.message}`)
  const result = varianceResultSchema.parse(data)
  await recordVarianceOrders({ orgId: input.orgId, projectId: input.projectId, changeOrderId: input.changeOrderId, orders: result.created })
  if (result.unrouted.length) {
    const totalCents = result.unrouted.reduce((sum, item) => sum + item.cost_delta_cents, 0)
    await recordEvent({
      orgId: input.orgId, eventType: "selection_change_variance_unrouted", entityType: "change_order", entityId: input.changeOrderId,
      payload: { project_id: input.projectId, unrouted: result.unrouted, unrouted_count: result.unrouted.length, unrouted_cost_cents: totalCents },
    })
    await notifyPermissionHolders({
      orgId: input.orgId, permission: "vpo.request", type: "selection_change_variance_unrouted",
      title: "Change needs a variance order",
      message: `${result.unrouted.length} cost change${result.unrouted.length === 1 ? "" : "s"} could not be routed to a purchase order. Raise the variance order by hand.`,
      projectId: input.projectId, entityType: "change_order", entityId: input.changeOrderId, href: `/projects/${input.projectId}/change-orders`,
    })
  }
  return { created: result.created.length, unrouted: result.unrouted.length }
}

const appliedPayloadSchema = z.object({
  change_order_id: z.string().uuid(),
  project_id: z.string().uuid(),
  schedule_item_id: z.string().uuid().nullable().optional(),
  variance_orders: varianceResultSchema.shape.created.nullable().optional(),
})

const appliedChangeSchema = z.object({
  selection_id: z.string(),
  old_option_id: z.string().nullable().optional(),
  new_option_id: z.string(),
  cost_delta_cents: z.number().optional(),
  cost_code_id: z.string().nullable().optional(),
  price_cents: z.number().optional(),
}).passthrough()

/**
 * What follows a selection change order's approval, once it has committed:
 * the record of each selection and variance order it wrote, the exceptions it
 * opened for cost with no purchase order, and the superintendent's notice of
 * the schedule impact waiting on them.
 */
export async function processSelectionChangeApplied(orgId: string, raw: unknown) {
  const payload = appliedPayloadSchema.parse(raw)
  const supabase = createServiceSupabaseClient()
  const [changeOrderResult, exceptionsResult, projectResult] = await Promise.all([
    supabase.from("change_orders").select("id, co_number, title, days_impact, metadata").eq("org_id", orgId).eq("id", payload.change_order_id).maybeSingle(),
    supabase.from("selection_exceptions").select("id").eq("org_id", orgId).eq("change_order_id", payload.change_order_id).eq("reason", "variance_unrouted").eq("status", "open"),
    supabase.from("projects").select("id, name, superintendent_id").eq("org_id", orgId).eq("id", payload.project_id).maybeSingle(),
  ])
  for (const failure of [changeOrderResult.error, exceptionsResult.error, projectResult.error]) {
    if (failure) throw new Error(`Failed to load the applied selection change: ${failure.message}`)
  }
  const changeOrder = changeOrderResult.data
  if (!changeOrder) throw new Error("The applied selection change order was not found")
  const changes = z.array(appliedChangeSchema).parse(changeOrder.metadata?.selection_change?.changes ?? [])
  for (const change of changes) {
    await recordEvent({
      orgId, eventType: "selection_changed_post_cutoff", entityType: "selection", entityId: change.selection_id,
      payload: { project_id: payload.project_id, change_order_id: changeOrder.id, old_option_id: change.old_option_id ?? null, new_option_id: change.new_option_id,
        cost_delta_cents: change.cost_delta_cents ?? 0, cost_code_id: change.cost_code_id ?? null },
    })
    await recordAudit({
      orgId, action: "update", entityType: "selection", entityId: change.selection_id,
      after: { selected_option_id: change.new_option_id, status: "confirmed", price_cents_snapshot: change.price_cents ?? null, source_change_order_id: changeOrder.id },
    })
  }
  await recordVarianceOrders({ orgId, projectId: payload.project_id, changeOrderId: changeOrder.id, orders: payload.variance_orders ?? [] })
  await announceSelectionExceptions(orgId, (exceptionsResult.data ?? []).map((row) => row.id as string))

  const daysImpact = Number(changeOrder.days_impact ?? 0)
  const superintendentId = projectResult.data?.superintendent_id as string | null | undefined
  if (daysImpact !== 0) {
    await recordEvent({
      orgId, eventType: "selection_change_schedule_pending", entityType: "change_order", entityId: changeOrder.id,
      payload: { project_id: payload.project_id, schedule_item_id: payload.schedule_item_id ?? null, days_impact: daysImpact },
    })
    if (superintendentId) {
      await new NotificationService().createAndQueue({
        orgId, userId: superintendentId, type: "selection_change_schedule_pending",
        title: `Schedule impact: ${daysImpact} day${Math.abs(daysImpact) === 1 ? "" : "s"}`,
        message: payload.schedule_item_id
          ? `CO #${changeOrder.co_number ?? ""} (${changeOrder.title}) on ${projectResult.data?.name ?? "a home"} is waiting for you to apply its schedule impact.`
          : `CO #${changeOrder.co_number ?? ""} (${changeOrder.title}) on ${projectResult.data?.name ?? "a home"} carries a schedule impact with no linked task; adjust the schedule by hand.`,
        projectId: payload.project_id, entityType: "change_order", entityId: changeOrder.id,
        metadata: { href: `/projects/${payload.project_id}/schedule`, schedule_item_id: payload.schedule_item_id ?? null },
      })
    }
  }
}
