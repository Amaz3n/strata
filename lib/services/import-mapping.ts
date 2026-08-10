import "server-only"

import { z } from "zod"

import { IMPORTER_DEFINITIONS, type ImporterKey } from "@/lib/services/import-definitions"
import { normalizeKey } from "@/lib/services/import-parsers"
import { runAiObject } from "@/lib/services/ai/gateway"

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

/**
 * Model-facing shape. The schema above coerces sloppy output and stays the
 * public type; structured output guarantees this one, so it carries no
 * preprocessing (z.preprocess does not survive JSON Schema conversion).
 */
const modelMappingSchema = z.object({
  mappings: z.array(
    z.object({
      target: z.string(),
      source: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      note: z.string(),
    }),
  ),
  unmapped_sources: z.array(z.string()),
  unmatched_targets: z.array(z.string()),
})

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
    const columns = IMPORTER_DEFINITIONS[input.importer].columns.map((column) => ({ key: column.key, label: column.label, type: column.type, required: column.required ?? false, example: column.example ?? null }))
    const result = await runAiObject({
      feature: "document_extraction",
      schema: modelMappingSchema,
      system:
        "You map legacy construction ERP CSV columns to Arc import columns. Suggestions only: never " +
        "combine multiple source columns and never invent a source header. `source` is an exact source " +
        "header or null.",
      prompt: [
        `TARGET IMPORTER: ${input.importer}`,
        `TARGET COLUMNS: ${JSON.stringify(columns)}`,
        `SOURCE HEADERS: ${JSON.stringify(input.sourceHeaders)}`,
        `SAMPLE ROWS (maximum five): ${JSON.stringify(input.sampleRows.slice(0, 5))}`,
      ].join("\n"),
      timeoutMs: 45_000,
      // A deterministic alias matcher already answered; the model only refines it.
      allowEscalation: false,
    })
    if (!result.ok) return fallback
    const parsed = result.object
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
