import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"

/**
 * Saved estimate templates — a reusable set of sections + line items a builder
 * can seed a new estimate from. Brand/boilerplate (terms, intro, accent) live in
 * org settings; templates intentionally only carry the line structure so they stay
 * compatible with {@link createEstimateFromTemplate}.
 */

const templateLineSchema = z.object({
  item_type: z.enum(["line", "group"]).default("line"),
  description: z.string().trim().min(1, "Description is required"),
  quantity: z.number().min(0).default(1),
  unit_cost_cents: z.number().int().min(0).default(0),
  cost_code_id: z.string().uuid().nullable().optional(),
  is_optional: z.boolean().optional(),
})

export const estimateTemplateInputSchema = z.object({
  name: z.string().trim().min(1, "Template name is required").max(120),
  description: z.string().trim().max(500).optional().nullable(),
  lines: z.array(templateLineSchema).min(1, "Add at least one line"),
})

export type EstimateTemplateInput = z.infer<typeof estimateTemplateInputSchema>

export type EstimateTemplateLine = z.infer<typeof templateLineSchema>

export type EstimateTemplateDto = {
  id: string
  name: string
  description: string | null
  lines: EstimateTemplateLine[]
  created_at: string | null
  updated_at: string | null
}

function mapTemplate(row: any): EstimateTemplateDto {
  const rawLines = Array.isArray(row.lines) ? row.lines : []
  const lines: EstimateTemplateLine[] = rawLines.map((line: any) => ({
    item_type: line.item_type === "group" ? "group" : "line",
    description: typeof line.description === "string" ? line.description : "",
    quantity: typeof line.quantity === "number" ? line.quantity : 1,
    unit_cost_cents: typeof line.unit_cost_cents === "number" ? line.unit_cost_cents : 0,
    cost_code_id: typeof line.cost_code_id === "string" ? line.cost_code_id : null,
    is_optional: line.is_optional === true,
  }))
  return {
    id: row.id,
    name: row.name ?? "",
    description: row.description ?? null,
    lines,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

export async function listEstimateTemplates(orgId?: string): Promise<EstimateTemplateDto[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("estimate_templates")
    .select("id, name, description, lines, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .order("name", { ascending: true })

  if (error) {
    console.error("Failed to list estimate templates", error.message)
    return []
  }
  return (data ?? []).map(mapTemplate)
}

function toLinesPayload(lines: EstimateTemplateLine[]) {
  return lines.map((line, idx) => ({
    item_type: line.item_type ?? "line",
    description: line.description.trim(),
    quantity: line.quantity ?? 1,
    unit_cost_cents: line.unit_cost_cents ?? 0,
    cost_code_id: line.cost_code_id ?? null,
    is_optional: line.is_optional ?? false,
    markup_pct: 0,
    sort_order: idx,
  }))
}

export async function createEstimateTemplate(input: EstimateTemplateInput, orgId?: string): Promise<EstimateTemplateDto> {
  const parsed = estimateTemplateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("estimate_templates")
    .insert({
      org_id: resolvedOrgId,
      name: parsed.name,
      description: parsed.description ?? null,
      lines: toLinesPayload(parsed.lines),
    })
    .select("id, name, description, lines, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create template: ${error?.message ?? "unknown error"}`)
  }
  return mapTemplate(data)
}

export async function updateEstimateTemplate(
  id: string,
  input: EstimateTemplateInput,
  orgId?: string,
): Promise<EstimateTemplateDto> {
  const parsed = estimateTemplateInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("estimate_templates")
    .update({
      name: parsed.name,
      description: parsed.description ?? null,
      lines: toLinesPayload(parsed.lines),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", resolvedOrgId)
    .select("id, name, description, lines, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to update template: ${error?.message ?? "not found"}`)
  }
  return mapTemplate(data)
}

export async function deleteEstimateTemplate(id: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { error } = await supabase.from("estimate_templates").delete().eq("id", id).eq("org_id", resolvedOrgId)
  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`)
  }
}
