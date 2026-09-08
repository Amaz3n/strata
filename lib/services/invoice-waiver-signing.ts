import "server-only";
import { invoiceWaiverContentHash } from "@/lib/lien-waivers/invoice-content";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  availableWaiverPayments,
  readWaiverWorkflow,
  waiverPaymentIds,
} from "@/lib/lien-waivers/invoice-waiver";
import { downloadFilesObject } from "@/lib/storage/files-storage";
/** Attach the exact native signing artifact. Called by the retryable execution outbox. */
export async function completeInvoiceWaiverFromSigning({
  supabase,
  orgId,
  documentId,
  envelopeId,
  executedFileId,
}: {
  supabase: SupabaseClient;
  orgId: string;
  documentId: string;
  envelopeId: string;
  executedFileId: string;
}) {
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("status,executed_file_id,metadata")
    .eq("org_id", orgId)
    .eq("id", documentId)
    .single();
  if (
    docError ||
    !doc ||
    doc.status !== "signed" ||
    doc.executed_file_id !== executedFileId
  )
    throw new Error("Waiver document is not fully executed");
  const id = doc.metadata?.invoice_lien_waiver_id;
  if (!id) throw new Error("Missing invoice waiver link");
  const { data: waiver, error } = await supabase
    .from("invoice_lien_waivers")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .single();
  if (error || !waiver) throw new Error("Invoice waiver not found");
  const workflow = readWaiverWorkflow(waiver);
  if (!workflow || workflow.signing_document_id !== documentId)
    throw new Error("Signing document does not match this waiver");
  if (workflow.lifecycle === "signed" && workflow.file_id === executedFileId)
    return;
  const [file, invoice, payments, allocations, reversals, envelope] =
    await Promise.all([
      supabase
        .from("files")
        .select("storage_path")
        .eq("org_id", orgId)
        .eq("id", executedFileId)
        .single(),
      supabase
        .from("invoices")
        .select("status,updated_at,project_id,invoice_number,title,total_cents,subtotal_cents,tax_cents,metadata,notes")
        .eq("org_id", orgId)
        .eq("id", waiver.invoice_id)
        .single(),
      supabase
        .from("payments")
        .select("*")
        .eq("org_id", orgId)
        .eq("invoice_id", waiver.invoice_id),
      supabase
        .from("payment_allocations")
        .select("*,payment:payments(*)")
        .eq("org_id", orgId)
        .eq("invoice_id", waiver.invoice_id),
      supabase
        .from("payment_reversals")
        .select("*")
        .eq("org_id", orgId)
        .eq("invoice_id", waiver.invoice_id),
      supabase
        .from("envelopes")
        .select("status,executed_at")
        .eq("org_id", orgId)
        .eq("id", envelopeId)
        .eq("document_id", documentId)
        .single(),
    ]);
  for (const result of [
    file,
    invoice,
    payments,
    allocations,
    reversals,
    envelope,
  ])
    if (result.error) throw new Error("Could not verify completed waiver");
  if (!file.data || !invoice.data)
    throw new Error("Completed waiver records unavailable");
  if (envelope.data?.status !== "executed" || !envelope.data.executed_at)
    throw new Error("Signing envelope is not executed");
  const ids = waiverPaymentIds(workflow.input);
  const activity = [
    ...(payments.data ?? []),
    ...(allocations.data ?? []).map((row) => ({
      ...(Array.isArray(row.payment) ? row.payment[0] : row.payment),
      amount_cents: row.amount_cents,
    })),
  ];
  const available = availableWaiverPayments(
    activity,
    reversals.data ?? [],
  ).filter((p) => ids.includes(p.id));
  const paymentValid =
    !ids.length ||
    (available.length === ids.length &&
      available.reduce((sum, p) => sum + p.available_cents, 0) >=
        waiver.amount_cents);
  const needsReview =
    waiver.status === "void" ||
    invoice.data.status === "void" ||
    (workflow.invoice_content_hash ? workflow.invoice_content_hash !== invoiceWaiverContentHash(invoice.data) : workflow.invoice_revision !== (invoice.data.updated_at ?? null)) ||
    !paymentValid;
  const bytes = await downloadFilesObject({
    supabase,
    orgId,
    path: file.data.storage_path,
  });
  const signedAt = envelope.data.executed_at as string;
  const next = {
    ...workflow,
    lifecycle: "signed",
    document_path: file.data.storage_path,
    file_id: executedFileId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signed_at: signedAt,
    envelope_id: envelopeId,
    shared: Boolean(workflow.sharing_requested && !needsReview &&
      (!invoice.data.metadata?.waiver_packet || (invoice.data.metadata.waiver_packet.enabled &&
        (!invoice.data.metadata.waiver_packet.waiver_id || invoice.data.metadata.waiver_packet.waiver_id === id)))),
    needs_review: needsReview,
    payment_ids: paymentValid ? ids : [],
    payment_id: paymentValid ? ids[0] : undefined,
  };
  const { data: updated, error: updateError } = await supabase
    .from("invoice_lien_waivers")
    .update({
      metadata: { ...waiver.metadata, workflow: next },
      status:
        waiver.status === "void"
          ? "void"
          : ids.length && paymentValid && !needsReview
            ? "released"
            : "pending_payment",
      released_at: ids.length && paymentValid && !needsReview ? signedAt : null,
      released_by_payment_id:
        ids.length && paymentValid && !needsReview ? ids[0] : null,
      updated_at: signedAt,
    })
    .eq("org_id", orgId)
    .eq("id", id)
    .eq("status", waiver.status)
    .eq("metadata", JSON.stringify(waiver.metadata))
    .select("id")
    .maybeSingle();
  if (updateError || !updated)
    throw new Error(
      "Waiver changed during signature completion. Retry required.",
    );
}
