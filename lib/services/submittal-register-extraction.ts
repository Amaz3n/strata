import type { SupabaseClient } from "@supabase/supabase-js"
import { generateText } from "ai"
import { z } from "zod"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { recordEvent } from "@/lib/services/events"

const requirementSchema = z.object({
  requirements: z.array(z.object({
    type: z.enum(["product_data","shop_drawing","sample","mock_up","certificate","other"]),
    title: z.string().trim().min(3).max(300),
    clause_text: z.string().trim().min(3).max(4000),
    page: z.number().int().positive().nullable(),
    lead_time_days: z.number().int().nonnegative().max(730).nullable(),
    confidence: z.number().min(0).max(1),
  })).max(100),
})

function jsonCandidate(raw: string) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

export async function extractSubmittalRegisterDrafts(input: { supabase: SupabaseClient; orgId: string; sectionId: string; revisionId: string }) {
  const { data: revision, error } = await input.supabase.from("spec_revisions").select("id,org_id,section_id,revision_number,extracted_text,section:spec_sections!inner(id,project_id,section_number,title)").eq("org_id", input.orgId).eq("id", input.revisionId).eq("section_id", input.sectionId).maybeSingle()
  if (error || !revision) throw new Error("Specification revision not found for register extraction")
  const section = Array.isArray(revision.section) ? revision.section[0] : revision.section
  if (!section) throw new Error("Specification section not found")
  const text = String(revision.extracted_text ?? "").slice(0, 80_000)
  if (!text.trim()) return { created: 0 }
  const config = await getPlatformAiFeatureDefaultConfig({ supabase: input.supabase, feature: "document_extraction" })
  const key = getApiKeyForProvider(config.provider)
  if (!key) throw new Error(`${config.provider} is not configured for submittal extraction`)
  const prompt = `Extract every explicit submittal obligation from this CSI section. Look for submit, shop drawings, product data, samples, mock-ups, certificates. Return JSON only: {"requirements":[{"type":"product_data|shop_drawing|sample|mock_up|certificate|other","title":string,"clause_text":string,"page":number|null,"lead_time_days":number|null,"confidence":0..1}]}. Quote only the shortest clause needed for traceability. Do not invent obligations.\n\nSECTION ${section.section_number} — ${section.title}\n${text}`
  const result = await generateText({ model: resolveLanguageModel(config.provider, key, config.model), prompt, abortSignal: AbortSignal.timeout(120_000) })
  const extracted = requirementSchema.parse(JSON.parse(jsonCandidate(result.text)))
  const rows = extracted.requirements.map((requirement) => ({
    org_id: input.orgId, project_id: section.project_id, spec_section_id: section.id, spec_revision_id: revision.id,
    section_reference: section.section_number, requirement_type: requirement.type, title: requirement.title,
    clause_text: requirement.clause_text, clause_page: requirement.page, suggested_lead_time_days: requirement.lead_time_days,
    confidence: requirement.confidence, status: requirement.confidence >= 0.8 ? "draft" : "needs_review",
  }))
  if (rows.length) {
    const { error: insertError } = await input.supabase.from("submittal_register_drafts").upsert(rows, { onConflict: "spec_revision_id,title,clause_page", ignoreDuplicates: true })
    if (insertError) throw new Error(`Failed to save submittal register drafts: ${insertError.message}`)
  }
  if (Number(revision.revision_number ?? 0) > 0) {
    await input.supabase.from("submittals").update({ needs_spec_rereview: true, spec_rereview_reason: `Specification ${section.section_number} was revised` }).eq("org_id", input.orgId).eq("project_id", section.project_id).eq("spec_section_id", section.id).is("superseded_by_id", null)
  }
  await recordEvent({ orgId: input.orgId, eventType: "submittal_register_extracted", entityType: "spec_section", entityId: section.id, payload: { project_id: section.project_id, spec_revision_id: revision.id, draft_count: rows.length } })
  return { created: rows.length }
}
