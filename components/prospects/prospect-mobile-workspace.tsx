"use client"

import { useEffect, useMemo, useState } from "react"

import type { TeamMember } from "@/lib/types"
import type { Prospect } from "@/lib/services/prospects"
import { AddProspectDialog } from "@/components/prospects/add-prospect-dialog"
import { ProspectDetailSheet } from "@/components/prospects/prospect-detail-sheet"
import { ALL_FUNNEL_STAGE_META, type FunnelStage, type PipelineStageKey } from "@/components/prospects/prospect-funnel-bar"
import type { AttentionCounts, AttentionFilter } from "@/components/pipeline/pipeline-attention-strip"
import type {
  PipelineCommunityOption,
  PipelineMode,
  ProspectReservationInfo,
} from "@/components/prospects/prospect-presentation"
import { isDerivedStage } from "@/components/prospects/prospect-presentation"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn, formatMoneyCents } from "@/lib/utils"
import { ChevronRight, Receipt, Search, Send, Timer, UserPlus, X } from "@/components/icons"

const STAGE_META_BY_KEY = new Map(ALL_FUNNEL_STAGE_META.map((meta) => [meta.key, meta]))

interface PipelineMobileWorkspaceProps {
  mode: PipelineMode
  funnelStages: FunnelStage[]
  attentionCounts: AttentionCounts
  newInquiries: Prospect[]
  prospects: Prospect[]
  teamMembers: TeamMember[]
  communities: PipelineCommunityOption[]
  reservationsByProspect: Record<string, ProspectReservationInfo>
  canCreate?: boolean
}

const statusLabels: Record<PipelineStageKey, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  pricing: "Pricing",
  estimate_sent: "Estimate sent",
  changes_requested: "Changes requested",
  client_approved: "Client approved",
  executed: "Executed",
  won: "Won",
  lost: "Lost",
  reserved: "Reserved",
  converted: "Under agreement",
}

function contactLine(prospect: Prospect) {
  const contact = prospect.primary_contact ?? prospect.contacts?.[0]
  return contact?.full_name ?? contact?.email ?? contact?.phone ?? "No contact"
}

export function PipelineMobileWorkspace({
  mode,
  funnelStages,
  attentionCounts,
  newInquiries,
  prospects,
  teamMembers,
  communities,
  reservationsByProspect,
  canCreate = false,
}: PipelineMobileWorkspaceProps) {
  const [search, setSearch] = useState("")
  const [activeStatus, setActiveStatus] = useState<PipelineStageKey | null>(null)
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editProspect, setEditProspect] = useState<Prospect | null>(null)
  const { setAction } = useMobileAction()

  useEffect(() => {
    if (!canCreate) return
    setAction({ label: "Add prospect", onAction: () => setAddOpen(true) })
    return () => setAction(null)
  }, [canCreate, setAction])

  const attentionChips = useMemo(
    () =>
      (
        mode === "production"
          ? []
          : (
              [
                { key: "changes_requested", label: "Changes", count: attentionCounts.changes_requested, tone: "text-orange-600 border-orange-500/40 bg-orange-500/10" },
                { key: "estimate_sent", label: "Awaiting client", count: attentionCounts.estimate_sent, tone: "text-blue-600 border-blue-500/40 bg-blue-500/10" },
                { key: "executed", label: "Ready to convert", count: attentionCounts.executed, tone: "text-emerald-600 border-emerald-500/40 bg-emerald-500/10" },
              ] satisfies Array<{ key: AttentionFilter; label: string; count: number; tone: string }>
            )
      ).filter((chip) => chip.count > 0),
    [attentionCounts, mode],
  )

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return prospects.filter((prospect) => {
      const reservation = reservationsByProspect[prospect.id]
      // With no stage selected, focus on active prospects and keep closed ones out of the default list.
      const matchesStatus = activeStatus
        ? isDerivedStage(activeStatus)
          ? activeStatus === "reserved"
            ? reservation?.status === "hold" || reservation?.status === "reserved"
            : reservation?.status === "converted"
          : prospect.status === activeStatus
        : prospect.status !== "won" && prospect.status !== "lost"
      const haystack = [prospect.name, contactLine(prospect), prospect.source ?? "", prospect.community_name ?? ""]
        .join(" ")
        .toLowerCase()
      return matchesStatus && (!term || haystack.includes(term))
    })
  }, [activeStatus, prospects, reservationsByProspect, search])

  const openProspect = (id: string) => {
    setDetailId(id)
    setDetailOpen(true)
  }

  const toggleStatus = (status: PipelineStageKey) => setActiveStatus((current) => (current === status ? null : status))

  return (
    <>
      <div className="-mx-4 -mt-6 pb-4">
        <div className="flex gap-2 overflow-x-auto px-4 pt-4 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {funnelStages.map((stage) => {
            const meta = STAGE_META_BY_KEY.get(stage.key)
            const isActive = activeStatus === stage.key
            return (
              <button
                key={stage.key}
                type="button"
                onClick={() => toggleStatus(stage.key)}
                aria-pressed={isActive}
                className={cn(
                  "flex w-[120px] shrink-0 flex-col border bg-gradient-to-br p-3 text-left transition-all",
                  meta?.gradient,
                  meta?.border,
                  isActive && cn("ring-2 ring-offset-1 ring-offset-background", meta?.activeRing),
                )}
              >
                <span className={cn("text-2xl font-bold tabular-nums leading-none", meta?.text)}>{stage.count}</span>
                <span className="mt-1 truncate text-xs font-medium text-foreground">{statusLabels[stage.key]}</span>
                {meta?.bearsValue && stage.valueCents > 0 ? (
                  <span className="mt-0.5 truncate text-[11px] font-medium tabular-nums text-muted-foreground">
                    {formatMoneyCents(stage.valueCents)}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        {attentionChips.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {attentionCounts.stalled > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600">
                <Timer className="h-3.5 w-3.5" />
                <span className="tabular-nums font-semibold">{attentionCounts.stalled}</span> Stalled
              </span>
            ) : null}
            {attentionChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => toggleStatus(chip.key as PipelineStageKey)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium",
                  chip.tone,
                  activeStatus === chip.key && "ring-1 ring-current/30",
                )}
              >
                {chip.key === "estimate_sent" ? <Send className="h-3.5 w-3.5" /> : null}
                <span className="tabular-nums font-semibold">{chip.count}</span> {chip.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search prospects"
              className="pl-9"
            />
          </div>
        </div>

        {activeStatus ? (
          <div className="px-4 pb-1">
            <Button variant="outline" size="sm" onClick={() => setActiveStatus(null)} className="h-7 gap-1.5 text-xs">
              {statusLabels[activeStatus]}
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : null}

        {!activeStatus && !search && newInquiries.length > 0 ? (
          <>
            <SectionHeader label="New inquiries" />
            <div className="divide-y border-y bg-card">
              {newInquiries.slice(0, 4).map((prospect) => (
                <ProspectRow key={prospect.id} prospect={prospect} onClick={() => openProspect(prospect.id)} />
              ))}
            </div>
          </>
        ) : null}

        <SectionHeader label={activeStatus ? statusLabels[activeStatus] : "Active prospects"} />
        {filtered.length === 0 ? (
          <div className="flex items-center gap-3 border-y bg-card px-4 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <UserPlus className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No prospects found</p>
              <p className="text-xs text-muted-foreground">Tap + to capture one.</p>
            </div>
          </div>
        ) : (
          <div className="divide-y border-y bg-card">
            {filtered.map((prospect) => (
              <ProspectRow
                key={prospect.id}
                prospect={prospect}
                reservation={reservationsByProspect[prospect.id]}
                onClick={() => openProspect(prospect.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ProspectDetailSheet
        prospectId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        teamMembers={teamMembers}
        onEditProspect={(p) => {
          setDetailOpen(false)
          setEditProspect(p)
        }}
      />
      <AddProspectDialog
        open={Boolean(editProspect) || addOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditProspect(null)
            setAddOpen(false)
          }
        }}
        teamMembers={teamMembers}
        prospect={editProspect}
        mode={mode}
        communities={communities}
      />
    </>
  )
}

function SectionHeader({ label }: { label: string }) {
  return <div className="px-4 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
}

function ProspectRow({
  prospect,
  reservation,
  onClick,
}: {
  prospect: Prospect
  reservation?: ProspectReservationInfo
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 bg-card px-4 py-3 text-left active:bg-muted/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{prospect.name}</span>
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
            {reservation ? statusLabels[reservation.status === "converted" ? "converted" : "reserved"] : statusLabels[prospect.status]}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {reservation?.lotLabel
            ? `${reservation.communityName ?? "Community"} · Lot ${reservation.lotLabel}`
            : contactLine(prospect)}
        </p>
      </div>
      {reservation && reservation.askingPriceCents > 0 ? (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {formatMoneyCents(reservation.askingPriceCents)}
        </span>
      ) : prospect.estimate_value_cents ? (
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {formatMoneyCents(prospect.estimate_value_cents)}
        </span>
      ) : prospect.estimate_count ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" />
          {prospect.estimate_count}
        </span>
      ) : null}
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </button>
  )
}
