import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { readAllRowsById } from "@/lib/land/paging"
import { recordAudit } from "@/lib/services/audit"
import { evaluateConfigurationRules, type ConfigurationRule } from "@/lib/selections/configuration-rules"

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

async function optionAccess(optionId: string) {
  const context = await requireOrgContext()
  await requirePermission("selections.catalog.manage", context)
  const { data, error } = await context.supabase.from("selection_options").select("id,name,community_id,parent_option_id,is_archived,is_available")
    .eq("org_id", context.orgId).eq("id", optionId).maybeSingle()
  if (error || !data) throw new Error("Catalog option not found")
  if (data.community_id) {
    const access = await getDivisionAccessForUser(context)
    const { data: community, error: scopeError } = await context.supabase.from("communities").select("division_id").eq("org_id", context.orgId).eq("id", data.community_id).maybeSingle()
    if (scopeError || !community || (access.assignedOnly && !access.divisionIds.includes(community.division_id))) throw new Error("Option is outside your division access")
  }
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

async function validateOptionSet(orgId: string, optionIds: string[]) {
  const supabase = createServiceSupabaseClient()
  const selected = new Set(optionIds)
  for (let offset = 0; offset < optionIds.length; offset += 100) {
    const ids = optionIds.slice(offset, offset + 100)
    const { data, error } = await supabase.from("selection_options").select("id,parent_option_id").eq("org_id", orgId).in("id", ids)
    if (error || data?.length !== ids.length) throw new Error("Unable to resolve the home's configured options")
    for (const row of data) if (row.parent_option_id) selected.add(row.parent_option_id)
  }
  const ids = [...selected]
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = await readAllRowsById<{ id: string; source_option_id: string; target_option_id: string; kind: "requires" | "excludes"; source: { name: string } | Array<{ name: string }>; target: { name: string } | Array<{ name: string }> }>((cursor, take) => {
      let query = supabase.from("selection_configuration_rules")
        .select("id,source_option_id,target_option_id,kind,source:selection_options!configuration_rule_source_fk(name),target:selection_options!configuration_rule_target_fk(name)")
        .eq("org_id", orgId).in("source_option_id", ids.slice(offset, offset + 100)).order("id").limit(take)
      if (cursor) query = query.gt("id", cursor)
      return query
    }, { cap: 20000, pageSize: 500, label: "Unable to verify configuration rules" })
    const rules: ConfigurationRule[] = rows.map((row) => ({ id: row.id, sourceOptionId: row.source_option_id, targetOptionId: row.target_option_id, kind: row.kind, sourceName: (Array.isArray(row.source) ? row.source[0] : row.source)?.name ?? "Option", targetName: (Array.isArray(row.target) ? row.target[0] : row.target)?.name ?? "Required option" }))
    const violations = evaluateConfigurationRules(selected, rules)
    if (violations.length) throw new Error(violations.slice(0, 50).map((violation) => violation.message).join(" ") + (violations.length > 50 ? " Additional configuration conflicts require review." : ""))
  }
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
    communityId: lot?.community_id ?? undefined, housePlanVersionId: lot?.house_plan_version_id ?? undefined })
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
  const resolved = await resolveOptionPricing({ orgId, items: uniqueIds.map((optionId) => ({ optionId })), ...scope })
  if (resolved.length !== uniqueIds.length || resolved.some((item) => !item.optionId)) throw new Error("Unable to resolve the complete sales configuration")
  if (resolved.some((item) => !item.available)) throw new Error("A configured package contains unavailable options")
  await validateOptionSet(orgId, [...new Set(resolved.map((item) => item.optionId!))])
}
