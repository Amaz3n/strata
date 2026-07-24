import "server-only"

import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

export type ProductionHouseOverviewData = {
  identity: {
    projectId: string
    projectName: string
    address: string | null
    communityId: string | null
    communityName: string
    phaseName: string | null
    lotNumber: string | null
    planId: string | null
    planName: string
    elevation: string | null
    swing: string | null
    version: number | null
    superintendent: string | null
    buyer: string | null
    startReleasedDate: string | null
    projectedClosing: string | null
  }
  schedule: {
    currentStage: string
    completed: number
    total: number
    progress: number
    daysElapsed: number | null
    communityAverageCycleDays: number | null
    next: Array<{ id: string; name: string; date: string | null; status: string }>
  }
  money: {
    basePriceCents: number
    lotPremiumCents: number
    structuralOptionsCents: number
    selectionsCents: number
    changeOrdersCents: number
    budgetCents: number
    actualCostCents: number
    vpoCents: number
    vpoCount: number
    topVpoReason: string | null
    projectedMarginCents: number
    projectedMarginPercent: number
  }
  gates: {
    startStatus: string
    startPassed: number
    startTotal: number
    selectionStatus: string
    nextCutoff: string | null
    closingStatus: string
    closingOpen: number
    closingTotal: number
  }
  quiet: {
    openPunch: number
    latestPhotoAt: string | null
    latestDailyLogDate: string | null
    openWarranty: number
  }
}

export async function getProductionHouseOverview(projectId: string, orgId?: string): Promise<ProductionHouseOverviewData> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "project.read")
  const { data: project, error } = await context.supabase
    .from("projects")
    .select("id,name,location,start_date,end_date,superintendent:app_users!projects_superintendent_id_fkey(full_name),client:contacts(full_name)")
    .eq("org_id", context.orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (error || !project) throw new Error("Home not found")

  const [{ data: lot }, { data: schedule }, { data: startPackage }, { data: contracts }, { data: budgetRows }, { data: costs }, { data: vpos }, { data: selectionGroups }, { data: selections }, { data: closing }, { count: punchCount }, { data: photos }, { data: logs }, { count: warrantyCount }, { data: approvedCos }] = await Promise.all([
    context.supabase.from("lots").select("id,lot_number,address,dimensions,swing,premium_cents,community_id,community:communities(name,settings),phase:community_phases(name),house_plan_id,plan:house_plans(name,code),elevation:house_plan_elevations(name,code),version:house_plan_versions(version_number)").eq("org_id", context.orgId).eq("project_id", projectId).maybeSingle(),
    context.supabase.from("schedule_items").select("id,name,status,start_date,end_date,progress,item_type,sort_order").eq("org_id", context.orgId).eq("project_id", projectId).order("sort_order").limit(500),
    context.supabase.from("start_packages").select("id,status,actual_start_date,released_at,gates:start_package_gates(status)").eq("org_id", context.orgId).eq("project_id", projectId).neq("status", "cancelled").maybeSingle(),
    context.supabase.from("contracts").select("id,total_cents,status,snapshot,signed_at").eq("org_id", context.orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").order("signed_at", { ascending: false, nullsFirst: false }).limit(1),
    context.supabase.from("budgets").select("total_cents,version").eq("org_id", context.orgId).eq("project_id", projectId).order("version", { ascending: false }).limit(1),
    context.supabase.from("job_cost_entries").select("cost_cents").eq("org_id", context.orgId).eq("project_id", projectId).eq("status", "posted").limit(5_000),
    context.supabase.from("commitment_change_orders").select("id,total_cents,status,reason:variance_reason_codes(label,code)").eq("org_id", context.orgId).eq("project_id", projectId).not("reason_code_id", "is", null).in("status", ["approved", "executed"]).limit(500),
    context.supabase.from("project_selection_groups").select("id,status,cutoff_date").eq("org_id", context.orgId).eq("project_id", projectId).order("cutoff_date", { ascending: true, nullsFirst: false }).limit(100),
    context.supabase.from("project_selections").select("price_cents_snapshot,status").eq("org_id", context.orgId).eq("project_id", projectId).limit(1_000),
    context.supabase.from("closings").select("id,status,scheduled_date,actual_date,items:closing_checklist_items(status)").eq("org_id", context.orgId).eq("project_id", projectId).neq("status", "cancelled").maybeSingle(),
    context.supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("project_id", projectId).not("status", "in", "(completed,closed,resolved)"),
    context.supabase.from("photos").select("taken_at,created_at").eq("org_id", context.orgId).eq("project_id", projectId).order("taken_at", { ascending: false, nullsFirst: false }).limit(1),
    context.supabase.from("daily_logs").select("log_date").eq("org_id", context.orgId).eq("project_id", projectId).order("log_date", { ascending: false }).limit(1),
    context.supabase.from("warranty_requests").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("project_id", projectId).in("status", ["open", "in_progress"]),
    context.supabase.from("change_orders").select("total_cents").eq("org_id", context.orgId).eq("project_id", projectId).eq("status", "approved").limit(500),
  ])

  const scheduleRows = schedule ?? []
  const completed = scheduleRows.filter((row) => row.status === "completed").length
  const current = scheduleRows.find((row) => row.status === "in_progress") ?? scheduleRows.find((row) => row.status !== "completed")
  const startDate = startPackage?.actual_start_date ?? startPackage?.released_at?.slice(0, 10) ?? project.start_date
  const elapsed = startDate ? Math.max(0, Math.floor((Date.now() - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000)) : null
  const contract = contracts?.[0]
  const pricing = (contract?.snapshot as any)?.purchase_agreement?.pricing ?? {}
  const basePrice = Number(pricing.base_price_cents ?? 0)
  const lotPremium = Number(pricing.lot_premium_cents ?? lot?.premium_cents ?? 0)
  const structuralOptions = Number(pricing.structural_options_cents ?? 0)
  const selectionPrice = Number(pricing.design_selections_cents ?? (selections ?? []).reduce((total, row) => total + Number(row.price_cents_snapshot ?? 0), 0))
  const changeOrders = (approvedCos ?? []).reduce((total, row) => total + Number(row.total_cents ?? 0), 0)
  const salePrice = Number(contract?.total_cents ?? basePrice + lotPremium + structuralOptions + selectionPrice + changeOrders)
  const budget = Number(budgetRows?.[0]?.total_cents ?? 0)
  const actualCost = (costs ?? []).reduce((total, row) => total + Number(row.cost_cents ?? 0), 0)
  const vpoCents = (vpos ?? []).reduce((total, row) => total + Number(row.total_cents ?? 0), 0)
  const projectedCost = Math.max(budget, actualCost) + vpoCents
  const projectedMargin = salePrice - projectedCost
  const reasonTotals = new Map<string, number>()
  for (const row of vpos ?? []) {
    const reason = one<any>(row.reason)
    const label = reason?.label ?? reason?.code ?? "Uncoded"
    reasonTotals.set(label, (reasonTotals.get(label) ?? 0) + Number(row.total_cents ?? 0))
  }
  const gates = startPackage?.gates ?? []
  const closingItems = closing?.items ?? []
  const openGroups = (selectionGroups ?? []).filter((row) => row.status === "open")
  const lotPlan = one<any>(lot?.plan)
  const elevation = one<any>(lot?.elevation)
  const version = one<any>(lot?.version)
  const community = one<any>(lot?.community)
  const phase = one<any>(lot?.phase)
  const superintendent = one<any>(project.superintendent)
  const buyer = one<any>(project.client)
  const location = (project.location ?? {}) as Record<string, any>
  const dimensions = (lot?.dimensions ?? {}) as Record<string, any>
  let communityAverageCycleDays: number | null = null
  if (lot?.community_id) {
    const { data: communityStarts } = await context.supabase
      .from("start_packages")
      .select("actual_start_date,project:projects!inner(end_date,status)")
      .eq("org_id", context.orgId)
      .eq("community_id", lot.community_id)
      .eq("status", "released")
      .not("actual_start_date", "is", null)
      .eq("project.status", "completed")
      .limit(250)
    const cycleDays = (communityStarts ?? []).flatMap((row: any) => {
      const completedProject = one<any>(row.project)
      return completedProject?.end_date
        ? [Math.max(0, Math.round((Date.parse(`${completedProject.end_date}T00:00:00Z`) - Date.parse(`${row.actual_start_date}T00:00:00Z`)) / 86_400_000))]
        : []
    }).sort((a, b) => a - b)
    communityAverageCycleDays = cycleDays.length ? cycleDays[Math.floor(cycleDays.length / 2)] ?? null : null
  }

  return {
    identity: {
      projectId,
      projectName: project.name,
      address: lot?.address ?? dimensions.address ?? location.address ?? location.formatted ?? null,
      communityId: lot?.community_id ?? null,
      communityName: community?.name ?? "Unassigned community",
      phaseName: phase?.name ?? null,
      lotNumber: lot?.lot_number ?? null,
      planId: lot?.house_plan_id ?? null,
      planName: lotPlan?.name ?? lotPlan?.code ?? "Plan unassigned",
      elevation: elevation?.name ?? elevation?.code ?? null,
      swing: lot?.swing ?? null,
      version: version?.version_number ?? null,
      superintendent: superintendent?.full_name ?? null,
      buyer: buyer?.full_name ?? null,
      startReleasedDate: startDate ?? null,
      projectedClosing: closing?.scheduled_date ?? project.end_date ?? null,
    },
    schedule: {
      currentStage: current?.name ?? (completed === scheduleRows.length && completed > 0 ? "Complete" : "Schedule not released"),
      completed,
      total: scheduleRows.length,
      progress: scheduleRows.length ? Math.round((completed / scheduleRows.length) * 100) : 0,
      daysElapsed: elapsed,
      communityAverageCycleDays,
      next: scheduleRows.filter((row) => row.status !== "completed").slice(0, 5).map((row) => ({ id: row.id, name: row.name, date: row.start_date ?? row.end_date ?? null, status: row.status })),
    },
    money: {
      basePriceCents: basePrice,
      lotPremiumCents: lotPremium,
      structuralOptionsCents: structuralOptions,
      selectionsCents: selectionPrice,
      changeOrdersCents: changeOrders,
      budgetCents: budget,
      actualCostCents: actualCost,
      vpoCents,
      vpoCount: vpos?.length ?? 0,
      topVpoReason: Array.from(reasonTotals.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      projectedMarginCents: projectedMargin,
      projectedMarginPercent: salePrice > 0 ? (projectedMargin / salePrice) * 100 : 0,
    },
    gates: {
      startStatus: startPackage?.status ?? "No start package",
      startPassed: gates.filter((row: any) => ["passed", "waived", "not_applicable"].includes(row.status)).length,
      startTotal: gates.length,
      selectionStatus: openGroups.length ? `${openGroups.length} selection group${openGroups.length === 1 ? "" : "s"} open` : "Selections locked",
      nextCutoff: openGroups.find((row) => row.cutoff_date)?.cutoff_date ?? null,
      closingStatus: closing?.status ?? "Not scheduled",
      closingOpen: closingItems.filter((row: any) => row.status === "open").length,
      closingTotal: closingItems.length,
    },
    quiet: {
      openPunch: punchCount ?? 0,
      latestPhotoAt: photos?.[0]?.taken_at ?? photos?.[0]?.created_at ?? null,
      latestDailyLogDate: logs?.[0]?.log_date ?? null,
      openWarranty: warrantyCount ?? 0,
    },
  }
}
