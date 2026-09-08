import "server-only";
import { invoiceWaiverContentHash } from "@/lib/lien-waivers/invoice-content";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isWaiverPublic,
  readWaiverWorkflow,
} from "@/lib/lien-waivers/invoice-waiver";
import { invoiceWaiverContext } from "@/lib/services/invoice-waiver-workflow";

export async function setInvoiceWaiverPacket(
  invoiceId: string,
  enabled: boolean,
  waiverId?: string,
) {
  const ctx = await invoiceWaiverContext(invoiceId);
  const { data: waivers, error: waiverError } = await ctx.supabase
    .from("invoice_lien_waivers")
    .select("id,metadata")
    .eq("org_id", ctx.orgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "void")
    .order("created_at", { ascending: false });
  if (waiverError) throw new Error("Could not load packet waivers");
  if (waiverId && !waivers?.some(w => w.id === waiverId && readWaiverWorkflow(w))) throw new Error("Waiver does not belong to this invoice");
  const selectedId = waiverId ?? ctx.invoice.metadata?.waiver_packet?.waiver_id ?? waivers?.find(w => readWaiverWorkflow(w))?.id;
  for (const waiver of waivers ?? []) {
    const flow = readWaiverWorkflow(waiver);
    if (!flow) continue;
    const shared =
      enabled && waiver.id === selectedId &&
      flow.lifecycle === "signed" &&
      !flow.needs_review &&
      (!flow.invoice_content_hash ||
        flow.invoice_content_hash === invoiceWaiverContentHash(ctx.invoice));
    const { data: changed, error } = await ctx.supabase
      .from("invoice_lien_waivers")
      .update({
        metadata: {
          ...waiver.metadata,
          workflow: { ...flow, shared, sharing_requested: enabled && waiver.id === selectedId },
        },
      })
      .eq("org_id", ctx.orgId)
      .eq("id", waiver.id)
      .eq("metadata", JSON.stringify(waiver.metadata))
      .select("id")
      .maybeSingle();
    if (error || !changed)
      throw new Error("The waiver changed. Refresh the packet and try again.");
  }
  const metadata = { ...ctx.invoice.metadata, waiver_packet: { enabled, waiver_id: selectedId ?? null } };
  const { data, error } = await ctx.supabase
    .from("invoices")
    .update({ metadata })
    .eq("org_id", ctx.orgId)
    .eq("id", invoiceId)
    .eq("updated_at", ctx.invoice.updated_at)
    .select("id")
    .maybeSingle();
  if (error || !data)
    throw new Error("The invoice changed. Try updating the packet again.");
}
export async function assertInvoiceWaiverPacketReady(
  supabase: SupabaseClient,
  orgId: string,
  invoice: {
    id: string;
    metadata?: Record<string, any> | null;
    total_cents?: number | null;
  },
) {
  if (!invoice.metadata?.waiver_packet?.enabled) return;
  const { data, error } = await supabase
    .from("invoice_lien_waivers")
    .select("*")
    .eq("org_id", orgId)
    .eq("invoice_id", invoice.id)
    .neq("status", "void");
  if (error) throw new Error("Could not verify the invoice's waiver");
  const ready = (data ?? []).some((w) => {
    const flow = readWaiverWorkflow(w);
    return (
      flow &&
      (!invoice.metadata?.waiver_packet?.waiver_id || w.id === invoice.metadata.waiver_packet.waiver_id) &&
      isWaiverPublic(w) &&
      !flow.needs_review &&
      (!flow.invoice_content_hash ||
        flow.invoice_content_hash === invoiceWaiverContentHash(invoice)) &&
      w.amount_cents <= Number(invoice.total_cents)
    );
  });
  if (!ready)
    throw new Error(
      "Finish signing the included waiver before sending this packet, or turn off Include waiver.",
    );
}
