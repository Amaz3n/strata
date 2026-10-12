"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { confirmSelectionGroup, listProjectSelections, listSelectionCategories, listSelectionOptions, selectProjectOption, selectProjectOptions, selectProjectPackage } from "@/lib/services/selections"
import { actionError, type ActionResult } from "@/lib/action-result"
import { getHomeConfigurationFixes, resolveHomeConfigurationFix } from "@/lib/services/configuration-rules"
import { readHomePricingScope } from "@/lib/services/home-pricing-scope"
import { resolveOptionPricing } from "@/lib/services/option-catalog"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await operation() }
  } catch (error) {
    return actionError(error)
  }
}

export async function loadSelectionsAction(token: string) {
  const access = await assertPortalActionAccess(token, {
    portalType: "client",
    requireProject: true,
    permission: "can_submit_selections",
  })

  const [selections, categories, configuration] = await Promise.all([
    listProjectSelections(access.org_id, access.project_id, { portalAccess: true }),
    listSelectionCategories(access.org_id),
    run(() => getHomeConfigurationFixes(access.org_id, access.project_id, { portalAccess: true })),
  ])

  const optionsByCategory = Object.fromEntries(
    await Promise.all(
      categories.map(async (cat) => {
        const options = await listSelectionOptions(access.org_id, cat.id)
        return [cat.id, options] as const
      }),
    ),
  )

  const supabase = createServiceSupabaseClient()
  const { pricing: scope } = await readHomePricingScope(supabase, access.org_id, access.project_id)
  const effectiveOptionsByCategory = Object.fromEntries(
    await Promise.all(Object.entries(optionsByCategory).map(async ([categoryId, options]) => {
      const visible = options.filter((option) => option.community_id == null || option.community_id === scope.communityId)
      const overridden = new Set(visible.filter((option) => option.community_id === scope.communityId && option.parent_option_id).map((option) => option.parent_option_id))
      const effective = visible.filter((option) => option.community_id === scope.communityId || !overridden.has(option.id))
      const pricing = effective.length ? await resolveOptionPricing({
        orgId: access.org_id,
        items: effective.map((option) => ({ optionId: option.parent_option_id ?? option.id })),
        ...scope,
      }) : []
      return [categoryId, effective.map((option, index) => ({
        ...option,
        id: pricing[index]?.optionId ?? option.id,
        price_cents: pricing[index]?.priceCents ?? option.price_cents,
        is_available: pricing[index]?.available ?? option.is_available,
      })).filter((option) => option.is_available)] as const
    })),
  )
  let packageQuery = supabase
    .from("selection_packages")
    .select("id, name, description, image_url, price_cents, is_available, community_id, items:selection_package_items(option_id)")
    .eq("org_id", access.org_id)
    .eq("is_archived", false)
    .eq("is_available", true)
    .order("sort_order")
    .limit(100)
  packageQuery = scope.communityId
    ? packageQuery.or(`community_id.is.null,community_id.eq.${scope.communityId}`)
    : packageQuery.is("community_id", null)
  const { data: packageRows, error: packageError } = await packageQuery
  if (packageError) throw new Error(`Failed to load selection packages: ${packageError.message}`)
  const packagePricing = packageRows?.length
    ? await resolveOptionPricing({
        orgId: access.org_id,
        items: packageRows.map((item) => ({ packageId: item.id })),
        ...scope,
      })
    : []

  return {
    selections: selections.map(({ cost_cents_snapshot: _cost, selected_option: selectedOption, ...selection }) => {
      if (!selectedOption) return { ...selection, selected_option: null }
      const { cost_cents: _optionCost, cost_code_id: _costCode, vendor: _vendor, ...buyerOption } = selectedOption
      return { ...selection, selected_option: buyerOption }
    }),
    categories,
    configuration,
    optionsByCategory: Object.fromEntries(
      Object.entries(effectiveOptionsByCategory).map(([categoryId, options]) => [
        categoryId,
        options.map(({ cost_cents: _cost, cost_code_id: _costCode, vendor: _vendor, ...option }) => option),
      ]),
    ),
    packages: (packageRows ?? []).map((item, index) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      image_url: item.image_url,
      price_cents: packagePricing[index]?.priceCents ?? item.price_cents,
      is_available: packagePricing[index]?.available ?? item.is_available,
      option_ids: (item.items ?? []).map((member) => member.option_id),
    })).filter((item) => item.is_available),
  }
}

/** A choice that breaks an option rule comes back with the rules it broke and the corrections that would make it valid. */
export async function selectOptionAction(input: { token: string; selectionId: string; optionId: string }) {
  const access = await run(() => assertPortalActionAccess(input.token, {
    portalType: "client",
    requireProject: true,
    permission: "can_submit_selections",
  }))
  if (!access.success) return access
  const { org_id: orgId, project_id: projectId } = access.data
  const result = await run(() => selectProjectOption({
    orgId,
    projectId,
    selectionId: input.selectionId,
    optionId: input.optionId,
    selectedByContactId: access.data.contact_id ?? null,
    portalAccess: true,
  }))
  if (result.success || !result.violations) return result
  const issues = await run(() => getHomeConfigurationFixes(orgId, projectId, { portalAccess: true, changes: [{ selectionId: input.selectionId, optionId: input.optionId }] }))
  return issues.success ? { ...result, fixes: issues.data.fixes } : result
}

/** The home's configuration issues as they stand now, for re-checking after a change. */
export async function loadConfigurationIssuesAction(token: string) {
  return run(async () => {
    const access = await assertPortalActionAccess(token, {
      portalType: "client",
      requireProject: true,
      permission: "can_submit_selections",
    })
    return getHomeConfigurationFixes(access.org_id, access.project_id, { portalAccess: true })
  })
}

/**
 * Applies a correction the home's configuration check suggested. The fix is
 * looked up again on the server — a blocked or stale one is refused — and lands
 * through the same selection mutation a buyer's own choice does, in ONE write
 * with the choice it was correcting when that is a different selection: the
 * pair lands whole or not at all.
 */
export async function applyConfigurationFixAction(input: { token: string; fixId: string; proposal?: { selectionId: string; optionId: string } | null }) {
  return run(async () => {
    const access = await assertPortalActionAccess(input.token, {
      portalType: "client",
      requireProject: true,
      permission: "can_submit_selections",
    })
    const changes = input.proposal ? [input.proposal] : []
    const fix = await resolveHomeConfigurationFix(access.org_id, access.project_id, { fixId: input.fixId, changes }, { portalAccess: true })
    const writes = [fix, ...changes.filter((change) => change.selectionId !== fix.selectionId)]
    await selectProjectOptions({
      orgId: access.org_id,
      projectId: access.project_id,
      changes: writes.map((write) => ({ selectionId: write.selectionId, optionId: write.optionId })),
      selectedByContactId: access.contact_id ?? null,
      portalAccess: true,
    })
    return { writes, configuration: await getHomeConfigurationFixes(access.org_id, access.project_id, { portalAccess: true }) }
  })
}

export async function confirmGroupAction(input: { token: string; groupId: string }) {
  return run(async () => {
    const access = await assertPortalActionAccess(input.token, {
      portalType: "client",
      requireProject: true,
      permission: "can_submit_selections",
    })
    return confirmSelectionGroup({
      orgId: access.org_id,
      projectId: access.project_id,
      groupId: input.groupId,
      portalAccess: true,
    })
  })
}

export async function selectPackageAction(input: { token: string; packageId: string }) {
  return run(async () => {
    const access = await assertPortalActionAccess(input.token, {
      portalType: "client",
      requireProject: true,
      permission: "can_submit_selections",
    })
    return selectProjectPackage({
      orgId: access.org_id,
      projectId: access.project_id,
      packageId: input.packageId,
      selectedByContactId: access.contact_id ?? null,
      portalAccess: true,
    })
  })
}



