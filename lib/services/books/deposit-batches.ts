import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { requireOrgContext } from "@/lib/services/context";
import { recordAudit } from "@/lib/services/audit";
import { recordEvent } from "@/lib/services/events";

async function requireDepositContext(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "deposit_batch",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

function depositAmount(payment: {
  amount_cents: number;
  gross_cents: number | null;
  net_cents: number | null;
  fee_cents: number | null;
}) {
  if (Number(payment.net_cents ?? 0) > 0) return Number(payment.net_cents);
  const gross = Number(payment.gross_cents ?? payment.amount_cents);
  return Math.max(gross - Number(payment.fee_cents ?? 0), 0);
}

export async function getDepositBatchWorkspace(orgId?: string) {
  const context = await requireDepositContext(orgId);
  const service = createServiceSupabaseClient();
  const [paymentResult, bankResult, assignedResult, batchResult] = await Promise.all([
    service
      .from("payments")
      .select("id, invoice_id, received_at, amount_cents, gross_cents, net_cents, fee_cents, method, reference, invoice:invoices(invoice_number,title,customer_name)")
      .eq("org_id", context.orgId)
      .in("status", ["succeeded", "completed", "paid"])
      .not("invoice_id", "is", null)
      .order("received_at", { ascending: false })
      .limit(500),
    service
      .from("bank_transactions")
      .select("id, bank_account_id, transaction_date, amount_cents, merchant_name, description, matches:bank_transaction_matches(status,matched_amount_cents), bank_account:bank_accounts(name,official_name,gl_account_id)")
      .eq("org_id", context.orgId)
      .eq("lifecycle_status", "posted")
      .eq("excluded", false)
      .eq("direction", "inflow")
      .order("transaction_date", { ascending: false })
      .limit(250),
    service.from("books_deposit_batch_items").select("payment_id").eq("org_id", context.orgId),
    service
      .from("books_deposit_batches")
      .select("id,deposited_on,total_cents,status,reference,bank_account:bank_accounts(name,official_name),items:books_deposit_batch_items(id)")
      .eq("org_id", context.orgId)
      .order("deposited_on", { ascending: false })
      .limit(25),
  ]);
  for (const result of [paymentResult, bankResult, assignedResult, batchResult]) {
    if (result.error) throw new Error(`Failed to load deposit batches: ${result.error.message}`);
  }

  const assigned = new Set((assignedResult.data ?? []).map((row) => row.payment_id));
  const paymentIds = (paymentResult.data ?? []).map((row) => row.id);
  const { data: journalRows, error: journalError } = paymentIds.length === 0
    ? { data: [], error: null }
    : await service
        .from("journal_entries")
        .select("source_id")
        .eq("org_id", context.orgId)
        .eq("status", "posted")
        .in("source_type", ["invoice_payment", "customer_deposit_receipt"])
        .in("source_id", paymentIds);
  if (journalError) throw new Error(`Failed to verify deposited receipts: ${journalError.message}`);
  const posted = new Set((journalRows ?? []).map((row) => row.source_id));

  return {
    payments: (paymentResult.data ?? [])
      .filter((row) => !assigned.has(row.id) && posted.has(row.id))
      .map((row) => {
        const invoice = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice;
        return {
          id: row.id,
          receivedAt: row.received_at,
          amountCents: depositAmount(row),
          method: row.method,
          reference: row.reference,
          invoiceNumber: invoice?.invoice_number ?? null,
          label: invoice?.customer_name || invoice?.title || "Customer receipt",
        };
      }),
    bankTransactions: (bankResult.data ?? [])
      .filter((row) => {
        const account = Array.isArray(row.bank_account) ? row.bank_account[0] : row.bank_account;
        const matched = (row.matches ?? []).filter((match) => match.status === "confirmed").reduce((sum, match) => sum + Number(match.matched_amount_cents ?? 0), 0);
        return Boolean(account?.gl_account_id) && matched < Number(row.amount_cents);
      })
      .map((row) => {
        const account = Array.isArray(row.bank_account) ? row.bank_account[0] : row.bank_account;
        return {
          id: row.id,
          bankAccountId: row.bank_account_id,
          date: row.transaction_date,
          amountCents: Number(row.amount_cents),
          description: row.merchant_name || row.description,
          accountName: account?.official_name || account?.name || "Bank account",
        };
      }),
    batches: (batchResult.data ?? []).map((row) => {
      const account = Array.isArray(row.bank_account) ? row.bank_account[0] : row.bank_account;
      return {
        id: row.id,
        depositedOn: row.deposited_on,
        totalCents: Number(row.total_cents),
        status: row.status,
        reference: row.reference,
        accountName: account?.official_name || account?.name || "Bank account",
        itemCount: row.items?.length ?? 0,
      };
    }),
  };
}

export async function createDepositBatch(input: {
  bankTransactionId: string;
  paymentIds: string[];
  reference?: string | null;
  orgId?: string;
}) {
  const context = await requireDepositContext(input.orgId);
  if (input.paymentIds.length === 0) throw new Error("Select at least one receipt");
  if (new Set(input.paymentIds).size !== input.paymentIds.length) throw new Error("A receipt can be selected only once");
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc("create_books_deposit_batch_atomic", {
    p_org_id: context.orgId, p_transaction_id: input.bankTransactionId,
    p_payment_ids: input.paymentIds, p_reference: input.reference?.trim() || null, p_actor_id: context.userId,
  });
  if (error) throw new Error(`Failed to post deposit batch: ${error.message}`);
  const result = z.object({ id: z.string().uuid(), duplicate: z.boolean() }).parse(data);
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "deposit_batch", entityId: result.id, after: { payment_ids: input.paymentIds, bank_transaction_id: input.bankTransactionId }, source: "books.deposit_batch" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.deposit_batch_posted", entityType: "deposit_batch", entityId: result.id, payload: { receipt_count: input.paymentIds.length } }),
  ]);
  return result;
}
