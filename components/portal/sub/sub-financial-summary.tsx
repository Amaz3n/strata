"use client"

import { DollarSign, Clock, CheckCircle, Wallet } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { SubPortalFinancialSummary } from "@/lib/types"

interface SubFinancialSummaryProps {
  summary: SubPortalFinancialSummary
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function SubFinancialSummary({ summary }: SubFinancialSummaryProps) {
  const cards = [
    {
      label: "Contracted",
      value: summary.total_committed,
      icon: Wallet,
      color: "text-foreground",
    },
    {
      label: "Remaining",
      value: summary.total_remaining,
      icon: DollarSign,
      color: "text-primary",
    },
    {
      label: "Pending",
      value: summary.pending_approval,
      icon: Clock,
      color: "text-warning",
      subLabel: "Awaiting approval",
    },
    {
      label: "Paid",
      value: summary.total_paid,
      icon: CheckCircle,
      color: "text-success",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <card.icon className={`h-4 w-4 ${card.color}`} />
              <span className="text-xs text-muted-foreground">{card.label}</span>
            </div>
            <p className={`text-lg font-semibold ${card.color}`}>
              {formatCurrency(card.value)}
            </p>
            {card.subLabel && (
              <p className="text-xs text-muted-foreground">{card.subLabel}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
