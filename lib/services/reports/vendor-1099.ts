import { requireOrgContext } from "@/lib/services/context";
import { requirePermission } from "@/lib/services/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { collectBooksRows } from "@/lib/services/books/paging";
import { isReportableVendorPayment, reportableVendorReversal, SETTLED_VENDOR_PAYMENT_STATUSES } from "@/lib/services/reports/vendor-tax-payment-rules";

export type Vendor1099Row = {
  company_id: string;
  vendor_name: string;
  tax_id_last4: string | null;
  tax_entity_type: string | null;
  w9_on_file: boolean;
  tax_identity_vaulted: boolean;
  tin_verification_status: string;
  total_paid_cents: number;
  reversed_cents: number;
  meets_threshold: boolean;
  /** Reportable, but Arc does not hold enough to file. Surfaced in December, not at the deadline. */
  blocked_for_filing: boolean;
  blocking_reasons: string[];
};

export type Vendor1099Report = {
  tax_year: number;
  threshold_cents: number;
  rows: Vendor1099Row[];
  total_paid_cents: number;
};

export async function getVendor1099Report({
  year,
  orgId,
}: { year?: number; orgId?: string } = {}): Promise<Vendor1099Report> {
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  await requirePermission("report.read", {
    supabase,
    orgId: resolvedOrgId,
    userId,
  });
  const taxYear = year ?? new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2200)
    throw new Error("Invalid tax year");
  const start = `${taxYear}-01-01T00:00:00.000Z`;
  const end = `${taxYear + 1}-01-01T00:00:00.000Z`;
  const service = createServiceSupabaseClient();
  const { data: policies, error: policyError } = await service
    .from("tax_policy_versions")
    .select("org_id, threshold_cents, source_url")
    .eq("tax_year", taxYear)
    .eq("form_type", "1099-NEC")
    .eq("jurisdiction", "US")
    .or(`org_id.eq.${resolvedOrgId},org_id.is.null`);
  if (policyError)
    throw new Error(`Failed to load 1099 policy: ${policyError.message}`);
  const policy = (policies ?? []).sort(
    (left, right) =>
      Number(Boolean(right.org_id)) - Number(Boolean(left.org_id)),
  )[0];
  if (!policy)
    throw new Error(
      `No approved 1099-NEC policy exists for tax year ${taxYear}`,
    );
  const thresholdCents = Number(policy.threshold_cents);

  const [companies, allocations, payments, legacyBills, expenses, identities, reversals] = await Promise.all([
    collectBooksRows((from, to) => supabase.from("companies")
      .select("id,name,tax_id_last4,tax_entity_type,is_1099_eligible,w9_file_id,w9_received_at,tin_verification_status,backup_withholding,tax_exempt")
      .eq("org_id", resolvedOrgId).eq("is_1099_eligible", true).order("id").range(from, to)),
    collectBooksRows((from, to) => supabase.from("payment_allocations")
      .select("id,payment_id,amount_cents,bill_id,payment:payments!inner(received_at,status,method),bill:vendor_bills!inner(company_id)")
      .eq("org_id", resolvedOrgId).not("bill_id", "is", null)
      .gte("payment.received_at", start).lt("payment.received_at", end)
      .in("payment.status", [...SETTLED_VENDOR_PAYMENT_STATUSES]).order("id").range(from, to)),
    collectBooksRows((from, to) => supabase.from("payments")
      .select("id,bill_id,amount_cents,method,status,received_at,bill:vendor_bills!bill_id!inner(company_id)")
      .eq("org_id", resolvedOrgId).not("bill_id", "is", null)
      .gte("received_at", start).lt("received_at", end)
      .in("status", [...SETTLED_VENDOR_PAYMENT_STATUSES]).order("id").range(from, to)),
    collectBooksRows((from, to) => supabase.from("vendor_bills")
      .select("id,company_id,paid_cents,paid_at")
      .eq("org_id", resolvedOrgId).not("company_id", "is", null).gt("paid_cents", 0)
      .gte("paid_at", start).lt("paid_at", end).order("id").range(from, to)),
    collectBooksRows((from, to) => supabase.from("project_expenses")
      .select("id,vendor_company_id,amount_cents,tax_cents,expense_date,status,payment_method,accounting_coding")
      .eq("org_id", resolvedOrgId).not("vendor_company_id", "is", null)
      .gte("expense_date", `${taxYear}-01-01`).lte("expense_date", `${taxYear}-12-31`)
      .in("status", ["approved", "locked"]).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("tax_identity_refs")
      .select("id,company_id,tin_last4,verification_status")
      .eq("org_id", resolvedOrgId).eq("vault_provider", "supabase_vault").order("id").range(from, to)),
    collectBooksRows((from, to) => supabase.from("payment_reversals")
      .select("id,amount_cents,bill_id,status,occurred_at,payment:payments!payment_id!inner(method),bill:vendor_bills!bill_id!inner(company_id)")
      .eq("org_id", resolvedOrgId).not("bill_id", "is", null).eq("status", "succeeded")
      .gte("occurred_at", start).lt("occurred_at", end).order("id").range(from, to)),
  ]);
  const identityByCompany = new Map(identities.map(identity => [String(identity.company_id), identity]));
  const paidByCompany = new Map<string, number>();
  const reversedByCompany = new Map<string, number>();
  const evidenceIssues = new Map<string, Set<string>>();
  const issue = (companyId: string, reason: string) => {
    const reasons = evidenceIssues.get(companyId) ?? new Set<string>();
    reasons.add(reason); evidenceIssues.set(companyId, reasons);
  };
  const addPayment = (companyId: string, method: string | null, cents: number) => {
    if (!method) { issue(companyId, "A payment has no method; confirm whether it is reportable"); return; }
    if (!isReportableVendorPayment(method)) return;
    if (!Number.isSafeInteger(cents)) throw new Error("Vendor payment requires integer cents");
    paidByCompany.set(companyId, (paidByCompany.get(companyId) ?? 0) + cents);
  };
  const allocatedPayments = new Set<string>();
  const evidencedBills = new Set<string>();
  for (const allocation of allocations) {
    const bill = Array.isArray(allocation.bill) ? allocation.bill[0] : allocation.bill;
    const payment = Array.isArray(allocation.payment) ? allocation.payment[0] : allocation.payment;
    if (!bill?.company_id || !payment) throw new Error("A vendor allocation is missing its payment or vendor");
    allocatedPayments.add(`${allocation.payment_id}:${allocation.bill_id}`);
    evidencedBills.add(allocation.bill_id);
    addPayment(bill.company_id, payment.method, Number(allocation.amount_cents));
  }
  for (const payment of payments) {
    const bill = Array.isArray(payment.bill) ? payment.bill[0] : payment.bill;
    if (!bill?.company_id) throw new Error("A vendor payment is missing its vendor");
    evidencedBills.add(payment.bill_id);
    if (allocatedPayments.has(`${payment.id}:${payment.bill_id}`)) continue;
    addPayment(bill.company_id, payment.method, Number(payment.amount_cents));
  }
  // A lifetime paid balance and last-paid date cannot prove this year's cash.
  // Keep these vendors visible and block filing until dated payment evidence is restored.
  for (const bill of legacyBills) {
    if (bill.company_id && !evidencedBills.has(bill.id)) {
      issue(bill.company_id, "A paid bill has no dated payment evidence for this year");
    }
  }
  for (const expense of expenses) {
    if (!expense.vendor_company_id || expense.accounting_coding?.transaction_type === "bill") continue;
    addPayment(expense.vendor_company_id, expense.payment_method, Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0));
  }
  for (const reversal of reversals) {
    const bill = Array.isArray(reversal.bill) ? reversal.bill[0] : reversal.bill;
    const payment = Array.isArray(reversal.payment) ? reversal.payment[0] : reversal.payment;
    if (!bill?.company_id || !payment) throw new Error("A vendor reversal is missing its payment or vendor");
    if (!payment.method) issue(bill.company_id, "A reversed payment has no method; confirm whether it is reportable");
    const cents = reportableVendorReversal({ status: reversal.status, occurredAt: reversal.occurred_at, paymentMethod: payment.method, amountCents: Number(reversal.amount_cents) }, taxYear);
    reversedByCompany.set(bill.company_id, (reversedByCompany.get(bill.company_id) ?? 0) + cents);
  }

  const rows = companies
    .filter((company) => company.tax_exempt !== true)
    .map((company) => {
      const identity = identityByCompany.get(String(company.id));
      const reversedCents = reversedByCompany.get(company.id) ?? 0;
      const totalPaidCents = Math.max(
        0,
        (paidByCompany.get(company.id) ?? 0) - reversedCents,
      );
      const meetsThreshold = totalPaidCents >= thresholdCents;

      const blockingReasons: string[] = [...(evidenceIssues.get(company.id) ?? [])];
      if (meetsThreshold) {
        if (!company.w9_file_id && !company.w9_received_at)
          blockingReasons.push("No W-9 on file");
        if (!identity)
          blockingReasons.push("Complete taxpayer ID is not secured in Vault");
        if (
          identity &&
          !["pending", "verified"].includes(
            String(identity.verification_status),
          )
        )
          blockingReasons.push(
            "Taxpayer ID verification failed or is incomplete",
          );
        if (company.tin_verification_status === "failed")
          blockingReasons.push("TIN does not match verification records");
        if (company.backup_withholding === true)
          blockingReasons.push("Backup withholding applies");
      }

      return {
        company_id: company.id,
        vendor_name: company.name,
        tax_id_last4: identity?.tin_last4 ?? company.tax_id_last4 ?? null,
        tax_entity_type: company.tax_entity_type ?? null,
        w9_on_file: Boolean(company.w9_file_id || company.w9_received_at),
        tax_identity_vaulted: Boolean(identity),
        tin_verification_status: String(
          identity?.verification_status ??
            company.tin_verification_status ??
            "unverified",
        ),
        total_paid_cents: totalPaidCents,
        reversed_cents: reversedCents,
        meets_threshold: meetsThreshold,
        blocked_for_filing: blockingReasons.length > 0,
        blocking_reasons: blockingReasons,
      };
    })
    .sort(
      (a, b) =>
        b.total_paid_cents - a.total_paid_cents ||
        a.vendor_name.localeCompare(b.vendor_name),
    );

  return {
    tax_year: taxYear,
    threshold_cents: thresholdCents,
    rows,
    total_paid_cents: rows.reduce((sum, row) => sum + row.total_paid_cents, 0),
  };
}
