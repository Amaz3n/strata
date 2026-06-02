"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { useUser } from "@/lib/auth/client"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TeamMember } from "@/lib/types"
import type { Prospect } from "@/lib/services/prospects"
import {
  createProspectAction,
  createProspectContactAction,
  updateProspectAction,
  updateProspectContactAction,
} from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2, User, Phone, Mail, Briefcase, Building2, MapPin, FileText } from "@/components/icons"

interface AddProspectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
  /** When provided, the sheet edits this prospect instead of creating a new one. */
  prospect?: Prospect | null
}

const US_STATES = [
  { value: "AL", label: "Alabama" },
  { value: "AK", label: "Alaska" },
  { value: "AZ", label: "Arizona" },
  { value: "AR", label: "Arkansas" },
  { value: "CA", label: "California" },
  { value: "CO", label: "Colorado" },
  { value: "CT", label: "Connecticut" },
  { value: "DE", label: "Delaware" },
  { value: "FL", label: "Florida" },
  { value: "GA", label: "Georgia" },
  { value: "HI", label: "Hawaii" },
  { value: "ID", label: "Idaho" },
  { value: "IL", label: "Illinois" },
  { value: "IN", label: "Indiana" },
  { value: "IA", label: "Iowa" },
  { value: "KS", label: "Kansas" },
  { value: "KY", label: "Kentucky" },
  { value: "LA", label: "Louisiana" },
  { value: "ME", label: "Maine" },
  { value: "MD", label: "Maryland" },
  { value: "MA", label: "Massachusetts" },
  { value: "MI", label: "Michigan" },
  { value: "MN", label: "Minnesota" },
  { value: "MS", label: "Mississippi" },
  { value: "MO", label: "Missouri" },
  { value: "MT", label: "Montana" },
  { value: "NE", label: "Nebraska" },
  { value: "NV", label: "Nevada" },
  { value: "NH", label: "New Hampshire" },
  { value: "NJ", label: "New Jersey" },
  { value: "NM", label: "New Mexico" },
  { value: "NY", label: "New York" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "OH", label: "Ohio" },
  { value: "OK", label: "Oklahoma" },
  { value: "OR", label: "Oregon" },
  { value: "PA", label: "Pennsylvania" },
  { value: "RI", label: "Rhode Island" },
  { value: "SC", label: "South Carolina" },
  { value: "SD", label: "South Dakota" },
  { value: "TN", label: "Tennessee" },
  { value: "TX", label: "Texas" },
  { value: "UT", label: "Utah" },
  { value: "VT", label: "Vermont" },
  { value: "VA", label: "Virginia" },
  { value: "WA", label: "Washington" },
  { value: "WV", label: "West Virginia" },
  { value: "WI", label: "Wisconsin" },
  { value: "WY", label: "Wyoming" }
]

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

export function AddProspectDialog({ open, onOpenChange, teamMembers, prospect }: AddProspectDialogProps) {
  const isEdit = Boolean(prospect)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const { user } = useUser()

  const [name, setName] = useState("")
  const [source, setSource] = useState("")
  const [ownerId, setOwnerId] = useState<string | undefined>()
  const [status, setStatus] = useState<string>("new")

  const [contactName, setContactName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")

  const [projectType, setProjectType] = useState<string | undefined>()
  const [budgetRange, setBudgetRange] = useState<string | undefined>()
  const [timeline, setTimeline] = useState<string | undefined>()

  const [street, setStreet] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [postalCode, setPostalCode] = useState("")

  const [notes, setNotes] = useState("")

  const reset = () => {
    setName("")
    setSource("")
    setOwnerId(user?.id ?? undefined)
    setStatus("new")
    setContactName("")
    setPhone("")
    setEmail("")
    setProjectType(undefined)
    setBudgetRange(undefined)
    setTimeline(undefined)
    setStreet("")
    setCity("")
    setState("")
    setPostalCode("")
    setNotes("")
  }

  // Prefill from the prospect when editing (and reset to blank for create).
  useEffect(() => {
    if (!open) return
    if (prospect) {
      const contact = prospect.primary_contact ?? prospect.contacts?.[0]
      setName(prospect.name ?? "")
      setSource(prospect.source ?? "")
      setOwnerId(prospect.owner_user_id ?? undefined)
      setStatus(prospect.status ?? "new")
      setContactName(contact?.full_name ?? "")
      setPhone(contact?.phone ?? "")
      setEmail(contact?.email ?? "")
      setProjectType(prospect.project_type ?? undefined)
      setBudgetRange(prospect.budget_range ?? undefined)
      setTimeline(prospect.timeline_preference ?? undefined)
      setStreet(prospect.jobsite_location?.street ?? "")
      setCity(prospect.jobsite_location?.city ?? "")
      setState(prospect.jobsite_location?.state ?? "")
      setPostalCode(prospect.jobsite_location?.postal_code ?? "")
      setNotes(prospect.notes ?? "")
    } else {
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospect, open])

  // Automatically assign owner when user loads and it's a new prospect
  useEffect(() => {
    if (open && !prospect && user?.id && !ownerId) {
      setOwnerId(user.id)
    }
  }, [open, prospect, user, ownerId])

  const handleSubmit = () => {
    if (!name.trim()) {
      toast({ title: "Prospect name is required" })
      return
    }

    const jobsite =
      street.trim() || city.trim() || state.trim() || postalCode.trim()
        ? {
            street: street.trim() || undefined,
            city: city.trim() || undefined,
            state: state.trim() || undefined,
            postal_code: postalCode.trim() || undefined,
          }
        : undefined

    const contactPayload = {
      full_name: contactName.trim() || name.trim(),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
    }

    startTransition(async () => {
      try {
        if (prospect) {
          await updateProspectAction(prospect.id, {
            name: name.trim(),
            source: source.trim() || null,
            notes: notes.trim() || null,
            owner_user_id: ownerId ?? null,
            project_type: projectType ?? null,
            budget_range: budgetRange ?? null,
            timeline_preference: timeline ?? null,
            jobsite_location: jobsite ?? null,
            status: status,
          })

          const existingContact = prospect.primary_contact ?? prospect.contacts?.[0]
          if (existingContact) {
            await updateProspectContactAction(existingContact.id, { ...contactPayload, is_primary: true })
          } else if (contactName.trim() || phone.trim() || email.trim()) {
            await createProspectContactAction(prospect.id, { ...contactPayload, is_primary: true })
          }

          router.refresh()
          toast({ title: "Prospect updated" })
          onOpenChange(false)
          return
        }

        await createProspectAction({
          name: name.trim(),
          source: source.trim() || undefined,
          notes: notes.trim() || undefined,
          owner_user_id: ownerId,
          project_type: projectType,
          budget_range: budgetRange,
          timeline_preference: timeline,
          jobsite_location: jobsite,
          status: status,
          primary_contact: { ...contactPayload, is_primary: true },
        })
        router.refresh()
        toast({ title: "Prospect created" })
        reset()
        onOpenChange(false)
      } catch (error) {
        toast({
          title: prospect ? "Failed to update prospect" : "Failed to create prospect",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(val) => {
        if (!val) reset()
        onOpenChange(val)
      }}
    >
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="space-y-0 border-b bg-muted/30 px-6 pb-4 pt-6 text-left">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Building2 className="h-5 w-5" />
            </div>
            {isEdit ? "Edit prospect" : "New prospect"}
          </SheetTitle>
          {isEdit && (
            <SheetDescription className="mt-1">
              Update the job details and primary contact for this prospect.
            </SheetDescription>
          )}
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="space-y-6 px-6 py-5">
            <Section icon={Building2} title="Prospect">
              <div className="space-y-1.5">
                <Label htmlFor="prospect-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="prospect-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Smith kitchen remodel"
                  className="h-10"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="prospect-status">Stage</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v)}>
                    <SelectTrigger id="prospect-status" className="!h-10 w-full">
                      <SelectValue placeholder="Select stage" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(statusLabels).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prospect-source">Lead source</Label>
                  <Select value={source || "none"} onValueChange={(v) => setSource(v === "none" ? "" : v)}>
                    <SelectTrigger id="prospect-source" className="!h-10 w-full">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      <SelectItem value="Referral">Referral</SelectItem>
                      <SelectItem value="Website">Website</SelectItem>
                      <SelectItem value="Google">Google</SelectItem>
                      <SelectItem value="Social Media">Social Media</SelectItem>
                      <SelectItem value="Repeat Customer">Repeat Customer</SelectItem>
                      <SelectItem value="Word of Mouth">Word of Mouth</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                      {source && !["Referral", "Website", "Google", "Social Media", "Repeat Customer", "Word of Mouth", "Other"].includes(source) && (
                        <SelectItem value={source}>{source}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Owner</Label>
                  <Select value={ownerId ?? "none"} onValueChange={(v) => setOwnerId(v === "none" ? undefined : v)}>
                    <SelectTrigger className="!h-10 w-full">
                      <SelectValue placeholder="Unassigned" />
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
            </Section>

            <Section icon={User} title="Primary contact">
              <div className="space-y-1.5">
                <Label htmlFor="contact-name">Contact name</Label>
                <Input
                  id="contact-name"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Defaults to prospect name"
                  className="h-10"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="contact-phone">Phone</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="contact-phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="(555) 555-5555"
                      className="h-10 pl-9"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contact-email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="contact-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="john@example.com"
                      className="h-10 pl-9"
                    />
                  </div>
                </div>
              </div>
            </Section>

            <Section icon={Briefcase} title="Project details">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>Project type</Label>
                  <Select value={projectType ?? "none"} onValueChange={(v) => setProjectType(v === "none" ? undefined : v)}>
                    <SelectTrigger className="!h-10 w-full">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      <SelectItem value="new_construction">New construction</SelectItem>
                      <SelectItem value="remodel">Remodel</SelectItem>
                      <SelectItem value="addition">Addition</SelectItem>
                      <SelectItem value="renovation">Renovation</SelectItem>
                      <SelectItem value="repair">Repair</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Budget range</Label>
                  <Select value={budgetRange ?? "none"} onValueChange={(v) => setBudgetRange(v === "none" ? undefined : v)}>
                    <SelectTrigger className="!h-10 w-full">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      <SelectItem value="under_100k">Under $100k</SelectItem>
                      <SelectItem value="100k_250k">$100k – $250k</SelectItem>
                      <SelectItem value="250k_500k">$250k – $500k</SelectItem>
                      <SelectItem value="500k_1m">$500k – $1M</SelectItem>
                      <SelectItem value="over_1m">Over $1M</SelectItem>
                      <SelectItem value="undecided">Undecided</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Timeline</Label>
                  <Select value={timeline ?? "none"} onValueChange={(v) => setTimeline(v === "none" ? undefined : v)}>
                    <SelectTrigger className="!h-10 w-full">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      <SelectItem value="asap">ASAP</SelectItem>
                      <SelectItem value="3_months">Within 3 months</SelectItem>
                      <SelectItem value="6_months">Within 6 months</SelectItem>
                      <SelectItem value="1_year">Within 1 year</SelectItem>
                      <SelectItem value="flexible">Flexible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Section>

            <Section icon={MapPin} title="Jobsite">
              <div className="space-y-1.5">
                <Label htmlFor="jobsite-street">Street</Label>
                <Input
                  id="jobsite-street"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  placeholder="123 Main St"
                  className="h-10"
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="jobsite-city">City</Label>
                  <Input
                    id="jobsite-city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="City"
                    className="h-10"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="jobsite-state">State</Label>
                  <Select value={state || "none"} onValueChange={(v) => setState(v === "none" ? "" : v)}>
                    <SelectTrigger id="jobsite-state" className="!h-10 w-full">
                      <SelectValue placeholder="Select state" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {US_STATES.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label} ({s.value})
                        </SelectItem>
                      ))}
                      {state && !US_STATES.some(s => s.value === state) && (
                        <SelectItem value={state}>{state}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="jobsite-zip">Zip code</Label>
                  <Input
                    id="jobsite-zip"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    placeholder="Zip code"
                    className="h-10"
                  />
                </div>
              </div>
            </Section>

            <Section icon={FileText} title="Notes">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Initial conversation details, scope, special requirements…"
                rows={3}
                className="resize-none"
              />
            </Section>
          </div>
        </ScrollArea>

        <div className="flex-shrink-0 border-t bg-muted/30 p-4">
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending} className="flex-1">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending} className="flex-1">
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {isEdit ? "Saving…" : "Creating…"}
                </>
              ) : isEdit ? (
                "Save changes"
              ) : (
                "Create prospect"
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  )
}
