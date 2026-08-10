"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import {
  REVIEWER_ROLE_LABELS,
  type Contact,
  type KnownExternalContact,
  type PortalAccessToken,
  type PortalPermissions,
  type Project,
  type ProjectVendor,
  type ReviewerRole,
} from "@/lib/types"
import type { ProjectPosture } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"
import {
  createPortalTokenAction,
  loadKnownExternalContactsAction,
  loadProjectVendorsAction,
} from "@/app/(app)/sharing/actions"
import { sendPortalInviteAction } from "@/app/(app)/contacts/actions"
import { unwrapAction } from "@/lib/action-result"

import {
  InviteAccessOptions,
  type PermissionPreset,
} from "@/components/sharing/invite-access-options"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Check,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Send,
} from "@/components/icons"

type InviteAudience = "client" | "sub" | "reviewer"

const PORTAL_PATH: Record<InviteAudience, string> = { client: "p", sub: "s", reviewer: "r" }

const REVIEWER_COMPANY_TYPES = new Set(["architect", "engineer", "consultant"])

const AUDIENCE_SEARCH_TERM: Record<InviteAudience, string> = {
  client: "client owner buyer",
  sub: "subcontractor",
  reviewer: "reviewer",
}

const READ_ONLY_PERMISSIONS: Partial<PortalPermissions> = {
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
}

/**
 * One invitable person. `contactId === null` is a link with nobody's name on it —
 * still a real access record, just one no email can be sent to.
 */
interface InviteCandidate {
  key: string
  contactId: string | null
  audience: InviteAudience
  title: string
  subtitle: string
  email: string | null
  companyId?: string
  hasAccount?: boolean
}

export interface ProjectInviteFormProps {
  projectId: string
  project: Project
  posture: ProjectPosture
  contacts: Contact[]
  projectVendors: ProjectVendor[]
  onCreated: (token: PortalAccessToken) => void
  enabled?: boolean
}

/**
 * Adding someone to a project. The verb is "invite this person", not "create a
 * link": the access record is a person, and email vs. copied URL is only how the
 * first message reaches them. Link-copy stays available for the sub who will not
 * get email working, but it is the fallback, not a peer choice.
 */
export function ProjectInviteForm({
  projectId,
  project,
  posture,
  contacts,
  projectVendors,
  onCreated,
  enabled = true,
}: ProjectInviteFormProps) {
  const terms = terminology(posture)

  // Seeded from the prop so the picker is populated on first open; the fetch
  // below refreshes it with the full project roster.
  const [vendors, setVendors] = useState<ProjectVendor[]>(projectVendors)
  const [isLoadingVendors, setIsLoadingVendors] = useState(false)
  const [knownContacts, setKnownContacts] = useState<KnownExternalContact[]>([])

  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState("")
  const [audienceOverride, setAudienceOverride] = useState<InviteAudience | null>(null)
  const [reviewerRole, setReviewerRole] = useState<ReviewerRole>("architect")

  const [optionsOpen, setOptionsOpen] = useState(false)
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>("standard")
  const [permissions, setPermissions] = useState<Partial<PortalPermissions>>({})
  const defaultExpires = useMemo(() => format(addDays(new Date(), 90), "yyyy-MM-dd"), [])
  const [expiresAt, setExpiresAt] = useState(defaultExpires)
  const [requirePin, setRequirePin] = useState(false)
  const [pin, setPin] = useState("")

  const [isSubmitting, startTransition] = useTransition()
  const [lastCreated, setLastCreated] = useState<PortalAccessToken | null>(null)
  const [createdUrl, setCreatedUrl] = useState("")
  const [lastWasEmailed, setLastWasEmailed] = useState(false)

  const [origin, setOrigin] = useState(process.env.NEXT_PUBLIC_APP_URL || "")

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  useEffect(() => {
    if (!enabled || !projectId) return
    setIsLoadingVendors(true)
    loadProjectVendorsAction(projectId)
      .then(setVendors)
      .catch(() => toast.error("Couldn't load the subcontractor list"))
      .finally(() => setIsLoadingVendors(false))
  }, [projectId, enabled])

  // People this builder already works with. Scoped to identities holding a live
  // grant in THIS org — a free-text identity search would let any builder probe
  // whether an arbitrary email has an Arc account.
  useEffect(() => {
    if (!enabled) return
    loadKnownExternalContactsAction()
      .then(setKnownContacts)
      .catch(() => {
        // Suggestions are a convenience; inviting works without them.
      })
  }, [enabled])

  useEffect(() => {
    if (permissionPreset === "standard") setPermissions({})
    else if (permissionPreset === "read_only") setPermissions(READ_ONLY_PERMISSIONS)
  }, [permissionPreset])

  const knownByEmail = useMemo(() => {
    const map = new Map<string, KnownExternalContact>()
    for (const known of knownContacts) map.set(known.email.trim().toLowerCase(), known)
    return map
  }, [knownContacts])

  const clientCandidates = useMemo<InviteCandidate[]>(() => {
    const prioritized = contacts
      .filter((contact) => !!contact.email)
      .filter((contact) => contact.contact_type === "client" || contact.id === project.client_id)
      .sort((a, b) => {
        if (a.id === project.client_id) return -1
        if (b.id === project.client_id) return 1
        return a.full_name.localeCompare(b.full_name)
      })

    const source =
      prioritized.length > 0
        ? prioritized
        : contacts.filter((contact) => !!contact.email).sort((a, b) => a.full_name.localeCompare(b.full_name))

    return source.map((contact) => ({
      key: `client:${contact.id}`,
      contactId: contact.id,
      audience: "client" as const,
      title: contact.full_name,
      subtitle:
        contact.role ||
        (contact.id === project.client_id ? `Project ${terms.owner.toLowerCase()}` : `${terms.owner} contact`),
      email: contact.email ?? null,
    }))
  }, [contacts, project.client_id, terms.owner])

  const subCandidates = useMemo<InviteCandidate[]>(() => {
    const list: InviteCandidate[] = []
    const seen = new Set<string>()

    for (const vendor of vendors) {
      const contact = vendor.contact
      if (!contact?.id || !contact.email || seen.has(contact.id)) continue
      seen.add(contact.id)
      list.push({
        key: `sub:${contact.id}`,
        contactId: contact.id,
        audience: "sub",
        title: contact.full_name,
        subtitle: vendor.company?.name
          ? `${vendor.company.name}${vendor.role ? ` · ${vendor.role.replaceAll("_", " ")}` : ""}`
          : contact.role || "Trade partner",
        email: contact.email,
        companyId: vendor.company?.id,
      })
    }

    if (list.length === 0) {
      for (const contact of contacts) {
        const company = contact.company_details?.[0] ?? contact.primary_company
        if (!contact.email || !company?.name || seen.has(contact.id)) continue
        seen.add(contact.id)
        list.push({
          key: `sub:${contact.id}`,
          contactId: contact.id,
          audience: "sub",
          title: contact.full_name,
          subtitle: company.name,
          email: contact.email,
          companyId: company.id,
        })
      }
    }

    return list.sort((a, b) => a.title.localeCompare(b.title))
  }, [contacts, vendors])

  const reviewerCandidates = useMemo<InviteCandidate[]>(() => {
    const withEmail = contacts.filter((contact) => !!contact.email)
    const designTeam = withEmail.filter((contact) =>
      [contact.primary_company, ...(contact.company_details ?? [])]
        .filter(Boolean)
        .some((company) => REVIEWER_COMPANY_TYPES.has((company?.company_type ?? "").toLowerCase())),
    )

    return (designTeam.length > 0 ? designTeam : withEmail)
      .map((contact) => {
        const company = contact.primary_company ?? contact.company_details?.[0]
        return {
          key: `reviewer:${contact.id}`,
          contactId: contact.id,
          audience: "reviewer" as const,
          title: contact.full_name,
          subtitle: company?.name || contact.role || "External reviewer",
          email: contact.email ?? null,
          companyId: company?.id,
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [contacts])

  /** Worked with on other projects, not on this one yet. */
  const knownCandidates = useMemo<InviteCandidate[]>(() => {
    const onProject = new Set(
      [...clientCandidates, ...subCandidates, ...reviewerCandidates]
        .map((candidate) => candidate.email?.trim().toLowerCase())
        .filter(Boolean) as string[],
    )

    return knownContacts
      .filter((known) => known.contact_id && !onProject.has(known.email.trim().toLowerCase()))
      .map((known) => ({
        key: `known:${known.contact_id}`,
        contactId: known.contact_id,
        audience: (known.portal_type as InviteAudience) ?? "sub",
        title: known.full_name || known.email,
        subtitle: known.company_name ?? "Worked with before",
        email: known.email,
        companyId: known.company_id ?? undefined,
        hasAccount: true,
      }))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [clientCandidates, subCandidates, reviewerCandidates, knownContacts])

  /** Access records with nobody's name on them — kept, but out of the way. */
  const unnamedCandidates = useMemo<InviteCandidate[]>(() => {
    const list: InviteCandidate[] = [
      {
        key: "unnamed:client",
        contactId: null,
        audience: "client",
        title: `${terms.owner} link`,
        subtitle: "Anyone who opens it gets in",
        email: null,
      },
    ]

    for (const vendor of vendors) {
      if (!vendor.company) continue
      list.push({
        key: `unnamed:sub:${vendor.company.id}`,
        contactId: null,
        audience: "sub",
        title: `${vendor.company.name} — company-wide link`,
        subtitle: "No named contact",
        email: null,
        companyId: vendor.company.id,
      })
    }

    return list
  }, [vendors, terms.owner])

  const allCandidates = useMemo(
    () => [
      ...clientCandidates,
      ...subCandidates,
      ...reviewerCandidates,
      ...knownCandidates,
      ...unnamedCandidates,
    ],
    [clientCandidates, subCandidates, reviewerCandidates, knownCandidates, unnamedCandidates],
  )

  const selected = useMemo(
    () => allCandidates.find((candidate) => candidate.key === selectedKey) ?? null,
    [allCandidates, selectedKey],
  )

  const audience: InviteAudience = audienceOverride ?? selected?.audience ?? "client"
  const hasAccountAlready = selected
    ? selected.hasAccount || knownByEmail.has((selected.email ?? "").trim().toLowerCase())
    : false

  const resetResult = useCallback(() => {
    setLastCreated(null)
    setCreatedUrl("")
  }, [])

  const pickCandidate = useCallback(
    (key: string) => {
      setSelectedKey(key)
      setAudienceOverride(null)
      setPickerOpen(false)
      resetResult()
    },
    [resetResult],
  )

  async function copyToClipboard(value: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value)
        toast.success("Link copied")
        return
      } catch {
        // Fall through to the textarea path (iOS, older browsers).
      }
    }
    try {
      const textArea = document.createElement("textarea")
      textArea.value = value
      textArea.style.position = "fixed"
      textArea.style.left = "-9999px"
      document.body.appendChild(textArea)
      textArea.select()
      const ok = document.execCommand("copy")
      document.body.removeChild(textArea)
      toast[ok ? "success" : "error"](ok ? "Link copied" : "Unable to copy link")
    } catch {
      toast.error("Unable to copy link")
    }
  }

  function validate(): string | null {
    if (!projectId) return "Select a project first"
    if (!selected) return "Choose who you're inviting"
    if (audience === "sub" && !selected.companyId) {
      return "Subcontractor access needs a company — pick someone with one, or add them to the project team"
    }
    // A reviewer seat is a named person: the stamp and the review record carry
    // their name, so an anonymous link has nothing to sign with.
    if (audience === "reviewer" && !selected.contactId) {
      return "Reviewer access needs a named person, not a shared link"
    }
    if (requirePin && !/^[0-9]{4,6}$/.test(pin)) return "Enter a 4-6 digit PIN"
    return null
  }

  function submit(method: "email" | "link") {
    const problem = validate()
    if (problem) {
      toast.error(problem)
      return
    }
    if (!selected) return

    startTransition(async () => {
      try {
        if (method === "email" && selected.contactId && selected.email) {
          const result = unwrapAction(
            await sendPortalInviteAction({
              contactId: selected.contactId,
              projectId,
              portalType: audience,
              reviewerRole: audience === "reviewer" ? reviewerRole : undefined,
              expiresAt: expiresAt || null,
              permissions,
              pin: requirePin ? pin : undefined,
            }),
          )

          setLastCreated(result.token)
          setLastWasEmailed(result.email_sent)
          onCreated(result.token)
          setCreatedUrl(`${origin}/${PORTAL_PATH[audience]}/${result.token.token}`)

          if (result.email_sent) {
            toast.success(`Invite sent to ${result.sent_to}`)
          } else {
            toast.warning("Access created, but the email couldn't be sent", {
              description: "Share the link below instead.",
            })
          }
          return
        }

        const token = unwrapAction(
          await createPortalTokenAction({
            project_id: projectId,
            portal_type: audience,
            company_id: audience === "client" ? undefined : selected.companyId,
            contact_id: selected.contactId ?? undefined,
            reviewer_role: audience === "reviewer" ? reviewerRole : undefined,
            expires_at: expiresAt || null,
            permissions,
            pin: requirePin ? pin : undefined,
          }),
        )

        setLastCreated(token)
        setLastWasEmailed(false)
        onCreated(token)
        setCreatedUrl(`${origin}/${PORTAL_PATH[audience]}/${token.token}`)
        setPin("")
        toast.success("Access created")
      } catch (error: any) {
        toast.error(error?.message ?? "Couldn't create access")
      }
    })
  }

  const groups: Array<{ heading: string; items: InviteCandidate[] }> = [
    { heading: terms.owners, items: clientCandidates },
    { heading: "Subcontractors", items: subCandidates },
    { heading: "Design team", items: reviewerCandidates },
    { heading: "Worked with before", items: knownCandidates },
    { heading: "Links without a named person", items: unnamedCandidates },
  ]

  const canEmail = !!selected?.contactId && !!selected?.email

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] font-medium text-muted-foreground">Who are you inviting?</Label>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={pickerOpen}
              className="h-auto min-h-10 w-full justify-between gap-2 px-3 py-2 text-left font-normal"
            >
              <span className="min-w-0">
                {selected ? (
                  <>
                    <span className="block truncate text-sm font-medium">{selected.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {selected.email ?? selected.subtitle}
                      {hasAccountAlready ? " · has an Arc account" : ""}
                    </span>
                  </>
                ) : (
                  <span className="block truncate text-sm text-muted-foreground">
                    Search people on this project
                  </span>
                )}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(28rem,calc(100vw-3rem))] p-0">
            <Command>
              <CommandInput placeholder="Search by name, company, or email" />
              <CommandList>
                <CommandEmpty>
                  {isLoadingVendors ? "Loading people…" : "Nobody matches. Add them as a contact first."}
                </CommandEmpty>
                {groups
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <CommandGroup key={group.heading} heading={group.heading}>
                      {group.items.map((candidate) => (
                        <CommandItem
                          key={candidate.key}
                          // The audience word disambiguates the same contact
                          // appearing under two headings — cmdk collapses items
                          // that share a value — and is worth searching on.
                          value={`${AUDIENCE_SEARCH_TERM[candidate.audience]} ${candidate.title} ${candidate.subtitle} ${candidate.email ?? ""}`}
                          onSelect={() => pickCandidate(candidate.key)}
                          className="gap-2"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{candidate.title}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {[candidate.email, candidate.subtitle].filter(Boolean).join(" · ")}
                              {candidate.hasAccount ? " · has an Arc account" : ""}
                            </span>
                          </span>
                          {candidate.key === selectedKey ? (
                            <Check className="size-4 shrink-0 text-primary" />
                          ) : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {selected ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground">What they can reach</Label>
              <Select
                value={audience}
                onValueChange={(value) => {
                  setAudienceOverride(value as InviteAudience)
                  resetResult()
                }}
              >
                <SelectTrigger className="h-9 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">{terms.ownerPortal}</SelectItem>
                  <SelectItem value="sub">Subcontractor portal</SelectItem>
                  <SelectItem value="reviewer">Reviewer portal</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {audience === "reviewer" ? (
              <div className="space-y-1.5">
                <Label className="text-[11px] font-medium text-muted-foreground">Reviewer role</Label>
                <Select value={reviewerRole} onValueChange={(value) => setReviewerRole(value as ReviewerRole)}>
                  <SelectTrigger className="h-9 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(REVIEWER_ROLE_LABELS) as Array<[ReviewerRole, string]>).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <InviteAccessOptions
            open={optionsOpen}
            onOpenChange={setOptionsOpen}
            expiresAt={expiresAt}
            onExpiresAtChange={(value) => {
              setExpiresAt(value)
              resetResult()
            }}
            defaultExpires={defaultExpires}
            requirePin={requirePin}
            onRequirePinChange={setRequirePin}
            pin={pin}
            onPinChange={setPin}
            preset={permissionPreset}
            onPresetChange={setPermissionPreset}
            permissions={permissions}
            onPermissionsChange={(value) => {
              setPermissions(value)
              setPermissionPreset("custom")
            }}
          />

          <div className="space-y-1.5">
            <Button
              className="h-10 w-full gap-2 text-sm font-medium"
              disabled={isSubmitting}
              onClick={() => submit(canEmail ? "email" : "link")}
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : canEmail ? (
                <Send className="size-4" />
              ) : (
                <Link2 className="size-4" />
              )}
              {isSubmitting ? "Working…" : canEmail ? "Send invite" : "Create link"}
            </Button>

            {canEmail ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => submit("link")}
                className="w-full text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                or create a link to share yourself
              </button>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              {hasAccountAlready
                ? "They have an Arc account, so they'll sign in — the link only points them at it."
                : "They can open the link straight away, and claim an Arc account from inside the portal."}
            </p>
          </div>
        </div>
      ) : null}

      {lastCreated ? (
        <div className="space-y-2 border border-success/25 bg-success/5 p-3">
          <div className="flex items-center gap-2">
            <Check className="size-4 shrink-0 text-success" />
            <p className="text-sm font-medium text-success">
              {lastWasEmailed ? "Invite sent" : "Access created"}
            </p>
          </div>
          <p className="truncate border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
            {createdUrl}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1 gap-1.5 text-xs"
              onClick={() => copyToClipboard(createdUrl)}
              disabled={!createdUrl}
            >
              <Copy className="size-3.5" />
              Copy link
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => createdUrl && window.open(createdUrl, "_blank", "noopener,noreferrer")}
              disabled={!createdUrl}
            >
              <ExternalLink className="size-3.5" />
              Open
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
