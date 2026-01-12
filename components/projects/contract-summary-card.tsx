import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Contract } from "@/lib/types"
import { format } from "date-fns"

interface ContractSummaryCardProps {
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  onView?: () => void
  compact?: boolean
}

export function ContractSummaryCard({ contract, approvedChangeOrdersTotalCents, onView, compact = false }: ContractSummaryCardProps) {
  if (!contract) {
    return (
      <Card className="border-dashed">
        <CardHeader className={compact ? "pb-3" : ""}>
          <CardTitle className={compact ? "text-sm font-semibold" : "text-base"}>Contract</CardTitle>
        </CardHeader>
        <CardContent className={compact ? "pt-0 space-y-2" : "space-y-3"}>
          <p className={compact ? "text-xs sm:text-sm text-muted-foreground" : "text-sm text-muted-foreground"}>No contract on file yet.</p>
          <Button variant="outline" disabled className={compact ? "text-xs h-7" : ""}>
            View contract
          </Button>
        </CardContent>
      </Card>
    )
  }

  const approvedChanges = approvedChangeOrdersTotalCents ?? 0
  const contractTotal = typeof contract.total_cents === "number" ? contract.total_cents : undefined
  const revisedTotal = typeof contractTotal === "number" ? contractTotal + approvedChanges : undefined

  return (
    <Card>
      <CardHeader className={`flex flex-row items-start justify-between space-y-0 ${compact ? "pb-3" : ""}`}>
        <div className={compact ? "space-y-0.5" : "space-y-1"}>
          <CardTitle className={compact ? "text-sm font-semibold" : "text-base"}>Contract</CardTitle>
          <div className={compact ? "text-xs sm:text-sm text-muted-foreground" : "text-sm text-muted-foreground"}>{contract.title || "Untitled Contract"}</div>
        </div>
        <Badge variant="secondary" className={`capitalize ${compact ? "text-[10px] px-1.5 py-0" : ""}`}>
          {contract.status ? contract.status.replace("_", " ") : "Unknown"}
        </Badge>
      </CardHeader>
      <CardContent className={compact ? "pt-0 space-y-2" : "space-y-3"}>
        <div className={`grid grid-cols-2 ${compact ? "gap-2 sm:gap-3 text-xs sm:text-sm" : "gap-3 text-sm"}`}>
          <InfoItem label="Type" value={contract.contract_type ? contract.contract_type.replace("_", " ") : "—"} compact={compact} />
          <InfoItem
            label="Value"
            value={
              typeof contractTotal === "number" && contract.currency
                ? new Intl.NumberFormat("en-US", { style: "currency", currency: contract.currency }).format(
                    contractTotal / 100,
                  )
                : "—"
            }
            compact={compact}
          />
          <InfoItem
            label="Approved changes"
            value={contract.currency ? new Intl.NumberFormat("en-US", { style: "currency", currency: contract.currency }).format(
              approvedChanges / 100,
            ) : "—"}
            compact={compact}
          />
          <InfoItem
            label="Revised total"
            value={
              typeof revisedTotal === "number" && contract.currency
                ? new Intl.NumberFormat("en-US", { style: "currency", currency: contract.currency }).format(
                    revisedTotal / 100,
                  )
                : "—"
            }
            compact={compact}
          />
          <InfoItem label="Markup" value={contract.markup_percent ? `${contract.markup_percent}%` : "—"} compact={compact} />
          <InfoItem
            label="Retainage"
            value={
              contract.retainage_percent
                ? `${contract.retainage_percent}%${contract.retainage_release_trigger ? ` • ${contract.retainage_release_trigger}` : ""}`
                : "—"
            }
            compact={compact}
          />
          <InfoItem
            label="Effective"
            value={contract.effective_date ? format(new Date(contract.effective_date), "MMM d, yyyy") : "—"}
            compact={compact}
          />
          <InfoItem label="Signed" value={contract.signed_at ? format(new Date(contract.signed_at), "MMM d, yyyy") : "—"} compact={compact} />
        </div>
        {onView && (
          <Button variant="outline" onClick={onView} className={compact ? "text-xs h-7" : ""}>
            View contract
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function InfoItem({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <div className={compact ? "text-[10px] sm:text-xs uppercase tracking-wide text-muted-foreground" : "text-xs uppercase tracking-wide text-muted-foreground"}>{label}</div>
      <div className={`font-medium text-foreground ${compact ? "text-xs sm:text-sm" : ""}`}>{value}</div>
    </div>
  )
}
