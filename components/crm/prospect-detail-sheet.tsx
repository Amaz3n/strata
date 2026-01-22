"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { TeamMember } from "@/lib/types"
import type { Prospect, CrmActivity } from "@/lib/services/crm"
import { getProspectAction, getProspectActivityAction } from "@/app/(app)/crm/actions"
import { LeadStatusBadge, LeadPriorityBadge } from "./lead-status-badge"
import { AddTouchDialog } from "./add-touch-dialog"
import { FollowUpDialog } from "./follow-up-dialog"
import { ChangeStatusDialog } from "./change-status-dialog"
import { Mail, Phone, Clock, Calendar, Loader2, MapPin, User, Receipt } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow, format, isPast, isToday } from "date-fns"

interface ProspectDetailSheetProps {
  contactId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
}

function formatFollowUp(dateStr: string | null | undefined): { text: string; isOverdue: boolean; isToday: boolean } {
  if (!dateStr) return { text: "Not set", isOverdue: false, isToday: false }
  const date = new Date(dateStr)
  const overdue = isPast(date) && !isToday(date)
  const today = isToday(date)
  return {
    text: today ? `Today at ${format(date, "h:mm a")}` : format(date, "MMM d, h:mm a"),
    isOverdue: overdue,
    isToday: today,
  }
}

function formatBudgetRange(budget?: string): string {
  const map: Record<string, string> = {
    under_100k: "Under $100k",
    "100k_250k": "$100k - $250k",
    "250k_500k": "$250k - $500k",
    "500k_1m": "$500k - $1M",
    over_1m: "Over $1M",
    undecided: "Undecided",
  }
  return map[budget ?? ""] ?? "Not specified"
}

function formatProjectType(type?: string): string {
  const map: Record<string, string> = {
    new_construction: "New construction",
    remodel: "Remodel",
    addition: "Addition",
    other: "Other",
  }
  return map[type ?? ""] ?? "Not specified"
}

function formatTimeline(timeline?: string): string {
  const map: Record<string, string> = {
    asap: "ASAP",
    "3_months": "Within 3 months",
    "6_months": "Within 6 months",
    "1_year": "Within 1 year",
    flexible: "Flexible",
  }
  return map[timeline ?? ""] ?? "Not specified"
}

export function ProspectDetailSheet({ contactId, open, onOpenChange, teamMembers }: ProspectDetailSheetProps) {
  const [prospect, setProspect] = useState<Prospect | null>(null)
  const [activity, setActivity] = useState<CrmActivity[]>([])
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const [touchOpen, setTouchOpen] = useState(false)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)

  useEffect(() => {
    if (!open || !contactId) return
    startTransition(async () => {
      try {
        const [prospectData, activityData] = await Promise.all([
          getProspectAction(contactId),
          getProspectActivityAction(contactId),
        ])
        setProspect(prospectData)
        setActivity(activityData)
      } catch (error) {
        toast({ title: "Unable to load prospect", description: (error as Error).message })
      }
    })
  }, [contactId, open, toast])

  const ownerName = teamMembers.find((m) => m.user.id === prospect?.lead_owner_user_id)?.user.full_name ?? "Unassigned"
  const followUp = formatFollowUp(prospect?.next_follow_up_at)

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Prospect details</SheetTitle>
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-8rem)] pr-2">
            {!prospect || isPending ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : (
              <div className="space-y-4 py-2">
                <div>
                  <h3 className="text-lg font-semibold">{prospect.full_name}</h3>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <LeadStatusBadge status={prospect.lead_status ?? "new"} />
                    <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
                    {prospect.has_estimate && <Badge variant="outline">Has estimate</Badge>}
                  </div>
                </div>

                {/* Quick actions */}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setTouchOpen(true)}>
                    Add activity
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFollowUpOpen(true)}>
                    Set follow-up
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>
                    Change status
                  </Button>
                </div>

                {/* Follow-up banner */}
                {prospect.next_follow_up_at && (
                  <div
                    className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
                      followUp.isOverdue
                        ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                        : followUp.isToday
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <Clock className="h-4 w-4" />
                    <span>
                      Follow-up: <strong>{followUp.text}</strong>
                      {followUp.isOverdue && " (overdue)"}
                    </span>
                  </div>
                )}

                {/* Contact info */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Contact info</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {prospect.phone && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="h-4 w-4" />
                        <a href={`tel:${prospect.phone}`} className="hover:underline">
                          {prospect.phone}
                        </a>
                      </div>
                    )}
                    {prospect.email && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Mail className="h-4 w-4" />
                        <a href={`mailto:${prospect.email}`} className="hover:underline">
                          {prospect.email}
                        </a>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <User className="h-4 w-4" />
                      <span>Owner: {ownerName}</span>
                    </div>
                    {prospect.crm_source && (
                      <div className="text-xs text-muted-foreground">
                        Source: {prospect.crm_source}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Project details */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Project details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-xs uppercase tracking-wide">Type</span>
                        <p className="text-foreground">{formatProjectType(prospect.lead_project_type)}</p>
                      </div>
                      <div>
                        <span className="text-xs uppercase tracking-wide">Budget</span>
                        <p className="text-foreground">{formatBudgetRange(prospect.lead_budget_range)}</p>
                      </div>
                      <div>
                        <span className="text-xs uppercase tracking-wide">Timeline</span>
                        <p className="text-foreground">{formatTimeline(prospect.lead_timeline_preference)}</p>
                      </div>
                      {prospect.last_contacted_at && (
                        <div>
                          <span className="text-xs uppercase tracking-wide">Last contact</span>
                          <p className="text-foreground">
                            {formatDistanceToNow(new Date(prospect.last_contacted_at), { addSuffix: true })}
                          </p>
                        </div>
                      )}
                    </div>
                    {prospect.jobsite_location && (
                      <div className="flex items-start gap-2 pt-2">
                        <MapPin className="h-4 w-4 mt-0.5" />
                        <div>
                          {prospect.jobsite_location.street && <div>{prospect.jobsite_location.street}</div>}
                          {(prospect.jobsite_location.city || prospect.jobsite_location.state) && (
                            <div>
                              {prospect.jobsite_location.city}
                              {prospect.jobsite_location.city && prospect.jobsite_location.state && ", "}
                              {prospect.jobsite_location.state}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {prospect.notes && (
                      <div className="pt-2 whitespace-pre-wrap border-t mt-2">
                        {prospect.notes}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Activity timeline */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Activity</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {activity.length === 0 ? (
                      <p className="text-muted-foreground">No activity recorded yet.</p>
                    ) : (
                      activity.map((item) => (
                        <div key={item.id} className="border-l-2 pl-3 py-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{item.title}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                            </span>
                          </div>
                          {item.description && (
                            <p className="text-muted-foreground text-xs mt-1">{item.description}</p>
                          )}
                          <Badge variant="outline" className="mt-1 text-xs">
                            {item.touch_type ?? item.event_type.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                <Separator />

                {/* Actions footer */}
                <div className="flex justify-between gap-2">
                  <Button variant="outline" asChild>
                    <Link href={`/estimates?recipient=${prospect.id}`}>
                      <Receipt className="h-4 w-4 mr-2" />
                      Create estimate
                    </Link>
                  </Button>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {prospect && (
        <>
          <AddTouchDialog
            open={touchOpen}
            onOpenChange={setTouchOpen}
            contactId={prospect.id}
            contactName={prospect.full_name}
          />
          <FollowUpDialog
            open={followUpOpen}
            onOpenChange={setFollowUpOpen}
            contactId={prospect.id}
            contactName={prospect.full_name}
            currentFollowUp={prospect.next_follow_up_at}
          />
          <ChangeStatusDialog
            open={statusOpen}
            onOpenChange={setStatusOpen}
            contactId={prospect.id}
            contactName={prospect.full_name}
            currentStatus={prospect.lead_status ?? "new"}
          />
        </>
      )}
    </>
  )
}
