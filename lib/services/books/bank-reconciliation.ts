import "server-only";

import { z } from "zod";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
import { booksDigest } from "@/lib/services/books/hash";
import { requireOrgContext } from "@/lib/services/context";
import {
  MATCH_WINDOW_DAYS,
  rankBankMatches,
  type BankMatchSuggestion,
} from "@/lib/services/books/bank-match-rules";
import { selectBankRule } from "@/lib/services/books/bank-rule-matching";
import { loadBankRuleCandidates } from "@/lib/services/books/bank-rules-data";
import { recordEvent } from "@/lib/services/events";

async function requireReconciliationContext(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "bank_reconciliation",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function createBankReconciliation(input: {
  bankAccountId: string;
  statementStart: string;
  statementEnd: string;
  beginningBalanceCents: number;
  endingBalanceCents: number;
  statementFileId?: string | null;
  orgId?: string;
}) {
  const context = await requireReconciliationContext(input.orgId);
  const service = createServiceSupabaseClient();
  const { data: account, error: accountError } = await service
    .from("bank_accounts")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", input.bankAccountId)
    .single();
  if (accountError || !account) throw new Error("Bank account not found");
  const { data, error } = await service
    .from("bank_reconciliations")
    .insert({
      org_id: context.orgId,
      bank_account_id: input.bankAccountId,
      statement_start: input.statementStart,
      statement_end: input.statementEnd,
      beginning_balance_cents: input.beginningBalanceCents,
      ending_balance_cents: input.endingBalanceCents,
      cleared_balance_cents: input.beginningBalanceCents,
      difference_cents: input.endingBalanceCents - input.beginningBalanceCents,
      status: "draft",
      statement_file_id: input.statementFileId ?? null,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to create bank reconciliation: ${error.message}`);
  return z.object({ id: z.string().uuid() }).parse(data).id;
}

export type BankReconciliationDetail = {
  id: string;
  bankAccountId: string;
  statementStart: string;
  statementEnd: string;
  beginningBalanceCents: number;
  endingBalanceCents: number;
  clearedBalanceCents: number;
  differenceCents: number;
  status: string;
  truncated: boolean;
  items: Array<{
    transactionId: string;
    transactionDate: string;
    description: string;
    counterparty: string | null;
    direction: "inflow" | "outflow";
    amountCents: number;
    matchedCents: number;
    status: "cleared" | "excluded" | "outstanding";
  }>;
};

/** The item-level statement proof shown before a reconciliation can close. */
export async function getBankReconciliationDetail(
  reconciliationId: string,
  orgId?: string,
): Promise<BankReconciliationDetail> {
  const context = await requireReconciliationContext(orgId);
  const service = createServiceSupabaseClient();
  const { data: reconciliation, error: reconciliationError } = await service
    .from("bank_reconciliations")
    .select("id, bank_account_id, statement_start, statement_end, beginning_balance_cents, ending_balance_cents, cleared_balance_cents, difference_cents, status")
    .eq("org_id", context.orgId)
    .eq("id", reconciliationId)
    .single();
  if (reconciliationError || !reconciliation)
    throw new Error("Bank reconciliation not found");

  const { data, error } = await service
    .from("bank_transactions")
    .select("id, transaction_date, description, merchant_name, direction, amount_cents, excluded, matches:bank_transaction_matches(matched_amount_cents,status)")
    .eq("org_id", context.orgId)
    .eq("bank_account_id", reconciliation.bank_account_id)
    .eq("lifecycle_status", "posted")
    .gte("transaction_date", reconciliation.statement_start)
    .lte("transaction_date", reconciliation.statement_end)
    .order("transaction_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(5001);
  if (error) throw new Error(`Failed to load statement transactions: ${error.message}`);

  const rows = (data ?? []).slice(0, 5000).map((transaction) => {
    const confirmed = (transaction.matches ?? []).filter((match) => match.status === "confirmed");
    const matchedCents = confirmed.reduce((sum, match) => sum + Number(match.matched_amount_cents ?? 0), 0);
    const status = transaction.excluded
      ? "excluded" as const
      : matchedCents === Number(transaction.amount_cents)
        ? "cleared" as const
        : "outstanding" as const;
    return {
      transactionId: transaction.id,
      transactionDate: transaction.transaction_date,
      description: transaction.description,
      counterparty: transaction.merchant_name ?? null,
      direction: transaction.direction as "inflow" | "outflow",
      amountCents: Number(transaction.amount_cents),
      matchedCents,
      status,
    };
  });
  const clearedBalanceCents = rows.reduce(
    (balance, row) => row.status !== "cleared"
      ? balance
      : balance + (row.direction === "inflow" ? row.amountCents : -row.amountCents),
    Number(reconciliation.beginning_balance_cents),
  );

  return {
    id: reconciliation.id,
    bankAccountId: reconciliation.bank_account_id,
    statementStart: reconciliation.statement_start,
    statementEnd: reconciliation.statement_end,
    beginningBalanceCents: Number(reconciliation.beginning_balance_cents),
    endingBalanceCents: Number(reconciliation.ending_balance_cents),
    clearedBalanceCents,
    differenceCents: Number(reconciliation.ending_balance_cents) - clearedBalanceCents,
    status: reconciliation.status,
    truncated: (data ?? []).length > 5000,
    items: rows,
  };
}

const REVIEW_TRAY_CAP = 100;
const REVIEW_TRAY_SCAN_CAP = 5_000;
const REVIEW_TRAY_PAGE_SIZE = 250;

function shiftDays(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Alternatives beyond this are noise — if the top few are all wrong, matching by hand is faster. */
const ALTERNATIVES_SHOWN = 4;

export type {
  BankMatchCandidate,
  BankMatchSuggestion,
} from "@/lib/services/books/bank-match-rules";

export type BankReviewRow = {
  transactionId: string;
  bankAccountId: string;
  bankAccountName: string;
  transactionDate: string;
  amountCents: number;
  direction: "inflow" | "outflow";
  counterparty: string;
  best: BankMatchSuggestion | null;
  /** Runners-up, so choosing a different line does not need a second round trip. */
  alternatives: BankMatchSuggestion[];
  accountUnmapped: boolean;
  /**
   * What a learned rule would categorize this as, when nothing in the ledger
   * matches. Matching an existing entry always wins — a rule only answers the
   * question "this spend was never in Arc, where does it go?".
   */
  ruleSuggestion: {
    glAccountId: string;
    accountCode: string;
    accountName: string;
    ruleId: string;
    confidence: number;
    autoApplies: boolean;
  } | null;
};

/**
 * Everything still needing a decision, with its suggested match already scored.
 *
 * One pass, not one query per row: a tray of fifty transactions would otherwise
 * be fifty round trips, and the point of a tray is to see at a glance how much of
 * the work is a single click. Runners-up ride along so picking a different line
 * does not need a second call either.
 *
 * Accounts with no GL mapping are reported separately rather than silently
 * contributing rows that can never match. That was the old defect: the
 * single-match path returned an empty list for an unmapped account, so a
 * misconfigured account was indistinguishable from one with nothing to match, and
 * the user was told "no posted ledger line matches" when nothing had been queried.
 */
export async function reviewUnmatchedBankTransactions(
  input: {
    bankAccountId?: string | null;
    orgId?: string;
  } = {},
) {
  const context = await requireReconciliationContext(input.orgId);
  const service = createServiceSupabaseClient();

  let accountQuery = service
    .from("bank_accounts")
    .select("id, name, gl_account_id")
    .eq("org_id", context.orgId);
  if (input.bankAccountId)
    accountQuery = accountQuery.eq("id", input.bankAccountId);
  const { data: accountData, error: accountError } = await accountQuery;
  if (accountError)
    throw new Error(`Failed to load bank accounts: ${accountError.message}`);
  const accounts = z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        gl_account_id: z.string().uuid().nullable(),
      }),
    )
    .parse(accountData ?? []);
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const transactionSchema = z.object({
    id: z.string().uuid(),
    bank_account_id: z.string().uuid(),
    transaction_date: z.string(),
    amount_cents: z.number().int(),
    direction: z.enum(["inflow", "outflow"]),
    merchant_name: z.string().nullable(),
    description: z.string(),
    matches: z.array(
      z.object({
        matched_amount_cents: z.number().int().nullable(),
        status: z.string(),
      }),
    ),
  });
  const transactions: Array<z.infer<typeof transactionSchema>> = [];
  let scanned = 0;
  let sourceExhausted = false;
  while (
    transactions.length <= REVIEW_TRAY_CAP &&
    scanned < REVIEW_TRAY_SCAN_CAP &&
    !sourceExhausted
  ) {
    let transactionQuery = service
      .from("bank_transactions")
      .select(
        "id, bank_account_id, transaction_date, amount_cents, direction, merchant_name, description, " +
          "matches:bank_transaction_matches(matched_amount_cents, status)",
      )
      .eq("org_id", context.orgId)
      .eq("lifecycle_status", "posted")
      .eq("excluded", false)
      .order("transaction_date", { ascending: false })
      .order("id", { ascending: false })
      .range(scanned, scanned + REVIEW_TRAY_PAGE_SIZE - 1);
    if (input.bankAccountId)
      transactionQuery = transactionQuery.eq(
        "bank_account_id",
        input.bankAccountId,
      );
    const { data: transactionData, error: transactionError } =
      await transactionQuery;
    if (transactionError)
      throw new Error(
        `Failed to load bank transactions: ${transactionError.message}`,
      );
    const batch = z.array(transactionSchema).parse(transactionData ?? []);
    sourceExhausted = batch.length < REVIEW_TRAY_PAGE_SIZE;
    scanned += batch.length;
    transactions.push(
      ...batch.filter((transaction) => {
        const matched = transaction.matches
          .filter((match) => match.status === "confirmed")
          .reduce(
            (sum, match) => sum + Number(match.matched_amount_cents ?? 0),
            0,
          );
        return matched < transaction.amount_cents;
      }),
    );
  }

  const truncated =
    transactions.length > REVIEW_TRAY_CAP ||
    (!sourceExhausted && scanned >= REVIEW_TRAY_SCAN_CAP);
  const page = truncated
    ? transactions.slice(0, REVIEW_TRAY_CAP)
    : transactions;

  const mappedGlAccountIds = Array.from(
    new Set(
      page
        .map(
          (transaction) =>
            accountById.get(transaction.bank_account_id)?.gl_account_id,
        )
        .filter((id): id is string => Boolean(id)),
    ),
  );

  // One query for every candidate line across the whole tray's date span.
  const candidateSchema = z.object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    debit_cents: z.number().int(),
    credit_cents: z.number().int(),
    description: z.string().nullable(),
    entry: z.union([
      z.object({ entry_date: z.string(), status: z.string() }),
      z.array(z.object({ entry_date: z.string(), status: z.string() })),
    ]),
  });
  const dates = page.map((transaction) => transaction.transaction_date).sort();
  const candidates =
    mappedGlAccountIds.length > 0 && dates.length > 0
      ? z.array(candidateSchema).parse(
          (
            await service
              .from("journal_lines")
              .select(
                "id, account_id, debit_cents, credit_cents, description, entry:journal_entries!inner(entry_date, status)",
              )
              .eq("org_id", context.orgId)
              .in("account_id", mappedGlAccountIds)
              .eq("entry.status", "posted")
              .gte("entry.entry_date", shiftDays(dates[0], -MATCH_WINDOW_DAYS))
              .lte(
                "entry.entry_date",
                shiftDays(dates[dates.length - 1], MATCH_WINDOW_DAYS),
              )
              .limit(2000)
          ).data ?? [],
        )
      : [];

  // Learned rules, plus the chart, so a row with no ledger match can still say
  // where it probably belongs.
  const [ruleCandidates, glAccountRows] = await Promise.all([
    loadBankRuleCandidates(context.orgId),
    service
      .from("gl_accounts")
      .select("id, code, name")
      .eq("org_id", context.orgId),
  ]);
  const glAccountById = new Map(
    z
      .array(
        z.object({ id: z.string().uuid(), code: z.string(), name: z.string() }),
      )
      .parse(glAccountRows.data ?? [])
      .map((row) => [row.id, row]),
  );

  // Already-confirmed lines must not be offered again to a second transaction.
  const { data: takenData } = await service
    .from("bank_transaction_matches")
    .select("journal_line_id")
    .eq("org_id", context.orgId)
    .eq("status", "confirmed");
  const taken = new Set(
    (takenData ?? []).map((row) => String(row.journal_line_id)),
  );

  const rows: BankReviewRow[] = page.map((transaction) => {
    const account = accountById.get(transaction.bank_account_id);
    const counterparty = transaction.merchant_name ?? transaction.description;
    const base = {
      transactionId: transaction.id,
      bankAccountId: transaction.bank_account_id,
      bankAccountName: account?.name ?? "Unknown account",
      transactionDate: transaction.transaction_date,
      amountCents: transaction.amount_cents,
      direction: transaction.direction,
      counterparty,
    };
    if (!account?.gl_account_id) {
      return {
        ...base,
        best: null,
        alternatives: [],
        accountUnmapped: true,
        ruleSuggestion: null,
      };
    }

    const scored = rankBankMatches({
      transaction: {
        id: transaction.id,
        date: transaction.transaction_date,
        amountCents: transaction.amount_cents,
        direction: transaction.direction,
        counterparty,
      },
      candidates: candidates
        .filter((candidate) => candidate.account_id === account.gl_account_id)
        .map((candidate) => {
          const entry = Array.isArray(candidate.entry)
            ? candidate.entry[0]
            : candidate.entry;
          return {
            id: candidate.id,
            debitCents: candidate.debit_cents,
            creditCents: candidate.credit_cents,
            description: candidate.description,
            entryDate: entry.entry_date,
          };
        }),
      excludeLineIds: taken,
    });

    const rule =
      scored.length > 0
        ? null
        : selectBankRule({
            transaction: {
              bankAccountId: transaction.bank_account_id,
              direction: transaction.direction,
              merchantName: transaction.merchant_name,
              description: transaction.description,
            },
            rules: ruleCandidates,
          });
    const ruleAccount = rule ? glAccountById.get(rule.glAccountId) : undefined;

    return {
      ...base,
      best: scored[0] ?? null,
      alternatives: scored.slice(1, 1 + ALTERNATIVES_SHOWN),
      accountUnmapped: false,
      ruleSuggestion:
        rule && ruleAccount
          ? {
              glAccountId: rule.glAccountId,
              accountCode: ruleAccount.code,
              accountName: ruleAccount.name,
              ruleId: rule.ruleId,
              confidence: rule.confidence,
              autoApplies: rule.autoApplies,
            }
          : null,
    };
  });

  return {
    rows,
    truncated,
    rowCap: REVIEW_TRAY_CAP,
    unmappedAccounts: accounts
      .filter((account) => !account.gl_account_id)
      .filter((account) => rows.some((row) => row.bankAccountId === account.id))
      .map((account) => ({ id: account.id, name: account.name })),
  };
}

export type BankReviewTray = Awaited<
  ReturnType<typeof reviewUnmatchedBankTransactions>
>;

export async function confirmBankMatch(input: {
  bankTransactionId: string;
  journalLineId?: string | null;
  amountCents: number;
  matchType:
    | "provider_identity"
    | "transfer"
    | "exact"
    | "suggested"
    | "manual_split"
    | "excluded";
  confidence?: number | null;
  orgId?: string;
}) {
  const context = await requireReconciliationContext(input.orgId);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error("Matched amount must be positive integer cents");
  const service = createServiceSupabaseClient();
  const { data: transaction, error: transactionError } = await service
    .from("bank_transactions")
    .select("id, amount_cents, lifecycle_status")
    .eq("org_id", context.orgId)
    .eq("id", input.bankTransactionId)
    .single();
  if (transactionError || !transaction)
    throw new Error("Bank transaction not found");
  if (transaction.lifecycle_status !== "posted")
    throw new Error("Only posted bank transactions can be confirmed");
  const { data: existingMatches, error: matchError } = await service
    .from("bank_transaction_matches")
    .select("matched_amount_cents")
    .eq("org_id", context.orgId)
    .eq("bank_transaction_id", input.bankTransactionId)
    .eq("status", "confirmed");
  if (matchError)
    throw new Error(`Failed to load bank matches: ${matchError.message}`);
  const alreadyMatched = (existingMatches ?? []).reduce(
    (sum, row) => sum + Number(row.matched_amount_cents ?? 0),
    0,
  );
  if (alreadyMatched + input.amountCents > Number(transaction.amount_cents)) {
    throw new Error("Confirmed matches exceed the bank transaction amount");
  }
  const { data, error } = await service
    .from("bank_transaction_matches")
    .insert({
      org_id: context.orgId,
      bank_transaction_id: input.bankTransactionId,
      journal_line_id: input.journalLineId ?? null,
      matched_amount_cents: input.amountCents,
      match_type: input.matchType,
      confidence: input.confidence ?? null,
      status: "confirmed",
      confirmed_by: context.userId,
      confirmed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to confirm bank match: ${error.message}`);
  return z.object({ id: z.string().uuid() }).parse(data).id;
}

export async function closeBankReconciliation(
  reconciliationId: string,
  orgId?: string,
) {
  const context = await requireReconciliationContext(orgId);
  const service = createServiceSupabaseClient();
  const { data: reconciliationData, error: reconciliationError } = await service
    .from("bank_reconciliations")
    .select(
      "id, bank_account_id, statement_start, statement_end, beginning_balance_cents, ending_balance_cents, status",
    )
    .eq("org_id", context.orgId)
    .eq("id", reconciliationId)
    .single();
  if (reconciliationError)
    throw new Error(
      `Failed to load bank reconciliation: ${reconciliationError.message}`,
    );
  const reconciliation = z
    .object({
      id: z.string().uuid(),
      bank_account_id: z.string().uuid(),
      statement_start: z.string(),
      statement_end: z.string(),
      beginning_balance_cents: z.number().int(),
      ending_balance_cents: z.number().int(),
      status: z.string(),
    })
    .parse(reconciliationData);
  if (reconciliation.status === "closed") return reconciliation.id;

  const { data: transactions, error: transactionError } = await service
    .from("bank_transactions")
    .select(
      "id, amount_cents, direction, excluded, matches:bank_transaction_matches(id, journal_line_id, matched_amount_cents, status)",
    )
    .eq("org_id", context.orgId)
    .eq("bank_account_id", reconciliation.bank_account_id)
    .eq("lifecycle_status", "posted")
    .gte("transaction_date", reconciliation.statement_start)
    .lte("transaction_date", reconciliation.statement_end)
    .limit(5000);
  if (transactionError)
    throw new Error(
      `Failed to load reconciliation transactions: ${transactionError.message}`,
    );
  const transactionSchema = z.object({
    id: z.string().uuid(),
    amount_cents: z.number().int(),
    direction: z.enum(["inflow", "outflow"]),
    excluded: z.boolean(),
    matches: z.array(
      z.object({
        id: z.string().uuid(),
        journal_line_id: z.string().uuid().nullable(),
        matched_amount_cents: z.number().int(),
        status: z.string(),
      }),
    ),
  });
  const rows = z.array(transactionSchema).parse(transactions ?? []);
  let clearedBalanceCents = reconciliation.beginning_balance_cents;
  const items: Array<Record<string, unknown>> = [];
  for (const transaction of rows) {
    const confirmed = transaction.matches.filter(
      (match) => match.status === "confirmed",
    );
    const matchedCents = confirmed.reduce(
      (sum, match) => sum + match.matched_amount_cents,
      0,
    );
    const cleared =
      transaction.excluded || matchedCents === transaction.amount_cents;
    if (cleared && !transaction.excluded) {
      clearedBalanceCents +=
        transaction.direction === "inflow"
          ? transaction.amount_cents
          : -transaction.amount_cents;
    }
    items.push({
      org_id: context.orgId,
      reconciliation_id: reconciliation.id,
      bank_transaction_id: transaction.id,
      journal_line_id:
        confirmed.length === 1 ? confirmed[0].journal_line_id : null,
      amount_cents: transaction.amount_cents,
      item_status: transaction.excluded
        ? "excluded"
        : cleared
          ? "cleared"
          : "outstanding",
    });
  }
  const differenceCents =
    reconciliation.ending_balance_cents - clearedBalanceCents;
  if (differenceCents !== 0)
    throw new Error(
      `Reconciliation difference must be zero; current difference is ${differenceCents} cents`,
    );
  if (items.length > 0) {
    const itemResult = await service
      .from("bank_reconciliation_items")
      .upsert(items, {
        onConflict: "reconciliation_id,bank_transaction_id,journal_line_id",
      });
    if (itemResult.error)
      throw new Error(
        `Failed to save reconciliation items: ${itemResult.error.message}`,
      );
  }
  const digest = booksDigest({ reconciliation, clearedBalanceCents, items });
  const closeResult = await service
    .from("bank_reconciliations")
    .update({
      cleared_balance_cents: clearedBalanceCents,
      difference_cents: 0,
      status: "closed",
      digest,
      closed_by: context.userId,
      closed_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", reconciliation.id);
  if (closeResult.error)
    throw new Error(
      `Failed to close bank reconciliation: ${closeResult.error.message}`,
    );
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "books.bank_reconciliation_closed",
    entityType: "bank_reconciliation",
    entityId: reconciliation.id,
    payload: { statement_end: reconciliation.statement_end, digest },
  });
  return reconciliation.id;
}
