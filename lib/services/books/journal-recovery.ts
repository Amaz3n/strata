import { z } from "zod";
import { assertBalancedJournalDraft } from "@/lib/services/books/types";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const journalRecoveryScopeSchema = z.object({
  orgId: uuid,
  actorId: uuid,
});
export type JournalRecoveryScope = z.infer<typeof journalRecoveryScopeSchema>;
const expected = { expectedOrgId: uuid, expectedActorId: uuid };
const preparation = z
  .object({
    ...expected,
    intentId: uuid,
    entryDate: date,
    memo: z.string().trim().min(4),
    reversingOn: date.nullish(),
    lines: z
      .array(
        z
          .object({
            accountCode: z.string().min(1),
            debitCents: z.number().int().nonnegative().safe(),
            creditCents: z.number().int().nonnegative().safe(),
            description: z.string().optional(),
            projectId: uuid.optional(),
            companyId: uuid.optional(),
            dimensions: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(1000),
  })
  .strict();
const review = z
  .object({
    ...expected,
    proposalId: uuid,
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(1000),
  })
  .strict();
export const journalRecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      resolution: z
        .object({ id: uuid, reason: z.string().trim().min(4).max(1000) })
        .strict()
        .optional(),
      kind: z.literal("prepare"),
      request: preparation,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      resolution: z
        .object({ id: uuid, reason: z.string().trim().min(4).max(1000) })
        .strict()
        .optional(),
      kind: z.literal("review"),
      request: review,
    })
    .strict(),
]);
export type JournalRecovery = z.infer<typeof journalRecoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function journalRecoveryKey(scope: JournalRecoveryScope) {
  const parsed = journalRecoveryScopeSchema.parse(scope);
  return `arc:books-journal-recovery:v1:${parsed.orgId}:${parsed.actorId}`;
}
function scoped(scope: JournalRecoveryScope, value: unknown): JournalRecovery {
  const parsed = journalRecoverySchema.parse(value),
    owner = journalRecoveryScopeSchema.parse(scope);
  if (
    parsed.request.expectedOrgId !== owner.orgId ||
    parsed.request.expectedActorId !== owner.actorId
  )
    throw new Error(
      "Saved journal request belongs to another organization or user",
    );
  if (parsed.kind === "prepare") {
    if (
      parsed.request.reversingOn &&
      parsed.request.reversingOn < parsed.request.entryDate
    )
      throw new Error("Saved reversal date precedes the adjustment");
    assertBalancedJournalDraft({
      entryDate: parsed.request.entryDate,
      memo: parsed.request.memo,
      entryKind: "adjusting",
      postingKey: "recovery",
      projectionVersion: 1,
      policyVersion: 1,
      lines: parsed.request.lines,
    });
  } else if (
    parsed.request.decision === "reject" &&
    parsed.request.note.length < 4
  )
    throw new Error("Saved rejection requires the original review note");
  return parsed;
}
/** Unknown outcomes never expire or silently disappear. */
export function readJournalRecovery(
  storage: RecoveryStorage,
  scope: JournalRecoveryScope,
): JournalRecovery | null {
  const value = storage.getItem(journalRecoveryKey(scope));
  if (value === null) return null;
  if (value.length > 1_048_576)
    throw new Error(
      "Saved journal request is too large to recover automatically",
    );
  return scoped(scope, JSON.parse(value));
}
export function persistJournalRecovery(
  storage: RecoveryStorage,
  scope: JournalRecoveryScope,
  record: JournalRecovery,
) {
  const parsed = scoped(scope, record),
    previous = readJournalRecovery(storage, scope),
    encoded = JSON.stringify(parsed);
  if (encoded.length > 1_048_576)
    throw new Error(
      "Journal recovery request is too large; no submission was sent",
    );
  if (previous && JSON.stringify(previous) !== encoded)
    throw new Error(
      "Recover the previous journal request before sending another",
    );
  storage.setItem(journalRecoveryKey(scope), encoded);
  if (storage.getItem(journalRecoveryKey(scope)) !== encoded)
    throw new Error(
      "Journal request could not be saved; no submission was sent",
    );
  return parsed;
}
/** Clear only our confirmed request, never a newer attempt from another tab. */
export function clearJournalRecovery(
  storage: RecoveryStorage,
  scope: JournalRecoveryScope,
  record: JournalRecovery,
) {
  const previous = readJournalRecovery(storage, scope);
  if (!previous) return;
  if (JSON.stringify(previous) !== JSON.stringify(scoped(scope, record)))
    throw new Error(
      "Another journal request needs recovery; reload before continuing",
    );
  storage.removeItem(journalRecoveryKey(scope));
  if (storage.getItem(journalRecoveryKey(scope)) !== null)
    throw new Error(
      "Confirmed journal request could not be cleared; retry its original receipt",
    );
}
export function validateJournalRecoveryReceipt(
  scope: JournalRecoveryScope,
  record: JournalRecovery,
  value: unknown,
) {
  const parsed = scoped(scope, record),
    owner = journalRecoveryScopeSchema.parse(scope);
  if (parsed.kind === "prepare") {
    const receipt = z
      .object({
        orgId: z.literal(owner.orgId),
        actorId: z.literal(owner.actorId),
        intentId: z.literal(parsed.request.intentId),
        id: z.string().uuid(),
        status: z.enum(["pending", "posted", "rejected"]),
        created: z.boolean(),
      })
      .parse(value);
    if (receipt.created && receipt.status !== "pending")
      throw new Error("New preparation has an invalid review receipt");
    return { id: receipt.id, status: receipt.status };
  }
  const receipt = z
    .object({
      orgId: z.literal(owner.orgId),
      reviewerId: z.literal(owner.actorId),
      proposalId: z.literal(parsed.request.proposalId),
      status: z.literal(
        parsed.request.decision === "approve" ? "posted" : "rejected",
      ),
      journal_entry_id: z.string().uuid().nullable(),
      reversal_entry_id: z.string().uuid().nullable(),
      created: z.boolean(),
    })
    .parse(value);
  if (
    (receipt.status === "posted" && !receipt.journal_entry_id) ||
    (receipt.status === "rejected" &&
      (receipt.journal_entry_id || receipt.reversal_entry_id)) ||
    (receipt.reversal_entry_id &&
      receipt.reversal_entry_id === receipt.journal_entry_id)
  )
    throw new Error("Review receipt has invalid money references");
  return { id: receipt.proposalId, status: receipt.status };
}

/** Persist the resolution choice without replacing a different pending operation. */
export function persistJournalResolution(
  storage: RecoveryStorage,
  scope: JournalRecoveryScope,
  record: JournalRecovery,
  resolution: { id: string; reason: string },
) {
  const original = scoped(scope, record),
    previous = readJournalRecovery(storage, scope);
  if (!previous || JSON.stringify(previous) !== JSON.stringify(original))
    throw new Error(
      "Saved journal request changed before its resolution; reload it",
    );
  const next = scoped(scope, { ...original, resolution });
  if (
    original.resolution &&
    JSON.stringify(original.resolution) !== JSON.stringify(next.resolution)
  )
    throw new Error("Retry the original saved resolution decision");
  const encoded = JSON.stringify(next);
  storage.setItem(journalRecoveryKey(scope), encoded);
  if (storage.getItem(journalRecoveryKey(scope)) !== encoded)
    throw new Error(
      "Resolution decision could not be saved; no acknowledgement was sent",
    );
  return next;
}
