import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import { nativeReceiptTime } from "./native-adjustment-contract";
import { nativePostingContextSchema } from "./native-posting-plan";
import { verifyNativeContextArchive } from "./native-context-archive";
import { verifyNativeInvoiceCorrectionProposal } from "./native-invoice-correction-proposal";
import { verifyNativeInvoiceCorrectionPairDerivation } from "./native-invoice-correction-pair";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const NATIVE_INVOICE_CORRECTION_REVIEW_TABLE =
  "books_native_invoice_correction_reviews" as const;
export const nativeInvoiceCorrectionReviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  proposal_id: uuid,
  decision: z.enum(["approve", "reject"]),
  request_sha256: sha,
  derivation_sha256: sha,
  reviewer_context_text: z.string().max(4194304),
  reviewer_context_sha256: sha,
  rechecked_derivation_text: z.string().max(84000000).nullable(),
  rechecked_derivation_sha256: sha.nullable(),
  reviewed_by: uuid,
  reviewed_access_event_id: uuid,
  reviewed_at: z.string(),
  notes: z
    .string()
    .min(10)
    .max(2000)
    .refine((v) => v === v.trim()),
});
export function verifyNativeInvoiceCorrectionReview(
  value: unknown,
  proposal: unknown,
) {
  const r = nativeInvoiceCorrectionReviewSchema.parse(value),
    p = verifyNativeInvoiceCorrectionProposal(proposal);
  if (!p.pair || !("protocolVersion" in p.request))
    throw Error("Correction review requires explicit replacement proposal");
  for (const [body, digest, max] of [
    [r.reviewer_context_text, r.reviewer_context_sha256, 4194304],
    [r.rechecked_derivation_text, r.rechecked_derivation_sha256, 84000000],
  ] as const) {
    if (body === null && digest === null) continue;
    if (
      body === null ||
      digest === null ||
      Buffer.byteLength(body) > max ||
      createHash("sha256").update(body).digest("hex") !== digest
    )
      throw Error("Correction review retained digest differs");
  }
  const c = nativePostingContextSchema.parse(
    JSON.parse(r.reviewer_context_text),
  );
  if (
    r.org_id !== p.proposal.org_id ||
    r.legal_entity_id !== p.proposal.legal_entity_id ||
    r.project_id !== p.proposal.project_id ||
    r.proposal_id !== p.proposal.id ||
    r.reviewed_by === p.proposal.prepared_by ||
    r.request_sha256 !== p.proposal.request_sha256 ||
    r.derivation_sha256 !== p.proposal.derivation_sha256 ||
    c.orgId !== r.org_id ||
    c.projectId !== r.project_id ||
    c.actorId !== r.reviewed_by ||
    c.sourceType !== "invoice" ||
    c.sourceId !== p.proposal.invoice_id ||
    c.owner.legal_entity_id !== r.legal_entity_id ||
    c.entryDate !== p.proposal.entry_date ||
    nativeReceiptTime(r.reviewed_at) <
      nativeReceiptTime(p.proposal.prepared_at) ||
    nativeReceiptTime(r.reviewed_at) < nativeReceiptTime(c.capturedAt)
  )
    throw Error(
      "Correction review scope, original hashes or chronology differs",
    );
  let pair = null;
  if (r.decision === "approve") {
    if (!r.rechecked_derivation_text)
      throw Error("Approved correction requires rechecked complete pair");
    const d = JSON.parse(r.rechecked_derivation_text),
      journal = JSON.parse(p.derivation.originalJournalText);
    pair = verifyNativeInvoiceCorrectionPairDerivation(
      {
        id: p.proposal.id,
        baseEconomic: p.request.baseEconomic,
        patch: p.request.patch,
        notes: p.request.notes,
        original: {
          posting: p.derivation.originalPosting,
          entry: journal.entry,
          lines: journal.lines,
        },
      },
      d,
    );
    const meaning = (context: typeof c) => {
      const { actorId, capturedAt, databaseSnapshot, ...rest } = context;
      return rest;
    };
    if (
      booksDigest(meaning(c)) !==
        booksDigest(meaning(pair.baseEconomic.native)) ||
      nativeReceiptTime(r.reviewed_at) <
        nativeReceiptTime(pair.baseEconomic.native.capturedAt) ||
      nativeReceiptTime(r.reviewed_at) <
        nativeReceiptTime(pair.replacementEconomic.native.capturedAt)
    )
      throw Error(
        "Correction reviewer did not retain the same rechecked source and definitions",
      );
  } else if (
    r.rechecked_derivation_text !== null ||
    r.rechecked_derivation_sha256 !== null
  )
    throw Error("Rejected correction cannot retain approval evidence");
  return {
    review: r,
    proposal: p,
    reviewerContext: c,
    pair,
    posted: false as const,
    sourceChanged: false as const,
  };
}
export function verifyNativeInvoiceCorrectionReviewArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  const rows = tables[NATIVE_INVOICE_CORRECTION_REVIEW_TABLE];
  if (version < 32)
    return rows?.length
      ? ["Native correction reviews require archive schema32"]
      : [];
  try {
    if (!rows) throw Error("Missing native correction review history");
    const ids = new Set<string>(),
      proposals = new Set<string>();
    const events = tables.books_legal_entity_access_history ?? [];
    const authority = (user: string, entity: string, at: bigint) =>
      events
        .filter(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === entity &&
            e.user_id === user &&
            nativeReceiptTime(String(e.changed_at)) <= at,
        )
        .sort((a, b) =>
          BigInt(String(a.sequence_no)) > BigInt(String(b.sequence_no))
            ? -1
            : 1,
        )[0];
    for (const row of rows) {
      const original = (
        tables.books_native_invoice_correction_proposals ?? []
      ).filter((p) => p.org_id === org && p.id === row.proposal_id);
      if (original.length !== 1)
        throw Error("Missing original correction proposal");
      const {
        review: r,
        proposal: p,
        reviewerContext: c,
        pair,
      } = verifyNativeInvoiceCorrectionReview(row, original[0]);
      if (r.org_id !== org || ids.has(r.id) || proposals.has(r.proposal_id))
        throw Error("Foreign or duplicate correction review");
      ids.add(r.id);
      proposals.add(r.proposal_id);
      verifyNativeContextArchive(c, tables, org, false);
      const at = nativeReceiptTime(r.reviewed_at),
        event = authority(r.reviewed_by, r.legal_entity_id, at);
      if (
        !event ||
        event.id !== r.reviewed_access_event_id ||
        !["review", "manage"].includes(String(event.access_level))
      )
        throw Error("Correction review historical authority differs");
      if (pair) {
        const maker = authority(p.proposal.prepared_by, r.legal_entity_id, at);
        if (
          !maker ||
          !["prepare", "manage"].includes(String(maker.access_level))
        )
          throw Error(
            "Correction maker lacked preparation authority at approval",
          );
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
        const hold = (tables.books_native_period_holds ?? [])
          .filter(
            (h) =>
              h.org_id === org &&
              h.legal_entity_id === r.legal_entity_id &&
              h.period_id === pair.baseEconomic.native.period.id &&
              nativeReceiptTime(String(h.recorded_at)) <= at,
          )
          .sort((a, b) =>
            BigInt(String(a.sequence_no)) > BigInt(String(b.sequence_no))
              ? -1
              : 1,
          )[0];
        if (hold?.decision === "hold")
          throw Error("Correction approval occurred in a held period");
      }
    }
    return [];
  } catch (e) {
    return [
      "Invalid native correction review history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
