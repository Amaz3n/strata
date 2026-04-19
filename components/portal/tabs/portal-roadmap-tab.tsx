"use client"

import { useMemo } from "react"
import { format } from "date-fns"
import { Map, Flag, CheckCircle2, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ClientPortalData, ScheduleItem } from "@/lib/types"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"

interface PortalRoadmapTabProps {
  data: ClientPortalData
}

export function PortalRoadmapTab({ data }: PortalRoadmapTabProps) {
  const scheduleItems = data.schedule ?? []

  // Filter only milestones and phases for the client roadmap view
  const roadmapItems = useMemo(() => {
    return scheduleItems
      .filter((item) => item.item_type === "milestone" || item.item_type === "phase")
      .sort((a, b) => {
        const dateA = a.end_date || a.start_date || ""
        const dateB = b.end_date || b.start_date || ""
        return dateA.localeCompare(dateB)
      })
  }, [scheduleItems])

  // Compute overall progress based on roadmap items
  const completedCount = roadmapItems.filter(i => i.status === "completed").length
  const totalCount = roadmapItems.length
  const overallProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  // Find the next upcoming item
  const upcomingItem = roadmapItems.find(i => i.status !== "completed")

  return (
    <div className="space-y-6 max-w-3xl mx-auto w-full pb-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Project Roadmap</h2>
        <p className="text-muted-foreground mt-1">
          A high-level view of major milestones and project phases.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Overall Progress</span>
            <span className="text-primary">{overallProgress}%</span>
          </CardTitle>
          <CardDescription>
            {completedCount} of {totalCount} major milestones completed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress value={overallProgress} className="h-3" />
          
          {upcomingItem && (
            <div className="mt-4 p-3 bg-primary/5 border border-primary/10 rounded-lg flex items-start gap-3">
              <div className="mt-0.5 bg-primary/10 p-1.5 rounded text-primary">
                <Flag className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-primary">Up Next: {upcomingItem.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Expected: {upcomingItem.end_date ? format(new Date(upcomingItem.end_date), "MMMM d, yyyy") : "TBD"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="relative border-l border-muted-foreground/20 ml-3 pl-6 space-y-8 mt-8">
        {roadmapItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roadmap items available yet.</p>
        ) : (
          roadmapItems.map((item, i) => {
            const isCompleted = item.status === "completed"
            const isNext = upcomingItem?.id === item.id
            const dateStr = item.end_date || item.start_date
            
            return (
              <div key={item.id} className="relative">
                {/* Timeline node */}
                <div className={cn(
                  "absolute -left-[31px] rounded-full p-1 border bg-background",
                  isCompleted ? "border-emerald-500 text-emerald-500" : 
                  isNext ? "border-primary text-primary" : "border-muted-foreground/30 text-muted-foreground/30"
                )}>
                  {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : 
                   isNext ? <Map className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </div>
                
                <div className={cn(
                  "rounded-lg border p-4 transition-colors",
                  isCompleted ? "bg-muted/30" : isNext ? "bg-card shadow-sm border-primary/20" : "bg-card opacity-70"
                )}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={item.item_type === "milestone" ? "default" : "secondary"} className="capitalize text-[10px]">
                          {item.item_type}
                        </Badge>
                        {isCompleted && <Badge variant="outline" className="text-emerald-600 bg-emerald-50 border-emerald-200 text-[10px]">Completed</Badge>}
                        {isNext && <Badge variant="outline" className="text-primary bg-primary/10 border-primary/20 text-[10px]">In Progress</Badge>}
                      </div>
                      <h3 className={cn("font-semibold", isCompleted && "text-muted-foreground")}>{item.name}</h3>
                      {item.metadata?.notes && (
                        <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                          {item.metadata.notes}
                        </p>
                      )}
                    </div>
                    
                    {dateStr && (
                      <div className="text-right shrink-0">
                        <p className="text-sm font-medium">
                          {format(new Date(dateStr), "MMM d, yyyy")}
                        </p>
                        {!isCompleted && (
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-1">Est. Date</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
