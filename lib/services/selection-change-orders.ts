import { recordAudit } from "@/lib/services/audit"
import { createChangeOrder } from "@/lib/services/change-orders"
import { requireOrgContext } from "@/lib/services/context"
import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { requirePermission } from "@/lib/services/permissions"
import { allocatePackageTotal } from "@/lib/selections/catalog-math"
import type { ChangeOrderLineInput } from "@/lib/validation/change-orders"
import { postCutoffChangeSchema, type PostCutoffChangeInput } from "@/lib/validation/selections"

export async function createPostCutoffSelectionChangeOrder(raw: PostCutoffChangeInput) {
  const input = postCutoffChangeSchema.parse(raw)
  const context = await requireOrgContext()
  if (input.waiveFee) await requirePermission("selections.cutoff.override", context)

  const [{ data: selections, error: selectionsError }, { data: lot, error: lotError }] = await Promise.all([
    context.supabase
      .from("project_selections")
      .select("id, category_id, selected_option_id, price_cents_snapshot, cost_cents_snapshot, group_id, category:selection_categories(name)")
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
    const category = Array.isArray(selection?.category) ? selection.category[0] : selection?.category
    const nextPriceCents = change.priceCents ?? resolved?.priceCents ?? 0
    const nextCostCents = change.costCents !== undefined ? change.costCents : resolved?.costCents ?? null
    return {
      selection_id: change.selectionId,
      old_option_id: selection?.selected_option_id ?? null,
      new_option_id: change.optionId,
      new_package_id: change.packageId,
      group_id: selection?.group_id ?? null,
      category_name: category?.name ?? "Selection",
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
