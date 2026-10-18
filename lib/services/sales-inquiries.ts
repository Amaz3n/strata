import { readPageOrEmpty } from "@/lib/land/paging"
import { orFilterTerm } from "@/lib/search-picker"
import { INQUIRY_CHANNEL_LABELS } from "@/lib/sales/activity"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { fileLeadRecord, leadReceiptForHandFiling, recordLeadFiled, type LeadFilingInput } from "@/lib/services/lead-intake"
import { getProspect, type Prospect } from "@/lib/services/prospects"
import { assertCanWriteDeals, assertProspectOwner } from "@/lib/services/prospect-write-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { productionInquiryInputSchema, type ProductionInquiryInput } from "@/lib/validation/prospects"

/**
 * Registering a buyer at the model home. One entry, two records: the deal the
 * consultant will work, and the day's traffic count the sales manager reads on
 * Monday. Traffic used to be logged separately on the community workbench, which
 * meant it was never logged at all.
 *
 * Files through the same core as a website lead (`file_lead`), so a buyer who
 * filled in the website form last week and walks in today lands on the deal
 * they already have — with the walk-in kept as a second touch — instead of
 * becoming a second deal. A phone call is not footfall and is not counted.
 */
export async function registerProductionInquiry(
  input: ProductionInquiryInput,
  orgId?: string,
): Promise<Prospect> {
  const parsed = productionInquiryInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await assertCanWriteDeals(context)
  // A buyer picked from the search is attached as they are on file, not retyped:
  // the directory's name, phone and email win over whatever the form carries.
  const [existing, receipt] = await Promise.all([
    parsed.existingContactId ? loadExistingBuyer(context, parsed.existingContactId) : null,
    parsed.leadReceiptId ? leadReceiptForHandFiling(context, parsed.leadReceiptId) : null,
  ])
  const ownerUserId = parsed.ownerUserId ?? context.userId
  await assertProspectOwner(context.orgId, ownerUserId)
  const source = parsed.source?.trim() || INQUIRY_CHANNEL_LABELS[parsed.channel]
  const lead: LeadFilingInput = {
    name: existing?.full_name ?? parsed.buyerName,
    email: existing ? existing.email : parsed.email?.trim() || null,
    phone: existing ? existing.phone : parsed.phone?.trim() || null,
    contactId: existing?.id ?? null,
    communityId: parsed.communityId ?? null,
    ownerUserId,
    source,
    planInterest: parsed.planInterest?.trim() || null,
    priceRange: parsed.priceRange?.trim() || null,
    timeframe: parsed.timeframe?.trim() || null,
    notes: parsed.notes?.trim() || null,
    channel: parsed.channel,
    occurredOn: parsed.loggedDate,
    createdBy: context.userId,
    // Filed by hand, a website lead keeps the campaign its form carried.
    attribution: receipt?.attribution ?? { sourceLabel: source },
  }
  const service = createServiceSupabaseClient()
  // With a delivery, the same transaction marks it filed (or merged) on this deal.
  const result = await fileLeadRecord(service, context.orgId, receipt?.receiptId ?? null, lead)
  const coopName = parsed.coopAgentName?.trim()
  await recordLeadFiled(service, {
    orgId: context.orgId,
    actorId: context.userId,
    result,
    lead,
    receiptId: receipt?.receiptId ?? null,
    matchDirectoryByName: true,
    coopAgent: coopName ? { name: coopName, brokerage: parsed.coopBrokerage?.trim() || null, email: null, phone: null } : null,
  })
  if (receipt) {
    await recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "lead_intake_receipt",
      entityId: receipt.receiptId,
      before: { status: "failed", failure_code: receipt.failureCode },
      after: { status: result.outcome, prospect_id: result.prospect_id, filed_by_hand: true },
    })
  }
  return getProspect(result.prospect_id, context.orgId)
}

async function loadExistingBuyer(context: Awaited<ReturnType<typeof requireOrgContext>>, contactId: string) {
  const { data, error } = await context.supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("org_id", context.orgId)
    .is("archived_at", null)
    .eq("id", contactId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the buyer: ${error.message}`)
  if (!data) throw new Error("That buyer is no longer in the directory. Search again or enter them as new.")
  return {
    id: data.id,
    full_name: data.full_name,
    email: data.email || null,
    phone: data.phone || null,
  }
}

export interface BuyerSearchResult {
  id: string
  name: string
  email: string | null
  phone: string | null
  /** Role labels they already hold with the org (Buyer, Homeowner, Prospect…). */
  roles: string[]
}

export interface BuyerSearchPage {
  buyers: BuyerSearchResult[]
  page: number
  pageSize: number
  total: number
}

/**
 * Existing people matching what the consultant typed — name, email or phone — so
 * a returning buyer is picked instead of entered a second time. Reads the
 * directory's contact list, org-scoped, a page at a time.
 */
export async function searchBuyerContacts(
  input: { search: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<BuyerSearchPage> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(Math.max(1, input.pageSize ?? 25), 50)
  const term = orFilterTerm(input.search)

  const from = (page - 1) * pageSize
  let query = context.supabase
    .from("directory_entries")
    .select("id, name, email, phone, role_states", { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("kind", "contact")
    .is("archived_at", null)
  if (term) query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
  const ordered = query.order("name").order("id")
  const { data, error, count } = await readPageOrEmpty((start, end) => ordered.range(start, end), from, from + pageSize - 1)
  if (error) throw new Error(`Failed to search buyers: ${error.message}`)

  return {
    buyers: data.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email ?? null,
      phone: row.phone ?? null,
      roles: (Array.isArray(row.role_states) ? row.role_states : []).flatMap((role: { label?: string }) => (role.label ? [role.label] : [])),
    })),
    page,
    pageSize,
    total: count ?? 0,
  }
}
