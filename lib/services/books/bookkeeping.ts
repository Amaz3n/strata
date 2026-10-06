import { createHash } from "node:crypto";
import { journalRecoverySchema } from "@/lib/services/books/journal-recovery";
import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { booksDigest } from "@/lib/services/books/hash";
import type {
  JournalEntryDraft,
  JournalLineDraft,
} from "@/lib/services/books/types";
import { assertBalancedJournalDraft } from "@/lib/services/books/types";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { recordAudit } from "@/lib/services/audit";

import {
  journalProposalCursorSchema,
  pendingJournalProposalSchema,
  type JournalProposalCursor,
} from "@/lib/services/books/journal-proposal-review";

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

function assertJournalRequestScope(
  context: { orgId: string; userId: string },
  input: { expectedOrgId?: string; expectedActorId?: string },
) {
  if (
    (input.expectedOrgId !== undefined &&
      z.string().uuid().parse(input.expectedOrgId).toLowerCase() !==
        context.orgId.toLowerCase()) ||
    (input.expectedActorId !== undefined &&
      z.string().uuid().parse(input.expectedActorId).toLowerCase() !==
        context.userId.toLowerCase())
  )
    throw new Error(
      "Saved journal request belongs to another organization or user",
    );
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
] as const;

export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

const JOURNAL_PAGE_CAP = 200;
const JOURNAL_SCAN_CAP = 1000;

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
export async function listJournalEntries(
  input: {
    entryKinds?: JournalEntryKind[];
    startDate?: string;
    endDate?: string;
    query?: string;
    accountId?: string;
    projectId?: string;
    minAmountCents?: number;
    maxAmountCents?: number;
    orgId?: string;
  } = {},
) {
  const context = await requireBooksRead(input.orgId);
  const service = createServiceSupabaseClient();

  let query = service
    .from("journal_entries")
    .select(
      "id, entry_date, entry_kind, status, memo, posting_key, source_type, source_id, posted_at, posted_by, reversal_of_entry_id, " +
        "lines:journal_lines(id, account_id, debit_cents, credit_cents, description, project_id, account:gl_accounts(code, name), project:projects(name), company:companies(name))",
    )
    .eq("org_id", context.orgId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(0, JOURNAL_SCAN_CAP);
  if (input.entryKinds?.length)
    query = query.in("entry_kind", input.entryKinds);
  if (input.startDate) query = query.gte("entry_date", input.startDate);
  if (input.endDate) query = query.lte("entry_date", input.endDate);

  const { data, error } = await query;
  if (error)
    throw new Error(`Failed to load journal entries: ${error.message}`);

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
        account_id: z.string().uuid(),
        debit_cents: z.number().int(),
        credit_cents: z.number().int(),
        description: z.string().nullable(),
        project_id: z.string().uuid().nullable(),
        project: z
          .union([
            z.object({ name: z.string() }),
            z.array(z.object({ name: z.string() })),
          ])
          .nullable(),
        company: z
          .union([
            z.object({ name: z.string() }),
            z.array(z.object({ name: z.string() })),
          ])
          .nullable(),
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
  const scanTruncated = parsed.length > JOURNAL_SCAN_CAP;
  const scanned = scanTruncated ? parsed.slice(0, JOURNAL_SCAN_CAP) : parsed;
  const needle = input.query?.trim().toLowerCase() ?? "";
  const filtered = scanned.filter((entry) => {
    const totalCents = entry.lines.reduce(
      (sum, line) => sum + line.debit_cents,
      0,
    );
    if (
      input.accountId &&
      !entry.lines.some((line) => line.account_id === input.accountId)
    )
      return false;
    if (
      input.projectId &&
      !entry.lines.some((line) => line.project_id === input.projectId)
    )
      return false;
    if (input.minAmountCents != null && totalCents < input.minAmountCents)
      return false;
    if (input.maxAmountCents != null && totalCents > input.maxAmountCents)
      return false;
    if (!needle) return true;
    return [
      entry.memo ?? "",
      entry.posting_key,
      entry.source_type ?? "",
      entry.source_id ?? "",
      ...entry.lines.flatMap((line) => {
        const account = Array.isArray(line.account)
          ? line.account[0]
          : line.account;
        const project = Array.isArray(line.project)
          ? line.project[0]
          : line.project;
        const company = Array.isArray(line.company)
          ? line.company[0]
          : line.company;
        return [
          line.description ?? "",
          account?.code ?? "",
          account?.name ?? "",
          project?.name ?? "",
          company?.name ?? "",
        ];
      }),
    ].some((value) => value.toLowerCase().includes(needle));
  });
  const truncated = scanTruncated || filtered.length > JOURNAL_PAGE_CAP;
  const page = filtered.slice(0, JOURNAL_PAGE_CAP);

  // Who posted it is half the audit question, and `posted_by` is only a uuid.
  const posterIds = Array.from(
    new Set(
      page
        .map((entry) => entry.posted_by)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const posterNames = new Map<string, string>();
  if (posterIds.length > 0) {
    const { data: users } = await service
      .from("app_users")
      .select("id, full_name, email")
      .in("id", posterIds);
    for (const user of users ?? []) {
      posterNames.set(
        String(user.id),
        String(user.full_name || user.email || "Unknown"),
      );
    }
  }

  return {
    truncated,
    scanTruncated,
    rowCap: JOURNAL_PAGE_CAP,
    entries: page.map((entry) => {
      const lines = entry.lines.map((line) => {
        const account = Array.isArray(line.account)
          ? line.account[0]
          : line.account;
        const project = Array.isArray(line.project)
          ? line.project[0]
          : line.project;
        const company = Array.isArray(line.company)
          ? line.company[0]
          : line.company;
        return {
          id: line.id,
          accountId: line.account_id,
          accountCode: account?.code ?? "",
          accountName: account?.name ?? "",
          debitCents: line.debit_cents,
          creditCents: line.credit_cents,
          description: line.description,
          projectId: line.project_id,
          projectName: project?.name ?? null,
          companyName: company?.name ?? null,
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
        postedByName: entry.posted_by
          ? (posterNames.get(entry.posted_by) ?? null)
          : null,
        isReversal: Boolean(entry.reversal_of_entry_id),
        // A hand-authored entry has no fact behind it. That is the whole
        // distinction this view exists to draw.
        isManual:
          entry.entry_kind === "adjusting" || entry.entry_kind === "opening",
        totalCents: lines.reduce((sum, line) => sum + line.debitCents, 0),
        lines,
      };
    }),
  };
}

export type JournalEntryListing = Awaited<
  ReturnType<typeof listJournalEntries>
>;
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
  if (error)
    throw new Error(`Failed to load recurring templates: ${error.message}`);

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
          const account = Array.isArray(line.account)
            ? line.account[0]
            : line.account;
          return {
            id: line.id,
            accountCode: account?.code ?? "",
            accountName: account?.name ?? "",
            debitCents: line.debit_cents,
            creditCents: line.credit_cents,
            description: line.description,
          };
        }),
      totalCents: template.lines.reduce(
        (sum, line) => sum + line.debit_cents,
        0,
      ),
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
  if (error)
    throw new Error(
      `Failed to update the recurring template: ${error.message}`,
    );
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
  const service = createServiceSupabaseClient();
  const codes = [...new Set(input.lines.map((line) => line.accountCode))];
  // Include inactive originals for exact retries; the RPC checks active accounts
  // under a row fence whenever it creates new adjustment money.
  const accounts = await service
    .from("gl_accounts")
    .select("id,code")
    .eq("org_id", context.orgId)
    .in("code", codes);
  if (accounts.error) throw new Error("Could not resolve adjustment accounts");
  const accountByCode = new Map(
    z
      .array(z.object({ id: z.string().uuid(), code: z.string() }))
      .parse(accounts.data ?? [])
      .map((row) => [row.code, row.id]),
  );
  if (codes.some((code) => !accountByCode.has(code)))
    throw new Error("One or more adjustment accounts are unavailable");
  const { data, error } = await service.rpc("post_books_adjustment_pair", {
    p_org: context.orgId,
    p_actor: context.userId,
    p_date: draft.entryDate,
    p_memo: draft.memo,
    p_key: draft.postingKey,
    p_policy: draft.policyVersion,
    p_lines: input.lines.map((line, index) => ({
      line_no: index + 1,
      account_id: accountByCode.get(line.accountCode),
      project_id: line.projectId ?? null,
      company_id: line.companyId ?? null,
      description: line.description ?? null,
      debit_cents: line.debitCents,
      credit_cents: line.creditCents,
      dimensions: line.dimensions ?? {},
    })),
    p_reversing_on: input.reversingOn || null,
  });
  if (error) throw new Error(`Could not post adjustment: ${error.message}`);
  const receipt = z
    .object({
      orgId: z.literal(context.orgId),
      actorId: z.literal(context.userId),
      postingKey: z.literal(draft.postingKey),
      id: z.string().uuid(),
      reversalId: z.string().uuid().nullable(),
      created: z.boolean(),
      reversalCreated: z.boolean(),
      legacyRecovered: z.boolean(),
    })
    .parse(data);
  if (
    Boolean(input.reversingOn) !== Boolean(receipt.reversalId) ||
    (receipt.created && receipt.legacyRecovered) ||
    (receipt.legacyRecovered && !receipt.reversalCreated) ||
    (receipt.reversalCreated && !receipt.reversalId) ||
    (receipt.created &&
      Boolean(input.reversingOn) &&
      !receipt.reversalCreated) ||
    receipt.reversalId === receipt.id
  )
    throw new Error("Adjustment receipt differs from requested pair");
  const postedEntries = [
    ...(receipt.created
      ? [
          {
            id: receipt.id,
            key: draft.postingKey,
            date: draft.entryDate,
            kind: "adjusting",
          },
        ]
      : []),
    ...(receipt.reversalCreated && receipt.reversalId
      ? [
          {
            id: receipt.reversalId,
            key: `scheduled_reversal:${receipt.id}:${input.reversingOn}`,
            date: input.reversingOn!,
            kind: "reversal",
          },
        ]
      : []),
  ];
  await Promise.all(
    postedEntries.flatMap((entry) => [
      recordEvent({
        orgId: context.orgId,
        actorId: context.userId,
        eventType: "books.journal_posted",
        entityType: "journal_entry",
        entityId: entry.id,
        payload: {
          posting_key: entry.key,
          entry_kind: entry.kind,
          reversal_entry_id: receipt.reversalId,
          legacy_recovered: receipt.legacyRecovered,
        },
      }),
      recordAudit({
        orgId: context.orgId,
        actorId: context.userId,
        action: "insert",
        entityType: "journal_entry",
        entityId: entry.id,
        after: {
          posting_key: entry.key,
          entry_date: entry.date,
          entry_kind: entry.kind,
        },
        source: "books.post",
      }),
    ]),
  );
  return receipt;
}

/** Stage a hand-authored entry for a different user to review and post. */
export async function proposeAdjustingJournal(input: {
  intentId: string;
  expectedOrgId?: string;
  expectedActorId?: string;
  entryDate: string;
  memo: string;
  lines: JournalLineDraft[];
  reversingOn?: string | null;
  orgId?: string;
}) {
  const context = await requireBooksAdjust(input.orgId);
  assertJournalRequestScope(context, input);
  const intentId = z.string().uuid().parse(input.intentId).toLowerCase();
  const memo = z.string().trim().min(4).parse(input.memo);
  if (input.lines.length > 1000)
    throw new Error("A journal proposal supports at most 1000 lines");
  assertBalancedJournalDraft({
    entryDate: input.entryDate,
    entryKind: "adjusting",
    memo,
    postingKey: "validation",
    projectionVersion: 1,
    policyVersion: 1,
    lines: input.lines,
  });
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc(
    "prepare_books_journal_proposal_atomic",
    {
      p_org: context.orgId,
      p_actor: context.userId,
      p_intent: intentId,
      p_date: input.entryDate,
      p_memo: memo,
      p_reversing: input.reversingOn || null,
      p_lines: input.lines.map((line, index) => ({
        line_no: index + 1,
        account_code: line.accountCode,
        project_id: line.projectId ?? null,
        company_id: line.companyId ?? null,
        description: line.description ?? null,
        debit_cents: line.debitCents,
        credit_cents: line.creditCents,
        dimensions: line.dimensions ?? {},
      })),
    },
  );
  if (error)
    throw new Error(`Failed to prepare journal proposal: ${error.message}`);
  const receipt = z
    .object({
      orgId: z.literal(context.orgId),
      actorId: z.literal(context.userId),
      intentId: z.literal(intentId),
      id: z.string().uuid(),
      status: z.enum(["pending", "posted", "rejected"]),
      policyVersion: z.number().int().positive(),
      created: z.boolean(),
    })
    .parse(data);
  if (receipt.created && receipt.status !== "pending")
    throw new Error("Invalid new journal preparation receipt");
  if (receipt.created)
    await recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.journal_proposed",
      entityType: "books_journal_proposal",
      entityId: receipt.id,
      payload: { entry_date: input.entryDate, memo },
      channel: "notification",
    });
  return receipt;
}

export async function listJournalProposals(
  orgId?: string,
  cursor?: JournalProposalCursor,
) {
  const context = await requireBooksAdjust(orgId);
  const service = createServiceSupabaseClient();
  const parsedCursor = cursor
    ? journalProposalCursorSchema.parse(cursor)
    : null;
  let query = service
    .from("books_journal_proposals")
    .select(
      "id,entry_date,memo,reversing_on,policy_version,status,proposed_by,proposed_at,lines,proposer:app_users!books_journal_proposals_proposed_by_fkey(full_name,email)",
    )
    .eq("org_id", context.orgId)
    .eq("status", "pending")
    .order("proposed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(26);
  if (parsedCursor)
    query = query.or(
      `proposed_at.lt.${parsedCursor.proposedAt},and(proposed_at.eq.${parsedCursor.proposedAt},id.lt.${parsedCursor.id})`,
    );
  const { data, error } = await query;
  if (error)
    throw new Error(`Failed to load journal proposals: ${error.message}`);
  const rows = z.array(pendingJournalProposalSchema).parse(data ?? []);
  const proposals = rows.slice(0, 25);
  const accountIds = [
    ...new Set(proposals.flatMap((p) => p.lines.map((l) => l.account_id))),
  ];
  const projectIds = [
    ...new Set(
      proposals.flatMap((p) =>
        p.lines.flatMap((l) => (l.project_id ? [l.project_id] : [])),
      ),
    ),
  ];
  const companyIds = [
    ...new Set(
      proposals.flatMap((p) =>
        p.lines.flatMap((l) => (l.company_id ? [l.company_id] : [])),
      ),
    ),
  ];
  const [accounts, projects, companies] = await Promise.all([
    accountIds.length
      ? service
          .from("gl_accounts")
          .select("id,code,name,active")
          .eq("org_id", context.orgId)
          .in("id", accountIds)
      : { data: [], error: null },
    projectIds.length
      ? service
          .from("projects")
          .select("id,name")
          .eq("org_id", context.orgId)
          .in("id", projectIds)
      : { data: [], error: null },
    companyIds.length
      ? service
          .from("companies")
          .select("id,name")
          .eq("org_id", context.orgId)
          .in("id", companyIds)
      : { data: [], error: null },
  ]);
  for (const result of [accounts, projects, companies])
    if (result.error)
      throw new Error(
        "Failed to load journal review account or workflow labels",
      );
  const last = proposals.at(-1);
  return {
    proposals,
    orgId: context.orgId,
    currentUserId: context.userId,
    accounts: accounts.data ?? [],
    projects: projects.data ?? [],
    companies: companies.data ?? [],
    nextCursor:
      rows.length > 25 && last
        ? { proposedAt: last.proposed_at, id: last.id }
        : null,
  };
}

export async function reviewJournalProposal(
  input: {
    proposalId: string;
    decision: "approve" | "reject";
    note?: string;
    expectedOrgId?: string;
    expectedActorId?: string;
  },
  orgId?: string,
) {
  const context = await requireBooksAdjust(orgId);
  assertJournalRequestScope(context, input);
  const service = createServiceSupabaseClient();
  const parsed = z
    .object({
      proposalId: z.string().uuid(),
      decision: z.enum(["approve", "reject"]),
      note: z.string().trim().max(1000).optional(),
    })
    .parse(input);
  const { data, error } = await service.rpc(
    "review_books_journal_proposal_atomic",
    {
      p_org_id: context.orgId,
      p_proposal_id: parsed.proposalId,
      p_reviewer_id: context.userId,
      p_decision: parsed.decision,
      p_note: parsed.note ?? "",
    },
  );
  if (error)
    throw new Error(`Failed to review journal proposal: ${error.message}`);
  const receipt = z
    .object({
      orgId: z.literal(context.orgId),
      proposalId: z.literal(parsed.proposalId),
      reviewerId: z.literal(context.userId),
      status: z.literal(parsed.decision === "approve" ? "posted" : "rejected"),
      journal_entry_id: z.string().uuid().nullable(),
      reversal_entry_id: z.string().uuid().nullable(),
      created: z.boolean(),
    })
    .parse(data);
  if (
    (receipt.status === "posted" && !receipt.journal_entry_id) ||
    (receipt.status === "rejected" &&
      (receipt.journal_entry_id || receipt.reversal_entry_id)) ||
    (receipt.reversal_entry_id &&
      receipt.reversal_entry_id === receipt.journal_entry_id)
  ) {
    throw new Error("Invalid journal proposal review receipt");
  }
  if (receipt.created)
    await recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: `books.journal_${parsed.decision === "approve" ? "approved" : "rejected"}`,
      entityType: "books_journal_proposal",
      entityId: parsed.proposalId,
      payload: { note: parsed.note ?? null },
      channel: "notification",
    });
  return receipt;
}

export async function resolveJournalRecovery(
  input: { resolutionId: string; reason: string; record: unknown },
  orgId?: string,
) {
  const context = await requireBooksAdjust(orgId);
  const parsed = z
    .object({
      resolutionId: z
        .string()
        .uuid()
        .transform((v) => v.toLowerCase()),
      reason: z.string().trim().min(4).max(1000),
      record: journalRecoverySchema,
    })
    .parse(input);
  assertJournalRequestScope(context, parsed.record.request);
  if (
    parsed.record.resolution &&
    (parsed.record.resolution.id !== parsed.resolutionId ||
      parsed.record.resolution.reason !== parsed.reason)
  )
    throw new Error(
      "Saved resolution decision differs from the requested acknowledgement",
    );
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc(
    "resolve_books_journal_request_atomic",
    {
      p_org: context.orgId,
      p_actor: context.userId,
      p_id: parsed.resolutionId,
      p_kind: parsed.record.kind,
      p_request: parsed.record.request,
      p_reason: parsed.reason,
    },
  );
  if (error)
    throw new Error(`Failed to resolve journal recovery: ${error.message}`);
  const receipt = z
    .object({
      orgId: z.literal(context.orgId),
      actorId: z.literal(context.userId),
      id: z.literal(parsed.resolutionId),
      kind: z.literal(parsed.record.kind),
      requestText: z.string(),
      requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
      resolution: z.enum([
        "cancelled_preparation",
        "cancelled_review",
        "acknowledged_original_review",
        "acknowledged_superseded_review",
      ]),
      observedProposalId: z.string().uuid().nullable(),
      observedReview: z
        .object({
          status: z.enum(["posted", "rejected"]),
          reviewedBy: z.string().uuid(),
          reviewedAt: z.string().min(1),
          note: z.string().nullable(),
          journalEntryId: z.string().uuid().nullable(),
          reversalEntryId: z.string().uuid().nullable(),
        })
        .strict()
        .nullable(),
      created: z.boolean(),
    })
    .parse(data);
  if (
    createHash("sha256").update(receipt.requestText, "utf8").digest("hex") !==
      receipt.requestSha256 ||
    booksDigest(JSON.parse(receipt.requestText)) !==
      booksDigest(parsed.record.request) ||
    (parsed.record.kind === "prepare") !==
      (receipt.resolution === "cancelled_preparation")
  )
    throw new Error(
      "Journal resolution receipt differs from the original request",
    );
  const acknowledged = receipt.resolution.startsWith("acknowledged_");
  if (
    acknowledged !== (receipt.observedReview !== null) ||
    (acknowledged &&
      receipt.observedProposalId !==
        (parsed.record.kind === "review"
          ? parsed.record.request.proposalId
          : null)) ||
    (receipt.resolution === "cancelled_preparation" &&
      receipt.observedProposalId !== null)
  )
    throw new Error(
      "Journal resolution receipt has inconsistent observed review evidence",
    );
  return receipt;
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

export async function processRecurringPostings(
  asOf = new Date().toISOString().slice(0, 10),
) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("recurring_posting_templates")
    .select("id,org_id,name")
    .eq("status", "active")
    .lte("next_run_on", asOf)
    .order("next_run_on")
    .order("id")
    .limit(250);
  if (error)
    throw new Error(`Failed to load recurring postings: ${error.message}`);
  let posted = 0;
  let awaitingApproval = 0;
  for (const template of data ?? []) {
    const { data: occurrence, error: occurrenceError } = await service.rpc(
      "generate_books_recurring_occurrence",
      {
        p_org_id: template.org_id,
        p_template_id: template.id,
        p_as_of: asOf,
      },
    );
    if (occurrenceError)
      throw new Error(
        `Failed to generate ${template.name}: ${occurrenceError.message}`,
      );
    const result = z
      .object({
        status: z.enum([
          "not_due",
          "completed",
          "disabled",
          "posted",
          "awaiting_approval",
        ]),
        id: z.string().uuid().optional(),
        due_on: z.string().optional(),
      })
      .parse(occurrence);
    if (result.status === "posted") posted += 1;
    if (result.status === "awaiting_approval") {
      awaitingApproval += 1;
      await recordEvent({
        orgId: template.org_id,
        eventType: "books.journal_proposed",
        entityType: "books_journal_proposal",
        entityId: result.id,
        payload: {
          recurring_template_id: template.id,
          name: template.name,
          due_on: result.due_on,
        },
        channel: "notification",
      });
    }
  }
  return { attempted: data?.length ?? 0, posted, awaitingApproval };
}

export type RecurringPostingTemplate = Awaited<
  ReturnType<typeof listRecurringPostingTemplates>
>[number];
