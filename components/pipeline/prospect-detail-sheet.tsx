"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { addDays, format, formatDistanceToNow } from "date-fns"

import type { Prospect, ProspectActivity } from "@/lib/services/prospects"
import type { Contact, CostCode, Estimate, TeamMember } from "@/lib/types"
import type { EstimateInput } from "@/lib/validation/estimates"
import {
  getEstimateCreateDataAction,
  getProspectAction,
  listProspectActivityAction,
  listProspectEstimatesAction,
  setProspectFollowUpAction,
} from "@/app/(app)/pipeline/actions"
import {
  createEstimateAction,
  createEstimateVersionAction,
  getEstimateBuilderSigningLinkAction,
  getEstimateForEditAction,
  getEstimateShareLinkAction,
  sendEstimateAction,
} from "@/app/(app)/estimates/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import {
  Activity as ActivityIcon,
  ArrowRight,
  Bell,
  Briefcase,
  Building2,
  Copy,
  ExternalLink,
  FileText,
  Hammer,
  Mail,
  MapPin,
  MessageSquare,
  PenLine,
  Phone,
  Plus,
  Receipt,
  Send,
  User,
  X,
} from "@/components/icons"
import { cn, formatPhone, formatLocalDate } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { ConvertProspectSheet } from "./convert-prospect-sheet"
import { EstimateCreateSheet, type EstimateSheetInitial, type EstimateTemplateOption } from "@/components/estimates/estimate-create-sheet"
import { EstimateActivitySheet } from "@/components/estimates/estimate-activity-sheet"

interface ProspectDetailSheetProps {
  prospectId?: string
  contactId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
  onEditProspect?: (prospect: Prospect) => void
}

const statusLabels: Record<string, string> = {
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
}

const estimateStatusLabels: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  client_signed: "Client signed",
  executed: "Executed",
  converted_to_project: "Project created",
  rejected: "Rejected",
  changes_requested: "Changes requested",
}

const estimateStatusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/15 text-success border-success/30",
  client_signed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  executed: "bg-success/20 text-success border-success/40",
  converted_to_project: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  changes_requested: "bg-amber-500/15 text-amber-600 border-amber-500/30",
}

function resolveEstimateStatus(status?: string | null): string {
  return status && estimateStatusLabels[status] ? status : "draft"
}

function formatBudgetRange(budget?: string | null): string {
  const map: Record<string, string> = {
    under_100k: "Under $100k",
    "100k_250k": "$100k – $250k",
    "250k_500k": "$250k – $500k",
    "500k_1m": "$500k – $1M",
    over_1m: "Over $1M",
    undecided: "Undecided",
  }
  return map[budget ?? ""] ?? "Not set"
}

function formatProjectType(type?: string | null): string {
  const map: Record<string, string> = {
    new_construction: "New construction",
    remodel: "Remodel",
    addition: "Addition",
    renovation: "Renovation",
    repair: "Repair",
    other: "Other",
  }
  return map[type ?? ""] ?? "Not set"
}

function formatTimeline(timeline?: string | null): string {
  const map: Record<string, string> = {
    asap: "ASAP",
    "3_months": "Within 3 months",
    "6_months": "Within 6 months",
    "1_year": "Within 1 year",
    flexible: "Flexible",
  }
  return map[timeline ?? ""] ?? "Not set"
}

function formatActivityType(eventType: string): string {
  const map: Record<string, string> = {
    prospect_created: "Prospect created",
    prospect_updated: "Prospect updated",
    prospect_status_changed: "Stage changed",
    prospect_deleted: "Prospect deleted",
    prospect_contact_added: "Contact added",
    prospect_contact_updated: "Contact updated",
    prospect_estimate_created: "Estimate created",
    estimate_sent: "Estimate sent",
    estimate_viewed: "Estimate opened by client",
    estimate_client_signed: "Estimate signed by client",
    estimate_changes_requested: "Changes requested by client",
    estimate_rejected: "Estimate rejected by client",
    estimate_executed: "Estimate executed (signed)",
    estimate_comment_added: "New estimate message",
  }
  return map[eventType] ?? eventType.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}

function renderActivityDetails(event: ProspectActivity): React.ReactNode {
  const p = event.payload as any
  if (!p) return null

  switch (event.event_type) {
    case "prospect_estimate_created":
      return p.estimate_title ? (
        <span className="text-xs text-muted-foreground">
          Created estimate <span className="font-medium text-foreground">"{p.estimate_title}"</span>
        </span>
      ) : null
    case "estimate_sent":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Sent estimate <span className="font-medium text-foreground">"{p.title}"</span>
          {p.recipient_email ? ` to ${p.recipient_email}` : ""}
        </span>
      ) : null
    case "estimate_viewed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Client viewed estimate <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null
    case "estimate_client_signed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Signed by <span className="font-medium text-foreground">{p.by || "Client"}</span> for estimate <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null
    case "estimate_changes_requested":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Changes requested by <span className="font-medium text-foreground">{p.by || "Client"}</span> on estimate <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null
    case "estimate_rejected":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Rejected by <span className="font-medium text-foreground">{p.by || "Client"}</span> on estimate <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null
    case "estimate_executed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Countersigned by <span className="font-medium text-foreground">{p.signer_name || "Builder"}</span> — estimate <span className="font-medium text-foreground">"{p.title}"</span> is executed
        </span>
      ) : null
    case "estimate_comment_added":
      return (
        <span className="text-xs text-muted-foreground">
          Comment posted by <span className="font-medium text-foreground">{p.author_type === "client" ? "Client" : "Builder"}</span>
        </span>
      )
    case "prospect_status_changed":
      return p.new_status ? (
        <span className="text-xs text-muted-foreground">
          Moved from <span className="capitalize">{p.old_status || "unknown"}</span> to <span className="font-medium text-foreground capitalize">{p.new_status}</span>
        </span>
      ) : null
    default:
      return null
  }
}

function formatCurrency(cents?: number | null): string {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function resolveRecipientId(prospect: Prospect, contacts: Contact[]): string | undefined {
  const pc = prospect.primary_contact ?? prospect.contacts?.[0]
  if (!pc) return undefined
  if (pc.promoted_contact_id) return pc.promoted_contact_id
  if (pc.contact_id) return pc.contact_id
  if (pc.email) {
    const email = pc.email.toLowerCase()
    const match = contacts.find((c) => c.email?.toLowerCase() === email)
    if (match) return match.id
  }
  return undefined
}

type EstimateRow = Estimate & { recipient_name?: string | null }

interface NextStep {
  tone: "info" | "warning" | "success" | "muted"
  title: string
  body: string
}

function deriveNextStep(prospect: Prospect, estimates: EstimateRow[]): NextStep {
  if (prospect.project_id) {
    return { tone: "success", title: "Project created", body: "This prospect has been converted. Open the project to keep working." }
  }
  switch (prospect.status) {
    case "executed":
      return { tone: "success", title: "Ready to convert", body: "The estimate is executed. Create the project to start the job." }
    case "client_approved":
      return { tone: "info", title: "Awaiting countersignature", body: "The client signed. Countersign the estimate to execute it." }
    case "estimate_sent":
      return { tone: "info", title: "Waiting on client", body: "The estimate is out for review. Follow up if it stalls." }
    case "changes_requested":
      return { tone: "warning", title: "Changes requested", body: "The client asked for changes. Revise the estimate and resend." }
    case "lost":
      return { tone: "muted", title: "Marked lost", body: prospect.lost_reason ? `Reason: ${prospect.lost_reason}` : "This prospect is no longer active." }
    default:
      if (estimates.length === 0) {
        return { tone: "info", title: "Create an estimate", body: "Price the job and send an estimate to move this prospect forward." }
      }
      return { tone: "info", title: "Send the estimate", body: "A draft estimate exists. Send it to the client when it's ready." }
  }
}

const nextStepTone: Record<NextStep["tone"], string> = {
  info: "border-blue-500/30 bg-blue-500/5",
  warning: "border-amber-500/30 bg-amber-500/5",
  success: "border-success/30 bg-success/5",
  muted: "border-border bg-muted/30",
}

export function ProspectDetailSheet({
  prospectId,
  contactId,
  open,
  onOpenChange,
  teamMembers,
  onEditProspect,
}: ProspectDetailSheetProps) {
  const router = useRouter()
  const { toast } = useToast()
  const resolvedProspectId = prospectId ?? contactId

  const [prospect, setProspect] = useState<Prospect | null>(null)
  const [isPending, startTransition] = useTransition()
  const [estimates, setEstimates] = useState<EstimateRow[]>([])
  const [activity, setActivity] = useState<ProspectActivity[]>([])
  const [tab, setTab] = useState<"overview" | "estimates" | "activity">("overview")

  const [convertOpen, setConvertOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loadingCreateData, setLoadingCreateData] = useState(false)
  const [createData, setCreateData] = useState<{
    contacts: Contact[]
    costCodes: CostCode[]
    defaultTerms: string
    defaultIntro?: string
    templates?: EstimateTemplateOption[]
  } | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [copyingId, setCopyingId] = useState<string | null>(null)
  const [signingId, setSigningId] = useState<string | null>(null)
  const [openingReviseId, setOpeningReviseId] = useState<string | null>(null)
  const [revising, setRevising] = useState(false)
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseTarget, setReviseTarget] = useState<{
    estimateId: string
    initial: EstimateSheetInitial
    changes: string | null
  } | null>(null)
  const [activityEstimate, setActivityEstimate] = useState<EstimateRow | null>(null)

  const refreshProspect = useCallback(async () => {
    if (!resolvedProspectId) return
    const [next, rows, events] = await Promise.all([
      getProspectAction(resolvedProspectId),
      listProspectEstimatesAction(resolvedProspectId),
      listProspectActivityAction(resolvedProspectId),
    ])
    setProspect(next)
    setEstimates(rows)
    setActivity(events)
  }, [resolvedProspectId])

  useEffect(() => {
    if (!open || !resolvedProspectId) return
    setTab("overview")
    startTransition(async () => {
      try {
        await refreshProspect()
      } catch (error) {
        toast({ title: "Unable to load prospect", description: (error as Error).message })
      }
    })
  }, [resolvedProspectId, open, refreshProspect, toast])

  const primaryContact = prospect?.primary_contact ?? prospect?.contacts?.[0]
  const ownerName =
    teamMembers.find((m) => m.user.id === prospect?.owner_user_id)?.user.full_name ?? "Unassigned"
  const nextStep = prospect ? deriveNextStep(prospect, estimates) : null

  async function ensureCreateData() {
    if (createData) return createData
    setLoadingCreateData(true)
    try {
      const data = await getEstimateCreateDataAction()
      setCreateData(data)
      return data
    } finally {
      setLoadingCreateData(false)
    }
  }

  async function handleNewEstimate() {
    try {
      await ensureCreateData()
      setCreateOpen(true)
    } catch (error) {
      toast({ title: "Couldn't open estimate form", description: (error as Error).message })
    }
  }

  async function handleCreateEstimate(input: EstimateInput) {
    if (!prospect) return
    setCreating(true)
    try {
      const estimate = await createEstimateAction({ ...input, prospect_id: prospect.id })
      const recipient = createData?.contacts.find((c) => c.id === estimate.recipient_contact_id)
      setEstimates((prev) => [{ ...estimate, recipient_name: recipient?.full_name ?? null }, ...prev])
      setCreateOpen(false)
      toast({ title: "Estimate created", description: "Draft saved to this prospect." })
      await refreshProspect()
      router.refresh()
    } catch (error) {
      toast({ title: "Failed to create estimate", description: (error as Error).message })
    } finally {
      setCreating(false)
    }
  }

  async function handleSend(estimateId: string) {
    setSendingId(estimateId)
    try {
      const result = await sendEstimateAction(estimateId)
      setEstimates((prev) => prev.map((e) => (e.id === estimateId ? { ...e, status: "sent" } : e)))
      await copyToClipboard(result.url)
      toast({
        title: result.emailSent ? "Estimate sent" : "Estimate marked sent",
        description: result.emailSent ? "Review link copied to clipboard." : "Email skipped — link copied.",
      })
      await refreshProspect()
      router.refresh()
    } catch (error) {
      toast({ title: "Couldn't send estimate", description: (error as Error).message })
    } finally {
      setSendingId(null)
    }
  }

  async function handleCopyLink(estimateId: string) {
    setCopyingId(estimateId)
    try {
      const result = await getEstimateShareLinkAction(estimateId)
      await copyToClipboard(result.url)
      toast({ title: "Review link copied" })
    } catch (error) {
      toast({ title: "Couldn't create link", description: (error as Error).message })
    } finally {
      setCopyingId(null)
    }
  }

  async function handleOpenBuilderSigning(estimateId: string) {
    setSigningId(estimateId)
    try {
      const result = await getEstimateBuilderSigningLinkAction(estimateId)
      if (!result.url) {
        throw new Error("Signing link was not returned.")
      }
      const signingUrl = new URL(result.url, window.location.origin)
      if (!signingUrl.pathname.startsWith("/d/")) {
        throw new Error("Signing link did not point to a document signing request.")
      }
      window.location.assign(signingUrl.toString())
      toast({ title: "Builder signing opened", description: result.signerEmail ? `Assigned to ${result.signerEmail}.` : undefined })
    } catch (error) {
      toast({ title: "Couldn't open signing request", description: (error as Error).message })
    } finally {
      setSigningId(null)
    }
  }

  async function handleOpenRevise(estimateId: string) {
    setOpeningReviseId(estimateId)
    try {
      await ensureCreateData()
      const initial = await getEstimateForEditAction(estimateId)
      setReviseTarget({ estimateId, initial, changes: initial.decision_note })
      setReviseOpen(true)
    } catch (error) {
      toast({ title: "Couldn't open revision", description: (error as Error).message })
    } finally {
      setOpeningReviseId(null)
    }
  }

  async function handleSubmitRevision(input: EstimateInput) {
    if (!reviseTarget) return
    setRevising(true)
    try {
      await createEstimateVersionAction(reviseTarget.estimateId, { ...input, prospect_id: prospect?.id })
      setReviseOpen(false)
      setReviseTarget(null)
      toast({ title: "New version created", description: "Send the revised estimate when it's ready." })
      await refreshProspect()
      router.refresh()
    } catch (error) {
      toast({ title: "Failed to save revision", description: (error as Error).message })
    } finally {
      setRevising(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        {!prospect || isPending ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            <SheetHeader className="space-y-0 px-6 pb-0 pt-6 text-left">
              <div className="flex items-start justify-between gap-3 mr-6">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-lg leading-tight">{prospect.name}</SheetTitle>
                    <SheetDescription className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span>Created on {format(new Date(prospect.created_at), "MM/dd/yy")}</span>
                    </SheetDescription>
                  </div>
                </div>
                {onEditProspect && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 px-2.5 text-xs"
                    onClick={() => onEditProspect(prospect)}
                  >
                    <PenLine className="mr-1 h-3.5 w-3.5" />
                    Edit
                  </Button>
                )}
              </div>
            </SheetHeader>

            <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex flex-1 flex-col overflow-hidden">
              <div className="border-b">
                <TabsList className="h-12 w-full justify-start gap-6 rounded-none border-0 bg-transparent p-0 px-6">
                  <TabsTrigger
                    value="overview"
                    className="h-12 rounded-none border-b-2 border-transparent px-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Overview
                  </TabsTrigger>
                  <TabsTrigger
                    value="estimates"
                    className="h-12 gap-2 rounded-none border-b-2 border-transparent px-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Estimates
                    {estimates.length > 0 ? (
                      <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{estimates.length}</span>
                    ) : null}
                  </TabsTrigger>
                  <TabsTrigger
                    value="activity"
                    className="h-12 rounded-none border-b-2 border-transparent px-0 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    Activity
                  </TabsTrigger>
                </TabsList>
              </div>

              <ScrollArea className="flex-1">
                <TabsContent value="overview" className="m-0 space-y-5 px-6 py-5 focus-visible:outline-none">
                  {nextStep ? (
                    <div className={cn("rounded-lg border p-3", nextStepTone[nextStep.tone])}>
                      <p className="text-sm font-medium">{nextStep.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{nextStep.body}</p>
                    </div>
                  ) : null}

                  {resolvedProspectId ? (
                    <FollowUpControl
                      prospectId={resolvedProspectId}
                      value={prospect.next_follow_up_at ?? null}
                      onChanged={refreshProspect}
                    />
                  ) : null}

                  <Section title="Primary contact">
                    <InfoRow icon={User} value={primaryContact?.full_name ?? "No contact added"} muted={!primaryContact?.full_name} />
                    <InfoRow
                      icon={Phone}
                      value={
                        primaryContact?.phone ? (
                          <a href={`tel:${primaryContact.phone}`} className="text-primary hover:underline">
                            {formatPhone(primaryContact.phone)}
                          </a>
                        ) : (
                          "No phone"
                        )
                      }
                      muted={!primaryContact?.phone}
                    />
                    <InfoRow
                      icon={Mail}
                      value={
                        primaryContact?.email ? (
                          <a href={`mailto:${primaryContact.email}`} className="text-primary hover:underline">
                            {primaryContact.email}
                          </a>
                        ) : (
                          "No email"
                        )
                      }
                      muted={!primaryContact?.email}
                    />
                    <InfoRow icon={Briefcase} value={`Lead owner: ${ownerName}`} />
                  </Section>

                  <Section title="Project details">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                      <Field label="Type" value={formatProjectType(prospect.project_type)} />
                      <Field label="Budget" value={formatBudgetRange(prospect.budget_range)} />
                      <Field label="Timeline" value={formatTimeline(prospect.timeline_preference)} />
                      <Field label="Stage" value={statusLabels[prospect.status] ?? prospect.status} />
                    </div>
                    {prospect.jobsite_location?.street || prospect.jobsite_location?.city || prospect.jobsite_location?.postal_code ? (
                      <div className="mt-3 flex items-start gap-2 border-t pt-3 text-sm text-muted-foreground">
                        <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          {prospect.jobsite_location.street ? <div>{prospect.jobsite_location.street}</div> : null}
                          {prospect.jobsite_location.city || prospect.jobsite_location.state || prospect.jobsite_location.postal_code ? (
                            <div>
                              {prospect.jobsite_location.city}
                              {prospect.jobsite_location.city && prospect.jobsite_location.state ? ", " : ""}
                              {prospect.jobsite_location.state}
                              {prospect.jobsite_location.postal_code ? ` ${prospect.jobsite_location.postal_code}` : ""}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    {prospect.notes ? (
                      <div className="mt-3 border-t pt-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Notes</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{prospect.notes}</p>
                      </div>
                    ) : null}
                  </Section>

                  <Section title="Workspaces">
                    <Button variant="outline" asChild className="w-full justify-start">
                      <Link href={`/pipeline/prospects/${prospect.id}/bids`}>
                        <Hammer className="mr-2 h-4 w-4" />
                        Bids
                        <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                      </Link>
                    </Button>
                  </Section>
                </TabsContent>

                <TabsContent value="estimates" className="m-0 space-y-3 px-6 py-5 focus-visible:outline-none">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Estimates</p>
                    <Button size="sm" onClick={handleNewEstimate} disabled={loadingCreateData}>
                      <Plus className="mr-1.5 h-4 w-4" />
                      {loadingCreateData ? "Loading…" : "New estimate"}
                    </Button>
                  </div>

                  {estimates.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-10 text-center">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                        <Receipt className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">No estimates yet</p>
                        <p className="text-xs text-muted-foreground">Create one to price the job and send it to the client.</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={handleNewEstimate} disabled={loadingCreateData}>
                        <Plus className="mr-1.5 h-4 w-4" />
                        Create estimate
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {estimates.map((estimate) => {
                        const statusKey = resolveEstimateStatus(estimate.status)
                        const superseded = estimate.is_current_version === false
                        return (
                          <div key={estimate.id} className="rounded-lg border p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium">{estimate.title}</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {formatCurrency(estimate.total_cents)}
                                  {estimate.version ? ` · v${estimate.version}` : ""}
                                  {superseded ? " · superseded" : ""}
                                </p>
                              </div>
                              <Badge variant="secondary" className={cn("shrink-0 border", estimateStatusStyles[statusKey])}>
                                {estimateStatusLabels[statusKey]}
                              </Badge>
                            </div>

                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              {estimate.recipient_name ?? primaryContact?.full_name ? (
                                <span>{estimate.recipient_name ?? primaryContact?.full_name}</span>
                              ) : null}
                              {estimate.sent_at ? <span>Sent {format(new Date(estimate.sent_at), "MMM d")}</span> : null}
                              {estimate.client_signed_at ? (
                                <span className="text-emerald-600">Signed {format(new Date(estimate.client_signed_at), "MMM d")}</span>
                              ) : null}
                              {estimate.valid_until ? <span>Valid to {formatLocalDate(estimate.valid_until, "MMM d")}</span> : null}
                            </div>

                            {statusKey === "changes_requested" && !superseded ? (
                              <div className="mt-2.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">
                                  Client requested changes
                                </p>
                                {estimate.decision_note ? (
                                  <p className="mt-1 whitespace-pre-line text-xs text-foreground">{estimate.decision_note}</p>
                                ) : (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    The client asked for changes — open the thread for details.
                                  </p>
                                )}
                                <div className="mt-2 flex items-center gap-1.5">
                                  <Button
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    onClick={() => void handleOpenRevise(estimate.id)}
                                    disabled={openingReviseId === estimate.id}
                                  >
                                    <PenLine className="mr-1.5 h-3.5 w-3.5" />
                                    {openingReviseId === estimate.id ? "Opening…" : "Revise estimate"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setActivityEstimate(estimate)}
                                  >
                                    <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                                    View thread
                                  </Button>
                                </div>
                              </div>
                            ) : null}

                            <div className="mt-2.5 flex items-center gap-1.5 border-t pt-2.5">
                              {statusKey !== "executed" && statusKey !== "converted_to_project" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => void handleSend(estimate.id)}
                                  disabled={sendingId === estimate.id}
                                >
                                  <Send className="mr-1.5 h-3.5 w-3.5" />
                                  {sendingId === estimate.id
                                    ? "Sending…"
                                    : estimate.sent_at
                                      ? "Resend"
                                      : "Send"}
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => void handleCopyLink(estimate.id)}
                                disabled={copyingId === estimate.id}
                              >
                                <Copy className="mr-1.5 h-3.5 w-3.5" />
                                Link
                              </Button>
                              <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                                <a href={`/estimates/${estimate.id}/export`} target="_blank" rel="noopener noreferrer">
                                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                                  PDF
                                </a>
                              </Button>
                              {estimate.sent_at ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setActivityEstimate(estimate)}
                                >
                                  <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                                  Thread
                                </Button>
                              ) : null}
                              {statusKey === "client_signed" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => void handleOpenBuilderSigning(estimate.id)}
                                  disabled={signingId === estimate.id}
                                >
                                  <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                                  {signingId === estimate.id ? "Opening..." : "Sign"}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="activity" className="m-0 px-6 py-5 focus-visible:outline-none">
                  {activity.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                      <ActivityIcon className="h-5 w-5" />
                      No activity recorded yet.
                    </div>
                  ) : (
                    <div className="space-y-0">
                      {activity.map((event, index) => {
                        const details = renderActivityDetails(event)
                        return (
                          <div key={event.id} className="flex gap-3">
                            <div className="flex flex-col items-center">
                              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/70" />
                              {index < activity.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                            </div>
                            <div className="pb-5">
                              <p className="text-sm font-medium">{formatActivityType(event.event_type)}</p>
                              {details && <div className="mt-0.5">{details}</div>}
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                {format(new Date(event.created_at), "MMM d, yyyy 'at' h:mm a")}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </TabsContent>
              </ScrollArea>
            </Tabs>

            <SheetFooter className="flex-row gap-2 border-t bg-background p-4 sm:flex-row sm:justify-stretch sm:space-x-0">
              <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
                Close
              </Button>
              {prospect.project_id ? (
                <Button asChild className="flex-1">
                  <Link href={`/projects/${prospect.project_id}`}>
                    Go to project
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              ) : prospect.status === "executed" ? (
                <Button
                  onClick={() => setConvertOpen(true)}
                  className="flex-1 gap-2 bg-success font-semibold text-white hover:bg-success/90"
                >
                  <Hammer className="h-4 w-4" />
                  Convert to project
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  disabled={loadingCreateData}
                  onClick={() => {
                    setTab("estimates")
                    void handleNewEstimate()
                  }}
                >
                  <Receipt className="mr-2 h-4 w-4" />
                  {loadingCreateData ? "Loading…" : "New estimate"}
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>

      {prospect && createData ? (
        <EstimateCreateSheet
          open={createOpen}
          onOpenChange={setCreateOpen}
          contacts={createData.contacts}
          costCodes={createData.costCodes}
          defaultTerms={createData.defaultTerms}
          defaultIntro={createData.defaultIntro}
          templates={createData.templates}
          defaultProspectId={prospect.id}
          defaultRecipientId={resolveRecipientId(prospect, createData.contacts)}
          prospectRecipient={
            primaryContact
              ? { name: primaryContact.full_name, email: primaryContact.email ?? null }
              : undefined
          }
          prospectContacts={(prospect.contacts ?? []).map((c) => ({ name: c.full_name, email: c.email ?? null }))}
          onCreate={handleCreateEstimate}
          loading={creating}
        />
      ) : null}

      {prospect && createData && reviseTarget ? (
        <EstimateCreateSheet
          key={`revise-${reviseTarget.estimateId}`}
          open={reviseOpen}
          onOpenChange={(open) => {
            setReviseOpen(open)
            if (!open) setReviseTarget(null)
          }}
          contacts={createData.contacts}
          costCodes={createData.costCodes}
          defaultTerms={createData.defaultTerms}
          defaultProspectId={prospect.id}
          mode="revise"
          initialEstimate={reviseTarget.initial}
          requestedChanges={reviseTarget.changes}
          prospectRecipient={
            reviseTarget.initial.recipient_name || reviseTarget.initial.recipient_email
              ? {
                  name: reviseTarget.initial.recipient_name ?? "",
                  email: reviseTarget.initial.recipient_email ?? null,
                }
              : primaryContact
                ? { name: primaryContact.full_name, email: primaryContact.email ?? null }
                : undefined
          }
          prospectContacts={(prospect.contacts ?? []).map((c) => ({ name: c.full_name, email: c.email ?? null }))}
          onCreate={handleSubmitRevision}
          loading={revising}
        />
      ) : null}

      <EstimateActivitySheet
        estimate={activityEstimate}
        open={!!activityEstimate}
        onOpenChange={(open) => {
          if (!open) setActivityEstimate(null)
        }}
      />

      {prospect ? (
        <ConvertProspectSheet
          prospect={prospect}
          open={convertOpen}
          onOpenChange={setConvertOpen}
          onSuccess={() => {
            onOpenChange(false)
            router.refresh()
          }}
        />
      ) : null}
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <Separator />
      <div className="space-y-2.5">{children}</div>
    </div>
  )
}

function combineDateTime(date: Date, time: string): Date {
  const [h, m] = time.split(":").map((n) => Number(n))
  const d = new Date(date)
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0)
  return d
}

function FollowUpControl({
  prospectId,
  value,
  onChanged,
}: {
  prospectId: string
  value: string | null
  onChanged: () => Promise<void>
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const date = value ? new Date(value) : null
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfTomorrow = addDays(startOfToday, 1)
  const isOverdue = date ? date < now : false
  const isDueToday = date ? date >= startOfToday && date < startOfTomorrow : false

  // Draft date + time edited inside the popover, seeded from the current value when opened.
  const [draftDate, setDraftDate] = useState<Date | undefined>(date ?? undefined)
  const [draftTime, setDraftTime] = useState<string>(date ? format(date, "HH:mm") : "09:00")

  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraftDate(date ?? undefined)
      setDraftTime(date ? format(date, "HH:mm") : "09:00")
    }
    setOpen(next)
  }

  const apply = (next: Date | null) => {
    startTransition(async () => {
      try {
        await setProspectFollowUpAction(prospectId, next ? next.toISOString() : null)
        await onChanged()
        setOpen(false)
        toast({ title: next ? "Follow-up scheduled" : "Follow-up cleared" })
      } catch (error) {
        toast({ title: "Failed to update follow-up", description: (error as Error).message })
      }
    })
  }

  const presets: Array<{ label: string; days: number }> = [
    { label: "Tomorrow", days: 1 },
    { label: "In 3 days", days: 3 },
    { label: "Next week", days: 7 },
  ]

  const tone = isOverdue
    ? "border-rose-500/40 bg-rose-500/5 text-rose-600 dark:text-rose-400"
    : isDueToday
      ? "border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400"
      : "border-border bg-muted/30 text-foreground"

  return (
    <div className={cn("flex items-center gap-3 rounded-lg border p-3", date ? tone : "border-dashed bg-muted/20")}>
      <Bell className={cn("h-4 w-4 shrink-0", !date && "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        {date ? (
          <>
            <p className="text-sm font-medium">Follow up {format(date, "MMM d, yyyy 'at' h:mm a")}</p>
            <p className="text-xs text-muted-foreground">
              {isOverdue ? "Overdue · " : ""}
              {formatDistanceToNow(date, { addSuffix: true })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No follow-up scheduled</p>
        )}
      </div>

      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={isPending}>
            {date ? "Change" : "Set follow-up"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="end">
          <div className="grid grid-cols-3 gap-1 border-b p-2">
            {presets.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                className="px-1 text-xs"
                disabled={isPending}
                onClick={() => setDraftDate(addDays(startOfToday, preset.days))}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Calendar mode="single" selected={draftDate} onSelect={setDraftDate} initialFocus className="w-full" />
          <div className="flex items-center gap-2 border-t p-3">
            <Input
              id="follow-up-time"
              type="time"
              value={draftTime}
              onChange={(event) => setDraftTime(event.target.value)}
              className="h-9 flex-1"
            />
            <Button
              disabled={isPending || !draftDate}
              onClick={() => draftDate && apply(combineDateTime(draftDate, draftTime))}
            >
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {date ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={isPending}
          onClick={() => apply(null)}
          aria-label="Clear follow-up"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  )
}

function InfoRow({
  icon: Icon,
  value,
  muted,
}: {
  icon: React.ComponentType<{ className?: string }>
  value: React.ReactNode
  muted?: boolean
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className={cn(muted && "italic text-muted-foreground")}>{value}</span>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm">{value}</p>
    </div>
  )
}

async function copyToClipboard(text: string) {
  try {
    if (navigator?.clipboard) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to legacy path
  }
  const textArea = document.createElement("textarea")
  textArea.value = text
  textArea.style.position = "fixed"
  textArea.style.left = "-9999px"
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  try {
    document.execCommand("copy")
  } finally {
    document.body.removeChild(textArea)
  }
}
