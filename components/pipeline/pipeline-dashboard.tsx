"use client"

import { useState } from "react"
import Link from "next/link"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { TeamMember } from "@/lib/types"
import type { Prospect, CrmDashboardStats, CrmActivity } from "@/lib/services/crm"
import { LeadStatusBadge, LeadPriorityBadge } from "./lead-status-badge"
import { ProspectDetailSheet } from "./prospect-detail-sheet"
import { AddTouchDialog } from "./add-touch-dialog"
import { FollowUpDialog } from "./follow-up-dialog"
import { AddProspectDialog } from "./add-prospect-dialog"
import { QuickCaptureInput } from "./quick-capture-input"
import {
  Clock,
  AlertTriangle,
  Users,
  Receipt,
  TrendingUp,
  TrendingDown,
  Plus,
  Target,
  Activity,
  ChevronRight,
  Zap,
  Sparkles,
  UserPlus,
  Mail,
  Phone,
  ExternalLink,
  MessageSquare,
} from "@/components/icons"
import { formatDistanceToNow, format, isPast, isToday, isYesterday } from "date-fns"
import { cn } from "@/lib/utils"

interface PipelineDashboardProps {
  stats: CrmDashboardStats
  pipelineCounts: {
    new: number
    contacted: number
    qualified: number
    estimating: number
    won: number
    lost: number
  }
  winRate: number | null
  followUpsDue: Prospect[]
  newInquiries: Prospect[]
  recentActivity: CrmActivity[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
}

const PIPELINE_STAGES = [
  { key: "new", label: "New", color: "bg-blue-500" },
  { key: "contacted", label: "Contacted", color: "bg-slate-400" },
  { key: "qualified", label: "Qualified", color: "bg-purple-500" },
  { key: "estimating", label: "Estimating", color: "bg-amber-500" },
] as const

export function PipelineDashboard({
  stats,
  pipelineCounts,
  winRate,
  followUpsDue,
  newInquiries,
  recentActivity,
  teamMembers,
  canCreate = false,
  canEdit = false,
}: PipelineDashboardProps) {
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)
  const [touchContact, setTouchContact] = useState<Prospect | undefined>()
  const [followUpContact, setFollowUpContact] = useState<Prospect | undefined>()
  const [addOpen, setAddOpen] = useState(false)

  const openDetail = (prospectId: string) => {
    setDetailId(prospectId)
    setDetailOpen(true)
  }

  const getFollowUpClass = (dateStr?: string | null) => {
    if (!dateStr) return ""
    const date = new Date(dateStr)
    if (isPast(date) && !isToday(date)) return "text-red-600 dark:text-red-400"
    if (isToday(date)) return "text-amber-600 dark:text-amber-400"
    return "text-muted-foreground"
  }

  // Calculate max for pipeline chart scaling
  const maxCount = Math.max(...Object.values(pipelineCounts).filter((_, i) => i < 4), 1)
  const activePipelineTotal = pipelineCounts.new + pipelineCounts.contacted + pipelineCounts.qualified + pipelineCounts.estimating

  return (
    <div className="space-y-6">
      {/* Header with quick capture */}
      <div className="flex justify-end">
        {canCreate && (
          <div className="flex items-center gap-2">
            <QuickCaptureInput teamMembers={teamMembers} />
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Full form
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3 lg:auto-rows-fr">
        {/* Active Pipeline - spans 2 columns */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Active Pipeline
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {activePipelineTotal} active · {pipelineCounts.won + pipelineCounts.lost} closed
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {/* Funnel stages - horizontal on desktop, vertical on mobile */}
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-0">
              {PIPELINE_STAGES.map((stage, index) => {
                const count = pipelineCounts[stage.key as keyof typeof pipelineCounts]
                const pctOfTotal = activePipelineTotal > 0 ? Math.round((count / activePipelineTotal) * 100) : 0

                const stageStyles: Record<string, { gradient: string; border: string; text: string }> = {
                  new: {
                    gradient: "from-blue-500/10 to-blue-600/5 dark:from-blue-500/20 dark:to-blue-600/10",
                    border: "border-blue-500/30",
                    text: "text-blue-600 dark:text-blue-400",
                  },
                  contacted: {
                    gradient: "from-slate-400/10 to-slate-500/5 dark:from-slate-400/20 dark:to-slate-500/10",
                    border: "border-slate-400/30",
                    text: "text-slate-600 dark:text-slate-400",
                  },
                  qualified: {
                    gradient: "from-purple-500/10 to-purple-600/5 dark:from-purple-500/20 dark:to-purple-600/10",
                    border: "border-purple-500/30",
                    text: "text-purple-600 dark:text-purple-400",
                  },
                  estimating: {
                    gradient: "from-amber-500/10 to-amber-600/5 dark:from-amber-500/20 dark:to-amber-600/10",
                    border: "border-amber-500/30",
                    text: "text-amber-600 dark:text-amber-400",
                  },
                }

                const style = stageStyles[stage.key]

                return (
                  <div key={stage.key} className="flex-1 flex items-center">
                    <Link
                      href={`/prospects?status=${stage.key}`}
                      className={cn(
                        "group relative flex-1 p-4 rounded-xl border transition-all",
                        "hover:shadow-md hover:scale-[1.02] active:scale-[0.98]",
                        "bg-gradient-to-br",
                        style.gradient,
                        style.border
                      )}
                    >
                      {/* Count - prominent */}
                      <div className={cn("text-2xl sm:text-3xl font-bold tabular-nums", style.text)}>
                        {count}
                      </div>

                      {/* Stage name + percentage */}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs font-medium text-foreground">{stage.label}</span>
                        <span className="text-[10px] text-muted-foreground">{pctOfTotal}%</span>
                      </div>

                      {/* Hover indicator */}
                      <ChevronRight className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
                    </Link>

                    {/* Arrow between stages - desktop only */}
                    {index < PIPELINE_STAGES.length - 1 && (
                      <div className="hidden sm:flex items-center justify-center w-6 shrink-0">
                        <ChevronRight className="h-4 w-4 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Outcomes: Won & Lost */}
            <div className="flex gap-3 mt-4 pt-4 border-t">
              <Link
                href="/prospects?status=won"
                className="flex-1 group flex items-center gap-3 p-3 rounded-lg bg-green-500/10 dark:bg-green-500/20 border border-green-500/20 hover:border-green-500/40 hover:shadow-sm transition-all"
              >
                <div className="h-10 w-10 rounded-lg bg-green-500 flex items-center justify-center shrink-0">
                  <TrendingUp className="h-5 w-5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-bold text-green-600 dark:text-green-400 tabular-nums">
                    {pipelineCounts.won}
                  </div>
                  <div className="text-xs text-muted-foreground">Won this month</div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
              </Link>

              <Link
                href="/prospects?status=lost"
                className="flex-1 group flex items-center gap-3 p-3 rounded-lg bg-red-500/5 dark:bg-red-500/10 border border-red-500/15 hover:border-red-500/30 hover:shadow-sm transition-all"
              >
                <div className="h-10 w-10 rounded-lg bg-red-500 flex items-center justify-center shrink-0">
                  <TrendingDown className="h-5 w-5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-bold text-red-600 dark:text-red-400 tabular-nums">
                    {pipelineCounts.lost}
                  </div>
                  <div className="text-xs text-muted-foreground">Lost this month</div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
              </Link>
            </div>

            {/* Win rate indicator */}
            {(pipelineCounts.won > 0 || pipelineCounts.lost > 0) && (
              <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Target className="h-3.5 w-3.5" />
                <span>
                  Win rate:{" "}
                  <span className={cn(
                    "font-semibold",
                    winRate !== null && winRate >= 50 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"
                  )}>
                    {winRate !== null ? `${winRate}%` : "—"}
                  </span>
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent activity - spans 2 rows */}
        <Card className="lg:col-span-1 lg:row-span-3 flex flex-col">
          <CardHeader className="pb-2 shrink-0">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 px-0 flex-1 min-h-0">
            {recentActivity.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center px-6">
                <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center mb-2">
                  <Activity className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No recent activity</p>
                <p className="text-xs text-muted-foreground mt-0.5">Activity will appear here</p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                <div className="divide-y divide-border/50">
                  {recentActivity.slice(0, 15).map((item) => {
                    // Determine icon and color based on event/touch type
                    const getActivityStyle = () => {
                      if (item.event_type === "crm_prospect_created") {
                        return { icon: UserPlus, bg: "bg-blue-100 dark:bg-blue-900/30", color: "text-blue-600 dark:text-blue-400" }
                      }
                      if (item.event_type === "crm_lead_status_changed") {
                        return { icon: TrendingUp, bg: "bg-purple-100 dark:bg-purple-900/30", color: "text-purple-600 dark:text-purple-400" }
                      }
                      if (item.event_type === "crm_follow_up_set") {
                        return { icon: Clock, bg: "bg-amber-100 dark:bg-amber-900/30", color: "text-amber-600 dark:text-amber-400" }
                      }
                      if (item.event_type === "crm_estimate_created") {
                        return { icon: Receipt, bg: "bg-green-100 dark:bg-green-900/30", color: "text-green-600 dark:text-green-400" }
                      }
                      // Touch types
                      if (item.touch_type === "call") {
                        return { icon: Phone, bg: "bg-green-100 dark:bg-green-900/30", color: "text-green-600 dark:text-green-400" }
                      }
                      if (item.touch_type === "email") {
                        return { icon: Mail, bg: "bg-blue-100 dark:bg-blue-900/30", color: "text-blue-600 dark:text-blue-400" }
                      }
                      if (item.touch_type === "meeting" || item.touch_type === "site_visit") {
                        return { icon: Users, bg: "bg-indigo-100 dark:bg-indigo-900/30", color: "text-indigo-600 dark:text-indigo-400" }
                      }
                      return { icon: MessageSquare, bg: "bg-muted", color: "text-muted-foreground" }
                    }

                    const style = getActivityStyle()
                    const IconComponent = style.icon

                    // Format timestamp properly
                    const activityDate = new Date(item.created_at)
                    const formatTimestamp = () => {
                      if (isToday(activityDate)) {
                        return `Today at ${format(activityDate, "h:mm a")}`
                      }
                      if (isYesterday(activityDate)) {
                        return `Yesterday at ${format(activityDate, "h:mm a")}`
                      }
                      return format(activityDate, "MM/dd/yy h:mm a")
                    }

                    return (
                      <button
                        key={item.id}
                        className={cn(
                          "group w-full flex items-center gap-3 py-3 pl-6 pr-3 text-left transition-colors",
                          "hover:bg-muted/50 active:bg-muted/70"
                        )}
                        onClick={() => item.entity_id && openDetail(item.entity_id)}
                        disabled={!item.entity_id}
                      >
                        {/* Icon */}
                        <div className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                          style.bg
                        )}>
                          <IconComponent className={cn("h-4 w-4", style.color)} />
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {/* Contact name • Activity */}
                          <p className="text-sm truncate leading-tight">
                            {item.contact_name && (
                              <span className="font-medium">{item.contact_name}</span>
                            )}
                            {item.contact_name && item.title && (
                              <span className="text-muted-foreground mx-1.5">•</span>
                            )}
                            <span className="text-muted-foreground">{item.title}</span>
                          </p>

                          {/* Timestamp */}
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {formatTimestamp()}
                          </p>
                        </div>

                        <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        {/* Follow-ups due */}
        <Card className="lg:col-span-1 lg:col-start-1 lg:row-span-2 flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Follow-ups Due
              </CardTitle>
              <Button variant="ghost" size="sm" asChild className="text-xs">
                <Link href="/prospects?filter=followup">
                  View all
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0 flex-1 min-h-0">
            {followUpsDue.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center h-full">
                <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-3">
                  <TrendingUp className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
                <p className="text-sm font-medium">All caught up!</p>
                <p className="text-xs text-muted-foreground mt-1">No follow-ups due</p>
              </div>
            ) : (
              <div className="space-y-2 overflow-y-auto scrollbar-thin pr-1">
                {followUpsDue.slice(0, 5).map((prospect) => (
                  <button
                    key={prospect.id}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg hover:bg-muted/50 transition-colors text-left"
                    onClick={() => openDetail(prospect.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{prospect.full_name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <LeadStatusBadge status={prospect.lead_status ?? "new"} className="text-[10px] px-1.5 py-0" />
                      </div>
                    </div>
                    <div className={cn("text-xs whitespace-nowrap ml-2", getFollowUpClass(prospect.next_follow_up_at))}>
                      {prospect.next_follow_up_at && (
                        <>
                          {isPast(new Date(prospect.next_follow_up_at)) && !isToday(new Date(prospect.next_follow_up_at))
                            ? "Overdue"
                            : isToday(new Date(prospect.next_follow_up_at))
                            ? format(new Date(prospect.next_follow_up_at), "h:mm a")
                            : formatDistanceToNow(new Date(prospect.next_follow_up_at), { addSuffix: true })}
                        </>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* New inquiries */}
        <Card className="lg:col-span-1 lg:row-span-2 flex flex-col">
          <CardHeader className="pb-2 shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                New Inquiries
              </CardTitle>
              <Button variant="ghost" size="sm" asChild className="text-xs h-7 px-2">
                <Link href="/prospects?status=new">
                  View all
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0 px-0 flex-1 min-h-0">
            {newInquiries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center px-6">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/30 dark:to-indigo-900/30 flex items-center justify-center mb-2">
                  <UserPlus className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <p className="text-sm font-medium">No new inquiries</p>
                <p className="text-xs text-muted-foreground mt-0.5">Add a prospect to get started</p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                <div className="divide-y divide-border/50">
                  {newInquiries.map((prospect, index) => {
                    const initials = prospect.full_name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()
                    const isHot = prospect.lead_priority === "high" || prospect.lead_priority === "urgent"
                    const gradients = [
                      "from-blue-500 to-indigo-600",
                      "from-violet-500 to-purple-600",
                      "from-cyan-500 to-blue-600",
                      "from-indigo-500 to-blue-600",
                      "from-blue-600 to-violet-600",
                    ]
                    const gradient = gradients[index % gradients.length]

                    // Format timestamp properly
                    const createdDate = new Date(prospect.created_at)
                    const formatTimestamp = () => {
                      if (isToday(createdDate)) {
                        return `Today at ${format(createdDate, "h:mm a")}`
                      }
                      if (isYesterday(createdDate)) {
                        return `Yesterday at ${format(createdDate, "h:mm a")}`
                      }
                      return format(createdDate, "MM/dd/yy h:mm a")
                    }

                    return (
                      <button
                        key={prospect.id}
                        className={cn(
                          "group w-full flex items-center gap-3 py-3 pl-6 pr-3 text-left transition-colors",
                          "hover:bg-muted/50 active:bg-muted/70",
                          isHot && "bg-amber-50/40 dark:bg-amber-950/20"
                        )}
                        onClick={() => openDetail(prospect.id)}
                      >
                        {/* Avatar */}
                        <div className={cn(
                          "relative h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                          "bg-gradient-to-br text-white font-medium text-xs",
                          gradient
                        )}>
                          {initials}
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          {/* Name + hot indicator */}
                          <p className="text-sm truncate leading-tight">
                            <span className="font-medium">{prospect.full_name}</span>
                            {isHot && (
                              <span className="inline-flex items-center ml-1.5">
                                <span className="h-4 w-4 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 flex items-center justify-center">
                                  <Zap className="h-2.5 w-2.5 text-white" />
                                </span>
                              </span>
                            )}
                            {prospect.crm_source && (
                              <>
                                <span className="text-muted-foreground mx-1.5">•</span>
                                <span className="text-muted-foreground">{prospect.crm_source}</span>
                              </>
                            )}
                          </p>

                          {/* Timestamp */}
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {formatTimestamp()}
                          </p>
                        </div>

                        {/* Right side - actions + chevron */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {/* Quick actions - always visible on mobile, hover on desktop */}
                          <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            {prospect.phone && (
                              <a
                                href={`tel:${prospect.phone}`}
                                onClick={(e) => e.stopPropagation()}
                                className="h-7 w-7 rounded-md bg-green-100 dark:bg-green-900/30 flex items-center justify-center hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                              >
                                <Phone className="h-3.5 w-3.5 text-green-700 dark:text-green-400" />
                              </a>
                            )}
                            {prospect.email && (
                              <a
                                href={`mailto:${prospect.email}`}
                                onClick={(e) => e.stopPropagation()}
                                className="h-7 w-7 rounded-md bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                              >
                                <Mail className="h-3.5 w-3.5 text-blue-700 dark:text-blue-400" />
                              </a>
                            )}
                          </div>

                          <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:block" />
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dialogs */}
      <ProspectDetailSheet
        contactId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        teamMembers={teamMembers}
      />

      <AddProspectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        teamMembers={teamMembers}
      />

      {touchContact && (
        <AddTouchDialog
          open={!!touchContact}
          onOpenChange={(open) => !open && setTouchContact(undefined)}
          contactId={touchContact.id}
          contactName={touchContact.full_name}
        />
      )}

      {followUpContact && (
        <FollowUpDialog
          open={!!followUpContact}
          onOpenChange={(open) => !open && setFollowUpContact(undefined)}
          contactId={followUpContact.id}
          contactName={followUpContact.full_name}
          currentFollowUp={followUpContact.next_follow_up_at}
        />
      )}
    </div>
  )
}
