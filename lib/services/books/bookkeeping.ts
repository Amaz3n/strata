import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { booksDigest } from "@/lib/services/books/hash";
import {
  postBooksJournalEntry,
  postBooksJournalEntryForService,
} from "@/lib/services/books/ledger";
import type {
  JournalEntryDraft,
  JournalLineDraft,
} from "@/lib/services/books/types";
import { assertBalancedJournalDraft } from "@/lib/services/books/types";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

async function requireBooksAdjust(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.adjust",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "journal_entry",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function createAdjustingJournal(input: {
  entryDate: string;
  memo: string;
  lines: JournalLineDraft[];
  reversingOn?: string | null;
  orgId?: string;
}) {
  const context = await requireBooksAdjust(input.orgId);
  if (input.memo.trim().length < 4)
    throw new Error("An explanatory memo is required");
  const digest = booksDigest({
    date: input.entryDate,
    memo: input.memo.trim(),
    lines: input.lines,
  });
  const draft: JournalEntryDraft = {
    entryDate: input.entryDate,
    entryKind: "adjusting",
    memo: input.memo.trim(),
    postingKey: `adjustment:${digest}`,
    policyVersion: 1,
    lines: input.lines,
  };
  assertBalancedJournalDraft(draft);
  const posted = await postBooksJournalEntry(draft, {
    permission: "books.adjust",
    orgId: context.orgId,
  });
  if (input.reversingOn) {
    const reversingDraft: JournalEntryDraft = {
      entryDate: input.reversingOn,
      entryKind: "reversal",
      memo: `Automatic reversal: ${draft.memo}`,
      postingKey: `scheduled_reversal:${posted.id}:${input.reversingOn}`,
      policyVersion: draft.policyVersion,
      reversalOfEntryId: posted.id,
      lines: draft.lines.map((line) => ({
        ...line,
        debitCents: line.creditCents,
        creditCents: line.debitCents,
      })),
    };
    await postBooksJournalEntry(reversingDraft, {
      permission: "books.adjust",
      orgId: context.orgId,
    });
  }
  return posted;
}

export async function createRecurringPostingTemplate(input: {
  name: string;
  memo: string;
  frequency: "weekly" | "monthly" | "quarterly" | "annually";
  nextRunOn: string;
  endOn?: string | null;
  autoPost?: boolean;
  lines: JournalLineDraft[];
  orgId?: string;
}) {
  const context = await requireBooksAdjust(input.orgId);
  const testDraft: JournalEntryDraft = {
    entryDate: input.nextRunOn,
    entryKind: "adjusting",
    memo: input.memo,
    postingKey: "validation",
    policyVersion: 1,
    lines: input.lines,
  };
  assertBalancedJournalDraft(testDraft);
  const service = createServiceSupabaseClient();
  const codes = Array.from(
    new Set(input.lines.map((line) => line.accountCode)),
  );
  const { data: accounts, error: accountError } = await service
    .from("gl_accounts")
    .select("id, code")
    .eq("org_id", context.orgId)
    .in("code", codes);
  if (accountError)
    throw new Error(
      `Failed to resolve recurring accounts: ${accountError.message}`,
    );
  const accountByCode = new Map(
    (accounts ?? []).map((account) => [account.code, account.id]),
  );
  if (codes.some((code) => !accountByCode.has(code)))
    throw new Error("One or more recurring accounts do not exist");
  const { data, error } = await service
    .from("recurring_posting_templates")
    .insert({
      org_id: context.orgId,
      name: input.name.trim(),
      memo: input.memo.trim(),
      frequency: input.frequency,
      next_run_on: input.nextRunOn,
      end_on: input.endOn ?? null,
      auto_post: Boolean(input.autoPost),
      requires_approval: !input.autoPost,
      created_by: context.userId,
      updated_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to create recurring template: ${error.message}`);
  const templateId = z.object({ id: z.string().uuid() }).parse(data).id;
  const lineResult = await service.from("recurring_posting_lines").insert(
    input.lines.map((line, index) => ({
      org_id: context.orgId,
      template_id: templateId,
      line_no: index + 1,
      account_id: accountByCode.get(line.accountCode),
      project_id: line.projectId ?? null,
      company_id: line.companyId ?? null,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      description: line.description ?? null,
    })),
  );
  if (lineResult.error)
    throw new Error(
      `Failed to create recurring lines: ${lineResult.error.message}`,
    );
  return templateId;
}

function nextRunDate(
  current: string,
  frequency: "weekly" | "monthly" | "quarterly" | "annually",
) {
  const date = new Date(`${current}T00:00:00Z`);
  if (frequency === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else if (frequency === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
  else if (frequency === "quarterly") date.setUTCMonth(date.getUTCMonth() + 3);
  else date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export async function processRecurringPostings(
  asOf = new Date().toISOString().slice(0, 10),
) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("recurring_posting_templates")
    .select(
      "id, org_id, name, memo, frequency, next_run_on, end_on, auto_post, requires_approval, last_notified_on, lines:recurring_posting_lines(debit_cents, credit_cents, description, project_id, company_id, account:gl_accounts(code))",
    )
    .eq("status", "active")
    .lte("next_run_on", asOf)
    .limit(250);
  if (error)
    throw new Error(`Failed to load recurring postings: ${error.message}`);
  const orgIds = Array.from(
    new Set((data ?? []).map((template) => template.org_id)),
  );
  const { data: settingsRows, error: settingsError } =
    orgIds.length > 0
      ? await service
          .from("books_settings")
          .select("org_id, active_policy_version")
          .eq("workspace_enabled", true)
          .in("org_id", orgIds)
      : { data: [], error: null };
  if (settingsError)
    throw new Error(
      `Failed to load recurring posting policies: ${settingsError.message}`,
    );
  const policyByOrg = new Map(
    (settingsRows ?? []).map((settings) => [
      settings.org_id,
      Number(settings.active_policy_version),
    ]),
  );
  let posted = 0;
  let awaitingApproval = 0;
  for (const template of data ?? []) {
    if (!policyByOrg.has(template.org_id)) continue;
    if (!template.auto_post || template.requires_approval) {
      if (template.last_notified_on === template.next_run_on) continue;
      await recordEvent({
        orgId: template.org_id,
        eventType: "books.recurring_posting_due",
        entityType: "recurring_posting_template",
        entityId: template.id,
        payload: { name: template.name, due_on: template.next_run_on },
        channel: "notification",
      });
      await service
        .from("recurring_posting_templates")
        .update({ last_notified_on: template.next_run_on })
        .eq("org_id", template.org_id)
        .eq("id", template.id)
        .eq("next_run_on", template.next_run_on);
      awaitingApproval += 1;
      continue;
    }
    const lines = (template.lines ?? []).map((row) => {
      const account = Array.isArray(row.account) ? row.account[0] : row.account;
      if (!account) throw new Error("Recurring line has no GL account");
      return {
        accountCode: account.code,
        debitCents: Number(row.debit_cents),
        creditCents: Number(row.credit_cents),
        description: row.description ?? undefined,
        projectId: row.project_id ?? undefined,
        companyId: row.company_id ?? undefined,
      };
    });
    await postBooksJournalEntryForService(
      {
        entryDate: template.next_run_on,
        entryKind: "adjusting",
        memo: template.memo,
        postingKey: `recurring:${template.id}:${template.next_run_on}`,
        policyVersion: policyByOrg.get(template.org_id) ?? 1,
        sourceType: "recurring_posting_template",
        sourceId: template.id,
        lines,
      },
      template.org_id,
    );
    const next = nextRunDate(template.next_run_on, template.frequency);
    const completed = Boolean(template.end_on && next > template.end_on);
    await service
      .from("recurring_posting_templates")
      .update({ next_run_on: next, status: completed ? "completed" : "active" })
      .eq("org_id", template.org_id)
      .eq("id", template.id)
      .eq("next_run_on", template.next_run_on);
    posted += 1;
  }
  return { attempted: data?.length ?? 0, posted, awaitingApproval };
}
