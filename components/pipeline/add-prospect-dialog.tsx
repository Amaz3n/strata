"use client"

import { useState, useTransition } from "react"
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
import type { TeamMember } from "@/lib/types"
import { createProspectAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2, User, Phone, Mail, Briefcase, DollarSign, Clock, UserPlus, FileText } from "@/components/icons"
import { cn } from "@/lib/utils"

interface AddProspectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamMembers: TeamMember[]
}

export function AddProspectDialog({ open, onOpenChange, teamMembers }: AddProspectDialogProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [fullName, setFullName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [crmSource, setCrmSource] = useState("")
  const [notes, setNotes] = useState("")
  const [leadOwnerId, setLeadOwnerId] = useState<string | undefined>()
  const [leadPriority, setLeadPriority] = useState<string>("normal")
  const [leadProjectType, setLeadProjectType] = useState<string | undefined>()
  const [leadBudgetRange, setLeadBudgetRange] = useState<string | undefined>()
  const [leadTimeline, setLeadTimeline] = useState<string | undefined>()

  const reset = () => {
    setFullName("")
    setPhone("")
    setEmail("")
    setCrmSource("")
    setNotes("")
    setLeadOwnerId(undefined)
    setLeadPriority("normal")
    setLeadProjectType(undefined)
    setLeadBudgetRange(undefined)
    setLeadTimeline(undefined)
  }

  const handleSubmit = () => {
    if (!fullName.trim()) {
      toast({ title: "Full name is required" })
      return
    }

    startTransition(async () => {
      try {
        await createProspectAction({
          full_name: fullName.trim(),
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          crm_source: crmSource.trim() || undefined,
          notes: notes.trim() || undefined,
          lead_owner_user_id: leadOwnerId,
          lead_priority: leadPriority as any,
          lead_project_type: leadProjectType as any,
          lead_budget_range: leadBudgetRange as any,
          lead_timeline_preference: leadTimeline as any,
        })
        router.refresh()
        toast({ title: "Prospect created" })
        reset()
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to create prospect", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-xl p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <UserPlus className="h-4 w-4 text-primary" />
            </div>
            Add Prospect
          </DialogTitle>
          <DialogDescription>
            Create a new prospect to track through your sales pipeline.
          </DialogDescription>
        </DialogHeader>

        {/* Form content - scrollable on mobile */}
        <div className="px-6 pb-6 space-y-6 max-h-[60vh] overflow-y-auto">
          {/* Contact Information */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <User className="h-4 w-4" />
              Contact Information
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">Full name <span className="text-destructive">*</span></Label>
                <Input
                  id="full_name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="John Smith"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(555) 555-5555"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="john@example.com"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="crm_source">Lead source</Label>
                <Input
                  id="crm_source"
                  value={crmSource}
                  onChange={(e) => setCrmSource(e.target.value)}
                  placeholder="Referral, Website, etc."
                />
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Assignment */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Briefcase className="h-4 w-4" />
              Assignment
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Owner</Label>
                <Select value={leadOwnerId ?? "none"} onValueChange={(v) => setLeadOwnerId(v === "none" ? undefined : v)}>
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
                <Label>Priority</Label>
                <Select value={leadPriority} onValueChange={setLeadPriority}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Project Details */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="h-4 w-4" />
              Project Details
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Project type</Label>
                <Select value={leadProjectType ?? "none"} onValueChange={(v) => setLeadProjectType(v === "none" ? undefined : v)}>
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
                <Select value={leadBudgetRange ?? "none"} onValueChange={(v) => setLeadBudgetRange(v === "none" ? undefined : v)}>
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
                <Label>Timeline</Label>
                <Select value={leadTimeline ?? "none"} onValueChange={(v) => setLeadTimeline(v === "none" ? undefined : v)}>
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
            </div>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Notes */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="h-4 w-4" />
              Notes
            </div>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Initial conversation details, project scope, special requirements..."
              rows={3}
              className="resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Prospect"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
