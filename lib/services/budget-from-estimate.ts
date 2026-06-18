import "server-only"

import { generateText } from "ai"

import { getOrgAiSearchConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { requireOrgContext } from "@/lib/services/context"

/** Lightweight summary of an estimate that can seed a budget. */
export type BudgetEstimateSource = {
  id: string
  label: string
  status: string
  total_cents: number
  line_count: number
  updated_at: string | null
}

/** A single proposed budget line awaiting the user's review. */
export type ProposedBudgetLine = {
  cost_code_id: string | null
  cost_code_label: string | null
  description: string
  amount_cents: number
  source_item_count: number
}

export type BudgetDraftFromEstimate = {
  estimate_id: string
  estimate_label: string
  lines: ProposedBudgetLine[]
  used_ai: boolean
}

type EstimateItemRow = {
  cost_code_id: string | null
  item_type: string | null
  description: string | null
  quantity: number | null
  unit_cost_cents: number | null
  metadata: Record<string, unknown> | null
}

function estimateLabel(row: { title?: string | null; version?: number | null }): string {
  const title = row.title?.trim()
  if (title) return title
  return row.version ? `Estimate v${row.version}` : "Estimate"
}

/** Lists the project's estimates that have at least one cost line, newest first. */
export async function listBudgetEstimateSources(
  projectId: string,
  orgId?: string,
): Promise<BudgetEstimateSource[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("estimates")
    .select("id, title, status, version, total_cents, updated_at, items:estimate_items(id, item_type)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })

  if (error) {
    throw new Error(`Failed to load estimates: ${error.message}`)
  }

  return (data ?? [])
    .map((row: any) => {
      const lineCount = (row.items ?? []).filter(
        (item: { item_type: string | null }) => (item.item_type ?? "line") !== "group",
      ).length
      return {
        id: row.id as string,
        label: estimateLabel(row),
        status: (row.status as string) ?? "draft",
        total_cents: (row.total_cents as number) ?? 0,
        line_count: lineCount,
        updated_at: (row.updated_at as string) ?? null,
      }
    })
    .filter((source) => source.line_count > 0)
}

/**
 * Builds a reviewable budget draft from an estimate. Amounts use the estimate's
 * cost basis (qty × unit cost, excluding markup, optional add-ons, and group
 * headers) so the budget reflects expected spend, not the marked-up sell price.
 * Cost codes are carried over deterministically. An optional AI pass tidies the
 * scope note for each line; it never changes amounts or cost codes, and falls
 * back to a deterministic note when AI is unavailable.
 */
export async function buildBudgetDraftFromEstimate({
  projectId,
  estimateId,
  costCodesEnabled,
  orgId,
}: {
  projectId: string
  estimateId: string
  costCodesEnabled: boolean
  orgId?: string
}): Promise<BudgetDraftFromEstimate> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: estimate, error } = await supabase
    .from("estimates")
    .select(
      "id, title, version, project_id, items:estimate_items(cost_code_id, item_type, description, quantity, unit_cost_cents, metadata)",
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("id", estimateId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load estimate: ${error.message}`)
  if (!estimate) throw new Error("Estimate not found for this project")

  // Cost codes referenced by the estimate, for human-friendly labels.
  const costCodeLabels = new Map<string, string>()
  const referencedCodeIds = Array.from(
    new Set(
      ((estimate.items as EstimateItemRow[]) ?? [])
        .map((item) => item.cost_code_id)
        .filter((id): id is string => Boolean(id)),
    ),
  )
  if (referencedCodeIds.length > 0) {
    const { data: codes } = await supabase
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", resolvedOrgId)
      .in("id", referencedCodeIds)
    for (const code of codes ?? []) {
      const label = [code.code, code.name].filter(Boolean).join(" — ")
      costCodeLabels.set(code.id as string, label || (code.name as string) || "Cost code")
    }
  }

  // Keep only real cost lines: drop group headers and optional add-ons.
  const costItems = ((estimate.items as EstimateItemRow[]) ?? []).filter((item) => {
    if ((item.item_type ?? "line") === "group") return false
    if (item.metadata && (item.metadata as Record<string, unknown>).is_optional) return false
    const amount = (item.unit_cost_cents ?? 0) * (item.quantity ?? 1)
    return amount > 0
  })

  // Group by cost code when codes are enabled; otherwise every line stands alone.
  type Group = { costCodeId: string | null; descriptions: string[]; amountCents: number }
  const groups = new Map<string, Group>()
  costItems.forEach((item, index) => {
    const key = costCodesEnabled ? item.cost_code_id ?? "__uncoded__" : `line-${index}`
    const amount = (item.unit_cost_cents ?? 0) * (item.quantity ?? 1)
    const existing = groups.get(key) ?? {
      costCodeId: costCodesEnabled ? item.cost_code_id ?? null : null,
      descriptions: [],
      amountCents: 0,
    }
    if (item.description?.trim()) existing.descriptions.push(item.description.trim())
    existing.amountCents += amount
    groups.set(key, existing)
  })

  let lines: ProposedBudgetLine[] = Array.from(groups.values()).map((group) => ({
    cost_code_id: group.costCodeId,
    cost_code_label: group.costCodeId ? costCodeLabels.get(group.costCodeId) ?? null : null,
    description: deterministicScopeNote(group.descriptions),
    amount_cents: group.amountCents,
    source_item_count: group.descriptions.length || 1,
  }))

  // Best-effort AI tidy-up of the scope notes (never touches amounts/codes).
  let usedAi = false
  try {
    const improved = await improveScopeNotesWithAi({
      supabase,
      orgId: resolvedOrgId,
      lines,
    })
    if (improved) {
      lines = lines.map((line, index) => ({
        ...line,
        description: improved[index]?.trim() || line.description,
      }))
      usedAi = true
    }
  } catch (aiError) {
    console.error("Budget-from-estimate AI tidy-up failed", aiError)
  }

  return {
    estimate_id: estimate.id as string,
    estimate_label: estimateLabel(estimate),
    lines,
    used_ai: usedAi,
  }
}

function deterministicScopeNote(descriptions: string[]): string {
  if (descriptions.length === 0) return "Budget line"
  if (descriptions.length === 1) return descriptions[0]
  const head = descriptions.slice(0, 3).join(", ")
  const extra = descriptions.length - 3
  return extra > 0 ? `${head} +${extra} more` : head
}

async function improveScopeNotesWithAi({
  supabase,
  orgId,
  lines,
}: {
  supabase: Parameters<typeof getOrgAiSearchConfig>[0]["supabase"]
  orgId: string
  lines: ProposedBudgetLine[]
}): Promise<string[] | null> {
  if (lines.length === 0) return null

  const config = await getOrgAiSearchConfig({ supabase, orgId })
  const apiKey = getApiKeyForProvider(config.provider)
  if (!apiKey) return null

  const model = resolveLanguageModel(config.provider, apiKey, config.model)
  const payload = lines.map((line, index) => ({
    index,
    code: line.cost_code_label ?? null,
    scope: line.description,
  }))

  const result = await generateText({
    model,
    system:
      "You write short, clear construction budget scope notes for builders. " +
      "Given draft scope notes, return a concise (max ~8 words) plain-language note for each. " +
      "Keep the trade/scope meaning. Do not invent work. Respond with strict JSON only: " +
      '{"notes":[{"index":number,"note":string}]}.',
    prompt: `Draft budget lines:\n${JSON.stringify(payload)}`,
    temperature: 0.2,
    maxOutputTokens: 600,
    timeout: 12_000,
  })

  const parsed = parseNotes(result.text, lines.length)
  return parsed
}

function parseNotes(raw: string, expectedLength: number): string[] | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const json = JSON.parse(raw.slice(start, end + 1)) as {
      notes?: Array<{ index?: number; note?: string }>
    }
    if (!Array.isArray(json.notes)) return null
    const out = new Array<string>(expectedLength).fill("")
    for (const entry of json.notes) {
      if (typeof entry.index === "number" && entry.index >= 0 && entry.index < expectedLength) {
        out[entry.index] = typeof entry.note === "string" ? entry.note : ""
      }
    }
    return out
  } catch {
    return null
  }
}
