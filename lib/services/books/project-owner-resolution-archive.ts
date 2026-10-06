import { createHash } from "node:crypto";
import { projectOwnerRecoverySchema } from "./project-owner-recovery";
import { projectOwnerResolutionSchema } from "./project-entity-contract";
import { timestampMicros } from "./posting-state";
export const PROJECT_OWNER_RESOLUTION_TABLE =
  "books_project_owner_request_resolutions";
/** Cancellation is retained evidence, never an owner or a monetary approval. */
export function verifyProjectOwnerResolutionArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  const rows = tables[PROJECT_OWNER_RESOLUTION_TABLE];
  if (version < 24)
    return rows?.length
      ? ["Ownership resolutions require archive schema24"]
      : [];
  try {
    if (!rows) throw Error("Missing ownership resolution history");
    const identities = new Set<string>(),
      requests = new Set<string>();
    const time = (v: unknown) => {
      const t = typeof v === "string" ? timestampMicros(v) : null;
      if (t === null) throw Error("Invalid ownership resolution timestamp");
      return t;
    };
    for (const raw of rows) {
      const row = projectOwnerResolutionSchema.parse(raw);
      const record = projectOwnerRecoverySchema.parse({
        version: 1,
        kind: row.kind,
        request: JSON.parse(row.request_text),
      });
      const r = record.request;
      const key = row.kind + ":" + row.request_id;
      if (
        identities.has(row.id) ||
        requests.has(key) ||
        row.org_id !== org ||
        r.expectedOrgId !== org ||
        r.expectedActorId !== row.actor_id ||
        r.entityId !== row.legal_entity_id ||
        r.projectId !== row.project_id ||
        r.id !== row.request_id ||
        Buffer.byteLength(row.request_text, "utf8") > 65536 ||
        createHash("sha256").update(row.request_text).digest("hex") !==
          row.request_sha256
      )
        throw Error(
          "Ownership cancellation identity, request scope or digest differs",
        );
      identities.add(row.id);
      requests.add(key);
      if (
        !tables.projects?.some(
          (p) => p.org_id === org && p.id === row.project_id,
        ) ||
        !tables.books_legal_entities?.some(
          (e) => e.org_id === org && e.id === row.legal_entity_id,
        )
      )
        throw Error("Ownership cancellation actual project/entity is missing");
      const at = time(row.resolved_at),
        events = tables.books_legal_entity_access_history ?? [];
      const authority = events.find(
        (e) =>
          e.org_id === org &&
          e.id === row.resolved_access_event_id &&
          e.legal_entity_id === row.legal_entity_id &&
          e.user_id === row.actor_id,
      );
      if (
        !authority ||
        ![row.kind, "manage"].includes(String(authority.access_level)) ||
        time(authority.changed_at) > at ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === row.legal_entity_id &&
            e.user_id === row.actor_id &&
            BigInt(String(e.sequence_no)) >
              BigInt(String(authority.sequence_no)) &&
            time(e.changed_at) <= at,
        )
      )
        throw Error(
          "Ownership cancellation authority differs from retained access history",
        );
      const proposals = tables.books_project_entity_proposals ?? [];
      const committed =
        row.kind === "prepare"
          ? proposals
          : (tables.books_project_entity_reviews ?? []);
      if (committed.some((p) => p.id === row.request_id))
        throw Error("Cancelled ownership nonce also has a committed receipt");
      const observed =
        record.kind === "review"
          ? proposals.find(
              (p) =>
                p.org_id === org &&
                p.legal_entity_id === row.legal_entity_id &&
                p.project_id === row.project_id &&
                p.id === record.request.proposalId &&
                time(p.prepared_at) <= at,
            )
          : undefined;
      if ((observed?.id ?? null) !== row.observed_proposal_id)
        throw Error(
          "Ownership cancellation observed proposal differs at resolution time",
        );
    }
    return [];
  } catch (e) {
    return [
      "Invalid ownership cancellation history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
