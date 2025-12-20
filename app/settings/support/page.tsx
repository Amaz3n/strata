import { AppShell } from "@/components/layout/app-shell"
export const dynamic = 'force-dynamic'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getCurrentUserAction } from "@/app/actions/user"
import { getOrgSupport } from "@/lib/services/orgs"
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function SupportPage() {
  await requirePermissionGuard("billing.manage")
  const [currentUser, support] = await Promise.all([getCurrentUserAction(), getOrgSupport()])

  const tier = (support?.details as any)?.tier ?? "standard"

  return (
    <AppShell
      title="Support"
      user={currentUser}
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: "Support" },
      ]}
    >
      <div className="p-4 lg:p-6 space-y-6">
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
    </AppShell>
  )
}




