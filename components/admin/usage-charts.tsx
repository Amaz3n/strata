import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { BarChart3, TrendingUp, Users, FileText } from "@/components/icons"
import { getUsageTrends } from "@/lib/services/admin"

export async function UsageCharts() {
  const trends = await getUsageTrends()

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            User Growth Trend
          </CardTitle>
          <CardDescription>New user registrations over time</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {trends.userGrowth.map((month, index) => (
              <div key={index} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{month.month}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{month.count}</span>
                  <Badge variant={month.change >= 0 ? "default" : "secondary"} className="text-xs">
                    {month.change >= 0 ? "+" : ""}{month.change}%
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Feature Usage
          </CardTitle>
          <CardDescription>Most used features this month</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {trends.featureUsage.map((feature, index) => (
              <div key={index} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{feature.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{feature.usage.toLocaleString()}</span>
                  <Badge variant="outline" className="text-xs">
                    {feature.change}%
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}