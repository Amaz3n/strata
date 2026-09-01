import { createHash } from "node:crypto";
import { z } from "zod";

import { isIssuedInvoiceStatus, normalizeInvoiceStatus } from "@/lib/financials/invoice-lifecycle";

import type {
  Payment,
  PaymentIntent,
  PaymentReversal,
} from "@/lib/types";
import {
  receivePaymentInputSchema,
  recordPaymentInputSchema,
  type CreatePublicInvoicePaymentIntentInput,
  type ReceivePaymentInput,
  type RecordPaymentInput,
} from "@/lib/validation/payments";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/services/audit";
import { recordEvent } from "@/lib/services/events";
import { cancelStripePaymentIntent, createStripePaymentIntent } from "@/lib/integrations/payments/stripe";
import {
  calculatePaymentFeeQuote,
  type OnlinePaymentMethod,
  loadPaymentFeePolicy,
} from "@/lib/payments/fee-engine";
import { releaseInvoiceLienWaiversIfPaid } from "@/lib/services/invoice-lien-waivers";
import { enqueuePaymentSync } from "@/lib/services/accounting-sync";
import { requireAuthorization } from "@/lib/services/authorization";
import {
  escapeHtml,
  getOrgSenderEmail,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer";
import { requireReadyStripeConnectedAccountForOrg } from "@/lib/services/stripe-connected-accounts";


const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com";

const reminderRuleSchema = z.object({
  invoice_id: z.string().uuid("Invoice is required"),
  channel: z.enum(["email", "sms"]).default("email"),
  schedule: z
    .enum(["before_due", "after_due", "overdue"])
    .default("before_due"),
  offset_days: z.number().int().min(0).default(0),
  template_id: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const lateFeeRuleSchema = z.object({
  project_id: z.string().uuid().optional(),
  strategy: z.enum(["fixed", "percent"]).default("fixed"),
  amount_cents: z.number().int().min(0).optional(),
  percent_rate: z.number().min(0).max(100).optional(),
  grace_days: z.number().int().min(0).default(0),
  repeat_days: z.number().int().min(0).optional(),
  max_applications: z.number().int().min(1).optional(),
  metadata: z.record(z.any()).optional(),
});

function mapPayment(row: any): Payment {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    invoice_id: row.invoice_id ?? undefined,
    bill_id: row.bill_id ?? undefined,
    amount_cents: row.amount_cents,
    currency: row.currency ?? "usd",
    method: row.method ?? undefined,
    provider: row.provider ?? undefined,
    provider_payment_id: row.provider_payment_id ?? undefined,
    provider_charge_id: row.provider_charge_id ?? undefined,
    status: row.status ?? "pending",
    reference: row.reference ?? undefined,
    fee_cents: row.fee_cents ?? undefined,
    net_cents: row.net_cents ?? undefined,
    gross_cents: row.gross_cents ?? undefined,
    connected_account_id: row.connected_account_id ?? undefined,
    processor_fee_cents: row.processor_fee_cents ?? undefined,
    platform_fee_cents: row.platform_fee_cents ?? undefined,
    application_fee_cents: row.application_fee_cents ?? undefined,
    metadata: row.metadata ?? undefined,
    received_at: row.received_at ?? row.created_at,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
}

function mapAllocatedPayment(row: any, invoiceId: string): Payment {
  const payment = Array.isArray(row.payment) ? row.payment[0] : row.payment;
  return mapPayment({
    ...(payment ?? {}),
    invoice_id: invoiceId,
    amount_cents: row.amount_cents,
    project_id: row.project_id ?? payment?.project_id,
    metadata: {
      ...(payment?.metadata ?? {}),
      payment_allocation_id: row.id,
      allocated_payment_id: row.payment_id,
      allocated_amount_cents: row.amount_cents,
      allocation_metadata: row.metadata ?? {},
    },
  });
}

function mapPaymentReversal(row: any): PaymentReversal {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    invoice_id: row.invoice_id,
    payment_id: row.payment_id,
    amount_cents: row.amount_cents,
    reversal_type: row.reversal_type,
    status: row.status ?? "succeeded",
    provider_reversal_id: row.provider_reversal_id ?? undefined,
    reason: row.reason ?? undefined,
    metadata: row.metadata ?? undefined,
    occurred_at: row.occurred_at ?? row.created_at,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
}

function mapPaymentIntent(row: any): PaymentIntent {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    invoice_id: row.invoice_id ?? undefined,
    provider: row.provider ?? "stripe",
    provider_intent_id: row.provider_intent_id ?? undefined,
    provider_charge_id: row.provider_charge_id ?? undefined,
    status: row.status ?? "requires_payment_method",
    amount_cents: row.amount_cents,
    currency: row.currency ?? "usd",
    client_secret: row.client_secret ?? undefined,
    connected_account_id: row.connected_account_id ?? undefined,
    charge_type: row.charge_type ?? undefined,
    application_fee_amount: row.application_fee_amount ?? undefined,
    processor_fee_cents: row.processor_fee_cents ?? undefined,
    platform_fee_cents: row.platform_fee_cents ?? undefined,
    on_behalf_of_account_id: row.on_behalf_of_account_id ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    expires_at: row.expires_at ?? undefined,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  };
}


async function getInvoiceTotals(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  invoiceId: string,
  orgId: string,
) {
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, token, invoice_number, total_cents, balance_due_cents, due_date, status, metadata",
    )
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (error || !data) {
    throw new Error("Invoice not found or inaccessible");
  }

  return data;
}

function stripePaymentMethodTypesFor(method?: string | null) {
  if (method === "ach") return ["us_bank_account"];
  if (method === "card") return ["card"];
  return ["us_bank_account", "card"];
}

function toStripeMethod(method?: string | null): OnlinePaymentMethod | null {
  return method === "ach" || method === "card" ? method : null;
}

function metadataInt(metadata: Record<string, any> | undefined, key: string) {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value))
    return Math.round(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function buildPaymentIntentAmounts(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orgId: string;
  invoiceBalanceCents: number;
  method?: string | null;
  includeProcessingFee?: boolean;
}): Promise<{
  chargeAmountCents: number;
  invoiceBalanceCents: number;
  paymentMethodFeeCents: number;
  metadata: Record<string, string>;
}> {
  const paymentMethod = toStripeMethod(params.method);
  if (!params.includeProcessingFee || !paymentMethod) {
    return {
      chargeAmountCents: params.invoiceBalanceCents,
      invoiceBalanceCents: params.invoiceBalanceCents,
      paymentMethodFeeCents: 0,
      metadata: {},
    };
  }

  const policy = await loadPaymentFeePolicy(params.supabase, params.orgId);
  const quote = calculatePaymentFeeQuote({
    invoiceBalanceCents: params.invoiceBalanceCents,
    method: paymentMethod,
    policy,
  });
  if (!quote.enabled) {
    throw new Error(
      `${quote.label} payments are not enabled for this invoice.`,
    );
  }

  return {
    chargeAmountCents: quote.totalCents,
    invoiceBalanceCents: quote.invoiceBalanceCents,
    paymentMethodFeeCents: quote.feeCents,
    metadata: {
      payment_method_choice: quote.method,
      invoice_balance_cents: String(quote.invoiceBalanceCents),
      payment_method_fee_cents: String(quote.feeCents),
      payment_method_fee_percent: String(quote.feePercent),
      payment_method_fee_fixed_cents: String(quote.feeFixedCents),
      payment_method_fee_cap_cents:
        quote.feeCapCents == null ? "" : String(quote.feeCapCents),
      payment_method_total_cents: String(quote.totalCents),
    },
  };
}

async function findReusablePaymentIntent(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orgId: string;
  invoiceId: string;
  amountCents: number;
  method?: string | null;
}) {
  const { data } = await params.supabase
    .from("payment_intents")
    .select("*")
    .eq("org_id", params.orgId)
    .eq("invoice_id", params.invoiceId)
    .in("status", [
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
      "processing",
    ])
    .order("created_at", { ascending: false })
    .limit(5);

  const reusable = (data ?? []).find((intent: any) => {
    const metadata = intent.metadata ?? {};
    return (
      Number(intent.amount_cents ?? 0) === params.amountCents &&
      (metadata.payment_method_choice ?? null) === (params.method ?? null) &&
      typeof intent.client_secret === "string" &&
      intent.client_secret.length > 0
    );
  });
  return reusable ? mapPaymentIntent(reusable) : null;
}

function paymentReservationKey(params: {
  invoiceId: string;
  principalCents: number;
  chargeCents: number;
  currency: string;
  method?: string | null;
}) {
  // A stable half-hour window makes simultaneous checkout requests converge on
  // one database reservation and one Stripe idempotency key. Existing open
  // intents are reused before this key is created.
  const window = Math.floor(Date.now() / (30 * 60 * 1000));
  const fingerprint = [
    params.invoiceId,
    params.principalCents,
    params.chargeCents,
    params.currency.toLowerCase(),
    params.method ?? "any",
    window,
  ].join(":");
  return `invoice-payment:${createHash("sha256").update(fingerprint).digest("hex")}`;
}

async function createReservedStripePaymentIntent(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orgId: string;
  projectId?: string | null;
  invoiceId: string;
  invoiceNumber?: string | null;
  currency: string;
  principalCents: number;
  chargeCents: number;
  method?: string | null;
  connectedAccountId: string;
  metadata: Record<string, any>;
}) {
  const idempotencyKey = paymentReservationKey({
    invoiceId: params.invoiceId,
    principalCents: params.principalCents,
    chargeCents: params.chargeCents,
    currency: params.currency,
    method: params.method,
  });
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { data: reservation, error: reservationError } = await params.supabase.rpc(
    "reserve_invoice_payment",
    {
      p_org_id: params.orgId,
      p_invoice_id: params.invoiceId,
      p_principal_cents: params.principalCents,
      p_charge_cents: params.chargeCents,
      p_currency: params.currency,
      p_method: params.method ?? null,
      p_idempotency_key: idempotencyKey,
      p_expires_at: expiresAt,
      p_metadata: params.metadata,
    },
  );
  if (reservationError || !reservation) {
    throw new Error(
      reservationError?.message ?? "Unable to reserve the invoice balance",
    );
  }

  const existingProviderIntentId = (reservation as any).provider_intent_id;
  if (existingProviderIntentId) {
    const { data: existing } = await params.supabase
      .from("payment_intents")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing) return mapPaymentIntent(existing);
  }

  const reservationId = String((reservation as any).id);
  const stringMetadata = Object.fromEntries(
    Object.entries(params.metadata).map(([key, value]) => [key, String(value)]),
  );
  const stripeIntent = await createStripePaymentIntent({
    amount_cents: params.chargeCents,
    currency: params.currency,
    invoice_id: params.invoiceId,
    org_id: params.orgId,
    project_id: params.projectId,
    description: `Invoice ${params.invoiceNumber ?? params.invoiceId}`,
    connected_account_id: params.connectedAccountId,
    payment_method_types: stripePaymentMethodTypesFor(params.method),
    idempotency_key: idempotencyKey,
    metadata: {
      ...stringMetadata,
      payment_reservation_id: reservationId,
    },
  });

  const { data: committed, error: commitError } = await params.supabase.rpc(
    "commit_invoice_payment_intent",
    {
      p_reservation_id: reservationId,
      p_provider_intent_id: stripeIntent.provider_intent_id,
      p_status: stripeIntent.status,
      p_client_secret: stripeIntent.client_secret,
      p_connected_account_id: params.connectedAccountId,
      p_charge_type: "direct",
      p_metadata: {
        ...params.metadata,
        payment_reservation_id: reservationId,
      },
    },
  );
  if (commitError || !committed) {
    throw new Error(
      commitError?.message ?? "Failed to persist the payment intent",
    );
  }
  return mapPaymentIntent(committed);
}

async function ensureReceiptForPayment({
  supabase,
  orgId,
  invoice,
  paymentId,
  amountCents,
  provider,
  method,
  reference,
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orgId: string;
  invoice: any;
  paymentId: string;
  amountCents: number;
  provider?: string | null;
  method?: string | null;
  reference?: string | null;
}) {
  try {
    const issuedToEmail =
      (invoice?.metadata as any)?.customer_email ??
      (invoice?.metadata as any)?.customerEmail ??
      (invoice?.metadata as any)?.email ??
      null;

    const { data: receipt, error } = await supabase.from("receipts").upsert(
      {
        org_id: orgId,
        project_id: invoice.project_id ?? null,
        invoice_id: invoice.id,
        payment_id: paymentId,
        amount_cents: amountCents,
        issued_to_email: issuedToEmail,
        issued_at: new Date().toISOString(),
        metadata: {
          invoice_number: invoice.invoice_number ?? null,
          provider: provider ?? null,
          method: method ?? null,
          reference: reference ?? null,
        },
      },
      { onConflict: "payment_id" },
    ).select("id, delivery_status").single();
    if (error) throw error;
    if (!issuedToEmail || receipt.delivery_status === "sent") return;

    await supabase.from("receipts").update({ delivery_status: "sending" }).eq("id", receipt.id).eq("org_id", orgId);
    const { data: org } = await supabase
      .from("orgs")
      .select("name, logo_url, slug")
      .eq("id", orgId)
      .maybeSingle();
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountCents / 100);
    const receiptUrl = invoice.token ? `${APP_URL}/i/${invoice.token}/receipt/${receipt.id}` : undefined;
    const html = renderStandardEmailLayout({
      title: `Payment received for invoice ${invoice.invoice_number ?? ""}`.trim(),
      messageHtml: `<p>We received your payment of <strong>${escapeHtml(amount)}</strong> for invoice <strong>${escapeHtml(String(invoice.invoice_number ?? invoice.id))}</strong>.</p><p>Thank you. Your invoice balance has been updated.</p>`,
      buttonText: receiptUrl ? "View receipt" : undefined,
      buttonUrl: receiptUrl,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      showManageSettings: false,
    });
    try {
      const delivered = await sendEmail({
        to: [issuedToEmail],
        subject: `Payment receipt · Invoice ${invoice.invoice_number ?? ""}`.trim(),
        html,
        from: getOrgSenderEmail(org?.slug, org?.name),
        idempotencyKey: `invoice-receipt:${paymentId}`,
      });
      await supabase
        .from("receipts")
        .update({ delivery_status: delivered ? "sent" : "not_sent" })
        .eq("id", receipt.id)
        .eq("org_id", orgId);
    } catch (deliveryError) {
      await supabase.from("receipts").update({ delivery_status: "failed" }).eq("id", receipt.id).eq("org_id", orgId);
      throw deliveryError;
    }
  } catch (err) {
    console.warn("Failed to create receipt for payment", err);
  }
}


export async function createPublicInvoicePaymentIntent(
  input: CreatePublicInvoicePaymentIntentInput,
) {
  const supabase = createServiceSupabaseClient();
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, token, invoice_number, status, client_visible, total_cents, balance_due_cents, currency",
    )
    .eq("token", input.token)
    .maybeSingle();

  if (error || !invoice) {
    throw new Error("Invoice not found or inaccessible");
  }
  if (invoice.client_visible === false || invoice.status === "void") {
    throw new Error("Invoice is not available for online payment");
  }

  const invoiceBalanceCents =
    invoice.balance_due_cents ?? invoice.total_cents ?? 0;
  if (invoiceBalanceCents <= 0)
    throw new Error("Invoice has no outstanding balance");

  // Optional partial payment: never above the outstanding balance, never below $1.
  const requestedCents = input.amount_cents ?? invoiceBalanceCents;
  if (requestedCents > invoiceBalanceCents) {
    throw new Error("Payment amount cannot exceed the outstanding balance");
  }
  if (requestedCents < Math.min(100, invoiceBalanceCents)) {
    throw new Error("Minimum online payment is $1.00");
  }

  const connectedAccount = await requireReadyStripeConnectedAccountForOrg(
    invoice.org_id,
  );
  const amounts = await buildPaymentIntentAmounts({
    supabase,
    orgId: invoice.org_id,
    invoiceBalanceCents: requestedCents,
    method: input.method,
    includeProcessingFee: true,
  });
  const reusable = await findReusablePaymentIntent({
    supabase,
    orgId: invoice.org_id,
    invoiceId: invoice.id,
    amountCents: amounts.chargeAmountCents,
    method: input.method,
  });
  if (reusable) return reusable;

  return createReservedStripePaymentIntent({
    supabase,
    orgId: invoice.org_id,
    projectId: invoice.project_id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    currency: invoice.currency ?? "usd",
    principalCents: requestedCents,
    chargeCents: amounts.chargeAmountCents,
    method: input.method,
    connectedAccountId: connectedAccount.stripe_account_id,
    metadata: {
      payment_method_choice: input.method,
      invoice_balance_cents: requestedCents,
      invoice_outstanding_before_cents: invoiceBalanceCents,
      requested_amount_cents: requestedCents,
      is_partial_payment: requestedCents < invoiceBalanceCents,
      payment_method_fee_cents: amounts.paymentMethodFeeCents,
      payment_method_total_cents: amounts.chargeAmountCents,
    },
  });
}

export async function recordPayment(input: RecordPaymentInput, orgId?: string) {
  const parsed = recordPaymentInputSchema.parse(input);
  const supabase = createServiceSupabaseClient();

  let resolvedOrgId = orgId;
  let invoiceId = parsed.invoice_id;

  if (!resolvedOrgId || !invoiceId) {
    const ctx = await requireOrgContext(orgId);
    resolvedOrgId = ctx.orgId;
    invoiceId = invoiceId ?? parsed.invoice_id ?? undefined;
    await requireAuthorization({
      permission: "payment.release",
      userId: ctx.userId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
      logDecision: true,
      resourceType: "invoice",
      resourceId: invoiceId ?? undefined,
    });
  }

  if (!resolvedOrgId || !invoiceId) {
    throw new Error("Missing org or invoice for payment");
  }

  const invoice = await getInvoiceTotals(supabase, invoiceId, resolvedOrgId);

  // Money can only be received against something that was actually billed. The
  // database guard only excluded `void`, so a draft — which carries a full
  // balance_due_cents from the moment it is created — could be settled and
  // marked paid without ever having been sent to anyone.
  if (!isIssuedInvoiceStatus(invoice.status)) {
    throw new Error(
      normalizeInvoiceStatus(invoice.status) === "void"
        ? "A voided invoice cannot take a payment."
        : "Issue this invoice before recording a payment against it.",
    );
  }

  if (parsed.provider_payment_id) {
    const { data: existing } = await supabase
      .from("payments")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("provider_payment_id", parsed.provider_payment_id)
      .maybeSingle();

    if (existing && existing.status === (parsed.status ?? "succeeded")) {
      return mapPayment(existing);
    }
    // Webhooks arrive out of order: a retried `payment_intent.processing` after
    // `succeeded` must never demote a settled payment (and with it the invoice).
    const settledStatuses = ["succeeded", "completed", "paid"];
    const incomingStatus = parsed.status ?? "succeeded";
    if (
      existing &&
      settledStatuses.includes(existing.status) &&
      (incomingStatus === "processing" || incomingStatus === "pending")
    ) {
      return mapPayment(existing);
    }
  }

  const { data: providerIntent } = parsed.provider_payment_id
    ? await supabase
        .from("payment_intents")
        .select("amount_cents,provider_charge_id,connected_account_id,processor_fee_cents,platform_fee_cents,application_fee_amount,provider_transfer_id,metadata")
        .eq("org_id", resolvedOrgId)
        .eq("provider_intent_id", parsed.provider_payment_id)
        .maybeSingle()
    : { data: null };
  const mergedMetadata = {
    ...((providerIntent?.metadata as Record<string, any> | null) ?? {}),
    ...(parsed.metadata ?? {}),
  };

  const providerGrossCents = Number(providerIntent?.amount_cents ?? 0);
  const providerProcessorFeeCents = Number(providerIntent?.processor_fee_cents ?? 0);
  const providerPlatformFeeCents = Number(providerIntent?.platform_fee_cents ?? 0);
  const providerApplicationFeeCents = Number(providerIntent?.application_fee_amount ?? 0);
  const grossCents = providerGrossCents > 0
    ? providerGrossCents
    : (metadataInt(mergedMetadata, "payment_method_total_cents") ?? parsed.amount_cents);
  const processorFeeCents = providerProcessorFeeCents > 0
    ? providerProcessorFeeCents
    : (metadataInt(mergedMetadata, "processor_fee_cents") ?? parsed.fee_cents ?? 0);
  const platformFeeCents = providerPlatformFeeCents > 0
    ? providerPlatformFeeCents
    : (metadataInt(mergedMetadata, "platform_fee_cents") ?? 0);
  const applicationFeeCents = providerApplicationFeeCents > 0
    ? providerApplicationFeeCents
    : (metadataInt(mergedMetadata, "application_fee_cents") ?? platformFeeCents);
  const totalFeeCents = processorFeeCents + platformFeeCents;

  const payload = {
    org_id: resolvedOrgId,
    project_id: invoice.project_id,
    invoice_id: invoiceId,
    amount_cents: parsed.amount_cents,
    gross_cents: grossCents,
    currency: parsed.currency ?? "usd",
    method: parsed.method ?? "ach",
    provider: parsed.provider ?? "stripe",
    provider_payment_id: parsed.provider_payment_id,
    provider_charge_id: providerIntent?.provider_charge_id ?? parsed.metadata?.provider_charge_id,
    connected_account_id: providerIntent?.connected_account_id ?? parsed.metadata?.connected_account_id,
    status: parsed.status ?? "succeeded",
    reference: parsed.reference ?? null,
    fee_cents: totalFeeCents,
    processor_fee_cents: processorFeeCents,
    platform_fee_cents: platformFeeCents,
    application_fee_cents: applicationFeeCents,
    provider_balance_transaction_id:
      parsed.metadata?.provider_balance_transaction_id,
    provider_transfer_id: providerIntent?.provider_transfer_id ?? parsed.metadata?.provider_transfer_id,
    net_cents: grossCents - totalFeeCents,
    metadata: mergedMetadata,
    idempotency_key: parsed.idempotency_key ?? null,
  };

  const { data: paymentResult, error: paymentError } = await supabase.rpc(
    "apply_invoice_payment_with_details_atomic",
    {
      p_org_id: resolvedOrgId,
      p_invoice_id: invoiceId,
      p_amount_cents: payload.amount_cents,
      p_currency: payload.currency,
      p_method: payload.method,
      p_provider: payload.provider,
      p_provider_payment_id: payload.provider_payment_id,
      p_status: payload.status,
      p_reference: payload.reference,
      p_fee_cents: payload.fee_cents,
      p_gross_cents: payload.gross_cents,
      p_net_cents: payload.net_cents,
      p_idempotency_key: payload.idempotency_key,
      p_metadata: payload.metadata,
      p_received_at: parsed.received_at,
      p_provider_charge_id: payload.provider_charge_id,
      p_connected_account_id: payload.connected_account_id,
      p_processor_fee_cents: payload.processor_fee_cents,
      p_platform_fee_cents: payload.platform_fee_cents,
      p_application_fee_cents: payload.application_fee_cents,
      p_provider_balance_transaction_id:
        payload.provider_balance_transaction_id,
      p_provider_transfer_id: payload.provider_transfer_id,
    },
  );

  if (paymentError || !paymentResult) {
    throw new Error(`Failed to record payment: ${paymentError?.message}`);
  }

  const paymentRow = paymentResult as any;
  const paymentSettled = ["succeeded", "completed", "paid"].includes(payload.status);

  if (paymentSettled && payload.invoice_id) {
    await ensureReceiptForPayment({
      supabase,
      orgId: resolvedOrgId,
      invoice,
      paymentId: paymentRow.id,
      amountCents: payload.amount_cents,
      provider: payload.provider,
      method: payload.method,
      reference: payload.reference,
    });
    // Non-fatal: releases any pending lien waivers once this payment settles the invoice.
    await releaseInvoiceLienWaiversIfPaid({
      supabase,
      orgId: resolvedOrgId,
      invoiceId,
      paymentId: paymentRow.id,
    });
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: undefined,
    action: "insert",
    entityType: "payment",
    entityId: paymentRow.id,
    after: payload,
  });

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "payment_recorded",
    entityType: "invoice",
    entityId: invoiceId,
    payload: {
      invoice_id: invoiceId,
      payment_id: paymentRow.id,
      project_id: invoice.project_id,
      invoice_number: invoice.invoice_number,
      amount_cents: parsed.amount_cents,
      status: parsed.status ?? "succeeded",
    },
  });

  if (paymentSettled) {
    try {
      await enqueuePaymentSync(paymentRow.id, resolvedOrgId);
    } catch (err) {
      console.error("Failed to enqueue QBO payment sync", err);
    }
    // The balance just dropped — any open intent quoted against the old balance
    // is now over-payable. Cancel them in Stripe so a stale client_secret in
    // someone's browser can't capture money Arc will refuse to apply.
    await cancelStaleOpenIntentsForInvoice({
      supabase,
      orgId: resolvedOrgId,
      invoiceId,
      excludeProviderIntentId: payload.provider_payment_id ?? null,
    });
  }

  return mapPayment({ ...paymentRow, ...payload });
}

/**
 * Cancel open Stripe intents whose charge no longer fits the invoice's
 * outstanding balance. Non-fatal by design: a failed cancel leaves the old
 * (worse) behaviour in place, and each failure is logged for follow-up.
 */
async function cancelStaleOpenIntentsForInvoice(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>;
  orgId: string;
  invoiceId: string;
  excludeProviderIntentId?: string | null;
}) {
  const { supabase, orgId, invoiceId } = params;
  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("balance_due_cents, total_cents")
    .eq("org_id", orgId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoiceRow) return;
  const balanceCents = Number(invoiceRow.balance_due_cents ?? invoiceRow.total_cents ?? 0);

  const { data: openIntents } = await supabase
    .from("payment_intents")
    .select("id, provider_intent_id, amount_cents, connected_account_id, metadata")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .in("status", ["requires_payment_method", "requires_confirmation", "requires_action"]);

  for (const intent of openIntents ?? []) {
    if (params.excludeProviderIntentId && intent.provider_intent_id === params.excludeProviderIntentId) continue;
    const principalCents = Number((intent.metadata as Record<string, any> | null)?.invoice_balance_cents ?? intent.amount_cents ?? 0);
    if (balanceCents > 0 && principalCents <= balanceCents) continue;
    try {
      await cancelStripePaymentIntent(intent.provider_intent_id, intent.connected_account_id ?? null);
      await supabase
        .from("payment_intents")
        .update({ status: "canceled" })
        .eq("org_id", orgId)
        .eq("id", intent.id);
      await supabase
        .from("invoice_payment_reservations")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("provider_intent_id", intent.provider_intent_id)
        .eq("status", "active");
    } catch (err) {
      console.error("Failed to cancel stale payment intent", intent.provider_intent_id, err);
    }
  }
}

export async function getReceivePaymentWorkspace(input: {
  partyType?: "contact" | "company";
  partyId?: string;
  orgId?: string;
} = {}) {
  const context = await requireOrgContext(input.orgId);
  await requireAuthorization({
    permission: "payment.read",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "receivable_payment",
    resourceId: input.partyId ?? context.orgId,
    logDecision: true,
  });
  const service = createServiceSupabaseClient();
  const [{ data: invoiceRows, error: invoiceError }, { data: groups, error: groupError }] = await Promise.all([
    service
      .from("invoices")
      .select(
        "id, invoice_number, project_id, customer_name, total_cents, balance_due_cents, due_date, status, metadata, " +
          "project:projects!inner(id, name, client_id)",
      )
      .eq("org_id", context.orgId)
      .in("status", ["sent", "partial", "overdue"])
      .gt("balance_due_cents", 0)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(500),
    service
      .from("receivable_payment_groups")
      .select("id, received_at, total_cents, method, reference, party_type, party_id, created_at")
      .eq("org_id", context.orgId)
      .order("received_at", { ascending: false })
      .limit(20),
  ]);
  if (invoiceError) throw new Error(`Failed to load open invoices: ${invoiceError.message}`);
  if (groupError) throw new Error(`Failed to load receipt history: ${groupError.message}`);

  let allowedProjectIds: Set<string> | null = null;
  if (input.partyType && input.partyId) {
    const { getFinancialPartyReceivables } = await import("@/lib/services/financial-parties");
    const party = await getFinancialPartyReceivables({
      partyType: input.partyType,
      partyId: input.partyId,
      orgId: context.orgId,
    });
    allowedProjectIds = new Set(party.projects.map((project) => project.project_id));
  }

  return {
    partyType: input.partyType ?? null,
    partyId: input.partyId ?? null,
    invoices: (invoiceRows ?? [])
      .map((row: any) => {
        const project = Array.isArray(row.project) ? row.project[0] : row.project;
        return {
          id: String(row.id),
          invoiceNumber: String(row.invoice_number ?? "Invoice"),
          projectId: String(row.project_id),
          projectName: String(project?.name ?? "Project"),
          clientContactId: project?.client_id ? String(project.client_id) : null,
          customerName: String(row.customer_name ?? row.metadata?.customer_name ?? "Customer"),
          totalCents: Number(row.total_cents ?? 0),
          balanceCents: Number(row.balance_due_cents ?? 0),
          dueDate: row.due_date ? String(row.due_date) : null,
          status: String(row.status),
        };
      })
      .filter((invoice) => !allowedProjectIds || allowedProjectIds.has(invoice.projectId)),
    recentGroups: groups ?? [],
  };
}

/**
 * Records one customer receipt across several invoices while preserving the
 * projector's one-invoice-per-payment source contract. The database function
 * locks and applies every allocation in one transaction; this service owns the
 * permission boundary and the non-economic follow-up records.
 */
export async function recordMultiInvoicePayment(input: ReceivePaymentInput, orgId?: string) {
  const parsed = receivePaymentInputSchema.parse(input);
  const context = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "payment.release",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "receivable_payment",
    resourceId: parsed.party_id ?? context.orgId,
    logDecision: true,
  });
  const service = createServiceSupabaseClient();
  const { data, error } = await service.rpc("apply_multi_invoice_payment_atomic", {
    p_org_id: context.orgId,
    p_received_at: parsed.received_at,
    p_method: parsed.method,
    p_reference: parsed.reference ?? null,
    p_provider: "manual",
    p_idempotency_key: parsed.idempotency_key,
    p_allocations: parsed.allocations,
    p_party_type: parsed.party_type ?? null,
    p_party_id: parsed.party_id ?? null,
    p_metadata: parsed.metadata ?? {},
    p_created_by: context.userId,
  });
  if (error || !data) throw new Error(`Failed to record the receipt: ${error?.message ?? "No result returned"}`);

  const result = z
    .object({
      group: z.object({ id: z.string().uuid(), total_cents: z.number().int() }).passthrough(),
      items: z.array(
        z.object({
          payment_id: z.string().uuid(),
          invoice_id: z.string().uuid(),
          amount_cents: z.number().int().positive(),
        }).passthrough(),
      ),
      duplicate: z.boolean(),
    })
    .parse(data);

  if (!result.duplicate) {
    for (const item of result.items) {
      const invoice = await getInvoiceTotals(service, item.invoice_id, context.orgId);
      await ensureReceiptForPayment({
        supabase: service,
        orgId: context.orgId,
        invoice,
        paymentId: item.payment_id,
        amountCents: item.amount_cents,
        provider: "manual",
        method: parsed.method,
        reference: parsed.reference ?? null,
      });
      await releaseInvoiceLienWaiversIfPaid({
        supabase: service,
        orgId: context.orgId,
        invoiceId: item.invoice_id,
        paymentId: item.payment_id,
      });
      try {
        await enqueuePaymentSync(item.payment_id, context.orgId);
      } catch (followupError) {
        console.error("Receipt follow-up could not be completed", followupError);
      }
    }

    await Promise.all([
      recordAudit({
        orgId: context.orgId,
        actorId: context.userId,
        action: "insert",
        entityType: "receivable_payment_group",
        entityId: result.group.id,
        after: { total_cents: result.group.total_cents, allocations: parsed.allocations },
        source: "receivables.receive_payment",
      }),
      recordEvent({
        orgId: context.orgId,
        actorId: context.userId,
        eventType: "receivable_payment_group_recorded",
        entityType: "receivable_payment_group",
        entityId: result.group.id,
        payload: { total_cents: result.group.total_cents, invoice_count: result.items.length },
      }),
    ]);
  }
  return result;
}

export async function recordPaymentReversal(input: {
  paymentId?: string;
  providerPaymentId?: string;
  providerChargeId?: string;
  amountCents: number;
  reversalType:
    | "refund"
    | "ach_return"
    | "chargeback"
    | "dispute"
    | "correction";
  providerReversalId?: string;
  reason?: string;
  metadata?: Record<string, any>;
  orgId?: string;
}) {
  const supabase = createServiceSupabaseClient();
  let resolvedOrgId = input.orgId;
  let paymentId = input.paymentId;

  if (!resolvedOrgId) {
    const ctx = await requireOrgContext();
    resolvedOrgId = ctx.orgId;
    await requireAuthorization({
      permission: "payment.release",
      userId: ctx.userId,
      orgId: ctx.orgId,
      supabase: ctx.supabase,
      logDecision: true,
      resourceType: "payment",
      resourceId: paymentId,
    });
  }

  if (!paymentId && input.providerPaymentId) {
    const { data: payment } = await supabase
      .from("payments")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("provider_payment_id", input.providerPaymentId)
      .maybeSingle();
    paymentId = payment?.id;
  }
  if (!paymentId && input.providerChargeId) {
    const { data: payment } = await supabase
      .from("payments")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("provider_charge_id", input.providerChargeId)
      .maybeSingle();
    paymentId = payment?.id;
  }
  if (!paymentId) throw new Error("Payment not found for reversal");

  const { data, error } = await supabase.rpc("record_payment_reversal_atomic", {
    p_org_id: resolvedOrgId,
    p_payment_id: paymentId,
    p_amount_cents: input.amountCents,
    p_reversal_type: input.reversalType,
    p_provider_reversal_id: input.providerReversalId ?? null,
    p_reason: input.reason ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error || !data) {
    throw new Error(`Failed to record payment reversal: ${error?.message}`);
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: undefined,
    action: "insert",
    entityType: "payment_reversal",
    entityId: (data as any).id,
    after: data,
  });
  const { data: reversedPayment } = await supabase
    .from("payments")
    .select("project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", paymentId)
    .maybeSingle();
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "payment_reversed",
    entityType: "payment",
    entityId: paymentId,
    payload: {
      amount_cents: input.amountCents,
      reversal_type: input.reversalType,
      provider_reversal_id: input.providerReversalId ?? null,
      project_id: reversedPayment?.project_id ?? null,
    },
  });

  return data;
}

export async function resolvePaymentReversal(input: {
  orgId: string;
  providerReversalId: string;
  outcome: "succeeded" | "reversed";
  reason?: string | null;
  metadata?: Record<string, any>;
}) {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc(
    "resolve_payment_reversal_atomic",
    {
      p_org_id: input.orgId,
      p_provider_reversal_id: input.providerReversalId,
      p_outcome: input.outcome,
      p_reason: input.reason ?? null,
      p_metadata: input.metadata ?? {},
    },
  );
  if (error || !data) {
    throw new Error(
      `Failed to resolve payment reversal: ${error?.message ?? "No result returned"}`,
    );
  }
  return data;
}

/**
 * Full payment activity for an invoice: every applied payment (Stripe, manual, or
 * QBO-imported) plus any reversals (refunds, ACH returns, chargebacks). Powers the
 * receivable detail sheet's payment breakdown so users can see what settled an invoice
 * — not just the resulting balance.
 */
export async function getInvoicePaymentActivity(
  invoiceId: string,
  orgId?: string,
) {
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "payment.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: invoiceId,
  });

  const [paymentsRes, allocationsRes, reversalsRes] = await Promise.all([
    supabase
      .from("payments")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("invoice_id", invoiceId),
    supabase
      .from("payment_allocations")
      .select("*, payment:payments(*)")
      .eq("org_id", resolvedOrgId)
      .eq("invoice_id", invoiceId),
    supabase
      .from("payment_reversals")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("invoice_id", invoiceId)
      .order("occurred_at", { ascending: false }),
  ]);

  if (paymentsRes.error)
    throw new Error(`Failed to list payments: ${paymentsRes.error.message}`);
  if (allocationsRes.error)
    throw new Error(
      `Failed to list payment allocations: ${allocationsRes.error.message}`,
    );
  if (reversalsRes.error)
    throw new Error(
      `Failed to list payment reversals: ${reversalsRes.error.message}`,
    );

  return {
    payments: [
      ...(paymentsRes.data ?? []).map(mapPayment),
      ...(allocationsRes.data ?? []).map((row: any) =>
        mapAllocatedPayment(row, invoiceId),
      ),
    ].sort((a, b) =>
      String(b.received_at ?? "").localeCompare(String(a.received_at ?? "")),
    ),
    reversals: (reversalsRes.data ?? []).map(mapPaymentReversal),
  };
}

export async function upsertReminderRule(input: unknown, orgId?: string) {
  const parsed = reminderRuleSchema.parse(input);
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "invoice.send",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: parsed.invoice_id,
  });

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id")
    .eq("id", parsed.invoice_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle();

  if (invoiceError || !invoice) {
    throw new Error("Invoice not found for reminder rule");
  }

  const { data, error } = await supabase
    .from("reminders")
    .insert({
      org_id: resolvedOrgId,
      invoice_id: parsed.invoice_id,
      channel: parsed.channel,
      schedule: parsed.schedule,
      offset_days: parsed.offset_days,
      template_id: parsed.template_id ?? null,
      metadata: parsed.metadata ?? {},
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create reminder rule: ${error?.message}`);
  }

  return data;
}

export async function upsertLateFeeRule(input: unknown, orgId?: string) {
  const parsed = lateFeeRuleSchema.parse(input);
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: parsed.project_id ? "project" : "org",
    resourceId: parsed.project_id ?? resolvedOrgId,
  });

  const { data, error } = await supabase
    .from("late_fees")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id ?? null,
      strategy: parsed.strategy,
      amount_cents: parsed.amount_cents ?? null,
      percent_rate: parsed.percent_rate ?? null,
      grace_days: parsed.grace_days ?? 0,
      repeat_days: parsed.repeat_days ?? null,
      max_applications: parsed.max_applications ?? null,
      metadata: parsed.metadata ?? {},
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create late fee rule: ${error?.message}`);
  }

  return data;
}
