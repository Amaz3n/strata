import { z } from "zod";
import { createHash } from "node:crypto";
import { booksDigest } from "./hash";
import {
  nativeReceiptTime,
  nativeContextMeaning,
} from "./native-adjustment-contract";
import {
  buildNativeProjectPostingPlan,
  nativePostingContextSchema,
  nativeJournalDraftSchema,
} from "./native-posting-plan";
import {
  verifyNativeInvoicePostingReceipt,
  nativeInvoicePostingSchema,
} from "./native-invoice-posting-receipt";

const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const nativeInvoiceReversalRequestSchema = z
  .object({
    id: uuid,
    context: nativePostingContextSchema,
    original: z
      .object({
        posting: z.unknown(),
        entry: z.unknown(),
        lines: z.unknown(),
      })
      .strict(),
    notes: z
      .string()
      .min(10)
      .max(2000)
      .refine((v) => v === v.trim()),
  })
  .strict();

/** Preparation only. The governed SQL writer must independently load the
 * original journal, revalidate current authority/period/ownership, obtain a
 * separate review and fence duplicate correction intents before committing.
 * Never reverse a newly projected invoice or substitute current control roles.
 */
export function buildNativeInvoiceReversalPlan(input: unknown) {
  const v = nativeInvoiceReversalRequestSchema.parse(input);
  const original = verifyNativeInvoicePostingReceipt(
    v.original.posting,
    v.original.entry,
    v.original.lines,
  );
  const c = v.context,
    p = original.posting;
  if (
    c.orgId !== p.org_id ||
    c.owner.legal_entity_id !== p.legal_entity_id ||
    c.projectId !== p.project_id ||
    c.sourceType !== "invoice" ||
    c.sourceId !== p.invoice_id ||
    c.entryDate < p.entry_date ||
    nativeReceiptTime(c.capturedAt) < nativeReceiptTime(p.posted_at)
  )
    throw Error(
      "Native invoice reversal differs from original scope or chronology",
    );
  if (v.id === p.id || v.id === p.entry_id)
    throw Error(
      "Native invoice reversal requires a distinct correction identity",
    );
  const accounts = new Map(c.accounts.map((a) => [a.id, a]));
  const oldAccounts = new Map(
    original.validated.economic.native.accounts.map((a) => [a.id, a]),
  );
  const lines = original.lines.map((line) => {
    const account = accounts.get(line.account_id),
      old = oldAccounts.get(line.account_id);
    if (!account || !old)
      throw Error(
        "Original reversal account is absent from the applicable entity chart",
      );
    // Renaming an account is permitted. Reclassifying original money requires
    // a separate reviewed account migration; code/role similarity is no proof.
    for (const field of [
      "account_type",
      "subtype",
      "normal_balance",
      "cash_flow_category",
    ] as const)
      if (account.definition[field] !== old.definition[field])
        throw Error("Original reversal account classification changed");
    return {
      accountCode: account.code,
      debitCents: line.credit_cents,
      creditCents: line.debit_cents,
      projectId: line.project_id,
      ...(line.company_id === null ? {} : { companyId: line.company_id }),
      ...(line.description === null ? {} : { description: line.description }),
      dimensions: structuredClone(line.dimensions),
    };
  });
  const result = buildNativeProjectPostingPlan(c, {
    entryDate: c.entryDate,
    entryKind: "reversal",
    memo: v.notes,
    postingKey: `native-invoice-correction:${v.id}:reversal:${p.id}`,
    projectionVersion: original.plan.projectionVersion,
    policyVersion: original.plan.policyVersion,
    sourceType: "invoice",
    sourceId: p.invoice_id,
    lines,
  });
  // Compare canonical identities after chart routing: changing current control
  // bindings may never redirect the original receivable, retainage or tax.
  for (const [i, line] of result.plan.lines.entries())
    if (line.accountId !== original.lines[i].account_id)
      throw Error("Native invoice reversal redirected an original account");
  const provenance = {
    correctionId: v.id,
    originalPostingId: p.id,
    originalEntryId: p.entry_id,
    originalEntryDate: p.entry_date,
    originalRequestSha256: p.request_sha256,
    originalDraftSha256: p.draft_sha256,
    originalJournalSha256: booksDigest({
      entry: original.entry,
      lines: original.lines,
    }),
    originalLegIds: original.lines.map((l) => l.id),
  };
  return {
    ...result,
    provenance,
    correctionPlanSha256: booksDigest({ plan: result.plan, provenance }),
    reviewed: false as const,
    sourceChanged: false as const,
  };
}

/** SQL response verification is independent of its checksums and supplied
 * draft: reconstruct every intended leg from the caller's original receipt. */
export function verifyNativeInvoiceReversalDerivation(
  input: unknown,
  response: unknown,
) {
  const q = nativeInvoiceReversalRequestSchema.parse(input);
  const r = z
    .object({
      draft: nativeJournalDraftSchema,
      validatedContext: nativePostingContextSchema,
      originalPosting: nativeInvoicePostingSchema,
      originalJournalText: z.string().max(8400000),
      originalJournalSha256: z.string().regex(/^[a-f0-9]{64}$/),
      posted: z.literal(false),
      reviewed: z.literal(false),
      sourceChanged: z.literal(false),
      ledgerActivated: z.literal(false),
    })
    .strict()
    .parse(response);
  if (
    Buffer.byteLength(r.originalJournalText) > 8400000 ||
    createHash("sha256").update(r.originalJournalText).digest("hex") !==
      r.originalJournalSha256
  )
    throw Error("Native reversal original journal checksum differs");
  if (
    booksDigest(nativeContextMeaning(q.context)) !==
      booksDigest(nativeContextMeaning(r.validatedContext)) ||
    nativeReceiptTime(r.validatedContext.capturedAt) <
      nativeReceiptTime(q.context.capturedAt)
  )
    throw Error(
      "Native reversal validated context differs from original request",
    );
  const journal = z
    .object({ entry: z.unknown(), lines: z.unknown() })
    .strict()
    .parse(JSON.parse(r.originalJournalText));
  const returned = verifyNativeInvoicePostingReceipt(
    r.originalPosting,
    journal.entry,
    journal.lines,
  );
  const original = verifyNativeInvoicePostingReceipt(
    q.original.posting,
    q.original.entry,
    q.original.lines,
  );
  if (
    booksDigest({
      posting: returned.posting,
      entry: returned.entry,
      lines: returned.lines,
    }) !==
    booksDigest({
      posting: original.posting,
      entry: original.entry,
      lines: original.lines,
    })
  )
    throw Error(
      "Native reversal returned original journal differs from saved receipt",
    );
  const expected = buildNativeInvoiceReversalPlan({
    ...q,
    context: r.validatedContext,
  });
  const actual = buildNativeProjectPostingPlan(r.validatedContext, r.draft);
  if (booksDigest(actual.plan) !== booksDigest(expected.plan))
    throw Error("Native reversal SQL draft differs from exact original money");
  return { ...r, ...expected };
}
