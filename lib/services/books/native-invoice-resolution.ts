import { createHash } from "node:crypto";
import { z } from "zod";
import { nativeInvoicePostingRequestSchema } from "./native-invoice-request";
import { nativeReceiptTime } from "./native-adjustment-contract";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const NATIVE_INVOICE_RESOLUTION_TABLE =
  "books_native_invoice_request_resolutions" as const;
export const nativeInvoiceResolutionSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  actor_id: uuid,
  request_id: uuid,
  entry_id: uuid,
  request_text: z.string().max(4198400),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z
    .string()
    .min(10)
    .max(2000)
    .refine((v) => v === v.trim()),
  resolved_at: z.string(),
  resolved_access_event_id: uuid,
});
export function verifyNativeInvoiceResolution(value: unknown) {
  const r = nativeInvoiceResolutionSchema.parse(value),
    q = nativeInvoicePostingRequestSchema.parse(JSON.parse(r.request_text)),
    c = q.economic.native;
  if (
    Buffer.byteLength(r.request_text) > 4198400 ||
    createHash("sha256").update(r.request_text).digest("hex") !==
      r.request_sha256 ||
    r.org_id !== q.expectedOrgId ||
    r.actor_id !== q.expectedActorId ||
    r.org_id !== c.orgId ||
    r.actor_id !== c.actorId ||
    c.sourceType !== "invoice" ||
    r.legal_entity_id !== c.owner.legal_entity_id ||
    r.project_id !== c.projectId ||
    r.invoice_id !== c.sourceId ||
    r.request_id !== q.id ||
    r.entry_id !== q.entryId
  )
    throw Error("Native invoice cancellation scope/request/digest differs");
  nativeReceiptTime(r.resolved_at);
  return { resolution: r, request: q };
}
export function verifyNativeInvoiceResolutionArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  const rows = tables[NATIVE_INVOICE_RESOLUTION_TABLE];
  if (version < 27)
    return rows?.length
      ? ["Native invoice cancellations require archive schema27"]
      : [];
  try {
    if (!rows) throw Error("Missing native invoice cancellation history");
    const ids = new Set(),
      nonces = new Set();
    for (const raw of rows) {
      const { resolution: r } = verifyNativeInvoiceResolution(raw);
      if (r.org_id !== org || ids.has(r.id) || nonces.has(r.request_id))
        throw Error("Foreign/duplicate native invoice cancellation");
      ids.add(r.id);
      nonces.add(r.request_id);
      if (
        !tables.invoices?.some(
          (i) => i.org_id === org && i.id === r.invoice_id,
        ) ||
        !tables.projects?.some(
          (p) => p.org_id === org && p.id === r.project_id,
        ) ||
        !tables.books_project_entity_reviews?.some(
          (p) =>
            p.org_id === org &&
            p.project_id === r.project_id &&
            p.legal_entity_id === r.legal_entity_id,
        )
      )
        throw Error(
          "Native invoice cancellation source/entity/project is missing",
        );
      if (
        tables.books_native_invoice_postings?.some((p) => p.id === r.request_id)
      )
        throw Error("Cancelled native invoice nonce also has committed money");
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
        throw Error("Native invoice cancellation historical authority differs");
    }
    return [];
  } catch (e) {
    return [
      "Invalid native invoice cancellation history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
