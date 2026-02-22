import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Company, ComplianceStatusSummary } from "@/lib/types"

type ComplianceWatchItem = {
  companyId: string
  companyName: string
  missingCount: number
  expiredCount: number
  deficiencyCount: number
  pendingCount: number
  expiringSoonCount: number
  score: number
}

function scoreComplianceIssue(status: ComplianceStatusSummary): number {
  return (
    status.missing.length * 100 +
    status.expired.length * 80 +
    status.deficiencies.length * 70 +
    status.pending_review.length * 30 +
    status.expiring_soon.length * 10
  )
}

function toWatchItem(company: Company, status: ComplianceStatusSummary): ComplianceWatchItem {
  return {
    companyId: company.id,
    companyName: company.name,
    missingCount: status.missing.length,
    expiredCount: status.expired.length,
    deficiencyCount: status.deficiencies.length,
    pendingCount: status.pending_review.length,
    expiringSoonCount: status.expiring_soon.length,
    score: scoreComplianceIssue(status),
  }
}

export function ComplianceWatchWidget({
  companies,
  complianceStatusByCompanyId,
}: {
  companies: Company[]
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
}) {
  const watchItems = companies
    .filter((company) => company.company_type === "subcontractor" || company.company_type === "supplier")
    .map((company) => {
      const status = complianceStatusByCompanyId[company.id]
      if (!status) return null
      const hasAlert =
        status.missing.length > 0 ||
        status.expired.length > 0 ||
        status.deficiencies.length > 0 ||
        status.pending_review.length > 0 ||
        status.expiring_soon.length > 0
      if (!hasAlert) return null
      return toWatchItem(company, status)
    })
    .filter((item): item is ComplianceWatchItem => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Compliance Watchlist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {watchItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active compliance alerts.</p>
        ) : (
          watchItems.map((item) => (
            <div key={item.companyId} className="space-y-2">
              <div className="font-medium">{item.companyName}</div>
              <div className="flex flex-wrap gap-1">
                {item.missingCount > 0 ? <Badge variant="destructive">{item.missingCount} missing</Badge> : null}
                {item.expiredCount > 0 ? <Badge variant="destructive">{item.expiredCount} expired</Badge> : null}
                {item.deficiencyCount > 0 ? <Badge variant="destructive">{item.deficiencyCount} updates needed</Badge> : null}
                {item.pendingCount > 0 ? <Badge variant="secondary">{item.pendingCount} pending review</Badge> : null}
                {item.expiringSoonCount > 0 ? <Badge variant="outline">{item.expiringSoonCount} expiring soon</Badge> : null}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
