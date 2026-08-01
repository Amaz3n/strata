import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { booksDigest } from "@/lib/services/books/hash";
import { buildTrialBalance } from "@/lib/services/books/statements";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

export type ExternalTrialBalanceRow = {
  externalAccountId: string;
  externalAccountCode?: string | null;
  externalAccountName: string;
  arcAccountCode: string;
  debitCents: number;
  creditCents: number;
};

export type BooksVarianceCategory =
  | "timing"
  | "mapping"
  | "missing_source"
  | "policy"
  | "duplicate"
  | "rounding"
  | "defect"
  | "unexplained";

export function compareTrialBalances(input: {
  arcRows: Array<{ code: string; debitCents: number; creditCents: number }>;
  externalRows: ExternalTrialBalanceRow[];
  roundingToleranceCents?: number;
}) {
  const tolerance = input.roundingToleranceCents ?? 1;
  const arcByCode = new Map(input.arcRows.map((row) => [row.code, row]));
  const externalByCode = new Map<
    string,
    {
      debitCents: number;
      creditCents: number;
      sourceRows: ExternalTrialBalanceRow[];
    }
  >();
  for (const row of input.externalRows) {
    if (![row.debitCents, row.creditCents].every(Number.isSafeInteger)) {
      throw new Error("External trial-balance rows must use integer cents");
    }
    const current = externalByCode.get(row.arcAccountCode) ?? {
      debitCents: 0,
      creditCents: 0,
      sourceRows: [],
    };
    current.debitCents += row.debitCents;
    current.creditCents += row.creditCents;
    current.sourceRows.push(row);
    externalByCode.set(row.arcAccountCode, current);
  }
  const codes = Array.from(
    new Set([...arcByCode.keys(), ...externalByCode.keys()]),
  ).sort();
  const items = codes.flatMap((accountCode) => {
    const arc = arcByCode.get(accountCode) ?? { debitCents: 0, creditCents: 0 };
    const external = externalByCode.get(accountCode) ?? {
      debitCents: 0,
      creditCents: 0,
      sourceRows: [],
    };
    const arcBalanceCents = arc.debitCents - arc.creditCents;
    const externalBalanceCents = external.debitCents - external.creditCents;
    const varianceCents = arcBalanceCents - externalBalanceCents;
    if (Math.abs(varianceCents) <= tolerance) return [];
    const category: BooksVarianceCategory =
      !arcByCode.has(accountCode) || !externalByCode.has(accountCode)
        ? "mapping"
        : "unexplained";
    return [
      {
        accountCode,
        arcBalanceCents,
        externalBalanceCents,
        varianceCents,
        category,
        externalRows: external.sourceRows,
      },
    ];
  });
  return {
    items,
    varianceCount: items.length,
    unexplainedVarianceCount: items.filter(
      (item) => item.category === "unexplained",
    ).length,
    digest: booksDigest({
      arcRows: input.arcRows,
      externalRows: input.externalRows,
      tolerance,
    }),
  };
}

async function requireComparisonContext(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_comparison",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function createBooksComparisonRun(input: {
  connectionId: string;
  periodId: string;
  asOf: string;
  externalRows: ExternalTrialBalanceRow[];
  orgId?: string;
}) {
  const context = await requireComparisonContext(input.orgId);
  const service = createServiceSupabaseClient();
  const [trialBalance, periodResult, settingsResult, accountResult] =
    await Promise.all([
      buildTrialBalance(context.orgId, input.asOf),
      service
        .from("accounting_periods")
        .select("id")
        .eq("org_id", context.orgId)
        .eq("id", input.periodId)
        .single(),
      service
        .from("books_settings")
        .select("active_policy_version")
        .eq("org_id", context.orgId)
        .single(),
      service
        .from("gl_accounts")
        .select("id, code")
        .eq("org_id", context.orgId),
    ]);
  if (periodResult.error) throw new Error("Accounting period not found");
  if (settingsResult.error) throw new Error("Arc Books is not initialized");
  if (accountResult.error)
    throw new Error(
      `Failed to load Books chart: ${accountResult.error.message}`,
    );
  const accountByCode = new Map(
    (accountResult.data ?? []).map((account) => [account.code, account.id]),
  );
  const comparison = compareTrialBalances({
    arcRows: trialBalance.rows,
    externalRows: input.externalRows,
  });
  const { data, error } = await service
    .from("books_comparison_runs")
    .insert({
      org_id: context.orgId,
      connection_id: input.connectionId,
      period_id: input.periodId,
      status: comparison.varianceCount === 0 ? "passed" : "warning",
      policy_version: settingsResult.data.active_policy_version,
      variance_count: comparison.varianceCount,
      unexplained_variance_count: comparison.unexplainedVarianceCount,
      digest: comparison.digest,
      completed_at: new Date().toISOString(),
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to create Books comparison: ${error.message}`);
  const runId = z.object({ id: z.string().uuid() }).parse(data).id;
  if (comparison.items.length > 0) {
    const insert = await service.from("books_comparison_items").insert(
      comparison.items.map((item) => ({
        org_id: context.orgId,
        run_id: runId,
        category: "trial_balance",
        account_id: accountByCode.get(item.accountCode) ?? null,
        external_account_id:
          item.externalRows.map((row) => row.externalAccountId).join(",") ||
          null,
        arc_amount_cents: item.arcBalanceCents,
        external_amount_cents: item.externalBalanceCents,
        difference_cents: item.varianceCents,
        variance_reason: item.category === "unexplained" ? null : item.category,
        explanation:
          item.externalRows.length === 0
            ? `No external mapping for Arc account ${item.accountCode}`
            : null,
        status: "unexplained",
      })),
    );
    if (insert.error)
      throw new Error(
        `Failed to persist Books variances: ${insert.error.message}`,
      );
  }
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.comparison_completed",
    entityType: "books_comparison_run",
    entityId: runId,
    payload: {
      variance_count: comparison.varianceCount,
      unexplained_variance_count: comparison.unexplainedVarianceCount,
    },
  });
  return { runId, ...comparison };
}

export async function approveBooksComparisonRun(input: {
  runId: string;
  note: string;
  orgId?: string;
}) {
  const context = await requireComparisonContext(input.orgId);
  if (input.note.trim().length < 10)
    throw new Error("A substantive comparison approval note is required");
  const service = createServiceSupabaseClient();
  const { count, error: openError } = await service
    .from("books_comparison_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("run_id", input.runId)
    .eq("status", "unexplained");
  if (openError)
    throw new Error(
      `Failed to verify comparison variances: ${openError.message}`,
    );
  if ((count ?? 0) > 0)
    throw new Error("Resolve or document every variance before approval");
  const { error } = await service
    .from("books_comparison_runs")
    .update({
      status: "approved",
      approval_note: input.note.trim(),
      approved_by: context.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", input.runId)
    .in("status", ["passed", "warning"]);
  if (error)
    throw new Error(`Failed to approve Books comparison: ${error.message}`);
}

export async function explainBooksComparisonItem(input: {
  itemId: string;
  reason: Exclude<BooksVarianceCategory, "unexplained">;
  explanation: string;
  resolved?: boolean;
  orgId?: string;
}) {
  const context = await requireComparisonContext(input.orgId);
  if (input.explanation.trim().length < 10)
    throw new Error("A substantive variance explanation is required");
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_comparison_items")
    .update({
      variance_reason: input.reason,
      explanation: input.explanation.trim(),
      status: input.resolved ? "resolved" : "explained",
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", input.itemId)
    .select("id, run_id")
    .single();
  if (error)
    throw new Error(`Failed to explain Books variance: ${error.message}`);
  const { count, error: countError } = await service
    .from("books_comparison_items")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("run_id", data.run_id)
    .eq("status", "unexplained");
  if (countError)
    throw new Error(`Failed to recount Books variances: ${countError.message}`);
  const runUpdate = await service
    .from("books_comparison_runs")
    .update({ unexplained_variance_count: count ?? 0 })
    .eq("org_id", context.orgId)
    .eq("id", data.run_id);
  if (runUpdate.error)
    throw new Error(
      `Failed to update Books comparison: ${runUpdate.error.message}`,
    );
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.comparison_variance_explained",
    entityType: "books_comparison_item",
    entityId: input.itemId,
    payload: {
      run_id: data.run_id,
      reason: input.reason,
      resolved: Boolean(input.resolved),
    },
  });
}
