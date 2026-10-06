import { getFilesStorageProvider } from "@/lib/storage/files-storage"
import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, hasPermission } from "@/lib/services/permissions"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { deriveAgreementSigningState, signingState, agreementReconciliationState, type AgreementSigningState } from "@/lib/sales/agreement-signing-state"

import { agreementSigningSourceMatches } from "@/lib/sales/agreement-signing-source"

const configurationSchema = z.object({ lot_id: z.string().uuid(), house_plan_id: z.string().uuid().nullable(),
  house_plan_version_id: z.string().uuid().nullable(), elevation_id: z.string().uuid().nullable(), swing: z.enum(["left", "right"]) })
const requestSchema = z.object({ id:z.string().uuid(),status:z.string(),sequence:z.number().int(),required:z.boolean(),signer_role:z.string(),recipient_contact_id:z.string().uuid().nullable(),delivery_status:z.string().nullable().optional(),provider_email_id:z.string().nullable().optional() })
/** Bounded evidence for one actual home. Secrets from raw requests never leave this service. */
export async function getAgreementSigningState(contractId: string, orgId?: string): Promise<AgreementSigningState> {
  z.string().uuid().parse(contractId)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read",context)
  const {data:contract,error:contractError} = await context.supabase.from("contracts").select("id,org_id,project_id,status,title,number,terms,snapshot,total_cents,currency,effective_date,buyer_contact_id,co_buyer_contact_id")
    .eq("org_id",context.orgId).eq("id",contractId).eq("contract_type","purchase_agreement").maybeSingle()
  if (contractError || !contract || !z.string().uuid().safeParse(contract.project_id).success) throw new Error("Purchase agreement signing status could not be verified")
  await requireAuthorization({permission:"sales.read",orgId:context.orgId,userId:context.userId,projectId:contract.project_id,supabase:context.supabase})
  const [orgManage,homeManage] = await Promise.all([
    hasPermission("sales.manage",context),
    authorize({permission:"sales.manage",orgId:context.orgId,userId:context.userId,projectId:contract.project_id,supabase:context.supabase}),
  ])
  const canManage = process.env.ARC_AGREEMENT_DURABLE_SIGNING_ENABLED === "true" && Boolean(process.env.DOCUMENT_SIGNING_SECRET) && getFilesStorageProvider() === "r2" && contract.status === "draft" && orgManage && homeManage.allowed
  const docs = await context.supabase.from("documents").select("id,status,metadata,current_revision").eq("org_id",context.orgId).eq("project_id",contract.project_id)
    .eq("source_entity_type","contract").eq("source_entity_id",contractId).contains("metadata",{purchase_agreement:true}).limit(2)
  if (docs.error || !docs.data) return signingState("unavailable")
  if (docs.data.length > 1) return signingState("reconcile")
  const doc = docs.data[0]
  const preparationState = async (stage: "not_prepared" | "prepared") => {
    const documentId = doc?.id ?? null
    const configuration = configurationSchema.safeParse((contract.snapshot as Record<string, any> | null)?.purchase_agreement?.configuration)
    if (!configuration.success) return agreementReconciliationState("configuration", documentId)
    const [lot, reservations] = await Promise.all([
      context.supabase.from("lots").select("project_id,status,house_plan_id,house_plan_version_id,house_plan_elevation_id,swing")
        .eq("org_id", context.orgId).eq("id", configuration.data.lot_id).maybeSingle(),
      context.supabase.from("lot_reservations").select("lot_id,status").eq("org_id", context.orgId).eq("contract_id", contract.id).limit(2),
    ])
    if (lot.error || reservations.error || !reservations.data) return signingState("unavailable", documentId)
    const saved = configuration.data
    if (!lot.data || lot.data.project_id !== contract.project_id || !["owned", "developed", "assigned", "started"].includes(lot.data.status)
      || lot.data.house_plan_id !== saved.house_plan_id || lot.data.house_plan_version_id !== saved.house_plan_version_id
      || lot.data.house_plan_elevation_id !== saved.elevation_id || lot.data.swing !== saved.swing) return agreementReconciliationState("configuration", documentId)
    if (reservations.data.length !== 1 || reservations.data[0].lot_id !== saved.lot_id || reservations.data[0].status !== "reserved") return agreementReconciliationState("reservation", documentId)
    return signingState(stage, documentId, canManage && (!doc || Boolean(doc.metadata?.agreement_signing_input)))
  }
  if (!doc) return contract.status === "draft" ? preparationState("not_prepared") : signingState("reconcile")
  if (doc.metadata && Object.hasOwn(doc.metadata, "agreement_signing_input") && !agreementSigningSourceMatches(doc.metadata.agreement_signing_input, contract)) return agreementReconciliationState("source", doc.id)
  const envelopes = await context.supabase.from("envelopes").select("id,status,document_revision").eq("org_id",context.orgId).eq("document_id",doc.id).limit(2)
  if (envelopes.error || !envelopes.data) return signingState("unavailable",doc.id)
  if (envelopes.data.length > 1) return signingState("reconcile",doc.id)
  const envelope = envelopes.data[0]
  const requests = await context.supabase.from("document_signing_requests").select("*").eq("org_id",context.orgId).eq("document_id",doc.id).limit(4)
  if (requests.error || !requests.data) return signingState("unavailable",doc.id)
  if (!envelope) return doc.status === "draft" && requests.data.length === 0 ? preparationState("prepared") : signingState("reconcile",doc.id)
  if (envelope.document_revision !== doc.current_revision || requests.data.some(r=>r.envelope_id !== envelope.id || r.revision !== doc.current_revision)) return signingState("reconcile",doc.id)
  const parsed = z.array(requestSchema).safeParse(requests.data)
  if (!parsed.success || !contract.buyer_contact_id) return signingState("reconcile",doc.id)
  const state = deriveAgreementSigningState({documentId:doc.id,documentStatus:doc.status,envelopeStatus:envelope.status,
    owned:Boolean(doc.metadata?.agreement_signing_input),buyerId:contract.buyer_contact_id,coBuyerId:contract.co_buyer_contact_id,
    canManage,requests:parsed.data.map(r=>({id:r.id,status:r.status,sequence:r.sequence,required:r.required,signerRole:r.signer_role,
      contactId:r.recipient_contact_id,deliveryStatus:r.delivery_status??null,providerId:r.provider_email_id??null}))})
  return state.stage === "prepared" ? preparationState("prepared") : state
}
