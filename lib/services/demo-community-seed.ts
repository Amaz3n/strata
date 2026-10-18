import "server-only"

import { tagSampleImportedHomes } from "@/lib/services/sample-home-provenance"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { commitImportBatch, stageImportBatch } from "@/lib/services/imports"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export const SAMPLE_COMMUNITY_SPEC = {
  name: "Cypress Landing",
  code: "CYP",
  location: { city: "Naples", state: "FL", postalCode: "34119" },
  plans: [
    { code: "CL1650", name: "The Mangrove", heatedSqft: 1650, beds: 3, baths: 2 },
    { code: "CL1900", name: "The Palmetto", heatedSqft: 1900, beds: 3, baths: 2.5 },
    { code: "CL2400", name: "The Banyan", heatedSqft: 2400, beds: 4, baths: 3 },
  ],
  statuses: ["controlled", "controlled", "controlled", "controlled", "developed", "developed", "developed", "developed", "assigned", "assigned", "assigned", "started", "started", "started", "started", "started", "started", "closed", "closed", "closed"],
} as const

function csv(headers: readonly string[], rows: Array<Record<string, string | number | boolean | null | undefined>>) {
  const quote = (value: unknown) => {
    const text = String(value ?? "")
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return [headers.join(","), ...rows.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\n")
}

// Importer money columns parse as DOLLARS (parseCents multiplies by 100), matching
// real builder CSV exports — so every money value below is written in dollars.
async function importCsv(input: { orgId: string; importer: "plan_library" | "option_catalog" | "price_book" | "communities_lots" | "open_wip"; name: string; headers: string[]; rows: Array<Record<string, string | number | boolean | null | undefined>>; context?: Record<string, unknown> }) {
  const batch = await stageImportBatch({ importer: input.importer, csvText: csv(input.headers, input.rows), sourceFilename: input.name, context: input.context }, { platformOrgId: input.orgId })
  if (batch.error_count > 0) throw new Error(`Sample ${input.importer} failed dry-run validation`)
  return commitImportBatch(batch.id, { platformOrgId: input.orgId })
}

async function assertSampleNamespaceAvailable(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const probes = [
    ["house_plans", "code", SAMPLE_COMMUNITY_SPEC.plans.map(plan => plan.code)],
    ["selection_options", "sku", Array.from({ length: 15 }, (_, i) => `CYP-OPT-${String(i + 1).padStart(2, "0")}`)],
    ["selection_categories", "name", ["Kitchen", "Flooring", "Electrical", "Exterior"].map(name => `Cypress Sample — ${name}`)],
    ["companies", "name", Array.from({ length: 6 }, (_, i) => `Cypress Sample Trade ${i + 1}`)],
    ["communities", "name", [SAMPLE_COMMUNITY_SPEC.name]],
    ["communities", "code", [SAMPLE_COMMUNITY_SPEC.code]],
    ["schedule_templates", "name", ["Cypress Landing 120-day build"]],
    ["contacts", "email", ["sample-buyer-1@example.invalid", "sample-buyer-2@example.invalid"]],
  ] as const
  // Every value is a server-owned template constant, not user-supplied filter
  // text. ilike catches casing differences also normalized by the importers.
  const results = await Promise.all(probes.map(async ([table, column, values]) => ({
    table,
    result: await supabase.from(table).select("id", { count: "exact", head: true })
      .eq("org_id", orgId).or(values.map(value => `${column}.ilike.${value}`).join(",")),
  })))
  for (const { table, result } of results) {
    if (result.error || result.count == null) throw new Error(`Unable to verify sample namespace in ${table}`)
    if (result.count > 0) throw new Error(`Sample namespace already exists in ${table}; reconcile original ownership before seeding`)
  }
}

export async function seedSampleCommunity(orgId: string, actorUserId: string): Promise<{ communityId: string }> {
  const actor = await requireAnyPlatformPermission(["platform.support.write"])
  if (actor.id !== actorUserId) throw new Error("Platform actor mismatch")
  const supabase = createServiceSupabaseClient()
  const { data: existing, error: existingError } = await supabase.from("communities").select("id,metadata").eq("org_id", orgId).contains("metadata", { is_sample: true }).maybeSingle()
  if (existingError) throw new Error("Unable to inspect the original sample community")
  if (existing) {
    if (existing.metadata?.sample_seed_status !== "seeded") throw new Error("Existing sample completion is unproven; reconcile its original import evidence before retrying")
    return { communityId: existing.id }
  }
  await assertSampleNamespaceAvailable(orgId)

  const { data: costCodes } = await supabase.from("cost_codes").select("id,code").eq("org_id", orgId).eq("is_active", true).order("code").limit(25)
  if (!costCodes || costCodes.length < 5) throw new Error("Seed cost codes before the sample community")
  const planRows = SAMPLE_COMMUNITY_SPEC.plans.flatMap((plan) => ["A", "B"].map((elevation, index) => ({ plan_code: plan.code, plan_name: plan.name, series: "Cypress Landing Sample", heated_sqft: plan.heatedSqft, total_sqft: plan.heatedSqft + 320, beds: plan.beds, baths: plan.baths, stories: plan.heatedSqft > 2000 ? 2 : 1, garage_bays: 2, elevation_code: elevation, elevation_name: index ? "Coastal" : "Craftsman", elevation_sqft_delta: index * 40, swing_applicable: true })))
  await importCsv({ orgId, importer: "plan_library", name: "sample-plans.csv", headers: Object.keys(planRows[0]), rows: planRows, context: { file_kind: "plans", is_sample: true } })

  // Sample takeoff aims at a believable production direct cost: the square-foot
  // scopes carry roughly $95/sf and the lump-sum scopes another ~$38k, landing a
  // 1,650 sf plan near $118/sf and a 2,400 sf plan near $111/sf. Values are cents.
  const sqftScopeUnitCents = 1_350
  const takeoffRows = SAMPLE_COMMUNITY_SPEC.plans.flatMap((plan) =>
    costCodes.map((costCode, index) => {
      const bySqft = index % 4 === 0
      return {
        plan_code: plan.code,
        elevation_code: "",
        cost_code: costCode.code,
        description: `Sample scope ${index + 1}`,
        quantity: bySqft ? plan.heatedSqft : 1,
        uom: bySqft ? "sf" : "ls",
        unit_cost_cents: bySqft ? sqftScopeUnitCents : 150_000 + index * 25_000,
      }
    }),
  )
  await importCsv({ orgId, importer: "plan_library", name: "sample-takeoffs.csv", headers: Object.keys(takeoffRows[0]), rows: takeoffRows, context: { file_kind: "takeoffs", is_sample: true } })

  // The foundation waits 35 days behind the permit release and each later phase starts the day after
  // the one before it finishes; the trade phases carry the cost codes
  // the sample takeoffs buy under, so a late delivery advises the task it holds up.
  const after = (key: string, lag = 1) => ({ depends_on: [{ key, type: "FS", lag_days: lag }] })
  const scheduleItems = [
    { key: "permit-release", name: "Permit release", start_offset_days: -35, duration_days: 1 },
    { key: "foundation", name: "Foundation", start_offset_days: 0, duration_days: 14, cost_code_id: costCodes[0].id, ...after("permit-release", 35) },
    { key: "framing", name: "Framing", start_offset_days: 14, duration_days: 21, cost_code_id: costCodes[1].id, ...after("foundation") },
    { key: "dry-in", name: "Dry-in", start_offset_days: 35, duration_days: 10, ...after("framing") },
    { key: "mep-rough", name: "MEP rough", start_offset_days: 45, duration_days: 18, cost_code_id: costCodes[2].id, ...after("dry-in") },
    { key: "drywall", name: "Drywall", start_offset_days: 63, duration_days: 14, cost_code_id: costCodes[3].id, ...after("mep-rough") },
    { key: "interior-finishes", name: "Interior finishes", start_offset_days: 77, duration_days: 28, cost_code_id: costCodes[4].id, ...after("drywall") },
    { key: "punch-and-close", name: "Punch and close", start_offset_days: 105, duration_days: 14, ...after("interior-finishes") },
  ]
  const { data: schedule, error: scheduleError } = await supabase.from("schedule_templates").insert({ org_id: orgId, name: "Cypress Landing 120-day build", property_type: "production", items: scheduleItems, created_by: actorUserId }).select("id").single()
  if (scheduleError || !schedule) throw new Error(`Failed to create sample schedule: ${scheduleError?.message}`)
  const { data: plans } = await supabase.from("house_plans").select("id,code,metadata,versions:house_plan_versions(id,status,metadata)").eq("org_id", orgId).eq("series", "Cypress Landing Sample").in("code", SAMPLE_COMMUNITY_SPEC.plans.map(plan => plan.code))
  for (const plan of plans ?? []) {
    const draft = Array.isArray(plan.versions) ? plan.versions.find((version) => version.status === "draft") : null
    if (!draft) continue
    const { error: configureError } = await supabase.from("house_plan_versions").update({ schedule_template_id: schedule.id, metadata: { ...(draft.metadata ?? {}), is_sample: true } }).eq("org_id", orgId).eq("id", draft.id)
    if (configureError) throw new Error(`Failed to configure sample plan: ${configureError.message}`)
    const { error: releaseError } = await supabase.rpc("release_house_plan_version", { p_org_id: orgId, p_version_id: draft.id, p_actor_id: actorUserId, p_bundle_snapshot: { sample: true, schedule_template: { id: schedule.id, items: scheduleItems } } })
    if (releaseError) throw new Error(`Failed to release sample plan: ${releaseError.message}`)
    await supabase.from("house_plans").update({ status: "active", metadata: { ...(plan.metadata ?? {}), is_sample: true } }).eq("org_id", orgId).eq("id", plan.id)
  }

  const optionRows = Array.from({ length: 15 }, (_, index) => ({ category: `Cypress Sample — ${["Kitchen", "Flooring", "Electrical", "Exterior"][index % 4]}`, option_code: `CYP-OPT-${String(index + 1).padStart(2, "0")}`, option_name: ["Cabinet upgrade", "Flooring upgrade", "Lighting package", "Exterior detail"][index % 4] + ` ${Math.floor(index / 4) + 1}`, scope: index < 5 ? "structural" : "design_studio", price_cents: (75000 + index * 12500) / 100, cost_cents: (42000 + index * 8000) / 100, cost_code: costCodes[index % costCodes.length].code, lead_time_days: 14 + index, is_default: index % 5 === 0, applicable_plans: SAMPLE_COMMUNITY_SPEC.plans.map((plan) => plan.code).join(";") }))
  await importCsv({ orgId, importer: "option_catalog", name: "sample-options.csv", headers: Object.keys(optionRows[0]), rows: optionRows, context: { is_sample: true } })

  const priceRows = Array.from({ length: 30 }, (_, index) => ({ vendor: `Cypress Sample Trade ${index % 6 + 1}`, cost_code: costCodes[index % costCodes.length].code, description: `Sample agreement ${index + 1}`, uom: index % 3 === 0 ? "sf" : "ls", unit_price_cents: index % 3 === 0 ? (150 + index * 5) / 100 : (25000 + index * 1250) / 100, plan_code: SAMPLE_COMMUNITY_SPEC.plans[index % 3].code, effective_start: new Date().toISOString().slice(0, 10) }))
  await importCsv({ orgId, importer: "price_book", name: "sample-price-book.csv", headers: Object.keys(priceRows[0]), rows: priceRows, context: { is_sample: true } })

  const lotRows = SAMPLE_COMMUNITY_SPEC.statuses.map((status, index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, community_code: SAMPLE_COMMUNITY_SPEC.code, phase: index < 10 ? "Phase 1" : "Phase 2", lot_number: String(index + 1), status, address: `${4100 + index} Cypress Landing Way`, city: SAMPLE_COMMUNITY_SPEC.location.city, state: SAMPLE_COMMUNITY_SPEC.location.state, postal_code: SAMPLE_COMMUNITY_SPEC.location.postalCode, width_ft: 52 + index % 4, depth_ft: 115, swing: index % 2 ? "left" : "right", premium_cents: index % 5 === 0 ? 15000 : 0, cost_basis_cents: (7200000 + index * 50000) / 100, takedown: index < 10 ? "Phase 1 close" : "Phase 2 close", takedown_date: new Date().toISOString().slice(0, 10), plan_code: SAMPLE_COMMUNITY_SPEC.plans[index % 3].code, elevation_code: index % 2 ? "A" : "B" }))
  await importCsv({ orgId, importer: "communities_lots", name: "sample-lots.csv", headers: Object.keys(lotRows[0]), rows: lotRows, context: { is_sample: true } })
  const { data: community, error: communityError } = await supabase.from("communities").select("id,metadata").eq("org_id", orgId).eq("name", SAMPLE_COMMUNITY_SPEC.name).single()
  if (communityError || !community) throw new Error(`Failed to load sample community: ${communityError?.message}`)
  const { data: building, error: buildingError } = await supabase.from("communities").update({ metadata: { ...(community.metadata ?? {}), is_sample: true, sample_seed_status: "building" } }).eq("org_id", orgId).eq("id", community.id).eq("metadata", JSON.stringify(community.metadata ?? {})).select("id").maybeSingle()
  if (buildingError || !building) throw new Error("Sample community changed before house import; inspect original import evidence")

  const asOfDate = new Date().toISOString().slice(0, 10)
  const houseLots = [12, 13, 14, 15, 16, 17]
  const budgets = houseLots.flatMap((lotNumber) => costCodes.slice(0, 5).map((costCode, index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), cost_code: costCode.code, budget_cents: (5000000 + index * 1000000) / 100 })))
  const purchaseOrders = houseLots.flatMap((lotNumber) => [0, 1].map((index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), po_number: `CYP-${lotNumber}-${index + 1}`, vendor: `Cypress Sample Trade ${index + 1}`, cost_code: costCodes[index].code, description: index ? "Open finish allowance" : "Open framing balance", remaining_cents: (1250000 + index * 500000) / 100, original_cents: (2500000 + index * 500000) / 100 })))
  const houses = houseLots.map((lotNumber, index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), plan_code: SAMPLE_COMMUNITY_SPEC.plans[index % 3].code, elevation_code: index % 2 ? "A" : "B", stage_task: ["Foundation", "Framing", "Dry-in", "MEP rough", "Drywall", "Interior finishes"][index], stage_date: asOfDate, budget_total_cents: 350000, sold: index >= 4, buyer_name: index >= 4 ? `Sample Buyer ${index - 3}` : "", buyer_email: index >= 4 ? `sample-buyer-${index - 3}@example.invalid` : "", sale_price_cents: index >= 4 ? (52500000 + index * 1000000) / 100 : "", sale_date: index >= 4 ? asOfDate : "" }))
  const budgetBatch = await importCsv({ orgId, importer: "open_wip", name: "sample-wip-budgets.csv", headers: Object.keys(budgets[0]), rows: budgets, context: { file_kind: "budgets", as_of_date: asOfDate, is_sample: true } })
  const poBatch = await importCsv({ orgId, importer: "open_wip", name: "sample-wip-pos.csv", headers: Object.keys(purchaseOrders[0]), rows: purchaseOrders, context: { file_kind: "purchase_orders", as_of_date: asOfDate, is_sample: true } })
  const houseBatch = await importCsv({ orgId, importer: "open_wip", name: "sample-wip-houses.csv", headers: Object.keys(houses[0]), rows: houses, context: { file_kind: "houses", as_of_date: asOfDate, is_sample: true, companion_batch_ids: { budgets: budgetBatch.id, purchase_orders: poBatch.id } } })
  await tagSampleImportedHomes({ orgId, communityId: community.id, batchId: houseBatch.id, actorUserId })
  const { data: seeded, error: seededError } = await supabase.from("communities").update({ metadata: {
    ...(community.metadata ?? {}), is_sample: true, sample_seed_status: "seeded", sample_home_batch_id: houseBatch.id,
  } }).eq("org_id", orgId).eq("id", community.id)
    .eq("metadata", JSON.stringify({ ...(community.metadata ?? {}), is_sample: true, sample_seed_status: "building" }))
    .select("id").maybeSingle()
  if (seededError || !seeded) throw new Error("Sample completion changed; inspect original import evidence before retrying")

  await Promise.all([
    recordEvent({ orgId, actorId: actorUserId, eventType: "sample_community_seeded", entityType: "community", entityId: community.id, payload: { lot_count: 20, plan_count: 3 } }),
    recordAudit({ orgId, actorId: actorUserId, action: "insert", entityType: "community", entityId: community.id, after: { is_sample: true, lot_count: 20, plan_count: 3 } }),
  ])
  return { communityId: community.id }
}

export async function deleteSampleCommunity(orgId: string, communityId: string, actorUserId: string) {
  const actor = await requireAnyPlatformPermission(["platform.support.write"])
  if (actor.id !== actorUserId) throw new Error("Platform actor mismatch")
  // Names and mutable sample markers cannot prove ownership. Do not run any
  // delete until original-run ownership and a transactional reset are available.
  if (!orgId || !communityId) throw new Error("Sample reset scope is required")
  throw new Error("Sample reset is unavailable until original ownership can be verified. Existing data has been preserved.")
}
