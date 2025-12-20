"use client"

import Link from "next/link"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus } from "lucide-react"
import type { SubPortalCommitment } from "@/lib/types"

interface SubContractsCardProps {
  commitment: SubPortalCommitment
  token: string
  canSubmitInvoice?: boolean
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function SubContractsCard({
  commitment,
  token,
  canSubmitInvoice = true,
}: SubContractsCardProps) {
  const billedPercent =
    commitment.total_cents > 0
      ? Math.round((commitment.billed_cents / commitment.total_cents) * 100)
      : 0

  const statusColors: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    approved: "bg-success/20 text-success border-success/30",
    complete: "bg-primary/20 text-primary border-primary/30",
    canceled: "bg-destructive/20 text-destructive border-destructive/30",
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{commitment.title}</p>
          <Badge
            variant="outline"
            className={`text-xs capitalize mt-1 ${statusColors[commitment.status] ?? ""}`}
          >
            {commitment.status}
          </Badge>
        </div>
        <p className="text-lg font-semibold shrink-0">
          {formatCurrency(commitment.total_cents)}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Billed</span>
          <span className="font-medium">
            {formatCurrency(commitment.billed_cents)} ({billedPercent}%)
          </span>
        </div>
        <Progress value={billedPercent} className="h-2" />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Remaining</span>
          <span className="font-medium text-primary">
            {formatCurrency(commitment.remaining_cents)}
          </span>
        </div>
      </div>

      {canSubmitInvoice &&
        commitment.status === "approved" &&
        commitment.remaining_cents > 0 && (
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link href={`/s/${token}/submit-invoice?commitment=${commitment.id}`}>
              <Plus className="h-4 w-4 mr-1" />
              Submit Invoice
            </Link>
          </Button>
        )}
    </div>
  )
}
