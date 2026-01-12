import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { validatePortalToken, loadSubPortalData } from "@/lib/services/portal-access"
import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface SubBillsPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export default async function SubBillsPage({ params }: SubBillsPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) notFound()
  if (access.portal_type !== "sub" || !access.company_id) notFound()
  if (!access.permissions.can_view_bills) notFound()

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />

      <main className="flex-1 mx-auto w-full max-w-xl px-4 py-6 space-y-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
            <Link href={`/s/${token}`}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track submitted invoices and their status.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">All Invoices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.bills.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices submitted yet</p>
            ) : (
              data.bills.map((bill) => (
                <div key={bill.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{bill.bill_number}</p>
                    <p className="text-xs text-muted-foreground truncate">{bill.commitment_title}</p>
                    {bill.due_date && (
                      <p className="text-xs text-muted-foreground">Due {new Date(bill.due_date).toLocaleDateString()}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <Badge
                      variant={bill.status === "paid" ? "secondary" : bill.status === "approved" ? "outline" : "outline"}
                      className="capitalize text-xs mb-1"
                    >
                      {bill.status}
                    </Badge>
                    <p className="text-sm font-medium">{formatCurrency(bill.total_cents)}</p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

