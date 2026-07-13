import "server-only"

import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { generateText } from "ai"
import { z } from "zod"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { extractPageTextLines, loadMupdf } from "@/lib/services/drawings-pipeline"
import { enqueueReindex } from "@/lib/services/search-index"
import { triggerSpecsPipeline } from "@/lib/services/specs-pipeline-trigger"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"

export const SPEC_PIPELINE_JOB_TYPES = ["process_spec_upload"] as const
const MAX_RETRIES = 3
const STALE_MINUTES = 5
const headingSchema = z.object({ section_number: z.string().regex(/^\d{2} \d{2} \d{2}$/), title: z.string().min(1).max(300) })

type ClaimedJob = { job_id: number; org_id: string; job_type: string; payload: Record<string, unknown>; retry_count: number }
type Boundary = { sectionNumber: string; title: string; pageIndex: number }

function normalizeText(value: string) { return value.replace(/\s+/g, " ").trim() }

function detectHeading(lines: string[]): Omit<Boundary, "pageIndex"> | null {
  const candidates: Array<{ sectionNumber: string; lineIndex: number }> = []
  for (const [lineIndex, line] of lines.slice(0, 24).entries()) {
    const match = normalizeText(line).match(/\bSECTION\s+(\d{2})\s?([0-9]{2})\s?([0-9]{2})\b/i)
    if (match) candidates.push({ sectionNumber: `${match[1]} ${match[2]} ${match[3]}`, lineIndex })
  }
  const unique = Array.from(new Map(candidates.map((candidate) => [candidate.sectionNumber, candidate])).values())
  if (unique.length !== 1) return null
  const candidate = unique[0]
  const title = lines.slice(candidate.lineIndex + 1, candidate.lineIndex + 5).map(normalizeText)
    .find((line) => line && !/^PART\s+\d/i.test(line) && !/^SECTION\b/i.test(line) && line.length <= 300)
  return { sectionNumber: candidate.sectionNumber, title: title ?? `Section ${candidate.sectionNumber}` }
}

async function classifyAmbiguousPage(lines: string[], supabase: SupabaseClient) {
  const pageText = lines.slice(0, 80).join("\n").slice(0, 8_000)
  if (!pageText || !/(?:SECTION|\b\d{2}\s\d{2}\s\d{2}\b)/i.test(pageText)) return null
  const config = await getPlatformAiFeatureDefaultConfig({ supabase, feature: "spec_classification" })
  const apiKey = getApiKeyForProvider(config.provider)
  if (!apiKey) return null
  const result = await generateText({
    model: resolveLanguageModel(config.provider, apiKey, config.model), temperature: 0, maxOutputTokens: 180, timeout: 12_000,
    system: "Classify a construction specification page. Return only JSON. Never invent a section if the page is a table of contents or continuation page.",
    prompt: `If this page begins a CSI section, return {"section_number":"NN NN NN","title":"..."}; otherwise return null.\n\n${pageText}`,
  })
  const raw = result.text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  if (raw === "null") return null
  try { return headingSchema.parse(JSON.parse(raw)) } catch { return null }
}

async function ensureSectionFile(input: { supabase: SupabaseClient; orgId: string; projectId: string; uploadId: string; sectionNumber: string; title: string; bytes: Buffer; actorId: string | null }) {
  const safeSection = input.sectionNumber.replaceAll(" ", "-")
  const storagePath = `${input.orgId}/${input.projectId}/specs/sections/${input.uploadId}/${safeSection}.pdf`
  await uploadFilesObject({ supabase: input.supabase, orgId: input.orgId, path: storagePath, bytes: input.bytes, contentType: "application/pdf", upsert: true })
  const { data: existing } = await input.supabase.from("files").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("storage_path", storagePath).limit(1).maybeSingle()
  if (existing) return existing.id
  const checksum = createHash("sha256").update(input.bytes).digest("hex")
  const fileName = `${input.sectionNumber} - ${input.title}.pdf`.replace(/[/\\]/g, "-")
  const { data: file, error } = await input.supabase.from("files").insert({ org_id: input.orgId, project_id: input.projectId, file_name: fileName,
    storage_path: storagePath, mime_type: "application/pdf", size_bytes: input.bytes.length, checksum, visibility: "private", category: "other",
    folder_path: "/specs", source: "generated", uploaded_by: input.actorId, tags: ["specification", input.sectionNumber] })
    .select("id").single()
  if (error || !file) throw new Error(`Failed to create section PDF record: ${error?.message}`)
  const { data: version, error: versionError } = await input.supabase.from("doc_versions").insert({ org_id: input.orgId, file_id: file.id,
    version_number: 1, storage_path: storagePath, file_name: fileName, mime_type: "application/pdf", size_bytes: input.bytes.length,
    checksum, created_by: input.actorId }).select("id").single()
  if (versionError || !version) throw new Error(`Failed to create section file version: ${versionError?.message}`)
  await input.supabase.from("files").update({ current_version_id: version.id }).eq("id", file.id)
  return file.id
}

export async function processSpecUpload(supabase: SupabaseClient, uploadId: string, orgId: string) {
  const { data: upload, error } = await supabase.from("spec_uploads").select("id, org_id, project_id, file_id, status, created_by, file:files(storage_path)")
    .eq("id", uploadId).eq("org_id", orgId).maybeSingle()
  if (error || !upload) throw new Error(`Specification upload not found: ${error?.message ?? uploadId}`)
  if (upload.status === "complete") return
  await supabase.from("spec_uploads").update({ status: "processing", error: null }).eq("id", uploadId)
  const file = Array.isArray(upload.file) ? upload.file[0] : upload.file
  if (!file?.storage_path) throw new Error("Specification upload file is unavailable")
  const pdfBytes = await downloadFilesObject({ supabase, orgId, path: file.storage_path })
  const mupdf = await loadMupdf()
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf")
  try {
    const pages: Array<{ lines: string[]; text: string }> = []
    const boundaries: Boundary[] = []
    for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex++) {
      const page = doc.loadPage(pageIndex)
      const lines = extractPageTextLines(page)
      page.destroy?.()
      pages.push({ lines, text: lines.join("\n") })
      const direct = detectHeading(lines)
      const classified = direct ? null : await classifyAmbiguousPage(lines, supabase)
      const detected = direct ?? (classified ? { sectionNumber: classified.section_number, title: classified.title } : null)
      if (detected && boundaries.at(-1)?.sectionNumber !== detected.sectionNumber) boundaries.push({ ...detected, pageIndex })
    }
    if (!boundaries.length) throw new Error("No CSI section headings were detected. Add sections manually or upload a text-searchable project manual.")
    let detectedCount = 0
    for (const [index, boundary] of boundaries.entries()) {
      const endIndex = (boundaries[index + 1]?.pageIndex ?? doc.countPages()) - 1
      const sectionPdf = new mupdf.PDFDocument()
      for (let pageIndex = boundary.pageIndex; pageIndex <= endIndex; pageIndex++) sectionPdf.graftPage(sectionPdf.countPages(), doc as any, pageIndex)
      const bytes = Buffer.from(sectionPdf.saveToBuffer("compress").asUint8Array())
      sectionPdf.destroy?.()
      const fileId = await ensureSectionFile({ supabase, orgId, projectId: upload.project_id, uploadId, sectionNumber: boundary.sectionNumber,
        title: boundary.title, bytes, actorId: upload.created_by ?? null })
      const extractedText = pages.slice(boundary.pageIndex, endIndex + 1).map((page) => page.text).join("\n").slice(0, 250_000)
      const { data: appended, error: appendError } = await supabase.rpc("append_spec_revision", { p_org_id: orgId, p_project_id: upload.project_id,
        p_division: boundary.sectionNumber.slice(0, 2), p_section_number: boundary.sectionNumber, p_title: boundary.title,
        p_source_upload_id: uploadId, p_file_id: fileId, p_page_start: boundary.pageIndex + 1, p_page_end: endIndex + 1,
        p_extracted_text: extractedText, p_issued_date: null, p_created_by: upload.created_by ?? null })
      if (appendError || !appended?.[0]) throw new Error(`Failed to append ${boundary.sectionNumber}: ${appendError?.message}`)
      await enqueueReindex({ orgId, entityType: "spec_section", entityId: appended[0].section_id, op: "upsert" }, supabase)
      detectedCount += 1
    }
    await supabase.from("spec_uploads").update({ status: "complete", sections_detected: detectedCount, error: null }).eq("id", uploadId)
  } finally { doc.destroy?.() }
}

async function resetStale(supabase: SupabaseClient) {
  await supabase.from("outbox").update({ status: "pending" }).in("job_type", [...SPEC_PIPELINE_JOB_TYPES]).eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - STALE_MINUTES * 60_000).toISOString())
}

export async function runSpecsPipeline(options: { deadlineMs?: number } = {}) {
  const supabase = createServiceSupabaseClient(); const deadline = options.deadlineMs ?? Date.now() + 240_000
  const summary = { processed: 0, failed: 0, remaining: 0 }; await resetStale(supabase)
  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_jobs", { job_types: [...SPEC_PIPELINE_JOB_TYPES], limit_value: 2 })
    if (error || !data?.length) break
    for (const job of data as ClaimedJob[]) {
      const heartbeat = setInterval(() => { void supabase.from("outbox").update({ updated_at: new Date().toISOString() }).eq("id", job.job_id) }, 45_000)
      try {
        const uploadId = typeof job.payload.specUploadId === "string" ? job.payload.specUploadId : null
        if (!uploadId) throw new Error("Missing specUploadId")
        await processSpecUpload(supabase, uploadId, job.org_id)
        await supabase.from("outbox").update({ status: "completed", last_error: null }).eq("id", job.job_id); summary.processed++
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError); const retry = job.retry_count + 1
        await supabase.from("outbox").update({ status: retry < MAX_RETRIES ? "pending" : "failed", retry_count: retry, last_error: message,
          run_at: retry < MAX_RETRIES ? new Date(Date.now() + 2 ** retry * 60_000).toISOString() : undefined }).eq("id", job.job_id)
        if (retry >= MAX_RETRIES && typeof job.payload.specUploadId === "string") await supabase.from("spec_uploads").update({ status: "failed", error: message }).eq("id", job.payload.specUploadId)
        summary.failed++
      } finally { clearInterval(heartbeat) }
    }
  }
  const { count } = await supabase.from("outbox").select("id", { count: "exact", head: true }).in("job_type", [...SPEC_PIPELINE_JOB_TYPES]).eq("status", "pending").lte("run_at", new Date().toISOString())
  summary.remaining = count ?? 0; return summary
}

export async function hasPendingSpecJobs() {
  const supabase = createServiceSupabaseClient(); const { count } = await supabase.from("outbox").select("id", { count: "exact", head: true })
    .in("job_type", [...SPEC_PIPELINE_JOB_TYPES]).eq("status", "pending").lte("run_at", new Date().toISOString())
  return (count ?? 0) > 0
}

export async function kickRemainingSpecJobs(count: number) { if (count > 0) await triggerSpecsPipeline() }
