import "server-only";
import { loadOpeningOwnedSources } from "@/lib/services/books/opening-sources";
import { loadRetainageReleaseInvoiceCents } from "@/lib/services/retainage";
import { collectBooksRows } from "@/lib/services/books/paging";
import { invoiceTaxBases } from "@/lib/services/books/tax-summary-rules";

import { z } from "zod";

import {
  BILLED_INVOICE_STATUSES,
  PAYABLE_VENDOR_BILL_STATUSES,
} from "@/lib/financials/ledger-status";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { createCompleteBooksExport } from "@/lib/services/books/exports";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099";

/** Sales tax billed plus explicitly accrued purchase use tax, by jurisdiction. */
export async function buildSalesUseTaxSummary(input: {
  startDate: string;
  endDate: string;
  orgId?: string;
}) {
  const context = await requireOrgContext(input.orgId);
  await requireAuthorization({
    permission: "books.tax",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "tax_summary",
    resourceId: context.orgId,
    logDecision: true,
  });
  const service = createServiceSupabaseClient();
  const [invoices, bills, jurisdictions, adjustments, openingSources, retainageReleases] = await Promise.all([
    collectBooksRows((from, to) => service.from("invoices").select("id,issue_date,subtotal_cents,tax_cents,tax_jurisdiction_id,metadata")
      .eq("org_id", context.orgId).gte("issue_date", input.startDate).lte("issue_date", input.endDate).in("status", [...BILLED_INVOICE_STATUSES]).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("vendor_bills").select("id,tax_jurisdiction_id,use_tax_accrued_cents")
      .eq("org_id", context.orgId).gte("bill_date", input.startDate).lte("bill_date", input.endDate).in("status", [...PAYABLE_VENDOR_BILL_STATUSES]).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("books_tax_jurisdictions").select("id,name").eq("org_id", context.orgId).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("receivable_adjustments").select("id,invoice_id,amount_cents,tax_cents,metadata,invoice:invoices(tax_jurisdiction_id)")
      .eq("org_id", context.orgId).eq("status", "posted").eq("adjustment_type", "credit_memo").gte("effective_date", input.startDate).lte("effective_date", input.endDate).order("id").range(from, to)),
    loadOpeningOwnedSources(context.orgId),
    loadRetainageReleaseInvoiceCents({ supabase: service, orgId: context.orgId }),
  ]);
  const reportInvoices = invoices.filter(invoice => !openingSources.invoices.has(invoice.id) && !retainageReleases.has(invoice.id) && (invoice.metadata as Record<string, unknown> | null)?.invoice_kind !== "earnest_deposit");
  const excludedOpeningCount = invoices.filter(invoice => openingSources.invoices.has(invoice.id)).length;
  const jurisdictionNames = new Map(jurisdictions.map((row) => [row.id, row.name]));
  const ids = reportInvoices.map((row) => row.id);
  const lineRows = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    lineRows.push(...await collectBooksRows((from, to) => service.from("invoice_lines")
      .select("id,invoice_id,quantity,unit_price_cents,description,unit,metadata").eq("org_id", context.orgId)
      .in("invoice_id", ids.slice(offset, offset + 200)).order("id").range(from, to)));
  }
  const linesByInvoice = new Map<string, typeof lineRows>();
  for (const line of lineRows) { const group = linesByInvoice.get(line.invoice_id) ?? []; group.push(line); linesByInvoice.set(line.invoice_id, group); }
  const empty = () => ({ taxableSalesCents: 0, exemptSalesCents: 0, unclassifiedSalesCents: 0, taxCents: 0, useTaxCents: 0, invoiceCount: 0, billCount: 0, adjustmentCount: 0 });
  const byJurisdiction = new Map<string, ReturnType<typeof empty>>();
  const nameFor = (id: string | null) => id ? jurisdictionNames.get(id) ?? "Unassigned" : "Unassigned";
  for (const invoice of reportInvoices) {
    const jurisdiction = nameFor(invoice.tax_jurisdiction_id);
    const current = byJurisdiction.get(jurisdiction) ?? empty();
    const metadata = z.record(z.unknown()).catch({}).parse(invoice.metadata);
    const totals = z.record(z.unknown()).catch({}).parse(metadata.totals);
    const discount = Number(totals.discount_cents ?? metadata.discount_cents ?? 0);
    const lines = linesByInvoice.get(invoice.id) ?? [];
    const bases = lines.length ? invoiceTaxBases(lines, discount) : { taxableSalesCents: 0, exemptSalesCents: 0, unclassifiedSalesCents: Number(invoice.subtotal_cents ?? 0) - discount };
    current.taxableSalesCents += bases.taxableSalesCents;
    current.exemptSalesCents += bases.exemptSalesCents;
    current.unclassifiedSalesCents += bases.unclassifiedSalesCents;
    current.taxCents += Number(invoice.tax_cents ?? 0);
    current.invoiceCount += 1;
    byJurisdiction.set(jurisdiction, current);
  }
  for (const adjustment of adjustments) {
    const invoice = Array.isArray(adjustment.invoice) ? adjustment.invoice[0] : adjustment.invoice;
    const jurisdiction = nameFor(invoice?.tax_jurisdiction_id ?? null);
    const current = byJurisdiction.get(jurisdiction) ?? empty();
    const metadata = z.record(z.unknown()).catch({}).parse(adjustment.metadata);
    const base = Number(adjustment.amount_cents) - Number(adjustment.tax_cents);
    const taxable = Number(metadata.taxable_base_cents ?? 0);
    const exempt = Number(metadata.exempt_base_cents ?? 0);
    if (![taxable, exempt].every((value) => Number.isSafeInteger(value) && value >= 0) || taxable + exempt > base) throw new Error("Invalid tax base on receivable adjustment");
    current.taxableSalesCents -= taxable;
    current.exemptSalesCents -= exempt;
    current.unclassifiedSalesCents -= base - taxable - exempt;
    current.taxCents -= Number(adjustment.tax_cents);
    current.adjustmentCount += 1;
    byJurisdiction.set(jurisdiction, current);
  }
  for (const bill of bills) {
    if (Number(bill.use_tax_accrued_cents ?? 0) === 0) continue;
    const jurisdiction = nameFor(bill.tax_jurisdiction_id);
    const current = byJurisdiction.get(jurisdiction) ?? empty();
    current.useTaxCents += Number(bill.use_tax_accrued_cents);
    current.billCount += 1;
    byJurisdiction.set(jurisdiction, current);
  }
  const rows = Array.from(byJurisdiction, ([jurisdiction, totals]) => ({
    jurisdiction,
    ...totals,
  })).sort((left, right) =>
    left.jurisdiction.localeCompare(right.jurisdiction),
  );
  const unassignedCount = byJurisdiction.get("Unassigned")?.invoiceCount ?? 0;
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    rows,
    // Stated as findings, not a disclaimer nobody reads. An accountant seeing
    // "every invoice is Unassigned" knows to ask why; a table that just says
    // "Unassigned" looks like a data-entry oversight they should chase.
    limitations: [
      ...(excludedOpeningCount ? ["Opening residual balances are excluded from sales; combine any pre-cutover activity from the prior system when preparing a filing."] : []),
      ...(rows.some((row) => row.unclassifiedSalesCents !== 0) ? ["Unclassified sales or credit bases need line-level tax treatment before filing."] : []),
      ...(unassignedCount > 0
        ? [
            `${unassignedCount} invoice(s) carry no tax jurisdiction and must be corrected before filing.`,
          ]
        : []),
      "Only explicitly accrued use tax is included; review taxable purchases for missing accruals before filing.",
    ],
    warning:
      "Summary only. Confirm contractor and resale treatment with a qualified tax professional before filing.",
  };
}

export async function createAccountantPackage(input: {
  periodId?: string;
  taxYear?: number;
  orgId?: string;
}) {
  if (!input.periodId && !input.taxYear)
    throw new Error("An accounting period or tax year is required");
  const context = await requireOrgContext(input.orgId);
  await requireAuthorization({
    permission: "books.export",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "accountant_package",
    resourceId: context.orgId,
    logDecision: true,
  });
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("accountant_packages")
    .insert({
      org_id: context.orgId,
      period_id: input.periodId ?? null,
      tax_year: input.taxYear ?? null,
      status: "generating",
      requested_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to start accountant package: ${error.message}`);
  const packageId = z.object({ id: z.string().uuid() }).parse(data).id;
  try {
    const [exportResult, vendor1099] = await Promise.all([
      createCompleteBooksExport({
        exportType: "accountant",
        orgId: context.orgId,
      }),
      input.taxYear
        ? getVendor1099Report({ year: input.taxYear, orgId: context.orgId })
        : Promise.resolve(null),
    ]);
    const manifest = {
      ...exportResult.manifest,
      books_export_id: exportResult.exportId,
      period_id: input.periodId ?? null,
      tax_year: input.taxYear ?? null,
      vendor_1099: vendor1099
        ? {
            threshold_cents: vendor1099.threshold_cents,
            vendor_count: vendor1099.rows.length,
            exception_count: vendor1099.rows.filter(
              (row) => row.meets_threshold && row.blocked_for_filing,
            ).length,
          }
        : null,
    };
    const update = await service
      .from("accountant_packages")
      .update({
        status: "ready",
        storage_path: exportResult.storagePath,
        content_hash: exportResult.contentHash,
        manifest,
        completed_at: new Date().toISOString(),
        expires_at: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .eq("org_id", context.orgId)
      .eq("id", packageId);
    if (update.error) throw new Error(update.error.message);
    await recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.accountant_package_ready",
      entityType: "accountant_package",
      entityId: packageId,
      payload: {
        period_id: input.periodId ?? null,
        tax_year: input.taxYear ?? null,
      },
      channel: "notification",
    });
    return { packageId, ...exportResult, vendor1099 };
  } catch (packageError) {
    await service
      .from("accountant_packages")
      .update({
        status: "failed",
        error_message:
          packageError instanceof Error
            ? packageError.message
            : String(packageError),
      })
      .eq("org_id", context.orgId)
      .eq("id", packageId);
    throw packageError;
  }
}
