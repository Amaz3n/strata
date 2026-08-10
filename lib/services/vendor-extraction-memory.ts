import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * What Arc has learned about how one vendor's invoices are laid out.
 *
 * Coding already learns from corrections (`coding_rules` tracks hit counts and
 * decays on correction). Extraction learned nothing: the interactive path threw
 * confidence away on submit and never recorded what a human fixed, so invoice
 * #50 from a vendor was read exactly as well — or as badly — as invoice #1.
 *
 * This closes that loop with the cheapest thing that works: remember the last
 * few corrected reads per vendor and hand them back as worked examples. No
 * training, no embeddings, no new table — the memory rides on the vendor's own
 * company row, which is already org-scoped and RLS-protected.
 */

/** Examples per vendor. Enough to establish a pattern, small enough to stay cheap. */
const MAX_EXAMPLES = 3
const SETTINGS_KEY = "extraction_memory"

export interface VendorExtractionExample {
  /** What the model read before a human touched it. */
  read: { billNumber: string | null; totalDollars: number | null; lineCount: number }
  /** What the human committed. Only recorded when it differs from the read. */
  corrected: { billNumber: string | null; totalDollars: number | null; lineCount: number }
  correctedAt: string
}

interface ExtractionMemory {
  examples: VendorExtractionExample[]
}

function readMemory(metadata: unknown): ExtractionMemory {
  if (!metadata || typeof metadata !== "object") return { examples: [] }
  const record = (metadata as Record<string, unknown>)[SETTINGS_KEY]
  if (!record || typeof record !== "object") return { examples: [] }
  const examples = (record as Record<string, unknown>).examples
  return { examples: Array.isArray(examples) ? (examples as VendorExtractionExample[]) : [] }
}

/**
 * Record a correction. Called after a human commits a scanned payable.
 *
 * A read that needed no correction teaches nothing and is deliberately not
 * stored — otherwise the memory fills with confirmations of what already works
 * and crowds out the cases that actually go wrong.
 */
export async function recordExtractionCorrection({
  supabase,
  orgId,
  companyId,
  read,
  corrected,
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string
  read: VendorExtractionExample["read"]
  corrected: VendorExtractionExample["corrected"]
}): Promise<void> {
  const unchanged =
    read.billNumber === corrected.billNumber &&
    read.totalDollars === corrected.totalDollars &&
    read.lineCount === corrected.lineCount
  if (unchanged) return

  try {
    const { data } = await supabase
      .from("companies")
      .select("metadata")
      .eq("org_id", orgId)
      .eq("id", companyId)
      .maybeSingle()

    const metadata = (data?.metadata as Record<string, unknown> | null) ?? {}
    const memory = readMemory(metadata)
    const examples = [
      { read, corrected, correctedAt: new Date().toISOString() },
      ...memory.examples,
    ].slice(0, MAX_EXAMPLES)

    await supabase
      .from("companies")
      .update({ metadata: { ...metadata, [SETTINGS_KEY]: { examples } } })
      .eq("org_id", orgId)
      .eq("id", companyId)
  } catch (error) {
    // Learning is an optimisation; never fail a payable because it did not stick.
    console.warn("[vendor-extraction-memory] Could not record correction", error)
  }
}

/**
 * Prior corrections for this vendor, as a prompt block. Empty string when there
 * is nothing learned yet, so the caller can drop it without a conditional.
 */
export async function loadVendorExtractionHints({
  supabase,
  orgId,
  companyId,
}: {
  supabase: SupabaseClient
  orgId: string
  companyId: string | null
}): Promise<string> {
  if (!companyId) return ""

  try {
    const { data } = await supabase
      .from("companies")
      .select("metadata")
      .eq("org_id", orgId)
      .eq("id", companyId)
      .maybeSingle()

    const { examples } = readMemory(data?.metadata)
    if (examples.length === 0) return ""

    const lines = examples.map((example, index) => {
      const notes: string[] = []
      if (example.read.billNumber !== example.corrected.billNumber) {
        notes.push(`invoice number was read as ${example.read.billNumber ?? "null"} but is ${example.corrected.billNumber ?? "null"}`)
      }
      if (example.read.totalDollars !== example.corrected.totalDollars) {
        notes.push(`total was read as ${example.read.totalDollars ?? "null"} but is ${example.corrected.totalDollars ?? "null"}`)
      }
      if (example.read.lineCount !== example.corrected.lineCount) {
        notes.push(`${example.read.lineCount} lines were found but the invoice has ${example.corrected.lineCount}`)
      }
      return `${index + 1}. ${notes.join("; ")}`
    })

    return [
      "Corrections a human previously made to this vendor's invoices. Read this",
      "vendor's layout with those mistakes in mind; do not copy the values themselves.",
      ...lines,
    ].join("\n")
  } catch {
    return ""
  }
}
