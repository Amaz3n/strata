import "server-only"

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

export async function seedSampleCommunity(orgId: string, actorUserId: string): Promise<{ communityId: string }> {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("communities").select("id").eq("org_id", orgId).contains("metadata", { is_sample: true }).maybeSingle()
  if (existing) return { communityId: existing.id }

  const planRows = SAMPLE_COMMUNITY_SPEC.plans.flatMap((plan) => ["A", "B"].map((elevation, index) => ({ plan_code: plan.code, plan_name: plan.name, series: "Cypress Landing Sample", heated_sqft: plan.heatedSqft, total_sqft: plan.heatedSqft + 320, beds: plan.beds, baths: plan.baths, stories: plan.heatedSqft > 2000 ? 2 : 1, garage_bays: 2, elevation_code: elevation, elevation_name: index ? "Coastal" : "Craftsman", elevation_sqft_delta: index * 40, swing_applicable: true })))
  await importCsv({ orgId, importer: "plan_library", name: "sample-plans.csv", headers: Object.keys(planRows[0]), rows: planRows, context: { file_kind: "plans", is_sample: true } })

  const { data: costCodes } = await supabase.from("cost_codes").select("code").eq("org_id", orgId).eq("is_active", true).order("code").limit(25)
  if (!costCodes || costCodes.length < 5) throw new Error("Seed cost codes before the sample community")
  const takeoffRows = SAMPLE_COMMUNITY_SPEC.plans.flatMap((plan) => costCodes.map((costCode, index) => ({ plan_code: plan.code, elevation_code: "", cost_code: costCode.code, description: `Sample scope ${index + 1}`, quantity: index % 4 === 0 ? plan.heatedSqft : 1, uom: index % 4 === 0 ? "sf" : "ls", unit_cost_cents: index % 4 === 0 ? 1.25 : (3500 + index * 275) / 100 })))
  await importCsv({ orgId, importer: "plan_library", name: "sample-takeoffs.csv", headers: Object.keys(takeoffRows[0]), rows: takeoffRows, context: { file_kind: "takeoffs", is_sample: true } })

  const scheduleItems = [
    { name: "Permit release", offset_days: -35, duration_days: 1 }, { name: "Foundation", offset_days: 0, duration_days: 14 },
    { name: "Framing", offset_days: 14, duration_days: 21 }, { name: "Dry-in", offset_days: 35, duration_days: 10 },
    { name: "MEP rough", offset_days: 45, duration_days: 18 }, { name: "Drywall", offset_days: 63, duration_days: 14 },
    { name: "Interior finishes", offset_days: 77, duration_days: 28 }, { name: "Punch and close", offset_days: 105, duration_days: 14 },
  ]
  const { data: schedule, error: scheduleError } = await supabase.from("schedule_templates").insert({ org_id: orgId, name: "Cypress Landing 120-day build", property_type: "production", items: scheduleItems, created_by: actorUserId }).select("id").single()
  if (scheduleError || !schedule) throw new Error(`Failed to create sample schedule: ${scheduleError?.message}`)
  const { data: plans } = await supabase.from("house_plans").select("id,code,metadata,versions:house_plan_versions(id,status)").eq("org_id", orgId).eq("series", "Cypress Landing Sample")
  for (const plan of plans ?? []) {
    const draft = Array.isArray(plan.versions) ? plan.versions.find((version) => version.status === "draft") : null
    if (!draft) continue
    const { error: configureError } = await supabase.from("house_plan_versions").update({ schedule_template_id: schedule.id, metadata: { is_sample: true } }).eq("org_id", orgId).eq("id", draft.id)
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
  await supabase.from("communities").update({ metadata: { ...(community.metadata ?? {}), is_sample: true } }).eq("org_id", orgId).eq("id", community.id)

  const asOfDate = new Date().toISOString().slice(0, 10)
  const houseLots = [12, 13, 14, 15, 16, 17]
  const budgets = houseLots.flatMap((lotNumber) => costCodes.slice(0, 5).map((costCode, index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), cost_code: costCode.code, budget_cents: (5000000 + index * 1000000) / 100 })))
  const purchaseOrders = houseLots.flatMap((lotNumber) => [0, 1].map((index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), po_number: `CYP-${lotNumber}-${index + 1}`, vendor: `Cypress Sample Trade ${index + 1}`, cost_code: costCodes[index].code, description: index ? "Open finish allowance" : "Open framing balance", remaining_cents: (1250000 + index * 500000) / 100, original_cents: (2500000 + index * 500000) / 100 })))
  const houses = houseLots.map((lotNumber, index) => ({ community: SAMPLE_COMMUNITY_SPEC.name, lot_number: String(lotNumber), plan_code: SAMPLE_COMMUNITY_SPEC.plans[index % 3].code, elevation_code: index % 2 ? "A" : "B", stage_task: ["Foundation", "Framing", "Dry-in", "MEP rough", "Drywall", "Interior finishes"][index], stage_date: asOfDate, budget_total_cents: 350000, sold: index >= 4, buyer_name: index >= 4 ? `Sample Buyer ${index - 3}` : "", buyer_email: index >= 4 ? `sample-buyer-${index - 3}@example.invalid` : "", sale_price_cents: index >= 4 ? (52500000 + index * 1000000) / 100 : "", sale_date: index >= 4 ? asOfDate : "" }))
  await importCsv({ orgId, importer: "open_wip", name: "sample-wip-budgets.csv", headers: Object.keys(budgets[0]), rows: budgets, context: { file_kind: "budgets", as_of_date: asOfDate, is_sample: true } })
  await importCsv({ orgId, importer: "open_wip", name: "sample-wip-pos.csv", headers: Object.keys(purchaseOrders[0]), rows: purchaseOrders, context: { file_kind: "purchase_orders", as_of_date: asOfDate, is_sample: true } })
  await importCsv({ orgId, importer: "open_wip", name: "sample-wip-houses.csv", headers: Object.keys(houses[0]), rows: houses, context: { file_kind: "houses", as_of_date: asOfDate, is_sample: true } })
  await supabase.from("projects").update({ metadata: { is_sample: true, sample_community_id: community.id } }).eq("org_id", orgId).contains("metadata", { imported_open_wip: true })

  await Promise.all([
    recordEvent({ orgId, actorId: actorUserId, eventType: "sample_community_seeded", entityType: "community", entityId: community.id, payload: { lot_count: 20, plan_count: 3 } }),
    recordAudit({ orgId, actorId: actorUserId, action: "insert", entityType: "community", entityId: community.id, after: { is_sample: true, lot_count: 20, plan_count: 3 } }),
  ])
  return { communityId: community.id }
}

export async function deleteSampleCommunity(orgId: string, communityId: string, actorUserId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: community } = await supabase.from("communities").select("id,metadata").eq("org_id", orgId).eq("id", communityId).maybeSingle()
  if (!community || community.metadata?.is_sample !== true) throw new Error("Only a marked sample community can be removed")
  const { data: projects } = await supabase.from("projects").select("id").eq("org_id", orgId).contains("metadata", { sample_community_id: communityId })
  if (projects?.length) await supabase.from("projects").delete().eq("org_id", orgId).in("id", projects.map((project) => project.id))
  await supabase.from("communities").delete().eq("org_id", orgId).eq("id", communityId)
  const { data: sampleOptions } = await supabase.from("selection_options").select("id,category_id").eq("org_id", orgId).ilike("sku", "CYP-OPT-%")
  if (sampleOptions?.length) await supabase.from("selection_options").delete().eq("org_id", orgId).in("id", sampleOptions.map((option) => option.id))
  const categoryIds = [...new Set((sampleOptions ?? []).map((option) => option.category_id))]
  if (categoryIds.length) await supabase.from("selection_categories").delete().eq("org_id", orgId).in("id", categoryIds)
  const { data: sampleCompanies } = await supabase.from("companies").select("id").eq("org_id", orgId).ilike("name", "Cypress Sample Trade %")
  if (sampleCompanies?.length) {
    const companyIds = sampleCompanies.map((company) => company.id)
    await supabase.from("vendor_price_agreements").delete().eq("org_id", orgId).in("company_id", companyIds)
    await supabase.from("companies").delete().eq("org_id", orgId).in("id", companyIds)
  }
  const { data: samplePlans } = await supabase.from("house_plans").select("id").eq("org_id", orgId).contains("metadata", { is_sample: true })
  if (samplePlans?.length) await supabase.from("house_plans").delete().eq("org_id", orgId).in("id", samplePlans.map((plan) => plan.id))
  await supabase.from("schedule_templates").delete().eq("org_id", orgId).eq("name", "Cypress Landing 120-day build")
  await supabase.from("contacts").delete().eq("org_id", orgId).ilike("email", "sample-buyer-%@example.invalid")
  const { data: sampleBatches } = await supabase.from("import_batches").select("id").eq("org_id", orgId).contains("context", { is_sample: true })
  if (sampleBatches?.length) await supabase.from("import_batches").delete().eq("org_id", orgId).in("id", sampleBatches.map((batch) => batch.id))
  await recordAudit({ orgId, actorId: actorUserId, action: "delete", entityType: "community", entityId: communityId, before: { is_sample: true } })
}
