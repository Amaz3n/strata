import "server-only"

import { z } from "zod"

import { authorizedAgreementTerms } from "@/lib/sales/agreement-versions"
import { getAgreementCancellation, type AgreementCancellation } from "@/lib/services/community-sales"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

/**
 * A purchase agreement's record: its signed versions (the original and each
 * buyer-signed change order, which are its amendments) and, once cancelled, the
 * cancellation and how far its settlement got. Read-only; amendments are made
 * and signed in Change Orders, cancellation from the deal.
 */

/** Hundreds of signed changes on one home is a broken record, not a busy one; past this it says so. */
const VERSION_CAP = 200

const versionRowSchema = z.object({
  id: z.string().uuid(),
  version_number: z.number().int(),
  kind: z.enum(["original", "amendment"]),
  change_order_id: z.string().uuid().nullable(),
  price_delta_cents: z.coerce.number(),
  authorized_total_cents: z.coerce.number(),
  executed_at: z.string(),
  signature: z.record(z.unknown()).nullable(),
  change_order: z.union([
    z.object({ co_number: z.number().int().nullable(), title: z.string().nullable() }),
    z.array(z.object({ co_number: z.number().int().nullable(), title: z.string().nullable() })),
  ]).nullable(),
})

export type PurchaseAgreementVersion = {
  id: string
  versionNumber: number
  kind: "original" | "amendment"
  changeOrderId: string | null
  changeOrderLabel: string | null
  priceDeltaCents: number
  authorizedTotalCents: number
  executedAt: string
  signedVia: string | null
  signerName: string | null
}

export type PurchaseAgreementRecord = {
  contractId: string
  projectId: string
  status: string
  number: string | null
  versions: PurchaseAgreementVersion[]
  truncated: boolean
  authorizedTotalCents: number | null
  originalTotalCents: number | null
  cancellation: AgreementCancellation | null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

export async function getPurchaseAgreementRecord(contractId: string, orgId?: string): Promise<PurchaseAgreementRecord> {
  z.string().uuid().parse(contractId)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: contract, error } = await context.supabase.from("contracts").select("id, project_id, status, number")
    .eq("org_id", context.orgId).eq("id", contractId).eq("contract_type", "purchase_agreement").maybeSingle()
  if (error) throw new Error(`Failed to load the purchase agreement: ${error.message}`)
  if (!contract) throw new Error("Purchase agreement not found")
  await requireAuthorization({ permission: "sales.read", userId: context.userId, orgId: context.orgId, projectId: contract.project_id, supabase: context.supabase })
  const [versions, cancellation] = await Promise.all([
    context.supabase.from("purchase_agreement_versions")
      .select("id, version_number, kind, change_order_id, price_delta_cents, authorized_total_cents, executed_at, signature, change_order:change_orders(co_number, title)")
      .eq("org_id", context.orgId).eq("contract_id", contract.id).order("version_number").limit(VERSION_CAP + 1),
    contract.status === "void" ? getAgreementCancellation(contract.id, context.orgId) : Promise.resolve(null),
  ])
  if (versions.error) throw new Error(`Failed to load the agreement's versions: ${versions.error.message}`)
  const rows = z.array(versionRowSchema).parse(versions.data ?? [])
  const truncated = rows.length > VERSION_CAP
  const shown = rows.slice(0, VERSION_CAP)
  const terms = shown.length > 0 && !truncated ? authorizedAgreementTerms(shown) : null
  return {
    contractId: contract.id,
    projectId: contract.project_id,
    status: contract.status,
    number: contract.number ?? null,
    truncated,
    authorizedTotalCents: terms?.authorizedTotalCents ?? null,
    originalTotalCents: terms?.originalTotalCents ?? null,
    cancellation,
    versions: shown.map((row) => {
      const changeOrder = Array.isArray(row.change_order) ? row.change_order[0] ?? null : row.change_order
      return {
        id: row.id,
        versionNumber: row.version_number,
        kind: row.kind,
        changeOrderId: row.change_order_id,
        changeOrderLabel: changeOrder ? [changeOrder.co_number ? `CO-${String(changeOrder.co_number).padStart(3, "0")}` : null, changeOrder.title].filter(Boolean).join(" · ") : null,
        priceDeltaCents: row.price_delta_cents,
        authorizedTotalCents: row.authorized_total_cents,
        executedAt: row.executed_at,
        signedVia: text(row.signature?.method) ?? (text(row.signature?.envelope_id) ? "envelope" : null),
        signerName: text(row.signature?.signer_name),
      }
    }),
  }
}
