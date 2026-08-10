"use client"

import { MoreHorizontal } from "lucide-react"

import { TradeBadge } from "@/components/companies/trade-badge"
import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { VendorPayableProfile } from "@/lib/services/companies"
import { cn } from "@/lib/utils"
import { VendorPaymentInviteButton } from "./vendor-payment-invite"

/** What this org can do with this vendor's money today, said plainly. */
const READINESS: Record<
  VendorPayableProfile["paymentReadiness"],
  { label: string; tone: string }
> = {
  ready: { label: "Ready for Arc Pay", tone: "bg-success" },
  verifying: { label: "Arc Pay setup in progress", tone: "bg-warning" },
  invited: { label: "Invited to set up payments", tone: "bg-warning" },
  not_started: { label: "Not set up for Arc Pay", tone: "bg-muted-foreground/40" },
  suspended: { label: "Payments paused", tone: "bg-warning" },
  revoked: { label: "Payments revoked", tone: "bg-destructive" },
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 truncate text-sm font-medium tabular-nums",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * The vendor as a standing relationship rather than a value in a picker.
 *
 * Once a vendor is on the payable, the question stops being "which vendor" and
 * becomes "do I know this vendor, do we already owe them, and can we pay them" —
 * which is what an AP clerk is actually deciding when a scanned invoice arrives
 * with a vendor already matched. Changing the vendor is still one click away,
 * because the scan gets it wrong often enough that hiding the escape hatch would
 * be worse than showing a dropdown nobody uses.
 */
export function PayableVendorCard({
  name,
  profile,
  loading,
  onChangeVendor,
  onEditVendor,
  onPaymentInvited,
}: {
  name: string
  profile: VendorPayableProfile | null
  loading: boolean
  onChangeVendor: () => void
  onEditVendor: () => void
  onPaymentInvited: () => void
}) {
  const readiness = profile ? READINESS[profile.paymentReadiness] : null

  return (
    <div className="border bg-muted/20">
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-semibold">{profile?.name ?? name}</p>
            {profile?.trade ? <TradeBadge trade={profile.trade} /> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {readiness ? (
              <span className="flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", readiness.tone)} aria-hidden />
                {readiness.label}
              </span>
            ) : null}
            {profile && !["ready", "suspended", "revoked"].includes(profile.paymentReadiness) ? (
              <VendorPaymentInviteButton
                companyId={profile.companyId}
                readiness={profile.paymentReadiness}
                onInvited={onPaymentInvited}
              />
            ) : null}
            {profile?.paymentTerms ? <span>{profile.paymentTerms}</span> : null}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="-mr-1 size-8 shrink-0">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Vendor actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onChangeVendor}>Change vendor</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEditVendor}>Edit vendor details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-4 px-4 pb-3.5 pt-3" aria-label="Loading vendor history">
          <div className="h-8 animate-pulse bg-muted" />
          <div className="h-8 animate-pulse bg-muted" />
          <div className="h-8 animate-pulse bg-muted" />
        </div>
      ) : profile && profile.canViewBills ? (
        <div className="mt-3 grid grid-cols-3 gap-4 border-t px-4 py-3">
          <Stat
            label={`Paid · ${Math.round(profile.trailingDays / 30)} mo`}
            value={formatMoneyFromCents(profile.paidCents)}
            muted={profile.paidCents === 0}
          />
          <Stat
            label="Open"
            value={formatMoneyFromCents(profile.openCents)}
            muted={profile.openCents === 0}
          />
          <Stat
            label="Bills"
            value={
              profile.billCount === 0
                ? "First bill"
                : `${profile.billCount}${profile.openBillCount > 0 ? ` · ${profile.openBillCount} open` : ""}`
            }
            muted={profile.billCount === 0}
          />
        </div>
      ) : (
        <div className="mt-3 border-t px-4 py-3 text-xs text-muted-foreground">
          {profile ? "Your role cannot see this vendor’s billing history." : "No billing history with this vendor yet."}
        </div>
      )}
    </div>
  )
}
