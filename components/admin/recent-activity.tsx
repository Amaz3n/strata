import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { getRecentAdminActivity } from "@/lib/services/admin"
import { formatDistanceToNow } from "date-fns"

export async function RecentActivity() {
  const activities = await getRecentAdminActivity()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest system events and changes</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {activities.length === 0 ? (
            <div className="text-center text-muted-foreground py-4">
              No recent activity
            </div>
          ) : (
            activities.map((activity) => (
              <div key={activity.id} className="flex items-start gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">
                    {activity.userInitials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{activity.description}</p>
                    <Badge variant={getActivityBadgeVariant(activity.type)} className="text-xs">
                      {activity.type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{activity.userName}</span>
                    <span>•</span>
                    <span>{formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}</span>
                  </div>
                  {activity.details && (
                    <p className="text-xs text-muted-foreground">{activity.details}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function getActivityBadgeVariant(type: string) {
  switch (type) {
    case "provision":
      return "default"
    case "subscription":
      return "secondary"
    case "billing":
      return "outline"
    case "security":
      return "destructive"
    default:
      return "secondary"
  }
}