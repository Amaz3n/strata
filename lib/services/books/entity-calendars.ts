import { z } from "zod";
import { timestampMicros } from "./posting-state";
export const ENTITY_CALENDAR_TABLES = [
  "books_entity_calendar_years",
  "books_entity_fiscal_periods",
  "books_entity_calendar_reviews",
] as const;
/** Anchored monthly boundaries clip short months without drifting subsequent months. */
export function entityMonthBoundary(
  year: number,
  month: number,
  day: number,
  offset: number,
) {
  const base = new Date(Date.UTC(year, month - 1 + offset, 1));
  const end = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(day, end)),
  )
    .toISOString()
    .slice(0, 10);
}
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const yearSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  profile_id: uuid,
  starts_in_year: z.number().int().min(1900).max(9997),
  starts_on: z.string(),
  ends_on: z.string(),
  prepared_by: uuid,
  prepared_at: z.string(),
  prepared_access_event_id: uuid,
  preparation_notes: z.string().trim().min(10).max(2000),
});
const periodSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  calendar_year_id: uuid,
  period_number: z.number().int().min(1).max(12),
  starts_on: z.string(),
  ends_on: z.string(),
});
const reviewSchema = z.object({
  id: uuid,
  org_id: uuid,
  legal_entity_id: uuid,
  calendar_year_id: uuid,
  starts_in_year: z.number().int(),
  reviewed_by: uuid,
  reviewed_at: z.string(),
  reviewed_access_event_id: uuid,
  review_notes: z.string().trim().min(10).max(2000),
});
const timeValue = (value: unknown): bigint => {
  if (typeof value !== "string") throw Error("Calendar timestamp is missing");
  const result = timestampMicros(value);
  if (result === null) throw Error("Calendar timestamp is invalid");
  return result;
};
const micros = timeValue;
const previousDay = (date: string) =>
  new Date(Date.parse(date + "T00:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
export function verifyEntityCalendarArchive(
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  version: number,
): string[] {
  if (version < 21)
    return ENTITY_CALENDAR_TABLES.some((t) => (tables[t] ?? []).length)
      ? ["Entity calendars require archive schema21"]
      : [];
  try {
    if (ENTITY_CALENDAR_TABLES.some((t) => !tables[t]))
      throw Error("Missing entity calendar history");
    const years = tables.books_entity_calendar_years.map((r) =>
        yearSchema.parse(r),
      ),
      periods = tables.books_entity_fiscal_periods.map((r) =>
        periodSchema.parse(r),
      ),
      reviews = tables.books_entity_calendar_reviews.map((r) =>
        reviewSchema.parse(r),
      );
    for (const rows of [years, periods, reviews])
      if (
        new Set(rows.map((r) => r.id)).size !== rows.length ||
        rows.some((r) => r.org_id !== org)
      )
        throw Error("Calendar identities or organization differ");
    const profiles = tables.books_legal_entity_profiles ?? [],
      profileReviews = tables.books_legal_entity_profile_reviews ?? [],
      events = tables.books_legal_entity_access_history ?? [];
    const applicable = (entity: string, startsOn: string, at: string) =>
      profiles
        .filter(
          (p) =>
            p.org_id === org &&
            p.legal_entity_id === entity &&
            String(p.effective_on) <= startsOn &&
            profileReviews.some(
              (r) =>
                r.profile_id === p.id && micros(r.reviewed_at) <= micros(at),
            ),
        )
        .sort((a, b) => Number(b.revision) - Number(a.revision))[0]?.id;
    const authority = (
      id: string,
      entity: string,
      actor: string,
      time: string,
      operation: string,
    ) => {
      const event = events.find(
        (e) =>
          e.id === id &&
          e.org_id === org &&
          e.legal_entity_id === entity &&
          e.user_id === actor,
      );
      if (
        !event ||
        ![operation, "manage"].includes(String(event.access_level)) ||
        micros(event.changed_at) > timeValue(time) ||
        events.some(
          (e) =>
            e.org_id === org &&
            e.legal_entity_id === entity &&
            e.user_id === actor &&
            BigInt(String(e.sequence_no)) > BigInt(String(event.sequence_no)) &&
            micros(e.changed_at) <= timeValue(time),
        )
      )
        throw Error("Calendar authority differs from pinned access event");
    };
    for (const y of years) {
      const p = profiles.find(
          (p) =>
            p.id === y.profile_id &&
            p.org_id === org &&
            p.legal_entity_id === y.legal_entity_id,
        ),
        pr = profileReviews.find(
          (r) =>
            r.profile_id === y.profile_id &&
            r.org_id === org &&
            r.legal_entity_id === y.legal_entity_id,
        );
      if (
        !p ||
        !pr ||
        String(p.effective_on) > y.starts_on ||
        micros(pr.reviewed_at) > micros(y.prepared_at) ||
        applicable(y.legal_entity_id, y.starts_on, y.prepared_at) !==
          y.profile_id
      )
        throw Error("Calendar lacks applicable independently reviewed profile");
      authority(
        y.prepared_access_event_id,
        y.legal_entity_id,
        y.prepared_by,
        y.prepared_at,
        "prepare",
      );
      const boundary = (n: number) =>
        entityMonthBoundary(
          y.starts_in_year,
          Number(p.fiscal_start_month),
          Number(p.fiscal_start_day),
          n,
        );
      if (
        y.starts_on !== boundary(0) ||
        y.ends_on !== previousDay(boundary(12))
      )
        throw Error("Calendar year dates differ from retained profile");
      const ps = periods.filter((r) => r.calendar_year_id === y.id);
      if (
        ps.length !== 12 ||
        new Set(ps.map((r) => r.period_number)).size !== 12 ||
        ps.some(
          (r) =>
            r.legal_entity_id !== y.legal_entity_id ||
            r.starts_on !== boundary(r.period_number - 1) ||
            r.ends_on !== previousDay(boundary(r.period_number)),
        )
      )
        throw Error("Calendar periods are incomplete or diverge");
    }
    if (periods.some((p) => !years.some((y) => y.id === p.calendar_year_id)))
      throw Error("Orphan fiscal period");
    const reviewed = new Set<string>();
    for (const r of reviews) {
      const y = years.find((y) => y.id === r.calendar_year_id);
      if (
        !y ||
        y.legal_entity_id !== r.legal_entity_id ||
        y.starts_in_year !== r.starts_in_year ||
        r.reviewed_by === y.prepared_by ||
        micros(r.reviewed_at) < micros(y.prepared_at) ||
        reviewed.has(y.id) ||
        applicable(y.legal_entity_id, y.starts_on, r.reviewed_at) !==
          y.profile_id
      )
        throw Error("Calendar review differs from independent preparation");
      authority(
        r.reviewed_access_event_id,
        r.legal_entity_id,
        r.reviewed_by,
        r.reviewed_at,
        "review",
      );
      reviewed.add(y.id);
      for (const other of reviews.filter((x) => x.id !== r.id)) {
        const x = years.find((y) => y.id === other.calendar_year_id);
        if (
          x &&
          x.legal_entity_id === y.legal_entity_id &&
          x.starts_on <= y.ends_on &&
          x.ends_on >= y.starts_on
        )
          throw Error("Reviewed entity calendars overlap");
      }
    }
    const approved = years.filter((y) => reviewed.has(y.id));
    for (const entity of new Set(approved.map((y) => y.legal_entity_id))) {
      const ordered = approved
        .filter((y) => y.legal_entity_id === entity)
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
      for (let n = 1; n < ordered.length; n++)
        if (previousDay(ordered[n].starts_on) !== ordered[n - 1].ends_on)
          throw Error("Reviewed fiscal calendars have an unexplained date gap");
    }
    return [];
  } catch (e) {
    return [
      "Invalid entity calendar history: " +
        (e instanceof Error ? e.message : String(e)),
    ];
  }
}

export {
  yearSchema as entityCalendarYearSchema,
  periodSchema as entityFiscalPeriodSchema,
  reviewSchema as entityCalendarReviewSchema,
};
