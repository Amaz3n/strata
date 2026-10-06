import { z } from "zod";
import {
  nativeInvoiceRecoveryKey,
  nativeInvoiceIncomeRecoveryKey,
  readNativeInvoiceRecovery,
  type NativeInvoiceRecoveryScope,
  type NativeInvoiceRecoveryLocks,
} from "./native-invoice-recovery";
// Browser contracts must not import server/Node code. Keep the exact original
// intent until a complete independently checked receipt or cancellation arrives.
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const reason = z
  .string()
  .min(10)
  .max(2000)
  .refine((v) => v === v.trim());
const requestSchema = z
  .object({
    id: uuid,
    expectedOrgId: uuid,
    expectedActorId: uuid,
    economic: z.record(z.unknown()),
    assignments: z
      .array(z.object({ lineId: uuid, accountId: uuid.nullable() }).strict())
      .min(1)
      .max(1000),
    notes: reason,
  })
  .strict();
const decisionSchema = z.object({ id: uuid, reason }).strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    request: requestSchema,
    resolution: decisionSchema.optional(),
  })
  .strict();
export type NativeInvoiceIncomeRecovery = z.infer<typeof recordSchema>;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const requestMax = 8400000;
const max = requestMax + 4096; // Request plus durable resolution envelope.
function canonical(v: unknown): string {
  if (v === undefined) throw Error("Undefined coding witness");
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
      .join(",") +
    "}"
  );
}
async function sha(v: string) {
  if (!globalThis.crypto?.subtle)
    throw Error("Browser cannot verify coding receipts");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function scoped(scope: NativeInvoiceRecoveryScope, value: unknown) {
  const r = recordSchema.parse(value),
    n = z
      .object({
        orgId: uuid,
        actorId: uuid,
        projectId: uuid,
        sourceId: uuid,
        sourceType: z.literal("invoice"),
        owner: z.object({ legal_entity_id: uuid }),
        source: z.object({ id: uuid, org_id: uuid, project_id: uuid }),
      })
      .passthrough()
      .parse(r.request.economic.native);
  if (
    r.request.expectedOrgId !== scope.orgId ||
    r.request.expectedActorId !== scope.actorId ||
    n.orgId !== scope.orgId ||
    n.actorId !== scope.actorId ||
    n.projectId !== scope.projectId ||
    n.owner.legal_entity_id !== scope.entityId ||
    n.sourceId !== scope.invoiceId ||
    n.source.id !== scope.invoiceId ||
    n.source.org_id !== scope.orgId ||
    n.source.project_id !== scope.projectId
  )
    throw Error("Saved income intent belongs to another scope");
  if (
    new TextEncoder().encode(JSON.stringify(r)).byteLength > max ||
    new TextEncoder().encode(JSON.stringify(r.request)).byteLength > requestMax
  )
    throw Error("Saved income intent is too large");
  return r;
}
export function readNativeInvoiceIncomeRecovery(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
) {
  const raw = storage.getItem(nativeInvoiceIncomeRecoveryKey(scope));
  if (raw === null) return null;
  if (raw.length > max) throw Error("Saved income intent is too large");
  return scoped(scope, JSON.parse(raw));
}
function save(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
  value: unknown,
) {
  const r = scoped(scope, value),
    old = readNativeInvoiceIncomeRecovery(storage, scope),
    raw = JSON.stringify(r);
  if (old && canonical(old) !== canonical(r))
    throw Error("Resolve the saved income intent before creating another");
  storage.setItem(nativeInvoiceIncomeRecoveryKey(scope), raw);
  if (storage.getItem(nativeInvoiceIncomeRecoveryKey(scope)) !== raw)
    throw Error("Income intent could not be saved; no request sent");
  return r;
}
const common = z.object({
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  invoice_id: uuid,
  actor_id: uuid,
  request_text: z.string().max(requestMax),
  request_sha256: z.string(),
  id: uuid,
});
function matchScope(
  scope: NativeInvoiceRecoveryScope,
  r: z.infer<typeof common>,
) {
  if (
    r.org_id !== scope.orgId ||
    r.legal_entity_id !== scope.entityId ||
    r.project_id !== scope.projectId ||
    r.invoice_id !== scope.invoiceId ||
    r.actor_id !== scope.actorId
  )
    throw Error("Coding receipt scope differs");
}
function timestamp(value: unknown) {
  const time = Date.parse(z.string().parse(value));
  if (!Number.isFinite(time)) throw Error("Invalid income receipt timestamp");
  return time;
}
function meaning(value: unknown) {
  const v = z.record(z.unknown()).parse(value),
    n = z.record(z.unknown()).parse(v.native);
  const { capturedAt, databaseSnapshot, ...rest } = n;
  void capturedAt;
  void databaseSnapshot;
  return { ...v, native: rest };
}
export async function verifyNativeInvoiceIncomeRecovery(
  scope: NativeInvoiceRecoveryScope,
  value: NativeInvoiceIncomeRecovery,
  response: unknown,
  resolving = false,
) {
  const record = scoped(scope, value),
    head = z
      .object({
        posted: z.literal(false),
        ledgerActivated: z.literal(false),
        coded: z.boolean(),
        outcome: z.enum(["committed_original", "cancelled"]).optional(),
      })
      .parse(response);
  const body = z.record(z.unknown()).parse(response);
  if (resolving && (!record.resolution || !head.outcome))
    throw Error("Missing original income resolution decision");
  if (!resolving && head.outcome)
    throw Error("Unexpected coding resolution response");
  if (head.outcome === "cancelled") {
    if (head.coded || body.selection !== null)
      throw Error("Cancellation cannot claim income coding");
    const r = common
      .extend({
        request_id: uuid,
        reason,
        resolved_at: z.string(),
        resolved_access_event_id: uuid,
      })
      .parse(body.resolution);
    matchScope(scope, r);
    if (
      timestamp(
        z.record(z.unknown()).parse(record.request.economic.native).capturedAt,
      ) > timestamp(r.resolved_at)
    )
      throw Error("Cancellation source witness is from the future");
    if (
      r.id !== record.resolution?.id ||
      r.reason !== record.resolution.reason ||
      r.request_id !== record.request.id ||
      (await sha(r.request_text)) !== r.request_sha256 ||
      canonical(JSON.parse(r.request_text)) !== canonical(record.request)
    )
      throw Error("Coding cancellation differs from saved decision");
    return body;
  }
  if (!head.coded || (resolving && body.resolution !== null))
    throw Error("Original coding receipt is required");
  const r = common
    .extend({
      result_text: z.string().max(requestMax),
      result_sha256: z.string(),
      chart_id: uuid,
      period_id: uuid,
      owner_review_id: uuid,
      access_event_id: uuid,
      selected_at: z.string(),
      selection_revision: z.number().int().positive().safe(),
    })
    .parse(body.selection);
  matchScope(scope, r);
  if (
    r.id !== record.request.id ||
    (await sha(r.request_text)) !== r.request_sha256 ||
    (await sha(r.result_text)) !== r.result_sha256 ||
    canonical(JSON.parse(r.request_text)) !== canonical(record.request)
  )
    throw Error("Coding receipt differs from original intent");
  const expected = structuredClone(record.request.economic),
    n = z
      .object({
        chart: z.object({ id: uuid, definition_text: z.string() }),
        period: z.object({ id: uuid }),
        owner: z.object({ id: uuid }),
        accounts: z.array(
          z.object({
            id: uuid,
            code: z.string(),
            definition: z.object({ account_type: z.string() }),
          }),
        ),
      })
      .passthrough()
      .parse(expected.native);
  if (
    r.chart_id !== n.chart.id ||
    r.period_id !== n.period.id ||
    r.owner_review_id !== n.owner.id
  )
    throw Error("Coding receipt definitions differ");
  const lines = z
    .array(
      z
        .object({
          source: z
            .object({ id: uuid, metadata: z.record(z.unknown()).nullish() })
            .passthrough(),
        })
        .passthrough(),
    )
    .parse(expected.lines);
  const priced = lines.filter(
    (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
  );
  if (
    priced.length !== record.request.assignments.length ||
    new Set(record.request.assignments.map((a) => a.lineId)).size !==
      priced.length
  )
    throw Error("Coding line inventory differs");
  for (const assignment of record.request.assignments) {
    const line = priced.find((l) => l.source.id === assignment.lineId),
      code = JSON.parse(n.chart.definition_text).controls.constructionRevenue;
    const account = n.accounts.find((a) =>
      assignment.accountId ? a.id === assignment.accountId : a.code === code,
    );
    if (!line || account?.definition.account_type !== "income")
      throw Error("Coding choice is outside reviewed income chart");
    const metadata = { ...(line.source.metadata ?? {}) };
    delete metadata.arc_books_gl_account_id;
    delete metadata.arc_books_entity_account_id;
    line.source.metadata = {
      ...metadata,
      arc_books_entity_income_selection_id: r.id,
      ...(assignment.accountId
        ? { arc_books_entity_account_id: assignment.accountId }
        : {}),
    };
  }
  expected.lines = lines;
  if (
    timestamp(z.record(z.unknown()).parse(expected.native).capturedAt) >
      timestamp(r.selected_at) ||
    timestamp(
      z
        .record(z.unknown())
        .parse(z.record(z.unknown()).parse(JSON.parse(r.result_text)).native)
        .capturedAt,
    ) > timestamp(r.selected_at)
  )
    throw Error("Coding source witness is from the future");
  if (
    canonical(meaning(expected)) !==
    canonical(meaning(JSON.parse(r.result_text)))
  )
    throw Error("Coding result changes unrelated source evidence");
  return body;
}
async function acknowledge(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
  r: NativeInvoiceIncomeRecovery,
  outcome: string,
) {
  const current = readNativeInvoiceIncomeRecovery(storage, scope);
  if (!current || canonical(current) !== canonical(r))
    throw Error("Saved coding intent changed before acknowledgement");
  const key =
      nativeInvoiceIncomeRecoveryKey(scope) + ":outcome:" + r.request.id,
    summary = JSON.stringify({
      version: 1,
      requestId: r.request.id,
      resolutionId: r.resolution?.id ?? null,
      outcome,
      requestSha256: await sha(canonical(r.request)),
      ledgerActivated: false,
    });
  storage.setItem(key, summary);
  if (storage.getItem(key) !== summary)
    throw Error("Coding confirmation could not be saved");
  if (
    canonical(readNativeInvoiceIncomeRecovery(storage, scope)) !== canonical(r)
  )
    throw Error("Coding intent changed while recording confirmation");
  storage.removeItem(nativeInvoiceIncomeRecoveryKey(scope));
  if (storage.getItem(nativeInvoiceIncomeRecoveryKey(scope)) !== null)
    throw Error("Coding acknowledgement failed");
}
type Transport = (
  r: NativeInvoiceIncomeRecovery,
) => Promise<
  { success: true; data: unknown } | { success: false; error: string }
>;
export async function submitNativeInvoiceIncomeRecovery(input: {
  storage: Store;
  scope: NativeInvoiceRecoveryScope;
  record: NativeInvoiceIncomeRecovery;
  locks: NativeInvoiceRecoveryLocks | undefined;
  transport: Transport;
  decision?: z.infer<typeof decisionSchema>;
  onSaved?: (r: NativeInvoiceIncomeRecovery) => void;
}) {
  if (!input.locks)
    throw Error("Browser cannot safely coordinate income requests");
  return input.locks.request(
    nativeInvoiceRecoveryKey(input.scope),
    async () => {
      let r = scoped(input.scope, input.record);
      const old = readNativeInvoiceIncomeRecovery(input.storage, input.scope);
      if (input.decision) {
        if (!old || canonical(old) !== canonical(r))
          throw Error(
            "Original saved income intent is required for resolution",
          );
        const decision = decisionSchema.parse(input.decision);
        if (old.resolution && canonical(old.resolution) !== canonical(decision))
          throw Error("Recover the original income resolution decision");
        r = scoped(input.scope, { ...r, resolution: decision });
        const raw = JSON.stringify(r);
        input.storage.setItem(nativeInvoiceIncomeRecoveryKey(input.scope), raw);
        if (
          input.storage.getItem(nativeInvoiceIncomeRecoveryKey(input.scope)) !==
          raw
        )
          throw Error("Income resolution decision could not be saved");
      } else {
        if (r.resolution)
          throw Error("Recover the saved income resolution decision");
        if (readNativeInvoiceRecovery(input.storage, input.scope))
          throw Error(
            "Resolve the saved invoice posting before selecting income",
          );
        r = save(input.storage, input.scope, r);
      }
      input.onSaved?.(r);
      const result = await input.transport(r);
      if (!result.success) throw Error(result.error);
      const verified = await verifyNativeInvoiceIncomeRecovery(
        input.scope,
        r,
        result.data,
        !!r.resolution,
      );
      await acknowledge(
        input.storage,
        input.scope,
        r,
        String(verified.outcome ?? "committed_original"),
      );
      return verified;
    },
  );
}
