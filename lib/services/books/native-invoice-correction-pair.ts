import { z } from "zod";
import { booksDigest } from "./hash";
import {
  buildNativeInvoiceReversalPlan,
  verifyNativeInvoiceReversalDerivation,
} from "./native-invoice-correction-plan";
import {
  buildNativeProjectPostingPlan,
  nativeJournalDraftSchema,
} from "./native-posting-plan";
import {
  nativeContextMeaning,
  nativeReceiptTime,
} from "./native-adjustment-contract";
import {
  nativeInvoiceEconomicSchema,
  verifyNativeInvoiceEconomicContext,
  buildNativeInvoiceReplacementPlan,
  nativeInvoiceLineCents,
} from "./native-invoice-economics";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const nativeInvoiceReplacementPatchSchema = z
  .object({
    totalCents: z.number().int().safe(),
    taxCents: z.number().int().safe(),
    lines: z
      .array(
        z
          .object({
            id: uuid,
            quantity: z.string().regex(/^-?\d{1,12}(?:\.\d{1,6})?$/),
            unitPriceCents: z.number().int().safe(),
            incomeAccountId: uuid.nullable(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const nativeInvoiceCorrectionPairRequestSchema = z
  .object({
    id: uuid,
    baseEconomic: nativeInvoiceEconomicSchema,
    original: z
      .object({ posting: z.unknown(), entry: z.unknown(), lines: z.unknown() })
      .strict(),
    patch: nativeInvoiceReplacementPatchSchema,
    notes: z
      .string()
      .min(10)
      .max(2000)
      .refine((v) => v === v.trim()),
  })
  .strict();
/** Proposed revision only. Retainage, release ownership, closing agreements,
 * source dates, cost dimensions and non-Books metadata cannot be rewritten by
 * these price/account choices. Their separate correction protocols remain
 * required before dependent money can change. */
export function buildNativeInvoiceCorrectionPair(input: unknown) {
  const q = nativeInvoiceCorrectionPairRequestSchema.parse(input);
  const base = verifyNativeInvoiceEconomicContext(q.baseEconomic).economic;
  const reversal = buildNativeInvoiceReversalPlan({
    id: q.id,
    context: base.native,
    original: q.original,
    notes: q.notes,
  });
  const e = structuredClone(base),
    byId = new Map(q.patch.lines.map((l) => [l.id, l]));
  const priced = e.lines.filter(
    (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
  );
  if (
    byId.size !== q.patch.lines.length ||
    priced.length !== byId.size ||
    priced.some((l) => !byId.has(l.source.id))
  )
    throw Error(
      "Native replacement must specify every existing priced line exactly once",
    );
  e.native.source.total_cents = q.patch.totalCents;
  e.native.source.tax_cents = q.patch.taxCents;
  for (const line of priced) {
    const p = byId.get(line.source.id)!;
    nativeInvoiceLineCents(p.quantity, String(p.unitPriceCents));
    if (
      p.incomeAccountId !== null &&
      !e.native.accounts.some(
        (a) =>
          a.id === p.incomeAccountId && a.definition.account_type === "income",
      )
    )
      throw Error(
        "Native replacement income account is absent from reviewed entity chart",
      );
    line.quantity = p.quantity;
    line.unitPriceCents = String(p.unitPriceCents);
    line.source.quantity = Number(p.quantity);
    line.source.unit_price_cents = p.unitPriceCents;
    const metadata = { ...(line.source.metadata ?? {}) };
    for (const key of [
      "arc_books_gl_account_id",
      "arc_books_entity_account_id",
      "arc_books_entity_income_selection_id",
    ])
      delete metadata[key];
    if (p.incomeAccountId !== null)
      metadata.arc_books_entity_account_id = p.incomeAccountId;
    metadata.arc_books_entity_correction_id = q.id;
    line.source.metadata = metadata;
  }
  const replacement = buildNativeInvoiceReplacementPlan(e, q.id);
  if (!replacement.plan)
    throw Error("Native replacement must contain invoice journal money");
  const provenance = reversal.provenance;
  return {
    id: q.id,
    patch: q.patch,
    baseEconomic: base,
    replacementEconomic: replacement.economic,
    reversal: reversal.plan,
    replacement: replacement.plan,
    provenance,
    pairSha256: booksDigest({
      reversal: reversal.plan,
      replacement: replacement.plan,
      provenance,
    }),
    posted: false as const,
    reviewed: false as const,
    sourceChanged: false as const,
    ledgerActivated: false as const,
  };
}

export function verifyNativeInvoiceCorrectionPairDerivation(
  input: unknown,
  response: unknown,
) {
  const q = nativeInvoiceCorrectionPairRequestSchema.parse(input);
  const r = z
    .object({
      reversal: z.unknown(),
      validatedEconomic: nativeInvoiceEconomicSchema,
      patch: nativeInvoiceReplacementPatchSchema,
      replacementEconomic: nativeInvoiceEconomicSchema,
      replacementDraft: nativeJournalDraftSchema,
      posted: z.literal(false),
      reviewed: z.literal(false),
      sourceChanged: z.literal(false),
      ledgerActivated: z.literal(false),
    })
    .strict()
    .parse(response);
  const meaning = (e: z.infer<typeof nativeInvoiceEconomicSchema>) => ({
    ...e,
    native: nativeContextMeaning(e.native),
  });
  if (
    booksDigest(r.patch) !== booksDigest(q.patch) ||
    booksDigest(meaning(r.validatedEconomic)) !==
      booksDigest(meaning(q.baseEconomic)) ||
    nativeReceiptTime(r.validatedEconomic.native.capturedAt) <
      nativeReceiptTime(q.baseEconomic.native.capturedAt)
  )
    throw Error(
      "Native correction pair differs from original source or revision request",
    );
  const reversal = verifyNativeInvoiceReversalDerivation(
    {
      id: q.id,
      context: r.validatedEconomic.native,
      original: q.original,
      notes: q.notes,
    },
    r.reversal,
  );
  const expected = buildNativeInvoiceCorrectionPair({
    ...q,
    baseEconomic: r.validatedEconomic,
  });
  if (
    booksDigest(expected.replacementEconomic) !==
    booksDigest(r.replacementEconomic)
  )
    throw Error(
      "Native replacement source revision differs from requested changes",
    );
  const replacement = buildNativeProjectPostingPlan(
    r.replacementEconomic.native,
    r.replacementDraft,
  ).plan;
  if (booksDigest(replacement) !== booksDigest(expected.replacement))
    throw Error(
      "Native replacement SQL draft differs from independently derived source money",
    );
  const {
    capturedAt: _at,
    databaseSnapshot: _snapshot,
    ...rev
  } = reversal.plan;
  const {
    capturedAt: _expectedAt,
    databaseSnapshot: _expectedSnapshot,
    ...expectedRev
  } = expected.reversal;
  if (booksDigest(rev) !== booksDigest(expectedRev))
    throw Error(
      "Native correction reversal differs from original full journal",
    );
  return {
    ...expected,
    reversal: reversal.plan,
    replacement,
    pairSha256: booksDigest({
      reversal: reversal.plan,
      replacement,
      provenance: expected.provenance,
    }),
  };
}
