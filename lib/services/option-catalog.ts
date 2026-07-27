import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { buildFilesPublicUrl } from "@/lib/storage/files-storage"
import { allocatePackageTotal, chooseResolvedPrice } from "@/lib/selections/catalog-math"

export { allocatePackageTotal, chooseResolvedPrice } from "@/lib/selections/catalog-math"
import {
  appointmentSchema,
  catalogCategorySchema,
  catalogOptionSchema,
  catalogPriceSchema,
  packageSchema,
  selectionGroupSchema,
  type AppointmentInput,
  type CatalogCategoryInput,
  type CatalogOptionInput,
  type CatalogPriceInput,
  type SelectionGroupInput,
  type SelectionPackageInput,
} from "@/lib/validation/selections"

export type CatalogSource = "org" | "community_override" | "community_only"

export type CatalogOptionDto = {
  id: string
  category_id: string
  parent_option_id: string | null
  community_id: string | null
  name: string
  description: string | null
  option_scope: "structural" | "design_studio"
  price_cents: number | null
  cost_cents?: number | null
  cost_code_id: string | null
  sku: string | null
  vendor: string | null
  lead_time_days: number | null
  image_url: string | null
  file_id: string | null
  is_available: boolean
  is_archived: boolean
  /** The grade included in base price — see `isStandard` on the input schema. */
  is_default: boolean
  sort_order: number
  source: CatalogSource
}

export type CatalogCategoryDto = {
  id: string
  parent_category_id: string | null
  community_id: string | null
  name: string
  description: string | null
  image_url: string | null
  is_archived: boolean
  sort_order: number
  source: CatalogSource
  options: CatalogOptionDto[]
}

export type SelectionPackageDto = {
  id: string
  community_id: string | null
  name: string
  description: string | null
  image_url: string | null
  price_cents: number
  cost_cents?: number | null
  is_available: boolean
  is_archived: boolean
  sort_order: number
  option_ids: string[]
}

export type CatalogDto = {
  categories: CatalogCategoryDto[]
  packages: SelectionPackageDto[]
  can_read_margin: boolean
}

export type ResolvedOptionPricing = {
  optionId?: string
  packageId?: string
  priceCents: number
  costCents: number | null
  costCodeId: string | null
  vendor: string | null
  sku: string | null
  leadTimeDays: number | null
  available: boolean
  source: "plan_community" | "plan" | "option_community" | "option_base"
}

export type SelectionGroupDto = {
  id: string
  community_id: string | null
  name: string
  schedule_task_key: string
  cutoff_offset_days: number
  cutoff_anchor: "start" | "end"
  sort_order: number
  is_archived: boolean
  category_ids: string[]
}

export type AppointmentDto = {
  id: string
  community_id: string | null
  project_id: string
  contact_id: string | null
  coordinator_user_id: string | null
  scheduled_at: string
  duration_minutes: number
  location: string | null
  status: "scheduled" | "completed" | "no_show" | "canceled"
  group_ids: string[]
  notes: string | null
  project_name?: string | null
  community_name?: string | null
  buyer_name?: string | null
  coordinator_name?: string | null
}

type CategoryRow = Omit<CatalogCategoryDto, "source" | "options">
type OptionRow = Omit<CatalogOptionDto, "source" | "cost_cents"> & { cost_cents: number | null }
type PackageRow = Omit<SelectionPackageDto, "option_ids" | "cost_cents"> & { cost_cents: number | null }

function sourceFor(communityId: string | null, parentId: string | null): CatalogSource {
  if (!communityId) return "org"
  return parentId ? "community_override" : "community_only"
}

function mergeEffectiveRows<T extends { id: string; community_id: string | null; parent_id: string | null }>(
  rows: T[],
  communityId?: string,
) {
  const visible = rows.filter((row) => row.community_id === null || row.community_id === communityId)
  if (!communityId) return visible.filter((row) => row.community_id === null)
  const overridden = new Set(
    visible.filter((row) => row.community_id === communityId && row.parent_id).map((row) => row.parent_id),
  )
  return visible.filter((row) => row.community_id === communityId || !overridden.has(row.id))
}

export async function listCatalog(
  opts: { communityId?: string; includeArchived?: boolean } = {},
): Promise<CatalogDto> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const canReadMargin = await hasPermission("financials.margin.read", context)
  const [categoriesResult, optionsResult, packagesResult, itemsResult] = await Promise.all([
    context.supabase
      .from("selection_categories")
      .select("id, parent_category_id, community_id, name, description, image_url, is_archived, sort_order")
      .eq("org_id", context.orgId)
      .order("sort_order")
      .limit(500),
    context.supabase
      .from("selection_options")
      .select("id, category_id, parent_option_id, community_id, name, description, option_scope, price_cents, cost_cents, cost_code_id, sku, vendor, lead_time_days, image_url, file_id, is_available, is_archived, is_default, sort_order")
      .eq("org_id", context.orgId)
      .order("sort_order")
      .limit(2000),
    context.supabase
      .from("selection_packages")
      .select("id, community_id, name, description, image_url, price_cents, cost_cents, is_available, is_archived, sort_order")
      .eq("org_id", context.orgId)
      .order("sort_order")
      .limit(500),
    context.supabase
      .from("selection_package_items")
      .select("package_id, option_id")
      .eq("org_id", context.orgId)
      .limit(5000),
  ])
  for (const result of [categoriesResult, optionsResult, packagesResult, itemsResult]) {
    if (result.error) throw new Error(`Failed to load option catalog: ${result.error.message}`)
  }

  const categoryRows = (categoriesResult.data ?? []).map((row) => ({
    ...row,
    parent_id: row.parent_category_id,
  }))
  const effectiveCategories = mergeEffectiveRows(categoryRows, opts.communityId)
  const effectiveCategoryIds = new Set(effectiveCategories.map((row) => row.id))
  const baseToEffectiveCategory = new Map(
    effectiveCategories
      .filter((row) => row.parent_category_id)
      .map((row) => [row.parent_category_id as string, row.id]),
  )
  const optionRows = (optionsResult.data ?? []).map((row) => ({ ...row, parent_id: row.parent_option_id }))
  const effectiveOptions = mergeEffectiveRows(optionRows, opts.communityId).filter((row) => {
    const categoryId = baseToEffectiveCategory.get(row.category_id) ?? row.category_id
    return effectiveCategoryIds.has(categoryId)
  })
  const optionsByCategory = new Map<string, CatalogOptionDto[]>()
  for (const row of effectiveOptions) {
    if (!opts.includeArchived && row.is_archived) continue
    const categoryId = baseToEffectiveCategory.get(row.category_id) ?? row.category_id
    const option: CatalogOptionDto = {
      ...row,
      category_id: categoryId,
      source: sourceFor(row.community_id, row.parent_option_id),
      ...(canReadMargin ? { cost_cents: row.cost_cents } : {}),
    }
    const existing = optionsByCategory.get(categoryId) ?? []
    existing.push(option)
    optionsByCategory.set(categoryId, existing)
  }
  const categories = effectiveCategories
    .filter((row) => opts.includeArchived || !row.is_archived)
    .map(({ parent_id: _parentId, ...row }) => ({
      ...row,
      source: sourceFor(row.community_id, row.parent_category_id),
      options: optionsByCategory.get(row.id) ?? [],
    }))

  const packageRows = (packagesResult.data ?? []) as PackageRow[]
  const packages = packageRows
    .filter((row) => row.community_id === null || row.community_id === opts.communityId)
    .filter((row) => opts.includeArchived || !row.is_archived)
    .map((row) => ({
      ...row,
      ...(canReadMargin ? { cost_cents: row.cost_cents } : {}),
      option_ids: (itemsResult.data ?? []).filter((item) => item.package_id === row.id).map((item) => item.option_id),
    }))
  return { categories, packages, can_read_margin: canReadMargin }
}

async function saveCatalogEntity<T>(input: {
  table: "selection_categories" | "selection_options" | "selection_packages" | "selection_catalog_prices" | "selection_groups"
  id?: string | null
  payload: Record<string, unknown>
  select: string
  entityType: string
}) {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const query = input.id
    ? context.supabase.from(input.table).update(input.payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from(input.table).insert({ org_id: context.orgId, ...input.payload })
  const { data, error } = await query.select(input.select).single()
  if (error || !data) throw new Error(`Failed to save catalog entity: ${error?.message ?? "missing row"}`)
  const entity = data as unknown as Record<string, unknown> & { id: string }
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "option_catalog_updated",
      entityType: input.entityType,
      entityId: entity.id,
      payload: { operation: input.id ? "update" : "insert" },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: input.id ? "update" : "insert",
      entityType: input.entityType,
      entityId: entity.id,
      after: input.payload,
    }),
  ])
  return entity
}

export async function upsertCategory(raw: CatalogCategoryInput) {
  const input = catalogCategorySchema.parse(raw)
  return saveCatalogEntity({
    table: "selection_categories",
    id: input.id,
    payload: {
      community_id: input.communityId ?? null,
      parent_category_id: input.parentCategoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      image_url: input.imageUrl ?? null,
      sort_order: input.sortOrder,
    },
    select: "id, org_id, community_id, parent_category_id, name, description, image_url, sort_order, is_archived",
    entityType: "selection_category",
  })
}

export async function upsertOption(raw: CatalogOptionInput) {
  const input = catalogOptionSchema.parse(raw)
  // Standard grade is carried by three columns that must never disagree: it is
  // the option included in base price, so it prices at zero and pre-selects.
  const priceCents = input.isStandard ? 0 : input.priceCents ?? 0
  const saved = await saveCatalogEntity({
    table: "selection_options",
    id: input.id,
    payload: {
      category_id: input.categoryId,
      community_id: input.communityId ?? null,
      parent_option_id: input.parentOptionId ?? null,
      name: input.name,
      description: input.description ?? null,
      option_scope: input.optionScope,
      price_cents: priceCents,
      price_type: priceCents === 0 ? "included" : "upgrade",
      cost_cents: input.costCents ?? null,
      cost_code_id: input.costCodeId ?? null,
      sku: input.sku ?? null,
      vendor: input.vendor ?? null,
      lead_time_days: input.leadTimeDays ?? null,
      image_url: input.imageUrl ?? null,
      file_id: input.fileId ?? null,
      sort_order: input.sortOrder,
      is_available: input.isAvailable,
      is_default: input.isStandard,
    },
    select: "id, org_id, category_id, community_id, parent_option_id, name, description, option_scope, price_cents, cost_cents, cost_code_id, sku, vendor, lead_time_days, image_url, file_id, sort_order, is_available, is_archived, is_default",
    entityType: "selection_option",
  })
  if (input.isStandard) await demoteOtherStandards(input.categoryId, saved.id, input.communityId ?? null)
  return saved
}

/**
 * A category has at most one standard grade. Promoting an option demotes the
 * previous one rather than refusing the edit, because the coordinator's intent
 * ("this is the new base carpet") is unambiguous.
 */
async function demoteOtherStandards(categoryId: string, keepOptionId: string, communityId: string | null) {
  const context = await requireOrgContext()
  let query = context.supabase
    .from("selection_options")
    .update({ is_default: false })
    .eq("org_id", context.orgId)
    .eq("category_id", categoryId)
    .eq("is_default", true)
    .neq("id", keepOptionId)
  query = communityId ? query.eq("community_id", communityId) : query.is("community_id", null)
  const { error } = await query
  if (error) throw new Error(`Failed to demote the previous standard grade: ${error.message}`)
}

/** Where option photography lands in the file tree, org-wide rather than per project. */
export const CATALOG_IMAGE_FOLDER = "/design-studio/catalog"

export type CatalogImage = {
  fileId: string
  /** Public CDN URL, so the buyer portal can render it without a session. */
  url: string
  fileName: string
}

/**
 * An image already in the catalog folder with these exact bytes. The same tile
 * photo legitimately backs several options, and the upload path rejects
 * duplicate checksums — so callers look here first and reuse the object rather
 * than storing a second copy of it.
 */
export async function findCatalogImageByChecksum(checksum: string): Promise<CatalogImage | null> {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const { data, error } = await context.supabase
    .from("files")
    .select("id, file_name, storage_path")
    .eq("org_id", context.orgId)
    .eq("checksum", checksum)
    .eq("folder_path", CATALOG_IMAGE_FOLDER)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to look up the image: ${error.message}`)
  if (!data) return null
  const url = buildFilesPublicUrl(data.storage_path)
  if (!url) return null
  return { fileId: data.id, url, fileName: data.file_name }
}

export async function archiveCatalogEntity(input: {
  type: "category" | "option" | "package"
  id: string
  archived?: boolean
}) {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const table = input.type === "category" ? "selection_categories" : input.type === "option" ? "selection_options" : "selection_packages"
  const { data, error } = await context.supabase
    .from(table)
    .update({ is_archived: input.archived ?? true })
    .eq("org_id", context.orgId)
    .eq("id", input.id)
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to archive catalog entity: ${error?.message ?? "missing row"}`)
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: `selection_${input.type}`,
    entityId: input.id,
    after: { is_archived: input.archived ?? true },
  })
}

export async function upsertPackage(raw: SelectionPackageInput): Promise<SelectionPackageDto> {
  const input = packageSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const { data: options, error: optionsError } = await context.supabase
    .from("selection_options")
    .select("id, category_id")
    .eq("org_id", context.orgId)
    .in("id", input.optionIds)
  if (optionsError || (options ?? []).length !== input.optionIds.length) throw new Error("One or more package options were not found")
  if (new Set((options ?? []).map((option) => option.category_id)).size !== input.optionIds.length) {
    throw new Error("A package can include only one option per category")
  }
  const payload = {
    community_id: input.communityId ?? null,
    name: input.name,
    description: input.description ?? null,
    image_url: input.imageUrl ?? null,
    price_cents: input.priceCents,
    cost_cents: input.costCents ?? null,
    is_available: input.isAvailable,
    sort_order: input.sortOrder,
  }
  const query = input.id
    ? context.supabase.from("selection_packages").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from("selection_packages").insert({ org_id: context.orgId, ...payload })
  const { data, error } = await query
    .select("id, community_id, name, description, image_url, price_cents, cost_cents, is_available, is_archived, sort_order")
    .single()
  if (error || !data) throw new Error(`Failed to save package: ${error?.message ?? "missing row"}`)
  const { error: deleteError } = await context.supabase
    .from("selection_package_items")
    .delete()
    .eq("org_id", context.orgId)
    .eq("package_id", data.id)
  if (deleteError) throw new Error(`Failed to replace package members: ${deleteError.message}`)
  const { error: itemError } = await context.supabase.from("selection_package_items").insert(
    input.optionIds.map((optionId) => ({ org_id: context.orgId, package_id: data.id, option_id: optionId })),
  )
  if (itemError) throw new Error(`Failed to save package members: ${itemError.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "selection_package", entityId: data.id, after: { ...payload, option_ids: input.optionIds } })
  return { ...data, option_ids: input.optionIds, cost_cents: data.cost_cents }
}

export async function setCatalogPrice(raw: CatalogPriceInput) {
  const input = catalogPriceSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const subjectColumn = input.optionId ? "option_id" : "package_id"
  const subjectId = input.optionId ?? input.packageId
  let lookup = context.supabase
    .from("selection_catalog_prices")
    .select("id")
    .eq("org_id", context.orgId)
    .eq(subjectColumn, subjectId)
    .eq("house_plan_version_id", input.housePlanVersionId)
  lookup = input.communityId ? lookup.eq("community_id", input.communityId) : lookup.is("community_id", null)
  const { data: existing, error: lookupError } = await lookup.maybeSingle()
  if (lookupError) throw new Error(`Failed to find catalog price: ${lookupError.message}`)
  return saveCatalogEntity({
    table: "selection_catalog_prices",
    id: existing?.id,
    payload: {
      option_id: input.optionId ?? null,
      package_id: input.packageId ?? null,
      house_plan_version_id: input.housePlanVersionId,
      community_id: input.communityId ?? null,
      price_cents: input.priceCents,
      cost_cents: input.costCents ?? null,
      is_available: input.isAvailable,
    },
    select: "id, option_id, package_id, house_plan_version_id, community_id, price_cents, cost_cents, is_available",
    entityType: "selection_catalog_price",
  })
}

export async function resolveOptionPricing(opts: {
  orgId: string
  items: Array<{ optionId?: string; packageId?: string }>
  housePlanVersionId?: string
  communityId?: string
}): Promise<ResolvedOptionPricing[]> {
  const supabase = createServiceSupabaseClient()
  const optionIds = opts.items.map((item) => item.optionId).filter((value): value is string => Boolean(value))
  const packageIds = opts.items.map((item) => item.packageId).filter((value): value is string => Boolean(value))
  const [optionsResult, overridesResult, packagesResult, pricesResult] = await Promise.all([
    optionIds.length
      ? supabase.from("selection_options").select("id, parent_option_id, community_id, price_cents, cost_cents, cost_code_id, vendor, sku, lead_time_days, is_available").eq("org_id", opts.orgId).in("id", optionIds)
      : Promise.resolve({ data: [], error: null }),
    opts.communityId && optionIds.length
      ? supabase.from("selection_options").select("id, parent_option_id, community_id, price_cents, cost_cents, cost_code_id, vendor, sku, lead_time_days, is_available").eq("org_id", opts.orgId).eq("community_id", opts.communityId).in("parent_option_id", optionIds)
      : Promise.resolve({ data: [], error: null }),
    packageIds.length
      ? supabase.from("selection_packages").select("id, community_id, price_cents, cost_cents, is_available").eq("org_id", opts.orgId).in("id", packageIds)
      : Promise.resolve({ data: [], error: null }),
    opts.housePlanVersionId
      ? supabase.from("selection_catalog_prices").select("option_id, package_id, community_id, price_cents, cost_cents, is_available").eq("org_id", opts.orgId).eq("house_plan_version_id", opts.housePlanVersionId).or(`community_id.is.null${opts.communityId ? `,community_id.eq.${opts.communityId}` : ""}`)
      : Promise.resolve({ data: [], error: null }),
  ])
  for (const result of [optionsResult, overridesResult, packagesResult, pricesResult]) {
    if (result.error) throw new Error(`Failed to resolve option pricing: ${result.error.message}`)
  }
  return opts.items.map((item) => {
    const baseOption = (optionsResult.data ?? []).find((option) => option.id === item.optionId)
    const override = (overridesResult.data ?? []).find((option) => option.parent_option_id === item.optionId)
    const option = override ?? baseOption
    const selectionPackage = (packagesResult.data ?? []).find((candidate) => candidate.id === item.packageId)
    if (!option && !selectionPackage) throw new Error("Catalog item was not found")
    const optionSubjectIds = Array.from(new Set([item.optionId, option?.id].filter((value): value is string => Boolean(value))))
    const relevantPrices = (pricesResult.data ?? []).filter((price) =>
      item.optionId ? Boolean(price.option_id && optionSubjectIds.includes(price.option_id)) : price.package_id === selectionPackage?.id,
    )
    const chosen = chooseResolvedPrice({
      basePriceCents: Number(option?.price_cents ?? selectionPackage?.price_cents ?? 0),
      baseCostCents: option?.cost_cents ?? selectionPackage?.cost_cents ?? null,
      baseAvailable: option?.is_available ?? selectionPackage?.is_available ?? false,
      communityPrice: relevantPrices.find((price) => price.community_id === opts.communityId) ?? null,
      planPrice: relevantPrices.find((price) => price.community_id === null) ?? null,
      isCommunityOption: Boolean(option?.community_id ?? selectionPackage?.community_id),
    })
    return {
      ...(item.optionId ? { optionId: option?.id ?? item.optionId } : { packageId: selectionPackage?.id ?? item.packageId }),
      priceCents: Number(chosen.price_cents),
      costCents: chosen.cost_cents == null ? null : Number(chosen.cost_cents),
      costCodeId: option?.cost_code_id ?? null,
      vendor: option?.vendor ?? null,
      sku: option?.sku ?? null,
      leadTimeDays: option?.lead_time_days == null ? null : Number(option.lead_time_days),
      available: chosen.is_available,
      source: chosen.source,
    }
  })
}

export type PlanColumn = {
  versionId: string
  planId: string
  planName: string
  versionLabel: string
}

export type PlanPriceCell = {
  priceCents: number | null
  costCents: number | null
  isAvailable: boolean
  /** False when the cell falls back to the option's base price. */
  isOverride: boolean
}

export type PlanPricingMatrix = {
  plans: PlanColumn[]
  /** Keyed `${optionId}:${versionId}`. Absent keys inherit the base price. */
  cells: Record<string, PlanPriceCell>
}

/**
 * Options priced per released plan version. The same quartz counter costs
 * different money in a 1,600 sf plan than a 3,200 sf one, which is what
 * `selection_catalog_prices` exists to express; this assembles it into the grid
 * the catalog screen edits.
 */
export async function listPlanPricingMatrix(
  opts: { communityId?: string; optionIds: string[] } = { optionIds: [] },
): Promise<PlanPricingMatrix> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  if (opts.optionIds.length === 0) return { plans: [], cells: {} }

  const [versionsResult, pricesResult] = await Promise.all([
    context.supabase
      .from("house_plan_versions")
      .select("id, house_plan_id, version_number, label, status, plan:house_plans(name)")
      .eq("org_id", context.orgId)
      .eq("status", "released")
      .order("version_number", { ascending: false })
      .limit(100),
    context.supabase
      .from("selection_catalog_prices")
      .select("option_id, house_plan_version_id, community_id, price_cents, cost_cents, is_available")
      .eq("org_id", context.orgId)
      .in("option_id", opts.optionIds.slice(0, 200))
      .limit(4000),
  ])
  if (versionsResult.error) throw new Error(`Failed to load plan versions: ${versionsResult.error.message}`)
  if (pricesResult.error) throw new Error(`Failed to load plan pricing: ${pricesResult.error.message}`)

  const seenPlans = new Set<string>()
  const plans: PlanColumn[] = []
  for (const row of versionsResult.data ?? []) {
    const planId = row.house_plan_id as string
    // One column per plan: its latest released version is the one being sold.
    if (seenPlans.has(planId)) continue
    seenPlans.add(planId)
    const plan = Array.isArray(row.plan) ? row.plan[0] : row.plan
    plans.push({
      versionId: row.id as string,
      planId,
      planName: plan?.name ?? "Plan",
      versionLabel: (row.label as string | null) ?? `v${row.version_number}`,
    })
  }

  const cells: Record<string, PlanPriceCell> = {}
  for (const row of pricesResult.data ?? []) {
    if (!row.option_id) continue
    // A community-specific price wins over the org-wide one for the same cell.
    const key = `${row.option_id}:${row.house_plan_version_id}`
    const isCommunity = row.community_id === opts.communityId
    if (row.community_id !== null && !isCommunity) continue
    if (cells[key]?.isOverride && !isCommunity) continue
    cells[key] = {
      priceCents: row.price_cents,
      costCents: row.cost_cents,
      isAvailable: row.is_available,
      isOverride: true,
    }
  }
  return { plans: plans.sort((a, b) => a.planName.localeCompare(b.planName)), cells }
}

export async function listSelectionGroups(opts: { communityId?: string } = {}): Promise<SelectionGroupDto[]> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  let query = context.supabase
    .from("selection_groups")
    .select("id, community_id, name, schedule_task_key, cutoff_offset_days, cutoff_anchor, sort_order, is_archived")
    .eq("org_id", context.orgId)
    .eq("is_archived", false)
    .order("sort_order")
  query = opts.communityId ? query.or(`community_id.is.null,community_id.eq.${opts.communityId}`) : query.is("community_id", null)
  const { data, error } = await query.limit(500)
  if (error) throw new Error(`Failed to load selection groups: ${error.message}`)
  const ids = (data ?? []).map((group) => group.id)
  const { data: links, error: linkError } = ids.length
    ? await context.supabase.from("selection_group_categories").select("group_id, category_id").eq("org_id", context.orgId).in("group_id", ids)
    : { data: [], error: null }
  if (linkError) throw new Error(`Failed to load selection group categories: ${linkError.message}`)
  return (data ?? []).map((group) => ({
    ...group,
    cutoff_anchor: group.cutoff_anchor as "start" | "end",
    category_ids: (links ?? []).filter((link) => link.group_id === group.id).map((link) => link.category_id),
  }))
}

export async function upsertSelectionGroup(raw: SelectionGroupInput): Promise<SelectionGroupDto> {
  const input = selectionGroupSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const payload = {
    community_id: input.communityId ?? null,
    name: input.name,
    schedule_task_key: input.scheduleTaskKey,
    cutoff_offset_days: input.cutoffOffsetDays,
    cutoff_anchor: input.cutoffAnchor,
    sort_order: input.sortOrder,
  }
  const query = input.id
    ? context.supabase.from("selection_groups").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from("selection_groups").insert({ org_id: context.orgId, ...payload })
  const { data, error } = await query.select("id, community_id, name, schedule_task_key, cutoff_offset_days, cutoff_anchor, sort_order, is_archived").single()
  if (error || !data) throw new Error(`Failed to save selection group: ${error?.message ?? "missing row"}`)
  await setGroupCategories(data.id, input.categoryIds, context)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "selection_group", entityId: data.id, after: { ...payload, category_ids: input.categoryIds } })
  return { ...data, cutoff_anchor: data.cutoff_anchor as "start" | "end", category_ids: input.categoryIds }
}

async function setGroupCategories(
  groupId: string,
  categoryIds: string[],
  existingContext?: Awaited<ReturnType<typeof requireOrgContext>>,
) {
  const context = existingContext ?? (await requireOrgContext())
  if (!existingContext) await requirePermission("selections.catalog.manage", context)
  const { error: deleteError } = await context.supabase.from("selection_group_categories").delete().eq("org_id", context.orgId).eq("group_id", groupId)
  if (deleteError) throw new Error(`Failed to replace group categories: ${deleteError.message}`)
  if (categoryIds.length === 0) return
  const { error } = await context.supabase.from("selection_group_categories").insert(
    categoryIds.map((categoryId) => ({ org_id: context.orgId, group_id: groupId, category_id: categoryId })),
  )
  if (error) throw new Error(`Failed to save group categories: ${error.message}`)
}

export async function cloneOrgGroupsToCommunity(communityId: string) {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const groups = await listSelectionGroups()
  for (const group of groups) {
    await upsertSelectionGroup({
      communityId,
      name: group.name,
      scheduleTaskKey: group.schedule_task_key,
      cutoffOffsetDays: group.cutoff_offset_days,
      cutoffAnchor: group.cutoff_anchor,
      sortOrder: group.sort_order,
      categoryIds: group.category_ids,
    })
  }
}

export async function listAppointments(opts: {
  communityId?: string
  from?: string
  to?: string
  status?: AppointmentDto["status"]
  limit?: number
} = {}): Promise<AppointmentDto[]> {
  const context = await requireOrgContext()
  // Reading the calendar is part of every selections read surface — a
  // superintendent checking a cutoff must not be blocked by the coordinator's
  // manage permission. Booking and rescheduling keep the stricter gate.
  await requirePermission("selections.read", context)
  let query = context.supabase
    .from("design_studio_appointments")
    .select("id, community_id, project_id, contact_id, coordinator_user_id, scheduled_at, duration_minutes, location, status, group_ids, notes, project:projects(name), community:communities(name), buyer:contacts(full_name), coordinator:app_users(full_name)")
    .eq("org_id", context.orgId)
    .order("scheduled_at")
    .limit(Math.min(opts.limit ?? 50, 100))
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.from) query = query.gte("scheduled_at", opts.from)
  if (opts.to) query = query.lte("scheduled_at", opts.to)
  if (opts.status) query = query.eq("status", opts.status)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load design studio appointments: ${error.message}`)
  return (data ?? []).map((row) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    const community = Array.isArray(row.community) ? row.community[0] : row.community
    const buyer = Array.isArray(row.buyer) ? row.buyer[0] : row.buyer
    const coordinator = Array.isArray(row.coordinator) ? row.coordinator[0] : row.coordinator
    return {
      ...row,
      status: row.status as AppointmentDto["status"],
      project_name: project?.name ?? null,
      community_name: community?.name ?? null,
      buyer_name: buyer?.full_name ?? null,
      coordinator_name: coordinator?.full_name ?? null,
    }
  })
}

export async function upsertAppointment(raw: AppointmentInput): Promise<AppointmentDto> {
  const input = appointmentSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  const payload = {
    community_id: input.communityId ?? null,
    project_id: input.projectId,
    contact_id: input.contactId ?? null,
    coordinator_user_id: input.coordinatorUserId ?? null,
    scheduled_at: input.scheduledAt,
    duration_minutes: input.durationMinutes,
    location: input.location ?? null,
    status: input.status,
    group_ids: input.groupIds,
    notes: input.notes ?? null,
  }
  const query = input.id
    ? context.supabase.from("design_studio_appointments").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from("design_studio_appointments").insert({ org_id: context.orgId, ...payload })
  const { data, error } = await query
    .select("id, community_id, project_id, contact_id, coordinator_user_id, scheduled_at, duration_minutes, location, status, group_ids, notes")
    .single()
  if (error || !data) throw new Error(`Failed to save appointment: ${error?.message ?? "missing row"}`)
  const eventType = input.id ? "design_studio_appointment_updated" : "design_studio_appointment_created"
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType, entityType: "design_studio_appointment", entityId: data.id, payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "design_studio_appointment", entityId: data.id, after: payload }),
  ])
  return { ...data, status: data.status as AppointmentDto["status"] }
}
