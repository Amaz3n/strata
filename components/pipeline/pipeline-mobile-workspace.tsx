"use client"

import { useMemo, useState, useTransition, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { formatDistanceToNow, format, isToday, isYesterday } from "date-fns"

import type { TeamMember } from "@/lib/types"
import type { Prospect, CrmActivity } from "@/lib/services/crm"
import type { Opportunity } from "@/lib/services/opportunities"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import type { LeadStatus } from "@/lib/validation/crm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer"
import { LeadStatusBadge, LeadPriorityBadge } from "@/components/pipeline/lead-status-badge"
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge"
import { ProspectDetailSheet } from "@/components/pipeline/prospect-detail-sheet"
import { OpportunityDetailSheet } from "@/components/opportunities/opportunity-detail-sheet"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { createProspectAction } from "@/app/(app)/pipeline/actions"
import { cn } from "@/lib/utils"
import {
  Plus,
  Phone,
  Mail,
  MessageSquare,
  ChevronRight,
  Zap,
  TrendingUp,
  Receipt,
  Clock,
  Users,
  UserPlus,
  Loader2,
} from "@/components/icons"

interface PipelineMobileWorkspaceProps {
  opportunityCounts: Record<OpportunityStatus, number>
  overdueFollowUps: Prospect[]
  upcomingFollowUps: Prospect[]
  newInquiries: Prospect[]
  recentActivity: CrmActivity[]
  prospects: Prospect[]
  opportunities: Opportunity[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canManageProjects?: boolean
}

type MobileView = "feed" | "deals" | "leads"

const DEAL_STAGES: { key: OpportunityStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "estimating", label: "Estimating" },
  { key: "proposed", label: "Proposed" },
]

const DEAL_FILTERS: ("all" | OpportunityStatus)[] = [
  "all",
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
  "won",
  "lost",
]

const LEAD_FILTERS: ("all" | LeadStatus)[] = ["all", "new", "contacted", "qualified", "estimating", "won", "lost"]

const STAGE_TEXT: Record<OpportunityStatus, string> = {
  new: "text-blue-600 dark:text-blue-400",
  contacted: "text-slate-600 dark:text-slate-400",
  qualified: "text-purple-600 dark:text-purple-400",
  estimating: "text-amber-600 dark:text-amber-400",
  proposed: "text-emerald-600 dark:text-emerald-400",
  won: "text-emerald-600 dark:text-emerald-400",
  lost: "text-red-600 dark:text-red-400",
}

const AVATAR_GRADIENTS = [
  "from-blue-500 to-indigo-600",
  "from-violet-500 to-purple-600",
  "from-cyan-500 to-blue-600",
  "from-indigo-500 to-blue-600",
  "from-blue-600 to-violet-600",
]

function gradientForId(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]
}

function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function formatBudgetRange(budget?: string | null): string | null {
  const map: Record<string, string> = {
    under_100k: "Under $100k",
    "100k_250k": "$100k–$250k",
    "250k_500k": "$250k–$500k",
    "500k_1m": "$500k–$1M",
    over_1m: "Over $1M",
    undecided: "Undecided",
  }
  return map[budget ?? ""] ?? null
}

function formatTimeline(timeline?: string | null): string | null {
  const map: Record<string, string> = {
    asap: "ASAP",
    "3_months": "≤ 3 months",
    "6_months": "≤ 6 months",
    "1_year": "≤ 1 year",
    flexible: "Flexible",
  }
  return map[timeline ?? ""] ?? null
}

function timestampLabel(value: string) {
  const date = new Date(value)
  if (isToday(date)) return `Today ${format(date, "h:mm a")}`
  if (isYesterday(date)) return `Yesterday ${format(date, "h:mm a")}`
  return format(date, "MMM d")
}

function capitalize(s: string) {
  return s[0].toUpperCase() + s.slice(1)
}

export function PipelineMobileWorkspace({
  opportunityCounts,
  overdueFollowUps,
  upcomingFollowUps,
  newInquiries,
  recentActivity,
  prospects,
  opportunities,
  teamMembers,
  canCreate = false,
  canManageProjects = false,
}: PipelineMobileWorkspaceProps) {
  const [view, setView] = useState<MobileView>("feed")
  const [dealFilter, setDealFilter] = useState<"all" | OpportunityStatus>("all")
  const [leadFilter, setLeadFilter] = useState<"all" | LeadStatus>("all")
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const { setAction } = useMobileAction()

  // Show the quick-add button beside the bottom-nav menu while this page is mounted.
  useEffect(() => {
    if (!canCreate) return
    setAction({ label: "Add prospect", onAction: () => setQuickAddOpen(true) })
    return () => setAction(null)
  }, [canCreate, setAction])

  const [prospectDetailId, setProspectDetailId] = useState<string | undefined>()
  const [prospectDetailOpen, setProspectDetailOpen] = useState(false)
  const [dealDetailId, setDealDetailId] = useState<string | undefined>()
  const [dealDetailOpen, setDealDetailOpen] = useState(false)

  const openProspect = (id: string) => {
    setProspectDetailId(id)
    setProspectDetailOpen(true)
  }
  const openDeal = (id: string) => {
    setDealDetailId(id)
    setDealDetailOpen(true)
  }

  const getOwnerName = (userId?: string | null) => {
    if (!userId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === userId)?.user.full_name ?? "Unknown"
  }

  const filteredDeals = useMemo(
    () => opportunities.filter((o) => dealFilter === "all" || o.status === dealFilter),
    [opportunities, dealFilter],
  )
  const filteredLeads = useMemo(
    () => prospects.filter((p) => leadFilter === "all" || (p.lead_status ?? "new") === leadFilter),
    [prospects, leadFilter],
  )

  const activeTotal = DEAL_STAGES.reduce((sum, s) => sum + opportunityCounts[s.key], 0)

  const goToDeals = (status: "all" | OpportunityStatus) => {
    setDealFilter(status)
    setView("deals")
  }
  const goToLeads = () => {
    setLeadFilter("all")
    setView("leads")
  }

  return (
    <>
      {/* Full-bleed surface: cancel the page's px-4 pt-6 so the feed runs edge to edge */}
      <div className="-mx-4 -mt-6">
        {view === "feed" ? (
          <Feed
            opportunityCounts={opportunityCounts}
            activeTotal={activeTotal}
            overdueFollowUps={overdueFollowUps}
            upcomingFollowUps={upcomingFollowUps}
            newInquiries={newInquiries}
            recentActivity={recentActivity}
            dealsTotal={opportunities.length}
            leadsTotal={prospects.length}
            onStageTap={goToDeals}
            onOpenLead={openProspect}
            onBrowseDeals={() => goToDeals("all")}
            onBrowseLeads={goToLeads}
          />
        ) : view === "deals" ? (
          <ListView
            title="Deals"
            count={filteredDeals.length}
            empty="No deals match this filter."
            onBack={() => setView("feed")}
            chips={DEAL_FILTERS.map((f) => ({ key: f, label: f === "all" ? "All" : capitalize(f), active: dealFilter === f }))}
            onChip={(key) => setDealFilter(key as "all" | OpportunityStatus)}
          >
            {filteredDeals.map((deal) => (
              <DealRow key={deal.id} deal={deal} ownerName={getOwnerName(deal.owner_user_id)} onClick={() => openDeal(deal.id)} />
            ))}
          </ListView>
        ) : (
          <ListView
            title="Leads"
            count={filteredLeads.length}
            empty="No leads match this filter."
            onBack={() => setView("feed")}
            chips={LEAD_FILTERS.map((f) => ({ key: f, label: f === "all" ? "All" : capitalize(f), active: leadFilter === f }))}
            onChip={(key) => setLeadFilter(key as "all" | LeadStatus)}
          >
            {filteredLeads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onClick={() => openProspect(lead.id)} />
            ))}
          </ListView>
        )}
      </div>

      {/* Detail sheets (reused from desktop) */}
      <ProspectDetailSheet
        contactId={prospectDetailId}
        open={prospectDetailOpen}
        onOpenChange={setProspectDetailOpen}
        teamMembers={teamMembers}
      />
      <OpportunityDetailSheet
        opportunityId={dealDetailId}
        open={dealDetailOpen}
        onOpenChange={setDealDetailOpen}
        teamMembers={teamMembers}
        canManageProjects={canManageProjects}
      />

      {canCreate ? <QuickAddDrawer open={quickAddOpen} onOpenChange={setQuickAddOpen} teamMembers={teamMembers} /> : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

interface FeedProps {
  opportunityCounts: Record<OpportunityStatus, number>
  activeTotal: number
  overdueFollowUps: Prospect[]
  upcomingFollowUps: Prospect[]
  newInquiries: Prospect[]
  recentActivity: CrmActivity[]
  dealsTotal: number
  leadsTotal: number
  onStageTap: (status: OpportunityStatus) => void
  onOpenLead: (id: string) => void
  onBrowseDeals: () => void
  onBrowseLeads: () => void
}

function Feed({
  opportunityCounts,
  activeTotal,
  overdueFollowUps,
  upcomingFollowUps,
  newInquiries,
  recentActivity,
  dealsTotal,
  leadsTotal,
  onStageTap,
  onOpenLead,
  onBrowseDeals,
  onBrowseLeads,
}: FeedProps) {
  const recent = recentActivity.slice(0, 5)
  const allCaughtUp = overdueFollowUps.length === 0 && upcomingFollowUps.length === 0

  return (
    <div className="pb-4">
      {/* Pipeline snapshot — the horizontal strip */}
      <div className="flex gap-2 overflow-x-auto px-4 pt-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {DEAL_STAGES.map((stage) => {
          const count = opportunityCounts[stage.key]
          return (
            <button
              key={stage.key}
              type="button"
              onClick={() => onStageTap(stage.key)}
              className="flex w-[92px] shrink-0 flex-col rounded-xl border bg-card p-3 text-left transition-transform active:scale-[0.97]"
            >
              <span className={cn("text-2xl font-bold tabular-nums", STAGE_TEXT[stage.key])}>{count}</span>
              <span className="mt-0.5 truncate text-xs font-medium text-muted-foreground">{stage.label}</span>
            </button>
          )
        })}
      </div>

      {/* Needs attention */}
      <SectionHeader
        label="Needs attention"
        right={
          !allCaughtUp ? (
            <span className="flex items-center gap-2">
              {overdueFollowUps.length > 0 ? (
                <span className="font-medium text-red-600 dark:text-red-400">{overdueFollowUps.length} overdue</span>
              ) : null}
              {upcomingFollowUps.length > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">{upcomingFollowUps.length} due soon</span>
              ) : null}
            </span>
          ) : null
        }
      />
      {allCaughtUp ? (
        <div className="flex items-center gap-3 border-y bg-card px-4 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
            <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <p className="text-sm font-medium">All caught up</p>
            <p className="text-xs text-muted-foreground">No follow-ups due</p>
          </div>
        </div>
      ) : (
        <div className="divide-y border-y bg-card">
          {overdueFollowUps.slice(0, 5).map((p) => (
            <FollowUpRow key={p.id} prospect={p} tone="overdue" onClick={() => onOpenLead(p.id)} />
          ))}
          {upcomingFollowUps.slice(0, 5).map((p) => (
            <FollowUpRow key={p.id} prospect={p} tone="soon" onClick={() => onOpenLead(p.id)} />
          ))}
        </div>
      )}

      {/* New inquiries */}
      <SectionHeader label="New inquiries" />
      {newInquiries.length === 0 ? (
        <div className="flex items-center gap-3 border-y bg-card px-4 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <UserPlus className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium">No new inquiries</p>
            <p className="text-xs text-muted-foreground">Tap + to capture a lead</p>
          </div>
        </div>
      ) : (
        <div className="divide-y border-y bg-card">
          {newInquiries.slice(0, 6).map((p) => (
            <InquiryRow key={p.id} prospect={p} onClick={() => onOpenLead(p.id)} />
          ))}
        </div>
      )}

      {/* Recent activity */}
      {recent.length > 0 ? (
        <>
          <SectionHeader label="Recent activity" />
          <div className="divide-y border-y bg-card">
            {recent.map((item) => (
              <ActivityRow key={item.id} item={item} onClick={() => item.entity_id && onOpenLead(item.entity_id)} />
            ))}
          </div>
        </>
      ) : null}

      {/* Browse all */}
      <SectionHeader label="Browse" />
      <div className="divide-y border-y bg-card">
        <BrowseRow label="All deals" count={dealsTotal} onClick={onBrowseDeals} />
        <BrowseRow label="All leads" count={leadsTotal} onClick={onBrowseLeads} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function FollowUpRow({ prospect, tone, onClick }: { prospect: Prospect; tone: "overdue" | "soon"; onClick: () => void }) {
  const due = prospect.next_follow_up_at ? new Date(prospect.next_follow_up_at) : null
  const dueLabel = due
    ? tone === "soon" && isToday(due)
      ? format(due, "h:mm a")
      : formatDistanceToNow(due, { addSuffix: true })
    : ""
  return (
    <div className="flex items-center bg-card active:bg-muted/50">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", tone === "overdue" ? "bg-red-500" : "bg-amber-500")} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{prospect.full_name}</p>
          <div className="mt-0.5 flex items-center gap-2">
            <LeadStatusBadge status={prospect.lead_status ?? "new"} className="px-1.5 py-0 text-[10px]" />
            <span className={cn("text-xs font-medium", tone === "overdue" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
              {dueLabel}
            </span>
          </div>
        </div>
      </button>
      <QuickContact phone={prospect.phone} email={prospect.email} />
    </div>
  )
}

function InquiryRow({ prospect, onClick }: { prospect: Prospect; onClick: () => void }) {
  const isHot = prospect.lead_priority === "high" || prospect.lead_priority === "urgent"
  return (
    <div className="flex items-center bg-card active:bg-muted/50">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-xs font-medium text-white", gradientForId(prospect.id))}>
          {getInitials(prospect.full_name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <span className="truncate">{prospect.full_name}</span>
            {isHot ? (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-amber-400 to-orange-500">
                <Zap className="h-2.5 w-2.5 text-white" />
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {prospect.crm_source ? `${prospect.crm_source} · ` : ""}
            {timestampLabel(prospect.created_at)}
          </p>
        </div>
      </button>
      <QuickContact phone={prospect.phone} email={prospect.email} />
    </div>
  )
}

function ActivityRow({ item, onClick }: { item: CrmActivity; onClick: () => void }) {
  const { icon: Icon, bg, color } = activityStyle(item)
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!item.entity_id}
      className="flex w-full items-center gap-3 bg-card px-4 py-3 text-left active:bg-muted/50 disabled:active:bg-card"
    >
      <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", bg)}>
        <Icon className={cn("h-4 w-4", color)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-tight">
          {item.contact_name ? <span className="font-medium">{item.contact_name}</span> : null}
          {item.contact_name && item.title ? <span className="mx-1.5 text-muted-foreground">·</span> : null}
          <span className="text-muted-foreground">{item.title}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{timestampLabel(item.created_at)}</p>
      </div>
    </button>
  )
}

function BrowseRow({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 bg-card px-4 py-3.5 text-left active:bg-muted/50">
      <span className="flex-1 text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  )
}

function DealRow({ deal, ownerName, onClick }: { deal: Opportunity; ownerName: string; onClick: () => void }) {
  const meta = [ownerName, formatBudgetRange(deal.budget_range), formatTimeline(deal.timeline_preference)].filter(Boolean)
  return (
    <button type="button" onClick={onClick} className="flex w-full flex-col gap-1 bg-card px-4 py-3 text-left active:bg-muted/50">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{deal.name}</span>
        <OpportunityStatusBadge status={deal.status} />
      </div>
      <span className="truncate text-sm text-muted-foreground">{deal.client_contact?.full_name ?? "Unknown client"}</span>
      {meta.length > 0 ? <span className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</span> : null}
    </button>
  )
}

function LeadRow({ lead, onClick }: { lead: Prospect; onClick: () => void }) {
  return (
    <div className="flex items-center bg-card active:bg-muted/50">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 flex-col gap-1 py-3 pl-4 text-left">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{lead.full_name}</span>
          <LeadPriorityBadge priority={lead.lead_priority ?? "normal"} className="px-1.5 py-0 text-[10px]" />
        </div>
        <div className="flex items-center gap-2">
          <LeadStatusBadge status={lead.lead_status ?? "new"} className="px-1.5 py-0 text-[10px]" />
          <span className="truncate text-xs text-muted-foreground">
            {lead.next_follow_up_at
              ? `Follow-up ${format(new Date(lead.next_follow_up_at), "MMM d")}`
              : lead.last_contacted_at
                ? `Last touched ${format(new Date(lead.last_contacted_at), "MMM d")}`
                : (lead.crm_source ?? "—")}
          </span>
        </div>
      </button>
      <QuickContact phone={lead.phone} email={lead.email} />
    </div>
  )
}

function QuickContact({ phone, email }: { phone?: string | null; email?: string | null }) {
  if (!phone && !email) return <span className="w-3 shrink-0" />
  return (
    <div className="flex shrink-0 items-center gap-1 pl-1 pr-3">
      {phone ? (
        <a
          href={`tel:${phone}`}
          onClick={(e) => e.stopPropagation()}
          aria-label="Call"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 active:bg-green-200 dark:bg-green-900/30"
        >
          <Phone className="h-4 w-4 text-green-700 dark:text-green-400" />
        </a>
      ) : null}
      {email ? (
        <a
          href={`mailto:${email}`}
          onClick={(e) => e.stopPropagation()}
          aria-label="Email"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 active:bg-blue-200 dark:bg-blue-900/30"
        >
          <Mail className="h-4 w-4 text-blue-700 dark:text-blue-400" />
        </a>
      ) : null}
    </div>
  )
}

function activityStyle(item: CrmActivity) {
  if (item.event_type === "crm_prospect_created")
    return { icon: UserPlus, bg: "bg-blue-100 dark:bg-blue-900/30", color: "text-blue-600 dark:text-blue-400" }
  if (item.event_type === "crm_lead_status_changed")
    return { icon: TrendingUp, bg: "bg-purple-100 dark:bg-purple-900/30", color: "text-purple-600 dark:text-purple-400" }
  if (item.event_type === "crm_follow_up_set")
    return { icon: Clock, bg: "bg-amber-100 dark:bg-amber-900/30", color: "text-amber-600 dark:text-amber-400" }
  if (item.event_type === "crm_estimate_created")
    return { icon: Receipt, bg: "bg-green-100 dark:bg-green-900/30", color: "text-green-600 dark:text-green-400" }
  if (item.touch_type === "call")
    return { icon: Phone, bg: "bg-green-100 dark:bg-green-900/30", color: "text-green-600 dark:text-green-400" }
  if (item.touch_type === "email")
    return { icon: Mail, bg: "bg-blue-100 dark:bg-blue-900/30", color: "text-blue-600 dark:text-blue-400" }
  if (item.touch_type === "meeting" || item.touch_type === "site_visit")
    return { icon: Users, bg: "bg-indigo-100 dark:bg-indigo-900/30", color: "text-indigo-600 dark:text-indigo-400" }
  return { icon: MessageSquare, bg: "bg-muted", color: "text-muted-foreground" }
}

// ---------------------------------------------------------------------------
// Section header + list view shell
// ---------------------------------------------------------------------------

function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{label}</span>
      {right ? <span className="ml-auto font-medium normal-case tracking-normal">{right}</span> : null}
    </div>
  )
}

function ListView({
  title,
  count,
  empty,
  onBack,
  chips,
  onChip,
  children,
}: {
  title: string
  count: number
  empty: string
  onBack: () => void
  chips: { key: string; label: string; active: boolean }[]
  onChip: (key: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="pb-4">
      <div className="flex items-center gap-1 px-2 pt-3">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="flex h-10 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
        >
          <ChevronRight className="h-5 w-5 rotate-180" />
        </button>
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">{count}</span>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => onChip(chip.key)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              chip.active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground active:bg-muted",
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {count === 0 ? (
        <p className="px-4 py-12 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y border-y bg-card">{children}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Quick add drawer
// ---------------------------------------------------------------------------

function QuickAddDrawer({
  open,
  onOpenChange,
  teamMembers,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [source, setSource] = useState("")
  const [owner, setOwner] = useState<string | undefined>()

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80)
    } else {
      setName("")
      setPhone("")
      setSource("")
      setOwner(undefined)
    }
  }, [open])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    startTransition(async () => {
      try {
        await createProspectAction({
          full_name: name.trim(),
          phone: phone.trim() || undefined,
          crm_source: source.trim() || undefined,
          lead_owner_user_id: owner,
          lead_priority: "normal",
        })
        router.refresh()
        toast.success("Prospect added", { description: name.trim() })
        onOpenChange(false)
      } catch (error) {
        toast.error("Failed to add prospect", { description: (error as Error).message })
      }
    })
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader className="px-4 pb-2 pt-4 text-left">
          <DrawerTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" />
            Quick add prospect
          </DrawerTitle>
        </DrawerHeader>
        <form onSubmit={submit} className="flex flex-col gap-3 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="qa-name" className="text-xs">
              Name *
            </Label>
            <Input ref={inputRef} id="qa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Smith" className="h-11" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-phone" className="text-xs">
              Phone
            </Label>
            <Input id="qa-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-5555" inputMode="tel" className="h-11" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="qa-source" className="text-xs">
                Source
              </Label>
              <Input id="qa-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Referral" className="h-11" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Owner</Label>
              <Select value={owner ?? "none"} onValueChange={(v) => setOwner(v === "none" ? undefined : v)}>
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="Assign" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {teamMembers.map((member) => (
                    <SelectItem key={member.user.id} value={member.user.id}>
                      {member.user.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button type="submit" className="mt-1 h-11" disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Add prospect
              </>
            )}
          </Button>
        </form>
      </DrawerContent>
    </Drawer>
  )
}
