"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import type { TeamMember } from "@/lib/types"
import type { Prospect, CrmActivity } from "@/lib/services/crm"
import { getProspectAction, getProspectActivityAction, updateProspectAction } from "@/app/(app)/pipeline/actions"
import { LeadStatusBadge, LeadPriorityBadge } from "./lead-status-badge"
import { AddTouchDialog } from "./add-touch-dialog"
import { FollowUpDialog } from "./follow-up-dialog"
import { ChangeStatusDialog } from "./change-status-dialog"
import {
  Mail,
  Phone,
  Clock,
  Loader2,
  MapPin,
  User,
  Receipt,
  Edit,
  CheckCircle,
  X,
  ExternalLink,
  MessageSquare,
  Calendar,
  Activity,
} from "@/components/icons"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow, format, isPast, isToday } from "date-fns"
import { cn } from "@/lib/utils"

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

function getActivityIcon(eventType: string) {
  if (eventType.includes("call")) return Phone
  if (eventType.includes("email")) return Mail
  if (eventType.includes("meeting") || eventType.includes("site_visit")) return Calendar
  if (eventType.includes("status")) return Activity
  return MessageSquare
}

interface EditableFieldProps {
  value: string
  onSave: (value: string) => Promise<void>
  placeholder?: string
  type?: "text" | "textarea"
}

function EditableField({ value, onSave, placeholder, type = "text" }: EditableFieldProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = async () => {
    if (editValue === value) {
      setIsEditing(false)
      return
    }
    setIsSaving(true)
    try {
      await onSave(editValue)
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setEditValue(value)
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <div className="flex items-start gap-1">
        {type === "textarea" ? (
          <Textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder={placeholder}
            className="text-sm min-h-[60px]"
            autoFocus
          />
        ) : (
          <Input
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder={placeholder}
            className="h-8 text-sm"
            autoFocus
          />
        )}
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={handleSave} disabled={isSaving}>
          {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={handleCancel} disabled={isSaving}>
          <X className="h-3 w-3" />
        </Button>
      </div>
    )
  }

  return (
    <button
      className="group flex items-center gap-1 text-left hover:text-primary transition-colors"
      onClick={() => setIsEditing(true)}
    >
      <span className={cn(!value && "text-muted-foreground italic")}>{value || placeholder || "Click to add"}</span>
      <Edit className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity" />
    </button>
  )
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

  const handleUpdateField = async (field: string, value: string) => {
    if (!prospect) return
    try {
      await updateProspectAction(prospect.id, { [field]: value || undefined })
      setProspect((prev) => prev ? { ...prev, [field]: value || undefined } : prev)
      toast({ title: "Updated" })
    } catch (error) {
      toast({ title: "Failed to update", description: (error as Error).message })
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col fast-sheet-animation"
          style={{
            animationDuration: '150ms',
            transitionDuration: '150ms'
          } as React.CSSProperties}
        >
          <div className="flex-1 overflow-y-auto px-4">
            <div className="pt-6 pb-4">
              <SheetTitle className="text-lg font-semibold leading-none tracking-tight">Prospect details</SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground mt-2">
                View and manage prospect information
              </SheetDescription>
            </div>

            {!prospect || isPending ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-32" />
                <div className="space-y-2">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                  {/* Header */}
                  <div>
                    <h3 className="text-xl font-semibold">{prospect.full_name}</h3>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <LeadStatusBadge status={prospect.lead_status ?? "new"} />
                      <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
                      {prospect.has_estimate && (
                        <Badge variant="outline" className="gap-1">
                          <Receipt className="h-3 w-3" />
                          {prospect.estimate_count} estimate{prospect.estimate_count !== 1 && "s"}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Quick actions */}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setTouchOpen(true)}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      Add activity
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setFollowUpOpen(true)}>
                      <Calendar className="h-4 w-4 mr-2" />
                      Set follow-up
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>
                      <Activity className="h-4 w-4 mr-2" />
                      Change status
                    </Button>
                  </div>

                  {/* Follow-up banner */}
                  {prospect.next_follow_up_at && (
                    <div
                      className={cn(
                        "flex items-center gap-2 p-3 rounded-lg text-sm",
                        followUp.isOverdue
                          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                          : followUp.isToday
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                      )}
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
                      <CardTitle className="text-sm font-medium">Contact info</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                        {prospect.phone ? (
                          <a href={`tel:${prospect.phone}`} className="hover:underline text-primary">
                            {prospect.phone}
                          </a>
                        ) : (
                          <span className="text-muted-foreground italic">No phone</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                        {prospect.email ? (
                          <a href={`mailto:${prospect.email}`} className="hover:underline text-primary">
                            {prospect.email}
                          </a>
                        ) : (
                          <span className="text-muted-foreground italic">No email</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span>Owner: {ownerName}</span>
                      </div>
                      {prospect.crm_source && (
                        <div className="text-xs text-muted-foreground pt-1">
                          Source: {prospect.crm_source}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Project details */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Project details</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">Type</span>
                          <p className="text-foreground">{formatProjectType(prospect.lead_project_type)}</p>
                        </div>
                        <div>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">Budget</span>
                          <p className="text-foreground">{formatBudgetRange(prospect.lead_budget_range)}</p>
                        </div>
                        <div>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">Timeline</span>
                          <p className="text-foreground">{formatTimeline(prospect.lead_timeline_preference)}</p>
                        </div>
                        {prospect.last_contacted_at && (
                          <div>
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Last contact</span>
                            <p className="text-foreground">
                              {formatDistanceToNow(new Date(prospect.last_contacted_at), { addSuffix: true })}
                            </p>
                          </div>
                        )}
                      </div>
                      {prospect.jobsite_location && (
                        <div className="flex items-start gap-2 pt-3 mt-3 border-t">
                          <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                          <div className="text-muted-foreground">
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
                        <div className="pt-3 mt-3 border-t">
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">Notes</span>
                          <p className="text-foreground whitespace-pre-wrap mt-1">{prospect.notes}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Related estimates */}
                  {prospect.has_estimate && (
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-medium">Related estimates</CardTitle>
                          <Button variant="ghost" size="sm" asChild className="text-xs h-7">
                            <Link href={`/estimates?recipient=${prospect.id}`}>
                              View all
                              <ExternalLink className="h-3 w-3 ml-1" />
                            </Link>
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Receipt className="h-4 w-4" />
                          <span>{prospect.estimate_count} estimate{prospect.estimate_count !== 1 && "s"} linked</span>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Activity timeline */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Activity</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm">
                      {activity.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-6 text-center">
                          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-2">
                            <MessageSquare className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <p className="text-muted-foreground text-sm">No activity recorded yet</p>
                          <Button variant="link" size="sm" className="mt-1" onClick={() => setTouchOpen(true)}>
                            Add first activity
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {activity.map((item) => {
                            const Icon = getActivityIcon(item.event_type)
                            return (
                              <div key={item.id} className="flex gap-3">
                                <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                                  <Icon className="h-3 w-3 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium truncate">{item.title}</span>
                                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                                      {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
                                    </span>
                                  </div>
                                  {item.description && (
                                    <p className="text-muted-foreground text-xs mt-0.5 line-clamp-2">{item.description}</p>
                                  )}
                                  <Badge variant="outline" className="mt-1 text-[10px] px-1.5 py-0">
                                    {item.touch_type ?? item.event_type.replace(/crm_|_/g, " ").trim()}
                                  </Badge>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
          </div>

          {/* Footer actions */}
          {prospect && (
            <div className="flex-shrink-0 border-t bg-background p-4">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
                  Close
                </Button>
                <Button variant="default" asChild className="flex-1">
                  <Link href={`/estimates?recipient=${prospect.id}`}>
                    <Receipt className="h-4 w-4 mr-2" />
                    Create estimate
                  </Link>
                </Button>
              </div>
            </div>
          )}
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
