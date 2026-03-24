"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import type { TeamMember } from "@/lib/types"
import type { Opportunity } from "@/lib/services/opportunities"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import {
  activateOpportunityProjectAction,
  getOpportunityAction,
  startEstimatingAction,
  updateOpportunityAction,
} from "@/app/(app)/pipeline/opportunity-actions"
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Mail, Phone, Loader2, MapPin, Briefcase, Receipt, Target, ArrowRight } from "@/components/icons"

const statusOptions: OpportunityStatus[] = [
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
  "won",
  "lost",
]

function formatBudgetRange(budget?: string | null): string {
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

function formatProjectType(type?: string | null): string {
  const map: Record<string, string> = {
    new_construction: "New construction",
    remodel: "Remodel",
    addition: "Addition",
    other: "Other",
  }
  return map[type ?? ""] ?? "Not specified"
}

function formatTimeline(timeline?: string | null): string {
  const map: Record<string, string> = {
    asap: "ASAP",
    "3_months": "Within 3 months",
    "6_months": "Within 6 months",
    "1_year": "Within 1 year",
    flexible: "Flexible",
  }
  return map[timeline ?? ""] ?? "Not specified"
}

interface OpportunityDetailSheetProps {
  opportunityId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
  canManageProjects?: boolean
}

export function OpportunityDetailSheet({
  opportunityId,
  open,
  onOpenChange,
  teamMembers,
  canManageProjects = false,
}: OpportunityDetailSheetProps) {
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null)
  const [isLoading, startLoadingTransition] = useTransition()
  const [isSaving, startSavingTransition] = useTransition()
  const [isActing, startActionTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [name, setName] = useState("")
  const [status, setStatus] = useState<OpportunityStatus>("new")
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [projectType, setProjectType] = useState<string | undefined>()
  const [budgetRange, setBudgetRange] = useState<string | undefined>()
  const [timelinePreference, setTimelinePreference] = useState<string | undefined>()
  const [source, setSource] = useState("")
  const [notes, setNotes] = useState("")
  const [street, setStreet] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [postalCode, setPostalCode] = useState("")

  useEffect(() => {
    if (!open || !opportunityId) return
    startLoadingTransition(async () => {
      try {
        const data = await getOpportunityAction(opportunityId)
        setOpportunity(data)
        setName(data.name ?? "")
        setStatus(data.status)
        setOwnerId(data.owner_user_id ?? null)
        setProjectType(data.project_type ?? undefined)
        setBudgetRange(data.budget_range ?? undefined)
        setTimelinePreference(data.timeline_preference ?? undefined)
        setSource(data.source ?? "")
        setNotes(data.notes ?? "")
        setStreet(data.jobsite_location?.street ?? "")
        setCity(data.jobsite_location?.city ?? "")
        setState(data.jobsite_location?.state ?? "")
        setPostalCode(data.jobsite_location?.postal_code ?? "")
      } catch (error) {
        toast({ title: "Unable to load opportunity", description: (error as Error).message })
      }
    })
  }, [opportunityId, open, toast])

  const ownerName = useMemo(() => {
    if (!ownerId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === ownerId)?.user.full_name ?? "Unknown"
  }, [ownerId, teamMembers])

  const hasStatusDraft = !!opportunity && status !== opportunity.status

  const nextStep = useMemo(() => {
    const nextStatus = status
    switch (nextStatus) {
      case "new":
        return {
          title: "Qualify the opportunity",
          description: "Confirm scope, budget, timeline, and ownership before moving this into preconstruction.",
          checklist: ["Assign an owner", "Capture budget and timing", "Add jobsite details"],
        }
      case "contacted":
        return {
          title: "Keep qualification moving",
          description: "Record outreach, tighten the job details, and decide whether this should move into estimating.",
          checklist: ["Log the latest touch", "Clarify homeowner goals", "Decide if it is qualified"],
        }
      case "qualified":
        return {
          title: "Start preconstruction",
          description: "This is the point where a preconstruction project and estimate workspace become useful.",
          checklist: ["Create the precon project", "Gather plans and assumptions", "Start estimating"],
        }
      case "estimating":
        return {
          title: "Build the estimate",
          description: "Keep pricing, assumptions, and follow-ups moving so this can progress to proposal.",
          checklist: ["Refine scope and pricing", "Track assumptions", "Coordinate client follow-up"],
        }
      case "proposed":
        return {
          title: "Work the proposal",
          description: "Monitor revisions and decision timing so this closes as won or lost with context.",
          checklist: ["Track revisions", "Confirm next decision date", "Record the outcome"],
        }
      case "won":
        return {
          title: "Kick off delivery",
          description: "A won opportunity should hand off into an active project with the job setup underway.",
          checklist: ["Activate the project", "Assign the PM", "Start the kickoff checklist"],
        }
      case "lost":
        return {
          title: "Capture what happened",
          description: "Document why the job was lost and any future reopen path before the trail goes cold.",
          checklist: ["Record the loss context", "Capture reopen timing", "Revisit only if circumstances change"],
        }
      default:
        return {
          title: "Review the opportunity",
          description: "Keep the opportunity details current so the next handoff is clear.",
          checklist: ["Confirm the stage", "Update the owner", "Capture the latest context"],
        }
    }
  }, [status])

  const primaryAction = useMemo(() => {
    if (!opportunity) return null
    const stage = hasStatusDraft ? status : opportunity.status

    switch (stage) {
      case "new":
      case "contacted":
        return null
      case "qualified":
        return {
          label: opportunity.project ? "Open estimate workspace" : "Create estimate workspace",
          description: opportunity.project
            ? "The job is qualified. Open the linked preconstruction workspace and move into pricing."
            : "Create the preconstruction workspace now that the job is qualified.",
          kind: "estimate" as const,
        }
      case "estimating":
        return {
          label: opportunity.project ? "Continue estimating" : "Create estimate workspace",
          description: opportunity.project
            ? "Jump back into the estimate workspace and keep pricing moving."
            : "This stage expects a workspace. Create the preconstruction project and start pricing.",
          kind: "estimate" as const,
        }
      case "proposed":
        return {
          label: opportunity.project ? "Open precon workspace" : "Create precon workspace",
          description: opportunity.project
            ? "Use the linked workspace to manage revisions, pricing updates, and proposal follow-through."
            : "Create the linked workspace so proposal revisions and handoff have a home.",
          kind: "estimate" as const,
        }
      case "won":
        return {
          label: "Open active project",
          description: "Ensure the linked project is active and continue into project delivery.",
          kind: "project" as const,
        }
      case "lost":
        return null
      default:
        return {
          label: "Start estimating",
          description: "Create the preconstruction project and start building the estimate.",
          kind: "estimate" as const,
        }
    }
  }, [hasStatusDraft, opportunity, status])

  const handleSave = () => {
    if (!opportunity) return
    if (!name.trim()) {
      toast({ title: "Opportunity name is required" })
      return
    }
    startSavingTransition(async () => {
      try {
        const payload: Record<string, any> = {
          name: name.trim(),
          status,
          owner_user_id: ownerId ?? null,
          project_type: projectType ?? null,
          budget_range: budgetRange ?? null,
          timeline_preference: timelinePreference ?? null,
          source: source.trim() || null,
          notes: notes.trim() || null,
        }

        const location = {
          street: street.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          postal_code: postalCode.trim() || undefined,
        }

        const hasLocation = Object.values(location).some(Boolean)
        if (hasLocation) {
          payload.jobsite_location = location
        } else {
          payload.jobsite_location = undefined
        }

        const updated = await updateOpportunityAction(opportunity.id, payload)
        setOpportunity(updated)
        router.refresh()
        toast({ title: "Opportunity updated" })
      } catch (error) {
        toast({ title: "Unable to update opportunity", description: (error as Error).message })
      }
    })
  }

  const handleStartEstimating = () => {
    if (!opportunity) return
    startActionTransition(async () => {
      try {
        const result = opportunity.project
          ? {
              project_id: opportunity.project.id,
              client_contact_id: opportunity.client_contact_id,
            }
          : await startEstimatingAction(opportunity.id)
        const params = new URLSearchParams()
        params.set("project", result.project_id)
        if (result.client_contact_id) {
          params.set("recipient", result.client_contact_id)
        }
        router.push(`/estimates?${params.toString()}`)
      } catch (error) {
        toast({ title: "Unable to start estimating", description: (error as Error).message })
      }
    })
  }

  const handleOpenProject = () => {
    if (!opportunity) return
    startActionTransition(async () => {
      try {
        const result = await activateOpportunityProjectAction(opportunity.id)
        router.push(`/projects/${result.project_id}`)
      } catch (error) {
        toast({ title: "Unable to open project", description: (error as Error).message })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation [&>button]:hidden"
        style={{
          animationDuration: "150ms",
          transitionDuration: "150ms",
        }}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <SheetTitle className="flex items-center gap-2">
                <Briefcase className="h-5 w-5" />
                Opportunity details
              </SheetTitle>
              <SheetDescription>
                Review the deal, update the stage, and drive the right next step.
              </SheetDescription>
            </div>
            {opportunity && <OpportunityStatusBadge status={opportunity.status} />}
          </div>
        </SheetHeader>

        {!opportunity || isLoading ? (
          <div className="flex-1 px-6 py-4 space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-6 py-4 space-y-6">
                <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-lg font-semibold">{name || opportunity.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {opportunity.client_contact?.full_name ?? "Unknown client"}
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>Owner: {ownerName}</div>
                      <div>Source: {source || "Not specified"}</div>
                    </div>
                  </div>

                  <div className="rounded-lg border bg-background p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Target className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="font-medium">{nextStep.title}</div>
                        <p className="text-sm text-muted-foreground">{nextStep.description}</p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {nextStep.checklist.map((item) => (
                        <div key={item} className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                          {item}
                        </div>
                      ))}
                    </div>
                    {primaryAction && (
                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        <Button
                          onClick={primaryAction.kind === "project" ? handleOpenProject : handleStartEstimating}
                          disabled={isActing || hasStatusDraft || !canManageProjects}
                        >
                          {isActing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                          {!isActing && primaryAction.kind === "project" ? <Briefcase className="mr-2 h-4 w-4" /> : null}
                          {!isActing && primaryAction.kind === "estimate" ? <Receipt className="mr-2 h-4 w-4" /> : null}
                          {primaryAction.label}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          {primaryAction.description}
                        </p>
                      </div>
                    )}
                    {hasStatusDraft && (
                      <p className="text-xs text-amber-600">
                        Save changes to apply this stage before using the next-step action.
                      </p>
                    )}
                    {!canManageProjects && primaryAction && (
                      <p className="text-xs text-muted-foreground">
                        Project access is required for this next step.
                      </p>
                    )}
                  </div>
                </div>

                <section className="space-y-3">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">Summary</h3>
                    <p className="text-sm text-muted-foreground">Core deal information and stage settings.</p>
                  </div>
                  <div className="rounded-lg border bg-background p-4 space-y-4">
                <div className="space-y-2">
                  <Label>Opportunity name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select value={status} onValueChange={(value) => setStatus(value as OpportunityStatus)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {statusOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option[0].toUpperCase() + option.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Owner</Label>
                    <Select value={ownerId ?? "none"} onValueChange={(value) => setOwnerId(value === "none" ? null : value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select owner" />
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
                    <p className="text-xs text-muted-foreground">Assigned to {ownerName}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Source</Label>
                    <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Referral, Website, etc." />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Project type</Label>
                    <Select value={projectType ?? "none"} onValueChange={(value) => setProjectType(value === "none" ? undefined : value)}>
                      <SelectTrigger>
                        <SelectValue placeholder={formatProjectType(projectType)} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not specified</SelectItem>
                        <SelectItem value="new_construction">New construction</SelectItem>
                        <SelectItem value="remodel">Remodel</SelectItem>
                        <SelectItem value="addition">Addition</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Budget range</Label>
                    <Select value={budgetRange ?? "none"} onValueChange={(value) => setBudgetRange(value === "none" ? undefined : value)}>
                      <SelectTrigger>
                        <SelectValue placeholder={formatBudgetRange(budgetRange)} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not specified</SelectItem>
                        <SelectItem value="under_100k">Under $100k</SelectItem>
                        <SelectItem value="100k_250k">$100k - $250k</SelectItem>
                        <SelectItem value="250k_500k">$250k - $500k</SelectItem>
                        <SelectItem value="500k_1m">$500k - $1M</SelectItem>
                        <SelectItem value="over_1m">Over $1M</SelectItem>
                        <SelectItem value="undecided">Undecided</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Timeline</Label>
                    <Select value={timelinePreference ?? "none"} onValueChange={(value) => setTimelinePreference(value === "none" ? undefined : value)}>
                      <SelectTrigger>
                        <SelectValue placeholder={formatTimeline(timelinePreference)} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not specified</SelectItem>
                        <SelectItem value="asap">ASAP</SelectItem>
                        <SelectItem value="3_months">Within 3 months</SelectItem>
                        <SelectItem value="6_months">Within 6 months</SelectItem>
                        <SelectItem value="1_year">Within 1 year</SelectItem>
                        <SelectItem value="flexible">Flexible</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes about this opportunity" />
                </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">Client</h3>
                    <p className="text-sm text-muted-foreground">The primary contact tied to this opportunity.</p>
                  </div>
                  <div className="rounded-lg border bg-background p-4 space-y-4 text-sm">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-4 w-4 text-muted-foreground" />
                  <div className="font-medium">{opportunity.client_contact?.full_name ?? "Unknown client"}</div>
                </div>
                {opportunity.client_contact?.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${opportunity.client_contact.email}`} className="text-primary hover:underline">
                      {opportunity.client_contact.email}
                    </a>
                  </div>
                )}
                {opportunity.client_contact?.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${opportunity.client_contact.phone}`} className="text-primary hover:underline">
                      {opportunity.client_contact.phone}
                    </a>
                  </div>
                )}
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">Jobsite</h3>
                    <p className="text-sm text-muted-foreground">Location details for preconstruction and handoff.</p>
                  </div>
                  <div className="rounded-lg border bg-background p-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Street</Label>
                    <Input value={street} onChange={(e) => setStreet(e.target.value)} placeholder="123 Main St" />
                  </div>
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Naples" />
                  </div>
                  <div className="space-y-2">
                    <Label>State</Label>
                    <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="FL" />
                  </div>
                  <div className="space-y-2">
                    <Label>Postal code</Label>
                    <Input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="34102" />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <MapPin className="h-4 w-4" />
                  {street || city || state || postalCode
                    ? `${street} ${city} ${state} ${postalCode}`.trim()
                    : "No jobsite address on file."}
                </div>
                  </div>
                </section>

                {opportunity.project && (
                  <section className="space-y-3">
                    <div className="space-y-1">
                      <h3 className="text-sm font-semibold">Linked project</h3>
                      <p className="text-sm text-muted-foreground">The project created from this opportunity.</p>
                    </div>
                    <div className="rounded-lg border bg-background p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{opportunity.project.name ?? "Preconstruction project"}</div>
                      <div className="text-muted-foreground">Status: {opportunity.project.status ?? "planning"}</div>
                    </div>
                    <Button asChild variant="outline">
                      <Link href={`/projects/${opportunity.project.id}`}>Open project</Link>
                    </Button>
                  </div>
                    </div>
                  </section>
                )}
              </div>
            </ScrollArea>

            <SheetFooter className="border-t bg-muted/30 px-6 py-4">
              <div className="flex w-full items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  Update the stage first, then use the recommended next step.
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                  <Button onClick={handleSave} disabled={isSaving}>
                    {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                    Save changes
                  </Button>
                </div>
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
