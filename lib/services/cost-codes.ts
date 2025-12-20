import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

const costCodeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  parent_id: z.string().uuid().optional(),
  division: z.string().optional(),
  category: z.string().optional(),
  standard: z.enum(["nahb", "csi", "custom"]).default("custom"),
  unit: z.string().optional(),
  default_unit_cost_cents: z.number().int().min(0).optional(),
})

export async function createCostCode(input: z.infer<typeof costCodeSchema>, orgId?: string) {
  const parsed = costCodeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("cost_codes")
    .insert({ org_id: resolvedOrgId, ...parsed })
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to create cost code: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: "insert",
    entityType: "cost_code",
    entityId: data.id,
    after: data,
  })

  return data
}

export async function listCostCodes(orgId?: string, includeInactive = false) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase.from("cost_codes").select("*").eq("org_id", resolvedOrgId).order("code")

  if (!includeInactive) {
    query = query.eq("is_active", true)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list cost codes: ${error.message}`)
  }

  return data ?? []
}

export async function seedNAHBCostCodes(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const nahbCodes = [
    { division: "01", code: "01-000", name: "General Requirements", category: "general" },
    { division: "01", code: "01-100", name: "Permits & Fees", category: "general" },
    { division: "01", code: "01-200", name: "Insurance", category: "general" },
    { division: "02", code: "02-000", name: "Site Work", category: "sitework" },
    { division: "02", code: "02-100", name: "Clearing & Grading", category: "sitework" },
    { division: "02", code: "02-200", name: "Excavation", category: "sitework" },
    { division: "02", code: "02-300", name: "Fill & Backfill", category: "sitework" },
    { division: "03", code: "03-000", name: "Concrete", category: "concrete" },
    { division: "03", code: "03-100", name: "Footings", category: "concrete" },
    { division: "03", code: "03-200", name: "Foundation Walls", category: "concrete" },
    { division: "03", code: "03-300", name: "Slabs", category: "concrete" },
    { division: "03", code: "03-400", name: "Flatwork", category: "concrete" },
    { division: "04", code: "04-000", name: "Masonry", category: "masonry" },
    { division: "05", code: "05-000", name: "Metals/Steel", category: "metals" },
    { division: "06", code: "06-000", name: "Wood & Plastics", category: "framing" },
    { division: "06", code: "06-100", name: "Rough Framing - Labor", category: "framing" },
    { division: "06", code: "06-200", name: "Rough Framing - Material", category: "framing" },
    { division: "06", code: "06-300", name: "Finish Carpentry", category: "framing" },
    { division: "07", code: "07-000", name: "Thermal & Moisture", category: "envelope" },
    { division: "07", code: "07-100", name: "Insulation", category: "envelope" },
    { division: "07", code: "07-200", name: "Roofing", category: "envelope" },
    { division: "07", code: "07-300", name: "Siding", category: "envelope" },
    { division: "08", code: "08-000", name: "Doors & Windows", category: "openings" },
    { division: "09", code: "09-000", name: "Finishes", category: "finishes" },
    { division: "09", code: "09-100", name: "Drywall", category: "finishes" },
    { division: "09", code: "09-200", name: "Paint", category: "finishes" },
    { division: "09", code: "09-300", name: "Flooring", category: "finishes" },
    { division: "09", code: "09-400", name: "Tile", category: "finishes" },
    { division: "10", code: "10-000", name: "Specialties", category: "specialties" },
    { division: "11", code: "11-000", name: "Equipment", category: "equipment" },
    { division: "11", code: "11-100", name: "Appliances", category: "equipment" },
    { division: "12", code: "12-000", name: "Furnishings", category: "furnishings" },
    { division: "12", code: "12-100", name: "Cabinets", category: "furnishings" },
    { division: "12", code: "12-200", name: "Countertops", category: "furnishings" },
    { division: "15", code: "15-000", name: "Mechanical", category: "mechanical" },
    { division: "15", code: "15-100", name: "Plumbing - Rough", category: "mechanical" },
    { division: "15", code: "15-200", name: "Plumbing - Finish", category: "mechanical" },
    { division: "15", code: "15-300", name: "HVAC", category: "mechanical" },
    { division: "16", code: "16-000", name: "Electrical", category: "electrical" },
    { division: "16", code: "16-100", name: "Electrical - Rough", category: "electrical" },
    { division: "16", code: "16-200", name: "Electrical - Finish", category: "electrical" },
    { division: "16", code: "16-300", name: "Low Voltage", category: "electrical" },
  ]

  const toInsert = nahbCodes.map((c) => ({
    org_id: resolvedOrgId,
    ...c,
    standard: "nahb" as const,
    is_active: true,
  }))

  const { error } = await supabase.from("cost_codes").upsert(toInsert, {
    onConflict: "org_id,code",
    ignoreDuplicates: true,
  })

  if (error) {
    throw new Error(`Failed to seed NAHB codes: ${error.message}`)
  }

  return { inserted: toInsert.length }
}

export async function importCostCodes(
  rows: Array<{ code: string; name: string; division?: string; category?: string }>,
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const toInsert = rows.map((row) => ({
    org_id: resolvedOrgId,
    code: row.code,
    name: row.name,
    division: row.division,
    category: row.category,
    standard: "custom" as const,
    is_active: true,
  }))

  const { data, error } = await supabase
    .from("cost_codes")
    .upsert(toInsert, { onConflict: "org_id,code" })
    .select("id")

  if (error) {
    throw new Error(`Failed to import cost codes: ${error.message}`)
  }

  return { imported: data?.length ?? 0 }
}


