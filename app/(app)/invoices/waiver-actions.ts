"use server"

import { revalidatePath } from "next/cache"
import { runAction } from "@/lib/action-result"
import { finalizeInvoiceWaiver, loadInvoiceWaiverPreparation, matchInvoiceWaiverPayment, prepareInvoiceWaiver,
  saveInvoiceWaiverTemplate, updateInvoiceWaiverSharing } from "@/lib/services/invoice-waiver-workflow"

export async function loadWaiverPreparationAction(invoiceId: string) {
  return runAction(() => loadInvoiceWaiverPreparation(invoiceId))
}
export async function prepareWaiverAction(form: FormData) {
  return runAction(async () => {
    const file = form.get("file")
    return prepareInvoiceWaiver(JSON.parse(String(form.get("input"))), file instanceof File ? file : undefined)
  })
}
export async function saveWaiverTemplateAction(form: FormData) {
  return runAction(async () => {
    const file = form.get("file")
    return saveInvoiceWaiverTemplate(String(form.get("invoiceId")), JSON.parse(String(form.get("input"))), file instanceof File ? file : undefined)
  })
}
export async function finalizeWaiverAction(invoiceId: string, waiverId: string, consent: boolean, shared: boolean) {
  return runAction(async () => {
    const result = await finalizeInvoiceWaiver(invoiceId, waiverId, consent, shared)
    revalidatePath("/invoices")
    return result
  })
}
export async function shareWaiverAction(invoiceId: string, waiverId: string, shared: boolean) {
  return runAction(async () => {
    const result = await updateInvoiceWaiverSharing(invoiceId, waiverId, shared)
    revalidatePath("/invoices")
    return result
  })
}
export async function matchWaiverPaymentAction(invoiceId: string, waiverId: string, paymentId: string | string[], confirmed: boolean) {
  return runAction(async () => {
    const result = await matchInvoiceWaiverPayment(invoiceId, waiverId, paymentId, confirmed)
    revalidatePath("/invoices")
    return result
  })
}

export async function startWaiverSigningAction(invoiceId:string,waiverId:string,shared:boolean,packet=false) {
 return runAction(async()=>{
  const {startInvoiceWaiverSigning}=await import("@/lib/services/invoice-waiver-workflow")
  const result=await startInvoiceWaiverSigning(invoiceId,waiverId,shared,packet)
  revalidatePath("/billing");revalidatePath("/signatures")
  let envelopeId: string | null = null
  if(packet && result.status!=="draft") {
   const {getInvoiceWaiverRecord}=await import("@/lib/services/invoice-waiver-workflow")
   const {ctx}=await getInvoiceWaiverRecord(invoiceId,waiverId,"invoice.write")
   const {data,error}=await ctx.supabase.from("envelopes").select("id").eq("org_id",ctx.orgId).eq("document_id",result.documentId).in("status",["sent","partially_signed","executed"]).order("created_at",{ascending:false}).limit(1).maybeSingle()
   if(error)throw new Error("Could not resume the signature")
   envelopeId=data?.id??null
  }
  return {...result,envelopeId}
 })
}

export async function setWaiverPacketAction(invoiceId:string,enabled:boolean,waiverId?:string) {
 return runAction(async()=>{
  if(typeof enabled!=="boolean")throw new Error("Choose whether to include a waiver")
  const {setInvoiceWaiverPacket}=await import("@/lib/services/invoice-waiver-packet")
  await setInvoiceWaiverPacket(invoiceId,enabled,waiverId)
 })
}
export async function refreshWaiverSigningAction(invoiceId:string,waiverId:string) {
 return runAction(async()=>{
  const {getInvoiceWaiverRecord}=await import("@/lib/services/invoice-waiver-workflow")
  const {readWaiverWorkflow}=await import("@/lib/lien-waivers/invoice-waiver")
  const {ctx,waiver}=await getInvoiceWaiverRecord(invoiceId,waiverId,"invoice.write")
  const workflow=readWaiverWorkflow(waiver)
  if(!workflow?.signing_document_id||workflow.lifecycle==="signed")return waiver
  const {data:doc}=await ctx.supabase.from("documents").select("status,executed_file_id").eq("org_id",ctx.orgId).eq("id",workflow.signing_document_id).single()
  if(doc?.status==="signed"&&doc.executed_file_id){
   const {data:envelope}=await ctx.supabase.from("envelopes").select("id").eq("org_id",ctx.orgId).eq("document_id",workflow.signing_document_id).eq("status","executed").maybeSingle()
   if(envelope){
    const {completeInvoiceWaiverFromSigning}=await import("@/lib/services/invoice-waiver-signing")
    await completeInvoiceWaiverFromSigning({supabase:ctx.supabase,orgId:ctx.orgId,documentId:workflow.signing_document_id,envelopeId:envelope.id,executedFileId:doc.executed_file_id})
    return (await getInvoiceWaiverRecord(invoiceId,waiverId)).waiver
   }
  }
  return waiver
 })
}

export async function loadWaiverPacketAction(invoiceId:string) {
 return runAction(async()=>{
  const {invoiceWaiverContext}=await import("@/lib/services/invoice-waiver-workflow")
  const ctx=await invoiceWaiverContext(invoiceId)
  const {getInvoiceWithLines}=await import("@/lib/services/invoices")
  const [invoice,waivers]=await Promise.all([
   getInvoiceWithLines(invoiceId,ctx.orgId),
   ctx.supabase.from("invoice_lien_waivers").select("*").eq("org_id",ctx.orgId).eq("invoice_id",invoiceId).neq("status","void").order("created_at",{ascending:false}),
  ])
  if(!invoice||waivers.error)throw new Error("Could not load the invoice packet")
  let readinessError: string | null = null
  try { await (await import("@/lib/services/invoice-waiver-packet")).assertInvoiceWaiverPacketReady(ctx.supabase,ctx.orgId,ctx.invoice) }
  catch(error) { readinessError=error instanceof Error?error.message:"Review the waiver before sending" }
  return {invoice,waivers:waivers.data as import("@/lib/types").InvoiceLienWaiver[],readinessError}
 })
}

export async function loadWaiverSignersAction(invoiceId: string) {
  return runAction(async () => {
    const { invoiceWaiverContext } = await import("@/lib/services/invoice-waiver-workflow")
    const { listWaiverSigners } = await import("@/lib/services/waiver-signers")
    const ctx = await invoiceWaiverContext(invoiceId)
    return { members: await listWaiverSigners(ctx.supabase, ctx.orgId), currentUserId: ctx.userId }
  })
}

export async function requestWaiverSignatureAction(invoiceId: string, waiverId: string, signerId: string, packet: boolean) {
  return runAction(async () => {
    const { getInvoiceWaiverRecord, startInvoiceWaiverSigning } = await import("@/lib/services/invoice-waiver-workflow")
    const { listWaiverSigners } = await import("@/lib/services/waiver-signers")
    const { readWaiverWorkflow } = await import("@/lib/lien-waivers/invoice-waiver")
    const { invoiceWaiverContentHash } = await import("@/lib/lien-waivers/invoice-content")
    const { unwrapAction } = await import("@/lib/action-result")
    const { sendDocumentEnvelopeAction } = await import("@/app/(app)/signatures/actions")
    const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
    const signer = (await listWaiverSigners(ctx.supabase, ctx.orgId)).find(member => member.id === signerId)
    if (!signer) throw new Error("Choose an active member of your organization")
    const workflow = readWaiverWorkflow(waiver)
    if (!workflow || workflow.lifecycle !== "draft") throw new Error("This waiver is already signed")
    if (workflow.invoice_content_hash && workflow.invoice_content_hash !== invoiceWaiverContentHash(ctx.invoice)) throw new Error("The invoice changed. Prepare a new waiver before requesting a signature.")
    if (workflow.input.signer_name !== signer.name) throw new Error("The signer changed. Update the waiver details and review the document again.")
    const extraSigners = workflow.input.additional_signers ?? [];
    const started = await startInvoiceWaiverSigning(invoiceId, waiverId, true, packet)
    const { data: document, error } = await ctx.supabase.from("documents").select("metadata").eq("org_id", ctx.orgId).eq("id", started.documentId).single()
    if (error || !document) throw new Error("Could not prepare signature request")
    if (started.status !== "draft") {
      if (document.metadata?.waiver_signer_id && document.metadata.waiver_signer_id !== signer.id) throw new Error("This waiver is already assigned to another signer")
      const { data: envelope, error: envelopeError } = await ctx.supabase.from("envelopes").select("id")
        .eq("org_id",ctx.orgId).eq("document_id",started.documentId).in("status",["sent","partially_signed","executed"])
        .order("created_at",{ascending:false}).limit(1).maybeSingle()
      if (envelopeError || !envelope) throw new Error("This signature request is no longer available")
      return { envelopeId: envelope.id as string, isSelf: signer.id === ctx.userId, waiver: started.waiver }
    }
    const { data: updated, error: updateError } = await ctx.supabase.from("documents")
      .update({ metadata: { ...document.metadata, waiver_signing_experience: "review", waiver_signer_id: signer.id,
        draft_recipients: [{ name: signer.name, email: signer.email, role: "signer", signer_role: "claimant" }, ...extraSigners.map(s=>({name:s.name,email:s.email,role:"signer",signer_role:s.role}))] } })
      .eq("org_id",ctx.orgId).eq("id",started.documentId).eq("status","draft").select("id").maybeSingle()
    if (updateError || !updated) throw new Error("Signing changed. Refresh the waiver and try again.")
    const result = unwrapAction(await sendDocumentEnvelopeAction({ document_id: started.documentId,
      recipients: [{ type: "internal_user", user_id: signer.id, name: signer.name, email: signer.email, role: "signer", signer_role: "claimant", required: true, sequence: 1 }, ...extraSigners.map(s=>({type:"external_email" as const,name:s.name,email:s.email,role:"signer" as const,signer_role:s.role,required:true,sequence:1}))], reminder_enabled: false }))
    revalidatePath("/billing")
    return { envelopeId: result.envelopeId, isSelf: signer.id === ctx.userId, waiver: started.waiver }
  })
}

/** Execute only the authenticated preparer's signature through the standard e-sign pipeline. */
export async function signOwnInvoiceWaiverAction(invoiceId: string, waiverId: string, signature: string, consent: boolean) {
  return runAction(async () => {
    const { unwrapAction } = await import("@/lib/action-result")
    const { selfSignatureValues, WAIVER_SIGNATURE_CONSENT } = await import("@/lib/invoices/waiver-self-signing")
    // Reject invalid intent before creating any signing request.
    selfSignatureValues([{ id: "signature", field_type: "signature", signer_role: "claimant", required: true }], signature, consent, "")
    const { getInvoiceWaiverRecord } = await import("@/lib/services/invoice-waiver-workflow")
    const { listWaiverSigners } = await import("@/lib/services/waiver-signers")
    const { readWaiverWorkflow } = await import("@/lib/lien-waivers/invoice-waiver")
    const { ctx, waiver } = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
    const signer = (await listWaiverSigners(ctx.supabase, ctx.orgId)).find(member => member.id === ctx.userId)
    if (!signer || readWaiverWorkflow(waiver)?.input.signer_name !== signer.name) throw new Error("This waiver is assigned to another signer")
    const refreshed = unwrapAction(await refreshWaiverSigningAction(invoiceId, waiverId))
    if (readWaiverWorkflow(refreshed)?.lifecycle === "signed") return refreshed
    const requested = unwrapAction(await requestWaiverSignatureAction(invoiceId, waiverId, ctx.userId, true))
    const documentId = readWaiverWorkflow(requested.waiver)?.signing_document_id
    if (!requested.isSelf || !documentId) throw new Error("Could not prepare your signature")
    const { data: request, error: requestError } = await ctx.supabase.from("document_signing_requests")
      .select("revision").eq("org_id", ctx.orgId).eq("document_id", documentId)
      .eq("envelope_id", requested.envelopeId).eq("signer_role", "claimant").single()
    if (requestError || !request) throw new Error("Could not load your signing request")
    const { data: fields, error } = await ctx.supabase.from("document_fields")
      .select("id,field_type,signer_role,required").eq("org_id", ctx.orgId).eq("document_id", documentId).eq("revision", request.revision)
    if (error || !fields) throw new Error("Could not load signature fields")
    const values = selfSignatureValues(fields, signature, consent, new Date().toISOString().slice(0, 10))
    const { createMySigningLinkAction } = await import("@/app/(app)/signatures/actions")
    const link = unwrapAction(await createMySigningLinkAction({ envelopeId: requested.envelopeId }))
    const token = new URL(link.url).pathname.match(/^\/d\/([a-f0-9]{64})$/)?.[1]
    if (!token) throw new Error("Could not open your signing request")
    const { submitDocumentSignatureAction } = await import("@/app/d/[token]/actions")
    await submitDocumentSignatureAction({ token, signerName: signer.name, signerEmail: signer.email, values, consentText: WAIVER_SIGNATURE_CONSENT })
    const result = unwrapAction(await refreshWaiverSigningAction(invoiceId, waiverId))
    if (readWaiverWorkflow(result)?.lifecycle !== "signed") throw new Error("Your signature is being processed. Please try again shortly.")
    revalidatePath("/billing")
    return result
  })
}

/** Request the coworker signature and persist automatic customer delivery after signing. */
export async function sendInvoiceWithWaiverRequestAction(invoiceId: string, waiverId: string, signerId: string, recipients: string[]) {
  return runAction(async () => {
    const { unwrapAction } = await import("@/lib/action-result")
    const { invoiceWaiverContext, getInvoiceWaiverRecord } = await import("@/lib/services/invoice-waiver-workflow")
    const { isInvoiceRecipientValid } = await import("@/lib/invoices/composer-recipients")
    if (!Array.isArray(recipients) || !recipients.length || recipients.some(email => !isInvoiceRecipientValid(email))) throw new Error("Add valid customer email addresses")
    // Sending permission is checked before any email can leave the organization.
    const ctx = await invoiceWaiverContext(invoiceId, "invoice.send")
    if (signerId === ctx.userId) throw new Error("Sign your waiver before sending the invoice")
    const { getInvoiceWithLines, assertInvoiceCanIssue } = await import("@/lib/services/invoices")
    const invoice = await getInvoiceWithLines(invoiceId, ctx.orgId)
    if (!invoice) throw new Error("Invoice not found")
    await assertInvoiceCanIssue(ctx, invoice)
    const { readWaiverWorkflow } = await import("@/lib/lien-waivers/invoice-waiver")
    const record = await getInvoiceWaiverRecord(invoiceId, waiverId, "invoice.write")
    const flow = readWaiverWorkflow(record.waiver)
    const { listWaiverSigners } = await import("@/lib/services/waiver-signers")
    const signer = (await listWaiverSigners(ctx.supabase, ctx.orgId)).find(member => member.id === signerId)
    if (!signer || !flow || flow.input.signer_name !== signer.name) throw new Error("Review the selected signer before sending")
    // Record authorization before sending the signing link, so an immediate signature cannot race it.
    const { data, error } = await ctx.supabase.from("invoices").update({ metadata: {
      ...record.ctx.invoice.metadata,
      waiver_packet: { enabled: true, waiver_id: waiverId, delivery_mode: "after_signature", signer_id: signerId,
        actor_id: ctx.userId, recipients, requested_at: new Date().toISOString() },
    } }).eq("org_id", ctx.orgId).eq("id", invoiceId).eq("updated_at", record.ctx.invoice.updated_at).select("id").maybeSingle()
    if (error || !data) throw new Error("The invoice changed. Review it and try again.")
    if (flow.lifecycle === "signed") {
      unwrapAction(await shareWaiverAction(invoiceId, waiverId, true))
      await (await import("@/lib/services/invoice-waiver-auto-send")).sendInvoiceAfterWaiverSignature(ctx.supabase, ctx.orgId, invoiceId, waiverId)
    } else {
      unwrapAction(await requestWaiverSignatureAction(invoiceId, waiverId, signerId, true))
    }
    revalidatePath("/billing")
    return (await getInvoiceWithLines(invoiceId, ctx.orgId))!
  })
}
