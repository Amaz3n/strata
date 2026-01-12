"use client"

import Link from "next/link"
import { format } from "date-fns"
import { Plus, AlertCircle, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SubFinancialSummary } from "./sub-financial-summary"
import { SubContractsCard } from "./sub-contracts-card"
import type { SubPortalData } from "@/lib/types"

interface SubDashboardProps {
  data: SubPortalData
  token: string
  canSubmitInvoices?: boolean
}

export function SubDashboard({
  data,
  token,
  canSubmitInvoices = true,
}: SubDashboardProps) {
  const upcomingSchedule = data.schedule
    .filter((s) => s.status === "planned" || s.status === "in_progress")
    .slice(0, 3)

  const needsAttention = data.pendingRfiCount + data.pendingSubmittalCount
  const complianceAlerts = (() => {
    const alerts: { label: string; detail?: string }[] = []
    const insuranceExpiry = data.company.insurance_expiry ? new Date(data.company.insurance_expiry) : null
    if (!insuranceExpiry || Number.isNaN(insuranceExpiry.getTime())) {
      alerts.push({ label: "Insurance not on file" })
    } else {
      const days = Math.ceil((insuranceExpiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      if (days < 0) alerts.push({ label: "Insurance expired", detail: format(insuranceExpiry, "MMM d, yyyy") })
      else if (days <= 30) alerts.push({ label: "Insurance expiring soon", detail: format(insuranceExpiry, "MMM d, yyyy") })
    }

    if (!data.company.w9_on_file) {
      alerts.push({ label: "W-9 missing" })
    }

    const licenseExpiry = data.company.license_expiry ? new Date(data.company.license_expiry) : null
    if (licenseExpiry && !Number.isNaN(licenseExpiry.getTime())) {
      const days = Math.ceil((licenseExpiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      if (days < 0) alerts.push({ label: "License expired", detail: format(licenseExpiry, "MMM d, yyyy") })
      else if (days <= 30) alerts.push({ label: "License expiring soon", detail: format(licenseExpiry, "MMM d, yyyy") })
    }

    return alerts
  })()

  return (
    <div className="space-y-4">
      {/* Company Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{data.company.name}</h2>
          {data.company.trade && (
            <p className="text-sm text-muted-foreground">{data.company.trade}</p>
          )}
        </div>
        {canSubmitInvoices && (
          <Button asChild size="sm">
            <Link href={`/s/${token}/submit-invoice`}>
              <Plus className="h-4 w-4 mr-1" />
              Submit Invoice
            </Link>
          </Button>
        )}
      </div>

      {complianceAlerts.length > 0 && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Compliance warnings</p>
                {complianceAlerts.map((alert) => (
                  <p key={alert.label} className="text-sm text-muted-foreground">
                    {alert.label}{alert.detail ? ` · ${alert.detail}` : ""}
                  </p>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Financial Summary */}
      <SubFinancialSummary summary={data.financialSummary} />

      {/* Contracts/Commitments */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">My Contracts</CardTitle>
          {data.commitments.length > 2 && (
            <Link
              href={`/s/${token}/commitments`}
              className="text-sm text-primary flex items-center"
            >
              View all <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {data.commitments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contracts assigned yet
            </p>
          ) : (
            data.commitments
              .slice(0, 2)
              .map((commitment) => (
                <SubContractsCard
                  key={commitment.id}
                  commitment={commitment}
                  token={token}
                  canSubmitInvoice={canSubmitInvoices}
                />
              ))
          )}
        </CardContent>
      </Card>

      {/* Needs Attention */}
      {needsAttention > 0 && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Needs Your Attention</p>
                {data.pendingRfiCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.pendingRfiCount} RFI
                    {data.pendingRfiCount > 1 ? "s" : ""} awaiting response
                  </p>
                )}
                {data.pendingSubmittalCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.pendingSubmittalCount} submittal
                    {data.pendingSubmittalCount > 1 ? "s" : ""} pending
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Schedule */}
      {upcomingSchedule.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Upcoming Schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingSchedule.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div>
                  <p className="text-sm font-medium">{item.name}</p>
                  {item.start_date && (
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(item.start_date), "MMM d")}
                      {item.end_date && item.end_date !== item.start_date && (
                        <> - {format(new Date(item.end_date), "MMM d")}</>
                      )}
                    </p>
                  )}
                </div>
                <Badge
                  variant={item.status === "in_progress" ? "default" : "secondary"}
                  className="capitalize text-xs"
                >
                  {item.status.replaceAll("_", " ")}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent Bills */}
      {data.bills.length > 0 && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Invoices</CardTitle>
            <Link
              href={`/s/${token}/bills`}
              className="text-sm text-primary flex items-center"
            >
              View all <ChevronRight className="h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.bills.slice(0, 3).map((bill) => (
              <div
                key={bill.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div>
                  <p className="text-sm font-medium">{bill.bill_number}</p>
                  <p className="text-xs text-muted-foreground">
                    {bill.commitment_title}
                  </p>
                </div>
                <div className="text-right">
                  <Badge
                    variant={
                      bill.status === "paid"
                        ? "default"
                        : bill.status === "approved"
                          ? "secondary"
                          : "outline"
                    }
                    className="capitalize text-xs mb-1"
                  >
                    {bill.status}
                  </Badge>
                  <p className="text-sm font-medium">
                    ${(bill.total_cents / 100).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Contact Info */}
      {data.projectManager && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Project Manager</p>
            <p className="text-sm font-medium">{data.projectManager.full_name}</p>
            {data.projectManager.phone && (
              <a
                href={`tel:${data.projectManager.phone}`}
                className="text-sm text-primary"
              >
                {data.projectManager.phone}
              </a>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
