import { z } from "zod";
import { createHash } from "node:crypto";
import { booksDigest } from "./hash";
import {
  nativeContextMeaning,
  nativeReceiptTime,
} from "./native-adjustment-contract";
import {
  nativeInvoiceEconomicSchema,
  verifyNativeInvoiceEconomicContext,
} from "./native-invoice-economics";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const NATIVE_INVOICE_INCOME_TABLE =
  "books_native_invoice_income_selections" as const;
export const nativeInvoiceIncomeRequestSchema = z
  .object({
    id: uuid,
    expectedOrgId: uuid,
    expectedActorId: uuid,
    economic: nativeInvoiceEconomicSchema,
    assignments: z
      .array(z.object({ lineId: uuid, accountId: uuid.nullable() }).strict())
      .min(1)
      .max(1000),
    notes: z
      .string()
      .min(10)
      .max(2000)
      .refine((s) => s === s.trim()),
  })
  .strict()
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8400000)
  .refine(
    (v) =>
      v.economic.native.sourceType === "invoice" &&
      v.economic.native.orgId === v.expectedOrgId &&
      v.economic.native.actorId === v.expectedActorId,
    "Native income request differs from expected actor/source",
  );
export const nativeInvoiceIncomeSelectionSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  actor_id: uuid,
  owner_review_id: uuid,
  chart_id: uuid,
  period_id: uuid,
  access_event_id: uuid,
  request_text: z.string().max(8400000),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  result_text: z.string().max(8400000),
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  selected_at: z.string(),
  selection_revision: z.number().int().positive().safe(),
});
export function verifyNativeInvoiceIncomeSelection(value: unknown) {
  const r = nativeInvoiceIncomeSelectionSchema.parse(value),
    q = nativeInvoiceIncomeRequestSchema.parse(JSON.parse(r.request_text));
  const before = verifyNativeInvoiceEconomicContext(q.economic).economic,
    after = verifyNativeInvoiceEconomicContext(
      JSON.parse(r.result_text),
    ).economic,
    c = before.native;
  for (const [text, digest] of [
    [r.request_text, r.request_sha256],
    [r.result_text, r.result_sha256],
  ])
    if (
      Buffer.byteLength(text) > 8400000 ||
      createHash("sha256").update(text).digest("hex") !== digest
    )
      throw Error("Native income selection digest differs");
  if (
    r.id !== q.id ||
    r.org_id !== q.expectedOrgId ||
    r.actor_id !== q.expectedActorId ||
    r.org_id !== c.orgId ||
    r.actor_id !== c.actorId ||
    c.sourceType !== "invoice" ||
    r.legal_entity_id !== c.owner.legal_entity_id ||
    r.project_id !== c.projectId ||
    r.invoice_id !== c.sourceId ||
    r.owner_review_id !== c.owner.id ||
    r.chart_id !== c.chart.id ||
    r.period_id !== c.period.id
  )
    throw Error("Native income selection scope differs");
  const priced = before.lines.filter(
    (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
  );
  if (
    priced.length !== q.assignments.length ||
    new Set(q.assignments.map((a) => a.lineId)).size !== priced.length
  )
    throw Error(
      "Native income selection inventory is incomplete or duplicated",
    );
  const codes = JSON.parse(c.chart.definition_text).controls;
  for (const a of q.assignments) {
    const line = priced.find((l) => l.source.id === a.lineId);
    const account =
      a.accountId === null
        ? c.accounts.find((v) => v.code === codes.constructionRevenue)
        : c.accounts.find((v) => v.id === a.accountId);
    if (!line || !account || account.definition.account_type !== "income")
      throw Error(
        "Native income selection is outside the reviewed source/chart",
      );
  }
  const expected = structuredClone(before);
  for (const a of q.assignments) {
    const line = expected.lines.find((l) => l.source.id === a.lineId)!;
    const {
      arc_books_gl_account_id,
      arc_books_entity_account_id,
      ...metadata
    } = line.source.metadata ?? {};
    void arc_books_gl_account_id;
    void arc_books_entity_account_id;
    line.source.metadata = {
      ...metadata,
      arc_books_entity_income_selection_id: r.id,
      ...(a.accountId ? { arc_books_entity_account_id: a.accountId } : {}),
    };
  }
  const meaning = (e: typeof before) => ({
    ...e,
    native: nativeContextMeaning(e.native),
  });
  if (booksDigest(meaning(expected)) !== booksDigest(meaning(after)))
    throw Error(
      "Native income selection result changes unrelated source evidence",
    );
  const at = nativeReceiptTime(r.selected_at);
  if (
    nativeReceiptTime(c.capturedAt) > at ||
    nativeReceiptTime(after.native.capturedAt) > at
  )
    throw Error("Native income selection witness is from the future");
  return { selection: r, request: q, economic: after };
}
