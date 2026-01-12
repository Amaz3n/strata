import Link from "next/link"
import { format, parseISO } from "date-fns"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  AlertCircle,
  CheckCircle,
  CalendarDays,
  MessageSquare,
  FileText,
  Hammer,
  AlertTriangle,
  ChevronRight,
} from "@/components/icons"
import type { AttentionItem } from "@/app/(app)/projects/[id]/overview-actions"
import { cn } from "@/lib/utils"

interface ProjectOverviewAttentionProps {
  items: AttentionItem[]
  projectId: string
}

const typeIcons: Record<string, React.ReactNode> = {
  task: <CheckCircle className="h-4 w-4" />,
  schedule: <CalendarDays className="h-4 w-4" />,
  rfi: <MessageSquare className="h-4 w-4" />,
  submittal: <FileText className="h-4 w-4" />,
  punch: <Hammer className="h-4 w-4" />,
  closeout: <AlertTriangle className="h-4 w-4" />,
  warranty: <AlertTriangle className="h-4 w-4" />,
}

const reasonColors: Record<string, string> = {
  overdue: "border-destructive/30 bg-destructive/5 text-destructive",
  at_risk: "border-warning/30 bg-warning/5 text-warning",
  blocked: "border-destructive/30 bg-destructive/5 text-destructive",
  pending: "border-amber-500/30 bg-amber-500/5 text-amber-600",
  missing: "border-muted bg-muted/50 text-muted-foreground",
}

const reasonLabels: Record<string, string> = {
  overdue: "Overdue",
  at_risk: "At Risk",
  blocked: "Blocked",
  pending: "Pending",
  missing: "Missing",
}

export function ProjectOverviewAttention({ items, projectId }: ProjectOverviewAttentionProps) {
  if (items.length === 0) {
    return null
  }

  return (
    <Card className="border-warning/50">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-warning" />
          <CardTitle className="text-base">Attention Required</CardTitle>
        </div>
        <CardDescription>Items that need immediate attention</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {items.map((item) => (
            <Link
              key={`${item.type}-${item.id}`}
              href={item.link}
              className="block"
            >
              <div
                className={cn(
                  "flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50",
                  reasonColors[item.reason]
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex-shrink-0 opacity-70">
                    {typeIcons[item.type]}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium truncate">{item.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {item.dueDate && (
                        <span>Due {format(parseISO(item.dueDate), "MMM d")}</span>
                      )}
                      {!item.dueDate && item.status && (
                        <span className="capitalize">{item.status.replace("_", " ")}</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs capitalize",
                      item.reason === "overdue" && "border-destructive/50 text-destructive",
                      item.reason === "blocked" && "border-destructive/50 text-destructive",
                      item.reason === "at_risk" && "border-warning/50 text-warning"
                    )}
                  >
                    {reasonLabels[item.reason]}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {item.type}
                  </Badge>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
