"use client"

import { useMemo } from "react"
import type { ComplianceRules } from "@/lib/types"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { ProjectPayablesClient } from "@/components/payables/project-payables-client"
import { Card, CardContent } from "@/components/ui/card"

interface PayablesTabProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  complianceRules: ComplianceRules
}

export function PayablesTab({
  projectId,
  vendorBills,
  complianceRules,
}: PayablesTabProps) {
  // Calculate summary stats
  const stats = useMemo(() => {
    const total = vendorBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const paid = vendorBills.reduce((sum, b) => sum + (b.paid_cents ?? (b.status === "paid" ? b.total_cents ?? 0 : 0)), 0)
    const pending = vendorBills.filter((b) => b.status === "pending").reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const approved = vendorBills.filter((b) => b.status === "approved").reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const outstanding = Math.max(0, total - paid)
    const billCount = vendorBills.length
    const pendingCount = vendorBills.filter((b) => b.status === "pending").length

    return {
      total,
      paid,
      pending,
      approved,
      outstanding,
      billCount,
      pendingCount,
    }
  }, [vendorBills])

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Payables" value={formatCurrency(stats.total)} subtext={`${stats.billCount} bills`} />
        <SummaryCard label="Paid" value={formatCurrency(stats.paid)} variant="success" />
        <SummaryCard
          label="Outstanding"
          value={formatCurrency(stats.outstanding)}
          subtext={stats.pendingCount > 0 ? `${stats.pendingCount} pending approval` : undefined}
          variant={stats.pendingCount > 0 ? "warning" : "default"}
        />
        <SummaryCard label="Approved (Ready to Pay)" value={formatCurrency(stats.approved)} />
      </div>

      {/* Main Payables Table */}
      <ProjectPayablesClient
        projectId={projectId}
        vendorBills={vendorBills}
        complianceRules={complianceRules}
      />
    </div>
  )
}

function SummaryCard({
  label,
  value,
  subtext,
  variant = "default",
}: {
  label: string
  value: string
  subtext?: string
  variant?: "default" | "success" | "warning" | "destructive"
}) {
  const variantStyles = {
    default: "",
    success: "border-success/30 bg-success/5",
    warning: "border-warning/30 bg-warning/5",
    destructive: "border-destructive/30 bg-destructive/5",
  }

  const textStyles = {
    default: "",
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
  }

  return (
    <Card className={variantStyles[variant]}>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold ${textStyles[variant]}`}>{value}</p>
        {subtext && <p className="text-xs text-muted-foreground mt-1">{subtext}</p>}
      </CardContent>
    </Card>
  )
}

function formatCurrency(cents?: number) {
  if (typeof cents !== "number") return "$0"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}
