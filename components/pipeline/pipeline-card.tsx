"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { formatDistanceToNow, format, isPast, isToday, differenceInDays } from "date-fns"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Prospect } from "@/lib/services/crm"
import type { LeadStatus } from "@/lib/validation/crm"
import { LeadPriorityBadge } from "./lead-status-badge"
import {
  Clock,
  MoreHorizontal,
  User,
  Receipt,
  ArrowRight,
  Phone,
  Calendar,
  MessageSquare,
  GripVertical,
  AlertTriangle,
} from "@/components/icons"
import { cn } from "@/lib/utils"

interface PipelineCardProps {
  prospect: Prospect
  ownerName?: string
  onViewDetail: () => void
  onChangeStatus: (status: LeadStatus) => void
  onAddActivity: () => void
  onSetFollowUp: () => void
  availableStatuses: LeadStatus[]
  isDragging?: boolean
}

function formatFollowUp(dateStr: string | null | undefined): { text: string; isOverdue: boolean; isToday: boolean } {
  if (!dateStr) return { text: "", isOverdue: false, isToday: false }
  const date = new Date(dateStr)
  const overdue = isPast(date) && !isToday(date)
  const today = isToday(date)
  return {
    text: today ? format(date, "h:mm a") : formatDistanceToNow(date, { addSuffix: true }),
    isOverdue: overdue,
    isToday: today,
  }
}

function isStale(lastTouched?: string | null): boolean {
  if (!lastTouched) return true // Never contacted is stale
  return differenceInDays(new Date(), new Date(lastTouched)) > 7
}

export function PipelineCard({
  prospect,
  ownerName,
  onViewDetail,
  onChangeStatus,
  onAddActivity,
  onSetFollowUp,
  availableStatuses,
  isDragging,
}: PipelineCardProps) {
  const followUp = formatFollowUp(prospect.next_follow_up_at)
  const lastTouched = prospect.last_contacted_at
    ? formatDistanceToNow(new Date(prospect.last_contacted_at), { addSuffix: true })
    : null
  const stale = isStale(prospect.last_contacted_at)

  return (
    <Card
      className={cn(
        "cursor-pointer hover:shadow-md transition-all",
        isDragging && "shadow-lg rotate-2 scale-105 opacity-90",
        stale && "ring-1 ring-amber-400/50"
      )}
      onClick={onViewDetail}
    >
      <CardContent className="p-3 space-y-2">
        {/* Header: Name + Menu */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              {stale && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
              <p className="font-medium truncate">{prospect.full_name}</p>
            </div>
            {prospect.phone && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Phone className="h-3 w-3" />
                {prospect.phone}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={onViewDetail}>
                View details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onAddActivity}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Add activity
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onSetFollowUp}>
                <Calendar className="h-4 w-4 mr-2" />
                Set follow-up
              </DropdownMenuItem>
              {availableStatuses.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Move to
                  </div>
                  {availableStatuses.map((status) => (
                    <DropdownMenuItem key={status} onClick={() => onChangeStatus(status)}>
                      <ArrowRight className="h-4 w-4 mr-2" />
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Badges row */}
        <div className="flex flex-wrap gap-1">
          <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} className="text-[10px] px-1.5 py-0" />
          {prospect.has_estimate && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              <Receipt className="h-2.5 w-2.5 mr-0.5" />
              Estimate
            </Badge>
          )}
        </div>

        {/* Footer info */}
        <div className="flex flex-col gap-1 text-xs text-muted-foreground pt-1 border-t">
          {/* Owner */}
          {ownerName && (
            <div className="flex items-center gap-1">
              <User className="h-3 w-3" />
              <span className="truncate">{ownerName}</span>
            </div>
          )}

          {/* Follow-up */}
          {prospect.next_follow_up_at && (
            <div
              className={cn(
                "flex items-center gap-1",
                followUp.isOverdue && "text-red-600 dark:text-red-400",
                followUp.isToday && "text-amber-600 dark:text-amber-400"
              )}
            >
              <Clock className="h-3 w-3" />
              <span>
                {followUp.isOverdue ? "Overdue" : followUp.isToday ? `Today ${followUp.text}` : followUp.text}
              </span>
            </div>
          )}

          {/* Last touched */}
          <div className={cn("flex items-center gap-1", stale && "text-amber-600 dark:text-amber-400")}>
            <MessageSquare className="h-3 w-3" />
            <span>{lastTouched ? `Last touch ${lastTouched}` : "Never contacted"}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// Draggable wrapper for the pipeline card
export function DraggablePipelineCard(props: PipelineCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.prospect.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="relative group">
        <div
          {...listeners}
          className="absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
        <PipelineCard {...props} isDragging={isDragging} />
      </div>
    </div>
  )
}
