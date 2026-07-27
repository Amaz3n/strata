import Link from "next/link"

import { ArrowUpRight } from "@/components/icons"
import { BAND_X } from "@/components/overview/primitives"
import { DealPeople } from "@/components/sales/deal-people"
import { DealAttentionBlock } from "@/components/sales/overview/deal-overview-attention"
import { Fact, MetaBlock, Note } from "@/components/sales/overview/meta-block"
import type { PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import { formatDealDate } from "@/lib/sales/dates"
import type { DealAttentionItem } from "@/lib/sales/deal-attention"
import { daysUntil } from "@/lib/sales/next-action"
import { STAGE_LABELS } from "@/lib/sales/stages"
import type { Prospect, ProspectContact } from "@/lib/services/prospects"
import type { SalesDeal, SalesDealReservation } from "@/lib/services/sales-deals"
import { cn, formatMoneyCents } from "@/lib/utils"

export interface DealElsewhereLink {
  label: string
  href: string
}

interface DealOverviewMetaProps {
  deal: SalesDeal
  reservation: SalesDealReservation | null
  pricing: PurchaseAgreementPricing | null
  prospect: Prospect | null
  ownerName: string | null
  contacts: ProspectContact[]
  attention: DealAttentionItem[]
  links: DealElsewhereLink[]
}

/** `partially_refunded` → `Partially refunded`. Raw enum values read as a bug. */
function humanizeStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase())
}

/** "in 34 days" / "12 days late" — a date alone never says whether to worry. */
function relativeSuffix(value: string, now: Date): string {
  const days = daysUntil(value, now)
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "1 day late"
  if (days < 0) return `${Math.abs(days)} days late`
  return `in ${days} days`
}

/**
 * Everything true about this deal, in the order a consultant asks it: what needs
 * doing, which home, what it costs, what was agreed, where the lead came from,
 * who to call, and where the rest of the work lives.
 *
 * The right-hand column of the file. The log on the left says what happened; this
 * says what is. Nothing here mutates — correcting a contact or a price is another
 * desk's job or the actions menu's, which is what keeps the numbers trustworthy.
 */
export function DealOverviewMeta({
  deal,
  reservation,
  pricing,
  prospect,
  ownerName,
  contacts,
  attention,
  links,
}: DealOverviewMetaProps) {
  const now = new Date()
  const holdExpiresAt = reservation?.expiresAt ?? deal.holdExpiresAt
  const hasHome = Boolean(deal.communityName || deal.lotLabel || deal.planName)
  const size = [
    deal.planBeds ? `${deal.planBeds} bd` : null,
    deal.planBaths ? `${deal.planBaths} ba` : null,
    deal.planSqft ? `${deal.planSqft.toLocaleString()} sq ft` : null,
  ].filter(Boolean)
  const daysOpen = Math.max(0, -daysUntil(deal.createdAt, now))
  const hasTerms = Boolean(
    reservation ||
      holdExpiresAt ||
      deal.contractSignedAt ||
      deal.closingScheduledDate ||
      deal.closingActualDate,
  )
  const optionsCents = pricing
    ? pricing.structuralOptionsCents + pricing.designSelectionsCents
    : 0

  return (
    <section className={cn(BAND_X, "space-y-9 py-10")}>
      <DealAttentionBlock
        items={attention}
        prospectId={prospect?.id ?? null}
        followUpAt={deal.nextFollowUpAt}
      />

      <MetaBlock title="Home">
        {hasHome ? (
          <>
            <Fact label="Community" value={deal.communityName ?? "—"} muted={!deal.communityName} />
            <Fact
              label="Lot"
              value={deal.lotLabel ? `Lot ${deal.lotLabel}` : "—"}
              muted={!deal.lotLabel}
            />
            <Fact label="Plan" value={deal.planName ?? "—"} muted={!deal.planName} />
            {size.length > 0 ? <Fact label="Size" value={size.join(" · ")} /> : null}
          </>
        ) : (
          <Note>No home selected yet — match this buyer to a lot and plan to price the deal.</Note>
        )}
      </MetaBlock>

      <MetaBlock title="Price">
        {pricing ? (
          <>
            <Fact label="Base price" value={formatMoneyCents(pricing.basePriceCents)} />
            <Fact label="Lot premium" value={formatMoneyCents(pricing.lotPremiumCents)} />
            <Fact
              label="Structural options"
              value={formatMoneyCents(pricing.structuralOptionsCents)}
            />
            <Fact
              label="Design selections"
              value={formatMoneyCents(pricing.designSelectionsCents)}
            />
            {pricing.incentivesCents > 0 ? (
              <Fact
                label="Incentives"
                value={`−${formatMoneyCents(pricing.incentivesCents)}`}
                positive
              />
            ) : null}
            {/* The total is the last line in the block, the way a total is. */}
            <Fact label="Contract price" value={formatMoneyCents(pricing.totalCents)} emphasis />
            {optionsCents > 0 ? (
              <p className="pt-2 text-xs text-muted-foreground">
                {formatMoneyCents(optionsCents)} of the price is options the buyer chose.
              </p>
            ) : null}
          </>
        ) : deal.priceCents !== null ? (
          <>
            <Fact label="Asking price" value={formatMoneyCents(deal.priceCents)} emphasis />
            <p className="pt-2 text-xs text-muted-foreground">
              The full breakdown appears once the purchase agreement is written.
            </p>
          </>
        ) : (
          <Note>Not priced yet — pricing lands when this buyer is matched to a home.</Note>
        )}
      </MetaBlock>

      <MetaBlock title="Terms">
        {hasTerms ? (
          <>
            {reservation ? (
              <>
                <Fact label="Reservation" value={humanizeStatus(reservation.status)} />
                <Fact
                  label="Deposit required"
                  value={formatMoneyCents(reservation.depositRequiredCents)}
                />
                <Fact
                  label="Deposit invoiced"
                  value={reservation.depositInvoiceId ? "Yes" : "Not yet"}
                  warning={!reservation.depositInvoiceId}
                />
              </>
            ) : null}
            {holdExpiresAt ? (
              <Fact
                label="Hold expires"
                value={`${formatDealDate(holdExpiresAt)} · ${relativeSuffix(holdExpiresAt, now)}`}
              />
            ) : null}
            {deal.contractSignedAt ? (
              <Fact label="Agreement signed" value={formatDealDate(deal.contractSignedAt)} />
            ) : null}
            {deal.closingScheduledDate && !deal.closingActualDate ? (
              <Fact
                label="Closing scheduled"
                value={`${formatDealDate(deal.closingScheduledDate)} · ${relativeSuffix(
                  deal.closingScheduledDate,
                  now,
                )}`}
              />
            ) : deal.closingScheduledDate ? (
              <Fact label="Closing scheduled" value={formatDealDate(deal.closingScheduledDate)} />
            ) : null}
            {deal.closingActualDate ? (
              <Fact label="Settled" value={formatDealDate(deal.closingActualDate)} />
            ) : null}
            {deal.openGateCount > 0 ? (
              <Fact label="Closing gates open" value={String(deal.openGateCount)} warning />
            ) : null}
          </>
        ) : (
          <Note>Nothing committed yet — terms appear once a lot is held.</Note>
        )}
      </MetaBlock>

      <MetaBlock title="Lead">
        <Fact label="Stage" value={STAGE_LABELS[deal.stage]} />
        <Fact label="Source" value={deal.source ?? "—"} muted={!deal.source} />
        <Fact label="Owner" value={ownerName ?? "Unassigned"} muted={!ownerName} />
        <Fact
          label="Registered"
          value={`${formatDealDate(deal.createdAt)} · ${daysOpen}d open`}
        />
        <Fact
          label="Follow-up"
          value={deal.nextFollowUpAt ? formatDealDate(deal.nextFollowUpAt) : "None set"}
          muted={!deal.nextFollowUpAt}
        />
        {prospect?.project_type ? (
          <Fact label="Plan of interest" value={prospect.project_type} />
        ) : null}
        {prospect?.budget_range ? <Fact label="Price range" value={prospect.budget_range} /> : null}
        {prospect?.timeline_preference ? (
          <Fact label="Timeframe" value={prospect.timeline_preference} />
        ) : null}
      </MetaBlock>

      <MetaBlock title="People">
        <DealPeople
          buyerName={deal.buyerName}
          buyerPhone={deal.buyerPhone}
          buyerEmail={deal.buyerEmail}
          contacts={contacts}
        />
      </MetaBlock>

      {links.length > 0 ? (
        <MetaBlock title="Elsewhere">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group flex items-center justify-between gap-3 border-b py-2 text-sm transition-colors last:border-b-0 hover:text-primary"
            >
              <span className="truncate">{link.label}</span>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            </Link>
          ))}
        </MetaBlock>
      ) : null}
    </section>
  )
}
