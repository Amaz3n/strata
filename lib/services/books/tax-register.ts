import "server-only";

import { z } from "zod";

import { recordAudit } from "@/lib/services/audit";
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access";
import { requireOrgContext } from "@/lib/services/context";
import { recordEvent } from "@/lib/services/events";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
async function requireTaxManager(orgId?: string) {
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "books.tax",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_tax",
    resourceId: context.orgId,
    logDecision: true,
  });
  return context;
}

export async function getTaxRegister(orgId?: string) {
  const context = await requireTaxManager(orgId);
  const service = createServiceSupabaseClient();
  const [jurisdictions, filings, vendors, identities] = await Promise.all([
    service
      .from("books_tax_jurisdictions")
      .select(
        "id,name,country_code,state_code,local_code,sales_tax_rate_micros,use_tax_rate_micros,effective_from,effective_through,filing_frequency,active",
      )
      .eq("org_id", context.orgId)
      .order("name"),
    service
      .from("books_tax_filings")
      .select(
        "id,jurisdiction_id,filing_type,period_start,period_end,due_on,status,amount_due_cents,confirmation_number,filed_at,notes",
      )
      .eq("org_id", context.orgId)
      .order("period_end", { ascending: false })
      .limit(250),
    service
      .from("companies")
      .select(
        "id,name,tax_id_last4,tin_verification_status,w9_received_at,w9_file_id",
      )
      .eq("org_id", context.orgId)
      .eq("is_1099_eligible", true)
      .order("name"),
    service
      .from("tax_identity_refs")
      .select(
        "id,company_id,tin_last4,verification_status,vault_provider,created_at",
      )
      .eq("org_id", context.orgId)
      .eq("vault_provider", "supabase_vault"),
  ]);
  const error =
    jurisdictions.error ?? filings.error ?? vendors.error ?? identities.error;
  if (error) throw new Error(`Failed to load tax register: ${error.message}`);
  const identityByCompany = new Map(
    (identities.data ?? []).map((identity) => [
      String(identity.company_id),
      identity,
    ]),
  );
  return {
    jurisdictions: jurisdictions.data ?? [],
    filings: filings.data ?? [],
    vendors: (vendors.data ?? []).map((vendor) => ({
      ...vendor,
      taxIdentity: identityByCompany.get(String(vendor.id)) ?? null,
    })),
  };
}

/**
 * Store a complete US taxpayer ID without returning or auditing it. The RPC is
 * the only application path that can write the encrypted Vault secret and its
 * ordinary-table reference in one transaction.
 */
export async function storeCompanyTaxIdentity(
  input: { companyId: string; tin: string },
  orgId?: string,
) {
  const context = await requireTaxManager(orgId);
  const parsed = z
    .object({
      companyId: z.string().uuid(),
      tin: z
        .string()
        .transform((value) => value.replace(/\D/g, ""))
        .pipe(
          z
            .string()
            .regex(
              /^\d{9}$/,
              "A US taxpayer ID must contain exactly nine digits",
            ),
        ),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc(
    "store_company_tax_identity_atomic",
    {
      p_org_id: context.orgId,
      p_company_id: parsed.companyId,
      p_tin: parsed.tin,
      p_actor_id: context.userId,
    },
  );
  if (error)
    throw new Error(`Failed to secure taxpayer identity: ${error.message}`);
  const identityId = String(data);
  const last4 = parsed.tin.slice(-4);
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "tax_identity_ref",
    entityId: identityId,
    after: {
      companyId: parsed.companyId,
      last4,
      provider: "supabase_vault",
      verificationStatus: "pending",
    },
    source: "books.tax",
  });
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "company_tax_identity_secured",
    entityType: "tax_identity_ref",
    entityId: identityId,
    payload: {
      company_id: parsed.companyId,
      tin_last4: last4,
      verification_status: "pending",
    },
  });
  return { id: identityId, last4, verificationStatus: "pending" as const };
}

/** Rotate an existing Vault secret after a corrected W-9. */
export async function replaceCompanyTaxIdentity(
  input: { companyId: string; tin: string; confirmation: string },
  orgId?: string,
) {
  const context = await requireTaxManager(orgId);
  const parsed = z
    .object({
      companyId: z.string().uuid(),
      tin: z
        .string()
        .transform((value) => value.replace(/\D/g, ""))
        .pipe(
          z
            .string()
            .regex(
              /^\d{9}$/,
              "A US taxpayer ID must contain exactly nine digits",
            ),
        ),
      confirmation: z.literal("REPLACE"),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc(
    "replace_company_tax_identity_atomic",
    {
      p_org_id: context.orgId,
      p_company_id: parsed.companyId,
      p_tin: parsed.tin,
      p_actor_id: context.userId,
    },
  );
  if (error)
    throw new Error(`Failed to rotate taxpayer identity: ${error.message}`);
  const identityId = String(data);
  const last4 = parsed.tin.slice(-4);
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "tax_identity_ref",
    entityId: identityId,
    before: { companyId: parsed.companyId, provider: "supabase_vault" },
    after: {
      companyId: parsed.companyId,
      last4,
      provider: "supabase_vault",
      verificationStatus: "pending",
      rotated: true,
    },
    source: "books.tax",
  });
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "company_tax_identity_rotated",
    entityType: "tax_identity_ref",
    entityId: identityId,
    payload: {
      company_id: parsed.companyId,
      tin_last4: last4,
      verification_status: "pending",
    },
  });
  return { id: identityId, last4, verificationStatus: "pending" as const };
}

export async function createTaxJurisdiction(
  input: {
    name: string;
    stateCode?: string | null;
    localCode?: string | null;
    salesTaxPercent: number;
    useTaxPercent: number;
    effectiveFrom: string;
    filingFrequency: string;
  },
  orgId?: string,
) {
  const context = await requireTaxManager(orgId);
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(160),
      stateCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/)
        .nullish(),
      localCode: z.string().trim().max(80).nullish(),
      salesTaxPercent: z.number().min(0).max(100),
      useTaxPercent: z.number().min(0).max(100),
      effectiveFrom: date,
      filingFrequency: z.enum(["monthly", "quarterly", "annual", "none"]),
    })
    .parse(input);
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_tax_jurisdictions")
    .insert({
      org_id: context.orgId,
      name: parsed.name,
      state_code: parsed.stateCode || null,
      local_code: parsed.localCode || null,
      sales_tax_rate_micros: Math.round(parsed.salesTaxPercent * 10000),
      use_tax_rate_micros: Math.round(parsed.useTaxPercent * 10000),
      effective_from: parsed.effectiveFrom,
      filing_frequency: parsed.filingFrequency,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (error)
    throw new Error(`Failed to create tax jurisdiction: ${error.message}`);
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "books_tax_jurisdiction",
    entityId: data.id,
    after: parsed,
    source: "books.tax",
  });
  return { id: data.id };
}

export async function recordTaxFiling(
  input: {
    jurisdictionId?: string | null;
    filingType: string;
    periodStart: string;
    periodEnd: string;
    dueOn?: string | null;
    status: string;
    amountDueCents?: number | null;
    confirmationNumber?: string | null;
    notes?: string | null;
  },
  orgId?: string,
) {
  const context = await requireTaxManager(orgId);
  const parsed = z
    .object({
      jurisdictionId: z.string().uuid().nullish(),
      filingType: z.enum([
        "sales_use_tax",
        "form_1099",
        "income_tax_package",
        "payroll_tax",
        "other",
      ]),
      periodStart: date,
      periodEnd: date,
      dueOn: date.nullish(),
      status: z.enum([
        "draft",
        "ready",
        "filed",
        "accepted",
        "rejected",
        "amended",
      ]),
      amountDueCents: z.number().int().nullish(),
      confirmationNumber: z.string().trim().max(160).nullish(),
      notes: z.string().trim().max(2000).nullish(),
    })
    .parse(input);
  const filed = ["filed", "accepted", "rejected", "amended"].includes(
    parsed.status,
  );
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_tax_filings")
    .insert({
      org_id: context.orgId,
      jurisdiction_id: parsed.jurisdictionId ?? null,
      filing_type: parsed.filingType,
      period_start: parsed.periodStart,
      period_end: parsed.periodEnd,
      due_on: parsed.dueOn ?? null,
      status: parsed.status,
      amount_due_cents: parsed.amountDueCents ?? null,
      confirmation_number: parsed.confirmationNumber ?? null,
      notes: parsed.notes ?? null,
      filed_at: filed ? new Date().toISOString() : null,
      filed_by: filed ? context.userId : null,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to record tax filing: ${error.message}`);
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: filed
      ? "books_tax_filing_recorded"
      : "books_tax_filing_prepared",
    entityType: "books_tax_filing",
    entityId: data.id,
    payload: parsed,
  });
  return { id: data.id };
}
