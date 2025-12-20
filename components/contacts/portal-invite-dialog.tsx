"use client"

import { useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Contact, Project } from "@/lib/types"
import { sendPortalInviteAction } from "@/app/contacts/actions"
import { useToast } from "@/hooks/use-toast"

interface PortalInviteDialogProps {
  contact?: Contact
  projects: Project[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function PortalInviteDialog({ contact, projects, open, onOpenChange }: PortalInviteDialogProps) {
  const [projectId, setProjectId] = useState<string>("")
  const [portalType, setPortalType] = useState<"client" | "sub">("sub")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const onSend = () => {
    if (!contact?.id || !projectId) return
    startTransition(async () => {
      try {
        await sendPortalInviteAction({ contactId: contact.id, projectId, portalType })
        toast({ title: "Portal invite sent" })
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
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <Button onClick={onSend} disabled={isPending || !projectId}>
              {isPending ? "Sending..." : "Send invite"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}



