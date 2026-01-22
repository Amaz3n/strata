import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Users, Building2, CreditCard, AlertTriangle } from "@/components/icons"
import { getAdminStats } from "@/lib/services/admin"

export async function AdminStats() {
  const stats = await getAdminStats()

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Total Organizations
          </CardTitle>
          <CardDescription>All active customer orgs</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.totalOrgs}</div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary" className="text-xs">
              {stats.newOrgsThisMonth} new this month
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Active Subscriptions
          </CardTitle>
          <CardDescription>Paid subscriptions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.activeSubscriptions}</div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="outline" className="text-xs">
              {stats.trialingSubscriptions} trialing
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Monthly Revenue
          </CardTitle>
          <CardDescription>MRR from subscriptions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            ${(stats.monthlyRevenue / 100).toLocaleString()}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary" className="text-xs">
              {stats.revenueGrowth >= 0 ? '+' : ''}{stats.revenueGrowth}% vs last month
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Issues
          </CardTitle>
          <CardDescription>Requires attention</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.pendingIssues}</div>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={stats.pendingIssues > 0 ? "destructive" : "secondary"} className="text-xs">
              {stats.criticalIssues} critical
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}