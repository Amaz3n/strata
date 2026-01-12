"use client"

import { useMemo, useState } from "react"

import type { Company, ComplianceRules } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

function statusFromExpiry(expiry?: string) {
  if (!expiry) return { label: "Missing", tone: "outline" as const }
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return { label: "Unknown", tone: "outline" as const }
  const days = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (days < 0) return { label: "Expired", tone: "destructive" as const }
  if (days <= 30) return { label: "Expiring", tone: "secondary" as const }
  return { label: "Valid", tone: "secondary" as const }
}

function companyIssues(company: Company, rules: ComplianceRules) {
  const issues: string[] = []
  if (rules.require_w9 && !company.w9_on_file) issues.push("W-9 missing")
  if (rules.require_insurance) {
    const insurance = statusFromExpiry(company.insurance_expiry)
    if (insurance.label !== "Valid") issues.push(`Insurance ${insurance.label.toLowerCase()}`)
  }
  if (rules.require_license) {
    const license = statusFromExpiry(company.license_expiry)
    if (license.label !== "Valid") issues.push(`License ${license.label.toLowerCase()}`)
  }
  return issues
}

export function ComplianceDashboard({
  companies,
  rules,
}: {
  companies: Company[]
  rules: ComplianceRules
}) {
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return companies
    return companies.filter((company) => company.name.toLowerCase().includes(term))
  }, [companies, search])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Compliance dashboard</p>
          <p className="text-xs text-muted-foreground">Track expiring documents and payment blockers.</p>
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search companies..."
          className="h-9 w-full sm:w-72"
        />
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Company</TableHead>
              <TableHead className="px-4 py-3">Insurance</TableHead>
              <TableHead className="px-4 py-3">License</TableHead>
              <TableHead className="px-4 py-3">W-9</TableHead>
              <TableHead className="px-4 py-3">Issues</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((company) => {
              const insurance = statusFromExpiry(company.insurance_expiry)
              const license = statusFromExpiry(company.license_expiry)
              const issues = companyIssues(company, rules)
              return (
                <TableRow key={company.id} className="divide-x">
                  <TableCell className="px-4 py-3">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{company.name}</p>
                      <p className="text-xs text-muted-foreground">{company.trade ?? "—"}</p>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={insurance.tone}>{insurance.label}</Badge>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={company.license_verified ? "secondary" : license.tone}>
                      {company.license_verified ? "Verified" : license.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant={company.w9_on_file ? "secondary" : "outline"}>
                      {company.w9_on_file ? "On file" : "Missing"}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    {issues.length > 0 ? (
                      <div className="space-y-1">
                        {issues.slice(0, 2).map((issue) => (
                          <Badge key={issue} variant="outline">
                            {issue}
                          </Badge>
                        ))}
                        {issues.length > 2 ? (
                          <span className="text-xs text-muted-foreground">+{issues.length - 2} more</span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">No blockers</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                  No companies found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
