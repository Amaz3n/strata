import "server-only"
import { invoiceWaiverContentHash } from "@/lib/lien-waivers/invoice-content"
import { listEditableWaiverTemplates, COMPANY_WAIVER_TEMPLATE_FOLDER } from "@/lib/services/company-waiver-templates"
import { waiverTemplateSchema } from "@/lib/templates/waiver-template"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { getInvoicePaymentActivity } from "@/lib/services/payments"
import { recordAudit } from "@/lib/services/audit"
import { storeGeneratedPdf } from "@/lib/services/generated-documents"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { locationState } from "@/lib/lien-waivers/jurisdiction"
import { inspectWaiverPdf, renderArcInvoiceWaiver, renderCustomInvoiceWaiver } from "@/lib/pdfs/invoice-waiver-document"
import {
  availableWaiverPayments, prepareWaiverSchema, readWaiverWorkflow, templateInputSchema,
  waiverThroughDate, waiverPaymentIds, WAIVER_CONSENT, WAIVER_PDF_LIMIT, WAIVER_TEMPLATE_FOLDER,
  type InvoiceWaiverWorkflow, type PrepareWaiverInput, type WaiverTemplate, type WaiverTemplateInput,
} from "@/lib/lien-waivers/invoice-waiver"
import type { InvoiceLienWaiver } from "@/lib/types"

const SELECT = "id,org_id,project_id,invoice_id,waiver_type,status,amount_cents,through_date,claimant_name,customer_name,property_description,released_at,created_at,metadata"

export async function invoiceWaiverContext(invoiceId: string, permission = "invoice.write") {
  z.string().uuid().parse(invoiceId)
  const context = await requireOrgContext()
  const { data: invoice, error } = await context.supabase.from("invoices")
    .select("id,project_id,invoice_number,status,total_cents,balance_due_cents,billing_period_id,metadata,updated_at,currency,title,notes,subtotal_cents,tax_cents")
    .eq("org_id", context.orgId).eq("id", invoiceId).maybeSingle()
  if (error || !invoice) throw new Error("Invoice not found")
  await requireAuthorization({ ...context, permission, projectId: invoice.project_id ?? undefined,
    resourceType: "invoice", resourceId: invoiceId, logDecision: true })
  return { ...context, invoice }
}

function propertyText(location: unknown): string {
  if (typeof location === "string") return location
  if (!location || typeof location !== "object") return ""
  const v = location as Record<string, unknown>
  if (typeof v.address === "string" && v.address.trim()) return v.address
  if (typeof v.formatted === "string" && v.formatted.trim()) return v.formatted
  // A project's city/state alone is not a property or lot description.
  if (typeof v.street1 !== "string" || !v.street1.trim()) return ""
  return [v.street1, v.city, v.state, v.postal_code].filter((part) => typeof part === "string" && part.trim()).join(", ")
}

export async function loadInvoiceWaiverPreparation(invoiceId: string) {
  const ctx = await invoiceWaiverContext(invoiceId)
  const { supabase, orgId, userId, invoice } = ctx
  const [org, project, user, period, templates, activity, admin] = await Promise.all([
    supabase.from("orgs").select("name").eq("id", orgId).single(),
    invoice.project_id ? supabase.from("projects").select("name,location").eq("org_id", orgId).eq("id", invoice.project_id).single() : Promise.resolve({ data: null, error: null }),
    supabase.from("app_users").select("full_name").eq("id", userId).single(),
    invoice.billing_period_id ? supabase.from("project_billing_periods").select("period_end").eq("org_id", orgId).eq("id", invoice.billing_period_id).single() : Promise.resolve({ data: null, error: null }),
    listBillingTemplates(ctx), getInvoicePaymentActivity(invoiceId, orgId),
    authorize({ ...ctx, permission: "org.admin" }),
  ])
  for (const result of [org, project, user, period]) if (result.error) throw new Error("Could not load waiver details. Please try again.")
  return {
    project_name: project.data?.name ?? "", claimant_name: org.data?.name ?? "", customer_name: invoice.metadata?.customer_name ?? "",
    owner_name: invoice.metadata?.owner_name ?? invoice.metadata?.customer_name ?? "",
    property_description: propertyText(project.data?.location), jurisdiction: locationState(project.data?.location) ?? "",
    signer_name: user.data?.full_name ?? "", through_date: waiverThroughDate(invoice, period.data?.period_end),
    templates, payments: availableWaiverPayments(activity.payments, activity.reversals),
    can_manage_company_templates: admin.allowed,
  }
}

type Context = Awaited<ReturnType<typeof invoiceWaiverContext>>
async function listTemplates(ctx: Context): Promise<WaiverTemplate[]> {
  let query = ctx.supabase.from("files").select("id,project_id,metadata,created_at")
    .eq("org_id", ctx.orgId).eq("folder_path", WAIVER_TEMPLATE_FOLDER).is("archived_at", null)
  query = ctx.invoice.project_id ? query.or(`project_id.is.null,project_id.eq.${ctx.invoice.project_id}`) : query.is("project_id", null)
  const { data, error } = await query.order("created_at", { ascending: false }).limit(200)
  if (error) throw new Error("Could not load waiver templates")
  const seen = new Set<string>()
  return (data ?? []).flatMap((row) => {
    const raw = row.metadata?.waiver_template
    const parsed = templateInputSchema.safeParse(raw)
    if (!parsed.success) return []
    const family = parsed.data.family_id ?? row.id
    if (seen.has(family)) return []
    seen.add(family)
    return [{ ...parsed.data, id: row.id, version: Number(raw.version) || 1, created_at: row.created_at, project_id: row.project_id }]
  })
}

async function listBillingTemplates(ctx: Context): Promise<WaiverTemplate[]> {
  const [legacy, editable] = await Promise.all([listTemplates(ctx), listEditableWaiverTemplates(ctx, {publishedOnly:true, direction:"outgoing"})]);
  return [...editable.map(t => ({id:t.id,name:t.name,waiver_type:t.waiverType,scope:"company" as const,preferred:false,family_id:t.familyId,fields:[],version:t.revision ?? 1,created_at:t.createdAt,project_id:null,editable:t,status:t.status})), ...legacy];
}
async function loadBillingTemplate(ctx: Context, id: string) {
  const {data,error} = await ctx.supabase.from("files").select("id,project_id,storage_path,metadata,archived_at,folder_path").eq("org_id",ctx.orgId).eq("id",z.string().uuid().parse(id)).maybeSingle();
  if(error || !data || data.archived_at) throw new Error("Template unavailable");
  if(data.folder_path !== COMPANY_WAIVER_TEMPLATE_FOLDER) return loadTemplate(ctx,id);
  const editable = waiverTemplateSchema.parse(data.metadata?.editable_waiver);
  if(editable.status !== "published") throw new Error("Publish this template in Settings before preparing a waiver");
  if (editable.applicability === "incoming") throw new Error("Choose an outgoing waiver template");
  return {...data, version:Number(data.metadata?.editable_waiver?.revision) || 1, editable, template:{name:editable.name,waiver_type:editable.waiverType,fields:[]}};
}

async function loadTemplate(ctx: Context, id: string) {
  const { data, error } = await ctx.supabase.from("files").select("id,project_id,storage_path,metadata,archived_at")
    .eq("org_id", ctx.orgId).eq("id", z.string().uuid().parse(id)).eq("folder_path", WAIVER_TEMPLATE_FOLDER).maybeSingle()
  if (error || !data || data.archived_at || (data.project_id && data.project_id !== ctx.invoice.project_id)) throw new Error("Template not available for this project")
  const template = templateInputSchema.parse(data.metadata?.waiver_template)
  return { ...data, template, version: Number(data.metadata?.waiver_template?.version) || 1 }
}

export async function saveInvoiceWaiverTemplate(invoiceId: string, raw: WaiverTemplateInput, file?: File) {
  const ctx = await invoiceWaiverContext(invoiceId)
  const input = templateInputSchema.parse(raw)
  if (input.scope === "company") await requireAuthorization({ ...ctx, permission: "org.admin", logDecision: true })
  if (input.scope === "project" && !ctx.invoice.project_id) throw new Error("Choose a project before saving a project template")
  let previous: Awaited<ReturnType<typeof loadTemplate>> | null = null
  if (input.family_id) {
    const templates = await listTemplates(ctx)
    const latest = templates.find((t) => (t.family_id ?? t.id) === input.family_id)
    if (!latest) throw new Error("Template no longer available")
    previous = await loadTemplate(ctx, latest.id)
    if (previous.template.scope !== input.scope) throw new Error("Keep the same scope when revising a template")
  }
  const bytes = file ? await pdfFileBytes(file) : previous ? await downloadFilesObject({ ...ctx, path: previous.storage_path }) : null
  if (!bytes) throw new Error("Choose a PDF")
  const pdf = await inspectWaiverPdf(bytes)
  for (const field of input.fields) {
    if (field.page >= pdf.getPageCount()) throw new Error("A field refers to a missing page")
    if (pdf.getPage(field.page).getRotation().angle !== 0) throw new Error("Apply page rotation before mapping this PDF")
  }
  const familyId = input.family_id ?? randomUUID()
  const version = (previous?.version ?? 0) + 1
  const stored = await storeGeneratedPdf({ orgId: ctx.orgId, projectId: input.scope === "project" ? ctx.invoice.project_id : null,
    pdf: bytes, fileName: `${input.name}-v${version}.pdf`, storageFolder: "waiver-templates", folderPath: WAIVER_TEMPLATE_FOLDER,
    description: input.name, createdBy: ctx.userId,
    metadata: { waiver_template: { ...input, family_id: familyId, version } }, supabase: ctx.supabase })
  await recordAudit({ orgId: ctx.orgId, actorId: ctx.userId, action: "insert", entityType: "waiver_template", entityId: stored.fileId,
    after: { name: input.name, family_id: familyId, version } })
  return listTemplates(ctx)
}

async function pdfFileBytes(file: File) {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size || file.size > WAIVER_PDF_LIMIT) throw new Error("Choose a PDF smaller than 15 MB")
  const bytes = Buffer.from(await file.arrayBuffer())
  await inspectWaiverPdf(bytes)
  return bytes
}

async function assertPayment(ctx: Context, paymentIds: string[], amount: number) {
  const activity = await getInvoicePaymentActivity(ctx.invoice.id, ctx.orgId)
  const ids = [...new Set(paymentIds)]
  const payments = availableWaiverPayments(activity.payments, activity.reversals).filter((p) => ids.includes(p.id))
  if (!ids.length || payments.length !== ids.length || payments.reduce((sum, p) => sum + p.available_cents, 0) < amount) {
    throw new Error("The selected payment no longer covers this waiver. Review the payment and any returns.")
  }
  return payments
}

function assertInvoiceOpen(ctx: Context) {
  if (ctx.invoice.status === "void") throw new Error("This invoice has been voided")
  if (ctx.invoice.currency?.trim().toUpperCase() !== "USD") throw new Error("Waiver preparation currently supports USD invoices")
}

export async function prepareInvoiceWaiver(raw: PrepareWaiverInput, file?: File) {
  const input = prepareWaiverSchema.parse(raw)
  const ctx = await invoiceWaiverContext(input.invoice_id)
  assertInvoiceOpen(ctx)
  const { data: existing } = await ctx.supabase.from("invoice_lien_waivers").select(SELECT)
    .eq("org_id", ctx.orgId).eq("id", input.request_id).maybeSingle()
  if (existing) {
    if (existing.invoice_id !== input.invoice_id) throw new Error("Invalid preparation request")
    if (existing.status === "void") throw new Error("This draft was discarded. Prepare a new waiver.")
    return existing as InvoiceLienWaiver
  }
  if (input.amount_cents > Number(ctx.invoice.total_cents)) throw new Error("The waiver amount exceeds this invoice. Review the amount covered.")
  if (input.signed_date && input.signed_date > new Date().toISOString().slice(0, 10)) throw new Error("The signature date cannot be in the future")
  if (waiverPaymentIds(input).length) await assertPayment(ctx, waiverPaymentIds(input), input.amount_cents)
  const template = input.source === "template" ? await loadBillingTemplate(ctx, input.template_id!) : null
  if(template && "editable" in template && template.editable?.jurisdiction && template.editable.jurisdiction !== input.jurisdiction)throw new Error("Choose a template matching the property state")
  if (template && template.template.waiver_type !== input.waiver_type) throw new Error("Choose a template matching the waiver type")
  let bytes: Buffer
  if (input.source === "upload") {
    if (file) bytes = await pdfFileBytes(file)
    else if (input.replaces_draft_id) {
      const previous = await getInvoiceWaiverRecord(input.invoice_id, input.replaces_draft_id, "invoice.write")
      const original = readWaiverWorkflow(previous.waiver)
      if (!original || original.source !== "upload" || original.lifecycle !== "draft" || previous.waiver.status === "void") throw new Error("Choose the signed PDF")
      bytes = await downloadFilesObject({ ...ctx, path: original.document_path })
    } else throw new Error("Choose the signed PDF")
  } else if (template) {
    bytes = "editable" in template ? await (await import("@/lib/pdfs/editable-invoice-waiver")).renderEditableInvoiceWaiver(template.editable, input, ctx.invoice.invoice_number) : await renderCustomInvoiceWaiver(await downloadFilesObject({ ...ctx, path: template.storage_path }), template.template.fields, input, ctx.invoice.invoice_number)
  } else {
    if (!["CA", "FL", "TX"].includes(input.jurisdiction)) throw new Error("Use your company or project form for this jurisdiction")
    bytes = await renderArcInvoiceWaiver(input, ctx.invoice.invoice_number, input.request_id)
  }
  if (input.replaces_draft_id) {
    const previous = await getInvoiceWaiverRecord(input.invoice_id, input.replaces_draft_id, "invoice.write")
    if (readWaiverWorkflow(previous.waiver)?.signing_document_id) throw new Error("This waiver is already in signing. Prepare a separate waiver instead.")
  }
  const stored = await saveDocument(ctx, bytes, input.request_id, "draft")
  const workflow: InvoiceWaiverWorkflow = {
    version: 2, lifecycle: "draft", source: input.source, input, shared: false,
    document_path: stored.storagePath, file_id: stored.fileId, file_name: `waiver-${ctx.invoice.invoice_number}.pdf`,
    sha256: createHash("sha256").update(bytes).digest("hex"), prepared_at: new Date().toISOString(),
    invoice_revision: ctx.invoice.updated_at ?? null, invoice_content_hash: invoiceWaiverContentHash(ctx.invoice),
    ...(template ? { template_name: template.template.name, template_version: template.version,
      template_path: template.storage_path, fields: template.template.fields, ...("editable" in template ? {editable_template:template.editable} : {}) } : {}),
  }
  const { data, error } = await ctx.supabase.from("invoice_lien_waivers").insert({
    id: input.request_id, org_id: ctx.orgId, project_id: ctx.invoice.project_id, invoice_id: input.invoice_id,
    waiver_type: input.waiver_type, status: "pending_payment", amount_cents: input.amount_cents,
    through_date: input.through_date, claimant_name: input.claimant_name, customer_name: input.customer_name,
    property_description: input.property_description, created_by: ctx.userId, metadata: { workflow },
  }).select(SELECT).single()
  if (error || !data) {
    if (error?.code === "23505") {
      const { data: retried } = await ctx.supabase.from("invoice_lien_waivers").select(SELECT).eq("org_id", ctx.orgId).eq("invoice_id", input.invoice_id).eq("id", input.request_id).single()
      if (retried) return retried as InvoiceLienWaiver
    }
    throw new Error("Could not save the waiver draft")
  }
  if (input.replaces_draft_id && input.replaces_draft_id !== input.request_id) {
    // Only an unsigned draft on this invoice may be replaced. Signed history
    // cannot be discarded by sending an arbitrary replacement ID.
    await ctx.supabase.from("invoice_lien_waivers").update({ status: "void", updated_at: new Date().toISOString() })
      .eq("org_id", ctx.orgId).eq("invoice_id", input.invoice_id).eq("id", input.replaces_draft_id)
      .eq("metadata->workflow->>lifecycle", "draft").is("metadata->workflow->>signing_document_id", null).eq("status", "pending_payment")
  }
  await recordAudit({ orgId: ctx.orgId, actorId: ctx.userId, action: "insert", entityType: "invoice_lien_waiver", entityId: data.id,
    after: { lifecycle: "draft", source: input.source, sha256: workflow.sha256 } })
  return data as InvoiceLienWaiver
}

async function saveDocument(ctx: Context, bytes: Buffer, waiverId: string, stage: string) {
  return storeGeneratedPdf({ orgId: ctx.orgId, projectId: ctx.invoice.project_id, pdf: bytes,
    fileName: `waiver-${ctx.invoice.invoice_number}-${waiverId}-${stage}.pdf`, storageFolder: `invoice-waivers/${waiverId}/${randomUUID()}`,
    folderPath: "/Financials/Lien waivers", description: `Invoice ${ctx.invoice.invoice_number} waiver`,
    createdBy: ctx.userId, supabase: ctx.supabase })
}

export async function getInvoiceWaiverRecord(invoiceId: string, waiverId: string, permission = "invoice.read") {
  const ctx = await invoiceWaiverContext(invoiceId, permission)
  const { data, error } = await ctx.supabase.from("invoice_lien_waivers").select(SELECT)
    .eq("org_id", ctx.orgId).eq("invoice_id", invoiceId).eq("id", z.string().uuid().parse(waiverId)).maybeSingle()
  if (error || !data) throw new Error("Waiver not found")
  return { ctx, waiver: data as InvoiceLienWaiver }
}

export async function finalizeInvoiceWaiver(invoiceId: string, waiverId: string, consent: boolean, shared: boolean) {
  z.boolean().parse(shared)
  if (consent !== true) throw new Error("Confirm that you reviewed the waiver")
  const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
  assertInvoiceOpen(ctx)
  const workflow = readWaiverWorkflow(waiver)
  if (!workflow || waiver.status === "void") throw new Error("This waiver cannot be signed")
  if (workflow.lifecycle === "signed") return waiver
  if (workflow.editable_template || workflow.signing_document_id) throw new Error("Complete this waiver through native document signing")
  if (workflow.invoice_revision !== (ctx.invoice.updated_at ?? null)) throw new Error("The invoice changed after this draft was prepared. Prepare a new waiver with the current details.")
  const input = prepareWaiverSchema.parse(workflow.input)
  const paymentIds = waiverPaymentIds(input)
  if (paymentIds.length) await assertPayment(ctx, paymentIds, input.amount_cents)
  const signedAt = new Date().toISOString()
  let signedWorkflow = { ...workflow }
  if (input.source !== "upload") {
    const bytes = input.source === "template"
      ? await renderCustomInvoiceWaiver(await downloadFilesObject({ ...ctx, path: workflow.template_path! }), workflow.fields!, input, ctx.invoice.invoice_number, signedAt)
      : await renderArcInvoiceWaiver(input, ctx.invoice.invoice_number, waiver.id, signedAt)
    const stored = await saveDocument(ctx, bytes, waiver.id, "signed")
    signedWorkflow = { ...signedWorkflow, document_path: stored.storagePath, file_id: stored.fileId, sha256: createHash("sha256").update(bytes).digest("hex") }
  }
  signedWorkflow = { ...signedWorkflow, lifecycle: "signed", shared, signed_at: input.source === "upload" ? input.signed_date : signedAt,
    ...(input.source === "upload" ? { recorded_by: ctx.userId, recorded_at: signedAt } : { signed_by: ctx.userId }),
    consent: input.source === "upload" ? "Uploader confirmed the document is signed and the recorded details match." : WAIVER_CONSENT,
    payment_id: paymentIds[0], payment_ids: paymentIds }
  const { data, error } = await ctx.supabase.from("invoice_lien_waivers").update({
    metadata: { ...waiver.metadata, workflow: signedWorkflow }, status: paymentIds.length ? "released" : "pending_payment",
    released_at: paymentIds.length ? signedAt : null, released_by_payment_id: paymentIds[0] ?? null,
    updated_at: signedAt,
  }).eq("org_id", ctx.orgId).eq("id", waiver.id).eq("status", "pending_payment")
    .eq("metadata->workflow->>lifecycle", "draft").select(SELECT).maybeSingle()
  if (error) throw new Error("Could not finish the waiver")
  if (!data) return (await getInvoiceWaiverRecord(invoiceId, waiverId)).waiver
  await recordAudit({ orgId: ctx.orgId, actorId: ctx.userId, action: "update", entityType: "invoice_lien_waiver", entityId: waiver.id,
    after: { source: input.source, signer_name: input.signer_name, signed_at: signedWorkflow.signed_at, recorded_at: signedAt, shared, sha256: signedWorkflow.sha256, consent: signedWorkflow.consent } })
  return data as InvoiceLienWaiver
}

export async function updateInvoiceWaiverSharing(invoiceId: string, waiverId: string, shared: boolean) {
  z.boolean().parse(shared)
  const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
  assertInvoiceOpen(ctx)
  const workflow = readWaiverWorkflow(waiver)
  if (!workflow || workflow.lifecycle !== "signed" || waiver.status === "void") throw new Error("Only signed waivers can be shared")
  if (shared && workflow.needs_review) throw new Error("The invoice or payment changed during signing. Prepare a new waiver before sharing.")
  const { data, error } = await ctx.supabase.from("invoice_lien_waivers").update({ metadata: { ...waiver.metadata, workflow: { ...workflow, shared } } })
    .eq("org_id", ctx.orgId).eq("id", waiverId).eq("metadata", JSON.stringify(waiver.metadata)).select(SELECT).maybeSingle()
  if (error || !data) throw new Error("The waiver changed. Refresh and try again.")
  await recordAudit({ orgId: ctx.orgId, actorId: ctx.userId, action: "update", entityType: "invoice_lien_waiver", entityId: waiverId, after: { shared } })
  return data as InvoiceLienWaiver
}

export async function matchInvoiceWaiverPayment(invoiceId: string, waiverId: string, paymentId: string | string[], confirmed: boolean) {
  if (confirmed !== true) throw new Error("Confirm that the covered funds were received")
  const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
  assertInvoiceOpen(ctx)
  const workflow = readWaiverWorkflow(waiver)
  if (!workflow || workflow.lifecycle !== "signed" || waiver.status === "void") throw new Error("Choose a signed waiver")
  const paymentIds = z.array(z.string().uuid()).min(1).max(100).parse(Array.isArray(paymentId) ? paymentId : [paymentId])
  await assertPayment(ctx, paymentIds, waiver.amount_cents)
  const { data, error } = await ctx.supabase.from("invoice_lien_waivers").update({
    status: "released", released_at: new Date().toISOString(), released_by_payment_id: paymentIds[0],
    metadata: { ...waiver.metadata, workflow: { ...workflow, payment_id: paymentIds[0], payment_ids: [...new Set(paymentIds)] } },
  }).eq("org_id", ctx.orgId).eq("id", waiverId).eq("metadata", JSON.stringify(waiver.metadata)).select(SELECT).maybeSingle()
  if (error || !data) throw new Error("The waiver changed. Refresh and try again.")
  await recordAudit({ orgId: ctx.orgId, actorId: ctx.userId, action: "update", entityType: "invoice_lien_waiver", entityId: waiverId, after: { payment_ids: paymentIds, funds_received_confirmed: true } })
  return data as InvoiceLienWaiver
}

export async function getInvoiceWaiverTemplateBytes(invoiceId: string, templateId: string) {
  const ctx = await invoiceWaiverContext(invoiceId)
  const template = await loadBillingTemplate(ctx, templateId)
  return downloadFilesObject({ ...ctx, path: template.storage_path })
}

export async function startInvoiceWaiverSigning(invoiceId:string,waiverId:string,shared:boolean, packet = false) {
 z.boolean().parse(shared)
 z.boolean().parse(packet)
 const {ctx,waiver}=await getInvoiceWaiverRecord(invoiceId,waiverId,"invoice.write")
 assertInvoiceOpen(ctx)
 const workflow=readWaiverWorkflow(waiver)
 if(!workflow||waiver.status==="void")throw new Error("This waiver is unavailable")
 if(workflow.signing_document_id){
  const {data,error}=await ctx.supabase.from("documents").select("id,status,metadata").eq("org_id",ctx.orgId).eq("id",workflow.signing_document_id).single()
  if(error||!data)throw new Error("Signing document unavailable")
  if(packet && data.status==="draft" && data.metadata?.delivery_mode!=="invoice_packet") {
   const {error: modeError}=await ctx.supabase.from("documents").update({metadata:{...data.metadata,delivery_mode:"invoice_packet"}}).eq("org_id",ctx.orgId).eq("id",data.id).eq("status","draft")
   if(modeError)throw new Error("Could not prepare the signing workspace")
  }
  return {documentId:data.id as string,status:data.status as string,waiver}
 }
 if(workflow.lifecycle!=="draft")throw new Error("This waiver is already signed")
 if(workflow.invoice_content_hash ? workflow.invoice_content_hash!==invoiceWaiverContentHash(ctx.invoice) : workflow.invoice_revision!==(ctx.invoice.updated_at??null))throw new Error("The invoice changed. Prepare a new waiver with the current details.")
 const input=prepareWaiverSchema.parse(workflow.input)
 if(waiverPaymentIds(input).length)await assertPayment(ctx,waiverPaymentIds(input),input.amount_cents)
 if(input.source==="upload"||input.source==="arc")throw new Error("Prepare a new waiver using a company template to use native signing.")
 const {createDocument,replaceDocumentFields}=await import("@/lib/services/documents")
 const bytes=await downloadFilesObject({...ctx,path:workflow.document_path})
 const fields=workflow.editable_template
  ? await (await import("@/lib/pdfs/waiver-signature-fields")).waiverSignatureFields(bytes, (workflow.editable_template.body.match(/\{\{signed_date\}\}/g) ?? []).length)
  : (workflow.fields??[]).filter(f=>f.key==="signer_name"||f.key==="signed_date").map(f=>({page_index:f.page,field_type:f.key==="signer_name"?"signature" as const:"date" as const,label:f.key==="signer_name"?"Authorized signature":"Date signed",required:true,signer_role:"claimant",x:f.x,y:f.y,w:f.width,h:f.height}))
 const {data:user}=await ctx.supabase.from("app_users").select("email").eq("id",ctx.userId).single()
 const document=await createDocument({project_id:ctx.invoice.project_id??undefined,document_type:"other",title:`Waiver · ${ctx.invoice.invoice_number}`,source_file_id:workflow.file_id,source_entity_type:"other",source_entity_id:waiver.id,metadata:{invoice_lien_waiver_id:waiver.id,invoice_id:invoiceId,...(packet?{delivery_mode:"invoice_packet"}:{}),draft_recipients:[{name:input.signer_name,email:user?.email??"",role:"signer",signer_role:"claimant"}]}},ctx.orgId,{authorizationPermission:"invoice.write"})
 try {
  await replaceDocumentFields({documentId:document.id,fields,orgId:ctx.orgId,authorizationPermission:"invoice.write"})
  const {data,error}=await ctx.supabase.from("invoice_lien_waivers").update({metadata:{...waiver.metadata,workflow:{...workflow,signing_document_id:document.id,sharing_requested:shared}}}).eq("org_id",ctx.orgId).eq("id",waiver.id).eq("status","pending_payment").eq("metadata",JSON.stringify(waiver.metadata)).select(SELECT).maybeSingle()
  if(error||!data)throw new Error("The waiver changed. Refresh and try again.")
  return {documentId:document.id as string,status:"draft",waiver:data as InvoiceLienWaiver}
 }catch(error){
  // Only remove the draft created by this attempt; it has never been sent.
  await ctx.supabase.from("documents").delete().eq("org_id",ctx.orgId).eq("id",document.id).eq("status","draft")
  throw error
 }
}
