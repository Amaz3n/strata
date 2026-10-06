import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import { nativeReceiptTime } from "./native-adjustment-contract";
import { nativePostingContextSchema } from "./native-posting-plan";
import { verifyNativeInvoiceReversalDerivation } from "./native-invoice-correction-plan";
import { verifyNativeContextArchive } from "./native-context-archive";
import { nativeInvoiceEconomicSchema } from "./native-invoice-economics";
import {
  nativeInvoiceReplacementPatchSchema,
  verifyNativeInvoiceCorrectionPairDerivation,
} from "./native-invoice-correction-pair";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE =
  "books_native_invoice_correction_proposals" as const;
export const nativeInvoiceReversalProposalRequestSchema = z
  .object({
    id: uuid,
    expectedOrgId: uuid,
    expectedActorId: uuid,
    context: nativePostingContextSchema,
    originalPostingId: uuid,
    notes: z
      .string()
      .min(10)
      .max(2000)
      .refine((v) => v === v.trim()),
  })
  .strict();
export const nativeInvoiceReplacementProposalRequestSchema =
  nativeInvoiceReversalProposalRequestSchema
    .extend({
      protocolVersion: z.literal(2),
      intent: z.literal("replace"),
      baseEconomic: nativeInvoiceEconomicSchema,
      patch: nativeInvoiceReplacementPatchSchema,
    })
    .strict()
    .refine(
      (q) => booksDigest(q.context) === booksDigest(q.baseEconomic.native),
      "Replacement must retain identical original economic context",
    );
export const nativeInvoiceCorrectionRequestSchema = z.union([
  nativeInvoiceReversalProposalRequestSchema,
  nativeInvoiceReplacementProposalRequestSchema,
]);
export const nativeInvoiceCorrectionProposalSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  original_posting_id: uuid,
  original_entry_id: uuid,
  owner_review_id: uuid,
  chart_id: uuid,
  period_id: uuid,
  entry_date: nativePostingContextSchema.shape.entryDate,
  request_text: z.string().max(16800000),
  request_sha256: sha,
  derivation_text: z.string().max(84000000),
  derivation_sha256: sha,
  prepared_by: uuid,
  prepared_access_event_id: uuid,
  prepared_at: z.string(),
});
export function verifyNativeInvoiceCorrectionProposal(value: unknown) {
  const r = nativeInvoiceCorrectionProposalSchema.parse(value);
  for (const [body, digest, max] of [
    [r.request_text, r.request_sha256, 16800000],
    [r.derivation_text, r.derivation_sha256, 84000000],
  ] as const)
    if (
      Buffer.byteLength(body) > max ||
      createHash("sha256").update(body).digest("hex") !== digest
    )
      throw Error("Native correction proposal retained digest differs");
  const q = nativeInvoiceCorrectionRequestSchema.parse(
    JSON.parse(r.request_text),
  );
  const derivation = JSON.parse(r.derivation_text);
  const isReplacement = "protocolVersion" in q;
  if (!isReplacement && Buffer.byteLength(r.request_text) > 8400000)
    throw Error(
      "Original reversal proposal exceeds its retained request bound",
    );
  const reversal = isReplacement ? derivation.reversal : derivation;
  const journal = JSON.parse(reversal.originalJournalText);
  const verified = verifyNativeInvoiceReversalDerivation(
    {
      id: q.id,
      context: q.context,
      notes: q.notes,
      original: {
        posting: reversal.originalPosting,
        entry: journal.entry,
        lines: journal.lines,
      },
    },
    reversal,
  );
  const pair = isReplacement
    ? verifyNativeInvoiceCorrectionPairDerivation(
        {
          id: q.id,
          baseEconomic: q.baseEconomic,
          patch: q.patch,
          notes: q.notes,
          original: {
            posting: reversal.originalPosting,
            entry: journal.entry,
            lines: journal.lines,
          },
        },
        derivation,
      )
    : null;
  const c = verified.validatedContext,
    p = verified.originalPosting;
  if (
    r.id !== q.id ||
    r.org_id !== q.expectedOrgId ||
    r.prepared_by !== q.expectedActorId ||
    r.org_id !== c.orgId ||
    r.prepared_by !== c.actorId ||
    r.legal_entity_id !== c.owner.legal_entity_id ||
    r.project_id !== c.projectId ||
    r.invoice_id !== c.sourceId ||
    r.owner_review_id !== c.owner.id ||
    r.chart_id !== c.chart.id ||
    r.period_id !== c.period.id ||
    r.entry_date !== c.entryDate ||
    r.original_posting_id !== q.originalPostingId ||
    r.original_posting_id !== p.id ||
    r.original_entry_id !== p.entry_id ||
    nativeReceiptTime(r.prepared_at) < nativeReceiptTime(c.capturedAt) ||
    (pair !== null &&
      nativeReceiptTime(r.prepared_at) <
        nativeReceiptTime(pair.replacementEconomic.native.capturedAt))
  )
    throw Error(
      "Native correction proposal scope, origin or chronology differs",
    );
  return { proposal: r, request: q, derivation: verified, pair };
}
export function verifyNativeInvoiceCorrectionProposalArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  const rows = tables[NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE];
  if (version < 30)
    return rows?.length
      ? ["Native invoice correction proposals require archive schema30"]
      : [];
  try {
    if (!rows)
      throw Error("Missing native invoice correction proposal history");
    const ids = new Set<string>();
    for (const raw of rows) {
      const {
        proposal: r,
        request: q,
        derivation: d,
        pair,
      } = verifyNativeInvoiceCorrectionProposal(raw);
      if (r.org_id !== org || ids.has(r.id))
        throw Error("Foreign or duplicate native correction proposal");
      ids.add(r.id);
      if (pair && version < 31)
        throw Error("Native replacement proposals require archive schema31");
      verifyNativeContextArchive(q.context, tables, org, false);
      verifyNativeContextArchive(d.validatedContext, tables, org, false);
      if (pair) {
        verifyNativeContextArchive(
          pair.baseEconomic.native,
          tables,
          org,
          false,
        );
        verifyNativeContextArchive(
          pair.replacementEconomic.native,
          tables,
          org,
          false,
        );
      }
      const original = (tables.books_native_invoice_postings ?? []).filter(
        (p) => p.org_id === org && p.id === r.original_posting_id,
      );
      const entry = (tables.books_native_journal_entries ?? []).filter(
        (e) => e.org_id === org && e.id === r.original_entry_id,
      );
      const lines = (tables.books_native_journal_lines ?? [])
        .filter((l) => l.org_id === org && l.entry_id === r.original_entry_id)
        .sort((a, b) => Number(a.position) - Number(b.position));
      const journal = JSON.parse(d.originalJournalText);
      // Original rows retain all exported columns, including future provenance.
      if (
        original.length !== 1 ||
        entry.length !== 1 ||
        booksDigest(original[0]) !==
          booksDigest(
            pair
              ? JSON.parse(r.derivation_text).reversal.originalPosting
              : JSON.parse(r.derivation_text).originalPosting,
          ) ||
        booksDigest({ entry: entry[0], lines }) !== booksDigest(journal)
      )
        throw Error(
          "Native correction proposal original journal archive differs",
        );
      const at = nativeReceiptTime(r.prepared_at),
        events = tables.books_legal_entity_access_history ?? [];
      const event = events.find(
        (e) =>
          e.org_id === org &&
          e.legal_entity_id === r.legal_entity_id &&
          e.user_id === r.prepared_by &&
          e.id === r.prepared_access_event_id,
      );
      if (
        !event ||
        !["prepare", "manage"].includes(String(event.access_level)) ||
        nativeReceiptTime(String(event.changed_at)) > at ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === r.legal_entity_id &&
            e.user_id === r.prepared_by &&
            BigInt(String(e.sequence_no)) > BigInt(String(event.sequence_no)) &&
            nativeReceiptTime(String(e.changed_at)) <= at,
        )
      )
        throw Error("Native correction proposal historical authority differs");
      const hold = (tables.books_native_period_holds ?? [])
        .filter(
          (h) =>
            h.org_id === org &&
            h.legal_entity_id === r.legal_entity_id &&
            h.period_id === r.period_id &&
            nativeReceiptTime(String(h.recorded_at)) <= at,
        )
        .sort((a, b) => Number(b.sequence_no) - Number(a.sequence_no))[0];
      if (hold?.decision === "hold")
        throw Error("Native correction proposal was prepared in a held period");
    }
    return [];
  } catch (e) {
    return [
      "Invalid native invoice correction history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
