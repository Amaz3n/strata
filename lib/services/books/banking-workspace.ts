import "server-only";
import { z } from "zod";
import {
  bankCodingSchema,
  codingForTransactionTotal,
  receiptCandidates,
} from "./banking-model";
import { POSTED_EXPENSE_STATUSES } from "@/lib/financials/ledger-status";
import { assertNotCapturedExpense, loadCapturedExpenses, loadMatchCandidates } from "./captured-expenses";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { recordAudit, listEntityAuditTrail } from "@/lib/services/audit";
import {
  createFileFromUpload,
  buildInternalFileUrl,
} from "@/lib/services/files";
import { extractExpenseReceiptFromFile } from "@/lib/services/document-extraction";
import { createCompany } from "@/lib/services/companies";
import { syncBankFeedConnection } from "./bank-feeds";
import { collectBooksRows } from "./paging";
import { plaidMerchantLogoUrl } from "./banking-presentation";
import { loadBankAiSuggestions, type BankAiSuggestion } from "./bank-ai-suggestions";
import { processBankAiSuggestionsForOrg } from "./bank-ai-suggestions";
import { hasPermission } from "@/lib/services/permissions";
import {
  reviewUnmatchedBankTransactions,
  type BankReviewRow,
} from "./bank-reconciliation";

async function context(write = false) {
  const ctx = await requireBooksWorkspaceEnabled();
  await requireBooksAuthorization({
    permission: write ? "books.reconcile" : "books.read",
    ...ctx,
    resourceType: "banking",
    resourceId: ctx.orgId,
    logDecision: write,
  });
  return { ...ctx, service: createServiceSupabaseClient() };
}
export const bankingQuerySchema = z.object({
  accountId: z.string().uuid().nullable().default(null),
  status: z
    .enum(["review", "posted", "excluded", "pending", "all"])
    .default("review"),
  search: z.string().max(200).default(""),
  start: z.string().date().optional(),
  end: z.string().date().optional(),
  direction: z.enum(["inflow", "outflow"]).optional(),
  missingReceipt: z.boolean().default(false),
  sort: z.enum(["date", "description", "amount"]).default("date"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(0).max(100000).default(0),
});
const transactionSchema = z.object({
  id: z.string(),
  bank_account_id: z.string(),
  transaction_date: z.string(),
  amount_cents: z.coerce.number(),
  direction: z.enum(["inflow", "outflow"]),
  currency: z.string(),
  merchant_name: z.string().nullable(),
  description: z.string(),
  lifecycle_status: z.string(),
  latest_revision: z.coerce.number().int().positive(),
  excluded: z.boolean(),
  coding: z.unknown(),
  version: z.number(),
  entry_id: z.string().nullable(),
  matched_cents: z.coerce.number(),
  receipt_count: z.coerce.number(),
  review_status: z.enum(["review", "posted", "excluded", "pending"]),
});
export type BankingTransaction = z.infer<typeof transactionSchema> & {
  draft: z.infer<typeof bankCodingSchema> | null;
  receipt_file_id: string | null;
  receipt_file_name: string | null;
  receipt_mime_type: string | null;
  merchant_logo_url: string | null;
  aiSuggestion: BankAiSuggestion | null;
  reviewSuggestion: BankReviewRow | null;
};

export async function loadBankingTransactions(
  raw: z.input<typeof bankingQuerySchema>,
) {
  const input = bankingQuerySchema.parse(raw);
  const { service, orgId, userId, supabase } = await context();
  let query = service
    .from("banking_workspace_rows")
    .select("*", { count: "exact" })
    .eq("org_id", orgId);
  if (input.accountId) query = query.eq("bank_account_id", input.accountId);
  if (input.status !== "all") query = query.eq("review_status", input.status);
  if (input.start) query = query.gte("transaction_date", input.start);
  if (input.end) query = query.lte("transaction_date", input.end);
  if (input.direction) query = query.eq("direction", input.direction);
  if (input.missingReceipt)
    query = query
      .eq("receipt_count", 0)
      .or(
        "coding->>receiptStatus.is.null,coding->>receiptStatus.neq.not_required",
      );
  if (input.search.trim()) {
    const term = input.search.trim().replace(/[%_(),\\"]/g, " ");
    const cents = Math.round(
      Math.abs(Number(input.search.trim().replace(/[$,\s]/g, ""))) * 100,
    );
    query = query.or(
      `merchant_name.ilike.%${term}%,description.ilike.%${term}%${Number.isSafeInteger(cents) && cents > 0 ? `,amount_cents.eq.${cents}` : ""}`,
    );
  }
  const sortColumn = {
    date: "transaction_date",
    description: "description",
    // Amounts are stored as a positive magnitude with direction separately.
    amount: "amount_cents",
  }[input.sort];
  const ascending = input.sortDir === "asc";
  const { data, error, count } = await query
    .order(sortColumn, { ascending })
    .order("id", { ascending })
    .range(input.page * 50, input.page * 50 + 49);
  if (error) throw new Error(`Banking could not load: ${error.message}`);
  const parsedRows = z
    .array(transactionSchema)
    .parse(data ?? [])
    .map((row) => {
      const savedDraft = bankCodingSchema.safeParse(row.coding).data;
      return {
        ...row,
        draft: savedDraft
          ? codingForTransactionTotal(savedDraft, row.amount_cents)
          : null,
      };
    });
  const ids = parsedRows.map((row) => row.id);
  const reviewIds = parsedRows
    .filter((row) => row.review_status === "review")
    .map((row) => row.id);
  const canReconcile = await hasPermission("books.reconcile", {
    orgId,
    userId,
    supabase,
  }).catch(() => false);
  const revisionFilter = parsedRows
    .map(
      (row) =>
        `and(bank_transaction_id.eq.${row.id},revision.eq.${row.latest_revision})`,
    )
    .join(",");
  const [receiptResult, revisionResult, aiSuggestions, reviewSuggestions] = ids.length
    ? await Promise.all([
        service
          .from("bank_transactions")
          .select(
            "id,bank_receipts(file_id,created_at,files(id,org_id,file_name,storage_path,mime_type,size_bytes,visibility,created_at,updated_at))",
          )
          .eq("org_id", orgId)
          .in("id", ids)
          .eq("bank_receipts.org_id", orgId)
          .order("created_at", {
            referencedTable: "bank_receipts",
            ascending: false,
          })
          .limit(1, { referencedTable: "bank_receipts" }),
        service
          .from("bank_transaction_revisions")
          .select("bank_transaction_id,revision,normalized_payload")
          .eq("org_id", orgId)
          .or(revisionFilter)
          .limit(50),
        loadBankAiSuggestions(orgId, ids),
        canReconcile && reviewIds.length
          ? reviewUnmatchedBankTransactions({ orgId, transactionIds: reviewIds })
          : Promise.resolve({ rows: [] as BankReviewRow[], truncated: false, rowCap: 0 }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        new Map<string, BankAiSuggestion>(),
        { rows: [] as BankReviewRow[], truncated: false, rowCap: 0 },
      ];
  if (receiptResult.error)
    console.error(
      "[banking] Receipt summaries could not load",
      receiptResult.error,
    );
  if (revisionResult.error)
    console.error(
      "[banking] Merchant branding could not load",
      revisionResult.error,
    );

  const receiptByTransaction = new Map<
    string,
    { file_id: string; files: unknown }
  >();
  for (const transaction of receiptResult.data ?? []) {
    const receipts = Array.isArray(transaction.bank_receipts)
      ? transaction.bank_receipts
      : [];
    const receipt = receipts[0];
    if (receipt) receiptByTransaction.set(transaction.id, receipt);
  }
  const logoByTransaction = new Map<string, string | null>();
  for (const revision of revisionResult.data ?? []) {
    if (!logoByTransaction.has(revision.bank_transaction_id))
      logoByTransaction.set(
        revision.bank_transaction_id,
        plaidMerchantLogoUrl(revision.normalized_payload),
      );
  }
  const rows: BankingTransaction[] = parsedRows.map((row) => {
    const receipt = receiptByTransaction.get(row.id);
    const file = receipt?.files
      ? Array.isArray(receipt.files)
        ? receipt.files[0]
        : receipt.files
      : null;
    const fileRecord =
      file && typeof file === "object"
        ? (file as { file_name?: unknown; mime_type?: unknown })
        : null;
    return {
      ...row,
      receipt_file_id: receipt?.file_id ?? null,
      receipt_file_name:
        typeof fileRecord?.file_name === "string" ? fileRecord.file_name : null,
      receipt_mime_type:
        typeof fileRecord?.mime_type === "string" ? fileRecord.mime_type : null,
      // A selected directory vendor may differ from Plaid's merchant. Avoid
      // assigning the merchant's brand to that vendor identity.
      // The client only displays this when the selected directory vendor is
      // the same identity as Plaid's merchant; otherwise it falls back to initials.
      merchant_logo_url: logoByTransaction.get(row.id) ?? null,
      aiSuggestion: aiSuggestions.get(row.id) ?? null,
      reviewSuggestion:
        reviewSuggestions.rows.find((candidate) => candidate.transactionId === row.id) ?? null,
    };
  });
  return { rows, count: count ?? 0 };
}
export async function loadBankingOptions() {
  const { service, orgId } = await context();
  const [vendors, projects, costCodes, counts] = await Promise.all([
    collectBooksRows((from, to) =>
      service
        .from("companies")
        .select("id,name")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    collectBooksRows((from, to) =>
      service
        .from("projects")
        .select("id,name")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    collectBooksRows((from, to) =>
      service
        .from("cost_codes")
        .select("id,code,name")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
    collectBooksRows((from, to) =>
      service
        .from("banking_workspace_counts")
        .select("bank_account_id,review_status,transaction_count")
        .eq("org_id", orgId)
        .order("bank_account_id")
        .order("review_status")
        .range(from, to),
    ),
  ]);
  return {
    vendors,
    projects,
    costCodes,
    counts: counts.reduce<Record<string, number>>((result, row) => {
      const key = `${row.bank_account_id}:${row.review_status}`;
      result[key] = (result[key] ?? 0) + Number(row.transaction_count);
      return result;
    }, {}),
  };
}
export const bankingMutationSchema = z.object({
  transactionId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  action: z.enum(["save", "post", "match", "exclude", "undo"]),
  coding: bankCodingSchema.optional(),
  /** The person was told this charge is an approved expense and chose to post it anyway. */
  confirmDoubleCost: z.boolean().default(false),
  matches: z
    .array(
      z.object({
        journalLineId: z.string().uuid(),
        amountCents: z.number().int().positive().safe(),
      }),
    )
    .max(50)
    .default([]),
});
export async function mutateBankingTransaction(
  raw: z.input<typeof bankingMutationSchema>,
) {
  const input = bankingMutationSchema.parse(raw);
  const { service, orgId, userId } = await context(true);
  if (input.action === "post" && !input.confirmDoubleCost)
    await assertNotCapturedExpense(service, orgId, input.transactionId);
  const { data, error } = await service.rpc("mutate_books_banking_atomic", {
    p_org_id: orgId,
    p_transaction_id: input.transactionId,
    p_actor_id: userId,
    p_action: input.action,
    p_version: input.version,
    p_coding: input.coding ?? null,
    p_matches: input.matches,
  });
  if (error) throw new Error(error.message);
  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "bank_transaction",
    entityId: input.transactionId,
    after: { action: input.action, coding: input.coding, ...data },
    source: "books.banking",
  });
  return z
    .object({ version: z.number(), entryId: z.string().nullable() })
    .parse(data);
}
export async function loadBankingDetail(transactionId: string) {
  const { service, orgId } = await context();
  const id = z.string().uuid().parse(transactionId);
  const { data: transaction, error } = await service
    .from("bank_transactions")
    .select("id,bank_account_id,direction,amount_cents,transaction_date")
    .eq("org_id", orgId)
    .eq("id", id)
    .single();
  if (error || !transaction) throw new Error("Transaction not found");
  const { data: bank, error: bankError } = await service
    .from("bank_accounts")
    .select("gl_account_id")
    .eq("org_id", orgId)
    .eq("id", transaction.bank_account_id)
    .single();
  if (bankError) throw new Error(bankError.message);
  const [receipts, history, matches, candidates] = await Promise.all([
    service
      .from("bank_receipts")
      .select("id,file_id,extracted,files(id,org_id,file_name,storage_path,mime_type,size_bytes,visibility,created_at,updated_at)")
      .eq("org_id", orgId)
      .eq("transaction_id", id),
    listEntityAuditTrail({
      entityType: "bank_transaction",
      entityId: id,
      orgId,
      permission: "books.read",
    }),
    service
      .from("bank_transaction_matches")
      .select("id,journal_line_id,matched_amount_cents,status,confirmed_at")
      .eq("org_id", orgId)
      .eq("bank_transaction_id", id),
    bank?.gl_account_id
      ? loadMatchCandidates(service, orgId, bank.gl_account_id, transaction)
      : Promise.resolve({ available: [], truncated: false }),
  ]);
  for (const result of [receipts, matches])
    if (result.error) throw new Error(result.error.message);
  const { available, truncated } = candidates;
  const expenses = await loadCapturedExpenses(
    service,
    orgId,
    available.flatMap((c) => (c.expenseId ? [c.expenseId] : [])),
  );
  return {
    receipts: receipts.data ?? [],
    history,
    matches: matches.data ?? [],
    candidates: available.map(({ expenseId, ...c }) => ({
      ...c,
      expense: expenseId ? (expenses.get(expenseId) ?? null) : null,
    })),
    candidatesTruncated: truncated,
  };
}
export async function uploadBankingReceipt(formData: FormData) {
  const { service, orgId, userId } = await context(true);
  const file = formData.get("file");
  if (
    !(file instanceof File) ||
    file.size > 20 * 1024 * 1024 ||
    ![
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ].includes(file.type)
  )
    throw new Error("Choose a PDF or receipt image up to 20 MB.");
  const transactionId = z
    .string()
    .uuid()
    .nullable()
    .parse(formData.get("transactionId") || null);
  if (transactionId) {
    const { data, error } = await service
      .from("bank_transactions")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", transactionId)
      .single();
    if (error || !data) throw new Error("Transaction not found");
  }
  const record = await createFileFromUpload(
    {
      file,
      visibility: "private",
      folderPath: "Banking/Receipts",
      shareWithClients: false,
      shareWithSubs: false,
    },
    orgId,
  );
  const { data, error } = await service
    .from("bank_receipts")
    .upsert(
      {
        org_id: orgId,
        file_id: record.id,
        transaction_id: transactionId,
        created_by: userId,
      },
      { onConflict: "org_id,file_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  // Saving succeeds independently of extraction; unreadable receipts stay usable.
  let extracted = null;
  let extractionError: string | null = null;
  try {
    extracted = await extractExpenseReceiptFromFile(file, {
      orgId,
      entityId: data.id,
    });
  } catch (error) {
    extractionError =
      error instanceof Error ? error.message : "Could not read receipt";
  }
  const updated = await service
    .from("bank_receipts")
    .update({ extracted, extraction_error: extractionError })
    .eq("org_id", orgId)
    .eq("id", data.id);
  if (updated.error) throw new Error(updated.error.message);
  await recordAudit({
    orgId,
    actorId: userId,
    action: "insert",
    entityType: "bank_transaction",
    entityId: transactionId ?? data.id,
    after: { receiptId: data.id, fileId: record.id },
    source: "books.banking.receipt",
  });
  return {
    id: data.id,
    fileId: record.id,
    url: buildInternalFileUrl(record.id),
    extracted,
    extractionError,
  };
}
export async function loadBankingReceiptInbox() {
  const { service, orgId } = await context();
  const { data, error } = await service
    .from("bank_receipts")
    .select("id,file_id,extracted,extraction_error,files(id,org_id,file_name,storage_path,mime_type,size_bytes,visibility,created_at,updated_at)")
    .eq("org_id", orgId)
    .is("transaction_id", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return Promise.all(
    (data ?? []).map(async (receipt) => {
      const extracted = receipt.extracted as {
        totalDollars: number | null;
        vendorName: string | null;
        expenseDate: string | null;
      } | null;
      if (!extracted?.expenseDate || extracted.totalDollars == null)
        return { ...receipt, candidates: [] };
      const date = Date.parse(extracted.expenseDate);
      const { data: candidates, error: candidateError } = await service
        .from("bank_transactions")
        .select("id,amount_cents,merchant_name,description,transaction_date")
        .eq("org_id", orgId)
        .eq("amount_cents", Math.round(Math.abs(extracted.totalDollars) * 100))
        .eq("lifecycle_status", "posted")
        .eq("excluded", false)
        .gte(
          "transaction_date",
          new Date(date - 7 * 86400000).toISOString().slice(0, 10),
        )
        .lte(
          "transaction_date",
          new Date(date + 7 * 86400000).toISOString().slice(0, 10),
        )
        .limit(50);
      if (candidateError) throw new Error(candidateError.message);
      const ranked = receiptCandidates(extracted, candidates ?? []);
      return {
        ...receipt,
        candidates: (candidates ?? []).map((c) => ({
          ...c,
          strong: ranked.find((r) => r.id === c.id)?.strong ?? false,
        })),
      };
    }),
  );
}
export async function linkBankingReceipt(raw: {
  receiptId: string;
  transactionId: string | null;
}) {
  const input = z
    .object({
      receiptId: z.string().uuid(),
      transactionId: z.string().uuid().nullable(),
    })
    .parse(raw);
  const { service, orgId, userId } = await context(true);
  if (input.transactionId) {
    const { data, error } = await service
      .from("bank_transactions")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", input.transactionId)
      .single();
    if (error || !data) throw new Error("Transaction not found");
  }
  const { data, error } = await service
    .from("bank_receipts")
    .update({ transaction_id: input.transactionId })
    .eq("org_id", orgId)
    .eq("id", input.receiptId)
    .select("id")
    .single();
  if (error || !data)
    throw new Error("Receipt not found or could not be attached");
  await recordAudit({
    orgId,
    actorId: userId,
    action: "update",
    entityType: "bank_receipt",
    entityId: input.receiptId,
    after: input,
    source: "books.banking.receipt",
  });
  return data;
}
export async function createBankingVendor(name: string) {
  const { orgId } = await context(true);
  return createCompany({
    orgId,
    input: {
      name: z.string().trim().min(2).max(120).parse(name),
      company_type: "supplier",
    },
  });
}
export async function refreshBankingFeeds() {
  const { service, orgId } = await context(true);
  const { data, error } = await service
    .from("bank_feed_connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("provider", "plaid")
    .in("status", ["active", "reauth_required", "error"]);
  if (error) throw new Error(error.message);
  const results = await Promise.allSettled(
    (data ?? []).map((row) => syncBankFeedConnection(row.id, undefined, { runAiSuggestions: false })),
  );
  const refreshedConnectionIds = (data ?? []).flatMap((row, index) =>
    results[index]?.status === "fulfilled" ? [row.id] : [],
  );
  let lastSyncedAt: string | null = null;
  if (refreshedConnectionIds.length > 0) {
    const { data: refreshedConnections, error: refreshedConnectionsError } = await service
      .from("bank_feed_connections")
      .select("last_refresh_at")
      .eq("org_id", orgId)
      .in("id", refreshedConnectionIds)
      .order("last_refresh_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (!refreshedConnectionsError) {
      lastSyncedAt = refreshedConnections?.[0]?.last_refresh_at ?? null;
    }
  }
  let aiSuggestions = { assessed: 0, failed: 0 };
  try {
    aiSuggestions = await processBankAiSuggestionsForOrg(orgId);
  } catch (error) {
    console.error("[banking-ai] Suggestion processing failed after manual refresh", error);
  }
  return {
    connectionCount: (data ?? []).length,
    refreshed: refreshedConnectionIds.length,
    errors: results.flatMap((r) =>
      r.status === "rejected"
        ? [r.reason instanceof Error ? r.reason.message : "Feed refresh failed"]
        : [],
    ),
    aiSuggestions,
    lastSyncedAt,
  };
}

const UNSTATEMENTED_WINDOW_DAYS = 90;
const UNSTATEMENTED_ROW_CAP = 200;
/** Paid on a statement: cash never reaches one, and a personal reimbursement is paid to a person. */
const STATEMENT_PAYMENT_METHODS = ["credit_card", "company_card", "ach", "check", "other"];

export type UnmatchedCapturedExpense = {
  expenseId: string;
  expenseDate: string;
  amountCents: number;
  vendorName: string | null;
  description: string;
  homeLabel: string;
  projectId: string | null;
  hasReceipt: boolean;
  receiptFileId: string | null;
};

/**
 * Approved expenses that should appear on a statement and have not: the posted
 * journal's payment-account line has no confirmed bank match. Only payment
 * accounts that are bank-feed accounts count, since only those can be matched.
 */
export async function loadUnmatchedCapturedExpenses() {
  const { service, orgId } = await context();
  const since = new Date(Date.now() - UNSTATEMENTED_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [expenseRows, bankAccounts] = await Promise.all([
    collectBooksRows((from, to) =>
      service
        .from("project_expenses")
        .select(
          "id,expense_date,amount_cents,tax_cents,description,vendor_name_text,vendor_company_id,project_id,overhead_category,receipt_file_id",
        )
        .eq("org_id", orgId)
        .in("status", [...POSTED_EXPENSE_STATUSES])
        .in("payment_method", STATEMENT_PAYMENT_METHODS)
        .gte("expense_date", since)
        .order("expense_date", { ascending: false })
        .order("id")
        .range(from, to),
    ),
    collectBooksRows((from, to) =>
      service
        .from("bank_accounts")
        .select("id,gl_account_id")
        .eq("org_id", orgId)
        .order("id")
        .range(from, to),
    ),
  ]);
  const feedGlIds = new Set(
    bankAccounts.flatMap((a) => (a.gl_account_id ? [String(a.gl_account_id)] : [])),
  );
  if (expenseRows.length === 0 || feedGlIds.size === 0)
    return { rows: [] as UnmatchedCapturedExpense[], truncated: false, rowCap: UNSTATEMENTED_ROW_CAP };
  const expenseIds = expenseRows.map((row) => String(row.id));
  const chunks: string[][] = [];
  for (let i = 0; i < expenseIds.length; i += 200) chunks.push(expenseIds.slice(i, i + 200));
  const entryResults = await Promise.all(
    chunks.map((chunk) =>
      service
        .from("journal_entries")
        .select(
          "source_id,lines:journal_lines!journal_lines_entry_owner_fk(id,account_id,credit_cents,matches:bank_transaction_matches(status))",
        )
        .eq("org_id", orgId)
        .eq("source_type", "expense")
        .eq("status", "posted")
        .in("source_id", chunk),
    ),
  );
  const entrySchema = z.array(
    z.object({
      source_id: z.string(),
      lines: z.array(
        z.object({
          id: z.string(),
          account_id: z.string(),
          credit_cents: z.coerce.number(),
          matches: z.array(z.object({ status: z.string() })),
        }),
      ),
    }),
  );
  /** expense id -> the payment-account lines posted for it, each with whether a bank line confirmed it */
  const paymentLines = new Map<string, boolean[]>();
  for (const result of entryResults) {
    if (result.error) throw new Error(result.error.message);
    for (const entry of entrySchema.parse(result.data ?? [])) {
      const lines = entry.lines.filter(
        (line) => line.credit_cents > 0 && feedGlIds.has(line.account_id),
      );
      if (lines.length === 0) continue;
      const states = paymentLines.get(entry.source_id) ?? [];
      for (const line of lines)
        states.push(line.matches.some((m) => m.status === "confirmed"));
      paymentLines.set(entry.source_id, states);
    }
  }
  const unmatched = expenseRows.filter((row) => {
    const states = paymentLines.get(String(row.id));
    return states !== undefined && states.some((matched) => !matched);
  });
  const truncated = unmatched.length > UNSTATEMENTED_ROW_CAP;
  const shown = unmatched.slice(0, UNSTATEMENTED_ROW_CAP);
  const details = await loadCapturedExpenses(
    service,
    orgId,
    shown.map((row) => String(row.id)),
  );
  return {
    rows: shown.map((row): UnmatchedCapturedExpense => {
      const detail = details.get(String(row.id));
      return {
        expenseId: String(row.id),
        expenseDate: String(row.expense_date),
        amountCents: Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0),
        vendorName: detail?.vendorName ?? null,
        description: String(row.description ?? ""),
        homeLabel: detail?.homeLabel ?? "Needs a job or category",
        projectId: row.project_id ? String(row.project_id) : null,
        hasReceipt: detail?.hasReceipt ?? false,
        receiptFileId: detail?.receiptFileId ?? null,
      };
    }),
    truncated,
    rowCap: UNSTATEMENTED_ROW_CAP,
  };
}
