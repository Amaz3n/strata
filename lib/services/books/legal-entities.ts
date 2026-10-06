import { entityChartDefinitionSchema } from "./entity-chart";
import {
  entityChartVersionSchema,
  entityChartReviewSchema,
  entityAccountSchema,
  entityAccountDefinitionSchema,
  entityControlAccountSchema,
  assertEntityChartRows,
} from "./entity-chart-archive";
import "server-only";
import { createHash } from "node:crypto";
import {
  entityCalendarYearSchema,
  entityFiscalPeriodSchema,
  entityCalendarReviewSchema,
  entityMonthBoundary,
} from "./entity-calendars";
import { z } from "zod";
import { booksDigest } from "@/lib/services/books/hash";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksAuthorization } from "@/lib/services/books/access";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const notes = z.string().trim().min(10).max(2000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Use a real calendar date");
export const legalEntityProfileSchema = z
  .object({
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
    effective_on: date,
    identity_evidence: z
      .record(z.unknown())
      .refine(
        (value) =>
          Object.keys(value).length > 0 &&
          Buffer.byteLength(JSON.stringify(value)) <= 65536,
        "Retain bounded identity evidence",
      ),
  })
  .strict()
  .refine((value) => {
    const date = new Date(
      Date.UTC(2001, value.fiscal_start_month - 1, value.fiscal_start_day),
    );
    return (
      date.getUTCMonth() === value.fiscal_start_month - 1 &&
      date.getUTCDate() === value.fiscal_start_day
    );
  }, "Fiscal start must recur every calendar year");
async function context(
  permission: "books.read" | "books.manage",
  entityId?: string,
) {
  const c = await requireOrgContext();
  await requireBooksAuthorization({
    permission,
    orgId: c.orgId,
    userId: c.userId,
    supabase: c.supabase,
    resourceType: "legal_entity",
    resourceId: entityId ?? c.orgId,
    logDecision: true,
  });
  return c;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw new Error(`Entity setup could not complete: ${r.error.message}`);
  return r.data as unknown;
}
const entityRecord = z.object({
  id: uuid,
  org_id: uuid,
  code: z.string(),
  ledger_state: z.literal("setup"),
  created_by: uuid,
  creation_notes: z.string(),
  created_at: z.string(),
});
export async function createBooksLegalEntity(input: unknown) {
  const v = z
      .object({
        id: uuid,
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
        notes,
      })
      .strict()
      .parse(input),
    c = await context("books.manage");
  const entity = entityRecord.parse(
    await call("create_books_legal_entity", {
      p_org: c.orgId,
      p_id: v.id,
      p_code: v.code,
      p_actor: c.userId,
      p_notes: v.notes,
    }),
  );
  if (
    entity.id !== v.id ||
    entity.org_id !== c.orgId ||
    entity.created_by !== c.userId ||
    entity.code !== v.code ||
    entity.creation_notes !== v.notes
  )
    throw new Error("Entity creation receipt differs from request");
  return entity;
}
export async function setBooksLegalEntityMember(input: unknown) {
  const v = z
      .object({
        entityId: uuid,
        userId: uuid,
        accessLevel: z.enum(["read", "prepare", "review", "manage", "revoked"]),
        notes,
      })
      .strict()
      .parse(input),
    c = await context("books.manage", v.entityId);
  const r = z
    .object({
      org_id: z.literal(c.orgId),
      legal_entity_id: z.literal(v.entityId),
      user_id: z.literal(v.userId),
      access_level: z.literal(v.accessLevel),
      changed_by: z.literal(c.userId),
      change_notes: z.literal(v.notes),
      changed_at: z.string(),
    })
    .parse(
      await call("set_books_legal_entity_member", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_user: v.userId,
        p_level: v.accessLevel,
        p_notes: v.notes,
      }),
    );
  return r;
}
export async function prepareBooksLegalEntityProfile(input: unknown) {
  const v = z
      .object({
        entityId: uuid,
        id: uuid,
        previousProfileId: uuid.nullable(),
        profile: legalEntityProfileSchema,
        notes,
      })
      .strict()
      .parse(input),
    c = await context("books.manage", v.entityId);
  const result = z
    .object({
      id: z.literal(v.id),
      org_id: z.literal(c.orgId),
      legal_entity_id: z.literal(v.entityId),
      prepared_by: z.literal(c.userId),
      previous_profile_id: z.literal(v.previousProfileId),
      preparation_notes: z.literal(v.notes),
      revision: z.number().int().positive(),
    })
    .passthrough()
    .parse(
      await call("prepare_books_legal_entity_profile", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_id: v.id,
        p_actor: c.userId,
        p_previous: v.previousProfileId,
        p_profile: v.profile,
        p_notes: v.notes,
      }),
    );
  const frozenProfile = Object.fromEntries(
    Object.keys(v.profile).map((key) => [key, result[key]]),
  );
  if (booksDigest(frozenProfile) !== booksDigest(v.profile))
    throw new Error("Entity profile receipt differs from frozen request");
  return result;
}
export async function reviewBooksLegalEntityProfile(input: unknown) {
  const v = z
      .object({ entityId: uuid, profileId: uuid, notes })
      .strict()
      .parse(input),
    c = await context("books.manage", v.entityId);
  return z
    .object({
      org_id: z.literal(c.orgId),
      legal_entity_id: z.literal(v.entityId),
      profile_id: z.literal(v.profileId),
      reviewed_by: z.literal(c.userId),
      review_notes: z.literal(v.notes),
      reviewed_at: z.string(),
    })
    .parse(
      await call("review_books_legal_entity_profile", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_profile: v.profileId,
        p_actor: c.userId,
        p_notes: v.notes,
      }),
    );
}
export async function listBooksLegalEntitySetup(input: unknown = {}) {
  const v = z
      .object({ entityId: uuid.optional(), before: uuid.optional() })
      .strict()
      .refine((value) => !(value.entityId && value.before))
      .parse(input),
    c = await context("books.read", v.entityId);
  const r = z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId ?? null),
      entities: z
        .array(
          z.object({
            id: uuid,
            org_id: z.literal(c.orgId),
            ledger_state: z.literal("setup"),
            code: z.string(),
            reviewed_profile: z.record(z.unknown()).nullable(),
          }),
        )
        .max(50),
      nextCursor: uuid.nullable(),
      profiles: z.array(z.record(z.unknown())).max(50),
      moreProfiles: z.boolean(),
      members: z.array(z.record(z.unknown())).max(50),
      moreMembers: z.boolean(),
      accessHistory: z.array(z.record(z.unknown())).max(50),
      moreAccessHistory: z.boolean(),
    })
    .parse(
      await call("read_books_legal_entity_setup", {
        p_org: c.orgId,
        p_actor: c.userId,
        p_entity: v.entityId ?? null,
        p_before: v.before ?? null,
        p_limit: 50,
      }),
    );
  if (
    new Set(r.entities.map((entity) => entity.id)).size !== r.entities.length ||
    (v.entityId &&
      (r.entities.length !== 1 || r.entities[0].id !== v.entityId)) ||
    [...r.profiles, ...r.members, ...r.accessHistory].some(
      (row) => row.org_id !== c.orgId || row.legal_entity_id !== v.entityId,
    )
  )
    throw new Error("Entity setup response differs from authorized scope");
  return r;
}

export async function prepareBooksEntityCalendar(input: unknown) {
  const v = z
    .object({
      entityId: uuid,
      calendarId: uuid,
      profileId: uuid,
      startsInYear: z.number().int().min(1900).max(9997),
      notes,
    })
    .strict()
    .parse(input);
  const c = await context("books.manage", v.entityId);
  const r = await call("prepare_books_entity_calendar", {
    p_org: c.orgId,
    p_entity: v.entityId,
    p_id: v.calendarId,
    p_profile: v.profileId,
    p_actor: c.userId,
    p_year: v.startsInYear,
    p_notes: v.notes,
  });
  const receipt = z
    .object({
      year: entityCalendarYearSchema.extend({
        id: z.literal(v.calendarId),
        org_id: z.literal(c.orgId),
        legal_entity_id: z.literal(v.entityId),
        profile_id: z.literal(v.profileId),
        prepared_by: z.literal(c.userId),
        starts_in_year: z.literal(v.startsInYear),
        preparation_notes: z.literal(v.notes),
      }),
      periods: z
        .array(
          entityFiscalPeriodSchema.extend({
            org_id: z.literal(c.orgId),
            legal_entity_id: z.literal(v.entityId),
            calendar_year_id: z.literal(v.calendarId),
          }),
        )
        .length(12),
      ledgerActivated: z.literal(false),
    })
    .parse(r);
  const [year, month, day] = receipt.year.starts_on.split("-").map(Number);
  const boundary = (n: number) =>
    entityMonthBoundary(v.startsInYear, month, day, n);
  const preceding = (s: string) =>
    new Date(Date.parse(s + "T00:00:00Z") - 86400000)
      .toISOString()
      .slice(0, 10);
  if (
    year !== v.startsInYear ||
    receipt.year.starts_on !== boundary(0) ||
    receipt.year.ends_on !== preceding(boundary(12)) ||
    new Set(receipt.periods.map((p) => p.id)).size !== 12 ||
    new Set(receipt.periods.map((p) => p.period_number)).size !== 12 ||
    receipt.periods.some(
      (p) =>
        p.starts_on !== boundary(p.period_number - 1) ||
        p.ends_on !== preceding(boundary(p.period_number)),
    )
  )
    throw new Error(
      "Calendar preparation receipt has incomplete or divergent periods",
    );
  return receipt;
}
export async function reviewBooksEntityCalendar(input: unknown) {
  const v = z
      .object({ entityId: uuid, calendarId: uuid, reviewId: uuid, notes })
      .strict()
      .parse(input),
    c = await context("books.manage", v.entityId);
  return z
    .object({
      id: z.literal(v.reviewId),
      org_id: z.literal(c.orgId),
      legal_entity_id: z.literal(v.entityId),
      calendar_year_id: z.literal(v.calendarId),
      reviewed_by: z.literal(c.userId),
    })
    .passthrough()
    .parse(
      await call("review_books_entity_calendar", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_calendar: v.calendarId,
        p_id: v.reviewId,
        p_actor: c.userId,
        p_notes: v.notes,
      }),
    );
}
export async function listBooksEntityCalendars(input: unknown) {
  const v = z
      .object({ entityId: uuid, before: uuid.optional() })
      .strict()
      .parse(input),
    c = await context("books.read", v.entityId);
  const result = z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId),
      years: z
        .array(
          entityCalendarYearSchema.extend({
            org_id: z.literal(c.orgId),
            legal_entity_id: z.literal(v.entityId),
          }),
        )
        .max(50),
      periods: z
        .array(
          entityFiscalPeriodSchema.extend({
            org_id: z.literal(c.orgId),
            legal_entity_id: z.literal(v.entityId),
          }),
        )
        .max(600),
      reviews: z
        .array(
          entityCalendarReviewSchema.extend({
            org_id: z.literal(c.orgId),
            legal_entity_id: z.literal(v.entityId),
          }),
        )
        .max(50),
      nextCursor: uuid.nullable(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("read_books_entity_calendars", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_before: v.before ?? null,
        p_limit: 50,
      }),
    );
  const ids = new Set(result.years.map((y) => y.id));
  if (
    ids.size !== result.years.length ||
    new Set(result.periods.map((p) => p.id)).size !== result.periods.length ||
    new Set(result.reviews.map((r) => r.calendar_year_id)).size !==
      result.reviews.length ||
    result.periods.some((p) => !ids.has(p.calendar_year_id)) ||
    result.reviews.some((r) => !ids.has(r.calendar_year_id)) ||
    result.years.some(
      (y) =>
        result.periods.filter((p) => p.calendar_year_id === y.id).length !== 12,
    )
  )
    throw new Error("Entity calendar page has inconsistent scoped history");
  return result;
}

export async function prepareBooksEntityChart(input: unknown) {
  const v = z
    .object({
      entityId: uuid,
      chartId: uuid,
      profileId: uuid,
      previousChartId: uuid.nullable(),
      effectiveOn: date,
      definition: entityChartDefinitionSchema,
      notes,
    })
    .strict()
    .parse(input);
  const c = await context("books.manage", v.entityId);
  const result = z
    .object({
      chart: entityChartVersionSchema.extend({
        id: z.literal(v.chartId),
        org_id: z.literal(c.orgId),
        legal_entity_id: z.literal(v.entityId),
        profile_id: z.literal(v.profileId),
        previous_reviewed_chart_id:
          v.previousChartId === null ? z.null() : z.literal(v.previousChartId),
        prepared_by: z.literal(c.userId),
        effective_on: z.literal(v.effectiveOn),
        preparation_notes: z.literal(v.notes),
      }),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("prepare_books_entity_chart", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_id: v.chartId,
        p_profile: v.profileId,
        p_previous: v.previousChartId,
        p_actor: c.userId,
        p_effective: v.effectiveOn,
        p_definition: v.definition,
        p_notes: v.notes,
      }),
    );
  if (
    booksDigest(JSON.parse(result.chart.definition_text)) !==
      booksDigest(v.definition) ||
    createHash("sha256")
      .update(result.chart.definition_text, "utf8")
      .digest("hex") !== result.chart.definition_sha256
  )
    throw new Error("Chart preparation differs from original request");
  return result;
}
export async function reviewBooksEntityChart(input: unknown) {
  const v = z
      .object({ entityId: uuid, chartId: uuid, reviewId: uuid, notes })
      .strict()
      .parse(input),
    c = await context("books.manage", v.entityId);
  return entityChartReviewSchema
    .extend({
      id: z.literal(v.reviewId),
      org_id: z.literal(c.orgId),
      legal_entity_id: z.literal(v.entityId),
      chart_id: z.literal(v.chartId),
      reviewed_by: z.literal(c.userId),
      review_notes: z.literal(v.notes),
    })
    .parse(
      await call("review_books_entity_chart", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_chart: v.chartId,
        p_id: v.reviewId,
        p_actor: c.userId,
        p_notes: v.notes,
      }),
    );
}
export async function readBooksEntityChart(input: unknown) {
  const v = z.object({ entityId: uuid, chartId: uuid }).strict().parse(input),
    c = await context("books.read", v.entityId);
  const scoped = {
    org_id: z.literal(c.orgId),
    legal_entity_id: z.literal(v.entityId),
  };
  const r = z
    .object({
      chart: entityChartVersionSchema.extend({
        ...scoped,
        id: z.literal(v.chartId),
      }),
      accounts: z.array(entityAccountSchema.extend(scoped)).max(1000),
      definitions: z
        .array(
          entityAccountDefinitionSchema.extend({
            ...scoped,
            chart_id: z.literal(v.chartId),
          }),
        )
        .max(1000),
      controls: z
        .array(
          entityControlAccountSchema.extend({
            ...scoped,
            chart_id: z.literal(v.chartId),
          }),
        )
        .max(100),
      review: entityChartReviewSchema
        .extend({ ...scoped, chart_id: z.literal(v.chartId) })
        .nullable(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("read_books_entity_chart", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_chart: v.chartId,
        p_actor: c.userId,
      }),
    );
  for (const rows of [r.accounts, r.definitions, r.controls])
    if (new Set(rows.map((x) => x.id)).size !== rows.length)
      throw new Error("Chart receipt duplicates row identities");
  assertEntityChartRows(r.chart, r.accounts, r.definitions, r.controls);
  if (
    r.review &&
    (r.review.reviewed_by === r.chart.prepared_by ||
      r.review.effective_on !== r.chart.effective_on)
  )
    throw new Error("Chart review receipt is not independent or applicable");
  return r;
}
export async function listBooksEntityCharts(input: unknown) {
  const v = z
      .object({ entityId: uuid, before: uuid.optional() })
      .strict()
      .parse(input),
    c = await context("books.read", v.entityId);
  const scoped = {
    org_id: z.literal(c.orgId),
    legal_entity_id: z.literal(v.entityId),
  };
  const r = z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId),
      charts: z
        .array(
          entityChartVersionSchema
            .omit({ definition_text: true })
            .extend(scoped),
        )
        .max(50),
      reviews: z.array(entityChartReviewSchema.extend(scoped)).max(50),
      nextCursor: uuid.nullable(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("read_books_entity_charts", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_before: v.before ?? null,
        p_limit: 50,
      }),
    );
  const ids = new Set(r.charts.map((x) => x.id));
  if (
    ids.size !== r.charts.length ||
    new Set(r.reviews.map((x) => x.chart_id)).size !== r.reviews.length ||
    r.reviews.some((x) => !ids.has(x.chart_id)) ||
    (r.nextCursor &&
      (r.charts.length !== 50 || r.nextCursor !== r.charts.at(-1)?.id)) ||
    r.charts.some((x) => v.before && x.id <= v.before)
  )
    throw new Error("Chart page receipt differs from entity or cursor");
  return r;
}

export async function readBooksEntityChartEditorContext(input: unknown) {
  const v = z
      .object({
        entityId: uuid,
        before: z.number().int().positive().optional(),
      })
      .strict()
      .parse(input),
    c = await context("books.read", v.entityId);
  const r = z
    .object({
      orgId: z.literal(c.orgId),
      entityId: z.literal(v.entityId),
      latestReviewedChartId: uuid.nullable(),
      latestReviewedEffectiveOn: date.nullable(),
      profiles: z
        .array(
          z.object({
            id: uuid,
            revision: z.number().int().positive(),
            effective_on: date,
            legal_name: z.string().min(1),
          }),
        )
        .max(50),
      nextProfileCursor: z.number().int().positive().nullable(),
      ledgerActivated: z.literal(false),
    })
    .parse(
      await call("read_books_entity_chart_editor_context", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_actor: c.userId,
        p_before: v.before ?? null,
        p_limit: 50,
      }),
    );
  if (
    (r.latestReviewedChartId === null) !==
      (r.latestReviewedEffectiveOn === null) ||
    new Set(r.profiles.map((p) => p.id)).size !== r.profiles.length ||
    new Set(r.profiles.map((p) => p.revision)).size !== r.profiles.length ||
    r.profiles.some(
      (p, i) =>
        (v.before !== undefined && p.revision >= v.before) ||
        (i > 0 && p.revision >= r.profiles[i - 1].revision),
    ) ||
    (r.nextProfileCursor !== null &&
      (r.profiles.length !== 50 ||
        r.nextProfileCursor !== r.profiles.at(-1)?.revision))
  )
    throw new Error(
      "Chart editor context differs from reviewed head or profile cursor",
    );
  return r;
}
