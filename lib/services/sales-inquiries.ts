import { COOP_AGENT_ROLE, INQUIRY_CHANNEL_LABELS } from "@/lib/sales/activity"
import { incrementCommunityTraffic } from "@/lib/services/community-traffic"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
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

  // Traffic is a sales-manager number, so a user who may create leads but not
  // manage sales (an OSC taking web inquiries) simply does not move the tally.
  if (parsed.communityId && (await hasPermission("sales.manage", context))) {
    await incrementCommunityTraffic(
      {
        communityId: parsed.communityId,
        loggedDate: parsed.loggedDate,
        walkIns: parsed.channel === "walk_in" ? 1 : 0,
        appointments: parsed.channel === "appointment" ? 1 : 0,
        webInquiries: parsed.channel === "web" ? 1 : 0,
      },
      context.orgId,
    )
  }

  return prospect
}
