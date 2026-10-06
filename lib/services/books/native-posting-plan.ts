import { createHash } from "node:crypto";
import { z } from "zod";
import { booksDigest } from "./hash";
import {
  entityChartDefinitionSchema,
  ENTITY_CONTROL_ROLES,
} from "./entity-chart";
import {
  projectOwnershipProposalSchema,
  projectOwnershipReviewSchema,
} from "./project-entity-contract";
import { timestampMicros } from "./posting-state";
import { assertBalancedJournalDraft } from "./types";
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  });
const approval = {
  org_id: uuid,
  legal_entity_id: uuid,
  reviewed_by: uuid,
  reviewed_at: z.string().datetime({ offset: true }),
};
const prepared = {
  prepared_by: uuid,
  prepared_at: z.string().datetime({ offset: true }),
};
const scoped = { id: uuid, org_id: uuid, legal_entity_id: uuid };
export const nativePostingContextSchema = z.object({
  orgId: uuid,
  projectId: uuid,
  actorId: uuid,
  sourceType: z.enum(["invoice", "vendor_bill", "expense"]),
  sourceId: uuid,
  entryDate: date,
  source: z.object({ id: uuid, org_id: uuid, project_id: uuid }).passthrough(),
  owner: projectOwnershipReviewSchema,
  ownershipProposal: projectOwnershipProposalSchema,
  profile: z
    .object({
      ...scoped,
      ...prepared,
      functional_currency: z.literal("USD"),
      effective_on: date,
    })
    .passthrough(),
  chart: z
    .object({
      ...scoped,
      ...prepared,
      effective_on: date,
      definition_text: z.string().max(4194304),
      definition_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .passthrough(),
  profileReview: z.object({ ...approval, profile_id: uuid }).passthrough(),
  chartReview: z
    .object({ ...approval, id: uuid, chart_id: uuid })
    .passthrough(),
  calendarReview: z
    .object({ ...approval, id: uuid, calendar_year_id: uuid })
    .passthrough(),
  period: z
    .object({
      ...scoped,
      calendar_year_id: uuid,
      period_number: z.number().int().min(1).max(12),
      starts_on: date,
      ends_on: date,
    })
    .passthrough(),
  calendar: z
    .object({ ...scoped, ...prepared, starts_on: date, ends_on: date })
    .passthrough(),
  accounts: z
    .array(
      z.object({
        id: uuid,
        code: z.string().min(1).max(32),
        definition: z.object({
          ...scoped,
          chart_id: uuid,
          account_id: uuid,
          parent_account_id: uuid.nullable(),
          name: z.string(),
          account_type: z.string(),
          subtype: z.string(),
          normal_balance: z.string(),
          cash_flow_category: z.string().nullable(),
        }),
      }),
    )
    .min(1)
    .max(1000),
  controls: z
    .array(
      z.object({
        ...scoped,
        chart_id: uuid,
        role: z.string(),
        account_id: uuid,
      }),
    )
    .length(51),
  capturedAt: z.string().datetime({ offset: true }),
  databaseSnapshot: z.string().min(1),
  ledgerActivated: z.literal(false),
});
export const nativeJournalDraftSchema = z
  .object({
    entryDate: date,
    entryKind: z.enum([
      "operational",
      "adjusting",
      "opening",
      "poc",
      "closing",
      "reversal",
    ]),
    memo: z.string().max(2000),
    postingKey: z.string().min(1).max(1000),
    projectionVersion: z.number().int().positive().safe(),
    policyVersion: z.number().int().positive().safe(),
    sourceType: z.string(),
    sourceId: uuid,
    lines: z
      .array(
        z
          .object({
            accountCode: z.string().min(1).max(32),
            accountRole: z
              .string()
              .refine((v) => Object.hasOwn(ENTITY_CONTROL_ROLES, v))
              .optional(),
            debitCents: z.number().int().safe().nonnegative(),
            creditCents: z.number().int().safe().nonnegative(),
            description: z.string().max(2000).optional(),
            projectId: uuid.optional(),
            companyId: uuid.optional(),
            dimensions: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(1000),
  })
  .strict();
export type NativePostingContext = z.infer<typeof nativePostingContextSchema>;
/** Canonical account/date routing only. The atomic native writer must revalidate
 * this snapshot and add source-specific fact, close, funding and dimension proof.
 * A plan is deliberately not a posted journal or an official-ledger activation. */
export function verifyNativeProjectPostingContext(context: unknown) {
  const c = nativePostingContextSchema.parse(context),
    entity = c.owner.legal_entity_id;
  const scope = (r: { org_id: string; legal_entity_id: string }) =>
    r.org_id === c.orgId && r.legal_entity_id === entity;
  if (
    c.source.org_id !== c.orgId ||
    c.source.id !== c.sourceId ||
    c.source.project_id !== c.projectId ||
    !scope(c.owner) ||
    !scope(c.ownershipProposal) ||
    c.owner.project_id !== c.projectId ||
    c.ownershipProposal.project_id !== c.projectId ||
    c.owner.proposal_id !== c.ownershipProposal.id ||
    c.owner.reviewed_by === c.ownershipProposal.prepared_by ||
    c.ownershipProposal.effective_on > c.entryDate ||
    !scope(c.profile) ||
    c.profile.effective_on > c.entryDate ||
    !scope(c.chart) ||
    c.chart.effective_on > c.entryDate ||
    !scope(c.period) ||
    !scope(c.calendar) ||
    c.period.calendar_year_id !== c.calendar.id ||
    c.entryDate < c.period.starts_on ||
    c.entryDate > c.period.ends_on ||
    c.period.starts_on < c.calendar.starts_on ||
    c.period.ends_on > c.calendar.ends_on
  )
    throw Error(
      "Native posting owner, source, chart or fiscal calendar scope differs",
    );
  if (
    createHash("sha256").update(c.chart.definition_text).digest("hex") !==
    c.chart.definition_sha256
  )
    throw Error("Native chart original definition checksum differs");
  const definition = entityChartDefinitionSchema.parse(
      JSON.parse(c.chart.definition_text),
    ),
    byCode = new Map(c.accounts.map((a) => [a.code, a])),
    ids = new Set(c.accounts.map((a) => a.id));
  if (
    byCode.size !== c.accounts.length ||
    ids.size !== c.accounts.length ||
    definition.accounts.length !== c.accounts.length
  )
    throw Error("Native chart account inventory differs");
  for (const a of definition.accounts) {
    const account = byCode.get(a.code),
      row = account?.definition;
    if (
      !account ||
      !row ||
      !scope(row) ||
      row.chart_id !== c.chart.id ||
      row.account_id !== account.id ||
      row.name !== a.name ||
      row.account_type !== a.account_type ||
      row.subtype !== a.subtype ||
      row.normal_balance !== a.normal_balance ||
      row.cash_flow_category !== a.cash_flow_category ||
      row.parent_account_id !==
        (a.parent_code ? byCode.get(a.parent_code)?.id : null)
    )
      throw Error(
        "Native account identity/classification differs from original chart",
      );
  }
  const roles = new Set<string>();
  for (const r of c.controls) {
    if (
      !scope(r) ||
      r.chart_id !== c.chart.id ||
      roles.has(r.role) ||
      byCode.get(definition.controls[r.role])?.id !== r.account_id
    )
      throw Error("Native control binding differs from reviewed entity chart");
    roles.add(r.role);
  }
  const at = (v: string) => {
    const t = timestampMicros(v);
    if (t === null) throw Error("Invalid native approval timestamp");
    return t;
  };
  const captured = at(c.capturedAt);
  if (
    at(c.ownershipProposal.prepared_at) > at(c.owner.reviewed_at) ||
    at(c.owner.reviewed_at) > captured
  )
    throw Error("Native project owner approval chronology differs");
  for (const [prepared, review, target] of [
    [c.profile, c.profileReview, c.profileReview.profile_id],
    [c.chart, c.chartReview, c.chartReview.chart_id],
    [c.calendar, c.calendarReview, c.calendarReview.calendar_year_id],
  ] as const) {
    if (
      !scope(review) ||
      target !== prepared.id ||
      prepared.prepared_by === review.reviewed_by ||
      at(prepared.prepared_at) > at(review.reviewed_at) ||
      at(review.reviewed_at) > captured
    )
      throw Error("Native profile/chart/calendar approval receipt differs");
  }
  return { context: c, byCode, controlCodes: definition.controls };
}
export function buildNativeProjectPostingPlan(
  context: unknown,
  draft: unknown,
) {
  const {
      context: c,
      byCode,
      controlCodes,
    } = verifyNativeProjectPostingContext(context),
    d = nativeJournalDraftSchema.parse(draft),
    entity = c.owner.legal_entity_id;
  assertBalancedJournalDraft(d);
  if (
    d.sourceType !== c.sourceType ||
    d.sourceId !== c.sourceId ||
    d.entryDate !== c.entryDate
  )
    throw Error("Native journal differs from actual source/date context");
  const lines = d.lines.map((line, index) => {
    const code = line.accountRole
      ? controlCodes[line.accountRole]
      : line.accountCode;
    const account = byCode.get(code);
    if (!account)
      throw Error(
        "Journal account is absent from applicable native entity chart: " +
          line.accountCode,
      );
    if (line.projectId !== undefined && line.projectId !== c.projectId)
      throw Error("Native line belongs to another project");
    if (
      line.dimensions?.project_id !== undefined &&
      line.dimensions.project_id !== c.projectId
    )
      throw Error("Native project dimension differs from source owner");
    const projects = line.dimensions?.project_dimensions;
    if (
      projects !== undefined &&
      (!projects ||
        typeof projects !== "object" ||
        Array.isArray(projects) ||
        Object.keys(projects).some((p) => p !== c.projectId))
    )
      throw Error(
        "Native split projects require reviewed explicit entity legs",
      );
    return {
      ...line,
      position: index + 1,
      sourceAccountCode: line.accountCode,
      accountCode: account.code,
      accountId: account.id,
      projectId: c.projectId,
      legalEntityId: entity,
      chartId: c.chart.id,
    };
  });
  const total = d.lines.reduce((sum, l) => sum + BigInt(l.debitCents), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error(
      "Native journal aggregate cents exceed the supported exact range",
    );
  const plan = {
    version: 1 as const,
    orgId: c.orgId,
    legalEntityId: entity,
    projectId: c.projectId,
    actorId: c.actorId,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    sourceSnapshot: c.source,
    sourceSnapshotSha256: booksDigest(c.source),
    ownershipReviewId: c.owner.id,
    ownershipProposalId: c.ownershipProposal.id,
    profileId: c.profile.id,
    profileReview: c.profileReview,
    chartReview: c.chartReview,
    calendarReview: c.calendarReview,
    chartId: c.chart.id,
    chartDefinitionSha256: c.chart.definition_sha256,
    calendarYearId: c.calendar.id,
    periodId: c.period.id,
    entryDate: d.entryDate,
    entryKind: d.entryKind,
    memo: d.memo,
    postingKey: `entity:${entity}:${d.postingKey}`,
    projectionVersion: d.projectionVersion,
    policyVersion: d.policyVersion,
    totalCents: Number(total),
    lines,
    capturedAt: c.capturedAt,
    databaseSnapshot: c.databaseSnapshot,
  };
  return {
    plan,
    planSha256: booksDigest(plan),
    posted: false as const,
    ledgerActivated: false as const,
  };
}
