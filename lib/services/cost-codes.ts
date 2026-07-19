import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { COST_TYPES } from "@/lib/cost-types"
import {
  CSI_MASTERFORMAT_DIVISIONS,
  CSI_MASTERFORMAT_ROW_COUNT,
} from "@/lib/data/csi-masterformat"
import { NAHB_COST_CODE_GROUPS, NAHB_COST_CODE_ROW_COUNT } from "@/lib/data/nahb-cost-codes"

const costCodeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  parent_id: z.string().uuid().optional(),
  division: z.string().optional(),
  category: z.string().optional(),
  standard: z.enum(["nahb", "csi", "custom"]).default("custom"),
  unit: z.string().optional(),
  default_unit_cost_cents: z.number().int().min(0).optional(),
  is_reimbursable_default: z.boolean().optional(),
  default_markup_percent: z.number().min(0).max(200).nullable().optional(),
  cost_type: z.enum(COST_TYPES).nullable().optional(),
})

const updateCostCodeSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  parent_id: z.string().uuid().nullable().optional(),
  division: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  standard: z.enum(["nahb", "csi", "custom"]).optional(),
  unit: z.string().nullable().optional(),
  default_unit_cost_cents: z.number().int().min(0).nullable().optional(),
  is_reimbursable_default: z.boolean().optional(),
  default_markup_percent: z.number().min(0).max(200).nullable().optional(),
  is_active: z.boolean().optional(),
  cost_type: z.enum(COST_TYPES).nullable().optional(),
})

async function assertParentCodeInOrg(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  parentId: string,
  orgId: string,
) {
  const { data, error } = await supabase
    .from("cost_codes")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", parentId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Parent cost code must belong to this organization")
  }
}

async function assertNoParentCycle(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  codeId: string,
  parentId: string,
) {
  const { data, error } = await supabase.from("cost_codes").select("id,parent_id").eq("org_id", orgId)
  if (error) {
    throw new Error("Unable to validate cost code hierarchy")
  }

  const parentMap = new Map<string, string | null>()
  for (const row of data ?? []) {
    parentMap.set(String(row.id), row.parent_id ? String(row.parent_id) : null)
  }

  let current: string | null = parentId
  while (current) {
    if (current === codeId) {
      throw new Error("This parent selection would create a circular hierarchy")
    }
    current = parentMap.get(current) ?? null
  }
}

export async function createCostCode(input: z.infer<typeof costCodeSchema>, orgId?: string) {
  const parsed = costCodeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  if (parsed.parent_id) {
    await assertParentCodeInOrg(supabase, parsed.parent_id, resolvedOrgId)
  }

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

export async function updateCostCode(input: z.infer<typeof updateCostCodeSchema>, orgId?: string) {
  const parsed = updateCostCodeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  if (parsed.parent_id && parsed.parent_id === parsed.id) {
    throw new Error("A cost code cannot be its own parent")
  }
  if (parsed.parent_id) {
    await assertParentCodeInOrg(supabase, parsed.parent_id, resolvedOrgId)
    await assertNoParentCycle(supabase, resolvedOrgId, parsed.id, parsed.parent_id)
  }

  const { data: before, error: beforeError } = await supabase
    .from("cost_codes")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.id)
    .maybeSingle()

  if (beforeError || !before) {
    throw new Error("Cost code not found")
  }

  const { id, ...changes } = parsed
  if (Object.keys(changes).length === 0) {
    return before
  }

  const { data, error } = await supabase
    .from("cost_codes")
    .update(changes)
    .eq("org_id", resolvedOrgId)
    .eq("id", id)
    .select("*")
    .single()

  if (error) {
    throw new Error(`Failed to update cost code: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    action: "update",
    entityType: "cost_code",
    entityId: data.id,
    before,
    after: data,
  })

  return data
}

export async function setCostCodeActive(id: string, isActive: boolean, orgId?: string) {
  return updateCostCode({ id, is_active: isActive }, orgId)
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
  const groupRows = NAHB_COST_CODE_GROUPS.map((group) => ({
    org_id: resolvedOrgId,
    code: group.group,
    name: group.name,
    division: group.group.slice(0, 1),
    category: "nahb-group",
    standard: "nahb" as const,
    cost_type: group.costType,
    is_active: true,
  }))

  const { error: groupError } = await supabase.from("cost_codes").upsert(groupRows, {
    onConflict: "org_id,code",
    ignoreDuplicates: true,
  })

  if (groupError) {
    throw new Error(`Failed to seed NAHB groups: ${groupError.message}`)
  }

  const { data: storedGroups, error: storedGroupsError } = await supabase
    .from("cost_codes")
    .select("id, code")
    .eq("org_id", resolvedOrgId)
    .in("code", groupRows.map((row) => row.code))

  if (storedGroupsError) {
    throw new Error(`Failed to load NAHB groups: ${storedGroupsError.message}`)
  }

  const groupIds = new Map((storedGroups ?? []).map((row) => [String(row.code), String(row.id)]))
  const missingGroup = NAHB_COST_CODE_GROUPS.find((group) => !groupIds.has(group.group))
  if (missingGroup) {
    throw new Error(`NAHB group ${missingGroup.group} conflicts with an existing cost code`)
  }

  const codeRows = NAHB_COST_CODE_GROUPS.flatMap((group) =>
    group.codes.map(([code, name, unit]) => ({
      org_id: resolvedOrgId,
      parent_id: groupIds.get(group.group),
      code,
      name,
      division: group.group.slice(0, 1),
      category: "nahb-code",
      standard: "nahb" as const,
      cost_type: group.costType,
      unit: unit ?? null,
      is_active: true,
    })),
  )

  const { error: codeError } = await supabase.from("cost_codes").upsert(codeRows, {
    onConflict: "org_id,code",
    ignoreDuplicates: true,
  })
  if (codeError) {
    throw new Error(`Failed to seed NAHB codes: ${codeError.message}`)
  }

  return { inserted: NAHB_COST_CODE_ROW_COUNT }
}

export async function seedCSICostCodes(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const divisionRows = CSI_MASTERFORMAT_DIVISIONS.map((division) => ({
    org_id: resolvedOrgId,
    code: `${division.division} 00 00`,
    name: division.name,
    division: division.division,
    category: "csi-division",
    standard: "csi" as const,
    cost_type: division.costType,
    is_active: true,
  }))

  const { error: divisionError } = await supabase.from("cost_codes").upsert(divisionRows, {
    onConflict: "org_id,code",
    ignoreDuplicates: true,
  })

  if (divisionError) {
    throw new Error(`Failed to seed CSI divisions: ${divisionError.message}`)
  }

  const { data: storedDivisions, error: storedDivisionsError } = await supabase
    .from("cost_codes")
    .select("id, code")
    .eq("org_id", resolvedOrgId)
    .eq("standard", "csi")
    .in("code", divisionRows.map((row) => row.code))

  if (storedDivisionsError) {
    throw new Error(`Failed to load CSI divisions: ${storedDivisionsError.message}`)
  }

  const divisionIds = new Map(
    (storedDivisions ?? []).map((row) => [String(row.code).slice(0, 2), String(row.id)]),
  )
  const missingDivision = CSI_MASTERFORMAT_DIVISIONS.find(
    (division) => !divisionIds.has(division.division),
  )
  if (missingDivision) {
    throw new Error(`CSI division ${missingDivision.division} conflicts with an existing cost code`)
  }

  const sectionRows = CSI_MASTERFORMAT_DIVISIONS.flatMap((division) =>
    division.sections.map(([code, name]) => ({
      org_id: resolvedOrgId,
      parent_id: divisionIds.get(division.division),
      code,
      name,
      division: division.division,
      category: "csi-section",
      standard: "csi" as const,
      cost_type: division.costType,
      is_active: true,
    })),
  )

  const { error: sectionError } = await supabase.from("cost_codes").upsert(sectionRows, {
    onConflict: "org_id,code",
    ignoreDuplicates: true,
  })

  if (sectionError) {
    throw new Error(`Failed to seed CSI sections: ${sectionError.message}`)
  }

  return { inserted: CSI_MASTERFORMAT_ROW_COUNT }
}

