"use client"

import { useState, useEffect } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken, PortalPermissions, ProjectVendor } from "@/lib/types"
import { createPortalTokenAction, loadProjectVendorsAction } from "@/app/sharing/actions"
import { PermissionToggles } from "./permission-toggles"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CalendarDays, User, Users, Building2 } from "@/components/icons"

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
  const [requirePin, setRequirePin] = useState(false)
  const [pin, setPin] = useState("")
  const [companyId, setCompanyId] = useState("")
  const [vendors, setVendors] = useState<ProjectVendor[]>([])
  const [isLoadingVendors, setIsLoadingVendors] = useState(false)

  // Load project vendors when project changes
  useEffect(() => {
    if (!projectId) {
      setVendors([])
      return
    }

    setIsLoadingVendors(true)
    loadProjectVendorsAction(projectId)
      .then(setVendors)
      .catch((error) => {
        console.error("Failed to load project vendors:", error)
        toast.error("Failed to load subcontractor list")
      })
      .finally(() => setIsLoadingVendors(false))
  }, [projectId])

  // Reset company selection when switching portal types
  useEffect(() => {
    if (portalType === "client") {
      setCompanyId("")
    }
  }, [portalType])

  const handleSubmit = async () => {
    if (!projectId) {
      toast.error("Select a project first")
      return
    }

    if (requirePin && !/^[0-9]{4,6}$/.test(pin)) {
      toast.error("Enter a 4-6 digit PIN")
      return
    }

    setIsSubmitting(true)
    try {
      const token = await createPortalTokenAction({
        project_id: projectId,
        portal_type: portalType,
        company_id: portalType === "sub" ? companyId : undefined,
        expires_at: expiresAt || null,
        permissions,
        pin: requirePin ? pin : undefined,
      })
      onCreated(token)
      setPin("")
    } catch (error) {
      console.error("Failed to create portal token", error)
      toast.error("Could not generate link")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePortalTypeChange = (value: string) => {
    if (!value) return
    setPortalType(value as "client" | "sub")
  }

  const handleResetExpiry = () => setExpiresAt("")

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-muted/40 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Audience</p>
            <p className="text-xs text-muted-foreground">Choose who will use this portal link.</p>
          </div>
          <Badge variant="outline" className="capitalize">
            {portalType} link
          </Badge>
        </div>
        <ToggleGroup
          type="single"
          value={portalType}
          onValueChange={handlePortalTypeChange}
          className="mt-3 grid grid-cols-2 gap-2"
        >
          <ToggleGroupItem value="client" className="w-full justify-center gap-2">
            <User className="h-4 w-4" />
            Client
          </ToggleGroupItem>
          <ToggleGroupItem value="sub" className="w-full justify-center gap-2">
            <Users className="h-4 w-4" />
            Subcontractor
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Company Selection for Sub Portals */}
      {portalType === "sub" && (
        <div className="rounded-xl border bg-muted/40 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-1">
              <p className="text-sm font-medium">Subcontractor Company</p>
              <p className="text-xs text-muted-foreground">Select which company will access this portal.</p>
            </div>
            <Badge variant="outline" className="capitalize">
              {companyId ? "Selected" : "Required"}
            </Badge>
          </div>
          <div className="mt-3">
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger>
                <SelectValue placeholder={isLoadingVendors ? "Loading companies..." : "Select subcontractor..."} />
              </SelectTrigger>
              <SelectContent>
                {vendors
                  .filter(v => v.company) // Only show vendors with companies
                  .map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.company!.id}>
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4" />
                        <span>{vendor.company!.name}</span>
                        {vendor.company!.company_type && (
                          <Badge variant="outline" className="text-xs">
                            {vendor.company!.company_type}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {vendors.length === 0 && !isLoadingVendors && (
              <p className="text-xs text-muted-foreground mt-2">
                No subcontractors added to this project yet. Add them in the project directory first.
              </p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-card/70 p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Expiration</Label>
            <p className="text-xs text-muted-foreground">Links stay active until this date.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
            {expiresAt ? `Ends ${format(new Date(expiresAt), "MMM d, yyyy")}` : "No auto-expiry"}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="date"
            value={expiresAt ?? ""}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="sm:flex-1"
          />
          <Button variant="outline" type="button" size="sm" onClick={() => setExpiresAt(defaultExpires)}>
            +90 days
          </Button>
          <Button variant="ghost" type="button" size="sm" onClick={handleResetExpiry}>
            No expiry
          </Button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border bg-card/80 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Permissions</p>
            <p className="text-xs text-muted-foreground">Toggle exactly what this link can access.</p>
          </div>
          <Badge variant="secondary">Granular</Badge>
        </div>
        <PermissionToggles value={permissions} onChange={setPermissions} />
      </div>

      <div className="space-y-3 rounded-xl border bg-card/80 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">PIN protection</p>
            <p className="text-xs text-muted-foreground">Add a 4-6 digit PIN your client must enter.</p>
          </div>
          <Badge variant={requirePin ? "default" : "outline"}>{requirePin ? "Enabled" : "Optional"}</Badge>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={requirePin}
              onChange={(e) => setRequirePin(e.target.checked)}
              className="h-4 w-4 rounded border-muted-foreground/50"
              id="require-pin"
            />
            <Label htmlFor="require-pin" className="text-sm">
              Require PIN for this link
            </Label>
          </div>
          {requirePin && (
            <div className="flex flex-1 items-center gap-2">
              <Input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <p className="text-xs text-muted-foreground whitespace-nowrap">4-6 digits</p>
            </div>
          )}
        </div>
      </div>

      <Button
        className="h-11 w-full"
        onClick={handleSubmit}
        disabled={isSubmitting || !projectId || (portalType === "sub" && !companyId)}
      >
        {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
        Generate secure link
      </Button>
    </div>
  )
}



