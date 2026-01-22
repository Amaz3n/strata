import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getOrgSupport } from "@/lib/services/orgs"
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function SupportPage() {
  await requirePermissionGuard("billing.manage")

  const support = await getOrgSupport()
  const tier = (support?.details as any)?.tier ?? "standard"

  return (
    <PageLayout
      title="Support"
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Support" },
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Support</h1>
          <p className="text-muted-foreground mt-1">
            Support tier and contact information for this organization.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Support contract</CardTitle>
            <CardDescription>Tier, status, and dates.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-lg font-semibold" data-testid="support-tier">
                {tier}
              </span>
              <Badge variant={support?.status === "active" ? "default" : "outline"} className="capitalize">
                {support?.status ?? "active"}
              </Badge>
            </div>
            {support?.starts_at && (
              <div className="text-sm text-muted-foreground">
                Starts: {new Date(support.starts_at).toLocaleDateString()}
              </div>
            )}
            {support?.ends_at && (
              <div className="text-sm text-muted-foreground">
                Ends: {new Date(support.ends_at).toLocaleDateString()}
              </div>
            )}
            <div className="text-sm text-muted-foreground">
              For assistance, contact: <a href="mailto:support@strata.local">support@strata.local</a>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}






