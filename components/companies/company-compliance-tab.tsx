"use client"

import type { Company } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

function formatDate(value?: string) {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString()
}

function statusFromExpiry(expiry?: string) {
  if (!expiry) return { label: "Not on file", tone: "outline" as const }
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return { label: "Unknown", tone: "outline" as const }
  const days = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (days < 0) return { label: "Expired", tone: "destructive" as const }
  if (days <= 30) return { label: "Expiring soon", tone: "secondary" as const }
  return { label: "Valid", tone: "secondary" as const }
}

export function CompanyComplianceTab({ company }: { company: Company }) {
  const insurance = statusFromExpiry(company.insurance_expiry)
  const license = statusFromExpiry(company.license_expiry)

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Insurance</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={insurance.tone}>{insurance.label}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Provider</span>
            <span>{company.insurance_provider || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Expiry</span>
            <span>{formatDate(company.insurance_expiry)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">License</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">License #</span>
            <span>{company.license_number || "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Expiry</span>
            <span>{formatDate(company.license_expiry)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={company.license_verified ? "secondary" : license.tone}>
              {company.license_verified ? "Verified" : license.label}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tax / W-9</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">W-9 on file</span>
            <Badge variant={company.w9_on_file ? "secondary" : "outline"}>{company.w9_on_file ? "Yes" : "No"}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Prequalification</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Prequalified</span>
            <Badge variant={company.prequalified ? "secondary" : "outline"}>{company.prequalified ? "Yes" : "No"}</Badge>
          </div>
          {company.prequalified_at && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Prequalified at</span>
              <span>{formatDate(company.prequalified_at)}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
