import "server-only"

import { z } from "zod"

import { isIssuedPurchaseOrder } from "@/lib/purchasing/po-lock"
import { revisedObligationCents } from "@/lib/purchasing/po-acknowledgment-state"
import { deliverTradeNotice, resolveTradePortalLink } from "@/lib/services/trade-notices"
import { companyRecipients, homeLabel } from "@/lib/services/trade-lookahead"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { poIssueSnapshotSchema } from "@/lib/validation/po-acknowledgments"

const payloadSchema = z.object({
  version_id: z.string().uuid(),
  commitment_id: z.string().uuid(),
  project_id: z.string().uuid(),
  company_id: z.string().uuid(),
  revision: z.number().int(),
  actor_id: z.string().uuid().nullish(),
})

const money = (cents: number | null) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100)

/** The dedupe key of one version's email: a version is mailed once, whoever asks. */
export const poIssuedNoticeDedupeKey = (versionId: string) => `po_issued:${versionId}`

/**
 * Mails the vendor one issued version of a purchase order, from the outbox job
 * the version's trigger queued. A version that was overtaken before this ran
 * (edits a minute apart make several) is not sent: only the order as it stands is
 * worth the vendor's attention. An order with nobody to email is skipped, and
 * shows as awaiting acknowledgment on the Purchasing desk.
 */
export async function processPoIssueNotice(jobId: number, orgId: string, payload: unknown) {
  const job = payloadSchema.parse(payload)
  const supabase = createServiceSupabaseClient()
  const outcome = await deliverTradeNotice({
    orgId, actorId: job.actor_id ?? null, kind: "po_issued", companyId: job.company_id, projectId: job.project_id,
    outboxId: jobId, dedupeKey: poIssuedNoticeDedupeKey(job.version_id),
    scope: { commitmentId: job.commitment_id, revision: job.revision },
    build: async () => {
      const [latest, order] = await Promise.all([
        supabase.from("po_issue_versions").select("id,revision,reason,snapshot")
          .eq("org_id", orgId).eq("commitment_id", job.commitment_id).order("revision", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("commitments").select("title,contract_number,status,company_id")
          .eq("org_id", orgId).eq("id", job.commitment_id).maybeSingle(),
      ])
      if (latest.error || order.error) throw new Error(`Failed to load the purchase order notice: ${(latest.error ?? order.error)?.message}`)
      if (!latest.data || latest.data.id !== job.version_id || latest.data.reason === "backfill") return null
      if (!order.data || order.data.company_id !== job.company_id || !isIssuedPurchaseOrder("purchase_order", order.data.status)) return null
      const snapshot = poIssueSnapshotSchema.parse(latest.data.snapshot)
      const [recipients, label, orgResult, companyResult, link] = await Promise.all([
        companyRecipients(supabase, orgId, job.company_id),
        homeLabel(supabase, orgId, job.project_id),
        supabase.from("orgs").select("name,slug,logo_url").eq("id", orgId).maybeSingle(),
        supabase.from("companies").select("name").eq("org_id", orgId).eq("id", job.company_id).maybeSingle(),
        resolveTradePortalLink(supabase, orgId, job.company_id, job.project_id),
      ])
      if (orgResult.error || companyResult.error) throw new Error(`Failed to load the purchase order notice: ${(orgResult.error ?? companyResult.error)?.message}`)
      if (!recipients.length) return null
      const number = order.data.contract_number ?? order.data.title
      const revised = job.revision > 1
      const title = revised ? `Purchase order ${number} revised` : `Purchase order ${number} issued`
      return {
        subject: `${title} (${label})`, recipients,
        snapshot: {
          title,
          intro: `${companyResult.data?.name ?? "Vendor"}, ${revised ? `revision ${job.revision} of` : ""} purchase order ${number} for ${label} is ${revised ? "issued" : "issued to you"}. Total ${money(revisedObligationCents(snapshot))}. Please accept it or tell us what you dispute.`,
          lines: snapshot.lines.map((line) => ({
            label: line.description ?? "Line", name: `${line.quantity ?? 0} ${line.unit ?? "ea"}`, dates: money(line.scheduled_value_cents),
          })),
          buttonText: link ? "Review and answer" : null, buttonUrl: link ? `${link}/purchase-orders` : null,
          org: { name: orgResult.data?.name ?? null, slug: orgResult.data?.slug ?? null, logoUrl: orgResult.data?.logo_url ?? null },
        },
      }
    },
  })
  return { sent: outcome === "sent", skipped: outcome === "skipped" }
}
