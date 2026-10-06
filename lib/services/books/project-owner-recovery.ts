import { z } from "zod";
import {
  projectOwnershipDecisionSchema,
  projectOwnershipProposalSchema,
  projectOwnershipReviewSchema,
  projectOwnerResolutionSchema,
} from "./project-entity-contract";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const note = z.string().trim().min(10).max(2000);
const scopeSchema = z
  .object({ orgId: uuid, actorId: uuid, projectId: uuid })
  .strict();
export type ProjectOwnerRecoveryScope = z.infer<typeof scopeSchema>;
const resolution = z.object({ id: uuid, reason: note }).strict();
const base = {
  expectedOrgId: uuid,
  expectedActorId: uuid,
  projectId: uuid,
  entityId: uuid,
  id: uuid,
  notes: note,
};
export const projectOwnerRecoverySchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("prepare"),
      resolution: resolution.optional(),
      request: z
        .object({
          ...base,
          profileId: uuid,
          effectiveOn: projectOwnershipProposalSchema.shape.effective_on,
          evidence: projectOwnershipDecisionSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("review"),
      resolution: resolution.optional(),
      request: z.object({ ...base, proposalId: uuid }).strict(),
    })
    .strict(),
]);
export type ProjectOwnerRecovery = z.infer<typeof projectOwnerRecoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function projectOwnerRecoveryKey(scope: ProjectOwnerRecoveryScope) {
  const s = scopeSchema.parse(scope);
  return `arc:project-owner-request:v1:${s.orgId}:${s.actorId}:${s.projectId}`;
}
function scoped(scope: ProjectOwnerRecoveryScope, value: unknown) {
  const s = scopeSchema.parse(scope),
    r = projectOwnerRecoverySchema.parse(value);
  if (
    r.request.expectedOrgId !== s.orgId ||
    r.request.expectedActorId !== s.actorId ||
    r.request.projectId !== s.projectId
  )
    throw Error(
      "Saved ownership request belongs to another organization, actor or project",
    );
  return r;
}
export function readProjectOwnerRecovery(
  storage: RecoveryStorage,
  scope: ProjectOwnerRecoveryScope,
) {
  const raw = storage.getItem(projectOwnerRecoveryKey(scope));
  if (raw === null) return null;
  if (raw.length > 65536) throw Error("Saved ownership request is too large");
  return scoped(scope, JSON.parse(raw));
}
export function persistProjectOwnerRecovery(
  storage: RecoveryStorage,
  scope: ProjectOwnerRecoveryScope,
  value: ProjectOwnerRecovery,
) {
  const r = scoped(scope, value),
    encoded = JSON.stringify(r),
    old = readProjectOwnerRecovery(storage, scope);
  if (encoded.length > 65536)
    throw Error("Ownership request is too large; no request was sent");
  if (old && JSON.stringify(old) !== encoded)
    throw Error("Resolve the saved ownership request before creating another");
  storage.setItem(projectOwnerRecoveryKey(scope), encoded);
  if (storage.getItem(projectOwnerRecoveryKey(scope)) !== encoded)
    throw Error("Ownership request could not be saved; no request was sent");
  return r;
}
/** Only a verified exact committed receipt can acknowledge an uncertain request. */

export function verifyProjectOwnerCommittedReceipt(
  scope: ProjectOwnerRecoveryScope,
  value: ProjectOwnerRecovery,
  receipt: unknown,
) {
  const r = scoped(scope, value),
    p =
      r.kind === "prepare"
        ? projectOwnershipProposalSchema.parse(receipt)
        : projectOwnershipReviewSchema.parse(receipt);
  const actor = "prepared_by" in p ? p.prepared_by : p.reviewed_by;
  if (
    p.id !== r.request.id ||
    p.org_id !== scope.orgId ||
    p.project_id !== scope.projectId ||
    p.legal_entity_id !== r.request.entityId ||
    actor !== scope.actorId
  )
    throw Error("Committed ownership receipt differs from saved request");
  if (r.kind === "prepare") {
    const q = projectOwnershipProposalSchema.parse(p);
    if (
      q.profile_id !== r.request.profileId ||
      q.effective_on !== r.request.effectiveOn ||
      q.preparation_notes !== r.request.notes ||
      JSON.stringify(q.decision_evidence) !== JSON.stringify(r.request.evidence)
    )
      throw Error("Committed preparation differs from saved content");
  } else {
    const q = projectOwnershipReviewSchema.parse(p);
    if (
      q.proposal_id !== r.request.proposalId ||
      q.review_notes !== r.request.notes
    )
      throw Error("Committed review differs from saved content");
  }
  return p;
}
export function acknowledgeProjectOwnerRecovery(
  storage: RecoveryStorage,
  scope: ProjectOwnerRecoveryScope,
  value: ProjectOwnerRecovery,
  receipt: unknown,
) {
  const r = scoped(scope, value);
  if (r.resolution)
    throw Error(
      "Recover the saved ownership resolution before acknowledgement",
    );
  verifyProjectOwnerCommittedReceipt(scope, r, receipt);
  const old = readProjectOwnerRecovery(storage, scope);
  if (old && JSON.stringify(old) !== JSON.stringify(r))
    throw Error("Saved ownership request changed during acknowledgement");
  if (old) storage.removeItem(projectOwnerRecoveryKey(scope));
  if (storage.getItem(projectOwnerRecoveryKey(scope)) !== null)
    throw Error("Committed ownership request could not be acknowledged");
}
export async function withProjectOwnerRequestLock<T>(
  locks:
    | { request: (name: string, callback: () => Promise<T>) => Promise<T> }
    | undefined,
  scope: ProjectOwnerRecoveryScope,
  action: () => Promise<T>,
) {
  if (!locks)
    throw Error("This browser cannot safely submit ownership requests");
  return locks.request(projectOwnerRecoveryKey(scope), action);
}
export async function submitProjectOwnerRecovery(input: {
  storage: RecoveryStorage;
  scope: ProjectOwnerRecoveryScope;
  record: ProjectOwnerRecovery;
  locks:
    | {
        request: (
          name: string,
          callback: () => Promise<unknown>,
        ) => Promise<unknown>;
      }
    | undefined;
  onSaved?: (r: ProjectOwnerRecovery) => void;
  transport: (
    r: ProjectOwnerRecovery,
  ) => Promise<
    { success: true; receipt: unknown } | { success: false; error: string }
  >;
}) {
  return withProjectOwnerRequestLock(input.locks, input.scope, async () => {
    const r = persistProjectOwnerRecovery(
      input.storage,
      input.scope,
      input.record,
    );
    if (r.resolution)
      throw Error(
        "Recover the saved resolution before submitting its original request",
      );
    input.onSaved?.(r);
    const result = await input.transport(r);
    if (!result.success) throw Error(result.error);
    acknowledgeProjectOwnerRecovery(
      input.storage,
      input.scope,
      r,
      result.receipt,
    );
    return result.receipt;
  });
}

export const projectOwnerResolutionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("cancelled"),
      proposal: z.null(),
      review: z.null(),
      resolution: projectOwnerResolutionSchema,
      ledgerActivated: z.literal(false),
    }),
    z.object({
      outcome: z.literal("committed_original"),
      proposal: projectOwnershipProposalSchema.nullable(),
      review: projectOwnershipReviewSchema.nullable(),
      resolution: z.null(),
      ledgerActivated: z.literal(false),
    }),
  ],
);
export function verifyProjectOwnerResolutionResult(
  scope: ProjectOwnerRecoveryScope,
  value: ProjectOwnerRecovery,
  response: unknown,
) {
  const r = scoped(scope, value),
    result = projectOwnerResolutionResultSchema.parse(response);
  if (!r.resolution)
    throw Error("Saved ownership resolution identity is required");
  if (result.outcome === "committed_original") {
    if (
      (r.kind === "prepare" && result.review !== null) ||
      (r.kind === "review" && result.proposal !== null)
    )
      throw Error("Original ownership resolution receipt kind differs");
    verifyProjectOwnerCommittedReceipt(
      scope,
      r,
      r.kind === "prepare" ? result.proposal : result.review,
    );
  } else {
    const row = result.resolution;
    const original = projectOwnerRecoverySchema.parse({
      version: 1,
      kind: row.kind,
      request: JSON.parse(row.request_text),
    });
    if (
      row.id !== r.resolution.id ||
      row.reason !== r.resolution.reason ||
      row.org_id !== scope.orgId ||
      row.actor_id !== scope.actorId ||
      row.project_id !== scope.projectId ||
      row.legal_entity_id !== r.request.entityId ||
      row.kind !== r.kind ||
      row.request_id !== r.request.id ||
      original.kind !== r.kind ||
      JSON.stringify(original.request) !== JSON.stringify(r.request)
    )
      throw Error(
        "Ownership cancellation receipt differs from the saved resolution",
      );
  }
  return result;
}
/** Persist a resolution once; a lost result must replay that exact decision. */
export async function resolveProjectOwnerRecovery(input: {
  storage: RecoveryStorage;
  scope: ProjectOwnerRecoveryScope;
  record: ProjectOwnerRecovery;
  decision: z.infer<typeof resolution>;
  locks: Parameters<typeof submitProjectOwnerRecovery>[0]["locks"];
  onSaved?: (r: ProjectOwnerRecovery) => void;
  transport: (
    r: ProjectOwnerRecovery,
  ) => Promise<
    { success: true; receipt: unknown } | { success: false; error: string }
  >;
}) {
  const outcome = await withProjectOwnerRequestLock(
    input.locks,
    input.scope,
    async () => {
      const old = readProjectOwnerRecovery(input.storage, input.scope),
        r = scoped(input.scope, input.record),
        decision = resolution.parse(input.decision);
      if (!old || JSON.stringify(old) !== JSON.stringify(r))
        throw Error("Saved ownership request changed before resolution");
      if (
        old.resolution &&
        JSON.stringify(old.resolution) !== JSON.stringify(decision)
      )
        throw Error("Recover the original saved resolution decision");
      const next = scoped(input.scope, { ...old, resolution: decision }),
        encoded = JSON.stringify(next);
      if (encoded.length > 65536)
        throw Error("Ownership resolution is too large; no request was sent");
      input.storage.setItem(projectOwnerRecoveryKey(input.scope), encoded);
      if (
        input.storage.getItem(projectOwnerRecoveryKey(input.scope)) !== encoded
      )
        throw Error(
          "Ownership resolution could not be saved; no request was sent",
        );
      input.onSaved?.(next);
      const reply = await input.transport(next);
      if (!reply.success) throw Error(reply.error);
      const result = verifyProjectOwnerResolutionResult(
        input.scope,
        next,
        reply.receipt,
      );
      const current = readProjectOwnerRecovery(input.storage, input.scope);
      if (!current || JSON.stringify(current) !== encoded)
        throw Error(
          "Saved ownership resolution changed during acknowledgement",
        );
      input.storage.removeItem(projectOwnerRecoveryKey(input.scope));
      if (input.storage.getItem(projectOwnerRecoveryKey(input.scope)) !== null)
        throw Error("Resolved ownership request could not be acknowledged");
      return result;
    },
  );
  return projectOwnerResolutionResultSchema.parse(outcome);
}
