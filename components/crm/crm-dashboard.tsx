"use client"

import { useState } from "react"
import Link from "next/link"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { TeamMember } from "@/lib/types"
import type { Prospect, CrmDashboardStats } from "@/lib/services/crm"
import { LeadStatusBadge, LeadPriorityBadge } from "./lead-status-badge"
import { ProspectDetailSheet } from "./prospect-detail-sheet"
import { AddTouchDialog } from "./add-touch-dialog"
import { FollowUpDialog } from "./follow-up-dialog"
import { AddProspectDialog } from "./add-prospect-dialog"
import { Clock, AlertTriangle, Users, Receipt, TrendingUp, TrendingDown, Plus } from "@/components/icons"
import { formatDistanceToNow, format, isPast, isToday } from "date-fns"

interface CrmDashboardProps {
  stats: CrmDashboardStats
  followUpsDue: Prospect[]
  newInquiries: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
}

export function CrmDashboard({
  stats,
  followUpsDue,
  newInquiries,
  teamMembers,
  canCreate = false,
  canEdit = false,
}: CrmDashboardProps) {
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

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Follow-ups Due</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.followUpsDueToday}
              {stats.followUpsOverdue > 0 && (
                <span className="text-red-600 dark:text-red-400 ml-2 text-base">
                  +{stats.followUpsOverdue} overdue
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Inquiries</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.newInquiries}</div>
            <p className="text-xs text-muted-foreground">Awaiting contact</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">In Estimating</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.inEstimating}</div>
            <p className="text-xs text-muted-foreground">Active proposals</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-green-500" />
              <TrendingDown className="h-4 w-4 text-red-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <span className="text-green-600 dark:text-green-400">{stats.wonThisMonth}</span>
              {" / "}
              <span className="text-red-600 dark:text-red-400">{stats.lostThisMonth}</span>
            </div>
            <p className="text-xs text-muted-foreground">Won / Lost</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Follow-ups due */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Follow-ups Due
                </CardTitle>
                <CardDescription>Prospects that need attention</CardDescription>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href="/crm/prospects?filter=followup">View all</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {followUpsDue.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No follow-ups due. Great job!</p>
            ) : (
              <div className="space-y-3">
                {followUpsDue.slice(0, 5).map((prospect) => (
                  <div
                    key={prospect.id}
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 cursor-pointer"
                    onClick={() => openDetail(prospect.id)}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{prospect.full_name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LeadStatusBadge status={prospect.lead_status ?? "new"} />
                        {prospect.phone && <span>{prospect.phone}</span>}
                      </div>
                    </div>
                    <div className={`text-sm whitespace-nowrap ${getFollowUpClass(prospect.next_follow_up_at)}`}>
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
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* New inquiries */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-blue-500" />
                  New Inquiries
                </CardTitle>
                <CardDescription>Recent prospects to contact</CardDescription>
              </div>
              {canCreate && (
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {newInquiries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No new inquiries.</p>
            ) : (
              <div className="space-y-3">
                {newInquiries.slice(0, 5).map((prospect) => (
                  <div
                    key={prospect.id}
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 cursor-pointer"
                    onClick={() => openDetail(prospect.id)}
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{prospect.full_name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {prospect.crm_source && <span>{prospect.crm_source}</span>}
                        {prospect.phone && <span>{prospect.phone}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(prospect.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                ))}
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
