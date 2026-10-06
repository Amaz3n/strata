import { booksDigest } from "./hash";
import { nativeReceiptTime } from "./native-adjustment-contract";
import type { nativePostingContextSchema } from "./native-posting-plan";
import type { z } from "zod";
/** Frozen definition closure shared by money and preparatory coding histories. */
export function verifyNativeContextArchive(
  c: z.infer<typeof nativePostingContextSchema>,
  tables: Record<string, Record<string, unknown>[]>,
  org: string,
  requireCurrentSourceProject = true,
) {
  const match = (table: string, id: unknown) => {
    const rows = (tables[table] ?? []).filter(
      (r) => r.org_id === org && r.id === id,
    );
    if (rows.length !== 1)
      throw Error("Missing or ambiguous native dependency: " + table);
    return rows[0];
  };
  const pairs = [
    ["books_project_entity_reviews", c.owner],
    ["books_project_entity_proposals", c.ownershipProposal],
    ["books_legal_entity_profiles", c.profile],
    ["books_legal_entity_profile_reviews", c.profileReview],
    ["books_entity_chart_versions", c.chart],
    ["books_entity_chart_reviews", c.chartReview],
    ["books_entity_calendar_years", c.calendar],
    ["books_entity_calendar_reviews", c.calendarReview],
    ["books_entity_fiscal_periods", c.period],
    ...c.controls.map((r) => ["books_entity_control_accounts", r]),
    ...c.accounts.map((r) => [
      "books_entity_account_definitions",
      r.definition,
    ]),
  ] as [string, Record<string, unknown>][];
  for (const [table, row] of pairs) {
    const retained = match(table, row.id);
    // Snapshot schemas intentionally select fields. All selected immutable fields must agree.
    if (
      Object.entries(row).some(
        ([k, v]) => booksDigest(v) !== booksDigest(retained[k]),
      )
    )
      throw Error("Native context differs from retained " + table);
  }
  const captured = nativeReceiptTime(c.capturedAt),
    entity = c.owner.legal_entity_id;
  const approvedBefore = (table: string, field: string, id: unknown) =>
    (tables[table] ?? []).some(
      (r) =>
        r.org_id === org &&
        r.legal_entity_id === entity &&
        r[field] === id &&
        nativeReceiptTime(String(r.reviewed_at)) <= captured,
    );
  const profiles = (tables.books_legal_entity_profiles ?? [])
    .filter(
      (r) =>
        r.org_id === org &&
        r.legal_entity_id === entity &&
        String(r.effective_on) <= c.entryDate &&
        approvedBefore(
          "books_legal_entity_profile_reviews",
          "profile_id",
          r.id,
        ),
    )
    .sort((a, b) => Number(b.revision) - Number(a.revision));
  const charts = (tables.books_entity_chart_versions ?? [])
    .filter(
      (r) =>
        r.org_id === org &&
        r.legal_entity_id === entity &&
        String(r.effective_on) <= c.entryDate &&
        approvedBefore("books_entity_chart_reviews", "chart_id", r.id),
    )
    .sort((a, b) =>
      String(b.effective_on).localeCompare(String(a.effective_on)),
    );
  if (
    profiles[0]?.id !== c.profile.id ||
    charts[0]?.id !== c.chart.id ||
    !approvedBefore(
      "books_entity_calendar_reviews",
      "calendar_year_id",
      c.calendar.id,
    ) ||
    nativeReceiptTime(c.owner.reviewed_at) > captured
  )
    throw Error("Native historical effective definition selection differs");
  const source = match(
    c.sourceType === "invoice"
      ? "invoices"
      : c.sourceType === "vendor_bill"
        ? "vendor_bills"
        : "project_expenses",
    c.sourceId,
  );
  if (
    (requireCurrentSourceProject && source.project_id !== c.projectId) ||
    match("projects", c.projectId).org_id !== org
  )
    throw Error("Native actual source project differs");
  for (const account of c.accounts) {
    const a = match("books_entity_accounts", account.id);
    if (
      a.legal_entity_id !== c.owner.legal_entity_id ||
      a.code !== account.code
    )
      throw Error("Native canonical account differs");
  }
}
