import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import { timestampMicros } from "./posting-state";
import {
  nativePostingContextSchema,
  nativeJournalDraftSchema,
  verifyNativeProjectPostingContext,
  buildNativeProjectPostingPlan,
} from "./native-posting-plan";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const note = z
  .string()
  .min(10)
  .max(2000)
  .refine((v) => v === v.trim());
const timestamp = z.string().refine((v) => timestampMicros(v) !== null);
const date = nativePostingContextSchema.shape.entryDate;
const scope = { id: uuid, org_id: uuid, legal_entity_id: uuid };
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeAdjustmentRequestSchema = z
  .object({
    context: nativePostingContextSchema,
    draft: nativeJournalDraftSchema,
  })
  .strict();
export const nativeAdjustmentFactSchema = z.object({
  ...scope,
  project_id: uuid,
  source_type: z.enum(["invoice", "vendor_bill", "expense"]),
  source_id: uuid,
  invoice_id: uuid.nullable(),
  bill_id: uuid.nullable(),
  expense_id: uuid.nullable(),
  owner_review_id: uuid,
  chart_id: uuid,
  period_id: uuid,
  entry_date: date,
  request_text: z.string().max(4194304),
  request_sha256: sha,
  validated_context_text: z.string().max(4194304),
  validated_context_sha256: sha,
  prepared_by: uuid,
  prepared_access_event_id: uuid,
  prepared_at: timestamp,
  notes: note,
});
export const nativeAdjustmentReviewSchema = z.object({
  ...scope,
  fact_id: uuid,
  decision: z.enum(["approve", "reject"]),
  entry_id: uuid.nullable(),
  request_sha256: sha,
  reviewed_by: uuid,
  reviewed_access_event_id: uuid,
  reviewed_at: timestamp,
  notes: note,
  validated_context_text: z.string().nullable(),
  validated_context_sha256: sha.nullable(),
});
export const nativeJournalEntrySchema = z.object({
  ...scope,
  fact_id: uuid,
  review_id: uuid,
  chart_id: uuid,
  period_id: uuid,
  project_id: uuid,
  entry_date: date,
  memo: z.string().max(2000),
  total_cents: z.number().int().positive().safe(),
  posted_at: timestamp,
});
export const nativeJournalLineSchema = z.object({
  ...scope,
  entry_id: uuid,
  chart_id: uuid,
  project_id: uuid,
  position: z.number().int().min(1).max(1000),
  account_id: uuid,
  debit_cents: z.number().int().safe().nonnegative(),
  credit_cents: z.number().int().safe().nonnegative(),
  description: z.string().nullable(),
  company_id: uuid.nullable(),
  cost_code_id: uuid.nullable(),
  dimensions: z.record(z.unknown()),
});
export const nativePeriodHoldSchema = z.object({
  ...scope,
  period_id: uuid,
  previous_id: uuid.nullable(),
  sequence_no: z.number().int().positive().safe(),
  decision: z.enum(["hold", "release"]),
  actor_id: uuid,
  access_event_id: uuid,
  recorded_at: timestamp,
  notes: note,
});
export function nativeReceiptTime(v: string) {
  const t = timestampMicros(v);
  if (t === null) throw Error("Invalid native accounting receipt timestamp");
  return t;
}
const rawSha = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function nativeContextMeaning(
  c: z.infer<typeof nativePostingContextSchema>,
) {
  const { capturedAt, databaseSnapshot, ...rest } = c;
  void capturedAt;
  void databaseSnapshot;
  return rest;
}
export function verifyNativeAdjustmentFact(value: unknown) {
  const f = nativeAdjustmentFactSchema.parse(value),
    request = nativeAdjustmentRequestSchema.parse(JSON.parse(f.request_text));
  const c = verifyNativeProjectPostingContext(request.context).context,
    validated = verifyNativeProjectPostingContext(
      JSON.parse(f.validated_context_text),
    ).context;
  if (
    rawSha(f.request_text) !== f.request_sha256 ||
    rawSha(f.validated_context_text) !== f.validated_context_sha256 ||
    Buffer.byteLength(f.request_text) > 4194304 ||
    booksDigest(nativeContextMeaning(c)) !==
      booksDigest(nativeContextMeaning(validated))
  )
    throw Error(
      "Native fact original request or validated snapshot digest differs",
    );
  if (
    f.org_id !== c.orgId ||
    f.legal_entity_id !== c.owner.legal_entity_id ||
    f.project_id !== c.projectId ||
    f.prepared_by !== c.actorId ||
    f.source_type !== c.sourceType ||
    f.source_id !== c.sourceId ||
    f.owner_review_id !== c.owner.id ||
    f.chart_id !== c.chart.id ||
    f.period_id !== c.period.id ||
    f.entry_date !== c.entryDate ||
    f.invoice_id !== (c.sourceType === "invoice" ? c.sourceId : null) ||
    f.bill_id !== (c.sourceType === "vendor_bill" ? c.sourceId : null) ||
    f.expense_id !== (c.sourceType === "expense" ? c.sourceId : null)
  )
    throw Error("Native fact owner, source, actor, chart or period differs");
  const d = request.draft;
  if (
    d.entryKind !== "adjusting" ||
    d.policyVersion !== 1 ||
    d.projectionVersion !== 1 ||
    d.postingKey !== "native-adjustment:" + f.id ||
    d.memo.length < 10
  )
    throw Error("Native adjustment policy or request identity differs");
  if (
    nativeReceiptTime(c.capturedAt) > nativeReceiptTime(f.prepared_at) ||
    nativeReceiptTime(validated.capturedAt) > nativeReceiptTime(f.prepared_at)
  )
    throw Error("Native fact validation occurs after preparation");
  for (const l of d.lines) {
    const dims = l.dimensions ?? {};
    if (
      Object.keys(dims).some((k) => !["project_id", "cost_code_id"].includes(k))
    )
      throw Error("Unsupported native adjustment dimension witness");
    if (dims.cost_code_id !== undefined) uuid.parse(dims.cost_code_id);
  }
  const plan = buildNativeProjectPostingPlan(c, d).plan;
  return { fact: f, request, validated, plan };
}
export function verifyNativeAdjustmentReview(
  fact: unknown,
  review: unknown,
  entry: unknown,
  lines: unknown,
) {
  const verified = verifyNativeAdjustmentFact(fact),
    f = verified.fact,
    r = nativeAdjustmentReviewSchema.parse(review),
    rows = z.array(nativeJournalLineSchema).parse(lines);
  if (
    r.org_id !== f.org_id ||
    r.legal_entity_id !== f.legal_entity_id ||
    r.fact_id !== f.id ||
    r.reviewed_by === f.prepared_by ||
    r.request_sha256 !== f.request_sha256 ||
    nativeReceiptTime(r.reviewed_at) < nativeReceiptTime(f.prepared_at)
  )
    throw Error(
      "Native independent approval receipt differs from original fact",
    );
  if (r.decision === "reject") {
    if (
      r.entry_id !== null ||
      entry !== null ||
      rows.length ||
      r.validated_context_text !== null ||
      r.validated_context_sha256 !== null
    )
      throw Error(
        "Rejected native adjustment has journal money or approval witness",
      );
    return { ...verified, review: r, entry: null, lines: rows };
  }
  if (
    r.validated_context_text === null ||
    rawSha(r.validated_context_text) !== r.validated_context_sha256
  )
    throw Error("Native approval context digest differs");
  const c = verifyNativeProjectPostingContext(
    JSON.parse(r.validated_context_text),
  ).context;
  if (
    booksDigest(nativeContextMeaning(c)) !==
      booksDigest(nativeContextMeaning(verified.request.context)) ||
    nativeReceiptTime(c.capturedAt) > nativeReceiptTime(r.reviewed_at)
  )
    throw Error(
      "Native approval snapshot differs from original prepared request",
    );
  const e = nativeJournalEntrySchema.parse(entry),
    p = verified.plan;
  if (
    e.id !== r.entry_id ||
    e.org_id !== f.org_id ||
    e.legal_entity_id !== f.legal_entity_id ||
    e.fact_id !== f.id ||
    e.review_id !== r.id ||
    e.chart_id !== f.chart_id ||
    e.period_id !== f.period_id ||
    e.project_id !== f.project_id ||
    e.entry_date !== f.entry_date ||
    e.memo !== p.memo ||
    e.total_cents !== p.totalCents ||
    nativeReceiptTime(e.posted_at) !== nativeReceiptTime(r.reviewed_at) ||
    rows.length !== p.lines.length ||
    new Set(rows.map((l) => l.id)).size !== rows.length
  )
    throw Error("Native journal header or retained leg inventory differs");
  for (const [i, l] of rows.entries()) {
    const original = p.lines[i],
      dims = original.dimensions ?? {};
    if (
      l.org_id !== f.org_id ||
      l.legal_entity_id !== f.legal_entity_id ||
      l.entry_id !== e.id ||
      l.chart_id !== f.chart_id ||
      l.project_id !== f.project_id ||
      l.position !== i + 1 ||
      l.account_id !== original.accountId ||
      l.debit_cents !== original.debitCents ||
      l.credit_cents !== original.creditCents ||
      l.description !== (original.description ?? null) ||
      l.company_id !== (original.companyId ?? null) ||
      l.cost_code_id !== (dims.cost_code_id ?? null) ||
      booksDigest(l.dimensions) !== booksDigest(dims)
    )
      throw Error("Native journal leg differs from original reviewed intent");
  }
  return { ...verified, review: r, entry: e, lines: rows };
}
