import { COOP_AGENT_ROLE, INQUIRY_CHANNEL_LABELS } from "@/lib/sales/activity"
import { requireOrgContext } from "@/lib/services/context"
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

  const email = parsed.email?.trim() || null
  const prospect = await createProspect({
    input: {
      name: parsed.buyerName,
      status: "new",
      owner_user_id: parsed.ownerUserId ?? null,
      community_id: parsed.communityId ?? null,
      source: parsed.source?.trim() || INQUIRY_CHANNEL_LABELS[parsed.channel],
      project_type: parsed.planInterest?.trim() || null,
      budget_range: parsed.priceRange?.trim() || null,
      timeline_preference: parsed.timeframe?.trim() || null,
      notes: parsed.notes?.trim() || null,
      primary_contact: {
        full_name: parsed.buyerName,
        phone: parsed.phone?.trim() || null,
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
