import { COOP_AGENT_ROLE, INQUIRY_CHANNEL_LABELS } from "@/lib/sales/activity"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createProspect, createProspectContact, type Prospect } from "@/lib/services/prospects"
import { productionInquiryInputSchema, type ProductionInquiryInput } from "@/lib/validation/prospects"

/**
 * Registering a buyer at the model home. One entry, two records: the deal the
 * consultant will work, and the day's traffic count the sales manager reads on
 * Monday. Traffic used to be logged separately on the community workbench, which
 * meant it was never logged at all.
 */
export async function registerProductionInquiry(
  input: ProductionInquiryInput,
  orgId?: string,
): Promise<Prospect> {
  const parsed = productionInquiryInputSchema.parse(input)
  const context = await requireOrgContext(orgId)

  // A buyer picked from the search is attached as they are on file, not retyped:
  // the directory's name, phone and email win over whatever the form carries.
  const existing = parsed.existingContactId ? await loadExistingBuyer(context, parsed.existingContactId) : null
  const buyerName = existing?.full_name ?? parsed.buyerName
  const email = existing ? existing.email : parsed.email?.trim() || null
  const prospect = await createProspect({
    input: {
      name: buyerName,
      status: "new",
      owner_user_id: parsed.ownerUserId ?? null,
      community_id: parsed.communityId ?? null,
      source: parsed.source?.trim() || INQUIRY_CHANNEL_LABELS[parsed.channel],
      project_type: parsed.planInterest?.trim() || null,
      budget_range: parsed.priceRange?.trim() || null,
      timeline_preference: parsed.timeframe?.trim() || null,
      notes: parsed.notes?.trim() || null,
      primary_contact: {
        contact_id: existing?.id ?? null,
        full_name: buyerName,
        phone: existing ? existing.phone : parsed.phone?.trim() || null,
        email,
        is_primary: true,
      },
    },
    orgId: context.orgId,
    // The lead is the traffic: createProspect counts it once, on the visit
    // date, in the channel the consultant picked. A phone call is not footfall.
    traffic:
      parsed.channel === "phone"
        ? null
        : { source: INQUIRY_CHANNEL_LABELS[parsed.channel], occurredOn: parsed.loggedDate },
  })

  const coopName = parsed.coopAgentName?.trim()
  if (coopName) {
    await createProspectContact({
      prospectId: prospect.id,
      input: {
        full_name: coopName,
        company_name: parsed.coopBrokerage?.trim() || null,
        role: COOP_AGENT_ROLE,
        is_primary: false,
      },
      orgId: context.orgId,
    })
  }

  return prospect
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
  const term = input.search.replace(/[\\%_,()"]/g, " ").replace(/\s+/g, " ").trim()

  const from = (page - 1) * pageSize
  let query = context.supabase
    .from("directory_entries")
    .select("id, name, email, phone, role_states", { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("kind", "contact")
    .is("archived_at", null)
  if (term) query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
  const { data, error, count } = await query.order("name").order("id").range(from, from + pageSize - 1)
  if (error) throw new Error(`Failed to search buyers: ${error.message}`)

  return {
    buyers: (data ?? []).map((row) => ({
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
