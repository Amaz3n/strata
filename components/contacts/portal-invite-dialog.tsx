"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Contact, Project } from "@/lib/types"
import { sendPortalInviteAction } from "@/app/(app)/contacts/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

interface PortalInviteDialogProps {
  /** Narrowed to what the dialog actually shows, so a list row that holds only
   *  an id and a name can invite without loading the whole contact. */
  contact?: Pick<Contact, "id" | "full_name">
  projects: Array<Pick<Project, "id" | "name">>
  projectsLoading?: boolean
  projectsError?: string
  onRetryProjects?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PortalInviteDialog({
  contact,
  projects,
  projectsLoading = false,
  projectsError,
  onRetryProjects,
  open,
  onOpenChange,
}: PortalInviteDialogProps) {
  const [projectId, setProjectId] = useState<string>("")
  const [portalType, setPortalType] = useState<"client" | "sub">("sub")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const onSend = () => {
    if (!contact?.id || !projectId) return
    startTransition(async () => {
      try {
        const result = unwrapAction(await sendPortalInviteAction({ contactId: contact.id, projectId, portalType }))
        toast({
          title: result.email_sent ? "Portal invite sent" : "Invite created, but email was not sent",
          description: result.email_sent ? `Sent to ${result.sent_to}` : "Check email configuration before relying on this invite.",
        })
        onOpenChange(false)
        setProjectId("")
      } catch (error) {
        toast({ title: "Unable to send invite", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send portal invite</DialogTitle>
          <DialogDescription>Pick a project to invite this contact into the portal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Contact</Label>
            <Input value={contact?.full_name ?? ""} disabled />
          </div>
          <div className="space-y-2">
            <Label>Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger disabled={projectsLoading || Boolean(projectsError)}>
                <SelectValue
                  placeholder={projectsLoading ? "Loading projects…" : "Select a project"}
                />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {projectsLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading projects…
              </div>
            ) : projectsError ? (
              <div className="flex items-center justify-between gap-3 text-xs text-destructive">
                <span>{projectsError}</span>
                {onRetryProjects ? (
                  <Button type="button" size="sm" variant="outline" onClick={onRetryProjects}>
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">No available projects.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Portal type</Label>
            <Select value={portalType} onValueChange={(v) => setPortalType(v as "client" | "sub")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client">Client</SelectItem>
                <SelectItem value="sub">Subcontractor</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={onSend}
              disabled={isPending || projectsLoading || Boolean(projectsError) || !projectId}
            >
              {isPending ? "Sending..." : "Send invite"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}





