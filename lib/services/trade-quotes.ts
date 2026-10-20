import "server-only";

import { z } from "zod";

import { recordAudit } from "@/lib/services/audit";
import { listBillingRateSchedules } from "@/lib/services/billing-rate-schedules";
import { requireTradeContext } from "@/lib/services/business-profile";
import { authorizeEstimateDocumentWrite } from "@/lib/services/estimate-document-authorization";
import { sendEstimate } from "@/lib/services/estimate-portal";
import { createEstimate, reviseEstimate, saveEstimateDraft } from "@/lib/services/estimates";
import { recordEvent } from "@/lib/services/events";
import { getTradeBuilderWorkspace } from "@/lib/services/external-portal-auth";
import { hasAnyPermission, hasPermission, requireAnyPermission, requirePermission } from "@/lib/services/permissions";
import { assertCanWriteDeals, assertProspectWriteAccess, canWriteDeals } from "@/lib/services/prospect-write-access";
import {
  createProspect,
  createProspectContact,
  listProspectActivity,
  logProspectContact,
  reopenProspect,
  setProspectFollowUp,
  updateProspect,
  updateProspectContact,
} from "@/lib/services/prospects";
import { createTradeJob } from "@/lib/services/trade-workspace";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { defaultTradeJobType } from "@/lib/business-profile";
import { serializeLostReason } from "@/lib/sales/lost-reasons";
import {
  compareOpportunities,
  quoteEstimateLines,
  quoteFunnel,
  quoteJobDraft,
  quoteLinesFromEstimate,
  quoteMove,
  quoteTotals,
  type QuoteDocumentFacts,
  type QuoteLine,
} from "@/lib/trade/quote";
import { tradeJobSchema } from "@/lib/trade/workspace";
import {
  opportunityCloseSchema,
  opportunityCustomerSchema,
  opportunityDueSchema,
  opportunityFollowUpSchema,
  opportunityRefSchema,
  quoteAcceptSchema,
  quoteRefSchema,
  quoteSaveSchema,
  quoteSendSchema,
  quoteStartJobSchema,
  tradeOpportunitySchema,
} from "@/lib/validation/trade-quotes";
import { logProspectContactInputSchema } from "@/lib/validation/prospects";

/**
 * A trade's opportunities and quotes. An opportunity is a prospect; a quote is
 * the prospect's estimate, so versions, the /e review link, signatures and the
 * activity trail are the estimate's own. Stages are derived by `quoteMove()`,
 * never stored. Accepting a quote wins the opportunity; starting the job turns
 * it into a trade job carrying the customer, the accepted price and billing.
 */

export const OPEN_OPPORTUNITY_CAP = 300;
export const CLOSED_OPPORTUNITY_CAP = 100;
/** Closed deals stay on the desk this long. */
const CLOSED_DAYS = 90;

const ACCEPTED_STATUSES = ["approved", "client_signed", "executed", "converted_to_project"];
const READ_PERMISSIONS = ["pipeline.read", "pipeline.write", "sales.manage"];

const embedded = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (Array.isArray(value) ? value : value ? [value] : []), z.array(schema));

const acceptedOptions = z.object({ accepted_total_cents: z.number().int() }).nullable().catch(null);

const quoteRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  version: z.number().int(),
  sent_at: z.string().nullable(),
  total_cents: z.number().int().nullable(),
  is_current_version: z.boolean().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  accepted: acceptedOptions,
});
type QuoteRow = z.infer<typeof quoteRow>;

const contactRow = z.object({
  id: z.string(),
  full_name: z.string().nullable(),
  company_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  is_primary: z.boolean().nullable(),
  contact_id: z.string().nullable(),
  promoted_contact_id: z.string().nullable(),
});
type ContactRow = z.infer<typeof contactRow>;

const opportunityRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  source: z.string().nullable(),
  notes: z.string().nullable(),
  lost_reason: z.string().nullable(),
  due_at: z.string().nullable(),
  next_follow_up_at: z.string().nullable(),
  source_grant_id: z.string().nullable(),
  jobsite_location: z.object({ street: z.string().optional() }).passthrough().nullable().catch(null),
  updated_at: z.string(),
  created_at: z.string(),
  contacts: embedded(contactRow),
  quotes: embedded(quoteRow),
  jobs: embedded(z.object({ id: z.string(), phase: z.string().nullable() })),
});
type OpportunityRow = z.infer<typeof opportunityRow>;

const OPPORTUNITY_SELECT = `id, name, status, source, notes, lost_reason, due_at, next_follow_up_at, source_grant_id,
  jobsite_location, updated_at, created_at,
  contacts:prospect_contacts(id, full_name, company_name, email, phone, is_primary, contact_id, promoted_contact_id),
  quotes:estimates(id, title, status, version, sent_at, total_cents, is_current_version, created_at, updated_at, accepted:metadata->accepted_options),
  jobs:projects(id, phase)`;

/** The quote an opportunity is judged by: the current version of its most recent quote. */
function currentQuote(quotes: QuoteRow[]) {
  return (
    quotes
      .filter((quote) => quote.is_current_version !== false)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

function quoteFacts(quote: QuoteRow | null): QuoteDocumentFacts | null {
  return quote
    ? {
        status: quote.status,
        sentAt: quote.sent_at,
        totalCents: quote.total_cents ?? 0,
        acceptedTotalCents: ACCEPTED_STATUSES.includes(quote.status)
          ? quote.accepted?.accepted_total_cents ?? quote.total_cents ?? 0
          : null,
      }
    : null;
}

function primaryContact(contacts: ContactRow[]) {
  return contacts.find((contact) => contact.is_primary) ?? contacts[0] ?? null;
}

function customerLabel(contact: ContactRow | null) {
  if (!contact) return null;
  const name = contact.full_name?.trim();
  const company = contact.company_name?.trim();
  if (company && name && company !== name) return `${company} · ${name}`;
  return company || name || null;
}

function deliveryJob(row: OpportunityRow) {
  return row.jobs.find((job) => job.phase === "delivery")?.id ?? null;
}

function toOpportunity(row: OpportunityRow, now: Date) {
  const quote = currentQuote(row.quotes);
  const jobId = deliveryJob(row);
  const move = quoteMove(
    {
      status: row.status,
      lostReason: row.lost_reason,
      dueAt: row.due_at,
      followUpAt: row.next_follow_up_at,
      quote: quoteFacts(quote),
      jobId,
    },
    now,
  );
  return {
    id: row.id,
    name: row.name,
    customer: customerLabel(primaryContact(row.contacts)),
    source: row.source,
    fromInvitation: Boolean(row.source_grant_id),
    dueAt: row.due_at,
    followUpAt: row.next_follow_up_at,
    updatedAt: row.updated_at,
    quoteId: quote?.id ?? null,
    jobId,
    move,
  };
}
export type TradeOpportunity = ReturnType<typeof toOpportunity>;

export type TrackableInvitation = {
  id: string;
  builder: string;
  project: string;
  dueAt: string | null;
};

/** Bid invitations shared with this member that nobody has tracked yet. Empty when the member has no verified builder identity. */
async function untrackedInvitations(context: Awaited<ReturnType<typeof requireTradeContext>>): Promise<TrackableInvitation[]> {
  const workspace = await getTradeBuilderWorkspace();
  const bids = (workspace?.items ?? []).filter((item) => item.kind === "bid").slice(0, 200);
  if (!bids.length) return [];
  const { data, error } = await context.supabase
    .from("prospects")
    .select("source_grant_id")
    .eq("org_id", context.orgId)
    .in(
      "source_grant_id",
      bids.map((item) => item.id),
    );
  if (error) throw new Error("Unable to check which invitations you already track.");
  const tracked = new Set((data ?? []).map((row) => row.source_grant_id));
  return bids
    .filter((item) => !tracked.has(item.id))
    .map((item) => ({ id: item.id, builder: item.org_name, project: item.project_name, dueAt: item.due_at ?? null }));
}

export async function listTradeOpportunities() {
  const context = await requireTradeContext();
  await requireAnyPermission(READ_PERMISSIONS, context);
  const now = new Date();
  const closedSince = new Date(now.getTime() - CLOSED_DAYS * 86_400_000).toISOString();
  const [open, closed, canWrite] = await Promise.all([
    context.supabase
      .from("prospects")
      .select(OPPORTUNITY_SELECT, { count: "exact" })
      .eq("org_id", context.orgId)
      .is("community_id", null)
      .not("status", "in", "(won,lost)")
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("id")
      .limit(OPEN_OPPORTUNITY_CAP),
    context.supabase
      .from("prospects")
      .select(OPPORTUNITY_SELECT, { count: "exact" })
      .eq("org_id", context.orgId)
      .is("community_id", null)
      .in("status", ["won", "lost"])
      .gte("updated_at", closedSince)
      .order("updated_at", { ascending: false })
      .order("id")
      .limit(CLOSED_OPPORTUNITY_CAP),
    canWriteDeals(context),
  ]);
  if (open.error || closed.error) throw new Error("Unable to load your opportunities.");
  const rows = [...z.array(opportunityRow).parse(open.data ?? []), ...z.array(opportunityRow).parse(closed.data ?? [])]
    .map((row) => toOpportunity(row, now))
    .sort(compareOpportunities);
  return {
    opportunities: rows,
    funnel: quoteFunnel(rows.map((row) => row.move)),
    openTotal: open.count ?? 0,
    closedTotal: closed.count ?? 0,
    openCap: OPEN_OPPORTUNITY_CAP,
    closedCap: CLOSED_OPPORTUNITY_CAP,
    closedDays: CLOSED_DAYS,
    invitations: canWrite ? await untrackedInvitations(context) : [],
    canWrite,
  };
}
export type TradeOpportunityList = Awaited<ReturnType<typeof listTradeOpportunities>>;

/** Follow-ups and price deadlines that need someone this week, for Today. */
export async function listQuoteAttention(context: Awaited<ReturnType<typeof requireTradeContext>>) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const { data, error } = await context.supabase
    .from("prospects")
    .select(OPPORTUNITY_SELECT)
    .eq("org_id", context.orgId)
    .is("community_id", null)
    .not("status", "in", "(won,lost)")
    .or(`next_follow_up_at.lte.${horizon},due_at.lte.${horizon}`)
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("id")
    .limit(51);
  if (error) throw new Error("Unable to load quotes that need you.");
  const rows = z
    .array(opportunityRow)
    .parse(data ?? [])
    .map((row) => toOpportunity(row, now))
    .filter((row) => row.move.stage !== "won")
    .sort(compareOpportunities);
  return { items: rows.slice(0, 50), truncated: rows.length > 50 };
}

async function loadOpportunityRow(context: Awaited<ReturnType<typeof requireTradeContext>>, prospectId: string) {
  const { data, error } = await context.supabase
    .from("prospects")
    .select(OPPORTUNITY_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", prospectId)
    .is("community_id", null)
    .maybeSingle();
  if (error) throw new Error("Unable to load this opportunity.");
  if (!data) throw new Error("This opportunity is not in your company workspace.");
  return opportunityRow.parse(data);
}

const itemRow = z.object({
  item_type: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.union([z.number(), z.string()]).nullable(),
  unit: z.string().nullable(),
  unit_cost_cents: z.number().int().nullable(),
  markup_pct: z.union([z.number(), z.string()]).nullable(),
  sort_order: z.number().int().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

const quoteDetailRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  sent_at: z.string().nullable(),
  updated_at: z.string(),
  valid_until: z.string().nullable(),
  total_cents: z.number().int().nullable(),
  metadata: z
    .object({
      tax_rate: z.coerce.number().catch(0),
      summary: z.string().nullable().catch(null),
      exclusions: z.string().nullable().catch(null),
      terms: z.string().nullable().catch(null),
    })
    .partial()
    .nullable(),
  items: embedded(itemRow),
});

async function loadQuoteDetail(context: Awaited<ReturnType<typeof requireTradeContext>>, estimateId: string) {
  const { data, error } = await context.supabase
    .from("estimates")
    .select(
      "id, title, status, sent_at, updated_at, valid_until, total_cents, metadata, items:estimate_items(item_type, description, quantity, unit, unit_cost_cents, markup_pct, sort_order, metadata)",
    )
    .eq("org_id", context.orgId)
    .eq("id", estimateId)
    .maybeSingle();
  if (error || !data) throw new Error("Unable to load the quote.");
  const row = quoteDetailRow.parse(data);
  const lines = quoteLinesFromEstimate(row.items);
  const taxRate = row.metadata?.tax_rate ?? 0;
  return {
    id: row.id,
    status: row.status,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
    editable: row.status === "draft" && !row.sent_at,
    quote: {
      title: row.title,
      lines,
      tax_rate: taxRate,
      valid_until: row.valid_until,
      scope: row.metadata?.summary ?? "",
      exclusions: row.metadata?.exclusions ?? "",
      terms: row.metadata?.terms ?? "",
    },
    totals: quoteTotals(lines, taxRate),
  };
}

export type QuoteRateOption = {
  id: string;
  kind: "labor" | "equipment";
  label: string;
  unit: string;
  rateCents: number;
};

/** Labor classifications and equipment from the company's active rate schedules, for pricing lines. */
async function quoteRateOptions(): Promise<QuoteRateOption[]> {
  const today = new Date().toISOString().slice(0, 10);
  const schedules = await listBillingRateSchedules();
  return schedules
    .filter((schedule) => schedule.status === "active")
    .flatMap((schedule) =>
      schedule.rates
        .filter(
          (rate) =>
            (rate.kind === "labor_role" || rate.kind === "equipment") &&
            rate.rate_cents != null &&
            rate.effective_from <= today &&
            (!rate.effective_to || rate.effective_to >= today),
        )
        .map((rate) => ({
          id: rate.id,
          kind: rate.kind === "labor_role" ? ("labor" as const) : ("equipment" as const),
          label: [rate.kind === "labor_role" ? rate.role_name : rate.equipment_name, schedules.length > 1 ? schedule.name : null]
            .filter(Boolean)
            .join(" · "),
          unit: rate.unit === "hour" ? "hr" : rate.unit,
          rateCents: rate.rate_cents ?? 0,
        })),
    )
    .slice(0, 200);
}

export async function getTradeOpportunity(prospectId: string) {
  const parsedId = z.string().uuid().parse(prospectId);
  const context = await requireTradeContext();
  await requireAnyPermission(READ_PERMISSIONS, context);
  const now = new Date();
  const row = await loadOpportunityRow(context, parsedId);
  const opportunity = toOpportunity(row, now);
  const [canWrite, canStartJob, activity, quote, rates] = await Promise.all([
    canWriteDeals(context),
    hasPermission("project.manage", context),
    listProspectActivity(parsedId, context.orgId, 40),
    opportunity.quoteId ? loadQuoteDetail(context, opportunity.quoteId) : Promise.resolve(null),
    quoteRateOptions(),
  ]);
  const contact = primaryContact(row.contacts);
  return {
    opportunity,
    scope: row.notes ?? "",
    address: row.jobsite_location?.street ?? "",
    contact: contact
      ? { name: contact.full_name, company: contact.company_name, email: contact.email, phone: contact.phone }
      : null,
    versions: row.quotes
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((version) => ({
        id: version.id,
        title: version.title,
        version: version.version,
        status: version.status,
        sentAt: version.sent_at,
        totalCents: version.total_cents ?? 0,
        current: version.is_current_version !== false,
      })),
    quote,
    rates,
    activity,
    jobDraft: quoteJobDraft({
      name: row.name,
      clientId: null,
      address: row.jobsite_location?.street ?? "",
      scope: row.notes ?? "",
      customerIsCompany: Boolean(contact?.company_name?.trim()),
      acceptedTotalCents: opportunity.move.valueCents,
      propertyType: defaultTradeJobType(context.productTier),
    }),
    canWrite,
    canStartJob,
  };
}
export type TradeOpportunityDetail = Awaited<ReturnType<typeof getTradeOpportunity>>;

export async function createTradeOpportunity(input: unknown) {
  const data = tradeOpportunitySchema.parse(input);
  const context = await requireTradeContext();
  await assertCanWriteDeals(context);
  let contact: { full_name: string; email?: string; phone?: string; company_name?: string; contact_id?: string } | null = null;
  if (data.contact_id) {
    const { data: row, error } = await context.supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("org_id", context.orgId)
      .eq("id", data.contact_id)
      .maybeSingle();
    if (error || !row) throw new Error("Choose a customer from your company directory.");
    contact = { full_name: row.full_name, email: row.email ?? undefined, phone: row.phone ?? undefined, contact_id: row.id };
  } else {
    contact = {
      full_name: data.customer_name || data.customer_company,
      email: data.customer_email || undefined,
      phone: data.customer_phone || undefined,
      company_name: data.customer_company || undefined,
    };
  }
  const prospect = await createProspect({
    input: {
      name: data.name,
      status: "new",
      source: data.source,
      notes: data.scope || null,
      due_at: data.due_at,
      jobsite_location: data.address ? { street: data.address } : null,
      primary_contact: contact,
    },
    traffic: null,
  });
  return { id: prospect.id };
}

/** Tracks a builder's bid invitation as an opportunity, resolved again against the member's verified identity. */
export async function trackBuilderInvitation(rawGrantId: unknown) {
  const grantId = z.string().uuid().parse(rawGrantId);
  const context = await requireTradeContext();
  await assertCanWriteDeals(context);
  const workspace = await getTradeBuilderWorkspace();
  const item = workspace?.items.find((entry) => entry.id === grantId && entry.kind === "bid");
  if (!item) throw new Error("This invitation is no longer available. Ask the builder to check your access.");
  const prospect = await createProspect({
    input: {
      name: item.project_name,
      status: "new",
      source: "builder_invitation",
      notes: `Bid invitation from ${item.org_name}.`,
      due_at: item.due_at ?? null,
      jobsite_location: item.project_address ? { street: item.project_address } : null,
      primary_contact: {
        full_name: item.contact_name?.trim() || item.org_name,
        // The grant names its contact by email when the directory holds no name for them.
        email: item.contact_name && z.string().email().safeParse(item.contact_name.trim()).success ? item.contact_name.trim() : undefined,
        company_name: item.org_name,
        role: "Builder",
      },
    },
    traffic: null,
    sourceGrantId: item.id,
  });
  return { id: prospect.id };
}

/** A quote stores its recipient when it is saved; an unanswered quote follows the customer when the office corrects them. */
async function retargetQuoteRecipients(orgId: string, prospectId: string, recipient: { name: string; email: string }) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("estimates")
    .select("id, metadata")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .in("status", ["draft", "sent", "viewed", "changes_requested"]);
  if (error) throw new Error("The customer was saved, but their quotes were not updated.");
  const updates = await Promise.all(
    (data ?? []).map((estimate) => {
      const metadata: Record<string, unknown> = z.record(z.unknown()).catch({}).parse(estimate.metadata);
      return service
        .from("estimates")
        .update({ metadata: { ...metadata, recipient: recipient.email ? { name: recipient.name, email: recipient.email } : null } })
        .eq("org_id", orgId)
        .eq("id", estimate.id);
    }),
  );
  if (updates.some((result) => result.error)) throw new Error("The customer was saved, but their quotes were not updated.");
}

/**
 * Who the quote goes to. An invited opportunity starts with the builder's name
 * and no email, and sending refuses without one, so the office fills it in
 * here. The prospect's contact and the directory contact it is linked to move
 * together, because the job started from the quote takes the directory contact
 * as its customer.
 */
export async function updateOpportunityCustomer(input: unknown) {
  const data = opportunityCustomerSchema.parse(input);
  const context = await requireTradeContext();
  await assertProspectWriteAccess(context, data.prospect_id);
  const row = await loadOpportunityRow(context, data.prospect_id);
  if (row.status === "won") throw new Error("This opportunity already started its job. Change the customer on the job.");
  const contact = primaryContact(row.contacts);
  const fields = {
    full_name: data.name || data.company,
    email: data.email || null,
    phone: data.phone || null,
    company_name: data.company || null,
  };
  if (contact) {
    await updateProspectContact({ contactId: contact.id, input: fields });
  } else {
    await createProspectContact({ prospectId: data.prospect_id, input: { ...fields, is_primary: true } });
  }
  await retargetQuoteRecipients(context.orgId, data.prospect_id, { name: fields.full_name, email: data.email });
  const directoryId = contact?.contact_id ?? contact?.promoted_contact_id ?? null;
  if (directoryId && (await hasAnyPermission(["directory.write", "directory.manage"], context))) {
    const { updateContact } = await import("@/lib/services/contacts");
    await updateContact({
      contactId: directoryId,
      input: { full_name: fields.full_name, email: data.email || undefined, phone: data.phone || undefined },
    });
  }
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "prospect",
    entityId: data.prospect_id,
    before: { customer: contact ? { name: contact.full_name, company: contact.company_name, email: contact.email, phone: contact.phone } : null },
    after: { customer: { name: data.name, company: data.company, email: data.email, phone: data.phone } },
  });
  return { id: data.prospect_id };
}

export async function setOpportunityDue(input: unknown) {
  const data = opportunityDueSchema.parse(input);
  await requireTradeContext();
  await updateProspect({ prospectId: data.prospect_id, input: { due_at: data.due_at } });
  return { id: data.prospect_id };
}

export async function setOpportunityFollowUp(input: unknown) {
  const data = opportunityFollowUpSchema.parse(input);
  await requireTradeContext();
  await setProspectFollowUp({ prospectId: data.prospect_id, nextFollowUpAt: data.at, note: data.note || null, outcome: "done" });
  return { id: data.prospect_id };
}

/** A call, email or visit with the customer; it lands on the opportunity's trail. */
export async function logOpportunityContact(prospectId: unknown, input: unknown) {
  const id = z.string().uuid().parse(prospectId);
  await requireTradeContext();
  await logProspectContact({ prospectId: id, input: logProspectContactInputSchema.parse(input) });
  return { id };
}

async function assertQuoteOnOpportunity(context: Awaited<ReturnType<typeof requireTradeContext>>, estimateId: string, prospectId: string) {
  const { data, error } = await context.supabase
    .from("estimates")
    .select("id, prospect_id, updated_at")
    .eq("org_id", context.orgId)
    .eq("id", estimateId)
    .maybeSingle();
  if (error || !data || data.prospect_id !== prospectId) throw new Error("This quote belongs to a different opportunity.");
  return data;
}

function recipientFor(contact: ContactRow | null) {
  return {
    recipient_contact_id: contact?.contact_id ?? contact?.promoted_contact_id ?? null,
    recipient_name: contact?.full_name?.trim() || contact?.company_name?.trim() || null,
    recipient_email: contact?.email?.trim() || null,
  };
}

/** Saves the quote: the first save creates it, later saves edit the unsent draft. */
export async function saveTradeQuote(input: unknown) {
  const data = quoteSaveSchema.parse(input);
  const context = await requireTradeContext();
  await assertProspectWriteAccess(context, data.prospect_id);
  const row = await loadOpportunityRow(context, data.prospect_id);
  if (row.status === "won" || row.status === "lost") throw new Error("Reopen this opportunity before changing its quote.");
  const lines = quoteEstimateLines(data.quote.lines);
  const recipient = recipientFor(primaryContact(row.contacts));
  const common = {
    title: data.quote.title,
    summary: data.quote.scope || undefined,
    exclusions: data.quote.exclusions || undefined,
    terms: data.quote.terms || undefined,
    valid_until: data.quote.valid_until ?? undefined,
    tax_rate: data.quote.tax_rate,
    ...recipient,
  };
  if (!data.estimate_id) {
    const { estimate } = await createEstimate({
      ...common,
      prospect_id: data.prospect_id,
      lines,
    });
    return { id: z.string().parse(estimate.id) };
  }
  const existing = await assertQuoteOnOpportunity(context, data.estimate_id, data.prospect_id);
  const saved = await saveEstimateDraft({
    estimateId: data.estimate_id,
    expectedUpdatedAt: data.expected_updated_at ?? existing.updated_at,
    input: {
      ...common,
      recipient_name: common.recipient_name ?? undefined,
      recipient_email: common.recipient_email ?? undefined,
      prospect_id: data.prospect_id,
      lines,
    },
  });
  return { id: saved.id };
}

/** A new draft version of a sent quote, for changes the customer asked for. The sent version stays as it was. */
export async function reviseTradeQuote(input: unknown) {
  const data = quoteRefSchema.parse(input);
  await requireTradeContext();
  const revised = await reviseEstimate({ estimateId: data.estimate_id });
  return { id: z.string().parse(revised.id) };
}

/**
 * Sends the quote on the review link. Sending writes the trail entry; when no
 * follow-up is set, one is set three days out so the quote cannot go quiet.
 */
export async function sendTradeQuote(input: unknown) {
  const data = quoteSendSchema.parse(input);
  const context = await requireTradeContext();
  const { data: estimate, error } = await context.supabase
    .from("estimates")
    .select("id, prospect_id, prospect:prospects(next_follow_up_at)")
    .eq("org_id", context.orgId)
    .eq("id", data.estimate_id)
    .maybeSingle();
  if (error || !estimate?.prospect_id) throw new Error("Unable to load the quote.");
  const sent = await sendEstimate({ estimateId: data.estimate_id, message: data.message });
  const followUp = embedded(z.object({ next_follow_up_at: z.string().nullable() })).parse(estimate.prospect)[0];
  if (!followUp?.next_follow_up_at) {
    await setProspectFollowUp({
      prospectId: estimate.prospect_id,
      nextFollowUpAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      note: "Follow up on the quote",
    });
  }
  return { emailSent: sent.emailSent, url: sent.url };
}

/** Records a yes given outside the review link. The quote's price, add-ons excluded, is what was accepted. */
export async function recordQuoteAcceptance(input: unknown) {
  const data = quoteAcceptSchema.parse(input);
  await requireTradeContext();
  const { service, orgId, userId, document } = await authorizeEstimateDocumentWrite(data.estimate_id);
  if (!document.prospect_id) throw new Error("This quote is not on an opportunity.");
  if (document.is_current_version === false) throw new Error("A newer version of this quote exists. Record the answer on that one.");
  const nowIso = new Date().toISOString();
  const { data: total, error: totalError } = await service
    .from("estimates")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("id", data.estimate_id)
    .single();
  if (totalError) throw new Error("Unable to load the quote.");
  const { data: updated, error } = await service
    .from("estimates")
    .update({
      status: "approved",
      approved_at: nowIso,
      approved_by: userId,
      responded_at: nowIso,
      client_decision_name: data.accepted_by,
      decision_note: data.note || null,
      metadata: {
        ...(document.metadata ?? {}),
        accepted_options: { ids: [], accepted_total_cents: total.total_cents ?? 0 },
        accepted_outside_portal: { by: data.accepted_by, recorded_by: userId, recorded_at: nowIso },
      },
      updated_at: nowIso,
    })
    .eq("org_id", orgId)
    .eq("id", data.estimate_id)
    .eq("updated_at", document.updated_at)
    .not("status", "in", `(${ACCEPTED_STATUSES.join(",")})`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("Unable to record the acceptance.");
  if (!updated) throw new Error("This quote changed or was already accepted. Reload and try again.");
  await service
    .from("prospects")
    .update({ status: "client_approved", updated_at: nowIso })
    .eq("org_id", orgId)
    .eq("id", document.prospect_id)
    .not("status", "in", "(won,lost)");
  await Promise.all([
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "estimate_accepted_outside_portal",
      entityType: "estimate",
      entityId: data.estimate_id,
      payload: { by: data.accepted_by, note: data.note || null },
    }),
    recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "estimate",
      entityId: data.estimate_id,
      before: { status: document.status },
      after: { status: "approved", accepted_by: data.accepted_by },
    }),
  ]);
  return { id: data.estimate_id };
}

/**
 * A closed opportunity cannot be accepted. The review link stays valid until it
 * is revoked, so closing revokes the links of every quote the customer has not
 * answered; reopening and sending again issues a fresh one.
 */
async function withdrawQuoteLinks(orgId: string, prospectId: string) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("estimates")
    .select("id")
    .eq("org_id", orgId)
    .eq("prospect_id", prospectId)
    .in("status", ["sent", "viewed", "changes_requested"]);
  if (error) throw new Error("The opportunity was closed, but its quote link could not be withdrawn.");
  const ids = (data ?? []).map((estimate) => estimate.id);
  if (!ids.length) return;
  const [links, legacy] = await Promise.all([
    service.from("estimate_review_links").delete().eq("org_id", orgId).in("estimate_id", ids),
    service.from("estimates").update({ token_hash: null }).eq("org_id", orgId).in("id", ids),
  ]);
  if (links.error || legacy.error) throw new Error("The opportunity was closed, but its quote link could not be withdrawn.");
}

/** Lost to someone else, or declined by the company. The quote stays on the opportunity for reuse. */
export async function closeTradeOpportunity(input: unknown) {
  const data = opportunityCloseSchema.parse(input);
  const context = await requireTradeContext();
  await updateProspect({
    prospectId: data.prospect_id,
    input: {
      status: "lost",
      lost_reason: serializeLostReason(data.reason_code, data.note || null),
      next_follow_up_at: null,
    },
  });
  await withdrawQuoteLinks(context.orgId, data.prospect_id);
  return { id: data.prospect_id };
}

export async function reopenTradeOpportunity(input: unknown) {
  const data = opportunityRefSchema.parse(input);
  await requireTradeContext();
  await reopenProspect({ prospectId: data.prospect_id });
  return { id: data.prospect_id };
}

/** A past quote's lines, to start a new quote from. Any quote in the company can be reused. */
export async function getQuoteLinesForReuse(input: unknown): Promise<QuoteLine[]> {
  const data = quoteRefSchema.parse(input);
  const context = await requireTradeContext();
  await requireAnyPermission(READ_PERMISSIONS, context);
  const detail = await loadQuoteDetail(context, data.estimate_id);
  return detail.quote.lines;
}

export async function listReusableQuotes() {
  const context = await requireTradeContext();
  await requireAnyPermission(READ_PERMISSIONS, context);
  const { data, error } = await context.supabase
    .from("estimates")
    .select("id, title, total_cents, created_at, prospect:prospects(name)")
    .eq("org_id", context.orgId)
    .not("prospect_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Unable to load past quotes.");
  return z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        total_cents: z.number().int().nullable(),
        created_at: z.string(),
        prospect: embedded(z.object({ name: z.string() })),
      }),
    )
    .parse(data ?? [])
    .map((row) => ({
      id: row.id,
      title: row.title,
      opportunity: row.prospect[0]?.name ?? null,
      totalCents: row.total_cents ?? 0,
      createdAt: row.created_at,
    }));
}

/** The opportunity's customer as a directory contact, promoted the first time a job needs one. */
async function customerContactId(context: Awaited<ReturnType<typeof requireTradeContext>>, contact: ContactRow | null) {
  if (!contact) return null;
  const known = contact.contact_id ?? contact.promoted_contact_id;
  if (known) return known;
  if (!(await hasAnyPermission(["directory.write", "directory.manage"], context))) return null;
  const { createContact } = await import("@/lib/services/contacts");
  const created = await createContact({
    input: {
      full_name: contact.full_name?.trim() || contact.company_name?.trim() || "Customer",
      email: contact.email || undefined,
      phone: contact.phone || undefined,
      contact_type: "client",
    },
  });
  await context.supabase
    .from("prospect_contacts")
    .update({ promoted_contact_id: created.id, updated_at: new Date().toISOString() })
    .eq("org_id", context.orgId)
    .eq("id", contact.id);
  return created.id;
}

/**
 * Starts the job an accepted quote won. The customer, address, scope and the
 * accepted price carry over; billing is what the office confirmed. Starting
 * twice returns the job already started.
 */
export async function startTradeJobFromQuote(input: unknown) {
  const data = quoteStartJobSchema.parse(input);
  const context = await requireTradeContext();
  await requirePermission("project.manage", context);
  const service = createServiceSupabaseClient();
  // Privileged lookup: a job this member cannot see is still the job this opportunity started.
  const { data: started, error: startedError } = await service
    .from("projects")
    .select("id, phase")
    .eq("org_id", context.orgId)
    .eq("prospect_id", data.prospect_id)
    .maybeSingle();
  if (startedError) throw new Error("Unable to check for a job already started.");
  if (started?.phase === "delivery") return { id: started.id, alreadyStarted: true };
  if (started) throw new Error("This opportunity has a builder pricing workspace. Start its job from the deal room.");
  const row = await loadOpportunityRow(context, data.prospect_id);
  if (row.status === "lost") throw new Error("Reopen this opportunity before starting its job.");
  const quote = currentQuote(row.quotes);
  const facts = quoteFacts(quote);
  if (!quote || facts?.acceptedTotalCents == null)
    throw new Error("Record the customer's acceptance of the quote before starting the job.");
  const contact = primaryContact(row.contacts);
  const draft = quoteJobDraft({
    name: data.name,
    clientId: await customerContactId(context, contact),
    address: row.jobsite_location?.street ?? "",
    scope: row.notes ?? "",
    customerIsCompany: Boolean(contact?.company_name?.trim()),
    acceptedTotalCents: facts.acceptedTotalCents,
    propertyType: defaultTradeJobType(context.productTier),
  });
  const job = await createTradeJob(
    tradeJobSchema.parse({
      ...draft,
      billing_basis: data.billing_basis,
      retainage_percent: data.retainage_percent,
      payment_terms_days: data.payment_terms_days,
      customer_certifies: data.customer_certifies,
      review_before_send: data.review_before_send,
      start_date: data.start_date,
      end_date: data.end_date,
    }),
    { prospectId: data.prospect_id },
  );
  const nowIso = new Date().toISOString();
  const [estimateLink, won] = await Promise.all([
    service.from("estimates").update({ project_id: job.id }).eq("org_id", context.orgId).eq("id", quote.id),
    service
      .from("prospects")
      .update({ status: "won", won_at: nowIso, lost_at: null, next_follow_up_at: null, updated_at: nowIso })
      .eq("org_id", context.orgId)
      .eq("id", data.prospect_id),
  ]);
  if (estimateLink.error || won.error) throw new Error("The job started, but the opportunity was not marked won. Reload and try again.");
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "prospect_won",
      entityType: "prospect",
      entityId: data.prospect_id,
      payload: { project_id: job.id, estimate_id: quote.id, contract_cents: facts.acceptedTotalCents },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "prospect",
      entityId: data.prospect_id,
      before: { status: row.status },
      after: { status: "won", project_id: job.id, estimate_id: quote.id },
    }),
  ]);
  return { id: job.id, alreadyStarted: false };
}
