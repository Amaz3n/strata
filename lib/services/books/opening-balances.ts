import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { recordAudit } from "@/lib/services/audit";
import { booksDigest } from "@/lib/services/books/hash";
import {
  postBooksJournalEntry,
  reverseBooksJournalEntry,
} from "@/lib/services/books/ledger";
import type { JournalEntryDraft } from "@/lib/services/books/types";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

export type OpeningBalanceLineInput = {
  accountCode: string;
  subledgerType?:
    | "ar"
    | "ap"
    | "bank"
    | "credit_card"
    | "loan"
    | "fixed_asset"
    | "deposit"
    | "equity"
    | "other";
  sourceEntityType?: string;
  sourceEntityId?: string;
  projectId?: string;
  companyId?: string;
  description: string;
  debitCents: number;
  creditCents: number;
  details?: Record<string, unknown>;
};

async function requireOpeningPermission(
  permission: "books.manage" | "books.adjust" | "books.cutover",
  orgId?: string,
) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "opening_balance_batch",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

function validateLines(lines: OpeningBalanceLineInput[]) {
  if (lines.length < 2)
    throw new Error("Opening balances require at least two lines");
  let debitTotalCents = 0;
  let creditTotalCents = 0;
  for (const [index, line] of lines.entries()) {
    if (
      !Number.isSafeInteger(line.debitCents) ||
      !Number.isSafeInteger(line.creditCents)
    ) {
      throw new Error(`Opening line ${index + 1} must use integer cents`);
    }
    const valid =
      (line.debitCents > 0 && line.creditCents === 0) ||
      (line.creditCents > 0 && line.debitCents === 0);
    if (!valid)
      throw new Error(
        `Opening line ${index + 1} requires exactly one positive debit or credit`,
      );
    const requiredSubledger: Record<
      string,
      OpeningBalanceLineInput["subledgerType"]
    > = {
      "1000": "bank",
      "1100": "ar",
      "2000": "ap",
      "2100": "credit_card",
      "2400": "loan",
      "2500": "loan",
    };
    const expected = requiredSubledger[line.accountCode];
    if (expected && line.subledgerType !== expected) {
      throw new Error(
        `Opening line ${index + 1} for account ${line.accountCode} requires subledgerType "${expected}"`,
      );
    }
    if (
      expected &&
      !line.sourceEntityType &&
      !line.sourceEntityId &&
      !line.companyId
    ) {
      throw new Error(
        `Opening line ${index + 1} for control account ${line.accountCode} requires source detail`,
      );
    }
    debitTotalCents += line.debitCents;
    creditTotalCents += line.creditCents;
  }
  if (debitTotalCents !== creditTotalCents)
    throw new Error("Opening balance batch does not balance");
  return { debitTotalCents, creditTotalCents };
}

export async function createOpeningBalanceBatch(input: {
  cutoverDate: string;
  connectionId?: string | null;
  sourceFilename?: string | null;
  sourceContent: string;
  sourceMetadata?: Record<string, unknown>;
  lines: OpeningBalanceLineInput[];
  orgId?: string;
}) {
  const context = await requireOpeningPermission("books.manage", input.orgId);
  const totals = validateLines(input.lines);
  const service = createServiceSupabaseClient();
  const sourceContentHash = booksDigest(input.sourceContent);
  const digest = booksDigest({
    orgId: context.orgId,
    cutoverDate: input.cutoverDate,
    sourceContentHash,
    lines: input.lines,
  });
  const codes = Array.from(
    new Set(input.lines.map((line) => line.accountCode)),
  );
  const { data: accountsData, error: accountsError } = await service
    .from("gl_accounts")
    .select("id, code")
    .eq("org_id", context.orgId)
    .in("code", codes);
  if (accountsError)
    throw new Error(
      `Failed to validate opening accounts: ${accountsError.message}`,
    );
  const accounts = z
    .array(z.object({ id: z.string().uuid(), code: z.string() }))
    .parse(accountsData ?? []);
  const accountByCode = new Map(
    accounts.map((account) => [account.code, account.id]),
  );
  const missing = codes.filter((code) => !accountByCode.has(code));
  if (missing.length > 0)
    throw new Error(
      `Opening balance accounts not found: ${missing.join(", ")}`,
    );

  const { data: batchData, error: batchError } = await service
    .from("opening_balance_batches")
    .insert({
      org_id: context.orgId,
      connection_id: input.connectionId ?? null,
      cutover_date: input.cutoverDate,
      status: "validated",
      source_filename: input.sourceFilename ?? null,
      source_content_hash: sourceContentHash,
      source_metadata: input.sourceMetadata ?? {},
      debit_total_cents: totals.debitTotalCents,
      credit_total_cents: totals.creditTotalCents,
      validation_errors: [],
      digest,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (batchError)
    throw new Error(`Failed to create opening batch: ${batchError.message}`);
  const batchId = z.object({ id: z.string().uuid() }).parse(batchData).id;
  const lineResult = await service.from("opening_balance_lines").insert(
    input.lines.map((line, index) => ({
      org_id: context.orgId,
      batch_id: batchId,
      line_no: index + 1,
      account_id: accountByCode.get(line.accountCode),
      subledger_type: line.subledgerType ?? null,
      source_entity_type: line.sourceEntityType ?? null,
      source_entity_id: line.sourceEntityId ?? null,
      project_id: line.projectId ?? null,
      company_id: line.companyId ?? null,
      description: line.description,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      details: line.details ?? {},
    })),
  );
  if (lineResult.error) {
    await service
      .from("opening_balance_batches")
      .delete()
      .eq("org_id", context.orgId)
      .eq("id", batchId);
    throw new Error(
      `Failed to create opening lines: ${lineResult.error.message}`,
    );
  }
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.opening_batch_validated",
    entityType: "opening_balance_batch",
    entityId: batchId,
    payload: { cutover_date: input.cutoverDate, digest },
  });
  return { batchId, digest, ...totals };
}

export async function approveOpeningBalanceBatch(input: {
  batchId: string;
  approvalRole: "owner" | "accountant";
  orgId?: string;
}) {
  const permission =
    input.approvalRole === "owner" ? "books.cutover" : "books.adjust";
  const context = await requireOpeningPermission(permission, input.orgId);
  const service = createServiceSupabaseClient();
  const { data: batch, error: batchError } = await service
    .from("opening_balance_batches")
    .select("id, status, digest")
    .eq("org_id", context.orgId)
    .eq("id", input.batchId)
    .single();
  if (
    batchError ||
    !batch?.digest ||
    !new Set(["validated", "approved"]).has(batch.status)
  ) {
    throw new Error("Opening balance batch is not ready for approval");
  }
  const { error } = await service.from("opening_balance_approvals").insert({
    org_id: context.orgId,
    batch_id: input.batchId,
    approval_role: input.approvalRole,
    approved_by: context.userId,
    approved_digest: batch.digest,
  });
  if (error)
    throw new Error(`Failed to approve opening balances: ${error.message}`);
  const { count, error: countError } = await service
    .from("opening_balance_approvals")
    .select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId)
    .eq("batch_id", input.batchId)
    .eq("approved_digest", batch.digest);
  if (countError)
    throw new Error(
      `Failed to verify opening approvals: ${countError.message}`,
    );
  if (count === 2) {
    const update = await service
      .from("opening_balance_batches")
      .update({
        status: "approved",
        approved_by: context.userId,
        approved_at: new Date().toISOString(),
      })
      .eq("org_id", context.orgId)
      .eq("id", input.batchId)
      .eq("digest", batch.digest);
    if (update.error)
      throw new Error(
        `Failed to finalize opening approval: ${update.error.message}`,
      );
  }
  return { approvalCount: count ?? 0 };
}

export async function postOpeningBalanceBatch(batchId: string, orgId?: string) {
  const context = await requireOpeningPermission("books.adjust", orgId);
  const service = createServiceSupabaseClient();
  const [batchResult, linesResult] = await Promise.all([
    service
      .from("opening_balance_batches")
      .select("id, cutover_date, status, digest, journal_entry_id")
      .eq("org_id", context.orgId)
      .eq("id", batchId)
      .single(),
    service
      .from("opening_balance_lines")
      .select(
        "line_no, project_id, company_id, description, debit_cents, credit_cents, details, account:gl_accounts!inner(code)",
      )
      .eq("org_id", context.orgId)
      .eq("batch_id", batchId)
      .order("line_no"),
  ]);
  if (batchResult.error)
    throw new Error(
      `Failed to load opening batch: ${batchResult.error.message}`,
    );
  if (linesResult.error)
    throw new Error(
      `Failed to load opening lines: ${linesResult.error.message}`,
    );
  if (batchResult.data.journal_entry_id)
    return batchResult.data.journal_entry_id;
  if (batchResult.data.status !== "approved" || !batchResult.data.digest)
    throw new Error("Opening batch requires both approvals");
  const lineSchema = z.object({
    project_id: z.string().uuid().nullable(),
    company_id: z.string().uuid().nullable(),
    description: z.string().nullable(),
    debit_cents: z.number().int(),
    credit_cents: z.number().int(),
    details: z.record(z.unknown()),
    account: z.union([
      z.object({ code: z.string() }),
      z.array(z.object({ code: z.string() })),
    ]),
  });
  const draft: JournalEntryDraft = {
    entryDate: batchResult.data.cutover_date,
    entryKind: "opening",
    memo: `Opening balances at ${batchResult.data.cutover_date}`,
    postingKey: `opening:${batchId}:${batchResult.data.digest}`,
    policyVersion: 1,
    sourceType: "opening_balance_batch",
    sourceId: batchId,
    lines: z
      .array(lineSchema)
      .parse(linesResult.data ?? [])
      .map((line) => {
        const account = Array.isArray(line.account)
          ? line.account[0]
          : line.account;
        if (!account) throw new Error("Opening line is missing its account");
        return {
          accountCode: account.code,
          projectId: line.project_id ?? undefined,
          companyId: line.company_id ?? undefined,
          description: line.description ?? undefined,
          debitCents: line.debit_cents,
          creditCents: line.credit_cents,
          dimensions: line.details,
        };
      }),
  };
  const posted = await postBooksJournalEntry(draft, {
    permission: "books.adjust",
    orgId: context.orgId,
  });
  const update = await service
    .from("opening_balance_batches")
    .update({
      status: "posted",
      journal_entry_id: posted.id,
      posted_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", batchId)
    .eq("status", "approved");
  if (update.error)
    throw new Error(
      `Failed to mark opening batch posted: ${update.error.message}`,
    );
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "opening_balance_batch",
    entityId: batchId,
    after: { status: "posted", journal_entry_id: posted.id },
    source: "books.opening.post",
  });
  return posted.id;
}

export async function reverseOpeningBalanceBatch(input: {
  batchId: string;
  reversalDate: string;
  reason: string;
  orgId?: string;
}) {
  const context = await requireOpeningPermission("books.adjust", input.orgId);
  const service = createServiceSupabaseClient();
  const { data: batch, error } = await service
    .from("opening_balance_batches")
    .select("status, journal_entry_id")
    .eq("org_id", context.orgId)
    .eq("id", input.batchId)
    .single();
  if (error || batch?.status !== "posted" || !batch.journal_entry_id)
    throw new Error("Only a posted opening batch can be reversed");
  const reversal = await reverseBooksJournalEntry({
    entryId: batch.journal_entry_id,
    reversalDate: input.reversalDate,
    reason: input.reason,
    orgId: context.orgId,
  });
  const update = await service
    .from("opening_balance_batches")
    .update({ status: "reversed", reversed_at: new Date().toISOString() })
    .eq("org_id", context.orgId)
    .eq("id", input.batchId);
  if (update.error)
    throw new Error(`Failed to reverse opening batch: ${update.error.message}`);
  return reversal.id;
}
