"use client"

import { useState } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken, PortalPermissions } from "@/lib/types"
import { createPortalTokenAction } from "@/app/sharing/actions"
import { PermissionToggles } from "./permission-toggles"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

interface AccessTokenGeneratorProps {
  projectId: string
  onCreated: (token: PortalAccessToken) => void
}

const defaultExpires = format(addDays(new Date(), 90), "yyyy-MM-dd")

export function AccessTokenGenerator({ projectId, onCreated }: AccessTokenGeneratorProps) {
  const [portalType, setPortalType] = useState<"client" | "sub">("client")
  const [expiresAt, setExpiresAt] = useState(defaultExpires)
  const [permissions, setPermissions] = useState<Partial<PortalPermissions>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!projectId) {
      toast.error("Select a project first")
      return
    }
    setIsSubmitting(true)
    try {
      const token = await createPortalTokenAction({
        project_id: projectId,
        portal_type: portalType,
        expires_at: expiresAt,
        permissions,
      })
      onCreated(token)
    } catch (error) {
      console.error("Failed to create portal token", error)
      toast.error("Could not generate link")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        <div className="space-y-2">
          <Label>Audience</Label>
          <Select value={portalType} onValueChange={(v) => setPortalType(v as "client" | "sub")}>
            <SelectTrigger>
              <SelectValue placeholder="Select audience" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="client">Client</SelectItem>
              <SelectItem value="sub">Subcontractor</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Expires (optional)</Label>
          <Input type="date" value={expiresAt ?? ""} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Permissions</Label>
        <PermissionToggles value={permissions} onChange={setPermissions} />
      </div>

      <Button className="w-full" onClick={handleSubmit} disabled={isSubmitting || !projectId}>
        {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
        Generate link
      </Button>
    </div>
  )
}



