import { z } from "zod"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { readHomePricingScope, type HomePricingScope } from "@/lib/services/home-pricing-scope"
import { allocatePackageTotal, resolveOptionPricing } from "@/lib/services/option-catalog"
import { requirePermission } from "@/lib/services/permissions"
import { getDivisionAccessForUser, requireAuthorization } from "@/lib/services/authorization"
import {
  listSelectionExceptions,
  loadSelectionException,
  openSelectionException,
  readSelectionChoiceFacts,
  recordAlternateChosen,
  type SelectionExceptionDto,
} from "@/lib/services/selection-exceptions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { agreementLocksStructuralOptions, planPackageSelection } from "@/lib/selections/selection-variance"
import {
  SelectionEligibilityError,
  eligibleAlternates,
  formatSupplyDate,
  supplyRefusal,
  type SelectionAlternate,
  type SelectionChoiceFacts,
} from "@/lib/selections/supply-eligibility"
import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import { selectionExceptionAlternateSchema, type SelectionExceptionAlternateInput, type SelectionInput } from "@/lib/validation/selections"

export type SelectionLockCode = "SELECTION_LOCKED_STRUCTURAL" | "SELECTION_LOCKED_CUTOFF"

export class SelectionLockError extends Error {
  constructor(
    message: string,
    public readonly code: SelectionLockCode,
  ) {
    super(message)
    this.name = "SelectionLockError"
  }
}

/**
 * The staff side of a selection write: `selections.write` on this home, which
 * carries the member's division scope. The portal path is authorized by its
 * token before it gets here.
 */
async function authorizeSelectionWrite(orgId: string, projectId: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "selections.write", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase,
    logDecision: true, resourceType: "project", resourceId: projectId,
  })
  return context.userId
}

export type ProjectSelectionDto = Selection & {
  group_id?: string | null
  package_id?: string | null
  price_cents_snapshot?: number | null
  cost_cents_snapshot?: number | null
  locked_at?: string | null
  source_change_order_id?: string | null
  effective_due_date?: string | null
  locked: boolean
  group?: {
    id: string
    name: string
    cutoff_date: string | null
    cutoff_source: "schedule" | "manual_override"
    override_reason: string | null
    status: "open" | "locked"
    locked_at: string | null
    /** Start of the task the group's cutoff is anchored to: what an option's lead time counts back from. */
    needed_by: string | null
  } | null
}

export async function listSelectionCategories(orgId: string): Promise<SelectionCategory[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_categories")
    .select("id, org_id, name, description, sort_order, community_id, parent_category_id, image_url, is_archived")
    .eq("org_id", orgId)
    .eq("is_archived", false)
    .order("sort_order", { ascending: true })
    .limit(500)
  if (error) throw new Error(`Failed to load selection categories: ${error.message}`)
  return data ?? []
}

export async function listSelectionOptions(orgId: string, categoryId: string): Promise<SelectionOption[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("selection_options")
    .select("id, org_id, category_id, name, description, price_cents, price_type, price_delta_cents, image_url, sku, vendor, lead_time_days, sort_order, is_default, is_available, option_scope, community_id, parent_option_id, cost_code_id, is_archived")
    .eq("org_id", orgId)
    .eq("category_id", categoryId)
    .eq("is_archived", false)
    .eq("is_available", true)
    .order("sort_order", { ascending: true })
    .limit(500)
  if (error) throw new Error(`Failed to load selection options: ${error.message}`)
  // A community version is off sale with the option it overrides.
  const parentIds = [...new Set((data ?? []).flatMap((row) => (row.parent_option_id ? [row.parent_option_id] : [])))]
  if (parentIds.length === 0) return data ?? []
  const { data: parents, error: parentError } = await supabase
    .from("selection_options")
    .select("id")
    .eq("org_id", orgId)
    .in("id", parentIds)
    .eq("is_archived", false)
    .eq("is_available", true)
  if (parentError) throw new Error(`Failed to load selection options: ${parentError.message}`)
  const parentsOnSale = new Set((parents ?? []).map((row) => row.id))
  return (data ?? []).filter((row) => !row.parent_option_id || parentsOnSale.has(row.parent_option_id))
}

export async function listProjectSelections(orgId?: string, projectId?: string, options: { portalAccess?: boolean; permissionChecked?: boolean } = {}): Promise<ProjectSelectionDto[]> {
  // `permissionChecked`: the caller already required selections.write, so the read
  // skips the project_selections RLS that hides a home from non-members (the
  // design coordinator is org-scoped, never a project member). Same pattern as
  // loadSelectionMutationContext.
  const context = options.portalAccess || options.permissionChecked
    ? { supabase: createServiceSupabaseClient(), orgId: orgId ?? "" }
    : await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId } = context
  if (!resolvedOrgId) throw new Error("Organization is required")
  let query = supabase
    .from("project_selections")
    .select("id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes, group_id, package_id, price_cents_snapshot, cost_cents_snapshot, locked_at, source_change_order_id, category:selection_categories(id,name,description), selected_option:selection_options(id,org_id,category_id,name,description,price_cents,price_type,price_delta_cents,image_url,sku,vendor,lead_time_days,sort_order,is_default,is_available,option_scope), group:selection_groups(id,name)")
    .eq("org_id", resolvedOrgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(1000)
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load project selections: ${error.message}`)
  const grouped = (data ?? []).filter((selection) => selection.group_id)
  const groupIds = Array.from(new Set(grouped.map((selection) => selection.group_id)))
  const { data: instances, error: instanceError } = projectId && groupIds.length
    ? await supabase
        .from("project_selection_groups")
        .select("group_id, cutoff_date, cutoff_source, override_reason, status, locked_at, matched_schedule_item:schedule_items(start_date)")
        .eq("org_id", resolvedOrgId)
        .eq("project_id", projectId)
        .in("group_id", groupIds)
    : { data: [], error: null }
  if (instanceError) throw new Error(`Failed to load selection deadlines: ${instanceError.message}`)
  return (data ?? []).map((selection) => {
    const group = Array.isArray(selection.group) ? selection.group[0] : selection.group
    const instance = (instances ?? []).find((candidate) => candidate.group_id === selection.group_id)
    const anchor = Array.isArray(instance?.matched_schedule_item) ? instance?.matched_schedule_item[0] : instance?.matched_schedule_item
    return {
      ...selection,
      category: Array.isArray(selection.category) ? selection.category[0] : selection.category,
      selected_option: Array.isArray(selection.selected_option) ? selection.selected_option[0] : selection.selected_option,
      effective_due_date: instance?.cutoff_date ?? selection.due_date ?? null,
      locked: Boolean(selection.locked_at || instance?.status === "locked"),
      group: group && instance ? {
        id: group.id,
        name: group.name,
        cutoff_date: instance.cutoff_date,
        cutoff_source: instance.cutoff_source,
        override_reason: instance.override_reason,
        status: instance.status,
        locked_at: instance.locked_at,
        needed_by: anchor?.start_date ?? null,
      } : null,
    }
  })
}

async function loadSelectionMutationContext(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: selection, error } = await supabase
    .from("project_selections")
    .select("id, org_id, project_id, category_id, selected_option_id, group_id, package_id, price_cents_snapshot, cost_cents_snapshot, locked_at, metadata")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.selectionId)
    .maybeSingle()
  if (error || !selection) throw new Error("Selection not found")
  const optionIds = [selection.selected_option_id, input.optionId].filter((value): value is string => Boolean(value))
  const [{ data: options, error: optionError }, home, { data: groupInstance, error: groupError }, facts] = await Promise.all([
    optionIds.length
      ? supabase.from("selection_options").select("id, name, option_scope").eq("org_id", input.orgId).in("id", optionIds)
      : Promise.resolve({ data: [], error: null }),
    readHomePricingScope(supabase, input.orgId, input.projectId),
    selection.group_id
      ? supabase
          .from("project_selection_groups")
          .select("status, cutoff_date, group:selection_groups(name)")
          .eq("org_id", input.orgId)
          .eq("project_id", input.projectId)
          .eq("group_id", selection.group_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    readSelectionChoiceFacts(input.orgId, input.projectId, input.selectionId, optionIds),
  ])
  if (optionError) throw new Error(`Failed to validate selection mutation: ${optionError.message}`)
  if (groupError) throw new Error(`Failed to validate selection deadline: ${groupError.message}`)
  return {
    supabase,
    selection,
    options: options ?? [],
    groupInstance,
    production: home.production,
    pricing: home.pricing,
    facts,
  }
}

export async function assertSelectionMutable(
  mutation: Awaited<ReturnType<typeof loadSelectionMutationContext>>,
  opts: { portal: boolean },
) {
  const structural = mutation.options.some((option) => option.option_scope === "structural")
  if (structural && mutation.production) {
    // The lock belongs to a *binding* agreement, not to the signature date. A
    // voided agreement leaves `signed_at` behind, so keying on it alone froze
    // the structural options of a released spec home for its next buyer.
    const { data: agreements, error } = await mutation.supabase
      .from("contracts")
      .select("id, status, signed_at")
      .eq("org_id", mutation.selection.org_id)
      .eq("project_id", mutation.selection.project_id)
      .eq("contract_type", "purchase_agreement")
      .limit(20)
    if (error) throw new Error(`Failed to validate purchase agreement lock: ${error.message}`)
    if ((agreements ?? []).some((agreement) => agreementLocksStructuralOptions(agreement))) {
      throw new SelectionLockError(
        opts.portal
          ? "Structural options are locked once the purchase agreement is signed. Changes require a change order — contact your builder."
          : "Structural options locked at agreement signing. Create a change order to modify.",
        "SELECTION_LOCKED_STRUCTURAL",
      )
    }
  }
  if (mutation.selection.group_id && mutation.groupInstance) {
    // The community's day, the one the database write checks.
    const today = mutation.facts.today
    const expired = mutation.groupInstance.status === "locked" || Boolean(mutation.groupInstance.cutoff_date && mutation.groupInstance.cutoff_date < today)
    if (expired) {
      const group = Array.isArray(mutation.groupInstance.group) ? mutation.groupInstance.group[0] : mutation.groupInstance.group
      const date = mutation.groupInstance.cutoff_date ?? "the configured date"
      throw new SelectionLockError(
        opts.portal
          ? `The selection deadline for ${group?.name ?? "this group"} was ${date}. Changes now require a change order — contact your builder.`
          : `The selection deadline for ${group?.name ?? "this group"} was ${date}. Changes now require a change order.`,
        "SELECTION_LOCKED_CUTOFF",
      )
    }
  }
  if (mutation.selection.locked_at) {
    throw new SelectionLockError(
      opts.portal ? "This selection is locked. Contact your builder to request a change." : "This selection is locked. Create a change order to modify it.",
      "SELECTION_LOCKED_CUTOFF",
    )
  }
}

type SingleSelectionInput = {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
  actorId: string | null
  portal: boolean
  configurationPrevalidated?: boolean
}

/**
 * The options this selection could take instead: offered for this home, in its
 * category, and orderable in time.
 */
async function selectionAlternates(input: {
  orgId: string
  projectId: string
  selectionId: string
  categoryId: string
  excludeOptionId: string | null
  pricing: HomePricingScope
}): Promise<SelectionAlternate[]> {
  const options = (await listSelectionOptions(input.orgId, input.categoryId)).slice(0, 100)
  if (!options.length) return []
  const priced = await resolveOptionPricing({ orgId: input.orgId, items: options.map((option) => ({ optionId: option.id })), ...input.pricing })
  const candidates = options.map((option, index) => {
    const price = priced[index]
    return {
      optionId: price?.optionId ?? option.id,
      name: option.name,
      priceCents: price?.priceCents ?? option.price_cents ?? 0,
      available: Boolean(price?.available && price.categoryIds.includes(input.categoryId)),
    }
  })
  const facts = await readSelectionChoiceFacts(input.orgId, input.projectId, input.selectionId, candidates.map((candidate) => candidate.optionId))
  return eligibleAlternates(facts, candidates, input.excludeOptionId)
}

function refusalWithAlternates(message: string, alternates: SelectionAlternate[], portal: boolean) {
  if (alternates.length) {
    const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    return `${message} Still in time: ${alternates.map((alternate) => `${alternate.name} (${money.format(alternate.priceCents / 100)})`).join(", ")}.`
  }
  return portal ? `${message} Your builder has been asked to find an alternate.` : `${message} Raise a change order or record an expedite on the exception.`
}

/**
 * The supply half of a choice: the option must still be offered, orderable by
 * the task it is needed for, and the selection must not already be bought.
 * The database write enforces the same rules; this names the reason, records
 * an exception, and offers what can be had instead.
 */
async function assertSupplyEligible(
  mutation: Awaited<ReturnType<typeof loadSelectionMutationContext>>,
  input: SingleSelectionInput & { option: { optionId: string; name: string; available: boolean } },
) {
  // Keeping the choice already made is not a new order; an option gone off sale is refused either way.
  if (input.option.optionId === mutation.selection.selected_option_id && input.option.available) return
  const facts: SelectionChoiceFacts = mutation.facts.options.some((entry) => entry.optionId === input.option.optionId)
    ? mutation.facts
    : await readSelectionChoiceFacts(input.orgId, input.projectId, input.selectionId, [input.option.optionId])
  const refusal = supplyRefusal(facts, input.option)
  if (!refusal) return
  const alternates = await selectionAlternates({
    orgId: input.orgId, projectId: input.projectId, selectionId: input.selectionId, categoryId: mutation.selection.category_id,
    excludeOptionId: input.option.optionId, pricing: mutation.pricing,
  })
  const exception = await openSelectionException({
    orgId: input.orgId, projectId: input.projectId, selectionId: input.selectionId, optionId: input.option.optionId,
    reason: refusal.reason, actorId: input.actorId,
    detail: {
      requested_option_id: input.option.optionId,
      order_by: refusal.orderBy,
      purchase_order_id: facts.releasedPurchaseOrderId,
      alternates: alternates.map((alternate) => alternate.optionId),
    },
  })
  throw new SelectionEligibilityError(refusalWithAlternates(refusal.message, alternates, input.portal), refusal.code, { reason: refusal.message, alternates, exceptionId: exception.id })
}

/** Validates one selection change and returns the row it would write, without writing it. */
async function prepareSingleSelection(input: SingleSelectionInput) {
  const mutation = await loadSelectionMutationContext(input)
  await assertSelectionMutable(mutation, { portal: input.portal })
  const [pricing] = await resolveOptionPricing({ orgId: input.orgId, items: [{ optionId: input.optionId }], ...mutation.pricing })
  if (!pricing.categoryIds.includes(mutation.selection.category_id) && pricing.available) throw new Error("This option belongs to a different selection category")
  const optionId = pricing.optionId ?? input.optionId
  const name = mutation.options.find((option) => option.id === input.optionId)?.name ?? "This option"
  await assertSupplyEligible(mutation, { ...input, option: { optionId, name, available: pricing.available } })
  if (!input.configurationPrevalidated) await assertProjectConfiguration(input.orgId, input.projectId, [{ selectionId: input.selectionId, optionId }])
  const payload = {
    selected_option_id: optionId,
    package_id: null,
    status: "selected",
    selected_at: new Date().toISOString(),
    confirmed_at: null,
    selected_by_contact_id: input.selectedByContactId ?? null,
    price_cents_snapshot: pricing.priceCents,
    cost_cents_snapshot: pricing.costCents,
  }
  return { mutation, payload }
}

async function recordSelectionWrite(input: SingleSelectionInput, payload: Record<string, unknown>) {
  await Promise.all([
    recordEvent({ orgId: input.orgId, actorId: input.actorId ?? undefined, eventType: "selection_updated", entityType: "selection", entityId: input.selectionId, payload: { project_id: input.projectId, option_id: input.optionId } }),
    recordAudit({ orgId: input.orgId, actorId: input.actorId ?? undefined, action: "update", entityType: "selection", entityId: input.selectionId, after: payload }),
  ])
}

/** A selection write was validated against a catalog or a home that has since moved. */
export class SelectionConfigurationChangedError extends Error {
  readonly code = "SELECTION_CONFIGURATION_CHANGED"
}

const FENCE_REFUSALS: Record<string, string> = {
  SELECTION_CATALOG_CHANGED: "The catalog changed while you were choosing; review and try again.",
  SELECTION_HOME_CHANGED: "This home's selections changed while you were choosing; review and try again.",
}

const selectionFenceSchema = z.object({
  catalogRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  homeState: z.string().regex(/^[0-9a-f]{32}$/),
})
type SelectionFence = z.infer<typeof selectionFenceSchema>

/**
 * The catalog revision and the home's selection state, read BEFORE anything is
 * validated. The write commits only if neither has moved since, so a price,
 * rule or availability published mid-choice — or another session changing the
 * same home — refuses the write instead of landing an unvalidated set.
 */
async function readSelectionFence(orgId: string, projectId: string): Promise<SelectionFence> {
  const { data, error } = await createServiceSupabaseClient().rpc("read_project_selection_fence", { p_org_id: orgId, p_project_id: projectId })
  if (error) throw new Error(`Failed to read the home's selections: ${error.message}`)
  const parsed = selectionFenceSchema.safeParse(data)
  if (!parsed.success) throw new Error("The home's selection state could not be verified")
  return parsed.data
}

/**
 * Writes several selection rows on one home in ONE transaction
 * (`apply_project_selection_writes`): a package, a group confirmation or a
 * change order lands whole or not at all, and only against the fence it was
 * validated on.
 */
async function applySelectionWrites(orgId: string, projectId: string, fence: SelectionFence, writes: Array<{ id: string } & Record<string, unknown>>) {
  const { error } = await createServiceSupabaseClient().rpc("apply_project_selection_writes", {
    p_org_id: orgId,
    p_project_id: projectId,
    p_writes: writes,
    p_expected_catalog_revision: fence.catalogRevision,
    p_expected_home_state: fence.homeState,
  })
  const refusal = error?.details ? FENCE_REFUSALS[error.details] : undefined
  if (refusal) throw new SelectionConfigurationChangedError(refusal)
  // The database's own deadline and supply checks: something moved between the
  // explanation and the write (a sweep, a schedule pull-in, a released PO).
  if (error?.details === "SELECTION_LOCKED_CUTOFF") throw new SelectionLockError(`${error.message}.`, "SELECTION_LOCKED_CUTOFF")
  if (error?.details === "SELECTION_LEAD_TIME") {
    throw new SelectionEligibilityError(error.hint ? `This option had to be ordered by ${formatSupplyDate(error.hint)} to arrive in time.` : `${error.message}.`, "SELECTION_LEAD_TIME")
  }
  if (error?.details === "SELECTION_PROCUREMENT_RELEASED") throw new SelectionEligibilityError(`${error.message}.`, "SELECTION_PROCUREMENT_RELEASED")
  if (error) throw new Error(`Failed to apply selections: ${error.message}`)
}

export async function selectProjectOption(input: {
  orgId: string
  projectId: string
  selectionId: string
  optionId: string
  selectedByContactId?: string | null
  portalAccess?: boolean
}) {
  const [written] = await selectProjectOptions({ ...input, changes: [{ selectionId: input.selectionId, optionId: input.optionId }] })
  return written
}

/**
 * Several choices on one home as ONE fenced write: each is gated, priced and
 * checked against the configuration rules together with the others, then they
 * land whole or not at all. A correction and the choice it clears (the buyer
 * portal's fix) go through here, so neither can stick without the other.
 */
export async function selectProjectOptions(input: {
  orgId: string
  projectId: string
  changes: Array<{ selectionId: string; optionId: string }>
  selectedByContactId?: string | null
  portalAccess?: boolean
}) {
  const actorId = input.portalAccess ? null : await authorizeSelectionWrite(input.orgId, input.projectId)
  if (!input.changes.length) throw new Error("Choose at least one option")
  if (new Set(input.changes.map((change) => change.selectionId)).size !== input.changes.length) throw new Error("Choose one option per selection")
  const fence = await readSelectionFence(input.orgId, input.projectId)
  const prepared = await Promise.all(input.changes.map(async (change) => {
    const single: SingleSelectionInput = {
      orgId: input.orgId,
      projectId: input.projectId,
      selectionId: change.selectionId,
      optionId: change.optionId,
      selectedByContactId: input.selectedByContactId,
      actorId,
      portal: Boolean(input.portalAccess),
      configurationPrevalidated: true,
    }
    return { single, ...(await prepareSingleSelection(single)) }
  }))
  await assertProjectConfiguration(input.orgId, input.projectId, prepared.map(({ single, payload }) => ({ selectionId: single.selectionId, optionId: payload.selected_option_id })))
  await applySelectionWrites(input.orgId, input.projectId, fence, prepared.map(({ single, payload }) => ({ id: single.selectionId, ...payload })))
  await Promise.all(prepared.map(({ single, payload }) => recordSelectionWrite(single, payload)))
  return prepared.map(({ single, payload }) => ({ id: single.selectionId, selected_option_id: payload.selected_option_id, status: payload.status, price_cents_snapshot: payload.price_cents_snapshot }))
}

export async function selectProjectPackage(input: {
  orgId: string
  projectId: string
  packageId: string
  selectedByContactId?: string | null
  portalAccess?: boolean
}) {
  const actorId = input.portalAccess ? null : await authorizeSelectionWrite(input.orgId, input.projectId)
  const fence = await readSelectionFence(input.orgId, input.projectId)
  const supabase = createServiceSupabaseClient()
  const { data: members, error } = await supabase
    .from("selection_package_items")
    .select("option_id, option:selection_options(category_id)")
    .eq("org_id", input.orgId)
    .eq("package_id", input.packageId)
  if (error || !members?.length) throw new Error("Package has no available options")
  const packageMembers = members.map((member) => {
    const option = Array.isArray(member.option) ? member.option[0] : member.option
    return { option_id: member.option_id as string, category_id: (option?.category_id as string | null) ?? null }
  })
  const { data: selections, error: selectionError } = await supabase
    .from("project_selections")
    .select("id, category_id, group_id")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .in("category_id", packageMembers.map((member) => member.category_id).filter((value): value is string => Boolean(value)))
  if (selectionError) throw new Error(`Failed to load package selections: ${selectionError.message}`)
  // Matching on category alone spans the whole project, so a package sold into
  // one group could silently rewrite another group's identical category.
  const plan = planPackageSelection({
    members: packageMembers,
    selections: (selections ?? []).map((selection) => ({
      id: selection.id as string,
      category_id: selection.category_id as string,
      group_id: (selection.group_id as string | null) ?? null,
    })),
  })
  const home = await readHomePricingScope(supabase, input.orgId, input.projectId)
  const [pricing] = await resolveOptionPricing({ orgId: input.orgId, items: [{ packageId: input.packageId }], ...home.pricing })
  if (!pricing.available) throw new Error("This package is not available for the lot's plan")

  const memberPrices = await resolveOptionPricing({ orgId: input.orgId, items: plan.members.map((member) => ({ optionId: member.optionId })), ...home.pricing })
  for (const [index, member] of plan.members.entries()) {
    const resolved = memberPrices[index]
    if (!resolved?.available) throw new Error("A package option is no longer available for this home. Review the package before applying it.")
    const category = packageMembers.find((item) => item.option_id === member.optionId)?.category_id
    if (!category || !resolved.categoryIds.includes(category)) throw new Error("A package option resolves to a different category")
  }

  await assertProjectConfiguration(input.orgId, input.projectId, plan.members.map((member) => ({ selectionId: member.selectionId, optionId: memberPrices[member.index].optionId ?? member.optionId })))

  // Every member is gated before any member is written. A cutoff lock hit
  // halfway through used to leave the home carrying half a package with no
  // way back.
  for (const member of plan.members) {
    const mutation = await loadSelectionMutationContext({ orgId: input.orgId, projectId: input.projectId, selectionId: member.selectionId, optionId: member.optionId })
    await assertSelectionMutable(mutation, { portal: Boolean(input.portalAccess) })
    const optionId = memberPrices[member.index].optionId ?? member.optionId
    await assertSupplyEligible(mutation, {
      orgId: input.orgId, projectId: input.projectId, selectionId: member.selectionId, optionId, actorId, portal: Boolean(input.portalAccess),
      option: { optionId, name: mutation.options.find((option) => option.id === member.optionId)?.name ?? "A package option", available: true },
    })
  }

  const nowIso = new Date().toISOString()
  const priceAllocations = allocatePackageTotal(pricing.priceCents, plan.members.length)
  const costAllocations = pricing.costCents == null ? null : allocatePackageTotal(pricing.costCents, plan.members.length)
  await applySelectionWrites(input.orgId, input.projectId, fence, plan.members.map((member) => ({
    id: member.selectionId,
    selected_option_id: memberPrices[member.index].optionId ?? member.optionId,
    package_id: input.packageId,
    status: "selected",
    selected_at: nowIso,
    selected_by_contact_id: input.selectedByContactId ?? null,
    price_cents_snapshot: priceAllocations[member.index],
    cost_cents_snapshot: costAllocations?.[member.index] ?? null,
    metadata: { package_allocated: true, package_member_index: member.index },
  })))
  await recordEvent({ orgId: input.orgId, actorId: actorId ?? undefined, eventType: "selection_updated", entityType: "selection_package", entityId: input.packageId, payload: { project_id: input.projectId, group_id: plan.groupId } })
  return { success: true }
}

export async function createProjectSelection({ input, orgId }: { input: SelectionInput; orgId?: string }) {
  const context = await requireOrgContext(orgId)
  // The design studio works across homes whose team it is not on, which the
  // row policy (team members and admins) would refuse: the permission is the
  // org's, the home must sit in the member's divisions, and the service writes.
  await requirePermission("selections.write", context)
  const service = createServiceSupabaseClient()
  const [{ data: home, error: homeError }, access] = await Promise.all([
    service.from("projects").select("id, division_id").eq("org_id", context.orgId).eq("id", input.project_id).maybeSingle(),
    getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
  ])
  if (homeError) throw new Error(`Failed to load the home: ${homeError.message}`)
  if (!home || (access.assignedOnly && !access.divisionIds.includes(String(home.division_id)))) throw new Error("Home not found")
  // A selection opened on a home belongs to the deadline group its category is
  // in there, so it cannot be chosen after that group's cutoff.
  const [{ data: groups, error: groupsError }, { data: links, error: linksError }] = await Promise.all([
    service.from("project_selection_groups").select("group_id").eq("org_id", context.orgId).eq("project_id", input.project_id),
    service.from("selection_group_categories").select("group_id").eq("org_id", context.orgId).eq("category_id", input.category_id),
  ])
  if (groupsError || linksError) throw new Error(`Failed to load the home's selection groups: ${(groupsError ?? linksError)?.message}`)
  const homeGroups = new Set((groups ?? []).map((group) => group.group_id as string))
  const groupId = (links ?? []).map((link) => link.group_id as string).filter((id) => homeGroups.has(id)).sort()[0] ?? null
  const payload = {
    org_id: context.orgId,
    project_id: input.project_id,
    category_id: input.category_id,
    group_id: groupId,
    status: "pending",
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
  }
  const { data, error } = await service
    .from("project_selections")
    .insert(payload)
    .select("id, org_id, project_id, category_id, selected_option_id, status, due_date, selected_at, confirmed_at, notes")
    .single()
  if (error || !data) throw new Error(`Failed to create selection: ${error?.message ?? "missing row"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "selection_created", entityType: "selection", entityId: data.id, payload: { project_id: input.project_id, category_id: input.category_id, status: payload.status } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "selection", entityId: data.id, after: payload }),
  ])
  return data as Selection
}

export type HomeSelectionException = SelectionExceptionDto & { alternates: SelectionAlternate[] }

/** Open exceptions answered by an alternate get their live alternates; more than this are listed without. */
const EXCEPTION_ALTERNATES_CAP = 10

/** The home's selection exceptions, each open supply exception with what the buyer can still have. */
export async function listHomeSelectionExceptions(projectId: string, orgId?: string): Promise<{ exceptions: HomeSelectionException[]; truncated: boolean }> {
  const { exceptions, truncated } = await listSelectionExceptions(projectId, orgId)
  const answerable = exceptions
    .filter((exception) => exception.status === "open" && (exception.reason === "option_unavailable" || exception.reason === "lead_time_exceeded"))
    .slice(0, EXCEPTION_ALTERNATES_CAP)
  if (!answerable.length) return { exceptions: exceptions.map((exception) => ({ ...exception, alternates: [] })), truncated }
  const home = await readHomePricingScope(createServiceSupabaseClient(), answerable[0].org_id, projectId)
  const alternates = new Map(await Promise.all(answerable.map(async (exception) => [exception.id, await selectionAlternates({
    orgId: exception.org_id, projectId, selectionId: exception.selection_id, categoryId: exception.category_id,
    excludeOptionId: exception.option_id, pricing: home.pricing,
  })] as const)))
  return { exceptions: exceptions.map((exception) => ({ ...exception, alternates: alternates.get(exception.id) ?? [] })), truncated }
}

/**
 * Answers an exception with an option the home can still have. The choice is
 * an ordinary selection write (every deadline and supply rule applies); the
 * write closes the exception and this records who chose.
 */
export async function chooseSelectionAlternate(raw: SelectionExceptionAlternateInput) {
  const input = selectionExceptionAlternateSchema.parse(raw)
  const context = await requireOrgContext()
  const exception = await loadSelectionException(context.orgId, input.exceptionId)
  if (exception.status !== "open") throw new Error("This exception was already resolved")
  if (exception.reason === "variance_unrouted" || exception.reason === "procurement_released") {
    throw new Error("This exception is resolved through purchasing or a change order, not by choosing again")
  }
  await selectProjectOptions({ orgId: context.orgId, projectId: exception.project_id, changes: [{ selectionId: exception.selection_id, optionId: input.optionId }] })
  await recordAlternateChosen({ orgId: context.orgId, exceptionId: exception.id, actorId: context.userId, optionId: input.optionId })
  return { projectId: exception.project_id }
}
