import Link from "next/link"
import { format, parseISO } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import {
  CalendarDays,
  CheckCircle,
  Flag,
  DollarSign,
  ChevronRight,
} from "@/components/icons"
import type { ComingUpItem } from "@/app/(app)/projects/[id]/overview-actions"
import { cn } from "@/lib/utils"

interface ProjectOverviewComingUpProps {
  items: ComingUpItem[]
  projectId: string
}

const scheduleStatusColors: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/10 text-primary",
  at_risk: "bg-warning/20 text-warning",
  blocked: "bg-destructive/10 text-destructive",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
}

export function ProjectOverviewComingUp({ items, projectId }: ProjectOverviewComingUpProps) {
  if (items.length === 0) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader>
          <CardTitle className="text-base">Coming Up</CardTitle>
          <CardDescription>Next 7 days</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground text-center">
            No upcoming items in the next 7 days
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full flex flex-col">
      <CardHeader>
        <CardTitle className="text-base">Coming Up</CardTitle>
        <CardDescription>Next 7 days</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <ScrollArea className="h-[320px] pr-4">
          <div className="space-y-3">
            {items.map((item) => (
              <Link
                key={`${item.type}-${item.id}`}
                href={item.link}
                className="block"
              >
                <div className="flex items-start gap-3 rounded-lg border p-3 hover:bg-muted/50 transition-colors">
                  <div className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-xs font-medium",
                    item.type === "milestone" && "bg-chart-3/20 text-chart-3",
                    item.type === "draw" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
                    item.type === "task" && "bg-primary/10 text-primary",
                    item.type === "schedule" && "bg-muted"
                  )}>
                    {item.type === "milestone" && <Flag className="h-4 w-4" />}
                    {item.type === "draw" && <DollarSign className="h-4 w-4" />}
                    {item.type === "task" && <CheckCircle className="h-4 w-4" />}
                    {item.type === "schedule" && (
                      <span>{format(parseISO(item.date), "dd")}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-medium leading-none truncate">{item.title}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CalendarDays className="h-3 w-3" />
                      <span>{format(parseISO(item.date), "EEE, MMM d")}</span>
                      <span className="capitalize">&bull; {item.type}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.status && item.type === "schedule" && (
                      <Badge variant="outline" className={scheduleStatusColors[item.status] ?? ""}>
                        {typeof item.progress === "number" ? `${item.progress}%` : item.status.replace("_", " ")}
                      </Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
