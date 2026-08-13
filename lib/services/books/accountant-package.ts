import "server-only";

import { z } from "zod";

import {
  BILLED_INVOICE_STATUSES,
  PAYABLE_VENDOR_BILL_STATUSES,
} from "@/lib/financials/ledger-status";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireAuthorization } from "@/lib/services/authorization";
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
  const [invoiceResult, billResult, jurisdictionResult] = await Promise.all([
    service
      .from("invoices")
      .select(
        "id, issue_date, subtotal_cents, tax_cents, total_cents, tax_jurisdiction_id, metadata, project_id",
      )
      .eq("org_id", context.orgId)
      .gte("issue_date", input.startDate)
      .lte("issue_date", input.endDate)
      .in("status", [...BILLED_INVOICE_STATUSES]),
    service
      .from("vendor_bills")
      .select("id,bill_date,tax_jurisdiction_id,use_tax_accrued_cents")
      .eq("org_id", context.orgId)
      .gte("bill_date", input.startDate)
      .lte("bill_date", input.endDate)
      .in("status", [...PAYABLE_VENDOR_BILL_STATUSES]),
    service
      .from("books_tax_jurisdictions")
      .select("id,name")
      .eq("org_id", context.orgId),
  ]);
  const error =
    invoiceResult.error ?? billResult.error ?? jurisdictionResult.error;
  if (error)
    throw new Error(`Failed to build sales/use-tax summary: ${error.message}`);
  const jurisdictionNames = new Map(
    (jurisdictionResult.data ?? []).map((row) => [
      String(row.id),
      String(row.name),
    ]),
  );
  const byJurisdiction = new Map<
    string,
    {
      taxableSalesCents: number;
      taxCents: number;
      useTaxCents: number;
      invoiceCount: number;
      billCount: number;
    }
  >();
  for (const invoice of invoiceResult.data ?? []) {
    const metadata =
      invoice.metadata &&
      typeof invoice.metadata === "object" &&
      !Array.isArray(invoice.metadata)
        ? invoice.metadata
        : {};
    const jurisdiction = invoice.tax_jurisdiction_id
      ? (jurisdictionNames.get(String(invoice.tax_jurisdiction_id)) ??
        "Unassigned")
      : typeof metadata.tax_jurisdiction === "string" &&
          metadata.tax_jurisdiction.trim()
        ? metadata.tax_jurisdiction.trim()
        : "Unassigned";
    const current = byJurisdiction.get(jurisdiction) ?? {
      taxableSalesCents: 0,
      taxCents: 0,
      useTaxCents: 0,
      invoiceCount: 0,
      billCount: 0,
    };
    current.taxableSalesCents += Number(invoice.subtotal_cents ?? 0);
    current.taxCents += Number(invoice.tax_cents ?? 0);
    current.invoiceCount += 1;
    byJurisdiction.set(jurisdiction, current);
  }
  for (const bill of billResult.data ?? []) {
    if (Number(bill.use_tax_accrued_cents ?? 0) <= 0) continue;
    const jurisdiction = bill.tax_jurisdiction_id
      ? (jurisdictionNames.get(String(bill.tax_jurisdiction_id)) ??
        "Unassigned")
      : "Unassigned";
    const current = byJurisdiction.get(jurisdiction) ?? {
      taxableSalesCents: 0,
      taxCents: 0,
      useTaxCents: 0,
      invoiceCount: 0,
      billCount: 0,
    };
    current.useTaxCents += Number(bill.use_tax_accrued_cents ?? 0);
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
