import { z } from "zod";
import { createHash } from "node:crypto";
import {
  nativeInvoiceIncomeRequestSchema,
  nativeInvoiceIncomeSelectionSchema,
  verifyNativeInvoiceIncomeSelection,
} from "./native-invoice-income-contract";
import { verifyNativeInvoiceEconomicContext } from "./native-invoice-economics";
import { nativeReceiptTime } from "./native-adjustment-contract";
import { booksDigest } from "./hash";
import { verifyNativeContextArchive } from "./native-context-archive";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const reason = z
  .string()
  .min(10)
  .max(2000)
  .refine((v) => v === v.trim());
export const NATIVE_INVOICE_INCOME_RESOLUTION_TABLE =
  "books_native_invoice_income_resolutions" as const;
export const nativeIncomeResolutionInputSchema = z
  .object({ id: uuid, request: nativeInvoiceIncomeRequestSchema, reason })
  .strict();
export const nativeIncomeCancellationSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  actor_id: uuid,
  request_id: uuid,
  request_text: z.string().max(8400000),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason,
  resolved_at: z.string(),
  resolved_access_event_id: uuid,
});
export function verifyNativeIncomeCancellation(value: unknown) {
  const r = nativeIncomeCancellationSchema.parse(value),
    q = nativeInvoiceIncomeRequestSchema.parse(JSON.parse(r.request_text));
  const c = verifyNativeInvoiceEconomicContext(q.economic).economic.native;
  if (
    Buffer.byteLength(r.request_text) > 8400000 ||
    createHash("sha256").update(r.request_text).digest("hex") !==
      r.request_sha256
  )
    throw Error("Native income cancellation digest differs");
  if (
    r.request_id !== q.id ||
    r.org_id !== q.expectedOrgId ||
    r.actor_id !== q.expectedActorId ||
    r.legal_entity_id !== c.owner.legal_entity_id ||
    r.project_id !== c.projectId ||
    r.invoice_id !== c.sourceId
  )
    throw Error("Native income cancellation scope differs");
  if (nativeReceiptTime(c.capturedAt) > nativeReceiptTime(r.resolved_at))
    throw Error("Native income cancellation witness is from the future");
  return { resolution: r, request: q };
}
const response = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("committed_original"),
    resolution: z.null(),
    selection: nativeInvoiceIncomeSelectionSchema,
    coded: z.literal(true),
    posted: z.literal(false),
    ledgerActivated: z.literal(false),
  }),
  z.object({
    outcome: z.literal("cancelled"),
    resolution: nativeIncomeCancellationSchema,
    selection: z.null(),
    coded: z.literal(false),
    posted: z.literal(false),
    ledgerActivated: z.literal(false),
  }),
]);
export function verifyNativeIncomeResolution(value: unknown, input: unknown) {
  const q = nativeIncomeResolutionInputSchema.parse(input),
    r = response.parse(value);
  if (r.outcome === "committed_original") {
    if (
      booksDigest(verifyNativeInvoiceIncomeSelection(r.selection).request) !==
      booksDigest(q.request)
    )
      throw Error("Recovered income selection differs from original intent");
  } else {
    const verified = verifyNativeIncomeCancellation(r.resolution);
    if (
      r.resolution.id !== q.id ||
      r.resolution.reason !== q.reason ||
      booksDigest(verified.request) !== booksDigest(q.request)
    )
      throw Error("Income cancellation differs from original decision");
  }
  return r;
}
export function verifyNativeIncomeResolutionArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  const rows = tables[NATIVE_INVOICE_INCOME_RESOLUTION_TABLE];
  if (version < 29)
    return rows?.length
      ? ["Native income cancellations require archive schema29"]
      : [];
  try {
    if (!rows) throw Error("Missing native income cancellation history");
    const ids = new Set<string>(),
      nonces = new Set<string>();
    for (const raw of rows) {
      const { resolution: r, request: q } = verifyNativeIncomeCancellation(raw);
      if (r.org_id !== org || ids.has(r.id) || nonces.has(r.request_id))
        throw Error("Foreign or duplicate native income cancellation");
      ids.add(r.id);
      nonces.add(r.request_id);
      verifyNativeContextArchive(q.economic.native, tables, org, false);
      if (
        tables.books_native_invoice_income_selections?.some(
          (s) => s.id === r.request_id,
        )
      )
        throw Error("Cancelled native income nonce also committed coding");
      const time = nativeReceiptTime(r.resolved_at),
        events = tables.books_legal_entity_access_history ?? [];
      const event = events.find(
        (e) =>
          e.org_id === org &&
          e.id === r.resolved_access_event_id &&
          e.legal_entity_id === r.legal_entity_id &&
          e.user_id === r.actor_id,
      );
      if (
        !event ||
        !["prepare", "manage"].includes(String(event.access_level)) ||
        nativeReceiptTime(String(event.changed_at)) > time ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === r.legal_entity_id &&
            e.user_id === r.actor_id &&
            BigInt(String(e.sequence_no)) > BigInt(String(event.sequence_no)) &&
            nativeReceiptTime(String(e.changed_at)) <= time,
        )
      )
        throw Error("Native income cancellation historical authority differs");
    }
    return [];
  } catch (e) {
    return [
      "Invalid native income cancellation history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
