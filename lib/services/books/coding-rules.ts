import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import type { AccountingCoding } from "@/lib/services/accounting-coding";
import {
  encodeLineSplits,
  isCodingCorrection,
  nextCodingRuleCounts,
  selectCodingSuggestion,
  type CodingLineSplit,
  type CodingSuggestion,
} from "@/lib/services/accounting-rules";
import { recordAudit } from "@/lib/services/audit";
import { requireAuthorization } from "@/lib/services/authorization";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

const codingRuleSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid().nullable(),
  match_kind: z.enum(["vendor", "vendor_memo"]),
  match_value: z.string(),
  memo_pattern: z.string().nullable(),
  cost_code_id: z.string().uuid().nullable(),
  budget_line_id: z.string().uuid().nullable(),
  accounting_coding: z.record(z.unknown()),
  confidence: z.coerce.number(),
  hit_count: z.number().int(),
  correction_count: z.number().int(),
  last_corrected_at: z.string().nullable(),
});

export type { CodingLineSplit, CodingSuggestion } from "@/lib/services/accounting-rules";

function normalize(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

async function requireCodingContext(orgId?: string, projectId?: string | null) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "bill.write",
    userId: context.userId,
    orgId: context.orgId,
    projectId: projectId ?? undefined,
    supabase: context.supabase,
    resourceType: "coding_rule",
    resourceId: context.orgId,
  });
  return context;
}

export async function suggestCoding(input: {
  companyId?: string | null;
  vendorName?: string | null;
  memo?: string | null;
  projectId?: string | null;
  orgId?: string;
}) {
  const context = await requireCodingContext(input.orgId, input.projectId);
  return suggestCodingForService({ ...input, orgId: context.orgId });
}

/** Internal ingestion path for already-authorized cron/webhook/provider imports. */
export async function suggestCodingForService(input: {
  orgId: string;
  companyId?: string | null;
  vendorName?: string | null;
  memo?: string | null;
}) {
  const service = createServiceSupabaseClient();
  let query = service
    .from("coding_rules")
    .select(
      "id, company_id, match_kind, match_value, memo_pattern, cost_code_id, budget_line_id, accounting_coding, confidence, hit_count, correction_count, last_corrected_at",
    )
    .eq("org_id", input.orgId)
    .eq("active", true)
    .limit(100);
  if (input.companyId) {
    query = query.eq("company_id", input.companyId);
  } else {
    query = query
      .is("company_id", null)
      .eq("match_value", normalize(input.vendorName));
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load coding rules: ${error.message}`);
  return selectCodingSuggestion({
    rules: z.array(codingRuleSchema).parse(data ?? []),
    companyId: input.companyId,
    vendorName: input.vendorName,
    memo: input.memo,
  });
}

export async function learnCodingRule(input: {
  companyId?: string | null;
  vendorName?: string | null;
  memoPattern?: string | null;
  costCodeId?: string | null;
  budgetLineId?: string | null;
  accountingCoding?: AccountingCoding;
  /**
   * Learned split pattern for vendors whose bills split across codes. Weights
   * are basis points and must sum to 10000. Stored inside the rule's
   * `accounting_coding` JSON (the table has no metadata column); a later
   * single-code learn overwrites the row and clears it naturally.
   */
  lineSplits?: CodingLineSplit[] | null;
  /**
   * The rule that coded this record, when one did. Whether the person actually
   * disagreed with it is derived by comparing coding values — passing
   * `corrected` by hand is what let "the user saved the bill" read as "the user
   * contradicted the rule".
   */
  appliedRuleId?: string | null;
  projectId?: string | null;
  orgId?: string;
}) {
  const context = await requireCodingContext(input.orgId, input.projectId);
  const companyId = input.companyId ?? null;
  const matchValue = companyId ?? normalize(input.vendorName);
  if (!matchValue) return null;
  const memoPattern = normalize(input.memoPattern) || null;
  const matchKind = memoPattern ? "vendor_memo" : "vendor";
  const service = createServiceSupabaseClient();

  let existingQuery = service
    .from("coding_rules")
    .select("id, hit_count, correction_count, cost_code_id, budget_line_id, last_hit_at, last_corrected_at, created_from")
    .eq("org_id", context.orgId)
    .eq("match_kind", matchKind)
    .eq("match_value", matchValue);
  existingQuery = memoPattern
    ? existingQuery.eq("memo_pattern", memoPattern)
    : existingQuery.is("memo_pattern", null);
  existingQuery = companyId
    ? existingQuery.eq("company_id", companyId)
    : existingQuery.is("company_id", null);
  const { data: existing, error: loadError } =
    await existingQuery.maybeSingle();
  if (loadError)
    throw new Error(`Failed to load coding rule: ${loadError.message}`);

  const costCodeId = input.costCodeId ?? null;
  const budgetLineId = input.budgetLineId ?? null;

  // A record coded by *this* rule is the only one whose outcome can confirm or
  // contradict it. A record coded by a different rule (or by hand) is a fresh
  // lesson, not a verdict on this row.
  const applied =
    input.appliedRuleId && existing?.id === input.appliedRuleId
      ? { costCodeId: existing.cost_code_id ?? null, budgetLineId: existing.budget_line_id ?? null }
      : null;
  const corrected = isCodingCorrection({ applied, final: { costCodeId, budgetLineId } });

  const counts = nextCodingRuleCounts({
    hitCount: Number(existing?.hit_count ?? 0),
    correctionCount: Number(existing?.correction_count ?? 0),
    corrected,
  });
  const now = new Date().toISOString();
  const row = {
    org_id: context.orgId,
    match_kind: matchKind,
    company_id: companyId,
    match_value: matchValue,
    memo_pattern: memoPattern,
    cost_code_id: costCodeId,
    budget_line_id: budgetLineId,
    accounting_coding: {
      ...(input.accountingCoding ?? {}),
      ...(input.lineSplits && input.lineSplits.length > 1
        ? { line_splits: encodeLineSplits(input.lineSplits) }
        : {}),
    },
    confidence: counts.confidence,
    hit_count: counts.hitCount,
    correction_count: counts.correctionCount,
    // Each timestamp records when that thing last happened. Nulling the other
    // one — as this used to — meant a single hit erased the correction that was
    // supposed to hold the rule in its cooldown, so the window never applied.
    last_hit_at: corrected ? existing?.last_hit_at ?? null : now,
    last_corrected_at: corrected ? now : existing?.last_corrected_at ?? null,
    // Provenance is set once, at birth. Overwriting it on every update made
    // every rule claim it came from a user correction.
    created_from: existing?.created_from ?? "user_correction",
    active: true,
    created_by: context.userId,
    updated_at: now,
  };
  // Upsert on the natural key rather than insert-or-update on the id we just
  // read: two bills for the same vendor landing together used to race between
  // the read and the insert and fail on the unique constraint.
  const result = await service
    .from("coding_rules")
    .upsert(row, { onConflict: "org_id,match_kind,company_id,match_value,memo_pattern" })
    .select("id")
    .single();
  if (result.error)
    throw new Error(`Failed to save coding rule: ${result.error.message}`);
  const ruleId = z.object({ id: z.string().uuid() }).parse(result.data).id;

  const after = {
    cost_code_id: costCodeId,
    budget_line_id: budgetLineId,
    confidence: counts.confidence,
    hit_count: counts.hitCount,
    correction_count: counts.correctionCount,
  };
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: corrected ? "coding.rule_corrected" : "coding.rule_learned",
      entityType: "coding_rule",
      entityId: ruleId,
      payload: { match_kind: matchKind, match_value: matchValue, ...after },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: existing?.id ? "update" : "insert",
      entityType: "coding_rule",
      entityId: ruleId,
      before: existing
        ? {
            cost_code_id: existing.cost_code_id ?? null,
            budget_line_id: existing.budget_line_id ?? null,
            hit_count: existing.hit_count,
            correction_count: existing.correction_count,
          }
        : undefined,
      after,
      source: "coding.learn",
    }),
  ]);
  return ruleId;
}

/** Days of history behind the zero-touch readout. */
export const CODING_AUTOMATION_WINDOW_DAYS = 30;

export type CodingAutomationStats = {
  windowDays: number;
  /** Payables captured in the window — the denominator. */
  transactions: number;
  /** Coding fields a human changed on them. */
  touches: number;
  /** The B1 acceptance number. Null when there is nothing to divide by. */
  touchesPerTransaction: number | null;
  /** Share of payables a learned rule coded outright, 0–1. */
  autoCodedShare: number | null;
};

/**
 * B1's acceptance criterion, finally readable.
 *
 * The engine has been learning and auto-applying since it shipped, but nothing
 * ever read `coding.touched`, so "touches per transaction" was a number no one
 * could see — which is the same as not having the criterion. Counts only, no
 * row scans: every query here is `head: true`.
 */
export async function getCodingAutomationStats(orgId?: string): Promise<CodingAutomationStats> {
  const context = await requireOrgContext(orgId);
  const service = createServiceSupabaseClient();
  const since = new Date(Date.now() - CODING_AUTOMATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [transactions, touches, autoCoded] = await Promise.all([
    service
      .from("vendor_bills")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .gte("created_at", since)
      .or("metadata->>creation_state.is.null,metadata->>creation_state.neq.draft"),
    service
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .eq("event_type", "coding.touched")
      .gte("created_at", since),
    service
      .from("vendor_bills")
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .gte("created_at", since)
      .eq("metadata->>coding_source", "rule"),
  ]);

  const firstError = transactions.error || touches.error || autoCoded.error;
  if (firstError) throw new Error(`Failed to load coding automation stats: ${firstError.message}`);

  const transactionCount = transactions.count ?? 0;
  const touchCount = touches.count ?? 0;
  return {
    windowDays: CODING_AUTOMATION_WINDOW_DAYS,
    transactions: transactionCount,
    touches: touchCount,
    touchesPerTransaction: transactionCount > 0 ? touchCount / transactionCount : null,
    autoCodedShare: transactionCount > 0 ? (autoCoded.count ?? 0) / transactionCount : null,
  };
}

export type CodingTouchField = "cost_code" | "budget_line" | "accounting_coding";

export type CodingTouchChange = {
  field: CodingTouchField;
  previousValue?: string | null;
  nextValue?: string | null;
};

/**
 * B1's acceptance criterion is touches per transaction, so a touch has to mean
 * "a human changed a coding value" — not "a human saved something". Callers
 * pass the fields whose values actually moved; unchanged fields are dropped
 * here rather than at each of the five call sites.
 */
export async function recordCodingTouch(input: {
  entityType: "vendor_bill" | "project_expense" | "accounting_import";
  entityId: string;
  changes: CodingTouchChange[];
  codingSource?: "rule" | "learned" | "ai" | "manual" | null;
  codingRuleId?: string | null;
  projectId?: string;
  orgId?: string;
}) {
  const changed = input.changes.filter(
    (change) => (change.previousValue ?? null) !== (change.nextValue ?? null),
  );
  if (!changed.length) return { touched: 0 };
  const context = await requireCodingContext(input.orgId, input.projectId);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "coding.touched",
    entityType: input.entityType,
    entityId: input.entityId,
    payload: {
      fields: changed.map((change) => change.field),
      changes: changed.map((change) => ({
        field: change.field,
        previous_value: change.previousValue ?? null,
        next_value: change.nextValue ?? null,
      })),
      coding_source: input.codingSource ?? null,
      coding_rule_id: input.codingRuleId ?? null,
    },
  });
  return { touched: changed.length };
}
