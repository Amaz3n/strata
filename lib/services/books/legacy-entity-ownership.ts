import {
  PROJECT_ENTITY_TABLES,
  verifyProjectEntityArchive,
} from "./project-entity-archive";
import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import { timestampMicros } from "./posting-state";

export const LEGACY_ENTITY_OWNERSHIP_TABLES = [
  "books_legacy_entity_proposals",
  "books_legacy_entity_reviews",
] as const;
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const notes = z.string().trim().min(10).max(2000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(value + "T00:00:00Z");
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
  });
const time = z.string().datetime({ offset: true });
const snapshot = z
  .string()
  .regex(/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/)
  .refine((value) => {
    const [min, max, active] = value.split(":");
    const ids = active ? active.split(",").map(BigInt) : [];
    return (
      BigInt(min) <= BigInt(max) &&
      new Set(ids).size === ids.length &&
      ids.every(
        (id, index) =>
          id >= BigInt(min) &&
          id < BigInt(max) &&
          (index === 0 || id > ids[index - 1]),
      )
    );
  });
export const legacyOwnershipDecisionSchema = z
  .object({
    rationale: notes,
    single_entity_history_confirmed: z.literal(true),
    document_version_ids: z
      .array(uuid)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const legacyOwnershipProposalSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  profile_id: uuid,
  previous_reviewed_proposal_id: uuid.nullable(),
  accounting_cutoff: date,
  assignment_kind: z.literal("single_entity_legacy"),
  population_contract_version: z.union([z.literal(1), z.literal(2)]).default(1),
  decision_evidence: legacyOwnershipDecisionSchema,
  source_population_text: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= 268435456),
  source_population_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_captured_at: time,
  source_database_snapshot: snapshot,
  prepared_by: uuid,
  prepared_at: time,
  prepared_access_event_id: uuid,
  preparation_notes: notes,
});
export const legacyOwnershipReviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  proposal_id: uuid,
  reviewed_by: uuid,
  reviewed_at: time,
  source_population_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_rechecked_at: time,
  source_database_snapshot: snapshot,
  reviewed_access_event_id: uuid,
  review_notes: notes,
});

export function parseLegacyOwnershipPopulation(
  proposal: z.infer<typeof legacyOwnershipProposalSchema>,
) {
  if (
    createHash("sha256")
      .update(proposal.source_population_text)
      .digest("hex") !== proposal.source_population_sha256
  )
    throw new Error("Legacy ownership original population checksum differs");
  return z
    .record(z.array(z.record(z.unknown())))
    .parse(JSON.parse(proposal.source_population_text));
}

/** Verifies retained preparation/review provenance. These are assignment
 * proposals, never a substitute for an activated native ledger's ownership. */
export function verifyLegacyEntityOwnershipArchive(
  tables: Record<string, Record<string, unknown>[]>,
  orgId: string,
  version: number,
  baseTables: readonly string[],
): string[] {
  if (version < 19)
    return LEGACY_ENTITY_OWNERSHIP_TABLES.some(
      (table) => (tables[table] ?? []).length,
    )
      ? ["Legacy entity ownership reviews require archive schema 19"]
      : [];
  try {
    const proposals = (tables.books_legacy_entity_proposals ?? []).map((row) =>
      legacyOwnershipProposalSchema.parse(row),
    );
    const reviews = (tables.books_legacy_entity_reviews ?? []).map((row) =>
      legacyOwnershipReviewSchema.parse(row),
    );
    if (
      version < 23 &&
      proposals.some((p) => p.population_contract_version === 2)
    )
      throw new Error(
        "Project-aware legacy population requires archive schema23",
      );
    const unique = (rows: { id: string }[]) => {
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error("Duplicate legacy ownership identity");
    };
    unique(proposals);
    unique(reviews);
    if ([...proposals, ...reviews].some((row) => row.org_id !== orgId))
      throw new Error("Legacy ownership organization differs");
    const proposalMap = new Map(proposals.map((row) => [row.id, row])),
      reviewMap = new Map(reviews.map((row) => [row.proposal_id, row]));
    if (reviewMap.size !== reviews.length)
      throw new Error("Duplicate legacy proposal review");
    const micros = (value: unknown) => {
      const n = timestampMicros(String(value));
      if (n === null) throw new Error("Invalid legacy ownership timestamp");
      return n;
    };
    const find = (population: typeof tables, table: string, id: string) => {
      const rows = (population[table] ?? []).filter(
        (row) => row.id === id && row.org_id === orgId,
      );
      if (rows.length !== 1)
        throw new Error(`Legacy ownership missing ${table}`);
      return rows[0];
    };
    const access = (
      entity: string,
      actor: string,
      eventId: string,
      at: string,
      operation: "prepare" | "review",
    ) => {
      const event = find(tables, "books_legal_entity_access_history", eventId);
      if (
        event.legal_entity_id !== entity ||
        event.user_id !== actor ||
        ![operation, "manage"].includes(String(event.access_level)) ||
        micros(event.changed_at) > micros(at)
      )
        throw new Error("Legacy ownership pinned actor authority differs");
      if (
        (tables.books_legal_entity_access_history ?? []).some(
          (other) =>
            other.legal_entity_id === entity &&
            other.user_id === actor &&
            BigInt(String(other.sequence_no)) >
              BigInt(String(event.sequence_no)) &&
            micros(other.changed_at) <= micros(at),
        )
      )
        throw new Error("Legacy ownership authority is stale");
    };
    const approvedChildren = new Set<string>();
    for (const p of proposals) {
      const population = parseLegacyOwnershipPopulation(p);
      if (micros(p.source_captured_at) > micros(p.prepared_at))
        throw new Error("Legacy source capture occurs after preparation");
      if (
        JSON.stringify(Object.keys(population).sort()) !==
        JSON.stringify(
          [
            ...baseTables,
            ...(p.population_contract_version === 2
              ? PROJECT_ENTITY_TABLES
              : []),
          ].sort(),
        )
      )
        throw new Error("Legacy ownership source table population differs");
      const completeProjectPopulationAt = (at: string) => {
        for (const table of PROJECT_ENTITY_TABLES) {
          const capturedIds = new Set(
            (population[table] ?? []).map((row) => row.id),
          );
          if (
            (tables[table] ?? []).some(
              (row) =>
                micros(row.prepared_at ?? row.reviewed_at) <= micros(at) &&
                !capturedIds.has(row.id),
            )
          )
            throw new Error(
              "Legacy population omitted retained project ownership at capture or review",
            );
        }
      };
      if (p.population_contract_version === 2) {
        completeProjectPopulationAt(p.source_captured_at);
        const errors = verifyProjectEntityArchive(population, orgId, 23);
        if (errors.length) throw new Error(errors.join("; "));
        for (const table of PROJECT_ENTITY_TABLES)
          for (const row of population[table]) {
            if (
              micros(row.prepared_at ?? row.reviewed_at) >
              micros(p.source_captured_at)
            )
              throw new Error(
                "Legacy population contains future project ownership",
              );
            if (
              booksDigest(find(tables, table, String(row.id))) !==
              booksDigest(row)
            )
              throw new Error(
                "Legacy original project ownership differs from retained immutable row",
              );
          }
        if (
          (population.books_project_entity_reviews ?? []).some(
            (r) => r.legal_entity_id !== p.legal_entity_id,
          )
        )
          throw new Error("Legacy population has mixed native project owners");
      } else if (
        PROJECT_ENTITY_TABLES.some((table) =>
          (tables[table] ?? []).some(
            (r) =>
              micros(r.prepared_at ?? r.reviewed_at) <=
              micros(p.source_captured_at),
          ),
        )
      )
        throw new Error(
          "Old legacy population omitted existing native project ownership",
        );
      for (const [table, rows] of Object.entries(population)) {
        const ids = new Set<string>();
        for (const row of rows) {
          if (
            table === "companies" &&
            ["tax_id", "ein", "ssn"].some((key) => key in row)
          )
            throw new Error(
              "Legacy population reintroduces redacted tax identifiers",
            );
          if (
            table === "org_funding_sources" &&
            Object.keys(row).some(
              (key) =>
                ![
                  "id",
                  "org_id",
                  "provider",
                  "bank_name",
                  "account_type",
                  "last4",
                  "status",
                  "books_gl_account_id",
                  "created_at",
                  "updated_at",
                ].includes(key),
            )
          )
            throw new Error("Legacy population reintroduces provider handles");
          const id =
            table === "audit_log"
              ? z
                  .string()
                  .regex(/^[1-9][0-9]{0,18}$/)
                  .refine((value) => BigInt(value) <= 9223372036854775807n)
                  .parse(row.id)
              : uuid.parse(row.id);
          if (row.org_id !== orgId || ids.has(id))
            throw new Error(
              "Legacy ownership source identity or organization differs",
            );
          ids.add(id);
        }
      }
      const entity = find(tables, "books_legal_entities", p.legal_entity_id),
        profile = find(tables, "books_legal_entity_profiles", p.profile_id);
      const identityReviews = (
        tables.books_legal_entity_profile_reviews ?? []
      ).filter(
        (row) =>
          row.profile_id === p.profile_id &&
          row.org_id === orgId &&
          row.legal_entity_id === p.legal_entity_id,
      );
      if (
        entity.ledger_state !== "setup" ||
        profile.legal_entity_id !== p.legal_entity_id ||
        identityReviews.length !== 1 ||
        micros(identityReviews[0].reviewed_at) > micros(p.prepared_at)
      )
        throw new Error(
          "Legacy ownership requires previously reviewed entity identity",
        );
      for (const [table, id] of [
        ["books_legal_entities", p.legal_entity_id],
        ["books_legal_entity_profiles", p.profile_id],
        ["books_legal_entity_profile_reviews", String(identityReviews[0].id)],
        ["books_legal_entity_access_history", p.prepared_access_event_id],
      ])
        if (
          booksDigest(find(population, table, id)) !==
          booksDigest(find(tables, table, id))
        )
          throw new Error(
            "Legacy ownership original identity/access evidence differs",
          );
      for (const id of p.decision_evidence.document_version_ids) {
        const original = find(population, "doc_versions", id),
          retained = find(tables, "doc_versions", id);
        if (
          booksDigest(original) !== booksDigest(retained) ||
          typeof original.storage_path !== "string" ||
          !original.storage_path ||
          typeof original.checksum !== "string" ||
          !/^[a-f0-9]{64}$/.test(original.checksum) ||
          !Number.isSafeInteger(Number(original.size_bytes)) ||
          Number(original.size_bytes) < 0
        )
          throw new Error("Legacy ownership original document version differs");
        find(population, "files", String(original.file_id));
        find(tables, "files", String(original.file_id));
      }
      access(
        p.legal_entity_id,
        p.prepared_by,
        p.prepared_access_event_id,
        p.prepared_at,
        "prepare",
      );
      if (p.previous_reviewed_proposal_id) {
        const previous = proposalMap.get(p.previous_reviewed_proposal_id),
          review = reviewMap.get(p.previous_reviewed_proposal_id);
        if (
          !previous ||
          !review ||
          previous.id === p.id ||
          previous.legal_entity_id !== p.legal_entity_id ||
          micros(review.reviewed_at) >= micros(p.prepared_at)
        )
          throw new Error(
            "Legacy ownership predecessor is not an earlier reviewed same-entity intent",
          );
      }
      const r = reviewMap.get(p.id);
      const latestProfileAt = (at: string) =>
        (tables.books_legal_entity_profiles ?? [])
          .filter(
            (row) =>
              row.org_id === orgId &&
              row.legal_entity_id === p.legal_entity_id &&
              (tables.books_legal_entity_profile_reviews ?? []).some(
                (review) =>
                  review.profile_id === row.id &&
                  micros(review.reviewed_at) <= micros(at),
              ),
          )
          .sort((a, b) => Number(b.revision) - Number(a.revision))[0]?.id;
      if (
        latestProfileAt(p.prepared_at) !== p.profile_id ||
        (r && latestProfileAt(r.reviewed_at) !== p.profile_id)
      )
        throw new Error(
          "Legacy ownership did not use the current reviewed identity",
        );
      if (r) {
        if (p.population_contract_version === 2)
          completeProjectPopulationAt(r.source_rechecked_at);
        if (
          p.population_contract_version === 1 &&
          PROJECT_ENTITY_TABLES.some((table) =>
            (tables[table] ?? []).some(
              (row) =>
                micros(row.prepared_at ?? row.reviewed_at) <=
                micros(r.source_rechecked_at),
            ),
          )
        )
          throw new Error(
            "Old legacy approval omitted existing native project ownership",
          );
        if (
          r.source_population_sha256 !== p.source_population_sha256 ||
          micros(r.source_rechecked_at) > micros(r.reviewed_at) ||
          r.legal_entity_id !== p.legal_entity_id ||
          r.reviewed_by === p.prepared_by ||
          micros(r.reviewed_at) < micros(p.prepared_at)
        )
          throw new Error(
            "Legacy ownership requires a separate subsequent entity reviewer",
          );
        access(
          r.legal_entity_id,
          r.reviewed_by,
          r.reviewed_access_event_id,
          r.reviewed_at,
          "review",
        );
        if (
          booksDigest(
            find(
              population,
              "books_legal_entity_access_history",
              r.reviewed_access_event_id,
            ),
          ) !==
          booksDigest(
            find(
              tables,
              "books_legal_entity_access_history",
              r.reviewed_access_event_id,
            ),
          )
        )
          throw new Error(
            "Legacy ownership review authority was not retained at preparation",
          );
        const key = `${p.legal_entity_id}:${p.previous_reviewed_proposal_id ?? "root"}`;
        if (approvedChildren.has(key))
          throw new Error("Legacy ownership approved history branches");
        approvedChildren.add(key);
      }
    }
    if (reviews.some((row) => !proposalMap.has(row.proposal_id)))
      throw new Error("Orphan legacy ownership approval");
    return [];
  } catch (e) {
    return [
      e instanceof Error ? e.message : "Invalid legacy ownership history",
    ];
  }
}
