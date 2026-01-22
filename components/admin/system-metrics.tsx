import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Users,
  Building2,
  BarChart3,
  Activity,
  TrendingUp,
  TrendingDown,
  Square,
  HardHat
} from "@/components/icons"
import { getSystemMetrics } from "@/lib/services/admin"

export async function SystemMetrics() {
  const metrics = await getSystemMetrics()

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Daily Active Users
            </CardTitle>
            <CardDescription>Last 30 days average</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.dailyActiveUsers}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={metrics.userGrowth >= 0 ? "default" : "destructive"} className="text-xs">
                {metrics.userGrowth >= 0 ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                {Math.abs(metrics.userGrowth)}%
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Organizations
            </CardTitle>
            <CardDescription>Active organizations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.totalOrganizations}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className="text-xs">
                {metrics.newOrgsThisMonth} new this month
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4" />
              Database Usage
            </CardTitle>
            <CardDescription>Current database load</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.databaseUsage}%</div>
            <Progress value={metrics.databaseUsage} className="mt-2" />
            <div className="text-xs text-muted-foreground mt-1">
              {metrics.databaseSize}GB used
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4" />
              API Requests
            </CardTitle>
            <CardDescription>Last 24 hours</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{metrics.apiRequests.toLocaleString()}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs">
                {metrics.avgResponseTime}ms avg
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              System Health
            </CardTitle>
            <CardDescription>Current system status and uptime</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm">API Status</span>
              <Badge variant="default">Healthy</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm">Database Status</span>
              <Badge variant="default">Healthy</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm">Uptime</span>
              <Badge variant="secondary">{metrics.uptime}</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm">Error Rate</span>
              <Badge variant="outline">{metrics.errorRate}%</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Storage Usage
            </CardTitle>
            <CardDescription>File storage and bandwidth</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>File Storage</span>
                <span>{metrics.fileStorageUsed}GB / {metrics.fileStorageLimit}GB</span>
              </div>
              <Progress value={(metrics.fileStorageUsed / metrics.fileStorageLimit) * 100} />
            </div>
            <div>
              <div className="flex justify-between text-sm mb-2">
                <span>Bandwidth</span>
                <span>{metrics.bandwidthUsed}GB / {metrics.bandwidthLimit}GB</span>
              </div>
              <Progress value={(metrics.bandwidthUsed / metrics.bandwidthLimit) * 100} />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  )
}