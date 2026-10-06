import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import {
  nativeContextMeaning,
  nativeJournalEntrySchema,
  nativeJournalLineSchema,
  nativeReceiptTime,
} from "./native-adjustment-contract";
import {
  nativeJournalDraftSchema,
  nativePostingContextSchema,
  buildNativeProjectPostingPlan,
} from "./native-posting-plan";
import { buildNativeInvoicePostingPlan } from "./native-invoice-economics";

const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(4194304);
export const nativeInvoicePostingSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  entry_id: uuid,
  income_selection_id: uuid.nullable().optional(),
  owner_review_id: uuid,
  chart_id: uuid,
  period_id: uuid,
  entry_date: nativePostingContextSchema.shape.entryDate,
  request_text: text,
  request_sha256: sha,
  validated_economic_text: text,
  validated_economic_sha256: sha,
  draft_text: text,
  draft_sha256: sha,
  posted_by: uuid,
  access_event_id: uuid,
  posted_at: z.string(),
  notes: z
    .string()
    .min(10)
    .max(2000)
    .refine((v) => v === v.trim()),
});
// Manual adjustment headers remain strict. Operational receipts require their
// distinct origin explicitly; accepting nullable origins globally would hide
// malformed manual approval history.
export const nativeInvoiceJournalEntrySchema = nativeJournalEntrySchema.extend({
  fact_id: z.null(),
  review_id: z.null(),
  source_posting_id: uuid,
});
const rawSha = (s: string) => createHash("sha256").update(s).digest("hex");
export function verifyNativeInvoicePostingReceipt(
  posting: unknown,
  entry: unknown,
  lines: unknown,
) {
  const r = nativeInvoicePostingSchema.parse(posting);
  const body = JSON.parse(r.request_text);
  const selectionIds = new Set<string>(
    (body.lines ?? [])
      .filter(
        (l: { source: { metadata?: Record<string, unknown> } }) =>
          l.source.metadata?.system_generated_kind !== "retainage_hold",
      )
      .map(
        (l: { source: { metadata?: Record<string, unknown> } }) =>
          l.source.metadata?.arc_books_entity_income_selection_id,
      )
      .filter(Boolean),
  );
  if (
    selectionIds.size > 1 ||
    (selectionIds.size && !selectionIds.has(r.income_selection_id ?? ""))
  )
    throw Error("Native invoice selection origin differs from frozen source");

  for (const [body, digest] of [
    [r.request_text, r.request_sha256],
    [r.validated_economic_text, r.validated_economic_sha256],
    [r.draft_text, r.draft_sha256],
  ]) {
    if (Buffer.byteLength(body) > 4194304 || rawSha(body) !== digest)
      throw Error("Native invoice retained receipt digest differs");
  }
  const original = buildNativeInvoicePostingPlan(JSON.parse(r.request_text));
  const validated = buildNativeInvoicePostingPlan(
    JSON.parse(r.validated_economic_text),
  );
  const c = original.economic.native;
  if (!original.plan || !validated.plan)
    throw Error("Collection request cannot have native invoice journal money");
  const meaning = (e: typeof original.economic) => ({
    ...e,
    native: nativeContextMeaning(e.native),
  });
  if (
    booksDigest(meaning(original.economic)) !==
    booksDigest(meaning(validated.economic))
  )
    throw Error(
      "Native invoice validated economics differ from original request",
    );
  if (
    r.org_id !== c.orgId ||
    r.legal_entity_id !== c.owner.legal_entity_id ||
    r.project_id !== c.projectId ||
    r.invoice_id !== c.sourceId ||
    r.posted_by !== c.actorId ||
    r.owner_review_id !== c.owner.id ||
    r.chart_id !== c.chart.id ||
    r.period_id !== c.period.id ||
    r.entry_date !== c.entryDate ||
    nativeReceiptTime(c.capturedAt) > nativeReceiptTime(r.posted_at) ||
    nativeReceiptTime(validated.economic.native.capturedAt) >
      nativeReceiptTime(r.posted_at)
  )
    throw Error(
      "Native invoice receipt source, scope, actor or chronology differs",
    );
  const draft = nativeJournalDraftSchema.parse(JSON.parse(r.draft_text));
  if (draft.postingKey !== "native-invoice:" + r.invoice_id)
    throw Error("Native invoice initial posting identity differs");
  const p = buildNativeProjectPostingPlan(
    validated.economic.native,
    draft,
  ).plan;
  const expected = original.plan;
  const financial = (v: typeof p) => ({
    orgId: v.orgId,
    legalEntityId: v.legalEntityId,
    projectId: v.projectId,
    sourceType: v.sourceType,
    sourceId: v.sourceId,
    chartId: v.chartId,
    periodId: v.periodId,
    entryDate: v.entryDate,
    entryKind: v.entryKind,
    memo: v.memo,
    projectionVersion: v.projectionVersion,
    policyVersion: v.policyVersion,
    totalCents: v.totalCents,
    lines: v.lines.map((l) => ({
      position: l.position,
      accountId: l.accountId,
      accountCode: l.accountCode,
      projectId: l.projectId,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description ?? null,
      companyId: l.companyId ?? null,
      dimensions: l.dimensions ?? {},
    })),
  });
  if (booksDigest(financial(p)) !== booksDigest(financial(expected)))
    throw Error(
      "Native invoice draft differs from independently derived source money",
    );
  const e = nativeInvoiceJournalEntrySchema.parse(entry);
  const rows = z.array(nativeJournalLineSchema).max(1000).parse(lines);
  if (
    e.id !== r.entry_id ||
    e.source_posting_id !== r.id ||
    e.org_id !== r.org_id ||
    e.legal_entity_id !== r.legal_entity_id ||
    e.chart_id !== r.chart_id ||
    e.period_id !== r.period_id ||
    e.project_id !== r.project_id ||
    e.entry_date !== r.entry_date ||
    e.memo !== p.memo ||
    e.total_cents !== p.totalCents ||
    nativeReceiptTime(e.posted_at) !== nativeReceiptTime(r.posted_at) ||
    rows.length !== p.lines.length ||
    new Set(rows.map((l) => l.id)).size !== rows.length
  )
    throw Error(
      "Native invoice shared journal header or leg inventory differs",
    );
  for (const [i, l] of rows.entries()) {
    const intended = p.lines[i],
      dims = intended.dimensions ?? {};
    if (
      l.org_id !== r.org_id ||
      l.legal_entity_id !== r.legal_entity_id ||
      l.entry_id !== e.id ||
      l.chart_id !== r.chart_id ||
      l.project_id !== r.project_id ||
      l.position !== i + 1 ||
      l.account_id !== intended.accountId ||
      l.debit_cents !== intended.debitCents ||
      l.credit_cents !== intended.creditCents ||
      l.description !== (intended.description ?? null) ||
      l.company_id !== (intended.companyId ?? null) ||
      l.cost_code_id !== (dims.cost_code_id ?? null) ||
      booksDigest(l.dimensions) !== booksDigest(dims)
    )
      throw Error(
        "Native invoice journal leg differs from original source money",
      );
  }
  return { posting: r, entry: e, lines: rows, original, validated, plan: p };
}
