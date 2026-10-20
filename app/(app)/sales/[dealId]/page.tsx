import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { notFound } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { BAND_X } from "@/components/overview/primitives"
import { AgreementCommissionSigningHold } from "@/components/sales/agreement-commission-plan"
import { AgreementSigningRecovery } from "@/components/sales/agreement-signing-recovery"
import { DealActionsMenu } from "@/components/sales/deal-actions-menu"
import { DealPrimaryAction } from "@/components/sales/deal-primary-action"
import { DealStageTrack } from "@/components/sales/deal-stage-track"
import { PurchaseAgreementRecord, PurchaseAgreementRecordSkeleton } from "@/components/sales/purchase-agreement-record"
import type { HoldBuyer } from "@/components/sales/lot-hold-form"
import type { ReserveLotTarget } from "@/components/sales/reserve-lot-dialog"
import {
  DealOverviewHeader,
  DealOverviewHistory,
  DealOverviewMeta,
  type DealElsewhereLink,
} from "@/components/sales/overview"
import { COOP_AGENT_ROLE, describeActivity } from "@/lib/sales/activity"
import { dealAttentionItems } from "@/lib/sales/deal-attention"
import { formatLostReason } from "@/lib/sales/lost-reasons"
import { resolveDealPrimaryAction } from "@/lib/sales/primary-action"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { getSalesDealDetail } from "@/lib/services/sales-deals"
import { listTeamMembers } from "@/lib/services/team"
import { cn } from "@/lib/utils"


/** Matches the cap `getSalesDealDetail` passes to the activity query. */
const ACTIVITY_CAP = 60

/**
 * The buyer's whole file, and the place the consultant works it. Everything a
 * deal owns is writable here — the touch log, the follow-up, the contact, the
 * outcome. Everything another desk owns (closings, selections, pricing) stays a
 * link, because one home per mutation is what keeps the numbers trustworthy.
 *
 * Opens the way a home file opens: a header, the stage spine, then two panes. The
 * log runs down the left and everything true about the deal down the right, so the
 * eye has one place to go for "what happened" and one for "what is" — and neither
 * moves depending on how much the other has to say. Each pane carries its own
 * control: the log has Log activity, the attention list has the follow-up.
 */
async function DealDetailPageContent({ params }: { params: Promise<{ dealId: string }> }) {
  await connection()
  await guardWorkspaceDesk("sales")
  const { dealId } = await params
  const [detail, ambient, teamMembers] = await Promise.all([
    getSalesDealDetail(decodeURIComponent(dealId)),
    getAmbientDeskContext(),
    listTeamMembers(undefined, { includeProjectCounts: false }),
  ])
  if (!detail) notFound()

  const { deal, reservation, pricing, activity, prospect, signing, capabilities } = detail
  const primary = resolveDealPrimaryAction(deal,signing)
  const contacts = prospect?.contacts ?? []
  const buyerContact = prospect?.primary_contact ?? contacts[0] ?? null
  const lostReason = formatLostReason(prospect?.lost_reason ?? null)
  const teamOptions = teamMembers.map((member) => ({ id: member.user.id, name: member.user.full_name }))
  const communityOptions = ambient.communities.map(({ id, name }) => ({ id, name }))
  const ownerName = teamOptions.find((member) => member.id === prospect?.owner_user_id)?.name ?? null
  const coopContact = contacts.find((contact) => !contact.is_primary && contact.role === COOP_AGENT_ROLE) ?? null

  // The three lifecycle transitions Sales owns all act on the live reservation,
  // so they share one target rather than each rediscovering it.
  const reserveTarget: ReserveLotTarget | null = reservation
    ? {
        reservationId: reservation.id,
        conversionScope: { ...detail.viewer, reservationId: reservation.id },
        lotLabel: deal.lotLabel,
        depositRequiredCents: reservation.depositRequiredCents,
        hasProject: Boolean(deal.projectId),
      }
    : null
  const agreement =
    deal.contractId && (deal.contractStatus === "draft" || deal.contractStatus === "active")
      ? { contractId: deal.contractId, hasDeposit: Boolean(reservation?.depositInvoiceId) }
      : null
  const holdBuyer: HoldBuyer | null = prospect
    ? {
        prospectId: prospect.id,
        name: deal.buyerName,
        communityId: prospect.community_id ?? null,
        hasContact: Boolean(buyerContact),
      }
    : null

  const lastTouch = activity.find((event) => describeActivity(event).logged) ?? null
  const hasContactDetails = Boolean(
    deal.buyerPhone ||
      deal.buyerEmail ||
      contacts.some((contact) => contact.phone || contact.email),
  )
  const attention = dealAttentionItems({
    signing,
    deal,
    reservation,
    hasContactDetails,
    ownerAssigned: Boolean(prospect?.owner_user_id),
    lastTouchAt: lastTouch?.created_at ?? null,
  })

  const links: DealElsewhereLink[] = [
    deal.projectId ? { label: "Home file", href: `/projects/${deal.projectId}` } : null,
    deal.projectId
      ? { label: "Design Studio selections", href: `/design-studio?project=${deal.projectId}` }
      : null,
    deal.communityId
      ? { label: "Community pricing & incentives", href: `/communities/${deal.communityId}/offering` }
      : null,
  ].filter((link): link is DealElsewhereLink => link !== null)

  return (
    <PageLayout
      title={deal.buyerName}
      breadcrumbs={[{ label: "Sales", href: "/sales" }, { label: deal.buyerName }]}
      fullBleed
    >
      <div className="flex min-h-full flex-col">
        <DealOverviewHeader
          deal={deal}
          hint={primary.hint}
          actions={
            <>
              {prospect ? (
                <DealActionsMenu
                  key={`actions:${deal.dealId}:${detail.viewer.orgId}:${detail.viewer.actorId}`}
                  deal={{
                    prospectId: prospect.id,
                    fullName: deal.buyerName,
                    phone: deal.buyerPhone,
                    email: deal.buyerEmail,
                    ownerUserId: prospect.owner_user_id ?? null,
                    communityId: prospect.community_id ?? null,
                    source: prospect.source ?? null,
                    planInterest: prospect.project_type ?? null,
                    priceRange: prospect.budget_range ?? null,
                    timeframe: prospect.timeline_preference ?? null,
                    coopAgentName: coopContact?.full_name ?? null,
                    coopBrokerage: coopContact?.company_name ?? null,
                    notes: prospect.notes ?? null,
                    communityLocked: Boolean(deal.lotId),
                  }}
                  teamMembers={teamOptions}
                  communities={communityOptions}
                  canEditProspect={capabilities.canEditProspect}
                  canManageSale={capabilities.canManageSale}
                  isLost={deal.stage === "lost"}
                  isClosed={deal.stage === "closed"}
                  isDeletable={!deal.projectId && !deal.reservationId && !deal.contractId}
                  reservation={
                    reservation
                      ? {
                          id: reservation.id,
                          lotLabel: deal.lotLabel,
                          hasDeposit: Boolean(reservation.depositInvoiceId),
                        }
                      : null
                  }
                  agreement={agreement}
                />
              ) : null}
              <DealPrimaryAction
                key={`primary:${deal.dealId}:${detail.viewer.orgId}:${detail.viewer.actorId}`}
                deal={deal}
                buyer={holdBuyer}
                communities={communityOptions}
                reserveTarget={reserveTarget}
                canManageSale={capabilities.canManageSale}
              />
            </>
          }
        />

        {signing && deal.contractId && deal.projectId && deal.contractStatus === "draft" ? <AgreementSigningRecovery contractId={deal.contractId} projectId={deal.projectId} state={signing} /> : null}

        {agreement && deal.projectId ? (
          <section className={cn(BAND_X, "border-b py-4")} aria-label="Commissions">
            <p className="mb-3 text-sm font-medium">Commissions</p>
            <AgreementCommissionSigningHold contractId={agreement.contractId} projectId={deal.projectId} />
          </section>
        ) : null}

        {deal.contractId ? (
          <Suspense fallback={<PurchaseAgreementRecordSkeleton />}>
            <PurchaseAgreementRecord contractId={deal.contractId} canManageSale={capabilities.canManageSale} />
          </Suspense>
        ) : null}

        {deal.stage === "lost" ? (
          <p
            className={cn(
              BAND_X,
              "border-b border-l-2 border-l-destructive bg-destructive/5 py-2.5 text-[13px] text-destructive",
            )}
          >
            Lost{lostReason ? ` — ${lostReason}` : " — no reason recorded"}
          </p>
        ) : (
          <DealStageTrack stage={deal.stage} stageRank={deal.stageRank} />
        )}

        {/* Stretches only where the two columns exist, so the rule between them
            runs the full page. Stacked on phones, each pane sizes to content. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:flex-1">
          <DealOverviewHistory
            key={`history:${deal.dealId}:${detail.viewer.orgId}:${detail.viewer.actorId}`}
            canLog={capabilities.canEditProspect && prospect?.status !== "lost" && prospect?.status !== "won"}
            activity={activity}
            truncated={activity.length >= ACTIVITY_CAP}
            prospectId={prospect?.id ?? null}
            buyerName={deal.buyerName}
          />
          <DealOverviewMeta
            key={`meta:${deal.dealId}:${detail.viewer.orgId}:${detail.viewer.actorId}`}
            canEditProspect={capabilities.canEditProspect && prospect?.status !== "lost" && prospect?.status !== "won"}
            deal={deal}
            reservation={reservation}
            pricing={pricing}
            prospect={prospect}
            ownerName={ownerName}
            contacts={contacts}
            attention={attention}
            links={links}
            attribution={detail.attribution}
          />
        </div>
      </div>
    </PageLayout>
  )
}

export default function DealDetailPage(props: Parameters<typeof DealDetailPageContent>[0]) {
  return (
    <Suspense fallback={
      <PageLayout title="Sales deal" breadcrumbs={[{ label: "Sales", href: "/sales" }, { label: "Sales deal" }]} fullBleed>
        <PageLoadingSkeleton />
      </PageLayout>
    }>
      <DealDetailPageContent {...props} />
    </Suspense>
  )
}
