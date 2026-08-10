"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionError, type ActionResult } from "@/lib/action-result";
import {
  createAccountantPackage,
  buildSalesUseTaxSummary,
} from "@/lib/services/books/accountant-package";
import {
  createPlaidLinkToken,
  connectPlaidItem,
} from "@/lib/services/books/bank-feeds";
import {
  createAdjustingJournal,
  createRecurringPostingTemplate,
  JOURNAL_ENTRY_KINDS,
  listJournalEntries,
  listRecurringPostingTemplates,
  setRecurringTemplateStatus,
} from "@/lib/services/books/bookkeeping";
import {
  closeBankReconciliation,
  confirmBankMatch,
  createBankReconciliation,
  reviewUnmatchedBankTransactions,
} from "@/lib/services/books/bank-reconciliation";
import {
  categorizeBankTransaction,
  listBankRules,
  setBankRuleActive,
} from "@/lib/services/books/bank-rules";
import {
  approveBooksComparisonRun,
  createBooksComparisonRun,
  explainBooksComparisonItem,
} from "@/lib/services/books/comparison";
import {
  cancelBooksCutover,
  completeBooksCutover,
  prepareBooksCutover,
  approveBooksCutover,
  rollbackBooksCutover,
} from "@/lib/services/books/cutover";
import { createCompleteBooksExport } from "@/lib/services/books/exports";
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module";
import {
  getAccountActivity,
  getStatementsForPeriod,
} from "@/lib/services/books/statement-detail";
import {
  createOpeningBalanceBatch,
  approveOpeningBalanceBatch,
  postOpeningBalanceBatch,
} from "@/lib/services/books/opening-balances";
import {
  closeAccountingPeriod,
  closeFiscalYearToRetainedEarnings,
  createAccountingPeriod,
  reopenAccountingPeriod,
  runBooksCloseChecklist,
} from "@/lib/services/books/period-close";
import { requestLedgerRebuildDrill } from "@/lib/services/books/rebuild";
import {
  resolveReconciliationItem,
  runReconciliationNow,
} from "@/lib/services/books/reconciliation";
import { requireAuthorization } from "@/lib/services/authorization";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { createFilesDownloadUrl } from "@/lib/storage/files-storage";
import { createPocJournalExport } from "@/lib/services/accounting-export";
import { createGlAccount, setGlAccountActive } from "@/lib/services/books/chart-management";

async function run<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireBooksWorkspaceEnabled();
    const result = await operation();
    revalidatePath("/books");
    return { success: true, data: result };
  } catch (error) {
    return actionError(error);
  }
}

/**
 * Read-only counterpart to `run`. Skips `revalidatePath` on purpose: changing the
 * statement period or opening a drill-down mutates nothing, and revalidating
 * would re-fetch the entire Books workspace on every interaction.
 */
async function read<T>(operation: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    await requireBooksWorkspaceEnabled();
    return { success: true, data: await operation() };
  } catch (error) {
    return actionError(error);
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date");

export async function loadStatementsAction(input: {
  startDate: string;
  endDate: string;
  comparePriorYear?: boolean;
}) {
  return read(() =>
    getStatementsForPeriod(
      z
        .object({
          startDate: isoDate,
          endDate: isoDate,
          comparePriorYear: z.boolean().optional(),
        })
        .parse(input),
    ),
  );
}

export async function loadBankReviewTrayAction(input: { bankAccountId?: string | null } = {}) {
  return read(() =>
    reviewUnmatchedBankTransactions(
      z.object({ bankAccountId: z.string().uuid().nullable().optional() }).parse(input),
    ),
  );
}

export async function confirmBankMatchAction(input: {
  bankTransactionId: string;
  journalLineId: string;
  amountCents: number;
  confidence: number;
}) {
  return run(() =>
    confirmBankMatch(
      z
        .object({
          bankTransactionId: z.string().uuid(),
          journalLineId: z.string().uuid(),
          amountCents: z.number().int().positive(),
          confidence: z.number().min(0).max(1),
        })
        .transform((parsed) => ({
          ...parsed,
          matchType: parsed.confidence >= 0.95 ? ("exact" as const) : ("suggested" as const),
        }))
        .parse(input),
    ),
  );
}

export async function categorizeBankTransactionAction(input: {
  bankTransactionId: string;
  glAccountId: string;
  projectId?: string | null;
  memo?: string | null;
  appliedRuleId?: string | null;
  learn?: boolean;
}) {
  return run(() =>
    categorizeBankTransaction(
      z
        .object({
          bankTransactionId: z.string().uuid(),
          glAccountId: z.string().uuid(),
          projectId: z.string().uuid().nullable().optional(),
          memo: z.string().max(200).nullable().optional(),
          appliedRuleId: z.string().uuid().nullable().optional(),
          learn: z.boolean().optional(),
        })
        .parse(input),
    ),
  );
}

export async function listBankRulesAction() {
  return read(() => listBankRules());
}

export async function setBankRuleActiveAction(input: { ruleId: string; active: boolean }) {
  return run(() =>
    setBankRuleActive(
      z.object({ ruleId: z.string().uuid(), active: z.boolean() }).parse(input),
    ),
  );
}

export async function listJournalEntriesAction(input: {
  entryKinds?: string[];
  startDate?: string;
  endDate?: string;
}) {
  return read(() =>
    listJournalEntries(
      z
        .object({
          entryKinds: z.array(z.enum(JOURNAL_ENTRY_KINDS)).optional(),
          startDate: isoDate.optional(),
          endDate: isoDate.optional(),
        })
        .parse(input),
    ),
  );
}

export async function listRecurringTemplatesAction() {
  return read(() => listRecurringPostingTemplates());
}

export async function createRecurringTemplateAction(input: {
  name: string;
  memo: string;
  frequency: "weekly" | "monthly" | "quarterly" | "annually";
  nextRunOn: string;
  endOn?: string | null;
  autoPost?: boolean;
  lines: Array<z.infer<typeof journalLineSchema>>;
}) {
  return run(() =>
    createRecurringPostingTemplate(
      z
        .object({
          name: z.string().min(2),
          memo: z.string().min(4, "An explanatory memo is required"),
          frequency: z.enum(["weekly", "monthly", "quarterly", "annually"]),
          nextRunOn: isoDate,
          endOn: isoDate.nullable().optional(),
          autoPost: z.boolean().optional(),
          lines: z.array(journalLineSchema).min(2, "A template needs at least two lines"),
        })
        .parse(input),
    ),
  );
}

export async function setRecurringTemplateStatusAction(input: {
  templateId: string;
  status: "active" | "paused" | "completed";
}) {
  return run(() =>
    setRecurringTemplateStatus(
      z
        .object({
          templateId: z.string().uuid(),
          status: z.enum(["active", "paused", "completed"]),
        })
        .parse(input),
    ),
  );
}

export async function loadAccountActivityAction(input: {
  accountId: string;
  startDate: string;
  endDate: string;
  projectId?: string | null;
}) {
  return read(() =>
    getAccountActivity(
      z
        .object({
          accountId: z.string().uuid(),
          startDate: isoDate,
          endDate: isoDate,
          projectId: z.string().uuid().nullable().optional(),
        })
        .parse(input),
    ),
  );
}

export async function createAccountingPeriodAction(formData: FormData) {
  return run(async () => {
    const input = z
      .object({
        periodStart: z.string(),
        periodEnd: z.string(),
        fiscalYear: z.coerce.number().int(),
        fiscalPeriod: z.coerce.number().int().min(1).max(13),
      })
      .parse(Object.fromEntries(formData));
    return { id: await createAccountingPeriod(input) };
  });
}

export async function runCloseChecklistAction(periodId: string) {
  return run(() => runBooksCloseChecklist(z.string().uuid().parse(periodId)));
}
export async function closeAccountingPeriodAction(periodId: string) {
  return run(() => closeAccountingPeriod(z.string().uuid().parse(periodId)));
}
export async function closeFiscalYearAction(periodId: string) {
  return run(() =>
    closeFiscalYearToRetainedEarnings(z.string().uuid().parse(periodId)),
  );
}
export async function reopenAccountingPeriodAction(
  periodId: string,
  reason: string,
) {
  return run(() =>
    reopenAccountingPeriod({
      periodId: z.string().uuid().parse(periodId),
      reason: z.string().min(10).parse(reason),
    }),
  );
}
export async function createBooksExportAction(
  exportType: "complete" | "accountant" | "cutover" | "period" = "complete",
) {
  return run(() => createCompleteBooksExport({ exportType }));
}
export async function runReconciliationNowAction() {
  return run(() => runReconciliationNow());
}
/**
 * Dispose of one reconciliation finding. `resolved` says it is fixed — the sweep
 * will open it again tonight if it is not. `explained` and `ignored` accept a known
 * difference and need a reason on the record.
 */
export async function resolveReconciliationItemAction(input: {
  itemId: string;
  disposition: "resolved" | "explained" | "ignored";
  explanation?: string;
}) {
  return run(() =>
    resolveReconciliationItem({
      itemId: z.string().uuid().parse(input.itemId),
      disposition: z
        .enum(["resolved", "explained", "ignored"])
        .parse(input.disposition),
      explanation: z.string().max(2000).optional().parse(input.explanation),
    }),
  );
}
export async function runLedgerRebuildAction() {
  return run(() => requestLedgerRebuildDrill());
}
export async function createPocJournalExportAction(asOf: string) {
  return run(() => createPocJournalExport({ asOf: z.string().parse(asOf) }));
}

export async function createPlaidLinkTokenAction() {
  return run(() => createPlaidLinkToken());
}
export async function exchangePlaidPublicTokenAction(input: {
  publicToken: string;
  institutionId?: string | null;
  institutionName?: string | null;
}) {
  return run(() => connectPlaidItem(input));
}

export async function excludeBankTransactionAction(
  transactionId: string,
  amountCents: number,
) {
  return run(() =>
    confirmBankMatch({
      bankTransactionId: z.string().uuid().parse(transactionId),
      amountCents: z.number().int().positive().parse(amountCents),
      matchType: "excluded",
      confidence: 1,
    }),
  );
}

export async function createBankReconciliationAction(formData: FormData) {
  return run(() =>
    createBankReconciliation(
      z
        .object({
          bankAccountId: z.string().uuid(),
          statementStart: z.string(),
          statementEnd: z.string(),
          beginningBalanceCents: z.coerce.number().int(),
          endingBalanceCents: z.coerce.number().int(),
        })
        .parse(Object.fromEntries(formData)),
    ),
  );
}
export async function closeBankReconciliationAction(id: string) {
  return run(() => closeBankReconciliation(z.string().uuid().parse(id)));
}

export async function createBooksComparisonAction(formData: FormData) {
  return run(() =>
    createBooksComparisonRun({
      connectionId: z.string().uuid().parse(formData.get("connectionId")),
      periodId: z.string().uuid().parse(formData.get("periodId")),
      asOf: z.string().parse(formData.get("asOf")),
      externalRows: z
        .array(
          z.object({
            externalAccountId: z.string(),
            externalAccountCode: z.string().optional().nullable(),
            externalAccountName: z.string(),
            arcAccountCode: z.string(),
            debitCents: z.number().int().nonnegative(),
            creditCents: z.number().int().nonnegative(),
          }),
        )
        .parse(JSON.parse(z.string().parse(formData.get("externalRows")))),
    }),
  );
}
export async function explainBooksVarianceAction(
  itemId: string,
  explanation: string,
) {
  return run(async () => {
    await explainBooksComparisonItem({
      itemId: z.string().uuid().parse(itemId),
      reason: "timing",
      explanation: z.string().min(10).parse(explanation),
    });
    return { explained: true };
  });
}
export async function approveBooksComparisonAction(
  runId: string,
  note: string,
) {
  return run(async () => {
    await approveBooksComparisonRun({
      runId: z.string().uuid().parse(runId),
      note: z.string().min(10).parse(note),
    });
    return { approved: true };
  });
}

const journalLineSchema = z.object({
  accountCode: z.string().min(1),
  debitCents: z.number().int().nonnegative(),
  creditCents: z.number().int().nonnegative(),
  description: z.string().optional(),
  projectId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
});

export async function postAdjustingJournalAction(input: {
  entryDate: string;
  memo: string;
  reversingOn?: string | null;
  lines: Array<z.infer<typeof journalLineSchema>>;
}) {
  return run(async () => {
    const parsed = z
      .object({
        entryDate: isoDate,
        memo: z.string().min(4, "An explanatory memo is required"),
        reversingOn: isoDate.nullable().optional(),
        lines: z.array(journalLineSchema).min(2, "A journal entry needs at least two lines"),
      })
      .parse(input);
    return createAdjustingJournal({
      entryDate: parsed.entryDate,
      memo: parsed.memo,
      lines: parsed.lines,
      reversingOn: parsed.reversingOn ?? undefined,
    });
  });
}

export async function createGlAccountAction(formData: FormData) {
  return run(() => createGlAccount({
    code: z.string().parse(formData.get("code")),
    name: z.string().parse(formData.get("name")),
    accountType: z.string().parse(formData.get("accountType")),
    subtype: z.string().parse(formData.get("subtype")),
    normalBalance: z.string().parse(formData.get("normalBalance")),
    cashFlowCategory: z.string().optional().parse(formData.get("cashFlowCategory") || undefined),
  }));
}

export async function setGlAccountActiveAction(accountId: string, active: boolean) {
  return run(() => setGlAccountActive(z.string().uuid().parse(accountId), z.boolean().parse(active)));
}

const openingLineSchema = z.object({
  accountCode: z.string().min(1),
  subledgerType: z
    .enum(["ar", "ap", "bank", "credit_card", "loan", "fixed_asset", "deposit", "equity", "other"])
    .optional(),
  sourceEntityType: z.string().optional(),
  sourceEntityId: z.string().optional(),
  projectId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  description: z.string(),
  debitCents: z.number().int().nonnegative(),
  creditCents: z.number().int().nonnegative(),
  details: z.record(z.unknown()).optional(),
});

export async function importOpeningBalancesAction(input: {
  cutoverDate: string;
  sourceFilename?: string | null;
  /** What the person actually pasted, kept verbatim as the batch's provenance. */
  sourceContent: string;
  lines: Array<z.infer<typeof openingLineSchema>>;
}) {
  return run(() => {
    const parsed = z
      .object({
        cutoverDate: isoDate,
        sourceFilename: z.string().max(200).nullable().optional(),
        sourceContent: z.string().min(2),
        lines: z.array(openingLineSchema).min(2, "An opening batch needs at least two lines"),
      })
      .parse(input);
    return createOpeningBalanceBatch({
      cutoverDate: parsed.cutoverDate,
      sourceFilename: parsed.sourceFilename ?? undefined,
      sourceContent: parsed.sourceContent,
      lines: parsed.lines,
    });
  });
}

export async function approveOpeningBalancesAction(
  batchId: string,
  role: "owner" | "accountant",
) {
  return run(() =>
    approveOpeningBalanceBatch({
      batchId: z.string().uuid().parse(batchId),
      approvalRole: role,
    }),
  );
}
export async function postOpeningBalancesAction(batchId: string) {
  return run(async () => ({
    journalEntryId: await postOpeningBalanceBatch(
      z.string().uuid().parse(batchId),
    ),
  }));
}

export async function prepareCutoverAction(formData: FormData) {
  return run(() =>
    prepareBooksCutover({
      connectionId: z.string().uuid().parse(formData.get("connectionId")),
      cutoverDate: z.string().parse(formData.get("cutoverDate")),
      targetPosture: z
        .enum(["outbound_mirror", "disconnected"])
        .parse(formData.get("targetPosture")),
    }),
  );
}
export async function approveCutoverAction(
  runId: string,
  role: "owner" | "accountant",
) {
  return run(async () => {
    await approveBooksCutover({
      cutoverRunId: z.string().uuid().parse(runId),
      approvalRole: role,
    });
    return { approved: true };
  });
}
export async function completeCutoverAction(runId: string) {
  return run(async () => {
    await completeBooksCutover(z.string().uuid().parse(runId));
    return { completed: true };
  });
}
export async function cancelCutoverAction(runId: string) {
  return run(async () => {
    await cancelBooksCutover(z.string().uuid().parse(runId));
    return { cancelled: true };
  });
}
export async function rollbackCutoverAction(runId: string, reason: string) {
  return run(async () => {
    await rollbackBooksCutover({
      cutoverRunId: z.string().uuid().parse(runId),
      reason,
    });
    return { rolledBack: true };
  });
}

export async function createAccountantPackageAction(input: {
  periodId?: string;
  taxYear?: number;
}) {
  return run(() => createAccountantPackage(input));
}
export async function buildSalesTaxSummaryAction(
  startDate: string,
  endDate: string,
) {
  return run(() => buildSalesUseTaxSummary({ startDate, endDate }));
}

export async function getBooksExportDownloadAction(exportId: string) {
  return run(async () => {
    const context = await requireOrgContext();
    await requireAuthorization({
      permission: "books.export",
      userId: context.userId,
      orgId: context.orgId,
      supabase: context.supabase,
      resourceType: "books_export",
      resourceId: exportId,
      logDecision: true,
    });
    const service = createServiceSupabaseClient();
    const { data, error } = await service
      .from("books_exports")
      .select("storage_path, status, export_type")
      .eq("org_id", context.orgId)
      .eq("id", z.string().uuid().parse(exportId))
      .single();
    if (error || data.status !== "ready" || !data.storage_path)
      throw new Error("Books export is not ready");
    const download = await createFilesDownloadUrl({
      supabase: service,
      orgId: context.orgId,
      path: data.storage_path,
      fileName: `arc-books-${data.export_type}-${exportId}.json.gz`,
      expiresIn: 300,
    });
    const marked = await service
      .from("books_exports")
      .update({
        downloaded_by: context.userId,
        downloaded_at: new Date().toISOString(),
      })
      .eq("org_id", context.orgId)
      .eq("id", exportId);
    if (marked.error)
      throw new Error(
        `Failed to record export download: ${marked.error.message}`,
      );
    return { url: download.downloadUrl };
  });
}
