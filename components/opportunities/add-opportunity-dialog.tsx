"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Contact, TeamMember } from "@/lib/types"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import { createOpportunityAction } from "@/app/(app)/pipeline/opportunity-actions"
import { createContactAction } from "@/app/(app)/contacts/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2, UserPlus, MapPin, Briefcase } from "@/components/icons"

const statusOptions: OpportunityStatus[] = [
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
  "won",
  "lost",
]

function buildDefaultOpportunityName(fullName: string) {
  const trimmed = fullName.trim()
  if (!trimmed) return ""
  const parts = trimmed.split(/\s+/)
  const lastName = parts[parts.length - 1] ?? trimmed
  return `${lastName} Residence`
}

interface AddOpportunityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
  clients: Contact[]
}

export function AddOpportunityDialog({ open, onOpenChange, teamMembers, clients }: AddOpportunityDialogProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [clientChoice, setClientChoice] = useState<string>("new")
  const [clientName, setClientName] = useState("")
  const [clientEmail, setClientEmail] = useState("")
  const [clientPhone, setClientPhone] = useState("")

  const [opportunityName, setOpportunityName] = useState("")
  const [status, setStatus] = useState<OpportunityStatus>("new")
  const [ownerId, setOwnerId] = useState<string | undefined>()
  const [source, setSource] = useState("")
  const [projectType, setProjectType] = useState<string | undefined>()
  const [budgetRange, setBudgetRange] = useState<string | undefined>()
  const [timelinePreference, setTimelinePreference] = useState<string | undefined>()
  const [notes, setNotes] = useState("")
  const [street, setStreet] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [postalCode, setPostalCode] = useState("")

  const selectedClient = useMemo(() => clients.find((c) => c.id === clientChoice), [clients, clientChoice])

  const reset = () => {
    setClientChoice("new")
    setClientName("")
    setClientEmail("")
    setClientPhone("")
    setOpportunityName("")
    setStatus("new")
    setOwnerId(undefined)
    setSource("")
    setProjectType(undefined)
    setBudgetRange(undefined)
    setTimelinePreference(undefined)
    setNotes("")
    setStreet("")
    setCity("")
    setState("")
    setPostalCode("")
  }

  const handleSubmit = () => {
    const resolvedClientName = clientChoice === "new" ? clientName.trim() : selectedClient?.full_name ?? ""

    if (!resolvedClientName) {
      toast({ title: "Client name is required" })
      return
    }

    startTransition(async () => {
      try {
        let clientId = clientChoice

        if (clientChoice === "new") {
          const contact = await createContactAction({
            full_name: clientName.trim(),
            email: clientEmail.trim() || undefined,
            phone: clientPhone.trim() || undefined,
            contact_type: "client",
          })
          clientId = contact.id
        }

        const name =
          opportunityName.trim() || buildDefaultOpportunityName(resolvedClientName) || `${resolvedClientName} Opportunity`

        await createOpportunityAction({
          name,
          client_contact_id: clientId,
          status,
          owner_user_id: ownerId ?? null,
          source: source.trim() || null,
          project_type: projectType ?? null,
          budget_range: budgetRange ?? null,
          timeline_preference: timelinePreference ?? null,
          notes: notes.trim() || null,
          jobsite_location: {
            street: street.trim() || undefined,
            city: city.trim() || undefined,
            state: state.trim() || undefined,
            postal_code: postalCode.trim() || undefined,
          },
        })

        router.refresh()
        toast({ title: "Opportunity created" })
        reset()
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to create opportunity", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <UserPlus className="h-4 w-4 text-primary" />
            </div>
            Add Opportunity
          </DialogTitle>
          <DialogDescription>
            Create a new opportunity and link it to a client contact.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-6 max-h-[70vh] overflow-y-auto">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <UserPlus className="h-4 w-4" />
              Client
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label>Client contact</Label>
                <Select value={clientChoice} onValueChange={setClientChoice}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">Create new client</SelectItem>
                    {clients.map((client) => (
                      <SelectItem key={client.id} value={client.id}>
                        {client.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {clientChoice === "new" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="client_name">Full name</Label>
                    <Input
                      id="client_name"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      placeholder="John Smith"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="client_email">Email</Label>
                    <Input
                      id="client_email"
                      type="email"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                      placeholder="john@example.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="client_phone">Phone</Label>
                    <Input
                      id="client_phone"
                      value={clientPhone}
                      onChange={(e) => setClientPhone(e.target.value)}
                      placeholder="(555) 555-5555"
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="border-t" />

          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Briefcase className="h-4 w-4" />
              Opportunity
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="opportunity_name">Opportunity name</Label>
                <Input
                  id="opportunity_name"
                  value={opportunityName}
                  onChange={(e) => setOpportunityName(e.target.value)}
                  placeholder="Smith Residence"
                />
              </div>
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
                <Select value={ownerId ?? "none"} onValueChange={(value) => setOwnerId(value === "none" ? undefined : value)}>
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
              </div>
              <div className="space-y-2">
                <Label>Source</Label>
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Referral, Website, etc."
                />
              </div>
              <div className="space-y-2">
                <Label>Project type</Label>
                <Select value={projectType ?? "none"} onValueChange={(value) => setProjectType(value === "none" ? undefined : value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
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
                    <SelectValue placeholder="Select budget" />
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
                <Label>Timeline preference</Label>
                <Select value={timelinePreference ?? "none"} onValueChange={(value) => setTimelinePreference(value === "none" ? undefined : value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select timeline" />
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
              <div className="space-y-2 sm:col-span-2">
                <Label>Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes about this opportunity" />
              </div>
            </div>
          </div>

          <div className="border-t" />

          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <MapPin className="h-4 w-4" />
              Jobsite location
            </div>
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
          </div>
        </div>

        <div className="border-t px-6 py-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create opportunity
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
