import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { recordAudit } from "@/lib/services/audit";
import { booksDigest } from "@/lib/services/books/hash";
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

/**
 * Every problem with an opening batch, as a list of fixes: an opening that is
 * missing evidence is refused with all of it named at once, never a first error
 * that hides the rest, and never made up.
 */
function validateLines(lines: OpeningBalanceLineInput[], cutoverDate: string) {
  const issues: string[] = [];
  if (lines.length < 2) issues.push("Add at least two lines; an opening journal needs a debit and a credit.");
  let debitTotalCents = 0;
  let creditTotalCents = 0;
  const requiredSubledger: Record<string, OpeningBalanceLineInput["subledgerType"]> = {
    "1000": "bank", "1100": "ar", "1110": "ar", "2010": "ap", "2300": "deposit", "2000": "ap", "2100": "credit_card", "2400": "loan", "2500": "loan",
  };
  for (const [index, line] of lines.entries()) {
    const at = `Line ${index + 1}`;
    if (!Number.isSafeInteger(line.debitCents) || !Number.isSafeInteger(line.creditCents)) {
      issues.push(`${at}: enter amounts in whole cents.`);
      continue;
    }
    if (!((line.debitCents > 0 && line.creditCents === 0) || (line.creditCents > 0 && line.debitCents === 0)))
      issues.push(`${at}: enter one positive debit or credit, not both.`);
    const expected = requiredSubledger[line.accountCode];
    if (expected && line.subledgerType !== expected)
      issues.push(`${at}: account ${line.accountCode} is a ${expected} control account; mark the line as ${expected}.`);
    if (expected && !line.sourceEntityType && !line.sourceEntityId && !line.companyId && !line.projectId &&
      !line.details?.existing_entity_id && !line.details?.customer_id && !line.details?.cash_account_id)
      issues.push(`${at}: say which customer, vendor, account or document this control-account balance belongs to.`);
    // An open invoice, bill or deposit comes over as the document it is: its own
    // number, date and party. A missing due date stays missing.
    if (["ar", "ap", "deposit"].includes(line.subledgerType ?? "") && !line.details?.existing_entity_id) {
      const party = line.subledgerType === "ap" ? "vendor" : "customer";
      if (!(typeof line.details?.document_number === "string" && line.details.document_number.trim()) && !line.sourceEntityId)
        issues.push(`${at}: give the original ${line.subledgerType === "ap" ? "bill" : "invoice"} number.`);
      const documentDate = line.details?.document_date;
      if (typeof documentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) issues.push(`${at}: give the original document date.`);
      else if (documentDate > cutoverDate) issues.push(`${at}: the document is dated after cutover; it belongs after the opening.`);
      if (line.subledgerType === "ap" ? !line.companyId : !line.details?.customer_id) issues.push(`${at}: name the ${party}.`);
      if (line.subledgerType === "ap" && !line.projectId) issues.push(`${at}: name the job this bill belongs to.`);
    }
    // A check or deposit the bank had not cleared at cutover is its own opening
    // line, so the first statements can clear exactly that item.
    if (line.details?.bank_opening_role !== undefined) {
      const { bank_opening_role: role, reference, document_date: documentDate } = line.details;
      if (role !== "outstanding_item" || (line.subledgerType !== "bank" && line.subledgerType !== "credit_card"))
        issues.push(`${at}: only bank and card accounts carry outstanding items.`);
      if (typeof reference !== "string" || reference.trim().length === 0)
        issues.push(`${at}: give the outstanding check or deposit its reference.`);
      if (typeof documentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(documentDate) || documentDate > cutoverDate)
        issues.push(`${at}: give the outstanding item its original date, on or before cutover.`);
    }
    debitTotalCents += line.debitCents;
    creditTotalCents += line.creditCents;
  }
  if (debitTotalCents !== creditTotalCents)
    issues.push(`The batch does not balance: debits ${debitTotalCents} cents, credits ${creditTotalCents} cents.`);
  if (issues.length)
    throw new Error(`The opening balances need ${issues.length === 1 ? "this fix" : `these ${issues.length} fixes`} before they can be saved:\n${issues.map((issue) => `• ${issue}`).join("\n")}`);
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
  const totals = validateLines(input.lines, input.cutoverDate);
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
  const { data, error } = await createServiceSupabaseClient().rpc("approve_books_opening_batch", {
    p_org_id: context.orgId, p_batch_id: z.string().uuid().parse(input.batchId), p_role: input.approvalRole, p_actor_id: context.userId,
  });
  if (error) throw new Error(`Failed to approve opening balances: ${error.message}`);
  return { approvalCount: z.number().int().parse(data) };
}

export async function postOpeningBalanceBatch(batchId: string, orgId?: string) {
  const context = await requireOpeningPermission("books.adjust", orgId);
  const { data, error } = await createServiceSupabaseClient().rpc("post_books_opening_batch", {
    p_org_id: context.orgId, p_batch_id: z.string().uuid().parse(batchId), p_actor_id: context.userId,
  });
  if (error) throw new Error(`Failed to initialize opening balances and open items: ${error.message}`);
  const id = z.string().uuid().parse(data);
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "opening_balance_batch", entityId: batchId, after: { status: "posted", journal_entry_id: id }, source: "books.opening.post" });
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.opening_posted", entityType: "opening_balance_batch", entityId: batchId, payload: { journal_entry_id: id } });
  return id;
}

export async function reverseOpeningBalanceBatch(input: {
  batchId: string;
  reversalDate: string;
  reason: string;
  orgId?: string;
}) {
  const context = await requireOpeningPermission("books.adjust", input.orgId);
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc("reverse_books_opening_batch", {
    p_org_id: context.orgId, p_batch_id: z.string().uuid().parse(input.batchId),
    p_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(input.reversalDate),
    p_reason: z.string().trim().min(10).parse(input.reason), p_actor_id: context.userId,
  });
  if (error) throw new Error(error.message);
  const id = z.string().uuid().parse(data);
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "opening_balance_batch", entityId: input.batchId, after: { status: "reversed", reversal_entry_id: id, reason: input.reason }, source: "books.opening.reverse" });
  return id;
}
