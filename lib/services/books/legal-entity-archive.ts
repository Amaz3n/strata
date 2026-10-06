import { z } from "zod";
export const LEGAL_ENTITY_ARCHIVE_TABLES = [
  "books_legal_entities",
  "books_legal_entity_members",
  "books_legal_entity_access_history",
  "books_legal_entity_profiles",
  "books_legal_entity_profile_reviews",
] as const;
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase(), "Canonical UUID required");
const notes = z.string().trim().min(10).max(2000);
const timestamp = z.string().datetime({ offset: true });
const level = z.enum(["read", "prepare", "review", "manage", "revoked"]);
const sequence = z
  .union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/)])
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const entitySchema = z.object({
  id: uuid,
  org_id: uuid,
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  ledger_state: z.literal("setup"),
  created_by: uuid,
  created_at: timestamp,
  creation_notes: notes,
});
const memberSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  user_id: uuid,
  access_level: level,
  changed_by: uuid,
  changed_at: timestamp,
  change_notes: notes,
});
const historySchema = memberSchema.extend({
  sequence_no: sequence,
  prior_level: level.nullable(),
});
const profileSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  revision: z.number().int().positive(),
  previous_profile_id: uuid.nullable(),
  prepared_access_event_id: uuid,
  legal_name: z.string().trim().min(1).max(200),
  legal_form: z.enum([
    "sole_proprietorship",
    "partnership",
    "corporation",
    "llc",
    "other",
  ]),
  functional_currency: z.literal("USD"),
  fiscal_start_month: z.number().int().min(1).max(12),
  fiscal_start_day: z.number().int().min(1).max(31),
  effective_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  identity_evidence: z
    .record(z.unknown())
    .refine(
      (value) =>
        Object.keys(value).length > 0 &&
        Buffer.byteLength(JSON.stringify(value)) <= 65536,
    ),
  prepared_by: uuid,
  prepared_at: timestamp,
  preparation_notes: notes,
});
const reviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  profile_id: uuid,
  reviewed_by: uuid,
  reviewed_access_event_id: uuid,
  reviewed_at: timestamp,
  review_notes: notes,
});
/** Semantic closure in addition to table checksums; never infer a legacy entity. */
export function verifyLegalEntityArchive(
  tables: Record<string, Record<string, unknown>[]>,
  orgId: string,
  version: number,
): string[] {
  const errors: string[] = [];
  if (version < 18) {
    if (
      LEGAL_ENTITY_ARCHIVE_TABLES.some((table) => (tables[table] ?? []).length)
    )
      errors.push("Native legal entity evidence requires schema 18");
    return errors;
  }
  try {
    const entities = (tables.books_legal_entities ?? []).map((row) =>
      entitySchema.parse(row),
    );
    const members = (tables.books_legal_entity_members ?? []).map((row) =>
      memberSchema.parse(row),
    );
    const events = (tables.books_legal_entity_access_history ?? []).map((row) =>
      historySchema.parse(row),
    );
    const profiles = (tables.books_legal_entity_profiles ?? []).map((row) =>
      profileSchema.parse(row),
    );
    const reviews = (tables.books_legal_entity_profile_reviews ?? []).map(
      (row) => reviewSchema.parse(row),
    );
    const owner = new Map(entities.map((row) => [row.id, row]));
    if (new Set(entities.map((row) => row.code)).size !== entities.length)
      throw Error("Duplicate native entity code");
    const owned = [...entities, ...members, ...events, ...profiles, ...reviews];
    if (owned.some((row) => row.org_id !== orgId))
      throw Error("Native entity organization differs");
    if (
      [...members, ...events, ...profiles, ...reviews].some(
        (row) => !owner.has(row.legal_entity_id),
      )
    )
      throw Error("Orphan native entity evidence");
    for (const rows of [entities, members, events, profiles, reviews])
      if (new Set(rows.map((row) => row.id)).size !== rows.length)
        throw Error("Duplicate native entity row identity");
    if (
      new Set(members.map((row) => `${row.legal_entity_id}:${row.user_id}`))
        .size !== members.length
    )
      throw Error("Duplicate entity membership");
    const sorted = [...events].sort(
      (a, b) =>
        a.legal_entity_id.localeCompare(b.legal_entity_id) ||
        (BigInt(a.sequence_no) < BigInt(b.sequence_no)
          ? -1
          : BigInt(a.sequence_no) > BigInt(b.sequence_no)
            ? 1
            : 0),
    );
    const states = new Map<string, (typeof events)[number]>(),
      sequences = new Set<string>(),
      initialized = new Set<string>();
    for (const event of sorted) {
      const key = `${event.legal_entity_id}:${event.user_id}`,
        seq = `${event.legal_entity_id}:${event.sequence_no}`,
        prior = states.get(key),
        entity = owner.get(event.legal_entity_id)!;
      if (
        sequences.has(seq) ||
        event.prior_level !== (prior?.access_level ?? null)
      )
        throw Error("Entity access history sequence or prior state differs");
      sequences.add(seq);
      if (!initialized.has(entity.id)) {
        if (
          event.user_id !== entity.created_by ||
          event.changed_by !== entity.created_by ||
          event.access_level !== "manage" ||
          event.prior_level !== null ||
          event.change_notes !== entity.creation_notes
        )
          throw Error("Entity creation access receipt differs");
        initialized.add(entity.id);
      } else if (
        states.get(`${entity.id}:${event.changed_by}`)?.access_level !==
        "manage"
      )
        throw Error("Entity access change lacks prior manager authority");
      states.set(key, event);
      if (
        ![...states.values()].some(
          (row) =>
            row.legal_entity_id === entity.id && row.access_level === "manage",
        )
      )
        throw Error("Entity access history removes last manager");
    }
    if (entities.some((row) => !initialized.has(row.id)))
      throw Error("Entity creation access history is missing");
    if (states.size !== members.length)
      throw Error("Entity membership and access history populations differ");
    for (const member of members) {
      const event = states.get(`${member.legal_entity_id}:${member.user_id}`);
      if (
        !event ||
        ["access_level", "changed_by", "changed_at", "change_notes"].some(
          (key) =>
            member[key as keyof typeof member] !==
            event[key as keyof typeof event],
        )
      )
        throw Error("Entity current access differs from retained history");
    }
    const eventMap = new Map(events.map((row) => [row.id, row]));
    const profileMap = new Map(profiles.map((row) => [row.id, row])),
      reviewMap = new Map(reviews.map((row) => [row.profile_id, row]));
    if (reviewMap.size !== reviews.length)
      throw Error("Duplicate entity profile review");
    const revisions = new Set<string>();
    for (const profile of profiles) {
      const key = `${profile.legal_entity_id}:${profile.revision}`;
      if (revisions.has(key)) throw Error("Duplicate entity profile revision");
      revisions.add(key);
      const date = new Date(`${profile.effective_on}T00:00:00Z`),
        calendar = new Date(
          Date.UTC(
            2001,
            profile.fiscal_start_month - 1,
            profile.fiscal_start_day,
          ),
        );
      if (
        Number.isNaN(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== profile.effective_on ||
        calendar.getUTCMonth() !== profile.fiscal_start_month - 1 ||
        calendar.getUTCDate() !== profile.fiscal_start_day
      )
        throw Error("Invalid entity effective date or recurring calendar");
      if (profile.previous_profile_id) {
        const previous = profileMap.get(profile.previous_profile_id);
        if (
          !previous ||
          previous.legal_entity_id !== profile.legal_entity_id ||
          previous.revision >= profile.revision ||
          !reviewMap.has(previous.id)
        )
          throw Error(
            "Entity profile predecessor is not a prior approved same-entity revision",
          );
      }
      const access = eventMap.get(profile.prepared_access_event_id);
      if (
        !access ||
        access.legal_entity_id !== profile.legal_entity_id ||
        access.user_id !== profile.prepared_by ||
        !["prepare", "manage"].includes(access.access_level) ||
        Date.parse(access.changed_at) > Date.parse(profile.prepared_at)
      )
        throw Error(
          "Entity preparation authority differs from pinned access event",
        );
      if (
        events.some(
          (event) =>
            event.legal_entity_id === profile.legal_entity_id &&
            event.user_id === profile.prepared_by &&
            BigInt(event.sequence_no) > BigInt(access.sequence_no) &&
            Date.parse(event.changed_at) <= Date.parse(profile.prepared_at),
        )
      )
        throw Error("Entity preparation references stale access authority");
      if (!states.has(`${profile.legal_entity_id}:${profile.prepared_by}`))
        throw Error("Entity preparer has no retained access evidence");
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (
            key.endsWith("_file_id") &&
            child != null &&
            !(tables.files ?? []).some(
              (file) => file.id === child && file.org_id === orgId,
            )
          )
            throw Error("Entity identity document is absent from archive");
          if (
            key === "document_version_id" &&
            child != null &&
            !(tables.doc_versions ?? []).some(
              (file) => file.id === child && file.org_id === orgId,
            )
          )
            throw Error(
              "Entity identity document version is absent from archive",
            );
          visit(child);
        }
      };
      visit(profile.identity_evidence);
    }
    for (const entity of entities) {
      const rows = profiles
        .filter((row) => row.legal_entity_id === entity.id)
        .sort((a, b) => a.revision - b.revision);
      if (rows.some((row, index) => row.revision !== index + 1))
        throw Error("Entity preparation history has missing revisions");
      let previous: string | null = null;
      for (const row of rows.filter((row) => reviewMap.has(row.id))) {
        if (row.previous_profile_id !== previous)
          throw Error(
            "Approved entity profile chain branches or loses a predecessor",
          );
        previous = row.id;
      }
    }
    for (const review of reviews) {
      const profile = profileMap.get(review.profile_id);
      const access = eventMap.get(review.reviewed_access_event_id);
      if (
        !access ||
        access.legal_entity_id !== review.legal_entity_id ||
        access.user_id !== review.reviewed_by ||
        !["review", "manage"].includes(access.access_level) ||
        Date.parse(access.changed_at) > Date.parse(review.reviewed_at)
      )
        throw Error("Entity review authority differs from pinned access event");
      if (
        events.some(
          (event) =>
            event.legal_entity_id === review.legal_entity_id &&
            event.user_id === review.reviewed_by &&
            BigInt(event.sequence_no) > BigInt(access.sequence_no) &&
            Date.parse(event.changed_at) <= Date.parse(review.reviewed_at),
        )
      )
        throw Error("Entity review references stale access authority");
      if (
        !profile ||
        profile.legal_entity_id !== review.legal_entity_id ||
        profile.prepared_by === review.reviewed_by ||
        !states.has(`${review.legal_entity_id}:${review.reviewed_by}`) ||
        Date.parse(review.reviewed_at) < Date.parse(profile.prepared_at)
      )
        throw Error(
          "Entity profile lacks a separate scoped preparation/review receipt",
        );
    }
  } catch (error) {
    errors.push(
      `Native legal entity archive: ${error instanceof Error ? error.message : "invalid evidence"}`,
    );
  }
  return errors;
}
