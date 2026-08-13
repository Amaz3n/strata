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

/** Reading the journal is not the same right as writing to it. */
async function requireBooksRead(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.read",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "journal_entry",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export const JOURNAL_ENTRY_KINDS = [
  "operational",
  "adjusting",
  "opening",
  "poc",
  "closing",
  "reversal",
] as const

export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number]

const JOURNAL_PAGE_CAP = 200

/**
 * Journal entries by where they came from.
 *
 * The question this answers is the one an auditor opens with: what in this ledger
 * did a person write, as opposed to what the projector derived from a bill? C1
 * directive 9 left that unanswerable from the product — hand-posted adjustments
 * are legitimate but were invisible next to projected entries, distinguishable
 * only by reading `posting_key` prefixes.
 *
 * Lines are embedded rather than fetched per row: entries are capped, an entry
 * has a handful of lines, and an audit view where you must click every row to see
 * the debits is not one anybody will use.
 */
export async function listJournalEntries(input: {
  entryKinds?: JournalEntryKind[];
  startDate?: string;
  endDate?: string;
  orgId?: string;
} = {}) {
  const context = await requireBooksRead(input.orgId);
  const service = createServiceSupabaseClient();

  let query = service
    .from("journal_entries")
    .select(
      "id, entry_date, entry_kind, status, memo, posting_key, source_type, source_id, posted_at, posted_by, reversal_of_entry_id, " +
        "lines:journal_lines(id, debit_cents, credit_cents, description, project_id, account:gl_accounts(code, name))",
    )
    .eq("org_id", context.orgId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(0, JOURNAL_PAGE_CAP);
  if (input.entryKinds?.length) query = query.in("entry_kind", input.entryKinds);
  if (input.startDate) query = query.gte("entry_date", input.startDate);
  if (input.endDate) query = query.lte("entry_date", input.endDate);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load journal entries: ${error.message}`);

  const entrySchema = z.object({
    id: z.string().uuid(),
    entry_date: z.string(),
    entry_kind: z.string(),
    status: z.string(),
    memo: z.string().nullable(),
    posting_key: z.string(),
    source_type: z.string().nullable(),
    source_id: z.string().nullable(),
    posted_at: z.string().nullable(),
    posted_by: z.string().uuid().nullable(),
    reversal_of_entry_id: z.string().uuid().nullable(),
    lines: z.array(
      z.object({
        id: z.string().uuid(),
        debit_cents: z.number().int(),
        credit_cents: z.number().int(),
        description: z.string().nullable(),
        project_id: z.string().uuid().nullable(),
        account: z
          .union([
            z.object({ code: z.string(), name: z.string() }),
            z.array(z.object({ code: z.string(), name: z.string() })),
          ])
          .nullable(),
      }),
    ),
  });
  const parsed = z.array(entrySchema).parse(data ?? []);
  const truncated = parsed.length > JOURNAL_PAGE_CAP;
  const page = truncated ? parsed.slice(0, JOURNAL_PAGE_CAP) : parsed;

  // Who posted it is half the audit question, and `posted_by` is only a uuid.
  const posterIds = Array.from(
    new Set(page.map((entry) => entry.posted_by).filter((id): id is string => Boolean(id))),
  );
  const posterNames = new Map<string, string>();
  if (posterIds.length > 0) {
    const { data: users } = await service
      .from("app_users")
      .select("id, full_name, email")
      .in("id", posterIds);
    for (const user of users ?? []) {
      posterNames.set(String(user.id), String(user.full_name || user.email || "Unknown"));
    }
  }

  return {
    truncated,
    rowCap: JOURNAL_PAGE_CAP,
    entries: page.map((entry) => {
      const lines = entry.lines.map((line) => {
        const account = Array.isArray(line.account) ? line.account[0] : line.account;
        return {
          id: line.id,
          accountCode: account?.code ?? "",
          accountName: account?.name ?? "",
          debitCents: line.debit_cents,
          creditCents: line.credit_cents,
          description: line.description,
          projectId: line.project_id,
        };
      });
      return {
        id: entry.id,
        entryDate: entry.entry_date,
        entryKind: entry.entry_kind,
        status: entry.status,
        memo: entry.memo ?? "",
        postingKey: entry.posting_key,
        sourceType: entry.source_type,
        sourceId: entry.source_id,
        postedAt: entry.posted_at,
        postedByName: entry.posted_by ? posterNames.get(entry.posted_by) ?? null : null,
        isReversal: Boolean(entry.reversal_of_entry_id),
        // A hand-authored entry has no fact behind it. That is the whole
        // distinction this view exists to draw.
        isManual: entry.entry_kind === "adjusting" || entry.entry_kind === "opening",
        totalCents: lines.reduce((sum, line) => sum + line.debitCents, 0),
        lines,
      };
    }),
  };
}

export type JournalEntryListing = Awaited<ReturnType<typeof listJournalEntries>>;
export type JournalEntrySummary = JournalEntryListing["entries"][number];

export async function listRecurringPostingTemplates(orgId?: string) {
  const context = await requireBooksRead(orgId);
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("recurring_posting_templates")
    .select(
      "id, name, memo, frequency, next_run_on, end_on, status, auto_post, requires_approval, " +
        "lines:recurring_posting_lines(id, line_no, debit_cents, credit_cents, description, account:gl_accounts(code, name))",
    )
    .eq("org_id", context.orgId)
    .order("next_run_on", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Failed to load recurring templates: ${error.message}`);

  const templateSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    memo: z.string(),
    frequency: z.string(),
    next_run_on: z.string(),
    end_on: z.string().nullable(),
    status: z.string(),
    auto_post: z.boolean(),
    requires_approval: z.boolean(),
    lines: z.array(
      z.object({
        id: z.string().uuid(),
        line_no: z.number().int(),
        debit_cents: z.number().int(),
        credit_cents: z.number().int(),
        description: z.string().nullable(),
        account: z
          .union([
            z.object({ code: z.string(), name: z.string() }),
            z.array(z.object({ code: z.string(), name: z.string() })),
          ])
          .nullable(),
      }),
    ),
  });

  return z
    .array(templateSchema)
    .parse(data ?? [])
    .map((template) => ({
      id: template.id,
      name: template.name,
      memo: template.memo,
      frequency: template.frequency,
      nextRunOn: template.next_run_on,
      endOn: template.end_on,
      status: template.status,
      autoPost: template.auto_post,
      requiresApproval: template.requires_approval,
      lines: [...template.lines]
        .sort((left, right) => left.line_no - right.line_no)
        .map((line) => {
          const account = Array.isArray(line.account) ? line.account[0] : line.account;
          return {
            id: line.id,
            accountCode: account?.code ?? "",
            accountName: account?.name ?? "",
            debitCents: line.debit_cents,
            creditCents: line.credit_cents,
            description: line.description,
          };
        }),
      totalCents: template.lines.reduce((sum, line) => sum + line.debit_cents, 0),
    }));
}

/**
 * Pause, resume, or retire a template.
 *
 * Deleting is not offered: a template that has already posted entries is part of
 * the ledger's history, and `completed` records that it stopped without pretending
 * it never ran.
 */
export async function setRecurringTemplateStatus(input: {
  templateId: string;
  status: "active" | "paused" | "completed";
  orgId?: string;
}) {
  const context = await requireBooksAdjust(input.orgId);
  const service = createServiceSupabaseClient();
  const { error } = await service
    .from("recurring_posting_templates")
    .update({ status: input.status, updated_by: context.userId })
    .eq("org_id", context.orgId)
    .eq("id", input.templateId);
  if (error) throw new Error(`Failed to update the recurring template: ${error.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.recurring_template_status_changed",
    entityType: "recurring_posting_template",
    entityId: input.templateId,
    payload: { status: input.status },
  });
  return { success: true as const };
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
    // Hand-authored entries are not projections, so they stay at version 1 and
    // are keyed by their own content digest.
    projectionVersion: 1,
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
      projectionVersion: draft.projectionVersion,
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

/** Stage a hand-authored entry for a different user to review and post. */
export async function proposeAdjustingJournal(input: {
  entryDate: string;
  memo: string;
  lines: JournalLineDraft[];
  reversingOn?: string | null;
  orgId?: string;
}) {
  const context = await requireBooksAdjust(input.orgId);
  const service = createServiceSupabaseClient();
  const draft: JournalEntryDraft = {
    entryDate: input.entryDate,
    entryKind: "adjusting",
    memo: input.memo.trim(),
    postingKey: "validation",
    projectionVersion: 1,
    policyVersion: 1,
    lines: input.lines,
  };
  assertBalancedJournalDraft(draft);
  const codes = [...new Set(input.lines.map((line) => line.accountCode))];
  const [{ data: accounts, error: accountError }, { data: settings, error: settingsError }] = await Promise.all([
    service.from("gl_accounts").select("id,code").eq("org_id", context.orgId).eq("active", true).in("code", codes),
    service.from("books_settings").select("active_policy_version").eq("org_id", context.orgId).single(),
  ]);
  if (accountError ?? settingsError) throw new Error(`Failed to prepare journal proposal: ${(accountError ?? settingsError)?.message}`);
  const accountByCode = new Map((accounts ?? []).map((row) => [row.code, row.id]));
  if (codes.some((code) => !accountByCode.has(code))) throw new Error("One or more selected accounts are unavailable");
  const digest = booksDigest({ date: input.entryDate, memo: input.memo.trim(), lines: input.lines });
  const { data, error } = await service.from("books_journal_proposals").insert({
    org_id: context.orgId,
    entry_date: input.entryDate,
    memo: input.memo.trim(),
    reversing_on: input.reversingOn || null,
    posting_key: `adjustment:${digest}`,
    policy_version: Number(settings.active_policy_version),
    proposed_by: context.userId,
    lines: input.lines.map((line, index) => ({
      line_no: index + 1,
      account_id: accountByCode.get(line.accountCode),
      project_id: line.projectId ?? null,
      company_id: line.companyId ?? null,
      description: line.description ?? null,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      dimensions: line.dimensions ?? {},
    })),
  }).select("id").single();
  if (error) throw new Error(`Failed to create journal proposal: ${error.message}`);
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.journal_proposed", entityType: "books_journal_proposal", entityId: data.id, payload: { entry_date: input.entryDate, memo: input.memo.trim() }, channel: "notification" });
  return { id: data.id };
}

export async function listJournalProposals(orgId?: string) {
  const context = await requireBooksAdjust(orgId);
  const service = createServiceSupabaseClient();
  const { data, error } = await service.from("books_journal_proposals").select("id,entry_date,memo,reversing_on,status,proposed_by,proposed_at,review_note,lines,proposer:app_users!books_journal_proposals_proposed_by_fkey(full_name,email)").eq("org_id", context.orgId).order("proposed_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Failed to load journal proposals: ${error.message}`);
  return { proposals: data ?? [], currentUserId: context.userId };
}

export async function reviewJournalProposal(input: { proposalId: string; decision: "approve" | "reject"; note?: string }, orgId?: string) {
  const context = await requireBooksAdjust(orgId);
  const service = createServiceSupabaseClient();
  const parsed = z.object({ proposalId: z.string().uuid(), decision: z.enum(["approve","reject"]), note: z.string().trim().max(1000).optional() }).parse(input);
  const { data, error } = await service.rpc("review_books_journal_proposal_atomic", { p_org_id: context.orgId, p_proposal_id: parsed.proposalId, p_reviewer_id: context.userId, p_decision: parsed.decision, p_note: parsed.note ?? "" });
  if (error) throw new Error(`Failed to review journal proposal: ${error.message}`);
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `books.journal_${parsed.decision === "approve" ? "approved" : "rejected"}`, entityType: "books_journal_proposal", entityId: parsed.proposalId, payload: { note: parsed.note ?? null }, channel: "notification" });
  return data;
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
    projectionVersion: 1,
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
        projectionVersion: 1,
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

export type RecurringPostingTemplate = Awaited<
  ReturnType<typeof listRecurringPostingTemplates>
>[number];
