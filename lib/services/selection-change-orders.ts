import { recordAudit } from "@/lib/services/audit"
import { createChangeOrder } from "@/lib/services/change-orders"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { allocatePackageTotal } from "@/lib/selections/catalog-math"
import {
  isSelectionPastCutoff,
  planSelectionVarianceOrders,
  type SelectionCostDelta,
  type UnroutedSelectionDelta,
} from "@/lib/selections/selection-variance"
import type { ChangeOrderLineInput } from "@/lib/validation/change-orders"
import { postCutoffChangeSchema, type PostCutoffChangeInput } from "@/lib/validation/selections"

/** The reason code every design-studio-driven variance order is filed under. */
export const SELECTION_AFTER_CUTOFF_REASON_CODE = "selection_after_cutoff"

export async function createPostCutoffSelectionChangeOrder(raw: PostCutoffChangeInput) {
  const input = postCutoffChangeSchema.parse(raw)
  const context = await requireOrgContext()
  if (input.waiveFee) await requirePermission("selections.cutoff.override", context)

  const [{ data: selections, error: selectionsError }, { data: lot, error: lotError }] = await Promise.all([
    context.supabase
      .from("project_selections")
      .select("id, category_id, selected_option_id, price_cents_snapshot, cost_cents_snapshot, group_id, locked_at, category:selection_categories(name)")
      .eq("org_id", context.orgId)
      .eq("project_id", input.projectId)
      .limit(1000),
    context.supabase
      .from("lots")
      .select("community_id, house_plan_version_id, community:communities(name, selection_change_fee_cents)")
      .eq("org_id", context.orgId)
      .eq("project_id", input.projectId)
      .maybeSingle(),
  ])
  if (selectionsError) throw new Error(`Failed to load project selections: ${selectionsError.message}`)
  if (lotError || !lot) throw new Error("This project is not linked to a production lot")
  const selectionById = new Map((selections ?? []).map((selection) => [selection.id, selection]))
  if (input.changes.some((change) => !selectionById.has(change.selectionId))) throw new Error("One or more selections were not found")

  const packageIds = Array.from(new Set(input.changes.map((change) => change.newPackageId).filter((value): value is string => Boolean(value))))
  const { data: packages, error: packageError } = packageIds.length
    ? await context.supabase
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
      housePlanVersionId: lot.house_plan_version_id ?? undefined,
      communityId: lot.community_id,
    })
    if (!packagePrice.available) throw new Error(`${selectionPackage.name} is not available for this lot's plan`)
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

  // Charging a post-cutoff fee — or spending the override permission to waive
  // one — is only honest once the cutoff has actually passed. Without this the
  // buyer is billed for a change they were still entitled to make for free.
  await assertChangesArePostCutoff({
    supabase: context.supabase,
    orgId: context.orgId,
    projectId: input.projectId,
    selections: deduped.map((change) => {
      const selection = selectionById.get(change.selectionId)
      return {
        id: change.selectionId,
        groupId: selection?.group_id ?? null,
        lockedAt: selection?.locked_at ?? null,
        label: relationName(selection?.category) ?? "This selection",
      }
    }),
  })

  const direct = deduped.filter((change) => change.priceCents == null)
  const directPricing = direct.length ? await resolveOptionPricing({
    orgId: context.orgId,
    items: direct.map((change) => ({ optionId: change.optionId })),
    housePlanVersionId: lot.house_plan_version_id ?? undefined,
    communityId: lot.community_id,
  }) : []
  if (directPricing.some((price) => !price.available)) throw new Error("One or more options are not available for this lot's plan")
  const directPriceBySelection = new Map(direct.map((change, index) => [change.selectionId, directPricing[index]]))
  const optionIds = Array.from(new Set(deduped.map((change) => change.optionId)))
  const { data: options, error: optionError } = await context.supabase
    .from("selection_options")
    .select("id, name, cost_code_id")
    .eq("org_id", context.orgId)
    .in("id", optionIds)
  if (optionError || (options ?? []).length !== optionIds.length) throw new Error("One or more new options were not found")

  const community = Array.isArray(lot.community) ? lot.community[0] : lot.community
  const feeCents = input.waiveFee ? 0 : Number(community?.selection_change_fee_cents ?? 25000)
  const changes = deduped.map((change) => {
    const selection = selectionById.get(change.selectionId)
    const resolved = directPriceBySelection.get(change.selectionId)
    const nextOption = (options ?? []).find((option) => option.id === change.optionId)
    const nextPriceCents = change.priceCents ?? resolved?.priceCents ?? 0
    const nextCostCents = change.costCents !== undefined ? change.costCents : resolved?.costCents ?? null
    return {
      selection_id: change.selectionId,
      old_option_id: selection?.selected_option_id ?? null,
      new_option_id: change.optionId,
      new_package_id: change.packageId,
      group_id: selection?.group_id ?? null,
      category_name: relationName(selection?.category) ?? "Selection",
      option_name: nextOption?.name ?? "New option",
      price_cents: nextPriceCents,
      cost_cents: nextCostCents,
      price_delta_cents: nextPriceCents - Number(selection?.price_cents_snapshot ?? 0),
      cost_delta_cents: Number(nextCostCents ?? 0) - Number(selection?.cost_cents_snapshot ?? 0),
      cost_code_id: nextOption?.cost_code_id ?? resolved?.costCodeId ?? null,
    }
  })
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
  if (!input.waiveFee) {
    lines.push({ description: "Post-cutoff selection change fee", quantity: 1, unit: "ls", unit_cost: feeCents / 100, internal_cost_cents: 0, allowance: 0, taxable: true, gmp_classification: "inside_gmp", gmp_impact: "none" })
  }
  const created = await createChangeOrder({
    orgId: context.orgId,
    input: {
      project_id: input.projectId,
      title: "Post-cutoff selection change",
      summary: `Selection changes for ${community?.name ?? "production lot"}`,
      description: "Buyer-requested selection changes after the configured cutoff.",
      pricing_display: "itemized",
      requires_signature: true,
      tax_rate: 0,
      markup_percent: 0,
      markup_mode: "percent",
      lifecycle: "draft",
      zero_dollar: false,
      status: "draft",
      client_visible: false,
      lines,
    },
  })
  const metadata = {
    ...(created.metadata ?? {}),
    selection_change: {
      changes,
      fee_cents: feeCents,
      fee_waived: input.waiveFee,
      group_ids: Array.from(new Set(changes.map((change) => change.group_id).filter(Boolean))),
    },
  }
  const { error: updateError } = await context.supabase.from("change_orders").update({ metadata }).eq("org_id", context.orgId).eq("id", created.id)
  if (updateError) throw new Error(`Failed to attach selection changes to the change order: ${updateError.message}`)
  if (input.waiveFee) {
    await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "change_order", entityId: created.id, after: { selection_change_fee_waived: true, fee_cents: feeCents } })
  }
  return { ...created, metadata }
}

function relationName(value: unknown): string | null {
  const relation = Array.isArray(value) ? value[0] : value
  if (!relation || typeof relation !== "object") return null
  const name = (relation as { name?: unknown }).name
  return typeof name === "string" ? name : null
}

async function assertChangesArePostCutoff(input: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
  selections: Array<{ id: string; groupId: string | null; lockedAt: string | null; label: string }>
}) {
  const groupIds = Array.from(new Set(input.selections.map((selection) => selection.groupId).filter((value): value is string => Boolean(value))))
  const { data: instances, error } = groupIds.length
    ? await input.supabase
        .from("project_selection_groups")
        .select("group_id, status, cutoff_date")
        .eq("org_id", input.orgId)
        .eq("project_id", input.projectId)
        .in("group_id", groupIds)
    : { data: [], error: null }
  if (error) throw new Error(`Failed to validate the selection cutoff: ${error.message}`)
  const instanceByGroup = new Map((instances ?? []).map((instance) => [instance.group_id as string, instance]))
  const today = new Date().toISOString().slice(0, 10)

  const open = input.selections.filter((selection) => {
    const instance = selection.groupId ? instanceByGroup.get(selection.groupId) ?? null : null
    return !isSelectionPastCutoff({
      selectionLockedAt: selection.lockedAt,
      group: instance ? { status: instance.status as string, cutoff_date: instance.cutoff_date as string | null } : null,
      today,
    })
  })
  if (open.length > 0) {
    throw new Error(
      `${open[0].label} is still open for changes — update the selection directly instead of raising a post-cutoff change order.`,
    )
  }
}

/**
 * The trade half of a post-cutoff selection change.
 *
 * The buyer-facing change order bills the granite upgrade; without this the
 * countertop purchase order is never revised and the variance never appears on
 * the purchasing desk. Runs service-role from the change-order execution path,
 * so it re-derives its own authority from the change order rather than a user
 * session, and is idempotent on `prime_change_order_id` so a re-executed or
 * re-delivered signature cannot double-bill the vendor.
 */
export async function createVarianceOrdersForSelectionChange(input: {
  orgId: string
  projectId: string
  changeOrderId: string
  changes: readonly SelectionCostDelta[]
}): Promise<{ created: number; unrouted: number; idempotent: boolean }> {
  const routable = input.changes.filter((change) => Math.round(Number(change.cost_delta_cents ?? 0)) !== 0)
  if (routable.length === 0) return { created: 0, unrouted: 0, idempotent: false }

  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase
    .from("commitment_change_orders")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("prime_change_order_id", input.changeOrderId)
    .eq("origin", "design_studio_co")
    .limit(1)
  if (existingError) throw new Error(`Failed to check existing variance orders: ${existingError.message}`)
  if ((existing ?? []).length > 0) return { created: 0, unrouted: 0, idempotent: true }

  const reasonCodeId = await resolveSelectionVarianceReasonCode(supabase, input.orgId)

  const { data: commitments, error: commitmentsError } = await supabase
    .from("commitments")
    .select("id, company_id, created_at")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("commitment_type", "purchase_order")
    .neq("status", "canceled")
    .order("created_at", { ascending: true })
    .limit(500)
  if (commitmentsError) throw new Error(`Failed to load purchase orders for the selection change: ${commitmentsError.message}`)

  const commitmentById = new Map((commitments ?? []).map((row) => [row.id as string, row]))
  const commitmentByCostCode = new Map<string, { commitmentId: string; companyId: string | null }>()
  if (commitmentById.size > 0) {
    const { data: lines, error: linesError } = await supabase
      .from("commitment_lines")
      .select("commitment_id, cost_code_id")
      .eq("org_id", input.orgId)
      .in("commitment_id", Array.from(commitmentById.keys()))
      .not("cost_code_id", "is", null)
      .limit(5000)
    if (linesError) throw new Error(`Failed to load purchase-order cost codes: ${linesError.message}`)
    // Oldest purchase order wins a contested cost code, so the routing is
    // stable across re-runs rather than dependent on row order.
    for (const commitment of commitments ?? []) {
      for (const line of lines ?? []) {
        if (line.commitment_id !== commitment.id) continue
        const costCodeId = line.cost_code_id as string
        if (commitmentByCostCode.has(costCodeId)) continue
        commitmentByCostCode.set(costCodeId, { commitmentId: commitment.id as string, companyId: (commitment.company_id as string | null) ?? null })
      }
    }
  }

  const { orders, unrouted } = planSelectionVarianceOrders({ changes: routable, commitmentByCostCode })

  for (const order of orders) {
    const { data: inserted, error: insertError } = await supabase
      .from("commitment_change_orders")
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        commitment_id: order.commitment_id,
        company_id: order.company_id,
        title: "Selection change after cutoff",
        description: order.lines.map((line) => line.description).join("; "),
        status: "draft",
        total_cents: order.total_cents,
        currency: "usd",
        reason_code_id: reasonCodeId,
        origin: "design_studio_co",
        prime_change_order_id: input.changeOrderId,
        photo_file_ids: [],
        metadata: { source: "design_studio_co", selection_ids: order.selection_ids },
      })
      .select("id")
      .single()
    if (insertError || !inserted) throw new Error(`Failed to create the selection variance order: ${insertError?.message}`)

    const { error: lineError } = await supabase.from("commitment_change_order_lines").insert(
      order.lines.map((line, index) => ({
        org_id: input.orgId,
        commitment_change_order_id: inserted.id as string,
        cost_code_id: line.cost_code_id,
        description: line.description,
        quantity: 1,
        unit: "ls",
        unit_cost_cents: line.unit_cost_cents,
        amount_cents: line.unit_cost_cents,
        sort_order: index,
        metadata: { selection_id: line.selection_id },
      })),
    )
    if (lineError) {
      await supabase.from("commitment_change_orders").delete().eq("org_id", input.orgId).eq("id", inserted.id)
      throw new Error(`Failed to create selection variance order lines: ${lineError.message}`)
    }

    await recordAudit({
      orgId: input.orgId,
      action: "insert",
      entityType: "commitment_change_order",
      entityId: inserted.id as string,
      after: { project_id: input.projectId, commitment_id: order.commitment_id, total_cents: order.total_cents, origin: "design_studio_co" },
    })
    await recordEvent({
      orgId: input.orgId,
      eventType: "vpo.requested",
      entityType: "commitment_change_order",
      entityId: inserted.id as string,
      payload: {
        project_id: input.projectId,
        commitment_id: order.commitment_id,
        origin: "design_studio_co",
        total_cents: order.total_cents,
        change_order_id: input.changeOrderId,
      },
    })
  }

  if (unrouted.length > 0) {
    await reportUnroutedSelectionDeltas({ orgId: input.orgId, projectId: input.projectId, changeOrderId: input.changeOrderId, unrouted })
  }

  return { created: orders.length, unrouted: unrouted.length, idempotent: false }
}

async function resolveSelectionVarianceReasonCode(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("variance_reason_codes")
    .select("id")
    .eq("org_id", orgId)
    .eq("code", SELECTION_AFTER_CUTOFF_REASON_CODE)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the selection variance reason: ${error.message}`)
  if (data) return data.id as string

  const { data: seeded, error: seedError } = await supabase
    .from("variance_reason_codes")
    .insert({ org_id: orgId, code: SELECTION_AFTER_CUTOFF_REASON_CODE, label: "Selection after cutoff", sort_order: 3 })
    .select("id")
    .single()
  if (seedError || !seeded) throw new Error(`Failed to seed the selection variance reason: ${seedError?.message}`)
  return seeded.id as string
}

/**
 * A cost delta with no purchase order behind its cost code is a real money
 * event with no home. It is recorded and put in front of the people who can
 * raise the variance order by hand rather than dropped on the floor.
 */
async function reportUnroutedSelectionDeltas(input: {
  orgId: string
  projectId: string
  changeOrderId: string
  unrouted: UnroutedSelectionDelta[]
}) {
  const supabase = createServiceSupabaseClient()
  const totalCents = input.unrouted.reduce((sum, item) => sum + item.cost_delta_cents, 0)
  await recordEvent({
    orgId: input.orgId,
    eventType: "selection_change_variance_unrouted",
    entityType: "change_order",
    entityId: input.changeOrderId,
    payload: {
      project_id: input.projectId,
      unrouted: input.unrouted,
      unrouted_count: input.unrouted.length,
      unrouted_cost_cents: totalCents,
    },
  })

  const { data: roleRows } = await supabase.from("role_permissions").select("role_id").eq("permission_key", "vpo.request")
  const roleIds = Array.from(new Set((roleRows ?? []).map((row) => row.role_id as string).filter(Boolean)))
  if (roleIds.length === 0) return
  const { data: memberships } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", input.orgId)
    .eq("status", "active")
    .in("role_id", roleIds)
  const userIds = Array.from(new Set((memberships ?? []).map((row) => row.user_id as string).filter(Boolean)))
  if (userIds.length === 0) return

  const notificationService = new NotificationService()
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(totalCents) / 100)
  for (const userId of userIds) {
    await notificationService.createAndQueue({
      orgId: input.orgId,
      userId,
      type: "selection_change_variance_unrouted",
      title: "Selection change needs a variance order",
      message: `${input.unrouted.length} selection change${input.unrouted.length === 1 ? "" : "s"} totalling ${amount} could not be routed to a purchase order. Raise the variance order by hand.`,
      projectId: input.projectId,
      entityType: "change_order",
      entityId: input.changeOrderId,
      metadata: { href: `/projects/${input.projectId}/change-orders`, unrouted_count: input.unrouted.length },
    })
  }
}
