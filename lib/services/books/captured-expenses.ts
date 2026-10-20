import "server-only";
import { z } from "zod";
import {
  capturedExpenseMatch,
  matchWindowBounds,
  type CapturedExpense,
} from "./banking-model";
import { expenseHome, expenseHomeLabel } from "@/lib/financials/overhead";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";

type Service = ReturnType<typeof createServiceSupabaseClient>;

const CANDIDATE_CAP = 500;

const journalEntrySource = z.object({
  entry_date: z.string(),
  source_type: z.string().nullable(),
  source_id: z.string().nullable(),
});
const capturedExpenseRow = z.object({
  id: z.string(),
  vendor_name_text: z.string().nullable(),
  vendor_company_id: z.string().nullable(),
  project_id: z.string().nullable(),
  overhead_category: z.string().nullable(),
  receipt_file_id: z.string().nullable(),
});

/** Who, where and whether-receipted for each expense id: two batched reads, never one per line. */
export async function loadCapturedExpenses(
  service: Service,
  orgId: string,
  expenseIds: string[],
) {
  const result = new Map<string, CapturedExpense>();
  const ids = [...new Set(expenseIds)];
  if (ids.length === 0) return result;
  const { data, error } = await service
    .from("project_expenses")
    .select(
      "id,vendor_name_text,vendor_company_id,project_id,overhead_category,receipt_file_id",
    )
    .eq("org_id", orgId)
    .in("id", ids.slice(0, 500));
  if (error) throw new Error(error.message);
  const rows = z.array(capturedExpenseRow).parse(data ?? []);
  const projectIds = [...new Set(rows.flatMap((r) => (r.project_id ? [r.project_id] : [])))];
  const companyIds = [
    ...new Set(rows.flatMap((r) => (r.vendor_company_id ? [r.vendor_company_id] : []))),
  ];
  const [projects, companies] = await Promise.all([
    projectIds.length
      ? service.from("projects").select("id,name").eq("org_id", orgId).in("id", projectIds)
      : Promise.resolve({ data: [], error: null }),
    companyIds.length
      ? service.from("companies").select("id,name").eq("org_id", orgId).in("id", companyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) throw new Error(projects.error.message);
  if (companies.error) throw new Error(companies.error.message);
  const projectName = new Map((projects.data ?? []).map((p) => [String(p.id), String(p.name)]));
  const companyName = new Map((companies.data ?? []).map((c) => [String(c.id), String(c.name)]));
  for (const row of rows)
    result.set(row.id, {
      expenseId: row.id,
      vendorName:
        row.vendor_name_text?.trim() ||
        (row.vendor_company_id ? (companyName.get(row.vendor_company_id) ?? null) : null),
      homeLabel: expenseHomeLabel(
        expenseHome(row),
        row.project_id ? projectName.get(row.project_id) : null,
      ),
      hasReceipt: row.receipt_file_id !== null,
      receiptFileId: row.receipt_file_id,
    });
  return result;
}


/**
 * The posted ledger lines on a bank account that could be this transaction: the
 * right side of the cash account, inside the match window, nearest the window's
 * start first, still holding an unmatched balance.
 */
export async function loadMatchCandidates(
  service: Service,
  orgId: string,
  glAccountId: string,
  transaction: { direction: string; transaction_date: string },
) {
  const { from, to } = matchWindowBounds(transaction.transaction_date);
  const { data, error } = await service
    .from("journal_lines")
    .select(
      "id,debit_cents,credit_cents,description,entry:journal_entries!journal_lines_entry_owner_fk!inner(entry_date,status,memo,source_type,source_id),matches:bank_transaction_matches(matched_amount_cents,status)",
    )
    .eq("org_id", orgId)
    .eq("account_id", glAccountId)
    .eq("entry.status", "posted")
    .gte("entry.entry_date", from)
    .lte("entry.entry_date", to)
    .gt(transaction.direction === "inflow" ? "debit_cents" : "credit_cents", 0)
    .order("entry_date", { referencedTable: "journal_entries", ascending: true })
    .order("id")
    .limit(CANDIDATE_CAP);
  if (error) throw new Error(error.message);
  const available = (data ?? [])
    .map((c) => {
      const used = (c.matches as Array<{ status: string; matched_amount_cents: number }>)
        .filter((m) => m.status === "confirmed")
        .reduce((sum, m) => sum + Number(m.matched_amount_cents), 0);
      const entry = journalEntrySource.safeParse(Array.isArray(c.entry) ? c.entry[0] : c.entry).data;
      return {
        ...c,
        entryDate: entry?.entry_date ?? "",
        expenseId: entry?.source_type === "expense" ? (entry.source_id ?? null) : null,
        availableCents: Number(c.debit_cents) + Number(c.credit_cents) - used,
      };
    })
    .filter((c) => c.availableCents > 0);
  return { available, truncated: (data?.length ?? 0) >= CANDIDATE_CAP };
}

/**
 * Refuses to cost a card charge a second time. An approved captured expense
 * already posted its cost, so posting or categorizing the charge would record
 * it twice; it has to be matched to the expense's ledger line instead. Every
 * path that posts a bank transaction (the workspace, bulk post, bank rules, the
 * mobile categorize action) runs this, so the check cannot be skipped by
 * choosing a different door.
 */
export async function assertNotCapturedExpense(
  service: Service,
  orgId: string,
  transactionId: string,
) {
  const { data: transaction, error } = await service
    .from("bank_transactions")
    .select("id,direction,amount_cents,transaction_date,merchant_name,description,bank_account:bank_accounts!inner(gl_account_id)")
    .eq("org_id", orgId)
    .eq("id", transactionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!transaction || transaction.direction !== "outflow") return;
  const account = Array.isArray(transaction.bank_account) ? transaction.bank_account[0] : transaction.bank_account;
  if (!account?.gl_account_id) return;
  const { available } = await loadMatchCandidates(service, orgId, account.gl_account_id, transaction);
  const expenses = await loadCapturedExpenses(
    service,
    orgId,
    available.flatMap((c) => (c.expenseId ? [c.expenseId] : [])),
  );
  const match = capturedExpenseMatch(
    {
      date: transaction.transaction_date,
      amountCents: Number(transaction.amount_cents),
      direction: "outflow",
      counterparty: transaction.merchant_name ?? transaction.description,
    },
    available.map((c) => ({
      id: c.id,
      availableCents: c.availableCents,
      entryDate: c.entryDate,
      expense: c.expenseId ? (expenses.get(c.expenseId) ?? null) : null,
    })),
  );
  if (match?.expense)
    throw new Error(
      `This charge is already recorded as the approved expense${match.expense.vendorName ? ` from ${match.expense.vendorName}` : ""} (${match.expense.homeLabel}). Match it to that expense instead of posting it again.`,
    );
}
