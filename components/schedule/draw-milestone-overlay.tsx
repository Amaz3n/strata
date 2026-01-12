"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DollarSign, Calendar, CheckCircle2, Clock, AlertCircle } from "lucide-react"
import { formatAmount } from "@/components/midday/format-amount"
import type { DrawSchedule } from "@/lib/types"
import { format } from "date-fns"

interface DrawMilestoneOverlayProps {
  /** Linked draw schedules for this milestone */
  draws: DrawSchedule[]
  /** Size variant */
  size?: "sm" | "default"
  /** Additional className */
  className?: string
  /** Click handler */
  onClick?: () => void
}

export function DrawMilestoneOverlay({
  draws,
  size = "default",
  className,
  onClick,
}: DrawMilestoneOverlayProps) {
  if (!draws.length) return null

  // Calculate totals
  const totalAmount = draws.reduce((sum, d) => sum + (d.amount_cents ?? 0), 0)
  const approvedAmount = draws
    .filter((d) => d.status === "approved" || d.status === "paid")
    .reduce((sum, d) => sum + (d.amount_cents ?? 0), 0)
  const pendingAmount = draws
    .filter((d) => d.status === "scheduled" || d.status === "pending")
    .reduce((sum, d) => sum + (d.amount_cents ?? 0), 0)

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "paid":
        return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
      case "approved":
        return <CheckCircle2 className="h-3 w-3 text-blue-500" />
      case "pending":
        return <Clock className="h-3 w-3 text-amber-500" />
      case "scheduled":
        return <Calendar className="h-3 w-3 text-slate-500" />
      case "rejected":
        return <AlertCircle className="h-3 w-3 text-red-500" />
      default:
        return <DollarSign className="h-3 w-3 text-slate-500" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "paid":
        return "text-emerald-600 dark:text-emerald-400"
      case "approved":
        return "text-blue-600 dark:text-blue-400"
      case "pending":
        return "text-amber-600 dark:text-amber-400"
      case "rejected":
        return "text-red-600 dark:text-red-400"
      default:
        return "text-slate-600 dark:text-slate-400"
    }
  }

  const badgeContent = (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 cursor-pointer transition-all hover:scale-105",
        "bg-emerald-50 text-emerald-800 border-emerald-300",
        "dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
        size === "sm" && "text-[10px] px-1.5 py-0.5",
        className
      )}
      onClick={onClick}
    >
      <DollarSign className={cn("shrink-0", size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      <span className="font-medium">
        {formatAmount({ amount: totalAmount / 100, currency: "USD", minimumFractionDigits: 0 })}
      </span>
      {draws.length > 1 && (
        <span className="text-[10px] opacity-75">({draws.length} draws)</span>
      )}
    </Badge>
  )

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <div className="space-y-2">
            <div className="font-medium text-sm">Linked Draw Schedules</div>
            <div className="space-y-1.5">
              {draws.map((draw) => (
                <div
                  key={draw.id}
                  className="flex items-center justify-between gap-4 text-xs"
                >
                  <div className="flex items-center gap-1.5">
                    {getStatusIcon(draw.status ?? "scheduled")}
                    <span>Draw #{draw.draw_number}</span>
                    {draw.scheduled_date && (
                      <span className="text-muted-foreground">
                        ({format(new Date(draw.scheduled_date), "MMM d")})
                      </span>
                    )}
                  </div>
                  <span className={cn("font-medium", getStatusColor(draw.status ?? "scheduled"))}>
                    {formatAmount({
                      amount: (draw.amount_cents ?? 0) / 100,
                      currency: "USD",
                      minimumFractionDigits: 0,
                    })}
                  </span>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-muted-foreground border-t pt-1.5 mt-1.5 space-y-0.5">
              {pendingAmount > 0 && (
                <div className="flex justify-between">
                  <span>Pending/Scheduled:</span>
                  <span className="text-amber-600 dark:text-amber-400">
                    {formatAmount({
                      amount: pendingAmount / 100,
                      currency: "USD",
                      minimumFractionDigits: 0,
                    })}
                  </span>
                </div>
              )}
              {approvedAmount > 0 && (
                <div className="flex justify-between">
                  <span>Approved/Paid:</span>
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {formatAmount({
                      amount: approvedAmount / 100,
                      currency: "USD",
                      minimumFractionDigits: 0,
                    })}
                  </span>
                </div>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Compact version for use in Gantt milestone markers
 */
export function DrawAmountIndicator({
  amountCents,
  status,
  className,
}: {
  amountCents: number
  status?: string
  className?: string
}) {
  if (!amountCents) return null

  const isPaid = status === "paid"
  const isApproved = status === "approved"

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded",
        isPaid || isApproved
          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
          : "bg-slate-500/20 text-slate-700 dark:text-slate-300",
        className
      )}
    >
      <DollarSign className="h-2.5 w-2.5" />
      {formatAmount({
        amount: amountCents / 100,
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}
    </span>
  )
}
