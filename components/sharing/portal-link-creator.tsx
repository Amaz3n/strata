"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"
import {
  Mail,
  Send,
  ShieldCheck,
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
  ChevronDown,
  Copy,
  ExternalLink,
  Check,
  Loader2,
  Info
} from "lucide-react"

import type { PortalAccessToken, PortalPermissions, ProjectVendor, Contact, Project } from "@/lib/types"
import { createPortalTokenAction, loadProjectVendorsAction } from "@/app/(app)/sharing/actions"
import { sendPortalInviteAction } from "@/app/(app)/contacts/actions"
import { cn } from "@/lib/utils"

import { PermissionToggles } from "@/components/sharing/permission-toggles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface PortalLinkCreatorProps {
  projectId: string
  project: Project
  contacts: Contact[]
  projectVendors: ProjectVendor[]
  onCreated: (token: PortalAccessToken) => void
  enabled?: boolean
}

type PermissionPreset = "standard" | "read_only" | "custom"
type ShareMethod = "email" | "link"

interface InviteCandidate {
  contactId: string
  title: string
  subtitle: string
  email: string
  companyId?: string
}

const defaultExpires = format(addDays(new Date(), 90), "yyyy-MM-dd")

export function PortalLinkCreator({
  projectId,
  project,
  contacts,
  projectVendors,
  onCreated,
  enabled = true
}: PortalLinkCreatorProps) {
  const [portalType, setPortalType] = useState<"client" | "sub">("client")
  const [shareMethod, setShareMethod] = useState<ShareMethod>("email")
  const [companyId, setCompanyId] = useState("")
  const [selectedContactId, setSelectedContactId] = useState("")

  const [vendors, setVendors] = useState<ProjectVendor[]>([])
  const [isLoadingVendors, setIsLoadingVendors] = useState(false)

  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>("standard")
  const [permissions, setPermissions] = useState<Partial<PortalPermissions>>({})
  const [expiresAt, setExpiresAt] = useState<string>(defaultExpires)
  const [requirePin, setRequirePin] = useState(false)
  const [pin, setPin] = useState("")

  const [isSubmitting, startTransition] = useTransition()
  const [lastCreated, setLastCreated] = useState<PortalAccessToken | null>(null)
  const [createdUrl, setCreatedUrl] = useState("")

  const fallbackOrigin = process.env.NEXT_PUBLIC_APP_URL || ""
  const [origin, setOrigin] = useState(fallbackOrigin)

  useEffect(() => {
    if (typeof window === "undefined") return
    setOrigin(window.location.origin)
  }, [])

  // Load project vendors for subcontractor lists
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

  // Reset states when changing portal types
  useEffect(() => {
    setCompanyId("")
    setSelectedContactId("")
    setLastCreated(null)
    setCreatedUrl("")
  }, [portalType])

  // Reset success state when fields change
  useEffect(() => {
    setLastCreated(null)
    setCreatedUrl("")
  }, [companyId, selectedContactId, shareMethod])

  // Candidates lists logic
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
        companyId: vendor.company?.id
      })
    }

    if (unique.size === 0) {
      for (const contact of contacts) {
        const companyName = contact.company_details?.[0]?.name || contact.primary_company?.name
        const companyId = contact.company_details?.[0]?.id || contact.primary_company?.id
        if (!contact.email || !companyName) continue
        if (unique.has(contact.id)) continue
        unique.set(contact.id, {
          contactId: contact.id,
          title: contact.full_name,
          subtitle: companyName,
          email: contact.email,
          companyId
        })
      }
    }

    return Array.from(unique.values()).sort((a, b) => a.title.localeCompare(b.title))
  }, [contacts, projectVendors])

  const candidates = portalType === "client" ? clientCandidates : subCandidates

  // Filter subcontractor contacts dynamically by the selected company
  const subCandidatesForCompany = useMemo(() => {
    if (!companyId) return []
    return subCandidates.filter(c => c.companyId === companyId)
  }, [subCandidates, companyId])

  const selectedCandidate = useMemo(() => {
    if (!selectedContactId || selectedContactId === "generic") return null
    return candidates.find((c) => c.contactId === selectedContactId) ?? null
  }, [selectedContactId, candidates])

  // Automatically switch sharing method to "link" if a generic link is selected (since you can't email a generic link)
  useEffect(() => {
    if (selectedContactId === "generic" || !selectedContactId) {
      setShareMethod("link")
    } else {
      setShareMethod("email")
    }
  }, [selectedContactId])

  // Pre-select first subcontractor candidate when company is chosen
  useEffect(() => {
    if (portalType === "sub" && companyId) {
      if (subCandidatesForCompany.length > 0) {
        setSelectedContactId(subCandidatesForCompany[0].contactId)
      } else {
        setSelectedContactId("generic")
      }
    }
  }, [companyId, portalType, subCandidatesForCompany])

  // Pre-select first client candidate on load
  useEffect(() => {
    if (portalType === "client" && clientCandidates.length > 0 && !selectedContactId) {
      setSelectedContactId(clientCandidates[0].contactId)
    }
  }, [portalType, clientCandidates, selectedContactId])

  // Apply permission preset
  useEffect(() => {
    if (permissionPreset === "custom") return
    if (permissionPreset === "standard") {
      setPermissions({})
      return
    }
    setPermissions({
      can_pay_invoices: false,
      can_respond_rfis: false,
      can_submit_submittals: false,
      can_approve_change_orders: false,
      can_submit_selections: false,
      can_create_punch_items: false,
      can_view_warranty: false,
      can_submit_invoices: false,
      can_submit_time: false,
      can_submit_expenses: false,
      can_upload_compliance_docs: false,
    })
  }, [permissionPreset])

  const hasEmailRecipient = !!selectedCandidate?.email

  async function copyToClipboard(text: string) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
        return
      }
      
      const textArea = document.createElement("textarea")
      textArea.value = text
      textArea.style.position = "fixed"
      textArea.style.left = "-9999px"
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

  function handleAction() {
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

    startTransition(async () => {
      try {
        if (shareMethod === "email" && selectedContactId && selectedContactId !== "generic") {
          // --- Method A: Secure Email-First Access ---
          const result = await sendPortalInviteAction({
            contactId: selectedContactId,
            projectId: projectId,
            portalType,
          })
          
          setLastCreated(result.token)
          onCreated(result.token)
          setCreatedUrl(`${origin}/${portalType === "client" ? "p" : "s"}/${result.token.token}`)
          
          if (result.email_sent) {
            toast.success("Secure email invite sent", {
              description: `An invite was successfully sent to ${result.sent_to}.`,
            })
          } else {
            toast.warning("Direct link created, but email could not be sent", {
              description: "Use the generated link below to share manual access.",
            })
          }
        } else {
          // --- Method B: Direct Access Link ---
          const token = await createPortalTokenAction({
            project_id: projectId,
            portal_type: portalType,
            company_id: portalType === "sub" ? companyId : undefined,
            contact_id: (selectedContactId && selectedContactId !== "generic") ? selectedContactId : undefined,
            expires_at: expiresAt || null,
            permissions,
            pin: requirePin ? pin : undefined,
          })

          setLastCreated(token)
          onCreated(token)
          setCreatedUrl(`${origin}/${portalType === "client" ? "p" : "s"}/${token.token}`)
          setPin("")
          toast.success("Access link created successfully")
        }
      } catch (error: any) {
        console.error("Portal access operation failed:", error)
        toast.error(error?.message ?? "An error occurred during creation")
      }
    })
  }

  const presetConfig = {
    standard: {
      icon: Shield,
      label: "Standard",
    },
    read_only: {
      icon: Eye,
      label: "View only",
    },
    custom: {
      icon: Settings,
      label: "Custom",
    },
  }

  return (
    <div className="space-y-5">
      {/* 1. Portal Audience (Segmented Switcher) */}
      <div className="space-y-1.5">
        <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Audience
        </Label>
        <div className="grid grid-cols-2 gap-1.5 bg-muted/40 p-1 rounded-none border border-border/80">
          <button
            type="button"
            onClick={() => setPortalType("client")}
            className={cn(
              "flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-none transition-all",
              portalType === "client"
                ? "bg-background text-foreground shadow-sm border border-border/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            <User className="h-3.5 w-3.5" />
            <span>Client</span>
          </button>
          <button
            type="button"
            onClick={() => setPortalType("sub")}
            className={cn(
              "flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-none transition-all",
              portalType === "sub"
                ? "bg-background text-foreground shadow-sm border border-border/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            <Users className="h-3.5 w-3.5" />
            <span>Subcontractor</span>
          </button>
        </div>
      </div>

      {/* 2. Dynamic Recipient Selectors */}
      <div className="space-y-4">
        {portalType === "client" ? (
          /* Client Recipient Selection */
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Recipient
            </Label>
            <Select value={selectedContactId} onValueChange={setSelectedContactId}>
              <SelectTrigger className="h-10 w-full bg-background/50 border border-border rounded-none shadow-sm focus:ring-2 focus:ring-primary/20">
                <SelectValue placeholder="Choose homeowner or generic link" />
              </SelectTrigger>
              <SelectContent className="rounded-none">
                <SelectItem value="generic" className="focus:bg-primary/5">
                  <span className="font-semibold text-primary block">Generic Client Link</span>
                  <span className="text-[10px] text-muted-foreground block">Creates a shareable manual link anyone can use</span>
                </SelectItem>
                {clientCandidates.map((candidate) => (
                  <SelectItem key={candidate.contactId} value={candidate.contactId} className="focus:bg-primary/5">
                    <span className="font-semibold block">{candidate.title}</span>
                    <span className="text-[10px] text-muted-foreground block">
                      {candidate.email} • {candidate.subtitle}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          /* Subcontractor Recipient Selection */
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Subcontractor Company
              </Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger className="h-10 w-full bg-background/50 border border-border rounded-none shadow-sm">
                  <SelectValue placeholder={isLoadingVendors ? "Loading..." : "Select subcontractor company"} />
                </SelectTrigger>
                <SelectContent className="rounded-none">
                  {vendors
                    .filter((v) => v.company)
                    .map((vendor) => (
                      <SelectItem key={vendor.id} value={vendor.company!.id}>
                        <div className="flex items-center gap-2 py-0.5">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-semibold">{vendor.company!.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {vendors.length === 0 && !isLoadingVendors && (
                <p className="text-[11px] text-muted-foreground pl-1">
                  Add a subcontractor vendor to the project team to share access.
                </p>
              )}
            </div>

            {companyId && (
              <div className="space-y-1.5 animate-fadeIn">
                <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Contact Recipient
                </Label>
                <Select value={selectedContactId} onValueChange={setSelectedContactId}>
                  <SelectTrigger className="h-10 w-full bg-background/50 border border-border rounded-none shadow-sm focus:ring-2 focus:ring-primary/20">
                    <SelectValue placeholder="Select subcontractor contact" />
                  </SelectTrigger>
                  <SelectContent className="rounded-none">
                    <SelectItem value="generic">
                      <span className="font-semibold text-primary block">Company-wide Link (No contact email)</span>
                      <span className="text-[10px] text-muted-foreground block">Generates a direct company link for manual sharing</span>
                    </SelectItem>
                    {subCandidatesForCompany.map((candidate) => (
                      <SelectItem key={candidate.contactId} value={candidate.contactId}>
                        <span className="font-semibold block">{candidate.title}</span>
                        <span className="text-[10px] text-muted-foreground block">{candidate.email}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Sharing Method (Segmented Switcher) */}
      <div className="space-y-2">
        <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Access Method
        </Label>
        <div className="grid grid-cols-2 gap-1.5 bg-muted/40 p-1 rounded-none border border-border/80">
          <button
            type="button"
            onClick={() => setShareMethod("email")}
            disabled={!hasEmailRecipient}
            className={cn(
              "flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-none transition-all",
              shareMethod === "email"
                ? "bg-background text-foreground shadow-sm border border-border/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30",
              !hasEmailRecipient && "opacity-40 cursor-not-allowed hover:bg-transparent"
            )}
          >
            <Mail className="h-3.5 w-3.5" />
            <span>Email Invite</span>
          </button>
          <button
            type="button"
            onClick={() => setShareMethod("link")}
            className={cn(
              "flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-none transition-all",
              shareMethod === "link"
                ? "bg-background text-foreground shadow-sm border border-border/20"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>Direct Link</span>
          </button>
        </div>

        {/* Method Explanation Text */}
        <div className="flex items-start gap-2 px-1 text-[11px] text-muted-foreground leading-normal">
          <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
          {shareMethod === "email" ? (
            <p>
              We'll send a secure email invite directly. The recipient can use the link from their email, then optionally claim an Arc account from inside the portal.
            </p>
          ) : (
            <p>
              Generates an instant, reusable access URL. Perfect for manual sharing, texting, or testing purposes.
            </p>
          )}
        </div>
      </div>

      {/* 4. Advanced Access Control (Collapsible with smooth transition) */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="border border-border/80 bg-muted/10 rounded-none overflow-hidden shadow-sm">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between px-4 py-3 text-xs font-semibold transition-all hover:bg-muted/30",
              advancedOpen && "border-b border-border/60 bg-muted/40"
            )}
          >
            <div className="flex items-center gap-2">
              <Settings className={cn("h-3.5 w-3.5", advancedOpen ? "text-primary animate-spin-slow" : "text-muted-foreground")} />
              <span>Access Control & Permissions</span>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform duration-200",
                advancedOpen && "rotate-180"
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="animate-slideDown">
          <div className="p-4 space-y-5">
            {/* Expiry */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <Label className="text-xs font-semibold">Link Expiration</Label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant={!expiresAt ? "secondary" : "outline"}
                  type="button"
                  onClick={() => setExpiresAt("")}
                  className="h-7 text-xs rounded-none"
                >
                  Never
                </Button>
                <Button
                  size="sm"
                  variant={expiresAt === defaultExpires ? "secondary" : "outline"}
                  type="button"
                  onClick={() => setExpiresAt(defaultExpires)}
                  className="h-7 text-xs rounded-none"
                >
                  90 Days
                </Button>
                <Input
                  type="date"
                  value={expiresAt ?? ""}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="h-7 w-auto text-xs rounded-none px-2"
                />
              </div>
            </div>

            {/* Security PIN */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Lock className="h-4 w-4" />
                  <Label className="text-xs font-semibold">Security PIN Lock</Label>
                </div>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-none transition-all border",
                    requirePin
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-background border-border text-muted-foreground hover:bg-muted/50"
                  )}
                  onClick={() => setRequirePin((v) => !v)}
                >
                  {requirePin ? "Active" : "Disabled"}
                </button>
              </div>
              {requirePin && (
                <Input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="Create 4-6 digit security PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="h-9 font-mono text-xs tracking-widest rounded-none focus:ring-2 focus:ring-primary/20"
                />
              )}
            </div>

            {/* Permission Presets */}
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Shield className="h-4 w-4" />
                <Label className="text-xs font-semibold">Access Level Settings</Label>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(["standard", "read_only", "custom"] as const).map((preset) => {
                  const config = presetConfig[preset]
                  const Icon = config.icon
                  const active = permissionPreset === preset
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setPermissionPreset(preset)}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1 border py-2 text-center rounded-none transition-all",
                        active
                          ? "border-primary bg-primary/5 text-primary shadow-sm"
                          : "border-border/60 bg-background text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="text-[10px] font-semibold">{config.label}</span>
                    </button>
                  )
                })}
              </div>
              {permissionPreset === "custom" && (
                <div className="border border-border/80 bg-background rounded-none p-3 animate-fadeIn mt-2 shadow-inner">
                  <PermissionToggles value={permissions} onChange={setPermissions} />
                </div>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* 5. Main Action Button */}
      <Button
        className="h-11 w-full gap-2 text-sm font-semibold rounded-none shadow-md transition-all hover:translate-y-[-1px] active:translate-y-[0]"
        onClick={handleAction}
        disabled={isSubmitting || !projectId || (portalType === "sub" && !companyId)}
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : shareMethod === "email" ? (
          <Send className="h-4 w-4" />
        ) : (
          <Link2 className="h-4 w-4" />
        )}
        {isSubmitting
          ? "Processing..."
          : shareMethod === "email"
          ? "Send Secure Invite"
          : "Generate Access Link"}
      </Button>

      {/* 6. Success State Layout */}
      {lastCreated && (
        <div className="border-2 border-emerald-500/25 bg-emerald-500/5 p-4 rounded-none animate-fadeIn overflow-hidden space-y-4">
          <div className="flex items-center justify-between gap-3 border-b border-emerald-500/10 pb-3">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-emerald-500/15 rounded-none border border-emerald-500/20">
                <Check className="h-4 w-4 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-800">
                  {shareMethod === "email" ? "Secure Invite Sent!" : "Direct Link Ready!"}
                </p>
                <p className="text-[10px] text-emerald-700/80">
                  {shareMethod === "email" ? "Recipient has been notified" : "Access link has been created"}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="text-[9px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-800 border-emerald-500/20 px-2 py-0.5 rounded-none">
              {lastCreated.portal_type}
            </Badge>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 border border-emerald-500/10 bg-background/80 rounded-none px-3 py-2 overflow-hidden shadow-inner min-w-0">
              <span className="truncate font-mono text-xs text-muted-foreground select-all w-full">
                {createdUrl}
              </span>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1 gap-1.5 h-9 text-xs rounded-none font-semibold bg-emerald-600 hover:bg-emerald-700 active:scale-95 transition-all text-white shadow-sm"
                onClick={() => copyToClipboard(createdUrl)}
                disabled={!createdUrl}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy Link
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-9 text-xs rounded-none font-semibold border-emerald-500/25 text-emerald-800 hover:bg-emerald-500/10 active:scale-95 transition-all bg-background"
                onClick={() => createdUrl && window.open(createdUrl, "_blank", "noopener,noreferrer")}
                disabled={!createdUrl}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open Portal
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
