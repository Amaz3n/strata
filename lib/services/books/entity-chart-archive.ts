import { z } from "zod";
import { createHash } from "node:crypto";
import { booksDigest } from "./hash";
import { timestampMicros } from "./posting-state";
import { entityChartDefinitionSchema } from "./entity-chart";
export const ENTITY_CHART_TABLES = [
  "books_entity_chart_versions",
  "books_entity_accounts",
  "books_entity_account_definitions",
  "books_entity_control_accounts",
  "books_entity_chart_reviews",
] as const;
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return (
      !Number.isNaN(d.valueOf()) &&
      d.toISOString().slice(0, 10) === v &&
      v >= "1900-01-01" &&
      v <= "9997-12-31"
    );
  });
const note = z.string().trim().min(10).max(2000);
export const entityChartVersionSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  profile_id: uuid,
  previous_reviewed_chart_id: uuid.nullable(),
  effective_on: date,
  definition_text: z.string().max(4194304),
  definition_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prepared_by: uuid,
  prepared_at: z.string(),
  prepared_access_event_id: uuid,
  preparation_notes: note,
});
export const entityChartReviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  chart_id: uuid,
  effective_on: date,
  reviewed_by: uuid,
  reviewed_at: z.string(),
  reviewed_access_event_id: uuid,
  review_notes: note,
});
export const entityAccountSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  code: z.string().trim().min(1).max(32),
  first_chart_id: uuid,
});
export const entityAccountDefinitionSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  chart_id: uuid,
  account_id: uuid,
  parent_account_id: uuid.nullable(),
  name: z.string(),
  account_type: z.string(),
  subtype: z.string(),
  normal_balance: z.string(),
  cash_flow_category: z.string().nullable(),
});
export const entityControlAccountSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  chart_id: uuid,
  role: z.string(),
  account_id: uuid,
});
const micros = (v: unknown) => {
  if (typeof v !== "string") throw Error("Missing chart authority timestamp");
  const t = timestampMicros(v);
  if (t === null) throw Error("Invalid chart authority timestamp");
  return t;
};
/** Verifies original canonical chart content and every relational account/control row. */
export function assertEntityChartRows(
  chart: z.infer<typeof entityChartVersionSchema>,
  accounts: Record<string, unknown>[],
  definitions: Record<string, unknown>[],
  controls: Record<string, unknown>[],
) {
  const parsed = JSON.parse(chart.definition_text),
    definition = entityChartDefinitionSchema.parse(parsed);
  if (
    booksDigest(parsed) !== booksDigest(definition) ||
    createHash("sha256").update(chart.definition_text, "utf8").digest("hex") !==
      chart.definition_sha256
  )
    throw Error("Original entity chart definition/hash differs");
  const byId = new Map(accounts.map((a) => [String(a.id), a])),
    found = new Set<string>();
  const actual = definitions
    .filter((d) => d.chart_id === chart.id)
    .map((d) => {
      const a = byId.get(String(d.account_id)),
        p = d.parent_account_id ? byId.get(String(d.parent_account_id)) : null;
      if (
        !a ||
        a.org_id !== chart.org_id ||
        a.legal_entity_id !== chart.legal_entity_id ||
        d.org_id !== chart.org_id ||
        d.legal_entity_id !== chart.legal_entity_id ||
        found.has(String(a.code)) ||
        (d.parent_account_id &&
          (!p ||
            p.org_id !== chart.org_id ||
            p.legal_entity_id !== chart.legal_entity_id))
      )
        throw Error(
          "Chart account definition scope, identity or parent differs",
        );
      found.add(String(a.code));
      return {
        code: a.code,
        name: d.name,
        account_type: d.account_type,
        subtype: d.subtype,
        normal_balance: d.normal_balance,
        cash_flow_category: d.cash_flow_category,
        parent_code: p?.code ?? null,
      };
    });
  const ordered = (rows: Record<string, unknown>[]) =>
    [...rows].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  if (
    booksDigest(ordered(actual)) !== booksDigest(ordered(definition.accounts))
  )
    throw Error("Entity account rows diverge from frozen chart definition");
  const bindings: Record<string, unknown> = {};
  for (const c of controls.filter((c) => c.chart_id === chart.id)) {
    const a = byId.get(String(c.account_id));
    if (
      !a ||
      c.org_id !== chart.org_id ||
      c.legal_entity_id !== chart.legal_entity_id ||
      a.org_id !== chart.org_id ||
      a.legal_entity_id !== chart.legal_entity_id ||
      !found.has(String(a.code)) ||
      Object.hasOwn(bindings, String(c.role))
    )
      throw Error(
        "Chart control binding is orphan, duplicated or crosses entity",
      );
    bindings[String(c.role)] = a.code;
  }
  if (booksDigest(bindings) !== booksDigest(definition.controls))
    throw Error("Entity control rows diverge from frozen chart definition");
  return definition;
}
export function verifyEntityChartArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  if (version < 22)
    return ENTITY_CHART_TABLES.some((t) => (tables[t] ?? []).length)
      ? ["Entity charts require archive schema22"]
      : [];
  try {
    if (ENTITY_CHART_TABLES.some((t) => !tables[t]))
      throw Error("Missing entity chart history");
    const charts = tables.books_entity_chart_versions.map((r) =>
        entityChartVersionSchema.parse(r),
      ),
      accounts = tables.books_entity_accounts.map((r) =>
        entityAccountSchema.parse(r),
      ),
      definitions = tables.books_entity_account_definitions.map((r) =>
        entityAccountDefinitionSchema.parse(r),
      ),
      controls = tables.books_entity_control_accounts.map((r) =>
        entityControlAccountSchema.parse(r),
      ),
      reviews = tables.books_entity_chart_reviews.map((r) =>
        entityChartReviewSchema.parse(r),
      );
    for (const rows of [charts, accounts, definitions, controls, reviews])
      if (
        new Set(rows.map((r) => r.id)).size !== rows.length ||
        rows.some((r) => r.org_id !== org)
      )
        throw Error("Entity chart identities or organization differ");
    if (
      new Set(accounts.map((a) => a.legal_entity_id + ":" + a.code)).size !==
      accounts.length
    )
      throw Error("Entity canonical account code is duplicated");
    const byId = new Map(charts.map((c) => [c.id, c])),
      profiles = tables.books_legal_entity_profiles ?? [],
      profileReviews = tables.books_legal_entity_profile_reviews ?? [],
      events = tables.books_legal_entity_access_history ?? [];
    const authority = (
      eventId: string,
      entity: string,
      actor: string,
      time: string,
      operation: string,
    ) => {
      const h = events.find(
        (e) =>
          e.id === eventId &&
          e.org_id === org &&
          e.legal_entity_id === entity &&
          e.user_id === actor,
      );
      if (
        !h ||
        ![operation, "manage"].includes(String(h.access_level)) ||
        micros(h.changed_at) > micros(time) ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === entity &&
            e.user_id === actor &&
            BigInt(String(e.sequence_no)) > BigInt(String(h.sequence_no)) &&
            micros(e.changed_at) <= micros(time),
        )
      )
        throw Error("Chart authority differs from original access event");
    };
    const profileAt = (
      c: z.infer<typeof entityChartVersionSchema>,
      at: string,
    ) =>
      profiles
        .filter(
          (p) =>
            p.org_id === org &&
            p.legal_entity_id === c.legal_entity_id &&
            String(p.effective_on) <= c.effective_on &&
            profileReviews.some(
              (r) =>
                r.profile_id === p.id && micros(r.reviewed_at) <= micros(at),
            ),
        )
        .sort((a, b) => Number(b.revision) - Number(a.revision))[0]?.id;
    const latestAt = (
      c: z.infer<typeof entityChartVersionSchema>,
      at: string,
    ) =>
      reviews
        .filter(
          (r) =>
            r.legal_entity_id === c.legal_entity_id &&
            r.chart_id !== c.id &&
            micros(r.reviewed_at) <= micros(at),
        )
        .sort((a, b) => b.effective_on.localeCompare(a.effective_on))[0]
        ?.chart_id ?? null;
    for (const c of charts) {
      micros(c.prepared_at);
      if (
        profileAt(c, c.prepared_at) !== c.profile_id ||
        latestAt(c, c.prepared_at) !== c.previous_reviewed_chart_id
      )
        throw Error(
          "Chart profile or predecessor is not historically applicable",
        );
      authority(
        c.prepared_access_event_id,
        c.legal_entity_id,
        c.prepared_by,
        c.prepared_at,
        "prepare",
      );
      if (c.previous_reviewed_chart_id) {
        const p = byId.get(c.previous_reviewed_chart_id);
        if (
          !p ||
          p.legal_entity_id !== c.legal_entity_id ||
          p.effective_on >= c.effective_on
        )
          throw Error("Chart predecessor scope/date differs");
      }
      assertEntityChartRows(c, accounts, definitions, controls);
    }
    for (const a of accounts) {
      const c = byId.get(a.first_chart_id);
      if (
        !c ||
        c.legal_entity_id !== a.legal_entity_id ||
        !entityChartDefinitionSchema
          .parse(JSON.parse(c.definition_text))
          .accounts.some((x) => x.code === a.code)
      )
        throw Error("Canonical account lacks original same-entity chart");
    }
    for (const d of definitions) {
      const c = byId.get(d.chart_id),
        a = accounts.find((a) => a.id === d.account_id),
        first = a ? byId.get(a.first_chart_id) : null;
      if (!c || !first || micros(first.prepared_at) > micros(c.prepared_at))
        throw Error("Account definition predates its canonical identity");
    }
    if (controls.some((c) => !byId.has(c.chart_id)))
      throw Error("Orphan entity control row");
    const reviewed = new Set<string>();
    for (const r of reviews) {
      const c = byId.get(r.chart_id);
      if (
        !c ||
        c.legal_entity_id !== r.legal_entity_id ||
        c.effective_on !== r.effective_on ||
        c.prepared_by === r.reviewed_by ||
        micros(r.reviewed_at) < micros(c.prepared_at) ||
        profileAt(c, r.reviewed_at) !== c.profile_id ||
        latestAt(c, r.reviewed_at) !== c.previous_reviewed_chart_id ||
        reviewed.has(c.id)
      )
        throw Error(
          "Entity chart approval is stale, duplicated or not independent",
        );
      authority(
        r.reviewed_access_event_id,
        r.legal_entity_id,
        r.reviewed_by,
        r.reviewed_at,
        "review",
      );
      reviewed.add(c.id);
    }
    return [];
  } catch (e) {
    return [
      "Invalid entity chart history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}
