import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { readAllRowsById } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { ConfigurationViolationError, evaluateConfigurationRules, type ConfigurationRule, type ConfigurationViolation } from "@/lib/selections/configuration-rules"
import { CONFIGURATION_LOCK_REASONS, suggestConfigurationFixes, type ConfigurationFix, type ConfigurationLockReason } from "@/lib/selections/configuration-fixes"
import { agreementLocksStructuralOptions } from "@/lib/selections/selection-variance"
import { getProjectPosture, isProductionProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { agreementConfigurationSchema } from "@/lib/validation/community-sales"

export const CONFIGURATION_RULES_FLAG = "production_configuration_rules"

// Unlike an optional display flag, a read failure must never disable an active control.
async function enabled(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("feature_flags").select("enabled,expires_at")
    .eq("org_id", orgId).eq("flag_key", CONFIGURATION_RULES_FLAG).order("updated_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`Unable to verify configuration controls: ${error.message}`)
  const flag = data ? z.object({ enabled: z.boolean(), expires_at: z.string().nullable().optional() }).parse(data) : null
  if (flag?.enabled) {
    if (flag.expires_at != null) throw new Error("Configuration enforcement cannot use an expiring flag; remove its expiry before continuing")
    return true
  }
  const history = await supabase.from("selection_configuration_rules").select("id").eq("org_id", orgId).limit(1).maybeSingle()
  if (history.error && !["42P01", "PGRST205"].includes(history.error.code)) throw new Error(`Unable to verify existing configuration controls: ${history.error.message}`)
  if (history.data) throw new Error("Restore configuration enforcement before changing an organization with existing rules")
  return false
}

async function assertCommunityAccess(context: OrgServiceContext, communityId: string, message: string) {
  const access = await getDivisionAccessForUser(context)
  const { data: community, error } = await context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", communityId).maybeSingle()
  if (error || !community || (access.assignedOnly && !access.divisionIds.includes(community.division_id))) throw new Error(message)
}

async function optionAccess(optionId: string) {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const { data, error } = await context.supabase.from("selection_options").select("id,name,community_id,parent_option_id,is_archived,is_available")
    .eq("org_id", context.orgId).eq("id", optionId).maybeSingle()
  if (error || !data) throw new Error("Catalog option not found")
  if (data.community_id) await assertCommunityAccess(context, data.community_id, "Option is outside your division access")
  return { context, option: data }
}

export async function listOptionConfigurationRules(optionId: string) {
  z.string().uuid().parse(optionId)
  const { context } = await optionAccess(optionId)
  if (!await enabled(context.orgId)) return { enabled: false, rules: [] }
  const supabase = createServiceSupabaseClient()
  const data = await readAllRowsById<{ id: string; kind: string; target_option_id: string; target: { name: string } | Array<{ name: string }> }>((cursor, take) => {
    let query = supabase.from("selection_configuration_rules").select("id,kind,target_option_id,target:selection_options!configuration_rule_target_fk(name)")
      .eq("org_id", context.orgId).eq("source_option_id", optionId).order("id").limit(take)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, { cap: 200, label: "Unable to load configuration rules" })
  return { enabled: true, rules: (data ?? []).map((row) => ({ id: row.id, kind: row.kind as "requires" | "excludes", targetId: row.target_option_id, targetName: (Array.isArray(row.target) ? row.target[0] : row.target)?.name ?? "Option" })) }
}

export async function searchConfigurationTargets(raw: unknown) {
  const input = z.object({ sourceId: z.string().uuid(), search: z.string().trim().max(200).default(""), page: z.number().int().min(1).max(10000).default(1) }).parse(raw)
  const { context, option } = await optionAccess(input.sourceId)
  let query = context.supabase.from("selection_options").select("id,name").eq("org_id", context.orgId).eq("is_archived", false).eq("is_available", true).neq("id", input.sourceId)
    .order("name").order("id").range((input.page - 1) * 25, input.page * 25)
  query = option.community_id ? query.or(`community_id.is.null,community_id.eq.${option.community_id}`) : query.is("community_id", null)
  if (input.search) query = query.ilike("name", `%${input.search.replace(/[\\%_]/g, "\\$&")}%`)
  const { data, error } = await query
  if (error) throw new Error(`Unable to search rule options: ${error.message}`)
  return { items: (data ?? []).slice(0, 25), more: (data ?? []).length > 25 }
}

export async function addOptionConfigurationRule(raw: unknown) {
  const input = z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid(), kind: z.enum(["requires", "excludes"]) }).parse(raw)
  const { context, option: source } = await optionAccess(input.sourceId)
  if (!await enabled(context.orgId)) throw new Error("Configuration rules are not enabled for this organization")
  const { context: targetContext, option: target } = await optionAccess(input.targetId)
  if (targetContext.orgId !== context.orgId) throw new Error("Options must belong to the same organization")
  if (source.is_archived || target.is_archived) throw new Error("Restore archived options before configuring rules")
  if (!source.is_available || !target.is_available) throw new Error("Restore unavailable options before configuring rules")
  if ((source.parent_option_id ?? source.id) === (target.parent_option_id ?? target.id)) throw new Error("An option cannot require or exclude itself")
  if (target.community_id && target.community_id !== source.community_id) throw new Error("The target option is not available in the source option's community scope")
  const payload = { org_id: context.orgId, source_option_id: source.id, target_option_id: target.id, kind: input.kind, created_by: context.userId }
  const { data, error } = await createServiceSupabaseClient().from("selection_configuration_rules").insert(payload).select("id").single()
  if (error || !data) throw new Error(`Unable to save configuration rule: ${error?.message ?? "No rule returned"}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "selection_configuration_rule", entityId: data.id, after: payload })
  return data
}

export async function removeOptionConfigurationRule(raw: unknown) {
  const input = z.object({ sourceId: z.string().uuid(), ruleId: z.string().uuid() }).parse(raw)
  const { context } = await optionAccess(input.sourceId)
  if (!await enabled(context.orgId)) throw new Error("Configuration rules are not enabled for this organization")
  const { data, error } = await createServiceSupabaseClient().from("selection_configuration_rules").delete()
    .eq("org_id", context.orgId).eq("id", input.ruleId).eq("source_option_id", input.sourceId).select("*").maybeSingle()
  if (error || !data) throw new Error("Rule changed or could not be removed. Refresh and try again.")
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "selection_configuration_rule", entityId: input.ruleId, before: data })
}

type RuleRow = { id: string; source_option_id: string; target_option_id: string; kind: "requires" | "excludes"; source: { name: string } | Array<{ name: string }>; target: { name: string } | Array<{ name: string }> }

/** The options and their canonical parents, with every rule any of them is the source of. */
async function loadConfigurationRules(orgId: string, optionIds: string[]) {
  const supabase = createServiceSupabaseClient()
  const selected = new Set(optionIds)
  for (let offset = 0; offset < optionIds.length; offset += 100) {
    const ids = optionIds.slice(offset, offset + 100)
    const { data, error } = await supabase.from("selection_options").select("id,parent_option_id").eq("org_id", orgId).in("id", ids)
    if (error || data?.length !== ids.length) throw new Error("Unable to resolve the home's configured options")
    for (const row of data) if (row.parent_option_id) selected.add(row.parent_option_id)
  }
  const ids = [...selected]
  const rules: ConfigurationRule[] = []
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = await readAllRowsById<RuleRow>((cursor, take) => {
      let query = supabase.from("selection_configuration_rules")
        .select("id,source_option_id,target_option_id,kind,source:selection_options!configuration_rule_source_fk(name),target:selection_options!configuration_rule_target_fk(name)")
        .eq("org_id", orgId).in("source_option_id", ids.slice(offset, offset + 100)).order("id").limit(take)
      if (cursor) query = query.gt("id", cursor)
      return query
    }, { cap: 20000, pageSize: 500, label: "Unable to verify configuration rules" })
    rules.push(...rows.map((row) => ({ id: row.id, sourceOptionId: row.source_option_id, targetOptionId: row.target_option_id, kind: row.kind, sourceName: (Array.isArray(row.source) ? row.source[0] : row.source)?.name ?? "Option", targetName: (Array.isArray(row.target) ? row.target[0] : row.target)?.name ?? "Required option" })))
  }
  return { selected, rules }
}

async function validateOptionSet(orgId: string, optionIds: string[]) {
  const { selected, rules } = await loadConfigurationRules(orgId, optionIds)
  const violations = evaluateConfigurationRules(selected, rules)
  if (violations.length) throw new ConfigurationViolationError(violations)
}

/** Internal mutation preflight; callers own project/portal authorization. */
export async function assertProjectConfiguration(orgId: string, projectId: string, changes: Array<{ selectionId: string; optionId: string }> = []) {
  if (!await enabled(orgId)) return
  const supabase = createServiceSupabaseClient()
  const rows = await readAllRowsById<{ id: string; category_id: string | null; selected_option_id: string | null }>((cursor, take) => {
    let query = supabase.from("project_selections").select("id,category_id,selected_option_id").eq("org_id", orgId).eq("project_id", projectId).order("id").limit(take)
    if (cursor) query = query.gt("id", cursor)
    return query
  }, { cap: 10000, pageSize: 500, label: "Unable to load home configuration" })
  const choices = new Map(rows.map((row) => [row.id, row.selected_option_id]))
  for (const change of changes) {
    if (!choices.has(change.selectionId)) throw new Error("Configuration change does not belong to this home")
    choices.set(change.selectionId, change.optionId)
  }
  const optionIds = [...new Set([...choices.values()].filter((id): id is string => Boolean(id)))]
  if (!optionIds.length) return
  const { data: lot, error: lotError } = await supabase.from("lots").select("community_id,house_plan_version_id")
    .eq("org_id", orgId).eq("project_id", projectId).maybeSingle()
  if (lotError) throw new Error(`Unable to verify home configuration scope: ${lotError.message}`)
  const resolved = await resolveOptionPricing({ orgId, items: optionIds.map((optionId) => ({ optionId })),
    communityId: lot?.community_id ?? undefined, requirePlanVersion: Boolean(lot?.community_id), housePlanVersionId: lot?.house_plan_version_id ?? undefined })
  if (resolved.length !== optionIds.length) throw new Error("Unable to resolve the complete home configuration")
  const byRequestedId = new Map(optionIds.map((id, index) => [id, resolved[index]]))
  const changed = new Set(changes.map((change) => change.selectionId))
  const effectiveIds = new Set<string>()
  for (const selection of rows) {
    const optionId = choices.get(selection.id)
    if (!optionId) continue
    const pricing = byRequestedId.get(optionId)
    if (!pricing?.available || !pricing.optionId) throw new Error("A selected option is no longer available for this home's plan or community. Review the home selections before proceeding.")
    if (!selection.category_id || !pricing.categoryIds.includes(selection.category_id)) throw new Error("A selected option no longer belongs to its selection category. Review the home selections before proceeding.")
    // A newly authored community override must not silently replace an existing
    // signed selection. Explicit proposed changes resolve to the effective ID.
    if (!changed.has(selection.id) && pricing.optionId !== optionId) throw new Error("A community override has changed a selected option. Review and explicitly update the home selection before proceeding.")
    effectiveIds.add(pricing.optionId)
  }
  await validateOptionSet(orgId, [...effectiveIds])
}

export async function assertSalesConfiguration(orgId: string, items: Array<{ optionId?: string; packageId?: string }>, scope: { communityId?: string; housePlanVersionId?: string } = {}) {
  if (!await enabled(orgId)) return
  const supabase = createServiceSupabaseClient()
  const optionIds = items.flatMap((item) => item.optionId ? [item.optionId] : [])
  const packageIds = [...new Set(items.flatMap((item) => item.packageId ? [item.packageId] : []))]
  for (let offset = 0; offset < packageIds.length; offset += 100) {
    const rows = await readAllRowsById<{ id: string; option_id: string; package_id: string }>((cursor, take) => {
      let query = supabase.from("selection_package_items").select("id,option_id,package_id").eq("org_id", orgId)
        .in("package_id", packageIds.slice(offset, offset + 100)).order("id").limit(take)
      if (cursor) query = query.gt("id", cursor)
      return query
    }, { cap: 10000, pageSize: 500, label: "Unable to validate package configuration" })
    const loadedPackages = new Set(rows.map((row) => row.package_id))
    if (packageIds.slice(offset, offset + 100).some((id) => !loadedPackages.has(id))) throw new Error("A configured package contains no options")
    optionIds.push(...rows.map((row) => row.option_id))
  }
  const uniqueIds = [...new Set(optionIds)]
  const resolved = await resolveOptionPricing({ orgId, items: uniqueIds.map((optionId) => ({ optionId })), ...scope, requirePlanVersion: Boolean(scope.communityId) })
  if (resolved.length !== uniqueIds.length || resolved.some((item) => !item.optionId)) throw new Error("Unable to resolve the complete sales configuration")
  if (resolved.some((item) => !item.available)) throw new Error("A configured package contains unavailable options")
  await validateOptionSet(orgId, [...new Set(resolved.map((item) => item.optionId!))])
}

/* ================================================================
 * Fix-it suggestions
 *
 * The same facts the preflights above judge with, plus the locks
 * `assertSelectionMutable` enforces, handed to the pure suggester. Read-only:
 * applying a fix is the caller's existing mutation, which re-checks both.
 * ============================================================== */

export type ConfigurationIssues = { violations: ConfigurationViolation[]; fixes: ConfigurationFix[] }

const NO_ISSUES: ConfigurationIssues = { violations: [], fixes: [] }

type CatalogScope = { communityId?: string; housePlanVersionId?: string }
type OptionRow = { id: string; name: string; parent_option_id: string | null; option_scope: string | null; category_id: string | null; community_id: string | null; is_archived: boolean; is_available: boolean }
type OptionFact = { optionId: string; name: string; parentOptionId: string | null; categoryIds: string[]; priceCents: number; available: boolean; structural: boolean }

async function readOptions(orgId: string, column: "id" | "parent_option_id" | "category_id", values: string[]) {
  const supabase = createServiceSupabaseClient()
  const unique = [...new Set(values)]
  const rows: OptionRow[] = []
  for (let offset = 0; offset < unique.length; offset += 100) {
    const { data, error } = await supabase.from("selection_options").select("id,name,parent_option_id,option_scope,category_id,community_id,is_archived,is_available")
      .eq("org_id", orgId).in(column, unique.slice(offset, offset + 100)).order("id").limit(500)
    if (error) throw new Error(`Unable to load configuration options: ${error.message}`)
    rows.push(...(data ?? []))
  }
  return rows
}

/** What each requested option resolves to on this home or sale — the community override, its price, its categories. */
async function describeOptions(orgId: string, requestedIds: string[], scope: CatalogScope) {
  const requested = [...new Set(requestedIds)]
  if (!requested.length) return new Map<string, OptionFact>()
  const pricing = await resolveOptionPricing({ orgId, items: requested.map((optionId) => ({ optionId })), ...scope, requirePlanVersion: Boolean(scope.communityId) })
  const rows = new Map((await readOptions(orgId, "id", requested.map((id, index) => pricing[index]?.optionId ?? id))).map((row) => [row.id, row]))
  return new Map(requested.map((id, index): [string, OptionFact] => {
    const price = pricing[index]
    const optionId = price?.optionId ?? id
    const row = rows.get(optionId)
    return [id, {
      optionId,
      name: row?.name ?? "Option",
      parentOptionId: row?.parent_option_id ?? null,
      categoryIds: price?.categoryIds ?? [],
      priceCents: price?.priceCents ?? 0,
      available: Boolean(price?.available && row && !row.is_archived),
      structural: row?.option_scope === "structural",
    }]
  }))
}

/** Options that could clear the violations: the required targets, and siblings of every option in conflict. */
async function fixFacts(orgId: string, scope: CatalogScope, current: OptionFact[], violations: ConfigurationViolation[], exclusiveStructural: boolean) {
  const inConflict = current.filter((fact) => violations.some((violation) =>
    [violation.sourceOptionId, violation.targetOptionId].some((id) => id === fact.optionId || id === fact.parentOptionId)))
  const categoryIds = [...new Set(inConflict.flatMap((fact) => fact.categoryIds))]
  const targetIds = violations.filter((violation) => violation.kind === "requires").map((violation) => violation.targetOptionId)
  const { data: categories, error } = categoryIds.length
    ? await createServiceSupabaseClient().from("selection_categories").select("id,parent_category_id").eq("org_id", orgId).in("id", categoryIds.slice(0, 100))
    : { data: [], error: null }
  if (error) throw new Error(`Unable to load configuration categories: ${error.message}`)
  const searchCategoryIds = [...categoryIds, ...(categories ?? []).flatMap((row) => (row.parent_category_id ? [row.parent_category_id] : []))]
  const [byCategory, byId, byParent] = await Promise.all([
    readOptions(orgId, "category_id", searchCategoryIds),
    readOptions(orgId, "id", targetIds),
    readOptions(orgId, "parent_option_id", targetIds),
  ])
  const candidateIds = [...byCategory, ...byId, ...byParent]
    .filter((row) => !row.is_archived && row.is_available && (!row.community_id || row.community_id === scope.communityId))
    .map((row) => row.parent_option_id ?? row.id)
  const candidates = [...(await describeOptions(orgId, candidateIds, scope)).values()].filter((fact) => fact.available)
  const facts = new Map([...current, ...candidates].map((fact) => [fact.optionId, fact]))
  const { rules } = await loadConfigurationRules(orgId, [...facts.keys()])
  return {
    facts,
    rules,
    availableOptionIds: [...new Set(candidates.map((fact) => fact.optionId))],
    optionMeta: Object.fromEntries([...facts.values()].map((fact) => [fact.optionId, {
      name: fact.name,
      categoryIds: fact.categoryIds,
      parentOptionId: fact.parentOptionId,
      exclusive: exclusiveStructural && fact.structural,
    }])),
    prices: Object.fromEntries([...facts.values()].map((fact) => [fact.optionId, fact.priceCents])),
  }
}

const homeChangesSchema = z.array(z.object({ selectionId: z.string().uuid(), optionId: z.string().uuid() })).max(1)

/**
 * What is wrong with a home's configuration — now, or after `changes` — and
 * how it could be corrected. A fix that would touch a selection past its
 * deadline, locked, confirmed, or frozen by a binding agreement is returned
 * blocked: it explains the correction but it belongs to a change order.
 * Portal callers have already authorized the token.
 */
export async function getHomeConfigurationFixes(orgId: string, projectId: string, options: { portalAccess?: boolean; changes?: Array<{ selectionId: string; optionId: string }> } = {}): Promise<ConfigurationIssues> {
  if (!options.portalAccess) {
    const context = await requireOrgContext(orgId)
    await requirePermission("selections.read", context)
  }
  const changes = homeChangesSchema.parse(options.changes ?? [])
  if (!await enabled(orgId)) return NO_ISSUES
  const supabase = createServiceSupabaseClient()
  const [rows, lot, groups, agreements, project, org] = await Promise.all([
    readAllRowsById<{ id: string; category_id: string | null; selected_option_id: string | null; status: string | null; group_id: string | null; locked_at: string | null }>((cursor, take) => {
      let query = supabase.from("project_selections").select("id,category_id,selected_option_id,status,group_id,locked_at").eq("org_id", orgId).eq("project_id", projectId).order("id").limit(take)
      if (cursor) query = query.gt("id", cursor)
      return query
    }, { cap: 10000, pageSize: 500, label: "Unable to load home configuration" }),
    supabase.from("lots").select("community_id,house_plan_version_id").eq("org_id", orgId).eq("project_id", projectId).maybeSingle(),
    supabase.from("project_selection_groups").select("group_id,status,cutoff_date").eq("org_id", orgId).eq("project_id", projectId).limit(500),
    supabase.from("contracts").select("id,status,signed_at").eq("org_id", orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").limit(20),
    supabase.from("projects").select("property_type").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    supabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
  ])
  for (const failure of [lot.error, groups.error, agreements.error, project.error, org.error]) {
    if (failure) throw new Error(`Unable to load home configuration: ${failure.message}`)
  }
  const choices = new Map(rows.map((row) => [row.id, row.selected_option_id]))
  for (const change of changes) {
    if (!choices.has(change.selectionId)) throw new Error("Configuration change does not belong to this home")
    choices.set(change.selectionId, change.optionId)
  }
  const scope = { communityId: lot.data?.community_id ?? undefined, housePlanVersionId: lot.data?.house_plan_version_id ?? undefined }
  const described = await describeOptions(orgId, [...choices.values()].filter((id): id is string => Boolean(id)), scope)
  const slots = rows.map((row) => {
    const chosen = choices.get(row.id)
    return { selectionId: row.id, categoryId: row.category_id ?? "", optionId: chosen ? described.get(chosen)?.optionId ?? chosen : null }
  })
  const current = [...described.values()]
  if (!current.length) return NO_ISSUES
  const { selected, rules: currentRules } = await loadConfigurationRules(orgId, [...new Set(current.map((fact) => fact.optionId))])
  const violations = evaluateConfigurationRules(selected, currentRules)
  if (!violations.length) return NO_ISSUES

  const today = new Date().toISOString().slice(0, 10)
  const closedGroups = new Set((groups.data ?? []).filter((group) => group.status === "locked" || Boolean(group.cutoff_date && group.cutoff_date < today)).map((group) => group.group_id))
  const bySelectionId: Record<string, ConfigurationLockReason> = {}
  for (const row of rows) {
    const lock: ConfigurationLockReason | null = row.group_id && closedGroups.has(row.group_id) ? "cutoff"
      : row.locked_at ? "locked"
      : COMMITTED_SELECTION_STATUSES.includes(row.status ?? "") ? "confirmed"
      : null
    if (lock) bySelectionId[row.id] = lock
  }
  const production = isProductionProjectPosture(getProjectPosture(project.data?.property_type, normalizeProductTier(org.data?.product_tier)))
  const agreementBinding = production && (agreements.data ?? []).some((agreement) => agreementLocksStructuralOptions(agreement))
  const facts = await fixFacts(orgId, scope, current, violations, false)
  return {
    violations,
    fixes: suggestConfigurationFixes({
      violations,
      rules: facts.rules,
      optionMeta: facts.optionMeta,
      availableOptionIds: facts.availableOptionIds,
      prices: facts.prices,
      slots,
      locks: {
        bySelectionId,
        structuralOptionIds: agreementBinding ? [...facts.facts.values()].filter((fact) => fact.structural).map((fact) => fact.optionId) : [],
      },
    }),
  }
}

const COMMITTED_SELECTION_STATUSES = ["confirmed", "ordered", "received"]

const applyFixSchema = z.object({
  fixId: z.string().min(1).max(400),
  changes: homeChangesSchema.default([]),
})

/**
 * The one door a home fix goes through: the fix must be one this service
 * suggests for the home right now, and it must not be blocked. A client cannot
 * name a fix into a locked selection — it is either not suggested or blocked,
 * and the selection mutation it leads to checks the locks again regardless.
 */
export async function resolveHomeConfigurationFix(orgId: string, projectId: string, raw: unknown, options: { portalAccess?: boolean } = {}) {
  const input = applyFixSchema.parse(raw)
  const { fixes } = await getHomeConfigurationFixes(orgId, projectId, { portalAccess: options.portalAccess, changes: input.changes })
  const fix = fixes.find((candidate) => candidate.id === input.fixId)
  if (!fix?.selectionId || !fix.add) throw new Error("This correction no longer applies. Review the selections and try again.")
  if (fix.blockedBy) {
    const error: Error & { code?: string } = new Error(`This correction needs a change order because ${CONFIGURATION_LOCK_REASONS[fix.blockedBy]}.${options.portalAccess ? " Contact your builder to request it." : ""}`)
    error.code = "CONFIGURATION_FIX_BLOCKED"
    throw error
  }
  return { selectionId: fix.selectionId, optionId: fix.add.optionId }
}

/**
 * What is wrong with a draft agreement configuration and how to correct it.
 * Drafts have no locks: every fix adds, removes, or swaps a line of the draft.
 */
export async function getSalesConfigurationFixes(raw: unknown): Promise<ConfigurationIssues> {
  const input = agreementConfigurationSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("sales.read", context)
  const { data: lot, error } = await context.supabase.from("lots").select("community_id,house_plan_version_id").eq("org_id", context.orgId).eq("id", input.lotId).maybeSingle()
  if (error || !lot) throw new Error("Lot not found")
  await assertCommunityAccess(context, lot.community_id, "Lot not found")
  const housePlanVersionId = input.housePlanVersionId ?? lot.house_plan_version_id
  if (!housePlanVersionId || !await enabled(context.orgId)) return NO_ISSUES
  const scope = { communityId: lot.community_id, housePlanVersionId }
  const supabase = createServiceSupabaseClient()
  const packageIds = [...new Set(input.optionItems.flatMap((item) => (item.packageId ? [item.packageId] : [])))]
  const [members, packages, packagePrices] = packageIds.length
    ? await Promise.all([
        readAllRowsById<{ id: string; option_id: string; package_id: string }>((cursor, take) => {
          let query = supabase.from("selection_package_items").select("id,option_id,package_id").eq("org_id", context.orgId).in("package_id", packageIds).order("id").limit(take)
          if (cursor) query = query.gt("id", cursor)
          return query
        }, { cap: 10000, pageSize: 500, label: "Unable to load package configuration" }),
        supabase.from("selection_packages").select("id,name").eq("org_id", context.orgId).in("id", packageIds),
        resolveOptionPricing({ orgId: context.orgId, items: packageIds.map((packageId) => ({ packageId })), ...scope, requirePlanVersion: true }),
      ])
    : [[], { data: [], error: null }, []]
  if (packages.error) throw new Error(`Unable to load package configuration: ${packages.error.message}`)
  const described = await describeOptions(context.orgId, [
    ...input.optionItems.flatMap((item) => (item.optionId ? [item.optionId] : [])),
    ...members.map((member) => member.option_id),
  ], scope)
  const effective = (id: string) => described.get(id)?.optionId ?? id
  const picks = input.optionItems.map((item) => item.optionId
    ? { optionId: item.optionId, name: described.get(item.optionId)?.name ?? "Option", optionIds: [effective(item.optionId)] }
    : { packageId: item.packageId, name: (packages.data ?? []).find((row) => row.id === item.packageId)?.name ?? "Package", optionIds: members.filter((member) => member.package_id === item.packageId).map((member) => effective(member.option_id)) })
  const current = [...new Map([...described.values()].map((fact) => [fact.optionId, fact])).values()]
  if (!current.length) return NO_ISSUES
  const { selected, rules: currentRules } = await loadConfigurationRules(context.orgId, current.map((fact) => fact.optionId))
  const violations = evaluateConfigurationRules(selected, currentRules)
  if (!violations.length) return NO_ISSUES
  const facts = await fixFacts(context.orgId, scope, current, violations, true)
  return {
    violations,
    fixes: suggestConfigurationFixes({
      violations,
      rules: facts.rules,
      optionMeta: facts.optionMeta,
      availableOptionIds: facts.availableOptionIds,
      prices: { ...facts.prices, ...Object.fromEntries(packageIds.map((id, index) => [id, packagePrices[index]?.priceCents ?? 0])) },
      picks,
    }),
  }
}
