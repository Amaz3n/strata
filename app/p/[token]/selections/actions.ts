"use server"

import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { confirmSelectionGroup, listProjectSelections, listSelectionCategories, listSelectionOptions, selectProjectOption, selectProjectPackage } from "@/lib/services/selections"
import { actionError, type ActionResult } from "@/lib/action-result"
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
    permission: "can_submit_selections",
  })

  const [selections, categories] = await Promise.all([
    listProjectSelections(access.org_id, access.project_id, { portalAccess: true }),
    listSelectionCategories(access.org_id),
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
  const { data: lot } = await supabase
    .from("lots")
    .select("community_id, house_plan_version_id")
    .eq("org_id", access.org_id)
    .eq("project_id", access.project_id)
    .maybeSingle()
  const effectiveOptionsByCategory = Object.fromEntries(
    await Promise.all(Object.entries(optionsByCategory).map(async ([categoryId, options]) => {
      const visible = options.filter((option) => option.community_id == null || option.community_id === lot?.community_id)
      const overridden = new Set(visible.filter((option) => option.community_id === lot?.community_id && option.parent_option_id).map((option) => option.parent_option_id))
      const effective = visible.filter((option) => option.community_id === lot?.community_id || !overridden.has(option.id))
      const pricing = effective.length ? await resolveOptionPricing({
        orgId: access.org_id,
        items: effective.map((option) => ({ optionId: option.parent_option_id ?? option.id })),
        housePlanVersionId: lot?.house_plan_version_id ?? undefined,
        communityId: lot?.community_id ?? undefined,
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
  packageQuery = lot?.community_id
    ? packageQuery.or(`community_id.is.null,community_id.eq.${lot.community_id}`)
    : packageQuery.is("community_id", null)
  const { data: packageRows, error: packageError } = await packageQuery
  if (packageError) throw new Error(`Failed to load selection packages: ${packageError.message}`)
  const packagePricing = packageRows?.length
    ? await resolveOptionPricing({
        orgId: access.org_id,
        items: packageRows.map((item) => ({ packageId: item.id })),
        housePlanVersionId: lot?.house_plan_version_id ?? undefined,
        communityId: lot?.community_id ?? undefined,
      })
    : []

  return {
    selections: selections.map(({ cost_cents_snapshot: _cost, selected_option: selectedOption, ...selection }) => {
      if (!selectedOption) return { ...selection, selected_option: null }
      const { cost_cents: _optionCost, cost_code_id: _costCode, vendor: _vendor, ...buyerOption } = selectedOption
      return { ...selection, selected_option: buyerOption }
    }),
    categories,
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

export async function selectOptionAction(input: { token: string; selectionId: string; optionId: string }) {
  return run(async () => {
    const access = await assertPortalActionAccess(input.token, {
      portalType: "client",
      permission: "can_submit_selections",
    })

    return selectProjectOption({
      orgId: access.org_id,
      projectId: access.project_id,
      selectionId: input.selectionId,
      optionId: input.optionId,
      selectedByContactId: access.contact_id ?? null,
      portalAccess: true,
    })
  })
}

export async function confirmGroupAction(input: { token: string; groupId: string }) {
  return run(async () => {
    const access = await assertPortalActionAccess(input.token, {
      portalType: "client",
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



