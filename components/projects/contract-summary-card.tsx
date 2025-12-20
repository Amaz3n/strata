import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Contract } from "@/lib/types"
import { format } from "date-fns"

interface ContractSummaryCardProps {
  contract: Contract | null
  onView?: () => void
}

export function ContractSummaryCard({ contract, onView }: ContractSummaryCardProps) {
  if (!contract) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Contract</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">No contract on file yet.</p>
          <Button variant="outline" disabled>
            View contract
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Contract</CardTitle>
          <div className="text-sm text-muted-foreground">{contract.title}</div>
        </div>
        <Badge variant="secondary" className="capitalize">
          {contract.status.replace("_", " ")}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <InfoItem label="Type" value={contract.contract_type ? contract.contract_type.replace("_", " ") : "—"} />
          <InfoItem
            label="Value"
            value={
              typeof contract.total_cents === "number"
                ? new Intl.NumberFormat("en-US", { style: "currency", currency: contract.currency }).format(
                    contract.total_cents / 100,
                  )
                : "—"
            }
          />
          <InfoItem label="Markup" value={contract.markup_percent ? `${contract.markup_percent}%` : "—"} />
          <InfoItem
            label="Retainage"
            value={
              contract.retainage_percent
                ? `${contract.retainage_percent}%${contract.retainage_release_trigger ? ` • ${contract.retainage_release_trigger}` : ""}`
                : "—"
            }
          />
          <InfoItem
            label="Effective"
            value={contract.effective_date ? format(new Date(contract.effective_date), "MMM d, yyyy") : "—"}
          />
          <InfoItem label="Signed" value={contract.signed_at ? format(new Date(contract.signed_at), "MMM d, yyyy") : "—"} />
        </div>
        <Button variant="outline" onClick={onView} disabled={!onView}>
          View contract
        </Button>
      </CardContent>
    </Card>
  )
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  )
}
