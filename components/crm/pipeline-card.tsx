"use client"

import { formatDistanceToNow, format, isPast, isToday } from "date-fns"
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
import { Clock, MoreHorizontal, User, Receipt, ArrowRight, Phone, Calendar, MessageSquare } from "@/components/icons"

interface PipelineCardProps {
  prospect: Prospect
  ownerName?: string
  onViewDetail: () => void
  onChangeStatus: (status: LeadStatus) => void
  onAddActivity: () => void
  onSetFollowUp: () => void
  availableStatuses: LeadStatus[]
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

export function PipelineCard({
  prospect,
  ownerName,
  onViewDetail,
  onChangeStatus,
  onAddActivity,
  onSetFollowUp,
  availableStatuses,
}: PipelineCardProps) {
  const followUp = formatFollowUp(prospect.next_follow_up_at)
  const lastTouched = prospect.last_contacted_at
    ? formatDistanceToNow(new Date(prospect.last_contacted_at), { addSuffix: true })
    : null

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      onClick={onViewDetail}
    >
      <CardContent className="p-3 space-y-2">
        {/* Header: Name + Menu */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{prospect.full_name}</p>
            {prospect.phone && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Badges row */}
        <div className="flex flex-wrap gap-1">
          <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
          {prospect.has_estimate && (
            <Badge variant="outline" className="text-xs">
              <Receipt className="h-3 w-3 mr-1" />
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
              className={`flex items-center gap-1 ${
                followUp.isOverdue
                  ? "text-red-600 dark:text-red-400"
                  : followUp.isToday
                  ? "text-amber-600 dark:text-amber-400"
                  : ""
              }`}
            >
              <Clock className="h-3 w-3" />
              <span>
                {followUp.isOverdue ? "Overdue" : followUp.isToday ? `Today ${followUp.text}` : followUp.text}
              </span>
            </div>
          )}

          {/* Last touched */}
          {lastTouched && (
            <div className="flex items-center gap-1">
              <MessageSquare className="h-3 w-3" />
              <span>Last touch {lastTouched}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
