import "server-only"

import { generateText } from "ai"
import { z } from "zod"

import { IMPORTER_DEFINITIONS, type ImporterKey } from "@/lib/services/import-definitions"
import { normalizeKey } from "@/lib/services/import-parsers"
import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const confidenceSchema = z.preprocess((value) => {
  const normalized = normalizeKey(value)
  return ["high", "medium", "low"].includes(normalized) ? normalized : "low"
}, z.enum(["high", "medium", "low"]))

const mappingResponseSchema = z.object({
  mappings: z.preprocess((value) => Array.isArray(value) ? value : [], z.array(z.object({
    target: z.string(),
    source: z.string().nullable().default(null),
    confidence: confidenceSchema.default("low"),
    note: z.preprocess((value) => typeof value === "string" ? value : "", z.string()),
  }))),
  unmapped_sources: z.preprocess((value) => Array.isArray(value) ? value : [], z.array(z.string())),
  unmatched_targets: z.preprocess((value) => Array.isArray(value) ? value : [], z.array(z.string())),
})

export type ImportMappingSuggestion = z.infer<typeof mappingResponseSchema>

function jsonCandidate(raw: string) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

function deterministicSuggestions(importer: ImporterKey, sourceHeaders: string[]): ImportMappingSuggestion {
  const normalizedHeaders = new Map(sourceHeaders.map((header) => [normalizeKey(header).replace(/[^a-z0-9]/g, ""), header]))
  const aliases: Record<string, string[]> = {
    lot_number: ["lot", "lotno", "lotnumber", "homesite", "homesitenumber"],
    community: ["community", "subdivision", "neighborhood", "project"],
    cost_code: ["costcode", "cost", "account", "accountcode"],
    plan_code: ["plan", "plancode", "model", "modelcode"],
    vendor: ["vendor", "supplier", "trade", "subcontractor"],
    unit_price_cents: ["unitprice", "price", "unitcost", "cost"],
    budget_cents: ["budget", "currentbudget", "revisedbudget"],
    remaining_cents: ["remaining", "openbalance", "balance", "unpaid"],
    full_name: ["fullname", "name", "employee"],
    option_code: ["optioncode", "sku", "itemcode"],
  }
  const mappings = IMPORTER_DEFINITIONS[importer].columns.map((column) => {
    const exact = normalizedHeaders.get(normalizeKey(column.key).replace(/[^a-z0-9]/g, ""))
    const alias = (aliases[column.key] ?? []).map((key) => normalizedHeaders.get(key)).find(Boolean)
    const source = exact ?? alias ?? null
    return { target: column.key, source, confidence: source ? "high" as const : "low" as const, note: source ? "Matched by normalized header or known legacy alias." : "Choose a source column." }
  })
  const used = new Set(mappings.map((mapping) => mapping.source).filter(Boolean))
  return { mappings, unmapped_sources: sourceHeaders.filter((header) => !used.has(header)), unmatched_targets: mappings.filter((mapping) => !mapping.source).map((mapping) => mapping.target) }
}

export async function suggestImportColumnMapping(input: { importer: ImporterKey; sourceHeaders: string[]; sampleRows: Array<Record<string, string>> }): Promise<ImportMappingSuggestion> {
  const fallback = deterministicSuggestions(input.importer, input.sourceHeaders)
  try {
    const config = await getPlatformAiFeatureDefaultConfig({ supabase: createServiceSupabaseClient(), feature: "document_extraction" })
    const apiKey = getApiKeyForProvider(config.provider)
    if (!apiKey) return fallback
    const columns = IMPORTER_DEFINITIONS[input.importer].columns.map((column) => ({ key: column.key, label: column.label, type: column.type, required: column.required ?? false, example: column.example ?? null }))
    const prompt = [
      "Map legacy construction ERP CSV columns to Arc import columns.",
      "Suggestions only: never combine multiple source columns and never invent a source header.",
      "Return JSON only: {mappings:[{target,source,confidence,note}],unmapped_sources:[],unmatched_targets:[]}.",
      "confidence is high, medium, or low. source is an exact source header or null.",
      `TARGET IMPORTER: ${input.importer}`,
      `TARGET COLUMNS: ${JSON.stringify(columns)}`,
      `SOURCE HEADERS: ${JSON.stringify(input.sourceHeaders)}`,
      `SAMPLE ROWS (maximum five): ${JSON.stringify(input.sampleRows.slice(0, 5))}`,
    ].join("\n")
    const result = await generateText({ model: resolveLanguageModel(config.provider, apiKey, config.model), prompt, abortSignal: AbortSignal.timeout(45_000) })
    const parsed = mappingResponseSchema.parse(JSON.parse(jsonCandidate(result.text)))
    const targetKeys = new Set(columns.map((column) => column.key))
    const sourceKeys = new Set(input.sourceHeaders)
    const validMappings = parsed.mappings.filter((mapping) => targetKeys.has(mapping.target) && (!mapping.source || sourceKeys.has(mapping.source)))
    const byTarget = new Map(validMappings.map((mapping) => [mapping.target, mapping]))
    const merged = fallback.mappings.map((mapping) => byTarget.get(mapping.target) ?? mapping)
    return { mappings: merged, unmapped_sources: parsed.unmapped_sources.filter((header) => sourceKeys.has(header)), unmatched_targets: merged.filter((mapping) => !mapping.source).map((mapping) => mapping.target) }
  } catch {
    return fallback
  }
}
