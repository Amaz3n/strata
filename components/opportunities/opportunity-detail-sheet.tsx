"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import type { TeamMember } from "@/lib/types"
import type { Opportunity } from "@/lib/services/opportunities"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import { getOpportunityAction, startEstimatingAction, updateOpportunityAction } from "@/app/(app)/pipeline/opportunity-actions"
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { Mail, Phone, Loader2, MapPin, Briefcase, Receipt } from "@/components/icons"

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
}

export function OpportunityDetailSheet({ opportunityId, open, onOpenChange, teamMembers }: OpportunityDetailSheetProps) {
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null)
  const [isPending, startTransition] = useTransition()
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
    startTransition(async () => {
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

  const handleSave = () => {
    if (!opportunity) return
    if (!name.trim()) {
      toast({ title: "Opportunity name is required" })
      return
    }
    startTransition(async () => {
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
        toast({ title: "Opportunity updated" })
      } catch (error) {
        toast({ title: "Unable to update opportunity", description: (error as Error).message })
      }
    })
  }

  const handleStartEstimating = () => {
    if (!opportunity) return
    startTransition(async () => {
      try {
        const result = await startEstimatingAction(opportunity.id)
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SheetTitle>Opportunity</SheetTitle>
            <SheetDescription>Review and update opportunity details.</SheetDescription>
          </div>
          {opportunity && (
            <div className="flex items-center gap-2">
              <OpportunityStatusBadge status={opportunity.status} />
              <Button onClick={handleStartEstimating} disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Receipt className="mr-2 h-4 w-4" />}
                Start estimating
              </Button>
            </div>
          )}
        </div>

        <Separator className="my-4" />

        {!opportunity || isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Client</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Jobsite</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
              </CardContent>
            </Card>

            {opportunity.project && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Preconstruction Project</CardTitle>
                </CardHeader>
                <CardContent className="text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{opportunity.project.name ?? "Preconstruction project"}</div>
                      <div className="text-muted-foreground">Status: {opportunity.project.status ?? "planning"}</div>
                    </div>
                    <Button asChild variant="outline">
                      <Link href={`/projects/${opportunity.project.id}`}>Open project</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={handleSave} disabled={isPending}>
                {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
