"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createProjectVendorBill,
  updateVendorBillStatus,
  reverseManualBillPayment,
  type ManualPaymentReversalResult,
  listVendorBillsForProject,
  deleteVendorBill,
  reassignImportedPayable,
  approveVendorBillsAtomic,
  submitVendorBillsForApproval,
  type BulkOperationMode,
  type VendorBillBulkOutcome,
  type VendorBillSummary,
  ensureVendorBillCompany,
} from "@/lib/services/vendor-bills";
import { releaseRetainage } from "@/lib/services/ap-retainage";
import { listProjectCommitments } from "@/lib/services/commitments";
import { listProjectBudgetLines } from "@/lib/services/budgets";
import { listCostCodes } from "@/lib/services/cost-codes";
import { getProjectCostCodesEnabled } from "@/lib/financials/cost-codes-enabled";
import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  AuthorizationError,
  requireAuthorization,
} from "@/lib/services/authorization";
import { resolveAccountingTarget } from "@/lib/services/accounting-target";
import { getProvider } from "@/lib/integrations/accounting/registry";
import { DIMENSION_LABELS } from "@/lib/integrations/accounting/catalog";
import { getAccountingSyncStates } from "@/lib/services/accounting-sync-state";
import { requestAccountingPush } from "@/lib/services/accounting-requests";
import { accountingReference } from "@/lib/services/accounting-coding";
import { suggestCoding } from "@/lib/services/books/coding-rules";
import { resolveLedgerAuthority } from "@/lib/services/books/authority";
import { suggestPayableCodingFromInvoice } from "@/lib/services/document-extraction";
import { previewCommitmentLineMatch } from "@/lib/services/payable-line-matching";
import { enqueueOutboxJob } from "@/lib/services/outbox";
import type {
  InvoiceLineForMatch,
  PayableLineMatchAssessment,
} from "@/lib/financials/payable-line-match";

import { actionError, type ActionResult } from "@/lib/action-result";

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() };
  } catch (error) {
    return actionError(error);
  }
}

export type PayableActionResult =
  | { success: true }
  | { success: false; error: string };
export type PayableMutationResult<T = VendorBillSummary> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function approveVendorBillsAtomicAction(
  items: Array<{ id: string; expected_updated_at?: string }>,
  mode: BulkOperationMode = "all_or_nothing",
): Promise<ActionResult<{ approvedCount: number; outcomes: VendorBillBulkOutcome[] }>> {
  return run(async () => {
    const result = await approveVendorBillsAtomic(items, undefined, mode);
    revalidatePath("/payables");
    revalidatePath("/projects/[id]/financials/payables", "page");
    return result;
  });
}

export async function submitVendorBillsForApprovalAction(ids: string[]): Promise<ActionResult<VendorBillBulkOutcome[]>> {
  return run(async () => {
    const result = await submitVendorBillsForApproval(ids)
    revalidatePath("/payables")
    revalidatePath("/projects/[id]/financials/payables", "page")
    return result
  })
}

/**
 * Turn a thrown error into a user-facing message. Server Actions redact thrown
 * error messages in production (the client only gets a generic "an error
 * occurred" + digest), so user-facing failures must be returned as data, not
 * thrown, for the real message to reach the toast.
 */
function toPayableActionError(error: unknown): string {
  console.error("[Payables Action Error]:", error);
  if (error instanceof AuthorizationError) {
    return "You don't have permission to do that.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function revalidatePayablesPages(projectId?: string | null) {
  // Not `/projects/[id]/payables` — that route is a redirect stub, so
  // revalidating it refreshed nothing anybody looks at. The org desk lists the
  // same payables and has to move with the project one.
  if (projectId) {
    revalidatePath(`/projects/${projectId}/financials`);
    revalidatePath(`/projects/${projectId}/financials/payables`);
    revalidatePath(`/projects/${projectId}`);
  }
  revalidatePath("/payables");
}

export async function updateProjectVendorBillStatusAction(
  projectId: string,
  billId: string,
  input: unknown,
): Promise<ActionResult<PayableMutationResult>> {
  return run(async () => {
    try {
      const updated = await updateVendorBillStatus({
        billId,
        input: input as any,
      });
      revalidatePayablesPages(projectId);
      return { success: true, data: updated };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

/**
 * Reverse a payment somebody recorded by hand.
 *
 * The counterpart to recording one. A rail payment is not reversible here —
 * money that actually moved comes back through the provider, not by editing
 * Arc's copy of the story.
 */
export async function reverseManualBillPaymentAction(
  projectId: string,
  input: { paymentId: string; amountCents?: number; reason: string; idempotencyKey?: string },
): Promise<ActionResult<PayableMutationResult<ManualPaymentReversalResult>>> {
  return run(async () => {
    try {
      const reversed = await reverseManualBillPayment(input);
      revalidatePayablesPages(projectId);
      return { success: true, data: reversed };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

/**
 * Release held retainage as its own payable.
 *
 * The workspace used to do this by sending `retainage_percent: 0` on the
 * original bill — editing accounting evidence to achieve a payment, which is
 * exactly what `releaseRetainage` was written to replace. The release now goes
 * through the normal approval, hold and payment path, and the original keeps
 * saying what it always said.
 */
export async function releaseRetainageAction(
  projectId: string,
  billId: string,
  amountCents?: number,
  reason?: string,
): Promise<
  ActionResult<
    PayableMutationResult<{
      releaseBillId: string;
      amountCents: number;
      remainingHeldCents: number;
    }>
  >
> {
  return run(async () => {
    try {
      const result = await releaseRetainage({
        bill_id: billId,
        amount_cents: amountCents,
        reason,
      });
      revalidatePayablesPages(projectId);
      revalidatePath("/payables");
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

export async function createProjectVendorBillAction(
  projectId: string | null,
  input: unknown,
): Promise<ActionResult<PayableMutationResult>> {
  return run(async () => {
    try {
      const bill = await createProjectVendorBill({
        projectId,
        input: input as any,
      });
      if (projectId && bill.lien_waiver_status === "requested") {
        const { orgId } = await requireOrgContext();
        await enqueueOutboxJob({
          orgId,
          jobType: "chase_vendor_bill_waiver",
          payload: { bill_id: bill.id, project_id: projectId },
          dedupeByPayloadKeys: ["bill_id"],
        });
      }
      revalidatePayablesPages(projectId);
      return { success: true, data: bill };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

export async function ensureProjectVendorCompanyForPayableAction(
  projectId: string,
  billId: string,
) {
  return run(async () => {
    const company = await ensureVendorBillCompany({ projectId, billId });

    revalidatePayablesPages(projectId);
    revalidatePath(`/companies/${company.id}`);
    revalidatePath("/directory");
    return company;
  });
}

export async function listProjectCommitmentsForPayablesAction(
  projectId: string,
) {
  return listProjectCommitments(projectId);
}

/** Everything the creation workspace needs for project or overhead coding. */
export async function getPayableCreationContextAction(projectId?: string | null) {
  const { orgId, supabase, userId } = await requireOrgContext();
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId,
    projectId: projectId ?? undefined,
    supabase,
    resourceType: projectId ? "project" : "vendor_bill",
    resourceId: projectId ?? "new",
  });
  const [costCodesEnabled, budgetLines, costCodes, accounting, taxJurisdictions] =
    await Promise.all([
      projectId ? getProjectCostCodesEnabled(supabase, orgId, projectId) : Promise.resolve(false),
      projectId ? listProjectBudgetLines(projectId, orgId).catch(() => []) : Promise.resolve([]),
      listCostCodes(orgId).catch(() => []),
      getPayablesAccountingContextAction(projectId ?? undefined),
      createServiceSupabaseClient().from("books_tax_jurisdictions").select("id,name,use_tax_rate_micros").eq("org_id", orgId).eq("active", true).order("name").then(({ data }) => data ?? []),
    ]);
  return { costCodesEnabled, budgetLines, costCodes, accounting, taxJurisdictions };
}

const payableCodingSuggestionInput = z.object({
  projectId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  vendorName: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

/**
 * No prose. The coding lands in the fields the bookkeeper is already reading,
 * and `source` + `confidence` are what the bill records about how it got there.
 */
export type PayableCreationCodingSuggestion = {
  source: "learned" | "ai";
  costCodeId: string | null;
  budgetLineId: string | null;
  expenseAccountId: string | null;
  apAccountId: string | null;
  confidence: number;
};

/** Learned vendor rules win; AI is the fallback when this is a new case. */
export async function suggestPayableCreationCodingAction(
  input: unknown,
): Promise<ActionResult<PayableCreationCodingSuggestion | null>> {
  try {
    const parsed = payableCodingSuggestionInput.parse(input);
    const { orgId } = await requireOrgContext();
    const [rule, context] = await Promise.all([
      suggestCoding({
        companyId: parsed.companyId,
        vendorName: parsed.vendorName,
        memo: parsed.description,
        projectId: parsed.projectId,
        orgId,
      }),
      getPayableCreationContextAction(parsed.projectId),
    ]);

    if (rule) {
      return {
        success: true,
        data: {
          source: "learned",
          costCodeId: rule.costCodeId,
          budgetLineId: rule.budgetLineId,
          expenseAccountId:
            accountingReference(rule.accountingCoding, "expense_account")?.id ??
            null,
          apAccountId:
            accountingReference(rule.accountingCoding, "ap_account")?.id ??
            null,
          confidence: rule.confidence,
        },
      };
    }

    const ai = await suggestPayableCodingFromInvoice({
      orgId,
      vendorName: parsed.vendorName,
      description: parsed.description,
      costCodes: context.costCodes.map((item) => ({
        id: item.id,
        label: `${item.code} · ${item.name}`,
      })),
      budgetLines: context.budgetLines.map((item) => ({
        id: item.id,
        label: item.description?.trim() || "Untitled budget line",
      })),
      expenseAccounts: context.accounting.expenseAccounts.map(
        (item: { id: string; name: string }) => ({
          id: item.id,
          label: item.name,
        }),
      ),
      apAccounts: context.accounting.apAccounts.map(
        (item: { id: string; name: string }) => ({
          id: item.id,
          label: item.name,
        }),
      ),
    });
    if (!ai) return { success: true, data: null };
    const confidence =
      ai.confidence === "high" ? 0.9 : ai.confidence === "medium" ? 0.65 : 0.35;
    return {
      success: true,
      data: {
        source: "ai",
        costCodeId: ai.costCodeId,
        budgetLineId: ai.budgetLineId,
        expenseAccountId: ai.expenseAccountId,
        apAccountId: ai.apAccountId,
        confidence,
      },
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function getPayablesAccountingContextAction(projectId?: string, options: { includeVendors?: boolean } = {}) {
  const { orgId, supabase, userId } = await requireOrgContext();
  await requireAuthorization({ permission: "bill.read", userId, orgId, projectId, supabase, resourceType: projectId ? "project" : "vendor_bill", resourceId: projectId ?? "payables-accounting" });
  // Separate from `enabled` on purpose. `enabled` means "a connection is
  // routed here, so coding pickers and pushes make sense". This means "this
  // org has an accounting integration at all" — which is the right gate for
  // the sync queue, because an org whose routing is missing or whose
  // connection expired is precisely the org with a silent backlog to find.
  const { count: connectionCount } = await supabase
    .from("accounting_connections")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  const hasAnyConnection = (connectionCount ?? 0) > 0;

  const ledgerAuthority = await resolveLedgerAuthority(orgId);
  if (ledgerAuthority === "arc") {
    const { data: accounts, error: accountsError } = await supabase
      .from("gl_accounts")
      .select("id,code,name,account_type,subtype")
      .eq("org_id", orgId)
      .eq("active", true)
      .in("account_type", ["cogs", "expense", "liability"])
      .order("code")
      .limit(500);
    if (accountsError)
      throw new Error(
        `Unable to load Arc Books accounts: ${accountsError.message}`,
      );
    const expenseAccounts = (accounts ?? [])
      .filter(
        (account) =>
          account.account_type === "cogs" || account.account_type === "expense",
      )
      .map((account) => ({
        id: account.id,
        name: `${account.code} · ${account.name}`,
      }));
    const apAccounts = (accounts ?? [])
      .filter(
        (account) =>
          account.subtype === "accounts_payable" ||
          account.subtype === "retainage_payable",
      )
      .map((account) => ({
        id: account.id,
        name: `${account.code} · ${account.name}`,
      }));
    return {
      enabled: true,
      hasAnyConnection: false,
      provider: "arc_books",
      providerName: "Arc Books",
      connectionLabel: "Arc Books",
      healthy: true,
      expenseAccounts,
      apAccounts,
      vendors: [],
      dimensions: [],
      defaults: {
        expenseAccountId: (accounts ?? []).find(
          (account) => account.subtype === "job_costs",
        )?.id,
        apAccountId: (accounts ?? []).find(
          (account) => account.subtype === "accounts_payable",
        )?.id,
      },
    };
  }
  const target = await resolveAccountingTarget({ orgId, projectId });
  if (!target) {
    return {
      enabled: false,
      hasAnyConnection,
      provider: null,
      providerName: null,
      connectionLabel: null,
      healthy: false,
      expenseAccounts: [],
      apAccounts: [],
      vendors: [],
      defaults: {},
      dimensions: [],
    };
  }

  const provider = getProvider(target.connection.provider);
  const [expenseAccounts, apAccounts, vendors, dimensionValues] =
    await Promise.all([
      provider
        .listAccounts({ connectionId: target.connection.id, kind: "expense" }),
      provider
        .listAccounts({ connectionId: target.connection.id, kind: "ap" }),
      options.includeVendors ? provider
        .searchCounterparties?.({
          connectionId: target.connection.id,
          role: "vendor",
          term: "",
        })
        .catch(() => []) ?? Promise.resolve([]) : Promise.resolve([]),
      Promise.all(
        provider.capabilities.dimensions
          .filter((kind) => kind !== "customer")
          .map(async (kind) => ({
            key: kind,
            label: DIMENSION_LABELS[kind],
            values: await provider
              .listDimensionValues({ connectionId: target.connection.id, kind })
              .catch(() => []),
          })),
      ),
    ]);

  const settings =
    (target.connection.settings as Record<string, any> | null) ?? {};
  return {
    enabled: true,
    hasAnyConnection,
    provider: target.connection.provider,
    providerName: target.connection.label,
    connectionLabel:
      target.connection.externalAccountName ?? target.connection.label,
    healthy: target.healthy,
    expenseAccounts,
    apAccounts,
    vendors,
    dimensions: dimensionValues,
    defaults: {
      expenseAccountId: settings.default_expense_account_id as
        | string
        | undefined,
      apAccountId: settings.default_ap_account_id as string | undefined,
    },
  };
}

export async function getPayablesAccountingSyncStatesAction(billIds: string[]) {
  const ids = z.array(z.string().uuid()).max(500).parse(Array.from(new Set(billIds)));
  const { orgId, supabase, userId } = await requireOrgContext();
  await requirePermission("bill.read", { orgId, supabase, userId });
  const { data, error } = ids.length ? await supabase.from("payments").select("id,bill_id,created_at").eq("org_id", orgId).in("bill_id", ids).order("created_at", { ascending: false }) : { data: [], error: null }
  if (error) throw new Error(`Unable to load bill payments: ${error.message}`)
  const paymentByBillId = new Map<string, string>()
  for (const payment of data ?? []) if (payment.bill_id && !paymentByBillId.has(payment.bill_id)) paymentByBillId.set(payment.bill_id, payment.id)
  const [billStates, creditStates, paymentStates] = await Promise.all([
    getAccountingSyncStates(supabase, { orgId, entityType: "bill", entityIds: ids }),
    getAccountingSyncStates(supabase, { orgId, entityType: "vendor_credit", entityIds: ids }),
    getAccountingSyncStates(supabase, { orgId, entityType: "bill_payment", entityIds: [...paymentByBillId.values()] }),
  ])
  return {
    bills: Object.fromEntries([...billStates, ...creditStates]),
    billPayments: Object.fromEntries(paymentStates),
    latestPaymentIdByBillId: Object.fromEntries(paymentByBillId),
  }
}

export async function syncProjectVendorBillToAccountingAction(
  projectId: string,
  billId: string,
) {
  return run(async () => {
    const { orgId } = await requireOrgContext();
    const result = await requestAccountingPush({
      projectId,
      entityType: "vendor_bill",
      entityId: billId,
    });
    revalidatePayablesPages(projectId);
    return result;
  });
}

export async function syncProjectVendorBillsToAccountingAction(
  projectId: string,
  billIds: string[],
): Promise<ActionResult<Array<{ billId: string; success: boolean; error?: string }>>> {
  return run(async () => {
    const parsed = z.object({ projectId: z.string().uuid(), billIds: z.array(z.string().uuid()).min(1).max(100) }).parse({ projectId, billIds: [...new Set(billIds)] })
    const { orgId } = await requireOrgContext()
    const results = []
    for (const billId of parsed.billIds) {
      try {
        await requestAccountingPush({ projectId, entityType: "vendor_bill", entityId: billId })
        results.push({ billId, success: true })
      } catch (error) {
        results.push({ billId, success: false, error: error instanceof Error ? error.message : "Accounting sync failed" })
      }
    }
    revalidatePayablesPages(parsed.projectId)
    return results
  })
}

export async function deleteProjectVendorBillAction(
  projectId: string | null,
  billId: string,
): Promise<ActionResult<PayableActionResult>> {
  return run(async () => {
    try {
      await deleteVendorBill({ billId });
      revalidatePayablesPages(projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

export type ReassignPayableResult =
  | { success: true; projectId: string }
  | { success: false; error: string };

export async function reassignProjectPayableAction(
  projectId: string,
  billId: string,
  targetProjectId: string,
): Promise<ActionResult<ReassignPayableResult>> {
  return run(async () => {
    try {
      const result = await reassignImportedPayable({ billId, targetProjectId });
      revalidatePayablesPages(projectId);
      revalidatePayablesPages(targetProjectId);
      return { success: true, projectId: result.projectId };
    } catch (error) {
      return { success: false, error: toPayableActionError(error) };
    }
  });
}

/**
 * Check scanned invoice lines against a commitment before the payable is saved.
 *
 * Read-only and advisory: the invoice is on screen and nothing has been coded
 * yet, which is the cheapest possible moment to notice that a line bills work
 * the commitment does not cover.
 */
export async function previewPayableLineMatchAction(input: {
  commitmentId: string;
  billTotalCents: number;
  invoiceLines: InvoiceLineForMatch[];
}): Promise<ActionResult<PayableLineMatchAssessment | null>> {
  return run(() =>
    previewCommitmentLineMatch({
      commitmentId: input.commitmentId,
      billTotalCents: input.billTotalCents,
      invoiceLines: input.invoiceLines,
    }),
  );
}
