import { z } from "zod";
// Browser-only recovery contracts deliberately import no server or Node modules.
// The server independently derives and verifies money; browser acknowledgement
// checks exact saved intent plus original receipt/draft hashes and complete legs.
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const scopeSchema = z
  .object({
    orgId: uuid,
    actorId: uuid,
    projectId: uuid,
    entityId: uuid,
    invoiceId: uuid,
  })
  .strict();
export type NativeInvoiceRecoveryScope = z.infer<typeof scopeSchema>;
const decisionSchema = z
  .object({
    id: uuid,
    reason: z
      .string()
      .min(10)
      .max(2000)
      .refine((v) => v === v.trim()),
  })
  .strict();
const requestSchema = z
  .object({
    expectedOrgId: uuid,
    expectedActorId: uuid,
    id: uuid,
    entryId: uuid,
    economic: z.record(z.unknown()),
    notes: z
      .string()
      .min(10)
      .max(2000)
      .refine((v) => v === v.trim()),
  })
  .strict();
export const nativeInvoiceRecoverySchema = z
  .object({
    version: z.literal(1),
    request: requestSchema,
    resolution: decisionSchema.optional(),
  })
  .strict();
export type NativeInvoiceRecovery = z.infer<typeof nativeInvoiceRecoverySchema>;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type NativeInvoiceRecoveryLocks = {
  request: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
};
const maximum = 8400000;
function bytes(v: string) {
  return new TextEncoder().encode(v).byteLength;
}
function canonical(v: unknown): string {
  if (v === undefined) throw Error("Undefined accounting witness value");
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
    throw Error("This browser cannot verify accounting receipts");
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function nativeInvoiceRecoveryKey(scope: NativeInvoiceRecoveryScope) {
  const s = scopeSchema.parse(scope);
  // Source identity, rather than the current project/entity, keeps an older
  // uncertain request discoverable when the source moves between workflows.
  return `arc:native-invoice-request:v1:${s.orgId}:${s.actorId}:${s.invoiceId}`;
}
export function nativeInvoiceIncomeRecoveryKey(
  scope: NativeInvoiceRecoveryScope,
) {
  const s = scopeSchema.parse(scope);
  return `arc:native-invoice-income-request:v1:${s.orgId}:${s.actorId}:${s.invoiceId}`;
}
function scoped(scope: NativeInvoiceRecoveryScope, value: unknown) {
  const s = scopeSchema.parse(scope),
    r = nativeInvoiceRecoverySchema.parse(value);
  const c = z
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
    r.request.expectedOrgId !== s.orgId ||
    r.request.expectedActorId !== s.actorId ||
    c.orgId !== s.orgId ||
    c.actorId !== s.actorId ||
    c.projectId !== s.projectId ||
    c.owner.legal_entity_id !== s.entityId ||
    c.sourceId !== s.invoiceId ||
    c.source.id !== s.invoiceId ||
    c.source.org_id !== s.orgId ||
    c.source.project_id !== s.projectId
  )
    throw Error(
      "Saved invoice request belongs to another organization, actor, project or entity",
    );
  if (
    bytes(JSON.stringify(r)) > maximum ||
    bytes(JSON.stringify(r.request.economic)) > 4194304
  )
    throw Error("Saved invoice request exceeds the supported size");
  return r;
}
export function readNativeInvoiceRecovery(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
) {
  const raw = storage.getItem(nativeInvoiceRecoveryKey(scope));
  if (raw === null) return null;
  if (raw.length > maximum) throw Error("Saved invoice request is too large");
  return scoped(scope, JSON.parse(raw));
}
export function persistNativeInvoiceRecovery(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
  value: NativeInvoiceRecovery,
) {
  const r = scoped(scope, value),
    old = readNativeInvoiceRecovery(storage, scope),
    encoded = JSON.stringify(r);
  if (old && canonical(old) !== canonical(r))
    throw Error("Resolve the saved invoice request before creating another");
  storage.setItem(nativeInvoiceRecoveryKey(scope), encoded);
  if (storage.getItem(nativeInvoiceRecoveryKey(scope)) !== encoded)
    throw Error("Invoice request could not be saved; no request was sent");
  return r;
}
const postingSchema = z
  .object({
    id: uuid,
    org_id: uuid,
    legal_entity_id: uuid,
    project_id: uuid,
    invoice_id: uuid,
    entry_id: uuid,
    income_selection_id: uuid.nullable().optional(),
    posted_by: uuid,
    notes: z.string(),
    request_text: z.string().max(maximum),
    request_sha256: z.string(),
    validated_economic_text: z.string().max(maximum),
    validated_economic_sha256: z.string(),
    draft_text: z.string().max(maximum),
    draft_sha256: z.string(),
    chart_id: uuid,
    period_id: uuid,
    entry_date: z.string(),
    posted_at: z.string(),
  })
  .passthrough();
const entrySchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  source_posting_id: uuid,
  fact_id: z.null(),
  review_id: z.null(),
  chart_id: uuid,
  period_id: uuid,
  entry_date: z.string(),
  memo: z.string(),
  total_cents: z.number().int().positive().safe(),
  posted_at: z.string(),
});
const cents = z.number().int().nonnegative().safe();
const lineSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  entry_id: uuid,
  chart_id: uuid,
  position: z.number().int().min(1).max(1000),
  account_id: uuid,
  debit_cents: cents,
  credit_cents: cents,
  description: z.string().nullable(),
  company_id: uuid.nullable(),
  cost_code_id: uuid.nullable(),
  dimensions: z.record(z.unknown()),
});
export async function verifyNativeInvoiceRecoveryPosting(
  scope: NativeInvoiceRecoveryScope,
  value: NativeInvoiceRecovery,
  response: unknown,
) {
  const r = scoped(scope, value),
    d = z
      .object({
        posted: z.literal(true),
        ledgerActivated: z.literal(false),
        posting: postingSchema,
        entry: entrySchema,
        lines: z.array(lineSchema).min(2).max(1000),
      })
      .parse(response),
    p = d.posting,
    e = d.entry;
  for (const [text, digest] of [
    [p.request_text, p.request_sha256],
    [p.validated_economic_text, p.validated_economic_sha256],
    [p.draft_text, p.draft_sha256],
  ])
    if ((await sha(text)) !== digest)
      throw Error("Native invoice receipt digest differs");
  if (
    p.id !== r.request.id ||
    p.entry_id !== r.request.entryId ||
    p.org_id !== scope.orgId ||
    p.legal_entity_id !== scope.entityId ||
    p.project_id !== scope.projectId ||
    p.invoice_id !== scope.invoiceId ||
    p.posted_by !== scope.actorId ||
    p.notes !== r.request.notes ||
    canonical(JSON.parse(p.request_text)) !== canonical(r.request.economic)
  )
    throw Error("Committed invoice receipt differs from saved intent");
  const originLines = z
    .array(
      z.object({
        source: z.object({ metadata: z.record(z.unknown()).nullish() }),
      }),
    )
    .parse(r.request.economic.lines);
  const origins = new Set(
    originLines
      .filter(
        (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
      )
      .map((l) => l.source.metadata?.arc_books_entity_income_selection_id)
      .filter((v) => v != null),
  );
  if (
    origins.size > 1 ||
    (origins.size && !origins.has(p.income_selection_id ?? ""))
  )
    throw Error("Native invoice selection origin differs from saved source");
  const native = z
    .object({
      chart: z.object({ id: uuid, definition_text: z.string() }),
      period: z.object({ id: uuid }),
      entryDate: z.string(),
      accounts: z.array(z.object({ id: uuid, code: z.string() })).min(1),
    })
    .passthrough()
    .parse(r.request.economic.native);
  const meaning = (v: unknown) => {
    const body = z.record(z.unknown()).parse(v),
      n = z.record(z.unknown()).parse(body.native);
    const { capturedAt, databaseSnapshot, ...rest } = n;
    void capturedAt;
    void databaseSnapshot;
    return { ...body, native: rest };
  };
  if (
    canonical(meaning(JSON.parse(p.validated_economic_text))) !==
    canonical(meaning(r.request.economic))
  )
    throw Error("Validated invoice snapshot differs from saved intent");
  const draft = z
    .object({
      entryDate: z.string(),
      entryKind: z.literal("operational"),
      memo: z.string(),
      postingKey: z.string(),
      sourceType: z.literal("invoice"),
      sourceId: uuid,
      lines: z
        .array(
          z.object({
            accountCode: z.string(),
            accountRole: z.string().optional(),
            projectId: uuid,
            debitCents: cents,
            creditCents: cents,
            description: z.string().optional(),
            companyId: uuid.optional(),
            dimensions: z.record(z.unknown()).optional(),
          }),
        )
        .min(2)
        .max(1000),
    })
    .parse(JSON.parse(p.draft_text));
  if (
    draft.postingKey !== "native-invoice:" + scope.invoiceId ||
    draft.sourceId !== scope.invoiceId ||
    p.chart_id !== native.chart.id ||
    p.period_id !== native.period.id ||
    p.entry_date !== native.entryDate ||
    draft.entryDate !== native.entryDate ||
    e.id !== p.entry_id ||
    e.source_posting_id !== p.id ||
    e.org_id !== p.org_id ||
    e.legal_entity_id !== p.legal_entity_id ||
    e.project_id !== p.project_id ||
    e.chart_id !== p.chart_id ||
    e.period_id !== p.period_id ||
    e.entry_date !== p.entry_date ||
    e.memo !== draft.memo ||
    e.posted_at !== p.posted_at ||
    d.lines.length !== draft.lines.length ||
    new Set(d.lines.map((l) => l.id)).size !== d.lines.length
  )
    throw Error("Native invoice header or complete leg inventory differs");
  const controls = z
    .object({ controls: z.record(z.string()) })
    .parse(JSON.parse(native.chart.definition_text)).controls;
  let debits = 0n,
    credits = 0n;
  for (const [i, l] of d.lines.entries()) {
    const q = draft.lines[i],
      dims = q.dimensions ?? {},
      code = q.accountRole ? controls[q.accountRole] : q.accountCode,
      accounts = native.accounts.filter((a) => a.code === code);
    if (
      accounts.length !== 1 ||
      q.projectId !== scope.projectId ||
      l.org_id !== p.org_id ||
      l.legal_entity_id !== p.legal_entity_id ||
      l.project_id !== p.project_id ||
      l.entry_id !== e.id ||
      l.chart_id !== p.chart_id ||
      l.position !== i + 1 ||
      l.account_id !== accounts[0].id ||
      l.debit_cents !== q.debitCents ||
      l.credit_cents !== q.creditCents ||
      l.description !== (q.description ?? null) ||
      l.company_id !== (q.companyId ?? null) ||
      l.cost_code_id !== (dims.cost_code_id ?? null) ||
      canonical(l.dimensions) !== canonical(dims) ||
      l.debit_cents > 0 === l.credit_cents > 0
    )
      throw Error("Native invoice leg differs from retained intent");
    debits += BigInt(l.debit_cents);
    credits += BigInt(l.credit_cents);
  }
  if (debits !== credits || debits !== BigInt(e.total_cents))
    throw Error("Native invoice complete journal does not balance");
  return d;
}
async function verifyResolution(
  scope: NativeInvoiceRecoveryScope,
  r: NativeInvoiceRecovery,
  value: unknown,
) {
  if (!r.resolution)
    throw Error("Saved invoice resolution decision is required");
  const header = z
    .object({
      outcome: z.enum(["cancelled", "committed_original"]),
      ledgerActivated: z.literal(false),
    })
    .passthrough()
    .parse(value);
  if (header.outcome === "committed_original") {
    if (header.resolution !== null)
      throw Error("Committed invoice resolution contains cancellation");
    await verifyNativeInvoiceRecoveryPosting(scope, r, value);
    return header;
  }
  const d = z
      .object({
        outcome: z.literal("cancelled"),
        posted: z.literal(false),
        ledgerActivated: z.literal(false),
        posting: z.null(),
        entry: z.null(),
        lines: z.array(z.unknown()).length(0),
        resolution: z
          .object({
            id: uuid,
            org_id: uuid,
            legal_entity_id: uuid,
            project_id: uuid,
            invoice_id: uuid,
            actor_id: uuid,
            request_id: uuid,
            entry_id: uuid,
            request_text: z.string().max(maximum),
            request_sha256: z.string(),
            reason: z.string(),
          })
          .passthrough(),
      })
      .parse(value),
    p = d.resolution;
  if (
    p.id !== r.resolution.id ||
    p.reason !== r.resolution.reason ||
    p.org_id !== scope.orgId ||
    p.actor_id !== scope.actorId ||
    p.legal_entity_id !== scope.entityId ||
    p.project_id !== scope.projectId ||
    p.invoice_id !== scope.invoiceId ||
    p.request_id !== r.request.id ||
    p.entry_id !== r.request.entryId ||
    (await sha(p.request_text)) !== p.request_sha256 ||
    canonical(JSON.parse(p.request_text)) !== canonical(r.request)
  )
    throw Error("Invoice cancellation differs from saved decision");
  return d;
}
async function acknowledge(
  storage: Store,
  scope: NativeInvoiceRecoveryScope,
  r: NativeInvoiceRecovery,
  outcome: "committed_original" | "cancelled",
) {
  const old = readNativeInvoiceRecovery(storage, scope);
  if (!old || canonical(old) !== canonical(r))
    throw Error("Saved invoice request changed before acknowledgement");
  const key = nativeInvoiceRecoveryKey(scope) + ":outcome:" + r.request.id;
  const summary = JSON.stringify({
    version: 1,
    requestId: r.request.id,
    entryId: r.request.entryId,
    outcome,
    resolutionId: r.resolution?.id ?? null,
    requestSha256: await sha(canonical(r.request)),
    ledgerActivated: false,
  });
  // Save the terminal confirmation before removing the only recoverable request.
  storage.setItem(key, summary);
  if (storage.getItem(key) !== summary)
    throw Error(
      "Invoice confirmation could not be saved; recover the retained request",
    );
  const current = readNativeInvoiceRecovery(storage, scope);
  if (!current || canonical(current) !== canonical(r))
    throw Error("Saved invoice request changed while recording confirmation");
  storage.removeItem(nativeInvoiceRecoveryKey(scope));
  if (storage.getItem(nativeInvoiceRecoveryKey(scope)) !== null)
    throw Error(
      "Invoice confirmation is saved but pending acknowledgement failed",
    );
}
type Transport = (
  r: NativeInvoiceRecovery,
) => Promise<
  { success: true; data: unknown } | { success: false; error: string }
>;
export async function submitNativeInvoiceRecovery(input: {
  storage: Store;
  scope: NativeInvoiceRecoveryScope;
  record: NativeInvoiceRecovery;
  locks: NativeInvoiceRecoveryLocks | undefined;
  transport: Transport;
  onSaved?: (r: NativeInvoiceRecovery) => void;
}) {
  if (!input.locks)
    throw Error("This browser cannot safely submit accounting requests");
  return input.locks.request(
    nativeInvoiceRecoveryKey(input.scope),
    async () => {
      if (
        input.storage.getItem(nativeInvoiceIncomeRecoveryKey(input.scope)) !==
        null
      )
        throw Error(
          "Resolve the saved income selection before posting the invoice",
        );
      const r = persistNativeInvoiceRecovery(
        input.storage,
        input.scope,
        input.record,
      );
      if (r.resolution)
        throw Error(
          "Recover the saved resolution before submitting its original invoice request",
        );
      input.onSaved?.(r);
      const result = await input.transport(r);
      if (!result.success) throw Error(result.error);
      await verifyNativeInvoiceRecoveryPosting(input.scope, r, result.data);
      await acknowledge(input.storage, input.scope, r, "committed_original");
      return result.data;
    },
  );
}
export async function resolveNativeInvoiceRecovery(input: {
  storage: Store;
  scope: NativeInvoiceRecoveryScope;
  record: NativeInvoiceRecovery;
  decision: z.infer<typeof decisionSchema>;
  locks: NativeInvoiceRecoveryLocks | undefined;
  transport: Transport;
  onSaved?: (r: NativeInvoiceRecovery) => void;
}) {
  if (!input.locks)
    throw Error("This browser cannot safely resolve accounting requests");
  return input.locks.request(
    nativeInvoiceRecoveryKey(input.scope),
    async () => {
      const old = readNativeInvoiceRecovery(input.storage, input.scope),
        r = scoped(input.scope, input.record),
        decision = decisionSchema.parse(input.decision);
      if (!old || canonical(old) !== canonical(r))
        throw Error("Saved invoice request changed before resolution");
      if (r.resolution && canonical(r.resolution) !== canonical(decision))
        throw Error(
          "Recover the saved resolution before changing its decision",
        );
      const next = { ...r, resolution: decision };
      const encoded = JSON.stringify(next);
      input.storage.setItem(nativeInvoiceRecoveryKey(input.scope), encoded);
      if (
        input.storage.getItem(nativeInvoiceRecoveryKey(input.scope)) !== encoded
      )
        throw Error(
          "Invoice resolution could not be saved; no decision was sent",
        );
      input.onSaved?.(next);
      const result = await input.transport(next);
      if (!result.success) throw Error(result.error);
      const verified = await verifyResolution(input.scope, next, result.data);
      await acknowledge(input.storage, input.scope, next, verified.outcome);
      return result.data;
    },
  );
}
