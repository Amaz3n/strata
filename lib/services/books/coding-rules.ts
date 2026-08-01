import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import type { AccountingCoding } from "@/lib/services/accounting-coding";
import {
  selectCodingSuggestion,
  type CodingSuggestion,
} from "@/lib/services/accounting-rules";
import { requireAuthorization } from "@/lib/services/authorization";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

const codingRuleSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid().nullable(),
  match_kind: z.enum(["vendor", "vendor_memo", "card_scope", "email_sender"]),
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

export type { CodingSuggestion } from "@/lib/services/accounting-rules";

function normalize(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

async function requireCodingContext(orgId?: string, projectId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "bill.write",
    userId: context.userId,
    orgId: context.orgId,
    projectId,
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
  projectId?: string;
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
    .in("match_kind", ["vendor", "vendor_memo"])
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
  corrected?: boolean;
  projectId?: string;
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
    .select("id, hit_count, correction_count")
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

  const hitCount = Number(existing?.hit_count ?? 0) + (input.corrected ? 0 : 1);
  const correctionCount =
    Number(existing?.correction_count ?? 0) + (input.corrected ? 1 : 0);
  const confidence = Math.max(
    0,
    Math.min(1, hitCount / Math.max(3, hitCount + correctionCount * 2)),
  );
  const row = {
    org_id: context.orgId,
    match_kind: matchKind,
    company_id: companyId,
    match_value: matchValue,
    memo_pattern: memoPattern,
    cost_code_id: input.costCodeId ?? null,
    budget_line_id: input.budgetLineId ?? null,
    accounting_coding: input.accountingCoding ?? {},
    confidence,
    hit_count: hitCount,
    correction_count: correctionCount,
    last_hit_at: input.corrected ? null : new Date().toISOString(),
    last_corrected_at: input.corrected ? new Date().toISOString() : null,
    created_from: "user_correction",
    active: true,
    created_by: context.userId,
    updated_at: new Date().toISOString(),
  };
  const result = existing?.id
    ? await service
        .from("coding_rules")
        .update(row)
        .eq("org_id", context.orgId)
        .eq("id", existing.id)
        .select("id")
        .single()
    : await service.from("coding_rules").insert(row).select("id").single();
  if (result.error)
    throw new Error(`Failed to save coding rule: ${result.error.message}`);
  return z.object({ id: z.string().uuid() }).parse(result.data).id;
}

export async function recordCodingTouch(input: {
  entityType: "vendor_bill" | "project_expense" | "accounting_import";
  entityId: string;
  field: "cost_code" | "budget_line" | "accounting_coding";
  previousValue?: string | null;
  nextValue?: string | null;
  projectId?: string;
  orgId?: string;
}) {
  const context = await requireCodingContext(input.orgId, input.projectId);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "coding.touched",
    entityType: input.entityType,
    entityId: input.entityId,
    payload: {
      field: input.field,
      previous_value: input.previousValue ?? null,
      next_value: input.nextValue ?? null,
    },
  });
}
