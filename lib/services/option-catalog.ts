import { publishCatalogGroup } from "@/lib/services/catalog-group-publication"
import { publishCatalogPriceBatch } from "@/lib/services/catalog-price-publication"
import { z } from "zod"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { publishCatalogPackage } from "@/lib/services/catalog-package-publication"
import { readAllRows, readAllRowsById } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { buildFilesPublicUrl } from "@/lib/storage/files-storage"
import { allocatePackageTotal, chooseResolvedPrice } from "@/lib/selections/catalog-math"
import { modelChangesSchema, type ModelChange } from "@/lib/drawings/model-options"

export { allocatePackageTotal, chooseResolvedPrice } from "@/lib/selections/catalog-math"
import {
  appointmentSchema,
  catalogCategorySchema,
  catalogOptionSchema,
  catalogPriceSchema,
  catalogPricePublicationSchema,
  catalogPriceSourceSchema,
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
  /** What choosing the option does to the house in the 3D model. */
  model_changes: ModelChange[]
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
  categoryId: string | null
  categoryIds: string[]
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
type OptionRow = Omit<CatalogOptionDto, "source" | "cost_cents" | "model_changes"> & { cost_cents: number | null; model_changes?: unknown }

const OPTION_COLUMNS = "id, category_id, parent_option_id, community_id, name, description, option_scope, price_cents, cost_cents, cost_code_id, sku, vendor, lead_time_days, image_url, file_id, is_available, is_archived, is_default, sort_order"

/**
 * `selection_options.model_changes` arrives with migration
 * 20261004124500_option_model_changes. Until it is applied, PostgREST answers
 * a select or write naming the column with one of these codes, and the catalog
 * must keep working without it.
 */
function isMissingModelChangesColumn(error: { code?: string; message?: string } | null) {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && (error.message ?? "").includes("model_changes")
}

/** Stored JSON is only trusted once it parses; anything else reads as no changes. */
function parseModelChanges(value: unknown): ModelChange[] {
  const parsed = modelChangesSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}
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

const catalogScopeSchema = z.object({ communityId: z.string().uuid().transform(value => value.toLowerCase()).optional() })

async function requireCatalogCommunityAccess(context: Awaited<ReturnType<typeof requireOrgContext>>, communityId?: string) {
  if (!communityId) return
  const [access, community] = await Promise.all([
    getDivisionAccessForUser(context),
    context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", communityId).maybeSingle(),
  ])
  if (community.error || !community.data || (access.assignedOnly && !access.divisionIds.includes(community.data.division_id))) {
    throw new Error("Catalog community is outside your division access")
  }
}

export async function listCatalog(
  opts: { communityId?: string; includeArchived?: boolean; includeOptions?: boolean; includeCategories?: boolean } = {},
  orgId?: string,
): Promise<CatalogDto> {
  opts = catalogScopeSchema.extend({ includeArchived: z.boolean().optional(), includeOptions: z.boolean().optional(), includeCategories: z.boolean().optional() }).strict().parse(opts)
  const context = await requireOrgContext(orgId)
  await requirePermission("selections.read", context)
  await requireCatalogCommunityAccess(context, opts.communityId)
  const canReadMargin = await hasPermission("financials.margin.read", context)
  const scope = `community_id.is.null,community_id.eq.${opts.communityId}`
  const [categoryData, optionData, packageData] = await Promise.all([
    opts.includeCategories === false ? Promise.resolve<CategoryRow[]>([]) : readAllRowsById((afterId, take) => {
      let query = context.supabase.from("selection_categories")
        .select("id, parent_category_id, community_id, name, description, image_url, is_archived, sort_order")
        .eq("org_id", context.orgId).order("id").limit(take)
      query = opts.communityId ? query.or(scope) : query.is("community_id", null)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: 2000, label: "Catalog categories", pageSize: 500 }),
    opts.includeOptions === false ? Promise.resolve<OptionRow[]>([]) : (() => {
      let withModelChanges = true
      const page = (columns: string, afterId: string | null, take: number) => {
        let query = context.supabase.from("selection_options")
          .select(columns)
          .eq("org_id", context.orgId).order("id").limit(take)
        query = opts.communityId ? query.or(scope) : query.is("community_id", null)
        return (afterId ? query.gt("id", afterId) : query).returns<OptionRow[]>()
      }
      return readAllRowsById<OptionRow>(async (afterId, take) => {
        if (withModelChanges) {
          const result = await page(`${OPTION_COLUMNS}, model_changes`, afterId, take)
          if (!isMissingModelChangesColumn(result.error)) return result
          withModelChanges = false
        }
        return page(OPTION_COLUMNS, afterId, take)
      }, { cap: 10000, label: "Catalog options", pageSize: 500 })
    })(),
    readAllRowsById((afterId, take) => {
      let query = context.supabase.from("selection_packages")
        .select("id, community_id, name, description, image_url, price_cents, cost_cents, is_available, is_archived, sort_order")
        .eq("org_id", context.orgId).order("id").limit(take)
      query = opts.communityId ? query.or(scope) : query.is("community_id", null)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: 2000, label: "Catalog packages", pageSize: 500 }),
  ])
  const bySortOrder = (a: { sort_order: number; id: string }, b: { sort_order: number; id: string }) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)
  categoryData.sort(bySortOrder)
  optionData.sort(bySortOrder)
  packageData.sort(bySortOrder)
  const packageIds = packageData.filter(row => opts.includeArchived || !row.is_archived).map(row => row.id)
  const items: Array<{ id: string; package_id: string; option_id: string }> = []
  for (let offset = 0; offset < packageIds.length; offset += 100) {
    const batch = packageIds.slice(offset, offset + 100)
    const members = await readAllRowsById((afterId, take) => {
      const query = context.supabase.from("selection_package_items").select("id,package_id,option_id")
        .eq("org_id", context.orgId).in("package_id", batch).order("id").limit(take)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: Math.max(1, 50000 - items.length), label: "Catalog package members", pageSize: 500 })
    items.push(...members)
    if (items.length > 50000) throw new Error("Catalog package members: Validation limit exceeded (50000 rows)")
  }
  const membersByPackage = new Map<string, string[]>()
  for (const item of items) {
    const members = membersByPackage.get(item.package_id) ?? []
    members.push(item.option_id)
    membersByPackage.set(item.package_id, members)
  }

  const categoryRows = categoryData.map((row) => ({
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
  const optionRows = optionData.map((row) => ({ ...row, parent_id: row.parent_option_id }))
  const effectiveOptions = mergeEffectiveRows(optionRows, opts.communityId).filter((row) => {
    const categoryId = baseToEffectiveCategory.get(row.category_id) ?? row.category_id
    return effectiveCategoryIds.has(categoryId)
  })
  const optionsByCategory = new Map<string, CatalogOptionDto[]>()
  for (const row of effectiveOptions) {
    if (!opts.includeArchived && row.is_archived) continue
    const categoryId = baseToEffectiveCategory.get(row.category_id) ?? row.category_id
    const { cost_cents, model_changes, ...visibleRow } = row
    const option: CatalogOptionDto = {
      ...visibleRow,
      category_id: categoryId,
      source: sourceFor(row.community_id, row.parent_option_id),
      model_changes: parseModelChanges(model_changes),
      ...(canReadMargin ? { cost_cents } : {}),
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

  const packageRows = packageData
  const packages = packageRows
    .filter((row) => row.community_id === null || row.community_id === opts.communityId)
    .filter((row) => opts.includeArchived || !row.is_archived)
    .map((row) => {
      const { cost_cents, ...visibleRow } = row
      return { ...visibleRow, ...(canReadMargin ? { cost_cents } : {}), option_ids: membersByPackage.get(row.id) ?? [] }
    })
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
  if ("model_changes" in input.payload && isMissingModelChangesColumn(error)) {
    throw new Error("3D model changes cannot be saved yet: the option_model_changes database migration is pending approval")
  }
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
      // Only written when the editor sent them, so saves keep working before the
      // column's migration lands and an omitted field never clears stored changes.
      ...(input.modelChanges ? { model_changes: input.modelChanges } : {}),
    },
    select: "id, org_id, category_id, community_id, parent_option_id, name, description, option_scope, price_cents, cost_cents, cost_code_id, sku, vendor, lead_time_days, image_url, file_id, sort_order, is_available, is_archived, is_default",
    entityType: "selection_option",
  })
  if (input.isStandard) await demoteOtherStandards(input.categoryId, saved.id, input.communityId ?? null)
  return saved
}

export type ModelOptionDto = {
  id: string
  name: string
  category: string | null
  modelChanges: ModelChange[]
}

export type ModelOptionList = { options: ModelOptionDto[]; truncated: boolean }

const MODEL_OPTION_CAP = 200

/**
 * The catalogue options a project's 3D model can show: sellable, unarchived
 * options that carry at least one model change, resolved for the project's
 * community (a community override replaces the org option it overrides).
 * Capped; `truncated` says when the cap cut the list.
 */
export async function listModelOptions(projectId: string): Promise<ModelOptionList> {
  const id = z.string().uuid().parse(projectId)
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const [project, lot] = await Promise.all([
    context.supabase.from("projects").select("id").eq("org_id", context.orgId).eq("id", id).maybeSingle(),
    context.supabase.from("lots").select("community_id").eq("org_id", context.orgId).eq("project_id", id).not("community_id", "is", null).limit(1).maybeSingle(),
  ])
  if (project.error) throw new Error(`Failed to load the project: ${project.error.message}`)
  if (!project.data) throw new Error("Project not found")
  if (lot.error) throw new Error(`Failed to load the project's lot: ${lot.error.message}`)
  const communityId: string | null = lot.data?.community_id ?? null
  await requireCatalogCommunityAccess(context, communityId ?? undefined)

  let optionsQuery = context.supabase.from("selection_options")
    .select("id, name, community_id, parent_option_id, sort_order, model_changes, category:selection_categories!inner(name, is_archived)")
    .eq("org_id", context.orgId)
    .eq("is_archived", false)
    .eq("is_available", true)
    .eq("category.is_archived", false)
    .neq("model_changes", "[]")
    .order("sort_order").order("id")
    .limit(MODEL_OPTION_CAP + 1)
  optionsQuery = communityId ? optionsQuery.or(`community_id.is.null,community_id.eq.${communityId}`) : optionsQuery.is("community_id", null)
  const [options, overrides] = await Promise.all([
    optionsQuery.returns<Array<{ id: string; name: string; community_id: string | null; parent_option_id: string | null; model_changes: unknown; category: { name: string } | null }>>(),
    communityId
      ? readAllRowsById((afterId, take) => {
        const query = context.supabase.from("selection_options").select("id, parent_option_id")
          .eq("org_id", context.orgId).eq("community_id", communityId).not("parent_option_id", "is", null)
          .order("id").limit(take)
        return afterId ? query.gt("id", afterId) : query
      }, { cap: 10000, label: "Community option overrides", pageSize: 500 })
      : Promise.resolve([]),
  ])
  if (isMissingModelChangesColumn(options.error)) return { options: [], truncated: false }
  if (options.error) throw new Error(`Failed to load model options: ${options.error.message}`)
  const overridden = new Set(overrides.map((row) => row.parent_option_id))
  const rows = (options.data ?? []).filter((row) => !overridden.has(row.id))
  const resolved = rows
    .map((row) => ({ id: row.id, name: row.name, category: row.category?.name ?? null, modelChanges: parseModelChanges(row.model_changes) }))
    .filter((row) => row.modelChanges.length > 0)
  return { options: resolved.slice(0, MODEL_OPTION_CAP), truncated: (options.data ?? []).length > MODEL_OPTION_CAP }
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
  if ((input.expectedOrgId && input.expectedOrgId !== context.orgId) || (input.expectedActorId && input.expectedActorId !== context.userId)) throw new Error("The catalog organization or signed-in actor changed; reopen this workspace before saving")
  await requirePermission("selections.catalog.manage", context)
  if ((input.requireAtomicPublication || input.isArchived !== undefined || input.editArchived) && process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED !== "true") throw new Error("Atomic package publication is unavailable. Retain the saved request until publication is enabled")
  if (process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED === "true") return publishCatalogPackage(context, input)
  const canReadMargin = await hasPermission("financials.margin.read", context)
  if (input.costCents !== undefined || input.expectedPackage?.cost_cents !== undefined) await requirePermission("financials.margin.read", context)
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
    ...(input.costCents !== undefined ? { cost_cents: input.costCents } : {}),
    is_available: input.isAvailable,
    sort_order: input.sortOrder,
  }
  const query = input.id
    ? context.supabase.from("selection_packages").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from("selection_packages").insert({ org_id: context.orgId, ...payload })
  const selected = canReadMargin
    ? query.select("id, community_id, name, description, image_url, price_cents, cost_cents, is_available, is_archived, sort_order")
    : query.select("id, community_id, name, description, image_url, price_cents, is_available, is_archived, sort_order")
  const { data, error } = await selected.single()
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
  const visible: SelectionPackageDto = { ...data, option_ids: input.optionIds }
  if (!canReadMargin) delete visible.cost_cents
  return visible
}

export async function setCatalogPrice(raw: CatalogPriceInput) {
  const input = catalogPriceSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  if ((input.expectedOrgId && input.expectedOrgId !== context.orgId) || (input.expectedActorId && input.expectedActorId !== context.userId)) throw new Error("Catalog organization or actor changed; reopen the workspace")
  if (process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED === "true") {
    if (!input.publicationKey || input.expectedPrice === undefined) throw new Error("Review the current price and retain its publication key before saving")
    return publishCatalogPriceBatch(context, catalogPricePublicationSchema.parse({ ...input, items: [input] }))
  }
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
      ...(input.costCents !== undefined ? { cost_cents: input.costCents } : {}),
      is_available: input.isAvailable,
    },
    select: "id, option_id, package_id, house_plan_version_id, community_id, price_cents, cost_cents, is_available",
    entityType: "selection_catalog_price",
  })
}

export async function publishCatalogPrices(raw: unknown) {
  const input = catalogPricePublicationSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  if ((input.expectedOrgId && input.expectedOrgId !== context.orgId) || (input.expectedActorId && input.expectedActorId !== context.userId)) throw new Error("Catalog organization or actor changed; reopen the workspace")
  if (process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED !== "true") throw new Error("Atomic price publication is not enabled; no prices were changed")
  return publishCatalogPriceBatch(context, input)
}

export async function resolveOptionPricing(opts: {
  orgId: string
  items: Array<{ optionId?: string; packageId?: string }>
  housePlanVersionId?: string
  communityId?: string
}): Promise<ResolvedOptionPricing[]> {
  const supabase = createServiceSupabaseClient()
  if (opts.items.some((item) => Boolean(item.optionId) === Boolean(item.packageId))) throw new Error("Choose exactly one option or package for each pricing item")
  const optionIds = [...new Set(opts.items.map((item) => item.optionId).filter((value): value is string => Boolean(value)))]
  const packageIds = [...new Set(opts.items.map((item) => item.packageId).filter((value): value is string => Boolean(value)))]
  type CatalogRow = { id: string; category_id?: string; parent_option_id?: string | null; community_id: string | null; price_cents: number; cost_cents: number | null; cost_code_id?: string | null; vendor?: string | null; sku?: string | null; lead_time_days?: number | null; is_available: boolean; is_archived: boolean }
  async function readCatalog(table: "selection_options" | "selection_packages", ids: string[], column: "id" | "parent_option_id", communityId?: string) {
    const rows: CatalogRow[] = []
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = await readAllRowsById<CatalogRow>((cursor, take) => {
        let query = supabase.from(table).select(table === "selection_options"
          ? "id, category_id, is_archived, parent_option_id, community_id, price_cents, cost_cents, cost_code_id, vendor, sku, lead_time_days, is_available"
          : "id, is_archived, community_id, price_cents, cost_cents, is_available")
          .eq("org_id", opts.orgId).in(column, ids.slice(offset, offset + 100)).order("id").limit(take)
        if (communityId) query = query.eq("community_id", communityId)
        if (cursor) query = query.gt("id", cursor)
        return query.returns<CatalogRow[]>()
      }, { pageSize: 500, cap: 10_000, label: "Failed to resolve option pricing" })
      rows.push(...batch)
    }
    return rows
  }
  const [options, overrides, packages] = await Promise.all([
    readCatalog("selection_options", optionIds, "id"),
    opts.communityId ? readCatalog("selection_options", optionIds, "parent_option_id", opts.communityId) : [],
    readCatalog("selection_packages", packageIds, "id"),
  ])
  type CategoryRow = { id: string; parent_category_id: string | null; community_id: string | null; is_archived: boolean }
  const categoryIds = [...new Set([...options, ...overrides].map((row) => row.category_id).filter((id): id is string => Boolean(id)))]
  const categories: CategoryRow[] = []
  for (let offset = 0; offset < categoryIds.length; offset += 100) {
    for (const column of ["id", ...(opts.communityId ? ["parent_category_id"] : [])]) {
      const batch = await readAllRowsById<CategoryRow>((cursor, take) => {
        let query = supabase.from("selection_categories").select("id,parent_category_id,community_id,is_archived")
          .eq("org_id", opts.orgId).in(column, categoryIds.slice(offset, offset + 100)).order("id").limit(take)
        if (column === "parent_category_id") query = query.eq("community_id", opts.communityId!)
        if (cursor) query = query.gt("id", cursor)
        return query
      }, { pageSize: 500, cap: 10_000, label: "Failed to validate option categories" })
      categories.push(...batch)
    }
  }
  const categoriesById = new Map(categories.map((category) => [category.id, category]))
  const categoryOverrides = new Map<string, CategoryRow>()
  for (const category of categoriesById.values()) {
    if (category.community_id !== opts.communityId || !category.parent_category_id) continue
    if (categoryOverrides.has(category.parent_category_id)) throw new Error("Multiple community category overrides match this item")
    categoryOverrides.set(category.parent_category_id, category)
  }
  const canonicalCategory = (id?: string) => id ? categoriesById.get(id)?.parent_category_id ?? id : null
  const priceRows: Array<{ id: string; option_id: string | null; package_id: string | null; community_id: string | null; price_cents: number; cost_cents: number | null; is_available: boolean }> = []
  if (opts.housePlanVersionId) {
    const resolvedOptionIds = [...new Set([...optionIds, ...overrides.map((option) => option.id)])]
    for (const [column, ids] of [["option_id", resolvedOptionIds], ["package_id", packageIds]] as const) {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = await readAllRowsById<(typeof priceRows)[number]>((cursor, take) => {
          let query = supabase.from("selection_catalog_prices")
            .select("id,option_id,package_id,community_id,price_cents,cost_cents,is_available")
            .eq("org_id", opts.orgId).eq("house_plan_version_id", opts.housePlanVersionId!)
            .in(column, ids.slice(offset, offset + 100))
            .or(`community_id.is.null${opts.communityId ? `,community_id.eq.${opts.communityId}` : ""}`)
            .order("id").limit(take)
          if (cursor) query = query.gt("id", cursor)
          return query
        }, { pageSize: 500, cap: 10_000, label: "Failed to resolve option prices" })
        priceRows.push(...batch)
      }
    }
  }
  const optionsById = new Map(options.map((row) => [row.id, row]))
  const packagesById = new Map(packages.map((row) => [row.id, row]))
  const overridesByParent = new Map<string, CatalogRow>()
  for (const override of overrides) {
    if (!override.parent_option_id) continue
    if (overridesByParent.has(override.parent_option_id)) throw new Error("Multiple community overrides match this option; reconcile the catalog before proceeding")
    overridesByParent.set(override.parent_option_id, override)
  }
  const pricesBySubject = new Map<string, typeof priceRows>()
  for (const price of priceRows) {
    const key = price.option_id ? `option:${price.option_id}` : `package:${price.package_id}`
    const group = pricesBySubject.get(key) ?? []
    if (group.some((row) => row.community_id === price.community_id)) throw new Error("Multiple prices match this item and scope; reconcile the catalog before proceeding")
    group.push(price)
    pricesBySubject.set(key, group)
  }
  return opts.items.map((item) => {
    const baseOption = item.optionId ? optionsById.get(item.optionId) : undefined
    const override = item.optionId ? overridesByParent.get(item.optionId) : undefined
    const option = override ?? baseOption
    if (override && baseOption && canonicalCategory(override.category_id) !== canonicalCategory(baseOption.category_id)) throw new Error("Community override belongs to a different selection category")
    const category = option?.category_id ? categoriesById.get(option.category_id) : undefined
    const effectiveCategory = option?.category_id ? categoryOverrides.get(option.category_id) ?? category : undefined
    const acceptedCategoryIds = option ? [...new Set([option.category_id, category?.parent_category_id, effectiveCategory?.id].filter((id): id is string => Boolean(id)))] : []
    const selectionPackage = item.packageId ? packagesById.get(item.packageId) : undefined
    if (!option && !selectionPackage) throw new Error("Catalog item was not found")
    const optionSubjectIds = Array.from(new Set([item.optionId, option?.id].filter((value): value is string => Boolean(value))))
    const relevantPrices = item.optionId
      ? optionSubjectIds.flatMap((id) => pricesBySubject.get(`option:${id}`) ?? [])
      : pricesBySubject.get(`package:${selectionPackage?.id}`) ?? []
    const pickPrice = (communityId: string | null) => relevantPrices.find((price) => price.community_id === communityId && (!item.optionId || price.option_id === option?.id))
      ?? relevantPrices.find((price) => price.community_id === communityId)
    const chosen = chooseResolvedPrice({
      basePriceCents: Number(option?.price_cents ?? selectionPackage?.price_cents ?? 0),
      baseCostCents: option?.cost_cents ?? selectionPackage?.cost_cents ?? null,
      baseAvailable: option?.is_available ?? selectionPackage?.is_available ?? false,
      communityPrice: opts.communityId ? pickPrice(opts.communityId) ?? null : null,
      planPrice: pickPrice(null) ?? null,
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
      categoryId: option?.category_id ?? null,
      categoryIds: acceptedCategoryIds,
      available: chosen.is_available && (!option || Boolean(effectiveCategory && !effectiveCategory.is_archived && (!effectiveCategory.community_id || effectiveCategory.community_id === opts.communityId))) && !(option?.is_archived ?? selectionPackage?.is_archived ?? false)
        && (!(option?.community_id ?? selectionPackage?.community_id) || (option?.community_id ?? selectionPackage?.community_id) === opts.communityId),
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
  costCents?: number | null
  isAvailable: boolean
  isOverride: boolean
  ownPrice: z.infer<typeof catalogPriceSourceSchema> | null
}

export type PlanPricingMatrix = {
  plans: PlanColumn[]
  cells: Record<string, PlanPriceCell>
  planPage: number
  hasMorePlans: boolean
  optionPage: number
  hasMoreOptions: boolean
  optionIds: string[]
  atomicPricing: boolean
  includeOlderVersions: boolean
}

const matrixReplySchema = z.object({
  orgId: z.string().uuid(),
  plans: z.array(z.object({ versionId: z.string().uuid(), planId: z.string().uuid(), planName: z.string(), versionLabel: z.string() })).max(20),
  cells: z.record(z.object({ priceCents: z.number().int().min(0), costCents: z.number().int().nullable().optional(), isAvailable: z.boolean(), isOverride: z.boolean(), ownPrice: catalogPriceSourceSchema.nullable() })),
  planPage: z.number().int().min(1), hasMorePlans: z.boolean(), canReadMargin: z.boolean(),
})

/** Only the visible 20 × 20 window travels to the browser; pages are explicit. */
export async function listPlanPricingMatrix(opts: { communityId?: string; optionIds: string[]; planPage?: number; optionPage?: number; includeOlderVersions?: boolean } = { optionIds: [] }): Promise<PlanPricingMatrix> {
  const input = z.object({ communityId: z.string().uuid().transform(value => value.toLowerCase()).optional(), optionIds: z.array(z.string().uuid()).max(10000), planPage: z.number().int().min(1).max(10000).default(1), optionPage: z.number().int().min(1).max(10000).default(1), includeOlderVersions: z.boolean().default(false) }).parse(opts)
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const uniqueIds = [...new Set(input.optionIds.map(id => id.toLowerCase()))]
  const optionIds = uniqueIds.slice((input.optionPage - 1) * 20, input.optionPage * 20)
  const window = { optionPage: input.optionPage, hasMoreOptions: uniqueIds.length > input.optionPage * 20, optionIds, includeOlderVersions: input.includeOlderVersions }
  if (process.env.ARC_CATALOG_ATOMIC_PUBLICATION_ENABLED === "true") {
    const { data, error } = await createServiceSupabaseClient().rpc("read_catalog_price_matrix", { p_org_id: context.orgId, p_actor_id: context.userId, p_community_id: input.communityId ?? null, p_option_ids: optionIds, p_page: input.planPage, p_latest_only: !input.includeOlderVersions })
    if (error) throw new Error(`Unable to load pricing window: ${error.message}`)
    const parsed = matrixReplySchema.parse(data)
    if (parsed.orgId !== context.orgId || parsed.planPage !== input.planPage || Object.keys(parsed.cells).length > optionIds.length * parsed.plans.length) throw new Error("Pricing window reply is inconsistent")
    for (const key of Object.keys(parsed.cells)) if (!optionIds.some(id => parsed.plans.some(plan => key === `${id}:${plan.versionId}`))) throw new Error("Pricing reply contains a cell outside the requested window")
    if (!parsed.canReadMargin) for (const cell of Object.values(parsed.cells)) { delete cell.costCents; if (cell.ownPrice) delete cell.ownPrice.cost_cents }
    return { plans: parsed.plans, cells: parsed.cells, planPage: parsed.planPage, hasMorePlans: parsed.hasMorePlans, ...window, atomicPricing: true }
  }
  // Complete bounded compatibility reads until the indexed RPC is approved.
  if (input.communityId) {
    const [access, community] = await Promise.all([getDivisionAccessForUser(context), context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", input.communityId).maybeSingle()])
    if (community.error || !community.data || (access.assignedOnly && !access.divisionIds.includes(community.data.division_id))) throw new Error("Pricing community is outside your division access")
  }
  const canReadMargin = await hasPermission("financials.margin.read", context)
  const versions = await readAllRowsById((cursor,take) => {
    const query = context.supabase.from("house_plan_versions").select("id,house_plan_id,version_number,label,plan:house_plans!inner(name,status,org_id)").eq("org_id",context.orgId).eq("status","released").eq("plan.org_id",context.orgId).eq("plan.status","active").order("id").limit(take)
    return cursor ? query.gt("id",cursor) : query
  }, { cap: 20000, pageSize: 500, label: "Released plan pricing versions" })
  versions.sort((a,b) => b.version_number-a.version_number || a.id.localeCompare(b.id))
  const seen = new Set<string>(), columns: PlanColumn[] = []
  for (const row of versions) {
    if (!input.includeOlderVersions && seen.has(row.house_plan_id)) continue
    seen.add(row.house_plan_id)
    const plan = Array.isArray(row.plan) ? row.plan[0] : row.plan
    columns.push({ versionId: row.id, planId: row.house_plan_id, planName: plan.name, versionLabel: row.label ?? `v${row.version_number}` })
  }
  columns.sort((a,b) => a.planName.toLowerCase().localeCompare(b.planName.toLowerCase()) || a.planId.localeCompare(b.planId))
  const plans = columns.slice((input.planPage-1)*20,input.planPage*20)
  const versionIds = plans.map(plan => plan.versionId)
  const rows = optionIds.length && versionIds.length ? await readAllRowsById((cursor,take) => {
    const table = context.supabase.from("selection_catalog_prices")
    let query = (canReadMargin
      ? table.select("id,option_id,house_plan_version_id,community_id,price_cents,is_available,cost_cents")
      : table.select("id,option_id,house_plan_version_id,community_id,price_cents,is_available"))
      .eq("org_id",context.orgId).in("option_id",optionIds).in("house_plan_version_id",versionIds).order("id").limit(take)
    query = input.communityId ? query.or(`community_id.is.null,community_id.eq.${input.communityId}`) : query.is("community_id",null)
    return cursor ? query.gt("id",cursor) : query
  }, { cap: 800, pageSize: 500, label: "Plan pricing cells" }) : []
  const cells: Record<string, PlanPriceCell> = {}
  for (const row of rows) {
    const key = `${row.option_id}:${row.house_plan_version_id}`, own = row.community_id === (input.communityId ?? null)
    if (cells[key]?.ownPrice && !own) continue
    cells[key] = { priceCents: row.price_cents, isAvailable: row.is_available, isOverride: true,
      ownPrice: own ? { id: row.id, price_cents: row.price_cents, is_available: row.is_available } : null,
      ...(canReadMargin && "cost_cents" in row ? { costCents: z.number().int().nullable().parse(row.cost_cents) } : {}) }
  }
  return { plans,cells,planPage:input.planPage,hasMorePlans:columns.length>input.planPage*20,...window,atomicPricing:false }
}

export type SelectionGroupPage = { groups: SelectionGroupDto[]; nextCursor: string | null }

export async function listSelectionGroupPage(raw: { communityId?: string; cursor?: string | null } = {}): Promise<SelectionGroupPage> {
  const opts = catalogScopeSchema.extend({ cursor: z.string().uuid().transform(value => value.toLowerCase()).nullable().optional() }).strict().parse(raw)
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  await requireCatalogCommunityAccess(context, opts.communityId)
  const rows: Array<Omit<SelectionGroupDto, "category_ids">> = []
  let after = opts.cursor ?? null
  while (rows.length < 26) {
    let query = context.supabase.from("selection_groups")
      .select("id, org_id, community_id, name, schedule_task_key, cutoff_offset_days, cutoff_anchor, sort_order, is_archived")
      .eq("org_id", context.orgId).eq("is_archived", false).order("id").limit(26 - rows.length)
    query = opts.communityId ? query.or(`community_id.is.null,community_id.eq.${opts.communityId}`) : query.is("community_id", null)
    if (after) query = query.gt("id", after)
    const { data, error } = await query
    if (error || !Array.isArray(data) || data.length > 26 - rows.length) throw new Error(`Failed to load selection groups: ${error?.message ?? "invalid page"}`)
    if (!data.length) break
    for (const row of data) {
      if (row.org_id !== context.orgId || row.community_id !== null && row.community_id !== opts.communityId || row.is_archived || !z.string().uuid().safeParse(row.id).success || after && row.id <= after || !["start", "end"].includes(row.cutoff_anchor)) throw new Error("Selection group scope or continuation could not be verified")
      const { org_id: _orgId, ...group } = row
      rows.push({ ...group, cutoff_anchor: row.cutoff_anchor === "start" ? "start" : "end" })
      after = row.id
    }
  }
  const visible = rows.slice(0, 25), ids = visible.map(group => group.id)
  const links = ids.length ? await readAllRowsById((afterId, take) => {
    const query = context.supabase.from("selection_group_categories").select("id, org_id, group_id, category_id")
      .eq("org_id", context.orgId).in("group_id", ids).order("id").limit(take)
    return afterId ? query.gt("id", afterId) : query
  }, { cap: ids.length * 100, label: "Selection group category assignments", pageSize: 500 }) : []
  const byGroup = new Map<string, string[]>()
  for (const link of links) {
    if (link.org_id !== context.orgId || !ids.includes(link.group_id) || !z.string().uuid().safeParse(link.category_id).success) throw new Error("Selection group assignment scope could not be verified")
    const members = byGroup.get(link.group_id) ?? []
    if (members.includes(link.category_id) || members.length === 100) throw new Error("Selection group category assignments exceed the editable bound")
    members.push(link.category_id); byGroup.set(link.group_id, members)
  }
  return { groups: visible.map(group => ({ ...group, category_ids: byGroup.get(group.id) ?? [] })), nextCursor: rows.length === 26 ? visible.at(-1)?.id ?? null : null }
}

// Complete source for copying defaults. The desk uses bounded pages directly.
export async function listSelectionGroups(opts: { communityId?: string } = {}): Promise<SelectionGroupDto[]> {
  const groups: SelectionGroupDto[] = []
  let cursor: string | null = null
  do {
    const page = await listSelectionGroupPage({ ...opts, cursor })
    groups.push(...page.groups)
    if (groups.length > 2000) throw new Error("Copying cutoff rules exceeds the review limit (2000 rules)")
    cursor = page.nextCursor
  } while (cursor)
  return groups.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
}

async function validateGroupCategories(context: Awaited<ReturnType<typeof requireOrgContext>>, categoryIds: string[], communityId: string | null) {
  if (!categoryIds.length) return
  const read = async (ids: string[]) => {
    const rows = await readAllRowsById((afterId, take) => {
      const query = context.supabase.from("selection_categories").select("id, org_id, community_id, parent_category_id, is_archived")
        .eq("org_id", context.orgId).in("id", ids).order("id").limit(take)
      return afterId ? query.gt("id", afterId) : query
    }, { cap: ids.length, label: "Cutoff rule categories", pageSize: 100 })
    if (rows.some(row => !ids.includes(row.id))) throw new Error("Cutoff rule category identities could not be verified")
    return rows
  }
  const categories = await read(categoryIds)
  if (categories.length !== categoryIds.length || categories.some(row => row.org_id !== context.orgId || row.is_archived || row.community_id !== null && row.community_id !== communityId || row.parent_category_id && row.community_id === null)) {
    throw new Error("Cutoff rule categories must be active and belong to the original organization/community scope")
  }
  const parentIds = Array.from(new Set(categories.flatMap(row => row.parent_category_id ? [row.parent_category_id] : [])))
  if (parentIds.length) {
    const parents = await read(parentIds)
    if (parents.length !== parentIds.length || parents.some(row => row.org_id !== context.orgId || row.community_id !== null || row.parent_category_id !== null || row.is_archived)) throw new Error("Cutoff rule category override ancestry could not be verified")
  }
}

export async function upsertSelectionGroup(raw: SelectionGroupInput): Promise<SelectionGroupDto> {
  const input = selectionGroupSchema.parse(raw)
  const categoryIds = input.categoryIds.map(id => id.toLowerCase())
  if (new Set(categoryIds).size !== categoryIds.length) throw new Error("Cutoff rule category references must be unique")
  const context = await requireOrgContext()
  if (input.expectedOrgId && input.expectedOrgId !== context.orgId || input.expectedActorId && input.expectedActorId !== context.userId) throw new Error("Cutoff rule organization or actor changed; reopen the workspace")
  await requirePermission("selections.catalog.manage", context)
  const communityId = input.communityId?.toLowerCase() ?? null
  await requireCatalogCommunityAccess(context, communityId ?? undefined)
  if (input.requireAtomicPublication || input.publicationKey || input.expectedGroup !== undefined || input.expectedCategoryVersions !== undefined) return publishCatalogGroup(context, input)
  await validateGroupCategories(context, categoryIds, communityId)
  const payload = {
    community_id: communityId,
    name: input.name,
    schedule_task_key: input.scheduleTaskKey,
    cutoff_offset_days: input.cutoffOffsetDays,
    cutoff_anchor: input.cutoffAnchor,
    sort_order: input.sortOrder,
  }
  const { community_id: _scope, ...changes } = payload
  let query = input.id
    ? context.supabase.from("selection_groups").update(changes).eq("org_id", context.orgId).eq("id", input.id).eq("is_archived", false)
    : context.supabase.from("selection_groups").insert({ org_id: context.orgId, ...payload })
  if (input.id) query = communityId ? query.eq("community_id", communityId) : query.is("community_id", null)
  const { data, error } = await query.select("id, community_id, name, schedule_task_key, cutoff_offset_days, cutoff_anchor, sort_order, is_archived").single()
  if (error || !data) throw new Error(`Failed to save selection group: ${error?.message ?? "missing row"}`)
  await setGroupCategories(data.id, categoryIds, context)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "selection_group", entityId: data.id, after: { ...payload, category_ids: categoryIds } })
  return { ...data, cutoff_anchor: data.cutoff_anchor as "start" | "end", category_ids: categoryIds }
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
      expectedOrgId: context.orgId,
      expectedActorId: context.userId,
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
