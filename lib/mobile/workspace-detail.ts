import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { allowed, loadRows, requireModule } from "@/lib/mobile/workspace"
import { workspaceRecord, type WorkspaceField } from "@/lib/mobile/workspace-catalog"
import { runWithServiceOrgContext } from "@/lib/services/context"

export type Field = WorkspaceField & { value?: string }
export type Action = { id: string; title: string; fields: Field[]; revision?: string }
export type Section = { id: string; title: string; records: ReturnType<typeof workspaceRecord>[] }
export const field = (key: string, label: string, kind: WorkspaceField["kind"] = "text", required = false): Field => ({ key, label, kind, required })
const meetingFields = [field("topic", "Topic", "text", true), field("discussion", "Discussion", "multiline"), { ...field("status", "Status", "choice", true), options: ["open", "closed", "info"] }, field("ball_in_court", "Ball in court"), field("due_date", "Due date", "date")]
export function section(id: string, title: string, rows: unknown[], titleKeys: string[], fields: Field[]): Section {
  return { id, title, records: rows.map((row, index) => workspaceRecord({ id, title, titleKeys, fields, group: "", symbol: "", permission: "", scope: "project" }, row, index)) }
}

async function attachedFiles(context: MobileOrgContext, ids: (string | null | undefined)[]) {
  const fileIds = [...new Set(ids.filter((id): id is string => !!id))]
  if (!fileIds.length) return []
  const { data, error } = await context.serviceSupabase.from("files").select("id,file_name,storage_path")
    .eq("org_id", context.orgId).in("id", fileIds)
  if (error) throw error
  const { createFilesDownloadUrl } = await import("@/lib/storage/files-storage")
  return Promise.all((data ?? []).filter(file => file.storage_path).map(async file => ({ id: file.id, name: file.file_name ?? "Attachment",
    url: (await createFilesDownloadUrl({ supabase: context.serviceSupabase, orgId: context.orgId, path: file.storage_path, fileName: file.file_name, expiresIn: 3600 })).downloadUrl })))
}

export async function loadWorkspaceRecordDetail(context: MobileOrgContext, moduleId: string, projectId: string | undefined, recordId: string, reportParams: Record<string, string> = {}) {
  const workspaceModule = await requireModule(context, moduleId, projectId)
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const rows = await loadRows(context, workspaceModule, projectId)
    const row = rows.find(row => (row as { id?: string }).id === recordId)
    if (!row) throw new MobileAPIError(404, "record_not_found", "This record is not available in this workspace.")
    const sections: Section[] = [], actions: Action[] = []
    const documents: { id: string; name: string; url: string }[] = []
    const orgId = context.orgId
    if (workspaceModule.group === "Books" && moduleId !== "ledger") {
      const books = await (await import("@/lib/mobile/workspace-books")).loadBooksDetail(context, moduleId, row as Record<string, unknown>)
      sections.push(...books.sections)
      actions.push(...books.actions)
    }
    if (moduleId === "estimates" && projectId) {
      const estimate = await (await import("@/lib/mobile/workspace-estimates")).loadEstimateDetail(context, projectId, recordId)
      sections.push(...estimate.sections)
      actions.push(...estimate.actions)
    }
    if (moduleId === "pipeline") {
      const prospect = await (await import("@/lib/mobile/workspace-precon")).loadProspectDetail(context, recordId)
      sections.push(...prospect.sections)
      actions.push(...prospect.actions)
    }
    if (moduleId === "schedule" && projectId) {
      const service = await import("@/lib/services/schedule")
      const dependencies = (await service.listDependenciesByProject(projectId, orgId)).filter(dependency => dependency.item_id === recordId)
      const names = new Map((rows as { id: string; name: string }[]).map(item => [item.id, item.name]))
      sections.push(section("dependencies", "Predecessors", dependencies.map(dependency => ({ ...dependency, name: names.get(dependency.depends_on_item_id) ?? "Schedule item" })), ["name"], [field("dependency_type", "Relationship"), field("lag_days", "Lag days", "number")]))
      if (await allowed(context, "schedule.edit", projectId)) {
        const candidates = (rows as { id: string; name: string }[]).filter(item => item.id !== recordId && !dependencies.some(dependency => dependency.depends_on_item_id === item.id))
        const dependencyFields = [{ ...field("dependency_type", "Relationship", "choice", true), options: ["FS", "SS", "FF", "SF"], option_labels: { FS: "Finish to start", SS: "Start to start", FF: "Finish to finish", SF: "Start to finish" } }, { ...field("lag_days", "Lag days", "number", true), value: "0" }]
        if (candidates.length) actions.push({ id: "add-predecessor", title: "Add Predecessor", fields: [{ ...field("depends_on_item_id", "Predecessor", "choice", true), options: candidates.map(item => item.id), option_labels: Object.fromEntries(candidates.map(item => [item.id, item.name])) }, ...dependencyFields] })
        for (const dependency of dependencies) {
          actions.push({ id: `edit-dependency:${dependency.id}`, title: `Edit Dependency: ${names.get(dependency.depends_on_item_id) ?? "Schedule item"}`, fields: dependencyFields.map(f => ({ ...f, value: String(dependency[f.key as "dependency_type" | "lag_days"]) })) })
          actions.push({ id: `remove-dependency:${dependency.id}`, title: `Remove Dependency: ${names.get(dependency.depends_on_item_id) ?? "Schedule item"}`, fields: [] })
        }
      }
    }
    if (["tasks", "punch"].includes(moduleId) && projectId) {
      const entityType = moduleId === "tasks" ? "task" : "punch_item"
      const { data: links, error } = await context.serviceSupabase.from("file_links").select("file_id")
        .eq("org_id", orgId).eq("project_id", projectId).eq("entity_type", entityType).eq("entity_id", recordId)
      if (error) throw new MobileAPIError(500, "attachments_unavailable", "Attachments could not be loaded.")
      documents.push(...await attachedFiles(context, (links ?? []).map(link => link.file_id)))
      if (await allowed(context, "org.member", projectId) && await allowed(context, "docs.upload", projectId)) {
        actions.push({ id: "attach-file", title: "Add Photo or Document", fields: [field("file_id", "File", "text", true)] })
      }
    }
    if (moduleId === "tasks" && projectId && await allowed(context, "org.member", projectId)) {
      const people = await (await import("@/lib/mobile/project-info")).listMobileTeam(context, projectId)
      if (people.length) actions.push({ id: "assign-task", title: "Assign Task", fields: [{ ...field("user_id", "Project team member", "choice", true), options: people.map(person => person.id), option_labels: Object.fromEntries(people.map(person => [person.id, person.name])) }] })
      actions.push({ id: "unassign-task", title: "Remove Task Assignment", fields: [] })
    }
    if (moduleId === "punch" && projectId) {
      if (await allowed(context, "org.member", projectId)) {
        const companies = await (await import("@/lib/mobile/workspace-punch")).punchAssignmentChoices(context, projectId)
        if (companies.length) actions.push({ id: "assign-punch-company", title: "Assign and Notify Trade", revision: (row as { updated_at?: string }).updated_at, fields: [{ ...field("company_id", "Project company", "choice", true), options: companies.map(company => company.id), option_labels: Object.fromEntries(companies.map(company => [company.id, company.name])) }] })
        if ((row as { assigned_company_id?: string }).assigned_company_id) actions.push({ id: "unassign-punch-company", title: "Remove Trade Assignment", fields: [] })
      }
    }
    if (moduleId === "signatures") {
      type Envelope = Awaited<ReturnType<typeof import("@/app/(app)/signatures/actions").listSignaturesHubAction>>["rows"][number]
      const envelope = row as Envelope
      sections.push(section("recipients", "Recipients", envelope.recipient_statuses, ["name", "email"], [field("email", "Email"), field("status", "Status"), field("signer_role", "Role"), field("signed_at", "Signed", "date"), field("signed_by_name", "Signed by")]))
      sections.push(section("activity", "Activity", envelope.activity, ["label"], [field("created_at", "When", "date"), field("actor_label", "By"), field("detail", "Details", "multiline")]))
      documents.push(...await attachedFiles(context, [envelope.source_file_id]))
      if (envelope.can_download) {
        const executed = await (await import("@/app/(app)/signatures/actions")).getEnvelopeExecutedDownloadUrlAction({ envelopeId: recordId })
        documents.push({ id: executed.executedFileId, name: `${envelope.document_title} – Executed.pdf`, url: executed.url })
      }
      if (projectId && await allowed(context, "project.manage", projectId)) {
        for (const recipient of envelope.recipient_statuses.filter(r => r.can_remind)) actions.push({ id: `signature-reminder:${recipient.id}`, title: `Remind ${recipient.email ?? recipient.name}`, fields: [] })
        if (envelope.can_void) actions.push({ id: "void-envelope", title: "Void Envelope", fields: [field("reason", "Reason", "multiline", true)] })
      }
    }
    if (moduleId === "correspondence" && projectId) {
      const service = await import("@/lib/services/correspondence")
      const email = await service.getProjectEmail(recordId, projectId, orgId)
      if (!email) throw new MobileAPIError(404, "email_missing", "This message is no longer available.")
      const thread = await service.getCorrespondenceThread({ projectId, threadId: email.thread_id }, orgId)
      const messages = thread?.messages ?? [email]
      sections.push(section("conversation", "Conversation", messages.map(message => ({ ...message, body: message.body || message.body_preview || "Message body unavailable.", recipients: message.to_addresses.join(", "), copied: message.cc_addresses.join(", ") })), ["from_address"], [field("occurred_at", "Date", "date"), field("recipients", "To"), field("copied", "Cc"), field("body", "Message", "multiline")]))
      if (thread?.truncated || messages.some(message => message.body_truncated)) sections.push(section("coverage", "Message History", [{ id: "coverage", title: "Some content is truncated", description: "The latest messages are shown. Download the stored message files below to read truncated bodies." }], ["title"], [field("description", "Coverage", "multiline")]))
      documents.push(...await attachedFiles(context, messages.flatMap(message => [...message.attachments.map(attachment => attachment.file_id), ...(message.body_truncated ? [message.body_file_id] : [])])))
      if (await allowed(context, "correspondence.write", projectId)) {
        const vocabulary = await import("@/lib/correspondence")
        actions.push({ id: "classify-message", title: "Classify Message", fields: [{ ...field("classification", "Classification", "choice", true), options: [...vocabulary.CORRESPONDENCE_CLASSIFICATIONS], option_labels: vocabulary.CLASSIFICATION_LABELS, value: email.classification }] })
        if (email.classified_by !== "user") actions.push({ id: "confirm-classification", title: "Confirm Classification", fields: [] })
      }
    }
    if (moduleId === "time" && projectId) {
      const entry = row as { attached_file_ids?: string[]; status: string; worker_name: string; notes?: string }
      documents.push(...await attachedFiles(context, entry.attached_file_ids ?? []))
      if (entry.status === "submitted" && await allowed(context, "time.write", projectId)) actions.push({ id: "edit-time-notes", title: "Edit Time Notes", fields: [{ ...field("notes", "Notes", "multiline"), value: entry.notes ?? "" }] })
      if (entry.status === "submitted" && await allowed(context, "bill.approve", projectId)) {
        actions.push({ id: "approve-time", title: "Approve Time Entry", fields: [] })
        actions.push({ id: "reject-time", title: "Reject Time Entry", fields: [field("reason", "Reason", "multiline", true)] })
      }
    }
    if (moduleId === "closeout") documents.push(...await attachedFiles(context, [(row as { file_id?: string }).file_id]))
    if (moduleId === "decisions") {
      const decision = row as import("@/lib/types").Decision
      sections.push(section("options", "Options", decision.options ?? [], ["label"], [field("description", "Description", "multiline"), field("cost_delta_cents", "Cost change", "money")]))
      if (decision.decision_note) sections.push(section("decision", "Decision", [{ id: "decision", title: decision.status, note: decision.decision_note, approved_at: decision.approved_at }], ["title"], [field("note", "Note", "multiline"), field("approved_at", "Approved", "date")]))
    }
    if (moduleId === "transmittals") {
      const transmittal = row as import("@/lib/services/transmittals").Transmittal
      sections.push(section("recipients", "Recipients", transmittal.recipients, ["display_name", "email"], [field("email", "Email"), field("company_name", "Company"), field("first_viewed_at", "First viewed", "date"), field("first_downloaded_at", "First downloaded", "date")]))
      sections.push(section("enclosures", "Enclosures", transmittal.items, ["description"], [field("copies", "Copies", "number")]))
      documents.push(...await attachedFiles(context, [transmittal.pdf_file_id, ...transmittal.items.map(item => item.file_id)]))
      if (projectId && !transmittal.sent_at && await allowed(context, "transmittal.write", projectId)) actions.push({ id: "send-transmittal", title: "Send to Listed Recipients", fields: [] })
    }
    if (moduleId === "warranty") {
      const request = row as import("@/lib/types").WarrantyRequest
      const service = await import("@/lib/services/warranty")
      const visits = (await service.listWarrantyVisitsForProject(request.project_id, orgId)).filter(visit => visit.request_id === recordId)
      sections.push(section("visits", "Service Visits", visits.map(visit => ({ ...visit, title: `Visit ${visit.visit_number}` })), ["title"], [field("status", "Status"), field("window_start", "Window start", "date"), field("window_end", "Window end", "date"), field("assigned_user_name", "Technician"), field("assigned_company_name", "Trade"), field("outcome", "Outcome"), field("outcome_note", "Outcome notes", "multiline")]))
      if (await allowed(context, "warranty.write", request.project_id)) {
        if (!request.first_responded_at) actions.push({ id: "acknowledge-warranty", title: "Record First Response", fields: [{ ...field("channel", "Contact method", "choice", true), options: ["phone", "email", "text", "in_person"] }, field("note", "Response note", "multiline")] })
        if (!["resolved", "closed"].includes(request.status)) actions.push({ id: "resolve-warranty", title: "Resolve and Notify Homeowner", fields: [field("resolution_note", "Resolution", "multiline", true)] })
        else actions.push({ id: "reopen-warranty", title: "Reopen Warranty Request", fields: [] })
      }
    }
    if (moduleId === "rfis") {
      const responses = await (await import("@/lib/services/rfis")).listRfiResponses({ orgId, rfiId: recordId })
      documents.push(...await attachedFiles(context, [(row as { attachment_file_id?: string }).attachment_file_id, ...responses.map(response => response.file_id)]))
      sections.push(section("responses", "Discussion", responses, ["responder_name", "response_type"], [field("body", "Message", "multiline"), field("created_at", "Posted", "date")]))
      if (projectId && await allowed(context, "rfi.respond", projectId) && (row as { status: string }).status !== "closed") {
        actions.push({ id: "respond", title: "Add Response", fields: [field("body", "Response", "multiline", true)] })
      }
      if (projectId && await allowed(context, "rfi.close", projectId)) {
        const closed = (row as { status: string }).status === "closed"
        actions.push({ id: closed ? "reopen" : "close", title: closed ? "Reopen RFI" : "Close RFI", fields: [] })
      }
    }
    if (moduleId === "submittals") {
      const service = await import("@/lib/services/submittals")
      const [items, steps] = await Promise.all([service.listSubmittalItems({ orgId, submittalId: recordId }), service.listSubmittalReviewSteps({ orgId, submittalId: recordId })])
      sections.push(section("items", "Submitted Items", items, ["description"], [field("manufacturer", "Manufacturer"), field("model_number", "Model"), field("file_name", "Document")]))
      sections.push(section("review-steps", "Review Routing", steps, ["role_label"], [field("status", "Status"), field("due_date", "Due date", "date"), field("notes", "Notes", "multiline")]))
      documents.push(...await attachedFiles(context, [(row as { attachment_file_id?: string }).attachment_file_id, ...items.map(item => item.file_id)]))
      const status = (row as { status: string }).status
      if (projectId && await allowed(context, "submittal.write", projectId) && ["draft", "pending", "revise_resubmit"].includes(status)) {
        actions.push({ id: "add-submittal-item", title: "Add Submittal Item", fields: [field("description", "Description", "multiline", true), field("manufacturer", "Manufacturer"), field("model_number", "Model number")] })
        if (status === "draft" || status === "pending") actions.push({ id: "submit-submittal", title: "Submit for Review", fields: [] })
        if (status === "revise_resubmit") actions.push({ id: "resubmit-submittal", title: "Start Resubmission", fields: [] })
      }
      if (projectId && ["submitted", "in_review"].includes(status) && await allowed(context, "submittal.route", projectId)) {
        for (const step of steps.filter(step => step.status === "in_review")) {
          actions.push({ id: `review-step:${step.id}`, title: `Review: ${step.role_label}`, fields: [{ ...field("decision", "Decision", "choice", true), options: ["approved", "approved_as_noted", "revise_resubmit", "rejected"] }, field("notes", "Review notes", "multiline")] })
        }
      }
      if (projectId && !steps.length && ["submitted", "in_review"].includes(status) && await allowed(context, "submittal.review", projectId)) {
        actions.push({ id: "review-submittal", title: "Record Review", fields: [{ ...field("decision_status", "Decision", "choice", true), options: ["approved", "approved_as_noted", "revise_resubmit", "rejected"] }, field("decision_note", "Review notes", "multiline")] })
      }
    }
    if (moduleId === "meetings") {
      const meeting = await (await import("@/lib/services/meetings")).getMeeting(recordId, orgId)
      sections.push(section("agenda", "Agenda and Minutes", meeting.items, ["topic"], meetingFields))
      sections.push(section("attendees", "Attendance", meeting.attendees, ["display_name"], [field("company_name", "Company"), field("email", "Email"), field("present", "Present")]))
      documents.push(...await attachedFiles(context, [meeting.pdf_file_id]))
      if (projectId && meeting.status === "finalized" && await allowed(context, "meeting.write", projectId)) {
        actions.push({ id: "distribute-minutes", title: "Email Meeting Minutes", fields: [field("recipients", "Recipient emails (separate with commas)", "multiline", true)] })
      }
      if (projectId && meeting.status !== "finalized" && await allowed(context, "meeting.write", projectId)) {
        actions.push({ id: "add-item", title: "Add Agenda Item", fields: meetingFields })
        for (const item of meeting.items) actions.push({ id: `meeting-item:${item.id}`, title: `Edit ${item.topic}`, fields: meetingFields.map(f => ({ ...f, value: String((item as unknown as Record<string, unknown>)[f.key] ?? "") })) })
        actions.push({ id: "add-attendee", title: "Add Attendee", fields: [field("display_name", "Name", "text", true), field("company_name", "Company"), field("email", "Email")] })
        for (const attendee of meeting.attendees) actions.push({ id: `attendance:${attendee.id}`, title: `Attendance: ${attendee.display_name}`, fields: [{ ...field("present", "Present", "choice", true), options: ["true", "false"], option_labels: { true: "Present", false: "Absent" }, value: String(attendee.present) }] })
        actions.push({ id: "finalize-minutes", title: "Finalize and Distribute Minutes", fields: [] })
      }
    }
    if (moduleId === "inspections") {
      const inspection = await (await import("@/lib/services/inspections")).getInspection(recordId, orgId)
      sections.push(section("checklist", "Checklist", inspection.items, ["prompt"], [field("section", "Section"), field("response", "Response"), field("note", "Note", "multiline"), field("is_deficient", "Deficient")]))
      if (projectId && inspection.status !== "completed" && await allowed(context, "inspection.write", projectId)) {
        for (const item of inspection.items) {
          const options = item.response_type === "pass_fail" ? ["pass", "fail", "n/a"] : item.response_type === "yes_no" ? ["yes", "no", "n/a"] : undefined
          actions.push({ id: `inspection-item:${item.id}`, title: item.prompt, fields: [
            { ...field("response", "Response", options ? "choice" : "text", true), options, value: item.response ?? "" },
            { ...field("note", "Note", "multiline"), value: item.note ?? "" },
          ] })
        }
        actions.push({ id: "complete-inspection", title: "Complete Inspection", fields: [] })
      }
    }
    if (moduleId === "billing") {
      const invoice = await (await import("@/lib/services/invoices")).getInvoiceWithLines(recordId, orgId)
      if (invoice) sections.push(section("invoice-lines", "Invoice Lines", (invoice.lines ?? []).map(line => ({ ...line, amount_cents: Math.round(line.quantity * line.unit_cost_cents) })), ["description"], [field("quantity", "Quantity", "number"), field("unit", "Unit"), field("unit_cost_cents", "Unit price", "money"), field("amount_cents", "Amount", "money")]))
      if (invoice) documents.push(...await attachedFiles(context, [invoice.file_id, typeof invoice.metadata?.latest_pdf_file_id === "string" ? invoice.metadata.latest_pdf_file_id : null]))
      if (invoice) actions.push({ id: "generate-invoice-pdf", title: "Prepare Invoice PDF", fields: [] })
      if (invoice && projectId) {
        if ((await import("@/lib/mobile/workspace-invoices")).canEditMobileInvoice(invoice) && await allowed(context, "invoice.write", projectId)) actions.push({ id: "edit-invoice-draft", title: "Edit Invoice Draft", fields: [] })
        const approval = invoice.approval_status
        if (["draft", "rejected"].includes(approval ?? "") && await allowed(context, "invoice.write", projectId)) actions.push({ id: "request-invoice-review", title: "Request Invoice Review", fields: [field("note", "Review note", "multiline")] })
        if (["draft", "saved"].includes(invoice.status) && ["approved", "not_required"].includes(approval ?? "") && await allowed(context, "invoice.send", projectId)) actions.push({ id: "issue-invoice", title: "Issue and Email Invoice", revision: invoice.updated_at, fields: [{ ...field("recipients", "Recipient emails (separate with commas)", "multiline", true), value: invoice.sent_to_emails?.join(", ") ?? "" }] })
        if (approval === "pending" && await allowed(context, "invoice.send", projectId)) {
          actions.push({ id: "approve-invoice", title: "Approve Invoice", fields: [field("note", "Review note", "multiline")] })
          actions.push({ id: "reject-invoice", title: "Reject Invoice", fields: [field("note", "Reason", "multiline", true)] })
        }
      }
    }
    if (["commitments", "bids", "change-orders"].includes(moduleId)) {
      const document = await (await import("@/lib/mobile/workspace-document-actions")).loadDocumentActions(context, moduleId, projectId, recordId)
      sections.push(...document.sections)
      actions.push(...document.actions)
    }
    if (moduleId === "commitments") {
      const commitment = await (await import("@/lib/services/commitments")).getCommitmentDetail(recordId, orgId)
      sections.push(section("commitment-lines", "Schedule of Values", commitment.lines, ["description"], [field("quantity", "Quantity", "number"), field("unit", "Unit"), field("unit_cost_cents", "Unit cost", "money"), field("total_cents", "Total", "money")]))
      sections.push(section("commitment-changes", "Change Orders", commitment.change_orders, ["title"], [field("status", "Status"), field("total_cents", "Total", "money"), field("reason_label", "Reason")]))
    }
    if (moduleId === "bids") {
      const service = await import("@/lib/services/bids")
      const [scope, submissions] = await Promise.all([service.listBidScopeItems(recordId, orgId), service.listBidSubmissions(recordId, orgId)])
      sections.push(section("bid-scope", "Scope of Work", scope, ["description", "title"], [field("quantity", "Quantity", "number"), field("unit", "Unit"), field("notes", "Notes", "multiline")]))
      sections.push(section("bid-submissions", "Submissions", submissions, ["company_name", "bid_number", "status"], [field("status", "Status"), field("total_cents", "Total", "money"), field("submitted_at", "Submitted", "date"), field("notes", "Notes", "multiline")]))
    }
    if (moduleId === "plans") {
      const plan = await (await import("@/lib/services/house-plans")).getHousePlan(recordId, orgId)
      sections.push(section("elevations", "Elevations", plan.elevations ?? [], ["name", "code"], [field("code", "Code"), field("description", "Description", "multiline")]))
      sections.push(section("versions", "Versions", plan.versions ?? [], ["label", "version"], [field("status", "Status"), field("released_at", "Released", "date"), field("notes", "Notes", "multiline")]))
    }
    if (moduleId === "starts") {
      const pkg = await (await import("@/lib/services/starts")).getStartPackage(recordId, orgId)
      sections.push(section("gates", "Release Gates", pkg.gates, ["label", "name", "key"], [field("status", "Status"), field("notes", "Notes", "multiline"), field("satisfied_at", "Satisfied", "date")]))
      sections.push(section("steps", "Release Steps", pkg.steps, ["stepKey"], [field("status", "Status"), field("completed_at", "Completed", "date"), field("error", "Issue", "multiline")]))
    }
    if (moduleId === "design-studio") {
      const options = await (await import("@/lib/services/selections")).listSelectionOptions(orgId, recordId)
      sections.push(section("options", "Available Options", options, ["name", "title"], [field("description", "Description", "multiline"), field("price_cents", "Price", "money"), field("sku", "SKU")]))
    }
    if (moduleId === "payables") {
      const bill = await (await import("@/lib/mobile/payables")).getMobilePayable(context, recordId)
      if (bill.document?.download_url) documents.push({ id: bill.document.file_id, name: bill.document.file_name ?? "Invoice Document", url: bill.document.download_url })
      sections.push(section("coding", "Cost Coding", bill.coding.lines, ["description", "cost_code_name", "cost_code"], [field("cost_code", "Cost code"), field("project_name", "Project"), field("amount_cents", "Amount", "money")]))
      sections.push(section("review", "Approval Review", [{ id: "summary", title: "Review", vendor_name: bill.vendor_name, outstanding_cents: bill.outstanding_cents, uncoded_cents: bill.coding.uncoded_cents, holds: bill.holds.reasons.join("\n"), evidence: bill.evidence.line_match?.notes.join("\n"), waiver: bill.evidence.waiver_verification?.mismatch_summary }], ["title"], [field("vendor_name", "Vendor"), field("outstanding_cents", "Outstanding", "money"), field("uncoded_cents", "Uncoded", "money"), field("holds", "Holds", "multiline"), field("evidence", "Match notes", "multiline"), field("waiver", "Waiver review", "multiline")]))
      if (bill.can_approve && bill.updated_at && bill.status === "pending") {
        actions.push({ id: "approve-bill", title: "Approve Bill", fields: [], revision: bill.updated_at })
        actions.push({ id: "reject-bill", title: "Reject Bill", fields: [field("reason", "Reason for the vendor", "multiline", true)], revision: bill.updated_at })
      }
    }
    if (moduleId === "reports") {
      const { getReportDefinition } = await import("@/lib/reports/registry")
      const catalog = await import("@/lib/services/report-catalog")
      const definition = getReportDefinition(recordId)
      const resolution = projectId ? await catalog.resolveProjectReportScopeById(projectId) : await catalog.resolveOrgReportScope()
      if (!definition || !resolution || !catalog.canRunReport(resolution, definition)) throw new MobileAPIError(403, "report_forbidden", "This report is not available in this workspace.")
      const { parseReportParams, PERIOD_PRESETS } = await import("@/lib/reports/params")
      const { formatCell, visibleColumns } = await import("@/lib/reports/format")
      // Mobile filters cannot inject saved-layout, division or packet configuration.
      const knownParams = Object.fromEntries((definition.params ?? []).filter(p => p.key in reportParams).map(p => [p.key, reportParams[p.key]]))
      const { result, context: reportContext } = await (await import("@/lib/services/report-workspace")).evaluateReport(definition, { ...resolution.context, params: parseReportParams(definition, knownParams) })
      sections.push(section("report-summary", "Report Summary", [{ id: "summary", title: result.subtitle ?? definition.title, notice: result.notice?.message, commentary: result.commentary, scope: result.provenance?.scope, generated_at: result.provenance?.generatedAt }], ["title"], [field("notice", "Notice", "multiline"), field("scope", "Scope"), field("generated_at", "Generated", "date"), field("commentary", "Commentary", "multiline")]))
      if (result.stats?.length) sections.push(section("report-stats", "Summary Figures", result.stats, ["label"], [field("value", "Value"), field("detail", "Detail")]))
      for (const table of result.tables) {
        const columns = visibleColumns(table.columns)
        const records: ReturnType<typeof workspaceRecord>[] = []
        const visit = (rows: typeof table.rows, depth = 0) => {
          for (const row of rows) {
            records.push({ id: row.key, title: `${"  ".repeat(depth)}${columns[0] ? formatCell(row.cells[columns[0].key], columns[0].type) : row.key}`, status: row.emphasis ?? null,
              fields: columns.slice(1).map(col => ({ key: col.key, label: col.header, kind: "text" as const, value: formatCell(row.cells[col.key], col.type) })) })
            if (row.children) visit(row.children, depth + 1)
          }
        }
        visit(table.rows)
        if (table.totals) records.push({ id: "__totals", title: "Total", status: "total", fields: columns.map(col => ({ key: col.key, label: col.header, kind: "text", value: formatCell(table.totals?.[col.key], col.type) })) })
        if (table.cap) records.unshift({ id: "__cap", title: `Showing ${table.cap.shown} of ${table.cap.total} rows`, status: "partial", fields: [] })
        sections.push({ id: table.key, title: table.title ?? definition.title, records })
      }
      const fields: Field[] = (definition.params ?? []).map(param => {
        if (param.kind === "date") return { ...field(param.key, param.label, "date"), value: reportContext.params[param.key] }
        const options = param.kind === "period" ? PERIOD_PRESETS.filter(p => p.value !== "custom") : param.kind === "select" ? param.options : [{ value: "0", label: "No" }, { value: "1", label: "Yes" }]
        return { ...field(param.key, param.label, "choice", true), options: options.map(o => o.value), option_labels: Object.fromEntries(options.map(o => [o.value, o.label])), value: reportContext.params[param.key] }
      })
      if (fields.length) actions.push({ id: "report-filters", title: "Report Filters", fields })
    }
    if (moduleId === "ledger") {
      const lines = (row as { lines?: unknown[] }).lines ?? []
      sections.push(section("lines", "Journal Lines", lines, ["accountName", "accountCode", "description"], [field("debit_cents", "Debit", "money"), field("credit_cents", "Credit", "money"), field("memo", "Memo", "multiline")]))
    }
    return { record: workspaceRecord(workspaceModule, row, 0), sections, actions, documents }
  })
}

export async function performWorkspaceAction(context: MobileOrgContext, moduleId: string, projectId: string | undefined, recordId: string, actionId: string, values: Record<string, string>, expectedRevision?: string) {
  const detail = await loadWorkspaceRecordDetail(context, moduleId, projectId, recordId)
  const action = detail.actions.find(action => action.id === actionId)
  if (!action) throw new MobileAPIError(403, "action_forbidden", "This action is no longer available. Refresh the record.")
  if (action.revision && action.revision !== expectedRevision) throw new MobileAPIError(409, "record_changed", "This record changed since you opened it. Refresh and review the latest version.")
  const input: Record<string, string> = {}
  for (const f of action.fields) {
    const value = values[f.key]?.trim() ?? ""
    if (f.required && !value) throw new MobileAPIError(422, "missing_field", `${f.label} is required.`)
    if (f.options && !f.options.includes(value)) throw new MobileAPIError(422, "invalid_option", `Choose a valid ${f.label.toLowerCase()}.`)
    input[f.key] = value
  }
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const orgId = context.orgId
    if (moduleId === "estimates" && projectId) return (await import("@/lib/mobile/workspace-estimates")).performEstimateAction(context, projectId, recordId, actionId, input, expectedRevision)
    if (moduleId === "pipeline") return (await import("@/lib/mobile/workspace-precon")).performProspectAction(context, recordId, actionId, input, expectedRevision)
    if (["commitments", "bids", "change-orders"].includes(moduleId)) return (await import("@/lib/mobile/workspace-document-actions")).performDocumentAction(context, moduleId, recordId, actionId, input)
    if (["period-close", "chart", "banking", "bank-transactions", "bank-reconciliations"].includes(moduleId)) return (await import("@/lib/mobile/workspace-books")).performBooksAction(context, moduleId, recordId, actionId, input)
    if (moduleId === "signatures") {
      const service = await import("@/app/(app)/signatures/actions")
      const result = actionId === "void-envelope"
        ? await service.voidEnvelopeAction({ envelopeId: recordId, reason: input.reason })
        : await service.sendDocumentSigningReminderAction(actionId.split(":")[1])
      if (!result.success) throw new MobileAPIError(422, "signature_action_failed", result.error)
      return result.data
    }
    if (moduleId === "payables") {
      return (await import("@/lib/mobile/payables")).decideMobilePayable(context, recordId, { decision: actionId === "approve-bill" ? "approved" : "rejected", expected_updated_at: expectedRevision, reason: input.reason })
    }
    if (moduleId === "correspondence" && projectId) {
      const service = await import("@/lib/services/correspondence")
      if (actionId === "confirm-classification") return service.confirmProjectEmailClassifications({ projectId, emailIds: [recordId] }, orgId)
      const { reclassifySchema } = await import("@/lib/validation/correspondence")
      return service.reclassifyProjectEmails(reclassifySchema.parse({ projectId, emailIds: [recordId], classification: input.classification }), orgId)
    }
    if (moduleId === "billing") {
      const service = await import("@/lib/services/invoices")
      if (actionId === "generate-invoice-pdf") {
        const result = await (await import("@/app/(app)/invoices/actions")).generateInvoicePdfAction(recordId, { persistToArc: true })
        if (!result.success) throw new MobileAPIError(422, "invoice_pdf_failed", result.error)
        return { prepared: true }
      }
      if (actionId === "issue-invoice") {
        const { z } = await import("zod")
        const recipients = z.array(z.string().email()).min(1).max(50).parse(input.recipients.split(/[,;\n]/).map(value => value.trim()).filter(Boolean))
        return service.issueInvoice({ invoiceId: recordId, recipients, orgId })
      }
      if (actionId === "request-invoice-review") return service.requestInvoiceApproval({ invoiceId: recordId, note: input.note, orgId })
      return service.decideInvoiceApproval({ invoiceId: recordId, decision: actionId === "approve-invoice" ? "approved" : "rejected", note: input.note, orgId })
    }
    if (moduleId === "time") {
      const service = await import("@/lib/services/cost-plus")
      if (actionId === "approve-time") return service.approveTimeEntry(recordId, orgId)
      if (actionId === "reject-time") return service.rejectTimeEntry(recordId, { rejectionReason: input.reason }, orgId)
      if (actionId === "edit-time-notes") return service.updateTimeEntry(recordId, { notes: input.notes }, orgId)
    }
    if (["tasks", "punch"].includes(moduleId) && actionId === "attach-file" && projectId) {
      const { z } = await import("zod")
      const fileId = z.string().uuid().parse(input.file_id)
      // Require exact project ownership, including files that have no project.
      const { data: file, error } = await context.serviceSupabase.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).eq("id", fileId).is("archived_at", null).maybeSingle()
      if (error || !file) throw new MobileAPIError(404, "file_not_found", "Choose a file from this project.")
      return (await import("@/lib/services/file-links")).attachFile({ file_id: fileId, project_id: projectId, entity_type: moduleId === "tasks" ? "task" : "punch_item", entity_id: recordId }, orgId)
    }
    if (moduleId === "tasks" && projectId) {
      const result = await (await import("@/app/(app)/tasks/actions")).updateMyTaskAction(recordId, actionId === "assign-task" ? { assignee_id: input.user_id, assignee_kind: "user" } : { clear_assignee: true })
      if (!result.success) throw new MobileAPIError(422, "assignment_failed", result.error)
      return result.data
    }
    if (moduleId === "schedule" && projectId) {
      const service = await import("@/lib/services/schedule")
      if (actionId.startsWith("remove-dependency:")) return service.deleteDependency(actionId.split(":")[1], orgId)
      const { scheduleDependencyInputSchema } = await import("@/lib/validation/schedule")
      if (actionId === "add-predecessor") return service.createDependency(scheduleDependencyInputSchema.parse({ ...input, item_id: recordId, lag_days: Number(input.lag_days) }), projectId, orgId)
      const parsed = scheduleDependencyInputSchema.pick({ dependency_type: true, lag_days: true }).parse({ ...input, lag_days: Number(input.lag_days) })
      return service.updateDependency(actionId.split(":")[1], parsed, projectId, orgId)
    }
    if (moduleId === "punch" && projectId) {
      const result = await (await import("@/app/(app)/projects/[id]/actions")).updateProjectPunchItemAction(projectId, recordId, { assigned_company_id: actionId === "assign-punch-company" ? input.company_id : null })
      if (!result.success) throw new MobileAPIError(422, "punch_assignment_failed", result.error)
      return result.data
    }
    if (moduleId === "transmittals" && actionId === "send-transmittal") return (await import("@/lib/services/transmittals")).sendTransmittal(recordId, orgId)
    if (moduleId === "warranty") {
      const service = await import("@/lib/services/warranty")
      if (actionId === "acknowledge-warranty") return service.acknowledgeWarrantyRequest({ request_id: recordId, ...input }, orgId)
      return service.updateWarrantyRequest({ requestId: recordId, input: { status: actionId === "resolve-warranty" ? "resolved" : "open", ...(actionId === "resolve-warranty" ? { resolution_note: input.resolution_note } : {}) }, orgId })
    }
    if (moduleId === "rfis") {
      const service = await import("@/lib/services/rfis")
      if (actionId === "respond") return service.addRfiResponse({ orgId, input: (await import("@/lib/validation/rfis")).rfiResponseInputSchema.parse({ rfi_id: recordId, body: input.body, response_type: "comment" }) })
      if (actionId === "close") return service.closeRfi({ orgId, rfiId: recordId })
      if (actionId === "reopen") return service.reopenRfi({ orgId, rfiId: recordId })
    }
    if (moduleId === "submittals") {
      const service = await import("@/lib/services/submittals"), schemas = await import("@/lib/validation/submittals")
      if (actionId === "add-submittal-item") return service.addSubmittalItem({ orgId, input: schemas.submittalItemInputSchema.parse({ ...input, submittal_id: recordId }) })
      if (actionId === "submit-submittal") return service.updateSubmittal({ orgId, input: { submittal_id: recordId, status: "submitted" } })
      if (actionId === "resubmit-submittal") return service.resubmitSubmittal({ orgId, submittalId: recordId })
      if (actionId.startsWith("review-step:")) return service.decideSubmittalReviewStep({ orgId, input: schemas.decideSubmittalReviewStepSchema.parse({ ...input, step_id: actionId.split(":")[1] }) })
      if (actionId === "review-submittal") return service.decideSubmittal({ orgId, input: schemas.submittalDecisionSchema.parse({ ...input, submittal_id: recordId }) })
    }
    if (moduleId === "meetings") {
      const service = await import("@/lib/services/meetings"), schemas = await import("@/lib/validation/meetings")
      if (actionId === "finalize-minutes") return service.finalizeMeeting(recordId, orgId)
      if (actionId === "distribute-minutes") {
        const { z } = await import("zod")
        const emails = z.array(z.string().email()).min(1).max(50).parse(input.recipients.split(/[,;\n]/).map(value => value.trim()).filter(Boolean))
        return service.distributeMeetingMinutes({ meetingId: recordId, recipients: emails.map(email => ({ email })), orgId })
      }
      if (actionId.startsWith("attendance:")) return service.updateMeetingAttendee(actionId.split(":")[1], { present: input.present === "true" }, orgId)
      if (actionId === "add-item" || actionId.startsWith("meeting-item:")) {
        const parsed = schemas.meetingItemSchema.parse({ ...input, meeting_id: recordId, due_date: input.due_date || null })
        if (actionId === "add-item") return service.addMeetingItem(parsed, orgId)
        return service.updateMeetingItem(actionId.split(":")[1], parsed, orgId)
      }
      if (actionId === "add-attendee") return service.addMeetingAttendee(schemas.meetingAttendeeSchema.parse({ ...input, meeting_id: recordId, email: input.email || null }), orgId)
    }
    if (moduleId === "inspections") {
      const service = await import("@/lib/services/inspections")
      if (actionId === "complete-inspection") return service.completeInspection(recordId, orgId)
      if (actionId.startsWith("inspection-item:")) return service.updateInspectionItem(actionId.split(":")[1], { response: input.response, note: input.note }, orgId)
    }
    throw new MobileAPIError(405, "action_unavailable", "This action is not supported.")
  })
}
