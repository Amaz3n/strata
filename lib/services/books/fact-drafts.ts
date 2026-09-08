import { booksDigest as booksDigestForDimensions } from "@/lib/services/books/hash";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";
import {
  postBillPayment,
  postApFeeCharge,
  postClosingInvoice,
  postCustomerDepositApplication,
  postCustomerDepositReceipt,
  postCustomerDepositReversal,
  postCustomerInvoice,
  postExpense,
  postExpenseFromCostLines,
  postInvoicePayment,
  postLaborCost,
  postPaymentReversal,
  postReceivableAdjustment,
  postRetainageRelease,
  postVendorBillFromCostLines,
} from "@/lib/services/books/posting-rules";
import type { JournalEntryDraft } from "@/lib/services/books/types";

/**
 * The one place a stored accounting fact becomes a journal draft.
 *
 * Both the projector and the nightly rebuild drill call this. If the projector
 * built drafts inline the drill would be comparing one implementation against a
 * copy of itself, and the two would drift the first time a posting rule changed.
 */

/**
 * Economic fields are allowlisted per source.
 *
 * A denylist makes every future payload field economic by accident. That turns
 * harmless integration metadata into a reversal/repost, which is especially
 * dangerous in parallel mode where the external adapter adds fields over time.
 */
const ECONOMIC_KEYS_BY_SOURCE: Record<string, readonly string[]> = {
  vendor_bill: [
    "total_cents",
    "use_tax_accrued_cents",
    "retainage_cents",
    "project_id",
    "company_id",
    "cost_lines",
  ],
  retainage_release: ["amount_cents", "side", "project_id", "company_id"],
  invoice: ["total_cents", "tax_cents", "retainage_cents", "project_id", "revenue_basis"],
  invoice_payment: ["amount_cents", "gross_cents", "fee_cents", "project_id"],
  customer_deposit_receipt: ["amount_cents", "gross_cents", "fee_cents", "project_id"],
  customer_deposit_application: ["amount_cents", "project_id", "deposit_payment_id"],
  customer_deposit_reversal: ["amount_cents", "project_id"],
  bill_payment: ["amount_cents", "discount_cents", "project_id", "cash_account_code"],
  ap_fee_charge: ["amount_cents", "cash_account_code"],
  expense: ["amount_cents", "project_id", "vendor_company_id", "cost_lines", "payment_account_code"],
  payment_reversal: ["amount_cents", "side", "project_id", "cash_account_code"],
  receivable_adjustment: ["amount_cents", "tax_cents", "adjustment_type", "project_id", "revenue_basis"],
  labor_cost: ["amount_cents", "project_id", "cost_account_code"],
  retirement: ["retired", "retired_source_version"],
};

export function hashableFactPayload(
  sourceType: string,
  payload: Record<string, unknown>,
) {
  const keys = ECONOMIC_KEYS_BY_SOURCE[sourceType];
  if (!keys)
    throw new Error(`No economic fact allowlist exists for ${sourceType}`);
  const economic: Record<string, unknown> = {};
  for (const key of keys) if (key in payload) economic[key] = payload[key];
  if (payload.project_dimensions && typeof payload.project_dimensions === "object") economic.project_dimensions = Object.fromEntries(Object.entries(payload.project_dimensions).map(([projectId, dimensions]) => [projectId, Object.fromEntries(Object.entries(dimensions as Record<string, unknown>).filter(([key]) => !key.endsWith("_name")))]));
  if (payload.dimensions) economic.dimensions = payload.dimensions;
  return economic;
}

export type FactCostLine = {
  amount_cents: number;
  project_id: string | null;
  description?: string;
  /** Arc Books chart code selected on the payable line, when one was chosen. */
  account_code?: string;
  dimensions?: Record<string, unknown>;
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Cost lines in a stable order, independent of how the subledger paged out of
 * Postgres.
 *
 * `booksDigest` preserves array order, so the same bill read back in a different
 * row order hashes to a different payload — which the projector reads as an
 * economic revision and "repairs" by reversing a correct entry and reposting an
 * identical one, every night, forever. Sorting on the values themselves rather
 * than on a row id (which never reaches the payload) makes the hash a function
 * of the multiset of cost lines and of nothing else.
 *
 * `localeCompare` is deliberately avoided: it is locale-dependent, and a hash
 * that depends on the server's locale is not a hash.
 */
export function sortFactCostLines(lines: FactCostLine[]): FactCostLine[] {
  return [...lines].sort(
    (left, right) =>
      compareText(left.project_id ?? "", right.project_id ?? "") ||
      compareText(left.account_code ?? "", right.account_code ?? "") ||
      compareText(left.description ?? "", right.description ?? "") ||
      compareText(JSON.stringify(left.dimensions ?? {}), JSON.stringify(right.dimensions ?? {})) ||
      left.amount_cents - right.amount_cents,
  );
}

/**
 * Retirement: what the projector records when a posted source leaves the
 * projectable set — an invoice voided, a bill rejected, a row deleted upstream.
 *
 * The fact table is append-only, so retirement is a new fact that supersedes the
 * last live one and produces no journal draft; the entry it retires is reversed
 * through the ordinary reversal machinery. Marking it in `fact_kind` is what
 * makes the sweep idempotent — a source already retired is skipped on every
 * later pass instead of being reversed again — and what tells the rebuild drill
 * that "no draft" is the correct answer rather than an unsupported fact kind.
 */
export const RETIRED_FACT_KIND_SUFFIX = ".retired";

export function retiredFactKind(sourceType: string) {
  return `${sourceType}${RETIRED_FACT_KIND_SUFFIX}`;
}

export function isRetiredFactKind(factKind: string) {
  return factKind.endsWith(RETIRED_FACT_KIND_SUFFIX);
}

/**
 * The payload of a retirement fact. It must never collide with a live payload,
 * because the projector derives the fact's idempotency key from the payload hash
 * — and it must differ from every other version so a restored source supersedes
 * the retirement rather than matching it and staying un-posted.
 */
export function retirementFactPayload(
  retiredSourceVersion: number,
): Record<string, unknown> {
  return { retired: true, retired_source_version: retiredSourceVersion };
}

export function factSourceKey(sourceType: string, sourceId: string) {
  return `${sourceType}:${sourceId}`;
}

export type RetirableFact = {
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  factKind: string;
};

/**
 * Which of the latest facts no longer have a qualifying source.
 *
 * Safe only against a COMPLETE candidate set — on an incremental pass the live
 * keys are a watermarked subset and this would retire the whole ledger.
 */
export function selectFactsToRetire<T extends RetirableFact>(
  latestFactPerSource: readonly T[],
  liveSourceKeys: ReadonlySet<string>,
): T[] {
  return latestFactPerSource.filter(
    (fact) =>
      !isRetiredFactKind(fact.factKind) &&
      !liveSourceKeys.has(factSourceKey(fact.sourceType, fact.sourceId)),
  );
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function centsValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function optionalId(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function costLinesValue(
  value: unknown,
  fallbackCents: number,
  fallbackProjectId?: string,
) {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ amountCents: fallbackCents, projectId: fallbackProjectId }];
  }
  return value.map((entry) => {
    const row =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    return {
      dimensions: row.dimensions && typeof row.dimensions === "object" ? row.dimensions as Record<string, unknown> : undefined,
      amountCents: centsValue(row.amount_cents),
      accountCode:
        typeof row.account_code === "string" ? row.account_code : undefined,
      projectId: optionalId(row.project_id) ?? fallbackProjectId,
      description:
        typeof row.description === "string" ? row.description : undefined,
    };
  });
}

export type FactDraftInput = {
  sourceType: string;
  sourceId: string;
  accountingDate: string;
  payload: Record<string, unknown>;
  sourceVersion: number;
  projectionVersion: number;
  policyVersion: number;
};

function baseDraftFromFact(input: FactDraftInput): JournalEntryDraft | null {
  const row = input.payload;
  const projectId = optionalId(row.project_id);
  const common = {
    id: input.sourceId,
    date: input.accountingDate,
    sourceVersion: input.sourceVersion,
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    projectId,
  };

  if (input.sourceType === "vendor_bill") {
    const grossCents = centsValue(row.total_cents);
    return postVendorBillFromCostLines({
      ...common,
      companyId: optionalId(row.company_id),
      memo: textValue(row.memo, "Vendor bill"),
      grossCents,
      useTaxCents: centsValue(row.use_tax_accrued_cents),
      retainageCents: centsValue(row.retainage_cents),
      costLines: costLinesValue(row.cost_lines, grossCents, projectId),
    });
  }

  if (input.sourceType === "retainage_release") {
    // Releasing retainage moves an existing balance; it is not new cost or new billing.
    // Left to the ordinary bill and invoice rules, an AP release would debit job costs
    // a second time for money already expensed on the original bill, and an AR release
    // would credit contract liabilities as though it were a fresh billing.
    return postRetainageRelease({
      ...common,
      memo: textValue(row.memo, "Retainage release"),
      amountCents: centsValue(row.amount_cents),
      side: row.side === "receivable" ? "receivable" : "payable",
    });
  }

  if (input.sourceType === "invoice") {
    const netCents = centsValue(row.total_cents);
    const retainageCents = centsValue(row.retainage_cents);
    const memo = textValue(row.memo, "Invoice");
    if (row.revenue_basis === "closing") {
      // Closing-basis sales debit AR for the whole amount with no retainage split, so
      // they post the net — the amount actually receivable.
      return postClosingInvoice({ ...common, memo, grossCents: netCents, taxCents: centsValue(row.tax_cents) });
    }
    // Unlike a vendor bill, an invoice's stored total is already NET of retainage (the
    // hold is a negative invoice line). `postCustomerInvoice` splits gross into
    // AR + retainage receivable, so the gross has to be rebuilt here — passing the net
    // would subtract retainage twice and under-credit contract liability.
    return postCustomerInvoice({
      ...common,
      memo,
      grossCents: netCents + retainageCents,
      taxCents: centsValue(row.tax_cents),
      retainageCents,
    });
  }

  if (input.sourceType === "invoice_payment") {
    return postInvoicePayment({
      ...common,
      memo: textValue(row.memo, "Customer payment"),
      amountCents: centsValue(row.amount_cents),
      grossCents: centsValue(row.gross_cents) || centsValue(row.amount_cents),
      // Processor and platform fees come out of the deposit before it lands, so
      // cash is debited net and the fee expensed — the same split the vendor
      // payment already makes. The projector has always carried `fee_cents` in
      // the hashed payload; ignoring it here debited cash for the gross.
      feeCents: centsValue(row.fee_cents),
    });
  }

  if (input.sourceType === "receivable_adjustment") {
    return postReceivableAdjustment({
      ...common,
      memo: textValue(row.memo, "Receivable adjustment"),
      amountCents: centsValue(row.amount_cents),
      taxCents: centsValue(row.tax_cents),
      adjustmentType: row.adjustment_type === "write_off" ? "write_off" : "credit_memo",
      revenueBasis: row.revenue_basis === "closing" ? "closing" : "percentage_of_completion",
    });
  }

  if (input.sourceType === "customer_deposit_receipt") {
    return postCustomerDepositReceipt({
      ...common,
      memo: textValue(row.memo, "Customer deposit received"),
      amountCents: centsValue(row.amount_cents),
      grossCents: centsValue(row.gross_cents) || centsValue(row.amount_cents),
      feeCents: centsValue(row.fee_cents),
    });
  }

  if (input.sourceType === "customer_deposit_application") {
    return postCustomerDepositApplication({
      ...common,
      memo: textValue(row.memo, "Customer deposit applied"),
      amountCents: centsValue(row.amount_cents),
    });
  }

  if (input.sourceType === "customer_deposit_reversal") {
    return postCustomerDepositReversal({
      ...common,
      memo: textValue(row.memo, "Customer deposit refunded"),
      amountCents: centsValue(row.amount_cents),
    });
  }

  if (input.sourceType === "bill_payment") {
    return postBillPayment({
      ...common,
      cashAccountCode: textValue(row.cash_account_code, "") || undefined,
      memo: textValue(row.memo, "Vendor bill payment"),
      amountCents: centsValue(row.amount_cents),
      discountCents: centsValue(row.discount_cents),
    });
  }

  if (input.sourceType === "ap_fee_charge") {
    return postApFeeCharge({
      ...common,
      cashAccountCode: textValue(row.cash_account_code, "") || undefined,
      memo: textValue(row.memo, "Arc Pay fees"),
      amountCents: centsValue(row.amount_cents),
    });
  }

  if (input.sourceType === "expense") {
    const amountCents = centsValue(row.amount_cents);
    const costLines = costLinesValue(row.cost_lines, amountCents, projectId);
    return projectId || costLines.some((line) => line.projectId)
      ? postExpenseFromCostLines({
          ...common,
          paymentAccountCode: textValue(row.payment_account_code, "") || undefined,
          companyId: optionalId(row.vendor_company_id),
          memo: textValue(row.memo, "Expense"),
          amountCents,
          costLines,
        })
      : postExpense({
          ...common,
          paymentAccountCode: textValue(row.payment_account_code, "") || undefined,
          companyId: optionalId(row.vendor_company_id),
          memo: textValue(row.memo, "Expense"),
          amountCents,
          expenseAccountCode: SYSTEM_ACCOUNT_CODES.otherExpense,
        });
  }

  if (input.sourceType === "payment_reversal") {
    const side =
      row.side === "bill_payment" ? "bill_payment" : "invoice_payment";
    return postPaymentReversal({
      ...common,
      cashAccountCode: textValue(row.cash_account_code, "") || undefined,
      memo: textValue(row.memo, "Payment reversal"),
      amountCents: centsValue(row.amount_cents),
      side,
    });
  }

  if (input.sourceType === "labor_cost") {
    return postLaborCost({
      ...common,
      memo: textValue(row.memo, "Field labor"),
      costAccountCode: textValue(row.cost_account_code, "") || undefined,
      amountCents: centsValue(row.amount_cents),
    });
  }

  return null;
}

/** Dimensions are captured in the immutable fact so historical replay does not read today's project relationships. */
export function draftFromFact(input: FactDraftInput): JournalEntryDraft | null {
  const draft = baseDraftFromFact(input);
  if (!draft) return null;
  const byProject = (input.payload.project_dimensions ?? {}) as Record<string, Record<string, unknown>>;
  const sourceDimensions = (input.payload.dimensions ?? {}) as Record<string, unknown>;
  return { ...draft, lines: draft.lines.map(line => {
    const dimensions = { ...(line.projectId ? byProject[line.projectId] : {}), ...sourceDimensions, ...line.dimensions };
    return Object.keys(dimensions).length ? { ...line, dimensions } : line;
  }) };
}

/** Enrich new economic revisions without recoding an unchanged, closed history at rollout. */
export function preserveLegacyDimensionPayload(sourceType: string, accountingDate: string, payload: Record<string, unknown>, previous: { accounting_date: string; payload_hash: string; payload: Record<string, unknown> } | null) {
  if (!previous || previous.accounting_date !== accountingDate || previous.payload.project_dimensions || previous.payload.dimensions || (Array.isArray(previous.payload.cost_lines) && previous.payload.cost_lines.some(line => line?.dimensions))) return payload;
  const legacy = { ...payload };
  delete legacy.project_dimensions; delete legacy.dimensions;
  if (Array.isArray(legacy.cost_lines)) legacy.cost_lines = sortFactCostLines(legacy.cost_lines.map(line => { const copy = { ...line }; delete copy.dimensions; return copy; }));
  const economic = hashableFactPayload(sourceType, legacy);
  return [booksDigestForDimensions(economic), booksDigestForDimensions({ accountingDate, payload: economic })].includes(previous.payload_hash) ? previous.payload : payload;
}
