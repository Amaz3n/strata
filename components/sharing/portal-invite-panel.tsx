"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { Mail, Send, ShieldCheck, User, Users } from "lucide-react"
import { toast } from "sonner"

import { sendPortalInviteAction } from "@/app/(app)/contacts/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { Contact, PortalAccessToken, Project, ProjectVendor } from "@/lib/types"

interface PortalInvitePanelProps {
  project: Project
  contacts: Contact[]
  projectVendors: ProjectVendor[]
  onInviteSent: (token: PortalAccessToken) => void
}

interface InviteCandidate {
  contactId: string
  title: string
  subtitle: string
  email: string
}

export function PortalInvitePanel({ project, contacts, projectVendors, onInviteSent }: PortalInvitePanelProps) {
  const [portalType, setPortalType] = useState<"client" | "sub">("client")
  const [selectedContactId, setSelectedContactId] = useState("")
  const [isPending, startTransition] = useTransition()

  const clientCandidates = useMemo(() => {
    const prioritized = contacts
      .filter((contact) => !!contact.email)
      .filter((contact) => contact.contact_type === "client" || contact.id === project.client_id)
      .sort((a, b) => {
        if (a.id === project.client_id) return -1
        if (b.id === project.client_id) return 1
        return a.full_name.localeCompare(b.full_name)
      })

    const fallback = contacts
      .filter((contact) => !!contact.email)
      .sort((a, b) => a.full_name.localeCompare(b.full_name))

    const source = prioritized.length > 0 ? prioritized : fallback
    const unique = new Map<string, InviteCandidate>()

    for (const contact of source) {
      if (!contact.email || unique.has(contact.id)) continue
      unique.set(contact.id, {
        contactId: contact.id,
        title: contact.full_name,
        subtitle: contact.role || (contact.id === project.client_id ? "Project client" : "Client contact"),
        email: contact.email,
      })
    }

    return Array.from(unique.values())
  }, [contacts, project.client_id])

  const subCandidates = useMemo(() => {
    const unique = new Map<string, InviteCandidate>()

    for (const vendor of projectVendors) {
      const contact = vendor.contact
      if (!contact?.id || !contact.email) continue
      if (unique.has(contact.id)) continue
      unique.set(contact.id, {
        contactId: contact.id,
        title: contact.full_name,
        subtitle: vendor.company?.name
          ? `${vendor.company.name}${vendor.role ? ` • ${vendor.role.replaceAll("_", " ")}` : ""}`
          : contact.role || "Trade partner",
        email: contact.email,
      })
    }

    if (unique.size === 0) {
      for (const contact of contacts) {
        const companyName = contact.company_details?.[0]?.name || contact.primary_company?.name
        if (!contact.email || !companyName) continue
        if (unique.has(contact.id)) continue
        unique.set(contact.id, {
          contactId: contact.id,
          title: contact.full_name,
          subtitle: companyName,
          email: contact.email,
        })
      }
    }

    return Array.from(unique.values()).sort((a, b) => a.title.localeCompare(b.title))
  }, [contacts, projectVendors])

  const candidates = portalType === "client" ? clientCandidates : subCandidates
  const selectedCandidate = candidates.find((candidate) => candidate.contactId === selectedContactId) ?? null

  useEffect(() => {
    if (candidates.some((candidate) => candidate.contactId === selectedContactId)) return
    setSelectedContactId(candidates[0]?.contactId ?? "")
  }, [candidates, selectedContactId])

  const emptyStateLabel =
    portalType === "client"
      ? "Add a client contact with an email to send a portal invite."
      : "Add a project vendor contact with an email to send a sub portal invite."

  const handleSend = () => {
    if (!selectedContactId) {
      toast.error("Select a recipient first")
      return
    }

    startTransition(async () => {
      try {
        const result = await sendPortalInviteAction({
          contactId: selectedContactId,
          projectId: project.id,
          portalType,
        })
        onInviteSent(result.token)

        if (result.email_sent) {
          toast.success("Invite sent", {
            description: `Sent to ${result.sent_to}`,
          })
        } else {
          toast.warning("Invite link created, but email was not sent", {
            description: "Check email configuration or use the direct link below if needed.",
          })
        }
      } catch (error: any) {
        toast.error(error?.message ?? "Unable to send invite")
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/60 p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium">Email-first access</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Recipients open the project directly from the email, then claim or sign in to Arc from there.
          </p>
        </div>
        <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
          Account required
        </Badge>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Portal audience</Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPortalType("client")}
            className={cn(
              "flex items-center gap-3 border p-3 text-left transition-colors",
              portalType === "client" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
            )}
          >
            <div className={cn("flex h-8 w-8 items-center justify-center", portalType === "client" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              <User className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium">Client</p>
              <p className="text-[11px] text-muted-foreground">Homeowner or owner rep</p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setPortalType("sub")}
            className={cn(
              "flex items-center gap-3 border p-3 text-left transition-colors",
              portalType === "sub" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
            )}
          >
            <div className={cn("flex h-8 w-8 items-center justify-center", portalType === "sub" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              <Users className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium">Sub</p>
              <p className="text-[11px] text-muted-foreground">Trade partner or vendor</p>
            </div>
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Recipient</Label>
        <Select value={selectedContactId} onValueChange={setSelectedContactId} disabled={candidates.length === 0 || isPending}>
          <SelectTrigger>
            <SelectValue placeholder={candidates.length === 0 ? emptyStateLabel : "Select a recipient"} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate.contactId} value={candidate.contactId}>
                <div className="flex min-w-0 flex-col">
                  <span>{candidate.title}</span>
                  <span className="text-xs text-muted-foreground">{candidate.subtitle}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedCandidate ? (
          <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
            <p className="font-medium">{selectedCandidate.title}</p>
            <p className="text-muted-foreground">{selectedCandidate.email}</p>
            <p className="mt-2 text-xs text-muted-foreground">{selectedCandidate.subtitle}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{emptyStateLabel}</p>
        )}
      </div>

      <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
          <div className="space-y-1">
            <p className="text-sm font-medium">What the recipient sees</p>
            <p className="text-xs leading-5 text-muted-foreground">
              The email button opens this project directly. If they are new to Arc, they will claim their account
              before entering the portal. After that, the project also appears in their Arc workspace.
            </p>
          </div>
        </div>
      </div>

      <Button className="w-full" onClick={handleSend} disabled={isPending || !selectedContactId}>
        <Send className="h-4 w-4" />
        {isPending ? "Sending invite..." : "Send invite email"}
      </Button>
    </div>
  )
}
