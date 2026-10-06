import { z } from "zod";
import { booksDigest } from "./hash";
import {
  nativePostingContextSchema,
  verifyNativeProjectPostingContext,
  buildNativeProjectPostingPlan,
} from "./native-posting-plan";
import { nativeContextMeaning } from "./native-adjustment-contract";
import { timestampMicros } from "./posting-state";
import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status";
import { readClosedSettlementEvidence } from "@/lib/financials/closing-settlement-evidence";
import { resolveProjectRevenueBasis } from "@/lib/financials/project-revenue-basis";
import type { JournalLineDraft } from "./types";
const uuid = z
    .string()
    .uuid()
    .refine((v) => v === v.toLowerCase()),
  date = nativePostingContextSchema.shape.entryDate;
const scoped = z.object({ id: uuid, org_id: uuid }).passthrough();
export const nativeInvoiceEconomicSchema = z.object({
  native: nativePostingContextSchema,
  settings: z
    .object({
      org_id: uuid,
      workspace_enabled: z.literal(true),
      active_policy_version: z.number().int().positive().safe(),
    })
    .passthrough(),
  policy: scoped.extend({
    version: z.number().int().positive().safe(),
    status: z.literal("approved"),
    effective_on: date,
    created_by: uuid,
    approved_by: uuid,
    created_at: z.string(),
    approved_at: z.string(),
    policy: z.record(z.unknown()),
  }),
  project: scoped.extend({
    status: z
      .enum([
        "planning",
        "bidding",
        "active",
        "on_hold",
        "completed",
        "cancelled",
      ])
      .nullable()
      .optional(),
    property_type: z
      .enum(["residential", "commercial", "production"])
      .nullable()
      .optional(),
  }),
  financialSettings: z
    .object({
      org_id: uuid,
      project_id: uuid,
      billing_model: z.enum([
        "fixed_price",
        "cost_plus_percent",
        "cost_plus_fixed_fee",
        "cost_plus_gmp",
        "time_and_materials",
      ]),
      fixed_price_billing_basis: z
        .enum(["draws", "progress"])
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable(),
  contracts: z
    .array(
      scoped.extend({
        project_id: uuid,
        status: z.enum([
          "draft",
          "active",
          "amended",
          "completed",
          "terminated",
          "superseded",
        ]),
        parent_contract_id: uuid.nullable(),
        effective_date: date.nullable(),
        contract_type: z
          .enum([
            "fixed_price",
            "cost_plus",
            "time_materials",
            "fixed",
            "unit_price",
            "purchase_agreement",
          ])
          .optional(),
        fixed_fee_cents: z.number().nullable().optional(),
        gmp_cents: z.number().nullable().optional(),
        snapshot: z.record(z.unknown()).nullable().optional(),
        open_book: z.boolean().nullable().optional(),
        requires_client_cost_approval: z.boolean().nullable().optional(),
      }),
    )
    .max(1000),
  lines: z
    .array(
      z.object({
        source: scoped.extend({
          invoice_id: uuid,
          cost_code_id: uuid.nullable(),
          metadata: z.record(z.unknown()).nullable(),
          quantity: z.number().nullable(),
          unit_price_cents: z.number().int().safe().nullable(),
        }),
        quantity: z.string().nullable(),
        unitPriceCents: z.string().nullable(),
        costCode: scoped.nullable(),
      }),
    )
    .max(1000),
  retainage: z
    .array(
      scoped.extend({
        project_id: uuid,
        invoice_id: uuid.nullable(),
        release_invoice_id: uuid.nullable(),
        amount_cents: z.number().int().nonnegative().safe(),
      }),
    )
    .max(1000),
  originalInvoices: z.array(scoped.extend({ project_id: uuid })).max(1000),
  closings: z
    .array(
      scoped.extend({
        project_id: uuid,
        closing_invoice_id: uuid.nullable(),
        status: z.string(),
        actual_date: date.nullable(),
        settlement: z.record(z.unknown()),
      }),
    )
    .max(1000),
  postingHold: scoped
    .extend({
      legal_entity_id: uuid,
      period_id: uuid,
      decision: z.enum(["hold", "release"]),
    })
    .nullable(),
});
const safe = (n: bigint) => {
  const v = Number(n);
  if (!Number.isSafeInteger(v))
    throw Error("Native invoice money exceeds safe integer cents");
  return v;
};
/** Exact decimal multiplication; PostgreSQL numeric rounding (ties away from zero). */
export function nativeInvoiceLineCents(quantity: string, unit: string) {
  if (
    !/^-?\d{1,12}(?:\.\d{1,6})?$/.test(quantity) ||
    !/^(-?[1-9]\d*|0)$/.test(unit)
  )
    throw Error(
      "Native invoice line requires exact bounded decimal quantity and integer unit cents",
    );
  safe(BigInt(unit));
  const negative = quantity.startsWith("-"),
    [whole, fraction = ""] = quantity.replace(/^-/, "").split("."),
    denom = 10n ** BigInt(fraction.length),
    numerator = BigInt(whole + fraction) * (negative ? -1n : 1n) * BigInt(unit),
    absolute = numerator < 0n ? -numerator : numerator;
  return safe(
    (absolute / denom + ((absolute % denom) * 2n >= denom ? 1n : 0n)) *
      (numerator < 0n ? -1n : 1n),
  );
}
export function verifyNativeInvoiceEconomicContext(value: unknown) {
  const e = nativeInvoiceEconomicSchema.parse(value),
    v = verifyNativeProjectPostingContext(e.native),
    c = v.context,
    org = c.orgId,
    project = c.projectId;
  const at = timestampMicros(c.capturedAt),
    approved = timestampMicros(e.policy.approved_at),
    created = timestampMicros(e.policy.created_at);
  if (
    c.sourceType !== "invoice" ||
    e.project.id !== project ||
    e.project.org_id !== org ||
    e.settings.org_id !== org ||
    e.policy.org_id !== org ||
    e.policy.version !== e.settings.active_policy_version ||
    e.policy.effective_on > c.entryDate ||
    e.policy.created_by === e.policy.approved_by ||
    at === null ||
    approved === null ||
    created === null ||
    created > approved ||
    approved > at
  )
    throw Error(
      "Native invoice economic policy, approval or project scope differs",
    );
  if (
    e.financialSettings &&
    (e.financialSettings.org_id !== org ||
      e.financialSettings.project_id !== project)
  )
    throw Error("Native invoice billing configuration is foreign");
  for (const [label, rows] of [
    ["contract", e.contracts],
    ["retainage", e.retainage],
    ["original invoice", e.originalInvoices],
    ["closing", e.closings],
  ] as const) {
    if (
      new Set(rows.map((r) => r.id)).size !== rows.length ||
      rows.some((r) => r.org_id !== org || r.project_id !== project)
    )
      throw Error(
        "Native invoice " + label + " inventory is foreign or duplicated",
      );
  }
  if (new Set(e.lines.map((l) => l.source.id)).size !== e.lines.length)
    throw Error("Native invoice line inventory is duplicated");
  for (const l of e.lines) {
    if (
      (l.quantity === null ? null : Number(l.quantity)) !== l.source.quantity ||
      (l.unitPriceCents === null ? null : Number(l.unitPriceCents)) !==
        l.source.unit_price_cents
    )
      throw Error(
        "Native invoice exact pricing differs from its captured source row",
      );
    if (
      l.source.org_id !== org ||
      l.source.invoice_id !== c.sourceId ||
      (l.source.cost_code_id !== null &&
        (!l.costCode ||
          l.costCode.org_id !== org ||
          l.costCode.id !== l.source.cost_code_id)) ||
      (l.source.cost_code_id === null && l.costCode !== null)
    )
      throw Error("Native invoice line or cost-code scope differs");
  }
  if (
    e.retainage.some(
      (r) => r.invoice_id !== c.sourceId && r.release_invoice_id !== c.sourceId,
    ) ||
    e.closings.some((r) => r.closing_invoice_id !== c.sourceId)
  )
    throw Error(
      "Native invoice monetary dependencies reference another invoice",
    );
  if (
    e.postingHold &&
    (e.postingHold.org_id !== org ||
      e.postingHold.legal_entity_id !== c.owner.legal_entity_id ||
      e.postingHold.period_id !== c.period.id)
  )
    throw Error("Native invoice period hold belongs to another scope");
  return { economic: e, routing: v };
}
/** Derive money only from captured operational rows. This API accepts no journal draft. */
export function buildNativeInvoicePostingPlan(value: unknown) {
  return deriveNativeInvoicePlan(value);
}
/** Correction accounting uses its available effective period while contract
 * eligibility and signed-closing evidence retain the actual invoice date.
 * Initial posting never accepts this path or a caller-supplied override flag. */
export function buildNativeInvoiceReplacementPlan(
  value: unknown,
  correctionId: string,
) {
  return deriveNativeInvoicePlan(value, uuid.parse(correctionId));
}
function deriveNativeInvoicePlan(value: unknown, correctionId?: string) {
  const { economic: e, routing: v } = verifyNativeInvoiceEconomicContext(value),
    c = v.context;
  const invoice = scoped
    .extend({
      project_id: uuid,
      issue_date: date,
      total_cents: z.number().int().safe(),
      tax_cents: z.number().int().safe(),
      status: z.enum(BILLED_INVOICE_STATUSES),
      metadata: z.record(z.unknown()).nullable(),
    })
    .parse(c.source);
  if (
    (!correctionId && invoice.issue_date !== c.entryDate) ||
    (correctionId && invoice.issue_date > c.entryDate)
  )
    throw Error(
      "Native invoice accounting date must equal original issue date",
    );
  if (correctionId && e.policy.effective_on > invoice.issue_date)
    throw Error(
      "Native replacement requires policy applicable to the actual invoice date",
    );
  const metadata = invoice.metadata ?? {},
    kind = metadata.invoice_kind;
  if (kind === "earnest_deposit")
    return {
      economic: e,
      economicDigest: booksDigest({
        ...e,
        native: nativeContextMeaning(e.native),
      }),
      disposition: "collection_request" as const,
      plan: null,
      posted: false as const,
      ledgerActivated: false as const,
    };
  if (e.postingHold?.decision === "hold")
    throw Error("Native invoice fiscal period is held against posting");
  const sum = (rows: { amount_cents: number }[]) =>
      safe(rows.reduce((n, r) => n + BigInt(r.amount_cents), 0n)),
    holds = e.retainage.filter((r) => r.invoice_id === invoice.id),
    releases = e.retainage.filter((r) => r.release_invoice_id === invoice.id),
    held = sum(holds),
    gross = safe(BigInt(invoice.total_cents) + BigInt(held)),
    tax = invoice.tax_cents;
  const lines: (JournalLineDraft & { accountRole?: string })[] = [];
  const leg = (
    role: string,
    amount: number,
    side: "debit" | "credit",
    dimensions?: Record<string, unknown>,
    code?: string,
  ) => {
    if (amount === 0) return;
    const debit = amount > 0 === (side === "debit");
    lines.push({
      accountCode: code ?? v.controlCodes[role],
      ...(code ? {} : { accountRole: role }),
      projectId: c.projectId,
      debitCents: debit ? Math.abs(amount) : 0,
      creditCents: debit ? 0 : Math.abs(amount),
      ...(dimensions ? { dimensions } : {}),
    });
  };
  let disposition: "progress_billing" | "closing_revenue" | "retainage_release";
  if (releases.length) {
    if (
      held ||
      tax ||
      invoice.total_cents <= 0 ||
      sum(releases) !== invoice.total_cents ||
      releases.some(
        (r) =>
          !r.invoice_id ||
          !e.originalInvoices.some((i) => i.id === r.invoice_id),
      )
    )
      throw Error(
        "Native retainage release must tie exactly to original project retainage and invoice principal",
      );
    leg("accountsReceivable", invoice.total_cents, "debit");
    leg("retainageReceivable", invoice.total_cents, "credit");
    disposition = "retainage_release";
  } else {
    if (
      gross === 0 ||
      Math.abs(tax) > Math.abs(gross) ||
      (tax !== 0 && Math.sign(tax) !== Math.sign(gross)) ||
      (held && gross < 0)
    )
      throw Error("Native invoice tax, gross or retainage is invalid");
    const basis = resolveProjectRevenueBasis(
      {
        id: c.projectId,
        status: e.project.status ?? undefined,
        property_type: e.project.property_type ?? undefined,
        financial_settings: e.financialSettings,
      },
      e.contracts.map((r) => ({
        ...r,
        effective_date: r.effective_date ?? undefined,
        snapshot: r.snapshot ?? undefined,
      })),
      invoice.issue_date,
    );
    const income = e.lines
      .filter(
        (l) => l.source.metadata?.system_generated_kind !== "retainage_hold",
      )
      .map((l) => {
        const m = l.source.metadata ?? {};
        if (m.arc_books_gl_account_id)
          throw Error(
            "Legacy income selection requires an explicitly reviewed native entity account selection",
          );
        const selected = m.arc_books_entity_account_id;
        const a =
          selected === undefined || selected === null
            ? v.byCode.get(v.controlCodes.constructionRevenue)
            : c.accounts.find((a) => a.id === selected);
        if (!a || a.definition.account_type !== "income")
          throw Error(
            "Native invoice income account is absent from the owner's reviewed income chart",
          );
        if (l.quantity === null || l.unitPriceCents === null)
          throw Error("Native invoice source line pricing is incomplete");
        return {
          code: a.code,
          cents: nativeInvoiceLineCents(l.quantity, l.unitPriceCents),
          dimensions: l.source.cost_code_id
            ? { cost_code_id: l.source.cost_code_id }
            : undefined,
        };
      });
    if (
      !income.length ||
      safe(income.reduce((n, l) => n + BigInt(l.cents), 0n)) !==
        safe(BigInt(gross) - BigInt(tax))
    )
      throw Error(
        "Native invoice priced lines must equal gross billing excluding tax and retainage presentation",
      );
    leg("accountsReceivable", invoice.total_cents, "debit");
    leg("retainageReceivable", held, "debit");
    if (basis === "closing") {
      const closing = e.closings.filter(
        (r) =>
          r.status === "closed" &&
          r.actual_date === invoice.issue_date &&
          r.id === metadata.source_closing_id,
      );
      if (
        kind !== "closing" ||
        closing.length !== 1 ||
        gross <= 0 ||
        closing[0].settlement.finalPriceCents !== gross
      )
        throw Error(
          "Native closing revenue requires the exact completed settlement, date, invoice and final sale price",
        );
      const settlement = readClosedSettlementEvidence(closing[0].settlement);
      if (
        !e.contracts.some((r) => r.id === settlement.contractId) ||
        !settlement.agreement.signed_at ||
        booksDigest(metadata.settlement) !== booksDigest(closing[0].settlement)
      )
        throw Error(
          "Native closing invoice does not retain the original signed settlement evidence",
        );
      for (const l of income)
        leg("constructionRevenue", l.cents, "credit", l.dimensions, l.code);
      disposition = "closing_revenue";
    } else {
      if (kind === "closing" || e.closings.length)
        throw Error(
          "Native closing invoice conflicts with project revenue basis",
        );
      leg("contractLiability", safe(BigInt(gross) - BigInt(tax)), "credit");
      disposition = "progress_billing";
    }
    leg("salesUseTaxPayable", tax, "credit");
  }
  const economicDigest = booksDigest({
      ...e,
      native: nativeContextMeaning(e.native),
    }),
    draft = {
      entryDate: c.entryDate,
      entryKind: correctionId
        ? ("adjusting" as const)
        : ("operational" as const),
      memo: "Invoice " + invoice.id + " — " + disposition,
      postingKey: correctionId
        ? `native-invoice-correction:${correctionId}:replacement:${invoice.id}`
        : "native-invoice:" +
          invoice.id +
          ":" +
          booksDigest({
            orgId: c.orgId,
            entityId: c.owner.legal_entity_id,
            sourceId: invoice.id,
            date: c.entryDate,
            chartId: c.chart.id,
            periodId: c.period.id,
            policy: {
              id: e.policy.id,
              version: e.policy.version,
              effective_on: e.policy.effective_on,
              policy: e.policy.policy,
            },
            disposition,
            lines,
          }),
      projectionVersion: 1,
      policyVersion: e.policy.version,
      sourceType: "invoice",
      sourceId: invoice.id,
      lines,
    };
  const plan = buildNativeProjectPostingPlan(c, draft).plan;
  return {
    economic: e,
    economicDigest,
    disposition,
    plan,
    posted: false as const,
    ledgerActivated: false as const,
  };
}
