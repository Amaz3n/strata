import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { recordAudit } from "@/lib/services/audit";
import { CONSTRUCTION_CHART_TEMPLATE } from "@/lib/services/books/chart-of-accounts";
import { booksDigest } from "@/lib/services/books/hash";
import {
  assertBalancedJournalDraft,
  type JournalEntryDraft,
} from "@/lib/services/books/types";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";

const idRowSchema = z.object({ id: z.string().uuid() });
const accountRowSchema = z.object({ id: z.string().uuid(), code: z.string() });
const journalRowSchema = z.object({
  id: z.string().uuid(),
  entry_date: z.string(),
  entry_kind: z.enum([
    "operational",
    "adjusting",
    "opening",
    "poc",
    "closing",
    "reversal",
  ]),
  memo: z.string(),
  posting_key: z.string(),
  projection_version: z.number().int(),
  policy_version: z.number().int(),
  status: z.enum(["draft", "posted", "reversed"]),
});
const journalLineRowSchema = z.object({
  line_no: z.number().int(),
  debit_cents: z.number().int(),
  credit_cents: z.number().int(),
  description: z.string().nullable(),
  project_id: z.string().uuid().nullable(),
  company_id: z.string().uuid().nullable(),
  dimensions: z.record(z.unknown()),
  account: z.union([accountRowSchema, z.array(accountRowSchema)]),
});

async function requireBooksPermission(permission: string, orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function initializeArcBooks(orgId?: string) {
  const context = await requireBooksPermission("books.manage", orgId);
  const service = createServiceSupabaseClient();

  const settingsResult = await service.from("books_settings").upsert(
    {
      org_id: context.orgId,
      workspace_enabled: true,
      ledger_authority: "external",
      arc_ledger_mode: "shadow",
      external_sync_posture: "normal",
      functional_currency: "usd",
      reporting_basis: "accrual",
      active_policy_version: 1,
      created_by: context.userId,
      updated_by: context.userId,
    },
    { onConflict: "org_id", ignoreDuplicates: true },
  );
  if (settingsResult.error)
    throw new Error(
      `Failed to initialize Books settings: ${settingsResult.error.message}`,
    );

  const chartResult = await service.from("gl_accounts").upsert(
    CONSTRUCTION_CHART_TEMPLATE.map((account) => ({
      org_id: context.orgId,
      code: account.code,
      name: account.name,
      account_type: account.accountType,
      subtype: account.subtype,
      normal_balance: account.normalBalance,
      cash_flow_category: account.cashFlowCategory ?? null,
      is_system: account.system,
      active: true,
      created_by: context.userId,
      updated_by: context.userId,
    })),
    { onConflict: "org_id,code", ignoreDuplicates: true },
  );
  if (chartResult.error)
    throw new Error(
      `Failed to initialize the Books chart: ${chartResult.error.message}`,
    );

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.initialized",
      entityType: "books_settings",
      entityId: context.orgId,
      payload: {
        mode: "shadow",
        account_count: CONSTRUCTION_CHART_TEMPLATE.length,
      },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "books_settings",
      entityId: context.orgId,
      after: { mode: "shadow", ledger_authority: "external" },
      source: "books.initialize",
    }),
  ]);
}

async function resolveAccountIds(orgId: string, accountCodes: string[]) {
  const service = createServiceSupabaseClient();
  const uniqueCodes = Array.from(new Set(accountCodes));
  const { data, error } = await service
    .from("gl_accounts")
    .select("id, code")
    .eq("org_id", orgId)
    .eq("active", true)
    .in("code", uniqueCodes);
  if (error) throw new Error(`Failed to resolve GL accounts: ${error.message}`);
  const rows = z.array(accountRowSchema).parse(data ?? []);
  const byCode = new Map(rows.map((row) => [row.code, row.id]));
  const missing = uniqueCodes.filter((code) => !byCode.has(code));
  if (missing.length > 0)
    throw new Error(`Missing active GL accounts: ${missing.join(", ")}`);
  return byCode;
}

async function findJournalByPostingKey(orgId: string, postingKey: string) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("journal_entries")
    .select("id")
    .eq("org_id", orgId)
    .eq("posting_key", postingKey)
    .maybeSingle();
  if (error)
    throw new Error(`Failed to resolve journal entry: ${error.message}`);
  return data ? idRowSchema.parse(data).id : null;
}

async function postBooksJournalEntryInternal(input: {
  draft: JournalEntryDraft;
  orgId: string;
  actorId?: string | null;
  factId?: string;
}) {
  const { draft, orgId, actorId = null, factId } = input;
  assertBalancedJournalDraft(draft);
  const existingId = await findJournalByPostingKey(orgId, draft.postingKey);
  if (existingId) return { id: existingId, created: false };

  const accountIds = await resolveAccountIds(
    orgId,
    draft.lines.map((item) => item.accountCode),
  );
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc("post_books_journal_entry", {
    p_org_id: orgId,
    p_entry: {
      fact_id: factId ?? null,
      entry_date: draft.entryDate,
      entry_kind: draft.entryKind,
      memo: draft.memo,
      posting_key: draft.postingKey,
      projection_version: draft.projectionVersion,
      policy_version: draft.policyVersion,
      source_type: draft.sourceType ?? null,
      source_id: draft.sourceId ?? null,
      reversal_of_entry_id: draft.reversalOfEntryId ?? null,
      created_by: actorId,
    },
    p_lines: draft.lines.map((item, index) => ({
      line_no: index + 1,
      account_id: accountIds.get(item.accountCode),
      project_id: item.projectId ?? null,
      company_id: item.companyId ?? null,
      description: item.description ?? null,
      debit_cents: item.debitCents,
      credit_cents: item.creditCents,
      dimensions: item.dimensions ?? {},
    })),
  });
  if (error) {
    const racedId = await findJournalByPostingKey(orgId, draft.postingKey);
    if (racedId) return { id: racedId, created: false };
    throw new Error(`Failed to post journal entry: ${error.message}`);
  }
  const entryId = z.string().uuid().parse(data);
  await Promise.all([
    recordEvent({
      orgId,
      actorId,
      eventType: "books.journal_posted",
      entityType: "journal_entry",
      entityId: entryId,
      payload: { posting_key: draft.postingKey, entry_kind: draft.entryKind },
    }),
    recordAudit({
      orgId,
      actorId: actorId ?? undefined,
      action: "insert",
      entityType: "journal_entry",
      entityId: entryId,
      after: {
        posting_key: draft.postingKey,
        entry_date: draft.entryDate,
        entry_kind: draft.entryKind,
      },
      source: "books.post",
    }),
  ]);
  return { id: entryId, created: true };
}

export async function postBooksJournalEntry(
  draft: JournalEntryDraft,
  options: {
    factId?: string;
    permission?: "books.manage" | "books.adjust";
    orgId?: string;
  } = {},
) {
  const context = await requireBooksPermission(
    options.permission ?? "books.manage",
    options.orgId,
  );
  return postBooksJournalEntryInternal({
    draft,
    orgId: context.orgId,
    actorId: context.userId,
    factId: options.factId,
  });
}

/** Service-job boundary. Callers must already have selected an organization-scoped fact. */
export async function postBooksJournalEntryForService(
  draft: JournalEntryDraft,
  orgId: string,
  factId?: string,
) {
  return postBooksJournalEntryInternal({ draft, orgId, factId });
}

const atomicProjectionResultSchema = z.object({
  fact_id: z.string().uuid(),
  journal_id: z.string().uuid(),
  created: z.boolean(),
  journal_created: z.boolean(),
  superseded: z.boolean(),
  source_version: z.number().int().positive(),
});

/**
 * Service-job boundary for one complete projection transition. The database RPC
 * commits the prior reversal, immutable fact and replacement journal together.
 */
export async function projectBooksFactAndJournalForService(input: {
  orgId: string;
  expectedFactId: string | null;
  fact: {
    sourceType: string;
    sourceId: string;
    sourceVersion: number;
    factKind: string;
    occurredAt: string;
    accountingDate: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    policyVersion: number;
    idempotencyKey: string;
  };
  draft: JournalEntryDraft;
  reversalReason: string;
}) {
  assertBalancedJournalDraft(input.draft);
  const accountIds = await resolveAccountIds(
    input.orgId,
    input.draft.lines.map((line) => line.accountCode),
  );
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc(
    "project_books_fact_and_journal_atomic",
    {
      p_org_id: input.orgId,
      p_expected_fact_id: input.expectedFactId,
      p_fact: {
        source_type: input.fact.sourceType,
        source_id: input.fact.sourceId,
        source_version: input.fact.sourceVersion,
        fact_kind: input.fact.factKind,
        occurred_at: input.fact.occurredAt,
        accounting_date: input.fact.accountingDate,
        payload: input.fact.payload,
        payload_hash: input.fact.payloadHash,
        policy_version: input.fact.policyVersion,
        idempotency_key: input.fact.idempotencyKey,
        created_by: null,
      },
      p_entry: {
        fact_id: null,
        entry_date: input.draft.entryDate,
        entry_kind: input.draft.entryKind,
        memo: input.draft.memo,
        posting_key: input.draft.postingKey,
        projection_version: input.draft.projectionVersion,
        policy_version: input.draft.policyVersion,
        source_type: input.draft.sourceType ?? null,
        source_id: input.draft.sourceId ?? null,
        reversal_of_entry_id: input.draft.reversalOfEntryId ?? null,
        created_by: null,
      },
      p_lines: input.draft.lines.map((line, index) => ({
        line_no: index + 1,
        account_id: accountIds.get(line.accountCode),
        project_id: line.projectId ?? null,
        company_id: line.companyId ?? null,
        description: line.description ?? null,
        debit_cents: line.debitCents,
        credit_cents: line.creditCents,
        dimensions: line.dimensions ?? {},
      })),
      p_reversal_date: input.fact.accountingDate,
      p_reversal_reason: input.reversalReason,
    },
  );
  if (error)
    throw new Error(`Failed to project accounting source atomically: ${error.message}`);
  const result = atomicProjectionResultSchema.parse(data);
  const effects: Promise<unknown>[] = [];
  if (result.journal_created) {
    effects.push(
      recordEvent({
        orgId: input.orgId,
        eventType: "books.journal_posted",
        entityType: "journal_entry",
        entityId: result.journal_id,
        payload: {
          posting_key: input.draft.postingKey,
          entry_kind: input.draft.entryKind,
          atomic_projection: true,
        },
      }),
      recordAudit({
        orgId: input.orgId,
        action: "insert",
        entityType: "journal_entry",
        entityId: result.journal_id,
        after: {
          posting_key: input.draft.postingKey,
          entry_date: input.draft.entryDate,
          entry_kind: input.draft.entryKind,
          atomic_projection: true,
        },
        source: "books.projector",
      }),
    );
  }
  if (result.superseded) {
    effects.push(
      recordEvent({
        orgId: input.orgId,
        eventType: "books.projection_source_revised",
        entityType: input.fact.sourceType,
        entityId: input.fact.sourceId,
        payload: {
          prior_fact_id: input.expectedFactId,
          new_fact_id: result.fact_id,
          new_version: result.source_version,
        },
      }),
    );
  }
  await Promise.all(effects);
  return {
    factId: result.fact_id,
    journalId: result.journal_id,
    sourceVersion: result.source_version,
    created: result.created,
    journalCreated: result.journal_created,
    superseded: result.superseded,
  };
}

export async function reverseBooksJournalEntry(input: {
  entryId: string;
  reversalDate: string;
  reason: string;
  orgId?: string;
}) {
  const context = await requireBooksPermission("books.adjust", input.orgId);
  return reverseJournalEntryInternal({
    entryId: input.entryId,
    reversalDate: input.reversalDate,
    reason: input.reason,
    orgId: context.orgId,
  });
}

/**
 * Service-job boundary. The projector uses this to reverse the entry behind a
 * superseded fact so a genuine economic revision repairs itself instead of
 * failing on every pass.
 */
export async function reverseBooksJournalEntryForService(input: {
  entryId: string;
  reversalDate: string;
  reason: string;
  orgId: string;
}) {
  return reverseJournalEntryInternal(input);
}

async function reverseJournalEntryInternal(input: {
  entryId: string;
  reversalDate: string;
  reason: string;
  orgId: string;
}) {
  const context = { orgId: input.orgId };
  const service = createServiceSupabaseClient();
  const [entryResult, linesResult] = await Promise.all([
    service
      .from("journal_entries")
      .select(
        "id, entry_date, entry_kind, memo, posting_key, projection_version, policy_version, status, source_type",
      )
      .eq("org_id", context.orgId)
      .eq("id", input.entryId)
      .single(),
    service
      .from("journal_lines")
      .select(
        "line_no, debit_cents, credit_cents, description, project_id, company_id, dimensions, account:gl_accounts!inner(id, code)",
      )
      .eq("org_id", context.orgId)
      .eq("entry_id", input.entryId)
      .order("line_no"),
  ]);
  if (entryResult.error)
    throw new Error(
      `Failed to load journal entry: ${entryResult.error.message}`,
    );
  if (linesResult.error)
    throw new Error(
      `Failed to load journal lines: ${linesResult.error.message}`,
    );
  const entry = journalRowSchema.parse(entryResult.data);
  if (entry.entry_kind === "opening" || ["land_acquisition", "inventory_start", "inventory_development_allocation", "inventory_interest", "inventory_completion", "inventory_sale_relief", "warranty_reserve", "warranty_reserve_consumption", "warranty_reserve_recovery"].includes(entryResult.data.source_type ?? "")) throw new Error("This journal belongs to an operational register. It cannot be reversed on its own; the operational record and ledger must be corrected together.");
  if (entry.status === "draft")
    throw new Error("Only a posted journal entry can be reversed");
  const lines = z.array(journalLineRowSchema).parse(linesResult.data ?? []);

  const draft: JournalEntryDraft = {
    entryDate: input.reversalDate,
    entryKind: "reversal",
    memo: `Reversal of ${entry.memo}: ${input.reason}`,
    postingKey: `reversal:${entry.id}:${booksDigest({ date: input.reversalDate, reason: input.reason }).slice(0, 20)}`,
    projectionVersion: entry.projection_version,
    policyVersion: entry.policy_version,
    reversalOfEntryId: entry.id,
    lines: lines.map((item) => {
      const account = Array.isArray(item.account)
        ? item.account[0]
        : item.account;
      if (!account) throw new Error("Journal line is missing its account");
      return {
        accountCode: account.code,
        debitCents: item.credit_cents,
        creditCents: item.debit_cents,
        projectId: item.project_id ?? undefined,
        companyId: item.company_id ?? undefined,
        description: item.description ?? undefined,
        dimensions: item.dimensions,
      };
    }),
  };
  const accountIds = await resolveAccountIds(
    context.orgId,
    draft.lines.map((item) => item.accountCode),
  );
  const { data, error } = await service.rpc("reverse_books_journal_entry", {
    p_org_id: context.orgId,
    p_original_entry_id: entry.id,
    p_entry: {
      fact_id: null,
      entry_date: draft.entryDate,
      entry_kind: draft.entryKind,
      memo: draft.memo,
      posting_key: draft.postingKey,
      projection_version: draft.projectionVersion,
      policy_version: draft.policyVersion,
      source_type: null,
      source_id: null,
      reversal_of_entry_id: entry.id,
      created_by: null,
    },
    p_lines: draft.lines.map((item, index) => ({
      line_no: index + 1,
      account_id: accountIds.get(item.accountCode),
      project_id: item.projectId ?? null,
      company_id: item.companyId ?? null,
      description: item.description ?? null,
      debit_cents: item.debitCents,
      credit_cents: item.creditCents,
      dimensions: item.dimensions ?? {},
    })),
  });
  if (error)
    throw new Error(`Failed to reverse journal entry: ${error.message}`);
  const result = z
    .object({ id: z.string().uuid(), created: z.boolean() })
    .parse(data);
  if (result.created) {
    await Promise.all([
      recordEvent({
        orgId: context.orgId,
        eventType: "books.journal_reversed",
        entityType: "journal_entry",
        entityId: entry.id,
        payload: {
          reversal_entry_id: result.id,
          reversal_date: input.reversalDate,
          reason: input.reason,
        },
      }),
      recordAudit({
        orgId: context.orgId,
        action: "update",
        entityType: "journal_entry",
        entityId: entry.id,
        before: { status: "posted" },
        after: { status: "reversed", reversal_entry_id: result.id },
        source: "books.reverse",
      }),
    ]);
  }
  return result;
}
