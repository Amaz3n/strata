import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createObservation } from "@/lib/services/safety"
import { renderReportPdf } from "@/lib/pdfs/report"
import { persistGeneratedProjectPdf } from "@/lib/services/generated-project-pdfs"
import {
  saveStructuredFormResponsesSchema,
  structuredFormRunSchema,
  structuredFormTemplateSchema,
} from "@/lib/validation/structured-forms"

export async function listStructuredFormTemplates(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.read", context)
  const { data, error } = await context.supabase.from("structured_form_templates")
    .select("id,org_id,name,kind,trade,description,is_active,created_at,updated_at,items:structured_form_items(id,section,prompt,response_type,options,is_required,blocks_completion,sort_order)")
    .eq("org_id", context.orgId).eq("is_active", true).order("name").limit(250)
  if (error) throw new Error(`Failed to list form templates: ${error.message}`)
  return data ?? []
}

export async function listStructuredFormRuns(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.read", context)
  const { data, error } = await context.supabase.from("structured_form_runs").select("id,title,status,completed_at,pdf_file_id,created_at,template:structured_form_templates(name,kind)").eq("org_id", context.orgId).eq("project_id", projectId).order("created_at", { ascending: false }).limit(100)
  if (error) throw new Error(`Failed to load form runs: ${error.message}`)
  return data ?? []
}

export async function createStructuredFormTemplate(input: unknown, orgId?: string) {
  const parsed = structuredFormTemplateSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.write", context)
  const payload = { org_id: context.orgId, name: parsed.name, kind: parsed.kind, trade: parsed.trade ?? null, description: parsed.description ?? null, is_active: true }
  const { data, error } = await context.supabase.from("structured_form_templates").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to create form template: ${error?.message}`)
  const items = parsed.items.map((item, index) => ({ org_id: context.orgId, template_id: data.id, section: item.section ?? null, prompt: item.prompt, response_type: item.response_type, options: item.options, is_required: item.is_required, blocks_completion: item.blocks_completion, sort_order: index }))
  const { error: itemError } = await context.supabase.from("structured_form_items").insert(items)
  if (itemError) throw new Error(`Failed to create form items: ${itemError.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "structured_form_template_created", entityType: "structured_form_template", entityId: data.id, payload: { name: parsed.name, kind: parsed.kind, item_count: items.length } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "structured_form_template", entityId: data.id, after: { ...payload, items } }),
  ])
  return { ...data, items }
}

export async function startStructuredFormRun(input: unknown, orgId?: string) {
  const parsed = structuredFormRunSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.write", context)
  const { data: template } = await context.supabase.from("structured_form_templates").select("id").eq("org_id", context.orgId).eq("id", parsed.template_id).eq("is_active", true).maybeSingle()
  if (!template) throw new Error("Form template not found")
  if (parsed.project_id) {
    const { data: project } = await context.supabase.from("projects").select("id").eq("org_id", context.orgId).eq("id", parsed.project_id).maybeSingle()
    if (!project) throw new Error("Project not found")
  }
  const payload = { org_id: context.orgId, template_id: parsed.template_id, project_id: parsed.project_id ?? null, lot_id: parsed.lot_id ?? null, company_id: parsed.company_id ?? null, title: parsed.title, status: "in_progress", started_by: context.userId }
  const { data, error } = await context.supabase.from("structured_form_runs").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to start form: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "structured_form_run", entityId: data.id, after: payload })
  return data
}

export async function saveStructuredFormResponses(input: unknown, orgId?: string) {
  const parsed = saveStructuredFormResponsesSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.write", context)
  const { data: run } = await context.supabase.from("structured_form_runs").select("id,project_id,status,template_id").eq("org_id", context.orgId).eq("id", parsed.run_id).maybeSingle()
  if (!run) throw new Error("Form run not found")
  if (["completed","void"].includes(run.status)) throw new Error("Completed forms are locked")
  const itemIds = parsed.responses.map((response) => response.item_id)
  const { data: items } = await context.supabase.from("structured_form_items").select("id").eq("org_id", context.orgId).eq("template_id", run.template_id).in("id", itemIds)
  if (items?.length !== new Set(itemIds).size) throw new Error("One or more responses do not belong to this form")
  const rows = parsed.responses.map((response) => ({ org_id: context.orgId, run_id: parsed.run_id, item_id: response.item_id, response: response.response ?? null, is_failed: response.is_failed, note: response.note ?? null, file_id: response.file_id ?? null, signature_file_id: response.signature_file_id ?? null, answered_by: context.userId, answered_at: new Date().toISOString() }))
  const { error } = await context.supabase.from("structured_form_responses").upsert(rows, { onConflict: "run_id,item_id" })
  if (error) throw new Error(`Failed to save form responses: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "structured_form_run", entityId: run.id, after: { responses: rows } })
  return rows
}

export async function completeStructuredFormRun(runId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("forms.write", context)
  const { data: run } = await context.supabase.from("structured_form_runs").select("id,project_id,status,template_id,title").eq("org_id", context.orgId).eq("id", runId).maybeSingle()
  if (!run) throw new Error("Form run not found")
  if (run.status === "completed") return run
  const [{ data: items, error: itemError }, { data: responses, error: responseError }] = await Promise.all([
    context.supabase.from("structured_form_items").select("id,section,prompt,response_type,is_required,blocks_completion,sort_order").eq("org_id", context.orgId).eq("template_id", run.template_id).order("sort_order"),
    context.supabase.from("structured_form_responses").select("id,item_id,response,is_failed,note,spawned_entity_type,spawned_entity_id").eq("org_id", context.orgId).eq("run_id", runId),
  ])
  if (itemError || responseError) throw new Error(`Failed to validate form completion: ${itemError?.message ?? responseError?.message}`)
  const responseByItem = new Map((responses ?? []).map((response) => [response.item_id, response]))
  const missing = (items ?? []).filter((item) => item.is_required && !responseByItem.has(item.id))
  if (missing.length) throw new Error(`${missing.length} required response${missing.length === 1 ? " is" : "s are"} missing`)
  const blocking = (items ?? []).filter((item) => item.blocks_completion && responseByItem.get(item.id)?.is_failed)
  const status = blocking.length ? "blocked" : "completed"
  const patch = status === "completed" ? { status, completed_by: context.userId, completed_at: new Date().toISOString() } : { status }
  const { data, error } = await context.supabase.from("structured_form_runs").update(patch).eq("org_id", context.orgId).eq("id", runId).select("*").single()
  if (error || !data) throw new Error(`Failed to complete form: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: status === "completed" ? "structured_form_completed" : "structured_form_blocked", entityType: "structured_form_run", entityId: runId, payload: { project_id: run.project_id, blocking_items: blocking.length } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "structured_form_run", entityId: runId, before: run, after: data }),
  ])
  if (run.project_id) {
    for (const item of items ?? []) {
      const response = responseByItem.get(item.id)
      if (!response?.is_failed || response.spawned_entity_id) continue
      const observation = await createObservation({ project_id: run.project_id, kind: "quality", category: "deficiency", description: [item.prompt, response.note].filter(Boolean).join(" — ") }, context.orgId)
      await context.supabase.from("structured_form_responses").update({ spawned_entity_type: "observation", spawned_entity_id: observation.id }).eq("org_id", context.orgId).eq("id", response.id)
    }
  }
  if (status === "completed" && run.project_id) {
    const printable = (items ?? []).map((item) => {
      const response = responseByItem.get(item.id)
      const raw = response?.response
      const display = raw == null ? "—" : typeof raw === "string" ? raw : JSON.stringify(raw)
      return { key: item.id, cells: { section: item.section ?? "General", item: item.prompt, response: display, result: response?.is_failed ? "Failed" : "Passed", note: response?.note ?? "" } }
    })
    const pdf = await renderReportPdf({ title: run.title, provenance: `Completed ${new Date().toISOString().slice(0, 10)}`, result: { tables: [{ key: "responses", columns: [{ key: "section", header: "Section" }, { key: "item", header: "Item" }, { key: "response", header: "Response" }, { key: "result", header: "Result", type: "status" }, { key: "note", header: "Note" }], rows: printable }] }, branding: { org_name: null, org_logo_url: null } })
    const file = await persistGeneratedProjectPdf({ supabase: context.supabase, orgId: context.orgId, projectId: run.project_id, fileName: `form-${runId}.pdf`, pdf: Buffer.from(pdf), category: "other", folderPath: "/Forms", description: `Completed form: ${run.title}` })
    await context.supabase.from("structured_form_runs").update({ pdf_file_id: file.id }).eq("org_id", context.orgId).eq("id", runId)
    data.pdf_file_id = file.id
  }
  return data
}
