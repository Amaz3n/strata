import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { requireOrgContext } from "@/lib/services/context";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";
import { postBooksJournalEntryForService } from "@/lib/services/books/ledger";
import { confirmBankMatch } from "@/lib/services/books/bank-reconciliation";
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
  const [{ data: transaction }, { data: payments }, { data: settings }] = await Promise.all([
    service
      .from("bank_transactions")
      .select("id,bank_account_id,transaction_date,amount_cents,direction,bank_account:bank_accounts(gl_account_id)")
      .eq("org_id", context.orgId)
      .eq("id", input.bankTransactionId)
      .single(),
    service
      .from("payments")
      .select("id,amount_cents,gross_cents,net_cents,fee_cents,status")
      .eq("org_id", context.orgId)
      .in("id", input.paymentIds),
    service.from("books_settings").select("active_policy_version").eq("org_id", context.orgId).single(),
  ]);
  if (!transaction || transaction.direction !== "inflow") throw new Error("Choose an incoming bank deposit");
  if ((payments ?? []).length !== input.paymentIds.length) throw new Error("One or more receipts were not found");
  if ((payments ?? []).some((payment) => !["succeeded", "completed", "paid"].includes(payment.status))) throw new Error("Only settled receipts may be deposited");
  const totalCents = (payments ?? []).reduce((sum, payment) => sum + depositAmount(payment), 0);
  if (totalCents !== Number(transaction.amount_cents)) throw new Error("Selected receipts must equal the bank deposit exactly");
  const bankAccount = Array.isArray(transaction.bank_account) ? transaction.bank_account[0] : transaction.bank_account;
  if (!bankAccount?.gl_account_id) throw new Error("Map the bank account to a GL control account first");
  const { data: controlAccount } = await service.from("gl_accounts").select("id,code").eq("org_id", context.orgId).eq("id", bankAccount.gl_account_id).single();
  if (!controlAccount) throw new Error("The bank control account could not be resolved");

  const { data: existing } = await service.from("books_deposit_batches").select("id,journal_entry_id,status").eq("org_id", context.orgId).eq("bank_transaction_id", transaction.id).maybeSingle();
  let batchId = existing?.id as string | undefined;
  if (!batchId) {
    const { data: batch, error } = await service.from("books_deposit_batches").insert({
      org_id: context.orgId,
      bank_transaction_id: transaction.id,
      bank_account_id: transaction.bank_account_id,
      deposited_on: transaction.transaction_date,
      total_cents: totalCents,
      reference: input.reference?.trim() || null,
      created_by: context.userId,
    }).select("id").single();
    if (error || !batch) throw new Error(`Failed to create deposit batch: ${error?.message}`);
    batchId = batch.id;
    const { error: itemError } = await service.from("books_deposit_batch_items").insert(input.paymentIds.map((paymentId) => ({ org_id: context.orgId, batch_id: batchId, payment_id: paymentId, amount_cents: depositAmount((payments ?? []).find((payment) => payment.id === paymentId)!) })));
    if (itemError) throw new Error(`Failed to group deposit receipts: ${itemError.message}`);
  } else if (existing?.status === "posted") {
    return { id: batchId, duplicate: true };
  }

  const journal = await postBooksJournalEntryForService({
    entryDate: transaction.transaction_date,
    entryKind: "operational",
    memo: `Bank deposit${input.reference?.trim() ? ` · ${input.reference.trim()}` : ""}`,
    postingKey: `deposit_batch:${batchId}`,
    projectionVersion: 1,
    policyVersion: Number(settings?.active_policy_version ?? 1),
    sourceType: "deposit_batch",
    sourceId: batchId,
    lines: [
      { accountCode: controlAccount.code, debitCents: totalCents, creditCents: 0, description: "Bank deposit" },
      { accountCode: SYSTEM_ACCOUNT_CODES.undepositedFunds, debitCents: 0, creditCents: totalCents, description: `${input.paymentIds.length} customer receipt${input.paymentIds.length === 1 ? "" : "s"}` },
    ],
  }, context.orgId);
  const { data: bankLine } = await service.from("journal_lines").select("id").eq("org_id", context.orgId).eq("journal_entry_id", journal.id).eq("account_id", controlAccount.id).single();
  if (!bankLine) throw new Error("The deposit bank line could not be matched");
  await confirmBankMatch({ bankTransactionId: transaction.id, journalLineId: bankLine.id, amountCents: totalCents, matchType: "exact", confidence: 1, orgId: context.orgId });
  const { error: updateError } = await service.from("books_deposit_batches").update({ status: "posted", journal_entry_id: journal.id }).eq("org_id", context.orgId).eq("id", batchId);
  if (updateError) throw new Error(`Failed to finish deposit batch: ${updateError.message}`);
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "deposit_batch", entityId: batchId, after: { total_cents: totalCents, payment_ids: input.paymentIds, bank_transaction_id: transaction.id }, source: "books.deposit_batch" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.deposit_batch_posted", entityType: "deposit_batch", entityId: batchId, payload: { total_cents: totalCents, receipt_count: input.paymentIds.length } }),
  ]);
  return { id: batchId, duplicate: false };
}
