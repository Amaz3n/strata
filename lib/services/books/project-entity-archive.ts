import { z } from "zod";
import { booksDigest } from "./hash";
import { timestampMicros } from "./posting-state";
export const PROJECT_ENTITY_TABLES = [
  "books_project_entity_proposals",
  "books_project_entity_reviews",
] as const;
import {
  projectOwnershipProposalSchema,
  projectOwnershipReviewSchema,
} from "./project-entity-contract";
export {
  projectOwnershipDecisionSchema,
  projectOwnershipProposalSchema,
  projectOwnershipReviewSchema,
} from "./project-entity-contract";
const time = (v: unknown) => {
  const t = typeof v === "string" ? timestampMicros(v) : null;
  if (t === null) throw Error("Invalid project ownership authority timestamp");
  return t;
};
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Match SQL's structured UUID references, including keys of project_dimensions. */
export function ownershipPayloadUuidRefs(payload: unknown): Set<string> {
  const refs = new Set<string>(),
    pending: unknown[] = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (uuidPattern.test(value)) refs.add(value.toLowerCase());
    } else if (Array.isArray(value))
      for (const child of value) pending.push(child);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (uuidPattern.test(key)) refs.add(key.toLowerCase());
        pending.push(child);
      }
    }
  }
  return refs;
}
/** Actual root/payment relationships are authoritative even if a fact omits its project. */
export function createOwnershipFactProjectResolver(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
) {
  const byTable = new Map<string, Map<unknown, Record<string, unknown>>>();
  for (const table of [
    "vendor_bills",
    "invoices",
    "project_expenses",
    "payments",
  ])
    byTable.set(
      table,
      new Map(
        (tables[table] ?? [])
          .filter((r) => r.org_id === org)
          .map((r) => [r.id, r]),
      ),
    );
  const actual = new Set(
    (tables.projects ?? [])
      .filter((p) => p.org_id === org)
      .map((p) => String(p.id)),
  );
  return (type: unknown, source: unknown, payload: unknown): Set<string> => {
    const refs = ownershipPayloadUuidRefs(payload);
    const record = (table: string, id: unknown) => byTable.get(table)?.get(id);
    const add = (r: Record<string, unknown> | undefined) => {
      if (typeof r?.project_id === "string") refs.add(r.project_id);
    };
    if (["vendor_bill", "retainage_release"].includes(String(type)))
      add(record("vendor_bills", source));
    if (["invoice", "retainage_release"].includes(String(type)))
      add(record("invoices", source));
    if (type === "expense") add(record("project_expenses", source));
    if (
      [
        "invoice_payment",
        "bill_payment",
        "customer_deposit_receipt",
        "customer_deposit_application",
        "customer_deposit_reversal",
        "payment_reversal",
      ].includes(String(type))
    ) {
      const p = record("payments", source);
      add(p);
      add(record("invoices", p?.invoice_id));
      add(record("vendor_bills", p?.bill_id));
    }
    return new Set([...refs].filter((p) => actual.has(p)));
  };
}
export function ownershipFactProjectRefs(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  type: unknown,
  source: unknown,
  payload: unknown,
) {
  return createOwnershipFactProjectResolver(tables, org)(type, source, payload);
}
export function verifyProjectEntityArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  if (version < 23)
    return PROJECT_ENTITY_TABLES.some((t) => (tables[t] ?? []).length)
      ? ["Project ownership requires archive schema23"]
      : [];
  try {
    if (PROJECT_ENTITY_TABLES.some((t) => !tables[t]))
      throw Error("Missing project ownership history");
    const proposals = tables.books_project_entity_proposals.map((r) =>
        projectOwnershipProposalSchema.parse(r),
      ),
      reviews = tables.books_project_entity_reviews.map((r) =>
        projectOwnershipReviewSchema.parse(r),
      );
    for (const rows of [proposals, reviews])
      if (
        new Set(rows.map((r) => r.id)).size !== rows.length ||
        rows.some((r) => r.org_id !== org)
      )
        throw Error("Project ownership row identity/organization differs");
    const byId = new Map(proposals.map((p) => [p.id, p])),
      profiles = tables.books_legal_entity_profiles ?? [],
      profileReviews = tables.books_legal_entity_profile_reviews ?? [],
      events = tables.books_legal_entity_access_history ?? [];
    const applicable = (
      p: z.infer<typeof projectOwnershipProposalSchema>,
      at: string,
    ) =>
      profiles
        .filter(
          (x) =>
            x.org_id === org &&
            x.legal_entity_id === p.legal_entity_id &&
            String(x.effective_on) <= p.effective_on &&
            profileReviews.some(
              (r) =>
                r.org_id === org &&
                r.legal_entity_id === p.legal_entity_id &&
                r.profile_id === x.id &&
                time(r.reviewed_at) <= time(at),
            ),
        )
        .sort((a, b) => Number(b.revision) - Number(a.revision))[0]?.id;
    const authority = (
      event: string,
      entity: string,
      actor: string,
      at: string,
      operation: string,
    ) => {
      const h = events.find(
        (e) =>
          e.id === event &&
          e.org_id === org &&
          e.legal_entity_id === entity &&
          e.user_id === actor,
      );
      if (
        !h ||
        ![operation, "manage"].includes(String(h.access_level)) ||
        time(h.changed_at) > time(at) ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === entity &&
            e.user_id === actor &&
            BigInt(String(e.sequence_no)) > BigInt(String(h.sequence_no)) &&
            time(e.changed_at) <= time(at),
        )
      )
        throw Error(
          "Project ownership authority differs from original access event",
        );
    };
    for (const p of proposals) {
      time(p.prepared_at);
      if (
        !tables.projects?.some((x) => x.id === p.project_id && x.org_id === org)
      )
        throw Error("Owner proposal has no actual same-organization project");
      if (
        applicable(p, p.prepared_at) !== p.profile_id ||
        p.effective_on > p.prepared_at.slice(0, 10)
      )
        throw Error(
          "Project owner profile/date is not historically applicable",
        );
      authority(
        p.prepared_access_event_id,
        p.legal_entity_id,
        p.prepared_by,
        p.prepared_at,
        "prepare",
      );
      if (
        new Set(p.documents.map((d) => d.id)).size !== p.documents.length ||
        booksDigest([...p.decision_evidence.document_version_ids].sort()) !==
          booksDigest(p.documents.map((d) => d.id).sort())
      )
        throw Error("Project ownership original document inventory differs");
      for (const d of p.documents) {
        const original = tables.doc_versions?.find(
          (v) => v.org_id === org && v.id === d.id,
        );
        if (
          !original ||
          !tables.files?.some((f) => f.org_id === org && f.id === d.file_id) ||
          original.file_id !== d.file_id ||
          original.storage_path !== d.storage_path ||
          original.checksum !== d.checksum ||
          !d.storage_path.startsWith(org + "/") ||
          !["string", "number"].includes(typeof original.size_bytes) ||
          BigInt(String(original.size_bytes)) !== BigInt(d.size_bytes)
        )
          throw Error("Project ownership original document metadata differs");
      }
    }
    const projects = new Set<string>(),
      approved = new Set<string>();
    for (const r of reviews) {
      const p = byId.get(r.proposal_id);
      if (
        !p ||
        p.project_id !== r.project_id ||
        p.legal_entity_id !== r.legal_entity_id ||
        p.prepared_by === r.reviewed_by ||
        time(r.reviewed_at) < time(p.prepared_at) ||
        applicable(p, r.reviewed_at) !== p.profile_id ||
        projects.has(r.project_id) ||
        approved.has(p.id)
      )
        throw Error(
          "Project owner review is stale, duplicate, foreign or not independent",
        );
      authority(
        r.reviewed_access_event_id,
        r.legal_entity_id,
        r.reviewed_by,
        r.reviewed_at,
        "review",
      );
      projects.add(r.project_id);
      approved.add(p.id);
    }
    // These owners are deliberately fenced from the legacy ledger. Native entity
    // journal legs will need their own explicit archive contract when implemented.
    if (projects.size === 0) return [];
    const resolve = createOwnershipFactProjectResolver(tables, org);
    for (const f of tables.accounting_facts ?? [])
      if (
        f.org_id === org &&
        [...resolve(f.source_type, f.source_id, f.payload)].some((p) =>
          projects.has(p),
        )
      )
        throw Error(
          "Native-owned project has incompatible legacy accounting facts",
        );
    for (const j of tables.journal_entries ?? [])
      if (
        j.org_id === org &&
        [...resolve(j.source_type, j.source_id, {})].some((p) =>
          projects.has(p),
        )
      )
        throw Error(
          "Native-owned project has incompatible legacy journal source",
        );
    for (const l of tables.journal_lines ?? [])
      if (
        l.org_id === org &&
        (projects.has(String(l.project_id)) ||
          [...ownershipPayloadUuidRefs(l.dimensions)].some((p) =>
            projects.has(p),
          ))
      )
        throw Error(
          "Native-owned project has incompatible legacy journal lines",
        );
    return [];
  } catch (e) {
    return [
      "Invalid project ownership history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
