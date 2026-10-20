import "server-only";

import {
  expenseApprovalRefusal,
  expenseHome,
  expenseHomeLabel,
  isOverheadCategory,
  OVERHEAD_CATEGORY_LABELS,
  type OverheadCategory,
} from "@/lib/financials/overhead";
import { POSTED_EXPENSE_STATUSES } from "@/lib/financials/ledger-status";
import { enqueueProjectExpenseSync } from "@/lib/services/accounting-sync";
import { recordAudit } from "@/lib/services/audit";
import { requireAuthorization } from "@/lib/services/authorization";
import { validateBooksExpensePaymentAccount } from "@/lib/services/books/funding";
import { requireOrgContext } from "@/lib/services/context";
import {
  approveProjectExpense,
  createProjectExpense,
  DUPLICATE_EXPENSE_ERROR_PREFIX,
  propagateApprovalToLedger,
  rejectProjectExpense,
} from "@/lib/services/cost-plus";
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files";
import { recordEvent } from "@/lib/services/events";
import { voidJobCostEntryForSource } from "@/lib/services/job-cost-actuals";
import { hasPermission, requirePermission } from "@/lib/services/permissions";
import {
  expenseDecisionSchema,
  expenseHomeSchema,
  orgExpenseCreateSchema,
  orgExpenseListSchema,
  type OrgExpenseQueue,
} from "@/lib/validation/org-expenses";

/**
 * Expenses across the company: the office review queue for every captured
 * receipt, and the workbench for overhead — fuel, tools, shop supplies — that
 * belongs to no job. A job expense is still a project expense and keeps its
 * project workbench; this module only adds the homes a project cannot give.
 */

const ROW_CAP = 200;

const EXPENSE_COLUMNS =
  "id, project_id, overhead_category, vendor_name_text, description, expense_date, amount_cents, tax_cents, payment_method, status, receipt_file_id, billable_cost_id, submitted_by_user_id, created_at, updated_at, project:projects(id, name), submitter:app_users!project_expenses_submitted_by_user_id_fkey(id, full_name)";

type ExpenseRow = {
  id: string;
  project_id: string | null;
  overhead_category: string | null;
  vendor_name_text: string | null;
  description: string | null;
  expense_date: string;
  amount_cents: number;
  tax_cents: number;
  payment_method: string | null;
  status: string;
  receipt_file_id: string | null;
  billable_cost_id: string | null;
  submitted_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  project: { id: string; name: string } | Array<{ id: string; name: string }> | null;
  submitter: { id: string; full_name: string | null } | Array<{ id: string; full_name: string | null }> | null;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function mapExpense(row: ExpenseRow) {
  const home = expenseHome(row);
  const project = one(row.project);
  return {
    id: row.id,
    home,
    homeLabel: expenseHomeLabel(home, project?.name ?? null),
    projectId: row.project_id,
    projectName: project?.name ?? null,
    overheadCategory: home.kind === "overhead" ? home.category : null,
    vendorName: row.vendor_name_text,
    description: row.description,
    expenseDate: row.expense_date,
    totalCents: Number(row.amount_cents) + Number(row.tax_cents),
    amountCents: Number(row.amount_cents),
    taxCents: Number(row.tax_cents),
    paymentMethod: row.payment_method,
    status: row.status,
    hasReceipt: Boolean(row.receipt_file_id),
    receiptFileId: row.receipt_file_id,
    submittedBy: one(row.submitter)?.full_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export type OrgExpense = ReturnType<typeof mapExpense>;

function monthStart(today: string) {
  return `${today.slice(0, 7)}-01`;
}

/**
 * The office's expense desk: one queue at a time, capped, plus this month's
 * overhead beside job cost so the owner sees what the shop itself costs.
 */
export async function loadOrgExpenseDesk(raw: unknown = {}) {
  const { queue } = orgExpenseListSchema.parse(raw);
  const context = await requireOrgContext();
  await requirePermission("bill.read", context);
  const { supabase, orgId } = context;
  const today = new Date().toISOString().slice(0, 10);
  const since = monthStart(today);

  const base = () =>
    supabase.from("project_expenses").select(EXPENSE_COLUMNS, { count: "exact" }).eq("org_id", orgId);
  const filtered = (q: OrgExpenseQueue) => {
    const query = base();
    if (q === "review") return query.eq("status", "submitted");
    if (q === "unsorted") return query.is("project_id", null).is("overhead_category", null).neq("status", "rejected");
    if (q === "overhead") return query.is("project_id", null).not("overhead_category", "is", null);
    return query;
  };
  const head = (q: OrgExpenseQueue) => {
    const query = supabase.from("project_expenses").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    if (q === "review") return query.eq("status", "submitted");
    if (q === "unsorted") return query.is("project_id", null).is("overhead_category", null).neq("status", "rejected");
    return query.is("project_id", null).not("overhead_category", "is", null);
  };

  const [rows, review, unsorted, overhead, month, jobs, canWrite, canApprove] = await Promise.all([
    filtered(queue)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(ROW_CAP),
    head("review"),
    head("unsorted"),
    head("overhead"),
    supabase
      .from("project_expenses")
      .select("project_id, overhead_category, amount_cents, tax_cents")
      .eq("org_id", orgId)
      .in("status", [...POSTED_EXPENSE_STATUSES])
      .gte("expense_date", since)
      .lte("expense_date", today)
      .limit(5_000),
    supabase
      .from("projects")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("phase", "delivery")
      .not("status", "in", "(completed,cancelled)")
      .order("name")
      .limit(500),
    hasPermission("bill.write", context),
    hasPermission("bill.approve", context),
  ]);
  for (const result of [rows, review, unsorted, overhead, month, jobs])
    if (result.error) throw new Error(`Failed to load expenses: ${result.error.message}`);

  const byCategory = new Map<OverheadCategory, number>();
  let overheadCents = 0;
  let jobCostCents = 0;
  for (const row of month.data ?? []) {
    const total = Number(row.amount_cents) + Number(row.tax_cents);
    if (row.project_id) jobCostCents += total;
    else if (isOverheadCategory(row.overhead_category)) {
      overheadCents += total;
      byCategory.set(row.overhead_category, (byCategory.get(row.overhead_category) ?? 0) + total);
    }
  }

  const list = ((rows.data ?? []) as ExpenseRow[]).map(mapExpense);
  return {
    queue,
    rows: list,
    total: rows.count ?? list.length,
    truncated: (rows.count ?? 0) > list.length,
    cap: ROW_CAP,
    counts: { review: review.count ?? 0, unsorted: unsorted.count ?? 0, overhead: overhead.count ?? 0 },
    month: {
      since,
      overheadCents,
      jobCostCents,
      // A month cut at 5,000 posted expenses is not a total; say so rather than understate it.
      complete: (month.data ?? []).length < 5_000,
      byCategory: [...byCategory.entries()]
        .map(([category, cents]) => ({ category, label: OVERHEAD_CATEGORY_LABELS[category], cents }))
        .sort((left, right) => right.cents - left.cents),
    },
    jobs: (jobs.data ?? []).map((job) => ({ id: String(job.id), name: String(job.name) })),
    canWrite,
    canApprove,
  };
}
export type OrgExpenseDesk = Awaited<ReturnType<typeof loadOrgExpenseDesk>>;

/**
 * Capture a receipt from the office. A job puts it on that job exactly as the
 * project workbench would; no job puts it in overhead (with a category) or in
 * the unsorted pile for whoever reviews expenses.
 */
export async function createOrgExpense(raw: unknown, receipt: File | null) {
  const input = orgExpenseCreateSchema.parse(raw);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;

  if (input.project_id) {
    const receiptFileId = await uploadCostPlusFile({ file: receipt, orgId, projectId: input.project_id, kind: "expense_receipt" });
    const created = await createProjectExpense(
      {
        projectId: input.project_id,
        expenseDate: new Date(`${input.expense_date}T00:00:00Z`),
        amountCents: input.amount_cents,
        taxCents: input.tax_cents,
        vendorNameText: input.vendor_name || null,
        paymentMethod: input.payment_method,
        booksPaymentAccountId: input.books_payment_account_id,
        qboTransactionType: "purchase",
        description: input.description || null,
        receiptFileId,
        isBillable: true,
        allowDuplicate: input.allow_duplicate,
      },
      orgId,
    );
    return { id: String(created.id) };
  }

  await requirePermission("bill.write", context);
  if (!input.allow_duplicate) {
    const { data: candidates, error } = await supabase
      .from("project_expenses")
      .select("id, vendor_name_text")
      .eq("org_id", orgId)
      .is("project_id", null)
      .eq("expense_date", input.expense_date)
      .eq("amount_cents", input.amount_cents)
      .neq("status", "rejected")
      .limit(10);
    if (error) throw new Error(`Failed to check for duplicate expenses: ${error.message}`);
    const vendor = input.vendor_name.toLowerCase() || null;
    const duplicate = (candidates ?? []).find((row) => {
      const existing = (row.vendor_name_text as string | null)?.trim().toLowerCase() || null;
      return !vendor || !existing || existing === vendor;
    });
    if (duplicate)
      throw new Error(
        `${DUPLICATE_EXPENSE_ERROR_PREFIX} An expense for ${duplicate.vendor_name_text ?? "this vendor"} on this date with the same amount already exists.`,
      );
  }
  if (input.books_payment_account_id) await validateBooksExpensePaymentAccount(orgId, input.books_payment_account_id);

  const receiptFileId = await uploadCostPlusFile({ file: receipt, orgId, projectId: null, kind: "expense_receipt" });
  const { data, error } = await supabase
    .from("project_expenses")
    .insert({
      org_id: orgId,
      project_id: null,
      overhead_category: input.overhead_category,
      vendor_name_text: input.vendor_name || null,
      expense_date: input.expense_date,
      description: input.description || null,
      amount_cents: input.amount_cents,
      tax_cents: input.tax_cents,
      payment_method: input.payment_method,
      metadata: input.books_payment_account_id ? { books_payment_account_id: input.books_payment_account_id } : {},
      receipt_file_id: receiptFileId,
      // Overhead is the company's own cost; nobody is billed for it.
      is_billable: false,
      accounting_coding: { transaction_type: "purchase" },
      submitted_by_user_id: userId,
      status: "submitted",
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Failed to save the expense: ${error?.message}`);

  await Promise.all([
    recordAudit({ orgId, actorId: userId, action: "insert", entityType: "project_expense", entityId: data.id, after: data }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "expense_submitted",
      entityType: "project_expense",
      entityId: data.id,
      payload: { project_id: null, overhead_category: input.overhead_category, amount_cents: input.amount_cents },
    }),
  ]);
  return { id: String(data.id) };
}

async function loadExpense(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string, expenseId: string) {
  const { data, error } = await supabase
    .from("project_expenses")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", expenseId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the expense: ${error.message}`);
  if (!data) throw new Error("Expense not found.");
  return data;
}

async function requireJobAccess(context: Awaited<ReturnType<typeof requireOrgContext>>, projectId: string, permission: string) {
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    projectId,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  });
}

/**
 * Move an expense to a job, to an overhead category, or back to unsorted. An
 * approved expense moves its cost with it: the old job's cost entry is voided
 * and the new job's is posted, and Books re-posts it from the new home because
 * the row's revision advances. The audit keeps both homes.
 */
export async function assignExpenseHome(raw: unknown) {
  const input = expenseHomeSchema.parse(raw);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  const before = await loadExpense(supabase, orgId, input.expense_id);

  if (before.updated_at !== input.expected_updated_at)
    throw new Error("This expense changed since you opened it. Reload and try again.");
  if (before.status === "locked") throw new Error("This expense is locked in a closed period and cannot move.");
  if (before.status === "rejected") throw new Error("A rejected expense has no cost to move.");
  const posted = (POSTED_EXPENSE_STATUSES as readonly string[]).includes(String(before.status));
  if (posted && !input.project_id && !input.overhead_category)
    throw new Error("An approved expense needs a job or an overhead category.");

  const moving = before.project_id !== input.project_id;
  if (moving) {
    const { count, error } = await supabase
      .from("project_expense_lines")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("expense_id", before.id);
    if (error) throw new Error(`Failed to load the expense split: ${error.message}`);
    if ((count ?? 0) > 0) throw new Error("This expense is split across cost lines. Change the split on its job instead.");
    if (before.billable_cost_id)
      throw new Error("This expense is on the customer's cost-plus billing. Remove it from billing before moving it.");
  }

  if (before.project_id) await requireJobAccess(context, before.project_id, "bill.write");
  else await requirePermission("bill.write", context);
  if (input.project_id && moving) await requireJobAccess(context, input.project_id, "bill.write");

  const { data: after, error } = await supabase
    .from("project_expenses")
    .update({
      project_id: input.project_id,
      overhead_category: input.overhead_category,
      // Cost codes and budget lines belong to the job they were picked on.
      ...(moving ? { cost_code_id: null, budget_line_id: null, is_billable: Boolean(input.project_id) } : {}),
    })
    .eq("org_id", orgId)
    .eq("id", before.id)
    .eq("updated_at", input.expected_updated_at)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to move the expense: ${error.message}`);
  if (!after) throw new Error("This expense changed since you opened it. Reload and try again.");

  if (posted && moving) {
    if (before.project_id)
      await voidJobCostEntryForSource({ sourceType: "project_expense", sourceId: before.id, orgId, supabase });
    if (input.project_id) await propagateApprovalToLedger({ source: "project_expense", sourceId: before.id, orgId });
  }

  await Promise.all([
    recordAudit({ orgId, actorId: userId, action: "update", entityType: "project_expense", entityId: before.id, before, after }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "expense_reassigned",
      entityType: "project_expense",
      entityId: before.id,
      payload: {
        from_project_id: before.project_id,
        from_overhead_category: before.overhead_category,
        project_id: input.project_id,
        overhead_category: input.overhead_category,
        amount_cents: before.amount_cents,
      },
    }),
  ]);
  return { id: before.id, updatedAt: String(after.updated_at) };
}

/** Approve from the office queue. A job expense approves through its job's rules. */
export async function approveOrgExpense(raw: unknown) {
  const input = expenseDecisionSchema.parse(raw);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  const before = await loadExpense(supabase, orgId, input.expense_id);
  if (before.project_id) {
    await approveProjectExpense(before.id, orgId);
    return { id: before.id };
  }

  await requirePermission("bill.approve", context);
  if (before.status !== "submitted") throw new Error("Only a submitted expense can be approved.");
  const refusal = expenseApprovalRefusal(before);
  if (refusal) throw new Error(refusal);

  const { data: after, error } = await supabase
    .from("project_expenses")
    .update({ status: "approved", approved_by_pm_at: new Date().toISOString(), approved_by_pm_user_id: userId })
    .eq("org_id", orgId)
    .eq("id", before.id)
    .eq("status", "submitted")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to approve the expense: ${error.message}`);
  if (!after) throw new Error("This expense changed since you opened it. Reload and try again.");

  await Promise.all([
    recordAudit({ orgId, actorId: userId, action: "update", entityType: "project_expense", entityId: before.id, before, after }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "expense_approved",
      entityType: "project_expense",
      entityId: before.id,
      payload: { project_id: null, overhead_category: before.overhead_category, amount_cents: before.amount_cents },
    }),
  ]);
  await enqueueProjectExpenseSync(before.id, orgId);
  return { id: before.id };
}

export async function rejectOrgExpense(raw: unknown) {
  const input = expenseDecisionSchema.parse(raw);
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  const before = await loadExpense(supabase, orgId, input.expense_id);
  if (before.project_id) {
    await rejectProjectExpense(before.id, { rejectionReason: input.reason || null }, orgId);
    return { id: before.id };
  }

  await requirePermission("bill.approve", context);
  if (before.status === "locked") throw new Error("This expense is locked in a closed period.");
  const { data: after, error } = await supabase
    .from("project_expenses")
    .update({ status: "rejected", rejection_reason: input.reason || null })
    .eq("org_id", orgId)
    .eq("id", before.id)
    .select("*")
    .single();
  if (error || !after) throw new Error(`Failed to reject the expense: ${error?.message}`);

  await Promise.all([
    recordAudit({ orgId, actorId: userId, action: "update", entityType: "project_expense", entityId: before.id, before, after }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "expense_rejected",
      entityType: "project_expense",
      entityId: before.id,
      payload: { project_id: null },
    }),
  ]);
  return { id: before.id };
}
