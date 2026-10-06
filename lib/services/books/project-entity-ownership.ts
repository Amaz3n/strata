import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { authorize, requireAuthorization } from "@/lib/services/authorization";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { booksDigest } from "./hash";
import { verifyTaxAttachmentBytes } from "./tax-attachments";
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules";
import {
  projectOwnershipDecisionSchema,
  projectOwnershipProposalSchema,
  projectOwnershipReviewSchema,
} from "./project-entity-contract";
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const notes = z.string().trim().min(10).max(2000);
const scope = { entityId: uuid, projectId: uuid };
const expected = { expectedOrgId: uuid, expectedActorId: uuid };
function assertActor(
  c: Context,
  v: { expectedOrgId: string; expectedActorId: string },
) {
  if (c.orgId !== v.expectedOrgId || c.userId !== v.expectedActorId)
    throw Error(
      "Saved project ownership request belongs to another organization or actor",
    );
}
const detailSchema = z.object({
  orgId: uuid,
  entityId: uuid,
  projectId: uuid,
  proposalId: uuid,
  actorId: uuid,
  proposal: projectOwnershipProposalSchema.nullable(),
  review: projectOwnershipReviewSchema.nullable(),
  ledgerActivated: z.literal(false),
});
type Context = Awaited<ReturnType<typeof requireBooksWorkspaceEnabled>>;
type Proposal = z.infer<typeof projectOwnershipProposalSchema>;
async function context(
  v: { entityId?: string; projectId: string },
  operation: "read" | "prepare" | "review",
) {
  const c = await requireBooksWorkspaceEnabled();
  await requireBooksAuthorization({
    permission: operation === "read" ? "books.read" : "books.manage",
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: v.entityId ? "legal_entity" : "project",
    resourceId: v.entityId ?? v.projectId,
    logDecision: true,
  });
  await requireAuthorization({
    permission: operation === "read" ? "project.read" : "project.manage",
    orgId: c.orgId,
    userId: c.userId,
    projectId: v.projectId,
    supabase: c.supabase,
    resourceType: "project",
    resourceId: v.projectId,
    logDecision: true,
  });
  return c;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw Error(`Project ownership could not complete: ${r.error.message}`);
  return r.data as unknown;
}
function assertProposal(
  p: Proposal,
  c: Context,
  v: { entityId: string; projectId: string; proposalId: string },
) {
  if (
    p.org_id !== c.orgId ||
    p.legal_entity_id !== v.entityId ||
    p.project_id !== v.projectId ||
    p.id !== v.proposalId
  )
    throw Error("Project ownership preparation differs from request scope");
}
async function detail(
  c: Context,
  v: { entityId: string; projectId: string; proposalId: string },
  operation: "read" | "prepare" | "review",
) {
  const d = detailSchema.parse(
    await call("read_books_project_entity_proposal", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_project: v.projectId,
      p_proposal: v.proposalId,
      p_actor: c.userId,
      p_operation: operation,
    }),
  );
  if (
    booksDigest([d.orgId, d.entityId, d.projectId, d.proposalId, d.actorId]) !==
    booksDigest([c.orgId, v.entityId, v.projectId, v.proposalId, c.userId])
  )
    throw Error("Project ownership detail differs from request scope");
  if (d.proposal) assertProposal(d.proposal, c, v);
  if (
    d.review &&
    (!d.proposal ||
      d.review.org_id !== c.orgId ||
      d.review.legal_entity_id !== v.entityId ||
      d.review.project_id !== v.projectId ||
      d.review.proposal_id !== v.proposalId ||
      d.review.reviewed_by === d.proposal.prepared_by)
  )
    throw Error("Project ownership review differs from preparation scope");
  return d;
}
const documentKey = (r: Record<string, unknown>) => [
  r.id,
  r.file_id,
  r.storage_path,
  r.checksum,
  String(r.size_bytes),
];
async function verifyDocuments(
  c: Context,
  ids: string[],
  frozen?: Proposal["documents"],
) {
  const service = createServiceSupabaseClient();
  const r = await service
    .from("doc_versions")
    .select(
      "id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum",
    )
    .eq("org_id", c.orgId)
    .in("id", ids);
  if (r.error)
    throw Error("Original project ownership versions could not load");
  const rows = z.array(z.record(z.unknown())).parse(r.data),
    proofs: Proposal["documents"] = [];
  if (rows.length !== ids.length)
    throw Error("Original project ownership supporting version is unavailable");
  // Resolve each supporting file through the caller's RLS client, then require
  // its actual project/document permission before privileged storage reads.
  const fileIds = [...new Set(rows.map((row) => uuid.parse(row.file_id)))];
  const files = await c.supabase
    .from("files")
    .select("id,org_id,project_id")
    .eq("org_id", c.orgId)
    .in("id", fileIds);
  const visible = z
    .array(z.object({ id: uuid, org_id: uuid, project_id: uuid.nullable() }))
    .parse(files.data ?? []);
  if (
    files.error ||
    visible.length !== fileIds.length ||
    visible.some((f) => f.org_id !== c.orgId || !fileIds.includes(f.id)) ||
    new Set(visible.map((f) => f.id)).size !== fileIds.length
  )
    throw Error("Original project ownership supporting file is unavailable");
  for (const file of visible)
    await requireAuthorization({
      permission: "docs.read",
      orgId: c.orgId,
      userId: c.userId,
      projectId: file.project_id ?? undefined,
      supabase: c.supabase,
      resourceType: "file",
      resourceId: file.id,
      logDecision: true,
    });
  for (const id of [...ids].sort()) {
    const found = rows.filter((row) => row.id === id && row.org_id === c.orgId);
    if (found.length !== 1)
      throw Error(
        "Original project ownership supporting version is unavailable",
      );
    const row = found[0];
    if (frozen) {
      const original = frozen.find((d) => d.id === id);
      if (
        !original ||
        booksDigest(documentKey(original)) !== booksDigest(documentKey(row))
      )
        throw Error("Original project ownership document metadata changed");
    }
    const proof = taxAttachmentSnapshotSchema.parse({
      version: 1,
      org_id: c.orgId,
      file_id: row.file_id,
      document_version_id: row.id,
      storage_path: row.storage_path,
      file_name: row.file_name,
      mime_type: row.mime_type ?? null,
      size_bytes: Number(row.size_bytes),
      checksum: row.checksum,
    });
    try {
      await verifyTaxAttachmentBytes(service, c.orgId, proof);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "Tax attachment bytes differ from frozen evidence",
          "Tax attachment size differs from frozen evidence",
        ].includes(error.message)
      )
        throw Error(
          "Original project ownership bytes differ from recorded evidence",
        );
      throw Error(
        "Original project ownership document could not be read or verified",
      );
    }
    proofs.push({
      id,
      file_id: proof.file_id,
      storage_path: proof.storage_path,
      checksum: proof.checksum,
      size_bytes: proof.size_bytes,
    });
  }
  return proofs;
}
export async function readBooksProjectEntityProposal(input: unknown) {
  const v = z
      .object({ ...scope, proposalId: uuid })
      .strict()
      .parse(input),
    c = await context(v, "read");
  return detail(c, v, "read");
}
export async function prepareBooksProjectEntity(input: unknown) {
  const v = z
      .object({
        ...scope,
        ...expected,
        id: uuid,
        profileId: uuid,
        effectiveOn: projectOwnershipProposalSchema.shape.effective_on,
        evidence: projectOwnershipDecisionSchema,
        notes,
      })
      .strict()
      .parse(input),
    c = await context(v, "prepare");
  assertActor(c, v);
  const prior = await detail(c, { ...v, proposalId: v.id }, "prepare");
  // Retained exact receipts remain recoverable after document changes. New
  // preparations must first stream the selected original bytes.
  const before = prior.proposal
    ? null
    : await verifyDocuments(c, v.evidence.document_version_ids);
  const result = z
    .object({
      proposal: projectOwnershipProposalSchema,
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("prepare_books_project_entity", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_project: v.projectId,
        p_id: v.id,
        p_profile: v.profileId,
        p_actor: c.userId,
        p_effective: v.effectiveOn,
        p_decision: v.evidence,
        p_notes: v.notes,
      }),
    );
  const p = result.proposal;
  assertProposal(p, c, { ...v, proposalId: v.id });
  if (
    booksDigest([
      p.profile_id,
      p.prepared_by,
      p.effective_on,
      p.decision_evidence,
      p.preparation_notes,
    ]) !==
    booksDigest([v.profileId, c.userId, v.effectiveOn, v.evidence, v.notes])
  )
    throw Error(
      "Project ownership preparation receipt differs from request; retain the original request identity",
    );
  if (
    before &&
    booksDigest(before.map(documentKey)) !==
      booksDigest(
        [...p.documents]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(documentKey),
      )
  )
    throw Error(
      "Project ownership documents changed while preparing; retain the original request identity",
    );
  return result;
}
export async function reviewBooksProjectEntity(input: unknown) {
  const v = z
      .object({ ...scope, ...expected, id: uuid, proposalId: uuid, notes })
      .strict()
      .parse(input),
    c = await context(v, "review");
  assertActor(c, v);
  const d = await detail(c, v, "review");
  if (!d.proposal) throw Error("Project ownership preparation is unavailable");
  if (d.proposal.prepared_by === c.userId)
    throw Error("Project ownership requires a separate reviewer");
  if (!d.review)
    await verifyDocuments(
      c,
      d.proposal.decision_evidence.document_version_ids,
      d.proposal.documents,
    );
  const result = z
    .object({
      review: projectOwnershipReviewSchema,
      sourceOwnerEstablished: z.literal(true),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("review_books_project_entity", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_project: v.projectId,
        p_proposal: v.proposalId,
        p_id: v.id,
        p_actor: c.userId,
        p_notes: v.notes,
      }),
    );
  const r = result.review;
  if (
    booksDigest([
      r.id,
      r.org_id,
      r.legal_entity_id,
      r.project_id,
      r.proposal_id,
      r.reviewed_by,
      r.review_notes,
    ]) !==
    booksDigest([
      v.id,
      c.orgId,
      v.entityId,
      v.projectId,
      v.proposalId,
      c.userId,
      v.notes,
    ])
  )
    throw Error(
      "Project ownership review receipt differs from request; retain the original request identity",
    );
  return result;
}

const summarySchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  project_id: uuid,
  profile_id: uuid,
  effective_on: projectOwnershipProposalSchema.shape.effective_on,
  project_name: z.string(),
  prepared_by: uuid,
  prepared_at: z.string(),
  reviewed_by: uuid.nullable(),
  reviewed_at: z.string().nullable(),
});
export async function getBooksProjectOwnerWorkspace(input: unknown) {
  const v = z
      .object({
        projectId: uuid,
        entityId: uuid.optional(),
        afterEntity: uuid.optional(),
        afterProposal: uuid.optional(),
      })
      .strict()
      .refine(
        (v) => !v.afterProposal || !!v.entityId,
        "Proposal cursor requires an entity",
      )
      .parse(input),
    c = await context(v, "read");
  const r = z
    .object({
      orgId: uuid,
      projectId: uuid,
      actorId: uuid,
      entityId: uuid.nullable(),
      projectName: z.string(),
      entities: z
        .array(
          z.object({
            id: uuid,
            org_id: uuid,
            code: z.string(),
            profile_id: uuid.nullable(),
            legal_name: z.string().nullable(),
            effective_on:
              projectOwnershipProposalSchema.shape.effective_on.nullable(),
            can_prepare: z.boolean(),
            can_review: z.boolean(),
          }),
        )
        .max(25),
      nextEntityCursor: uuid.nullable(),
      proposals: z.array(summarySchema).max(25),
      nextProposalCursor: uuid.nullable(),
      hasReviewedOwner: z.boolean(),
      owner: z
        .object({
          proposal: projectOwnershipProposalSchema,
          review: projectOwnershipReviewSchema,
        })
        .nullable(),
      canPrepare: z.boolean(),
      canReview: z.boolean(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("read_books_project_owner_workspace", {
        p_org: c.orgId,
        p_project: v.projectId,
        p_actor: c.userId,
        p_entity: v.entityId ?? null,
        p_after_entity: v.afterEntity ?? null,
        p_after_proposal: v.afterProposal ?? null,
        p_limit: 25,
      }),
    );
  if (
    booksDigest([r.orgId, r.projectId, r.actorId, r.entityId]) !==
    booksDigest([c.orgId, v.projectId, c.userId, v.entityId ?? null])
  )
    throw Error("Project ownership workspace differs from request scope");
  const validatePage = (
    rows: { id: string }[],
    after: string | undefined,
    cursor: string | null,
  ) => {
    if (
      rows.some((row, i) =>
        i ? rows[i - 1].id >= row.id : after ? row.id <= after : false,
      ) ||
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      (cursor && (rows.length !== 25 || cursor !== rows.at(-1)?.id))
    )
      throw Error("Project ownership page order or cursor differs");
  };
  validatePage(r.entities, v.afterEntity, r.nextEntityCursor);
  validatePage(r.proposals, v.afterProposal, r.nextProposalCursor);
  if (
    r.entities.some((e) => e.org_id !== c.orgId) ||
    r.proposals.some(
      (p) =>
        p.org_id !== c.orgId ||
        p.project_id !== v.projectId ||
        p.legal_entity_id !== v.entityId ||
        (p.reviewed_at === null) !== (p.reviewed_by === null),
    ) ||
    (!v.entityId && (r.canPrepare || r.canReview || r.proposals.length))
  )
    throw Error("Project ownership workspace rows differ from scope");
  if (r.owner) {
    assertProposal(r.owner.proposal, c, {
      entityId: r.owner.review.legal_entity_id,
      projectId: v.projectId,
      proposalId: r.owner.review.proposal_id,
    });
    const o = r.owner.review;
    if (
      !r.hasReviewedOwner ||
      o.org_id !== c.orgId ||
      o.project_id !== v.projectId ||
      o.reviewed_by === r.owner.proposal.prepared_by
    )
      throw Error("Reviewed project owner differs from preparation");
  }
  const [booksManage, projectManage] = await Promise.all([
    authorize({
      permission: "books.manage",
      orgId: c.orgId,
      userId: c.userId,
      supabase: c.supabase,
      resourceType: "project",
      resourceId: v.projectId,
      logDecision: true,
    }),
    authorize({
      permission: "project.manage",
      orgId: c.orgId,
      userId: c.userId,
      projectId: v.projectId,
      supabase: c.supabase,
      resourceType: "project",
      resourceId: v.projectId,
      logDecision: true,
    }),
  ]);
  const canManage =
    booksManage.allowed &&
    booksManage.divisionScope !== "assigned" &&
    projectManage.allowed;
  return {
    ...r,
    canPrepare: r.canPrepare && canManage,
    canReview: r.canReview && canManage,
    entities: r.entities.map((e) => ({
      ...e,
      can_prepare: e.can_prepare && canManage,
      can_review: e.can_review && canManage,
    })),
  };
}
/** Original-version choices use the caller's document visibility and permissions. */
export async function listBooksProjectOwnerDocuments(input: unknown) {
  const v = z
      .object({ ...scope, after: uuid.optional() })
      .strict()
      .parse(input),
    c = await context(v, "read");
  if (
    (await call("books_entity_has_access", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_actor: c.userId,
      p_operation: "read",
    })) !== true
  )
    throw Error("Project entity read access is required");
  let q = c.supabase
    .from("doc_versions")
    .select("id,org_id,file_id,file_name,version_number,created_at")
    .eq("org_id", c.orgId)
    .order("id", { ascending: true })
    .limit(26);
  if (v.after) q = q.gt("id", v.after);
  const r = await q;
  if (r.error) throw Error("Ownership supporting versions could not load");
  const rows = z
    .array(
      z.object({
        id: uuid,
        org_id: uuid,
        file_id: uuid,
        file_name: z.string().nullable(),
        version_number: z.number().int().positive(),
        created_at: z.string(),
      }),
    )
    .max(26)
    .parse(r.data ?? []);
  if (
    rows.some(
      (d, i) =>
        d.org_id !== c.orgId ||
        (i ? d.id <= rows[i - 1].id : v.after ? d.id <= v.after : false),
    )
  )
    throw Error("Ownership document page differs from scope or order");
  const page = rows.slice(0, 25),
    fileIds = [...new Set(page.map((d) => d.file_id))];
  if (!fileIds.length) return { options: [], nextCursor: null };
  const files = await c.supabase
    .from("files")
    .select("id,org_id,project_id")
    .eq("org_id", c.orgId)
    .in("id", fileIds);
  if (files.error) throw Error("Ownership supporting files could not load");
  const visible = z
    .array(z.object({ id: uuid, org_id: uuid, project_id: uuid.nullable() }))
    .parse(files.data ?? []);
  if (
    visible.some((f) => f.org_id !== c.orgId || !fileIds.includes(f.id)) ||
    new Set(visible.map((f) => f.id)).size !== visible.length
  )
    throw Error("Ownership supporting files differ from scope");
  const allowed = new Set<string>();
  for (const f of visible) {
    const d = await authorize({
      permission: "docs.read",
      orgId: c.orgId,
      userId: c.userId,
      projectId: f.project_id ?? undefined,
      supabase: c.supabase,
      resourceType: "file",
      resourceId: f.id,
      logDecision: true,
    });
    if (d.allowed) allowed.add(f.id);
  }
  return {
    options: page
      .filter((d) => allowed.has(d.file_id))
      .map((d) => ({
        id: d.id,
        label: d.file_name ?? "Original supporting document",
        detail: `Version ${d.version_number} · ${d.created_at.slice(0, 10)}`,
      })),
    nextCursor: rows.length > 25 ? page.at(-1)!.id : null,
  };
}
/** Download the prepared version's frozen original, never the current file. */
export async function downloadBooksProjectOwnerOriginal(
  input: unknown,
  signal?: AbortSignal,
) {
  const v = z
      .object({ ...scope, proposalId: uuid, versionId: uuid })
      .strict()
      .parse(input),
    c = await context(v, "read"),
    d = await detail(c, v, "read");
  const original = d.proposal?.documents.find((doc) => doc.id === v.versionId);
  if (!original)
    throw Error("Prepared original supporting version is unavailable");
  const file = await c.supabase
    .from("files")
    .select("id,org_id,project_id")
    .eq("org_id", c.orgId)
    .eq("id", original.file_id)
    .maybeSingle();
  const row = z
    .object({ id: uuid, org_id: uuid, project_id: uuid.nullable() })
    .parse(file.data);
  if (file.error || row.id !== original.file_id || row.org_id !== c.orgId)
    throw Error("Prepared supporting file is unavailable");
  await requireAuthorization({
    permission: "docs.download",
    orgId: c.orgId,
    userId: c.userId,
    projectId: row.project_id ?? undefined,
    supabase: c.supabase,
    resourceType: "file",
    resourceId: row.id,
    logDecision: true,
  });
  const proof = taxAttachmentSnapshotSchema.parse({
    version: 1,
    org_id: c.orgId,
    file_id: original.file_id,
    document_version_id: original.id,
    storage_path: original.storage_path,
    file_name: "Ownership supporting original",
    mime_type: "application/octet-stream",
    size_bytes: Number(original.size_bytes),
    checksum: original.checksum,
  });
  const { stageVerifiedTaxAttachment } = await import("./tax-attachments");
  const body = await stageVerifiedTaxAttachment(
    createServiceSupabaseClient(),
    c.orgId,
    proof,
    signal,
  );
  try {
    await detail(c, v, "read");
  } catch (error) {
    await body.cancel().catch(() => {});
    throw error;
  }
  return { body, sizeBytes: proof.size_bytes, checksum: proof.checksum };
}

/** Resolve an uncertain request without reading unusable original document bytes. */
export async function resolveBooksProjectOwnerRequest(input: unknown) {
  const { projectOwnerRecoverySchema, verifyProjectOwnerResolutionResult } =
    await import("./project-owner-recovery");
  const { createHash } = await import("node:crypto");
  const record = projectOwnerRecoverySchema.parse(input);
  if (!record.resolution) throw Error("Saved ownership resolution is required");
  const v = record.request;
  const c = await context(v, record.kind);
  assertActor(c, v);
  const result = verifyProjectOwnerResolutionResult(
    { orgId: c.orgId, actorId: c.userId, projectId: v.projectId },
    record,
    await call("resolve_books_project_owner_request", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_project: v.projectId,
      p_actor: c.userId,
      p_id: record.resolution.id,
      p_kind: record.kind,
      p_request: v,
      p_reason: record.resolution.reason,
    }),
  );
  if (
    result.outcome === "cancelled" &&
    createHash("sha256")
      .update(result.resolution.request_text)
      .digest("hex") !== result.resolution.request_sha256
  )
    throw Error("Ownership resolution receipt checksum differs");
  return result;
}
