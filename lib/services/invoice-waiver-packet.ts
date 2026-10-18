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
    .select("id,status,updated_at,metadata")
    .eq("org_id", ctx.orgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "void")
    .order("created_at", { ascending: false });
  if (waiverError) throw new Error("Could not load packet waivers");
  if (
    waiverId &&
    !waivers?.some((w) => w.id === waiverId && readWaiverWorkflow(w))
  )
    throw new Error("Waiver does not belong to this invoice");
  const selectedId =
    waiverId ??
    ctx.invoice.metadata?.waiver_packet?.waiver_id ??
    waivers?.find((w) => readWaiverWorkflow(w))?.id;
  for (const waiver of waivers ?? []) {
    const flow = readWaiverWorkflow(waiver);
    if (!flow) continue;
    const shared =
      enabled &&
      waiver.id === selectedId &&
      flow.lifecycle === "signed" &&
      !flow.needs_review &&
      (!flow.invoice_content_hash ||
        flow.invoice_content_hash === invoiceWaiverContentHash(ctx.invoice));
    const { data: changed, error } = await ctx.supabase
      .from("invoice_lien_waivers")
      .update({
        updated_at: new Date().toISOString(),
        metadata: {
          ...waiver.metadata,
          workflow: {
            ...flow,
            shared,
            sharing_requested: enabled && waiver.id === selectedId,
          },
        },
      })
      .eq("org_id", ctx.orgId)
      .eq("id", waiver.id)
      .eq("updated_at", waiver.updated_at)
      .eq("status", waiver.status)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("Could not save the waiver packet. Try again.", { cause: error });
    if (!changed)
      throw new Error("The waiver changed. Refresh the packet and try again.");
  }
  const metadata = {
    ...ctx.invoice.metadata,
    waiver_packet: { ...(enabled && selectedId === ctx.invoice.metadata?.waiver_packet?.waiver_id ? ctx.invoice.metadata.waiver_packet : {}), enabled, waiver_id: selectedId ?? null },
  };
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
  const packet = invoice.metadata?.waiver_packet;
  if (packet?.delivery_mode === "separate_signature") {
    const selected = (data ?? []).find((w) => w.id === packet.waiver_id);
    const flow = selected && readWaiverWorkflow(selected);
    if (
      !flow?.signing_document_id ||
      flow.needs_review ||
      !flow.invoice_content_hash ||
      flow.invoice_content_hash !== invoiceWaiverContentHash(invoice) ||
      selected.amount_cents > Number(invoice.total_cents)
    )
      throw new Error("The waiver changed. Review it before sending.");
    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("metadata")
      .eq("org_id", orgId)
      .eq("id", flow.signing_document_id)
      .maybeSingle();
    const { data: envelope, error: envelopeError } = await supabase
      .from("envelopes")
      .select("id,status")
      .eq("org_id", orgId)
      .eq("id", packet.envelope_id)
      .eq("document_id", flow.signing_document_id)
      .maybeSingle();
    if (
      documentError ||
      envelopeError ||
      !packet.signer_id ||
      document?.metadata?.waiver_signer_id !== packet.signer_id ||
      !envelope ||
      !["sent", "partially_signed", "executed"].includes(envelope.status)
    )
      throw new Error(
        "Request the selected signer's signature before sending this invoice.",
      );
    return;
  }
  const ready = (data ?? []).some((w) => {
    const flow = readWaiverWorkflow(w);
    return (
      flow &&
      (!invoice.metadata?.waiver_packet?.waiver_id ||
        w.id === invoice.metadata.waiver_packet.waiver_id) &&
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
