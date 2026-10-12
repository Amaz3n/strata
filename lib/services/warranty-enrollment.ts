import "server-only"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { readAllRows } from "@/lib/land/paging"
import { buildCoverageSnapshot } from "@/lib/services/warranty/domain"
import { recordEvent } from "@/lib/services/events"

export const warrantyEffectiveDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, "Invalid calendar date")
const date = warrantyEffectiveDateSchema
const inputSchema = z.object({ orgId: z.string().uuid(), projectId: z.string().uuid(), effectiveDate: date, source: z.enum(["closing", "completion"]) })
const termSchema = z.object({ key: z.string().min(1), label: z.string().min(1), duration_months: z.number().int().min(1).max(1200), is_structural: z.boolean(), description: z.string().nullable() })
const coverageSchema = z.object({ id: z.string().uuid(), program_id: z.string().uuid(), effective_date: date, effective_source: z.enum(["closing", "completion", "manual"]),
  terms_snapshot: z.array(termSchema.extend({ expires_on: date })).min(1).max(1000) })

export async function readWarrantyEnrollmentTerms(supabase: SupabaseClient, orgId: string, programId: string) {
  const terms = await readAllRows((from, to) => supabase.from("warranty_coverage_terms").select("key,label,duration_months,is_structural,description")
    .eq("org_id", orgId).eq("program_id", programId).order("sort_order").order("key").range(from, to), { cap: 1001, label: "Unable to read warranty terms" })
  if (terms.truncated) throw new Error("Warranty terms exceed the supported limit")
  const parsed = z.array(termSchema).min(1).max(1000).parse(terms.rows)
  if (new Set(parsed.map(term => term.key)).size !== parsed.length) throw new Error("Warranty term keys must be unique")
  return parsed
}

export async function enrollSystemWarrantyCoverage(supabase: SupabaseClient, raw: unknown, ensureDefaults: () => Promise<void>) {
  const input = inputSchema.parse(raw)
  const project = await supabase.from("projects").select("id").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle()
  if (project.error || !project.data) throw new Error("Warranty enrollment home is unavailable")
  const source = input.source === "closing"
    ? await supabase.from("closings").select("actual_date").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("status", "closed").limit(2)
    : await supabase.from("closeout_packages").select("substantial_completion_date").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("substantial_completion_date", input.effectiveDate).limit(2)
  if (source.error) throw new Error(`Unable to verify warranty handoff evidence: ${source.error.message}`)
  if (source.data?.length !== 1) throw new Error("Warranty enrollment requires one verified closing or completion record")
  const sourceDate = input.source === "closing" ? z.object({ actual_date: date }).parse(source.data[0]).actual_date : z.object({ substantial_completion_date: date }).parse(source.data[0]).substantial_completion_date
  if (sourceDate !== input.effectiveDate) throw new Error("Warranty enrollment date differs from the recorded home handoff")

  const readExisting = async () => {
    // A reversed closing voided its coverage; the live row is the one this handoff owns.
    const result = await supabase.from("project_warranty_coverage").select("id,program_id,effective_date,effective_source,terms_snapshot")
      .eq("org_id", input.orgId).eq("project_id", input.projectId).is("voided_at", null).maybeSingle()
    if (result.error) throw new Error(`Unable to read existing warranty coverage: ${result.error.message}`)
    if (!result.data) return null
    const saved = coverageSchema.parse(result.data)
    if (saved.effective_date !== input.effectiveDate || (saved.effective_source !== input.source && saved.effective_source !== "manual")) {
      throw new Error("Existing warranty coverage conflicts with the recorded handoff; reconcile the original enrollment")
    }
    const expected = buildCoverageSnapshot(saved.effective_date, saved.terms_snapshot)
    if (saved.terms_snapshot.some((term, index) => term.expires_on !== expected[index].expires_on) || new Set(saved.terms_snapshot.map(term => term.key)).size !== saved.terms_snapshot.length) {
      throw new Error("Existing warranty term evidence does not reconcile")
    }
    return saved
  }
  let coverage = await readExisting(), enrolled = false
  if (!coverage) {
    const { programId, soldTerms } = await readHandoffProgram(supabase, input, ensureDefaults)
    const parsedTerms = soldTerms ?? await readWarrantyEnrollmentTerms(supabase, input.orgId, programId)
    const inserted = await supabase.from("project_warranty_coverage").insert({ id: randomUUID(), org_id: input.orgId, project_id: input.projectId, program_id: programId,
      effective_date: input.effectiveDate, effective_source: input.source, terms_snapshot: buildCoverageSnapshot(input.effectiveDate, parsedTerms) }).select("id").single()
    if (inserted.error && inserted.error.code !== "23505") throw new Error(`Failed to enroll warranty coverage: ${inserted.error.message}`)
    coverage = await readExisting()
    if (!coverage) throw new Error("Warranty enrollment could not be verified after insert")
    enrolled = !inserted.error
  }
  // Enrollment survives an event-write failure. A retry repairs the missing
  // event; the coverage UUID is its durable event identity across retries.
  const events = await supabase.from("events").select("id,payload").eq("org_id", input.orgId).eq("event_type", "warranty_coverage_enrolled")
    .eq("entity_type", "warranty_coverage").eq("entity_id", coverage.id).order("id").limit(2)
  if (events.error) throw new Error(`Unable to verify warranty enrollment event: ${events.error.message}`)
  if ((events.data?.length ?? 0) > 1) throw new Error("Warranty enrollment event history is ambiguous; reconcile original evidence")
  if (events.data?.length) {
    const payload = z.object({ project_id: z.string().uuid(), effective_date: date, source: z.enum(["closing", "completion", "manual"]).optional() }).parse(events.data[0].payload)
    if (payload.project_id !== input.projectId || payload.effective_date !== coverage.effective_date || (payload.source && payload.source !== coverage.effective_source)) throw new Error("Warranty enrollment event does not match coverage")
  } else {
    await recordEvent({ idempotencyId: coverage.id, orgId: input.orgId, eventType: "warranty_coverage_enrolled", entityType: "warranty_coverage", entityId: coverage.id,
      payload: { project_id: input.projectId, effective_date: coverage.effective_date, source: coverage.effective_source } })
  }
  return { id: coverage.id, enrolled }
}

const soldWarrantySchema = z.object({
  warranty_program_id: z.string().uuid().nullable().optional(),
  // Captured from the program when the agreement was executed; null on an agreement the program had no terms for.
  warranty_terms_snapshot: z.array(termSchema).min(1).max(1000).nullable().optional(),
})

/**
 * The program the buyer bought: the one bound to the executed purchase
 * agreement, on the terms it had when the agreement was signed. A home sold
 * before the org had any program, or handed over at completion without a sale,
 * takes the org's default on its current terms.
 */
async function readHandoffProgram(supabase: SupabaseClient, input: z.infer<typeof inputSchema>, ensureDefaults: () => Promise<void>) {
  if (input.source === "closing") {
    const agreement = await supabase.from("contracts").select("warranty_program_id, warranty_terms_snapshot").eq("org_id", input.orgId).eq("project_id", input.projectId)
      .eq("contract_type", "purchase_agreement").eq("status", "active").order("signed_at", { ascending: false }).limit(2)
    if (agreement.error) throw new Error(`Unable to read the agreement's warranty program: ${agreement.error.message}`)
    if ((agreement.data?.length ?? 0) > 1) throw new Error("The home has more than one active purchase agreement; reconcile it before enrolling warranty")
    const sold = soldWarrantySchema.parse(agreement.data?.[0] ?? {})
    if (sold.warranty_program_id) return { programId: sold.warranty_program_id, soldTerms: sold.warranty_terms_snapshot ?? null }
  }
  await ensureDefaults()
  const program = await supabase.from("warranty_programs").select("id").eq("org_id", input.orgId).eq("is_default", true).eq("is_active", true).order("id").limit(2)
  if (program.error) throw new Error(`Unable to read default warranty program: ${program.error.message}`)
  if (program.data?.length !== 1) throw new Error("Exactly one active default warranty program is required")
  return { programId: z.string().uuid().parse(program.data[0].id), soldTerms: null }
}
