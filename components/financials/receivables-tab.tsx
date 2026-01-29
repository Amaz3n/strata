"use client"

import { useMemo } from "react"
import type { Contact, CostCode, Contract, DrawSchedule, Invoice, Project, Retainage } from "@/lib/types"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Receipt, Calendar, Percent } from "lucide-react"
import { useState } from "react"

interface ReceivablesTabProps {
  projectId: string
  project: Project
  invoices: Invoice[]
  draws: DrawSchedule[]
  retainage: Retainage[]
  contacts?: Contact[]
  costCodes?: CostCode[]
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  scheduleItems?: any[]
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
}

export function ReceivablesTab({
  projectId,
  project,
  invoices,
  draws,
  retainage,
  contacts,
  costCodes,
  contract,
  approvedChangeOrdersTotalCents,
  scheduleItems,
  builderInfo,
}: ReceivablesTabProps) {
  const [subTab, setSubTab] = useState<"invoices" | "draws" | "retainage">("invoices")
  const safeRetainage = useMemo(() => (Array.isArray(retainage) ? retainage : []), [retainage])
  const safeInvoices = useMemo(() => (Array.isArray(invoices) ? invoices : []), [invoices])

  // Calculate summary stats
  const stats = useMemo(() => {
    const totalInvoiced = safeInvoices.reduce((sum, inv) => sum + (inv.total_cents ?? inv.totals?.total_cents ?? 0), 0)
    const paidInvoices = safeInvoices.filter((inv) => inv.status === "paid")
    const totalPaid = paidInvoices.reduce((sum, inv) => sum + (inv.total_cents ?? inv.totals?.total_cents ?? 0), 0)
    const overdueInvoices = safeInvoices.filter((inv) => inv.status === "overdue")
    const totalOverdue = overdueInvoices.reduce((sum, inv) => sum + (inv.total_cents ?? inv.totals?.total_cents ?? 0), 0)
    const outstanding = totalInvoiced - totalPaid

    const totalRetainageHeld = safeRetainage.reduce((sum, r) => sum + (r.status === "held" ? r.amount_cents : 0), 0)

    return {
      totalInvoiced,
      totalPaid,
      totalOverdue,
      outstanding,
      invoiceCount: safeInvoices.length,
      overdueCount: overdueInvoices.length,
      totalRetainageHeld,
    }
  }, [safeInvoices, safeRetainage])

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Invoiced" value={formatCurrency(stats.totalInvoiced)} subtext={`${stats.invoiceCount} invoices`} />
        <SummaryCard label="Collected" value={formatCurrency(stats.totalPaid)} variant="success" />
        <SummaryCard
          label="Outstanding"
          value={formatCurrency(stats.outstanding)}
          subtext={stats.overdueCount > 0 ? `${stats.overdueCount} overdue` : undefined}
          variant={stats.overdueCount > 0 ? "warning" : "default"}
        />
        <SummaryCard label="Retainage Held" value={formatCurrency(stats.totalRetainageHeld)} />
      </div>

      {/* Sub-tabs */}
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "invoices" | "draws" | "retainage")}>
        <TabsList className="grid w-full max-w-lg grid-cols-3">
          <TabsTrigger value="invoices" className="gap-2">
            <Receipt className="h-4 w-4" />
            Invoices
          </TabsTrigger>
          <TabsTrigger value="draws" className="gap-2">
            <Calendar className="h-4 w-4" />
            Draw Schedule
          </TabsTrigger>
          <TabsTrigger value="retainage" className="gap-2">
            <Percent className="h-4 w-4" />
            Retainage
          </TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="mt-4">
          <InvoicesClient
            invoices={invoices}
            projects={[project]}
            builderInfo={builderInfo}
            contacts={contacts}
            costCodes={costCodes}
          />
        </TabsContent>

        <TabsContent value="draws" className="mt-4">
          <DrawScheduleManager
            projectId={projectId}
            initialDraws={draws}
            contract={contract}
            approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
            scheduleItems={scheduleItems}
          />
        </TabsContent>

        <TabsContent value="retainage" className="mt-4">
          <RetainageTracker retainage={safeRetainage} />
        </TabsContent>
      </Tabs>
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
