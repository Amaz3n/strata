"use client"

import { useEffect, useMemo, useState } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import type { PortalAccessToken, PortalPermissions, ProjectVendor } from "@/lib/types"
import { createPortalTokenAction, loadProjectVendorsAction } from "@/app/(app)/sharing/actions"
import { cn } from "@/lib/utils"

import { PermissionToggles } from "@/components/sharing/permission-toggles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  ChevronDown,
  Copy,
  ExternalLink,
  User,
  Users,
  Building2,
  Link2,
  CheckCircle2,
  Shield,
  Lock,
  Clock,
  Eye,
  Settings,
} from "@/components/icons"

interface PortalLinkCreatorProps {
  projectId: string
  onCreated: (token: PortalAccessToken) => void
  enabled?: boolean
}

type PermissionPreset = "standard" | "read_only" | "custom"

const defaultExpires = format(addDays(new Date(), 90), "yyyy-MM-dd")

export function PortalLinkCreator({ projectId, onCreated, enabled = true }: PortalLinkCreatorProps) {
  const [portalType, setPortalType] = useState<"client" | "sub">("client")
  const [companyId, setCompanyId] = useState("")
  const [vendors, setVendors] = useState<ProjectVendor[]>([])
  const [isLoadingVendors, setIsLoadingVendors] = useState(false)

  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>("standard")
  const [permissions, setPermissions] = useState<Partial<PortalPermissions>>({})
  const [expiresAt, setExpiresAt] = useState<string>(defaultExpires)
  const [requirePin, setRequirePin] = useState(false)
  const [pin, setPin] = useState("")

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [lastCreated, setLastCreated] = useState<PortalAccessToken | null>(null)

  const fallbackOrigin = process.env.NEXT_PUBLIC_APP_URL || ""
  const [origin, setOrigin] = useState(fallbackOrigin)

  useEffect(() => {
    if (typeof window === "undefined") return
    setOrigin(window.location.origin)
  }, [])

  const createdUrl = useMemo(() => {
    if (!lastCreated) return ""
    return `${origin}/${lastCreated.portal_type === "client" ? "p" : "s"}/${lastCreated.token}`
  }, [lastCreated, origin])

  // Load project vendors for sub links.
  useEffect(() => {
    if (!enabled) return
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
  }, [projectId, enabled])

  // Reset sub-company selection when switching portal types.
  useEffect(() => {
    if (portalType === "client") setCompanyId("")
  }, [portalType])

  // Apply permission preset (only when not custom).
  useEffect(() => {
    if (permissionPreset === "custom") return
    if (permissionPreset === "standard") {
      setPermissions({})
      return
    }
    // Read-only: keep viewing features, remove "do" capabilities.
    setPermissions({
      can_pay_invoices: false,
      can_respond_rfis: false,
      can_submit_submittals: false,
      can_approve_change_orders: false,
      can_submit_selections: false,
      can_create_punch_items: false,
      can_message: false,
    })
  }, [permissionPreset])

  async function copy(text: string) {
    // Try modern clipboard API first
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
        return
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback for iOS and older browsers
    try {
      const textArea = document.createElement("textarea")
      textArea.value = text
      textArea.style.position = "fixed"
      textArea.style.left = "-9999px"
      textArea.style.top = "0"
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()

      const successful = document.execCommand("copy")
      document.body.removeChild(textArea)

      if (successful) {
        toast.success("Copied to clipboard")
      } else {
        toast.error("Unable to copy")
      }
    } catch {
      toast.error("Unable to copy")
    }
  }

  async function handleCreate() {
    if (!projectId) {
      toast.error("Select a project first")
      return
    }

    if (portalType === "sub" && !companyId) {
      toast.error("Select a subcontractor company")
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
      setLastCreated(token)
      onCreated(token)
      setPin("")
      toast.success("Link created", { description: "Copy it and send it to your client or subcontractor." })
    } catch (error) {
      console.error("Failed to create portal token", error)
      toast.error("Could not create link")
    } finally {
      setIsSubmitting(false)
    }
  }

  const presetConfig = {
    standard: {
      icon: Shield,
      label: "Standard",
      description: "Full access with defaults",
    },
    read_only: {
      icon: Eye,
      label: "View only",
      description: "No edit capabilities",
    },
    custom: {
      icon: Settings,
      label: "Custom",
      description: "Pick permissions",
    },
  }

  return (
    <div className="space-y-4">
      {/* Audience Selector */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Who is this link for?</Label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setPortalType("client")}
            className={cn(
              "relative flex items-center gap-2 border p-3 transition-all",
              portalType === "client"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
            )}
          >
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center transition-colors",
                portalType === "client" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}
            >
              <User className="h-4 w-4" />
            </div>
            <div className="text-left">
              <p className={cn("text-sm font-medium", portalType === "client" && "text-primary")}>Client</p>
              <p className="text-[10px] text-muted-foreground">Homeowner</p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setPortalType("sub")}
            className={cn(
              "relative flex items-center gap-2 border p-3 transition-all",
              portalType === "sub"
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/30 hover:bg-muted/50"
            )}
          >
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center transition-colors",
                portalType === "sub" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}
            >
              <Users className="h-4 w-4" />
            </div>
            <div className="text-left">
              <p className={cn("text-sm font-medium", portalType === "sub" && "text-primary")}>Sub</p>
              <p className="text-[10px] text-muted-foreground">Trade partner</p>
            </div>
          </button>
        </div>
      </div>

      {/* Sub Company Selector */}
      {portalType === "sub" && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Company</Label>
          <Select value={companyId} onValueChange={setCompanyId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder={isLoadingVendors ? "Loading..." : "Select company"} />
            </SelectTrigger>
            <SelectContent>
              {vendors
                .filter((v) => v.company)
                .map((vendor) => (
                  <SelectItem key={vendor.id} value={vendor.company!.id}>
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{vendor.company!.name}</span>
                    </div>
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {vendors.length === 0 && !isLoadingVendors && (
            <p className="text-[11px] text-muted-foreground">
              Add a subcontractor to the project first.
            </p>
          )}
        </div>
      )}

      {/* Advanced Options */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between border px-3 py-2 text-xs transition-all",
              advancedOpen
                ? "border-primary/20 bg-primary/5"
                : "border-dashed border-muted-foreground/25 hover:border-muted-foreground/40 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center gap-1.5">
              <Settings className={cn("h-3.5 w-3.5", advancedOpen ? "text-primary" : "text-muted-foreground")} />
              <span className={cn(advancedOpen ? "text-foreground" : "text-muted-foreground")}>
                Advanced
              </span>
            </div>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                advancedOpen && "rotate-180"
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-4 border bg-muted/20 p-3">
            {/* Expiry */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <Label className="text-xs font-medium">Expiration</Label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant={!expiresAt ? "secondary" : "ghost"}
                  type="button"
                  onClick={() => setExpiresAt("")}
                  className="h-7 text-xs"
                >
                  Never
                </Button>
                <Button
                  size="sm"
                  variant={expiresAt === defaultExpires ? "secondary" : "ghost"}
                  type="button"
                  onClick={() => setExpiresAt(defaultExpires)}
                  className="h-7 text-xs"
                >
                  90 days
                </Button>
                <Input
                  type="date"
                  value={expiresAt ?? ""}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="h-7 w-auto text-xs"
                />
              </div>
            </div>

            {/* PIN */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-xs font-medium">PIN</Label>
                </div>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium transition-all",
                    requirePin
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  )}
                  onClick={() => setRequirePin((v) => !v)}
                >
                  {requirePin ? "On" : "Off"}
                </button>
              </div>
              {requirePin && (
                <Input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="4-6 digit PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="h-8 font-mono text-xs tracking-widest"
                />
              )}
            </div>

            {/* Permission Presets */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                <Label className="text-xs font-medium">Access level</Label>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(["standard", "read_only", "custom"] as const).map((preset) => {
                  const config = presetConfig[preset]
                  const Icon = config.icon
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setPermissionPreset(preset)}
                      className={cn(
                        "flex items-center justify-center gap-1 border py-1.5 text-center transition-all",
                        permissionPreset === preset
                          ? "border-primary bg-primary/5"
                          : "border-transparent bg-background hover:border-muted-foreground/20 hover:bg-muted/50"
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-3 w-3",
                          permissionPreset === preset ? "text-primary" : "text-muted-foreground"
                        )}
                      />
                      <span
                        className={cn(
                          "text-[10px] font-medium",
                          permissionPreset === preset ? "text-primary" : "text-foreground"
                        )}
                      >
                        {config.label}
                      </span>
                    </button>
                  )
                })}
              </div>
              {permissionPreset === "custom" && (
                <div className="border bg-background p-2">
                  <PermissionToggles value={permissions} onChange={setPermissions} />
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Create Button */}
      <Button
        className="h-10 w-full gap-2 text-sm font-medium"
        onClick={handleCreate}
        disabled={isSubmitting || !projectId || (portalType === "sub" && !companyId)}
      >
        {isSubmitting ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <Link2 className="h-4 w-4" />
        )}
        Create link
      </Button>

      {/* Success State */}
      {lastCreated && (
        <div className="border-2 border-success/30 bg-success/5 p-3 overflow-hidden">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center bg-success/10">
                <CheckCircle2 className="h-4 w-4 text-success" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-success">Link ready</p>
                <p className="text-[10px] text-muted-foreground">Copy and share</p>
              </div>
            </div>
            <Badge variant="secondary" className="text-[10px] capitalize shrink-0">
              {lastCreated.portal_type}
            </Badge>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1 border bg-background px-2 py-1 overflow-hidden min-w-0">
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {createdUrl}
              </span>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1 gap-1.5 h-8"
                onClick={() => copy(createdUrl)}
                disabled={!createdUrl}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8 shrink-0"
                onClick={() => createdUrl && window.open(createdUrl, "_blank", "noopener,noreferrer")}
                disabled={!createdUrl}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
