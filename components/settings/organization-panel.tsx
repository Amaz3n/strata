"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"

import { Building2, Camera } from "@/components/icons"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ContractTemplateSettings } from "@/components/settings/contract-template-settings"
import { DocumentNumberingForm } from "@/components/settings/document-numbering-form"
import { InfoRow, RowControl, SettingsError, SettingsField, SettingsGroup } from "@/components/settings/settings-section"
import {
  getOrganizationSettingsAction,
  updateOrganizationLogoAction,
  updateOrganizationSettingsAction,
} from "@/app/(app)/settings/actions"
import { unwrapAction } from "@/lib/action-result"
import { formatDocNumber, type DocumentNumberingSettings } from "@/lib/document-number"
import type { TeamMember } from "@/lib/types"
import packageJson from "@/package.json"
import { cn } from "@/lib/utils"

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]
const MAX_LOGO_BYTES = 5 * 1024 * 1024
const LOGO_HINT = "PNG, JPG, WEBP, or SVG. 5MB max."

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/

const FONT_OPTIONS = [
  { value: "", label: "Default (system sans)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Serif (Georgia)" },
  { value: "'Inter', system-ui, sans-serif", label: "Inter" },
  { value: "'Courier New', ui-monospace, monospace", label: "Monospace" },
] as const

type SignerMode = "estimate_creator" | "prospect_owner" | "specific_user"

const SIGNER_MODE_LABEL: Record<SignerMode, string> = {
  estimate_creator: "Estimate creator",
  prospect_owner: "Prospect owner",
  specific_user: "Specific teammate",
}

const APP_INFO = {
  company: "Arc Project Systems LLC",
  version: packageJson.version ?? "0.1.0",
  termsUrl: "/terms",
  privacyUrl: "/privacy",
  websiteUrl: "https://arcnaples.com",
}

type OrgSettings = Awaited<ReturnType<typeof getOrganizationSettingsAction>>

/** The org "organization" section is saved whole — the action overwrites every key
 *  from the payload — so a one-field edit sends the full current set plus its change. */
type OrgSectionInput = {
  proposalTermsTemplate: string
  estimateTermsTemplate: string
  estimateAccentColor: string
  estimateFont: string
  estimateIntroTemplate: string
  estimateBuilderSignerMode: SignerMode
  estimateBuilderSignerUserId: string
}

function fontLabel(value: string) {
  return FONT_OPTIONS.find((option) => option.value === value)?.label ?? "Custom"
}

type EditKey = "estimate_terms" | "proposal_terms" | "cover_note" | "appearance" | "signer" | "numbering"

export function OrganizationPanel({
  initialDocumentNumbering,
  teamMembers,
  teamLoading = false,
}: {
  initialDocumentNumbering: DocumentNumberingSettings | null
  teamMembers: TeamMember[]
  teamLoading?: boolean
}) {
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [numbering, setNumbering] = useState<DocumentNumberingSettings | null>(initialDocumentNumbering)
  const [editing, setEditing] = useState<EditKey | null>(null)

  // Logo — the one thing edited in place, mirroring the Profile avatar.
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [updatingLogo, setUpdatingLogo] = useState(false)
  const logoInputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    getOrganizationSettingsAction()
      .then((data) => {
        setSettings(data)
        setLogoUrl(data.logoUrl ?? null)
      })
      .catch((error) => {
        console.error("Failed to load organization settings", error)
        setLoadError("We couldn't load your organization settings right now.")
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
    }
  }, [logoPreview])

  const canManage = settings?.canManageOrganization ?? false

  const saveOrgSection = useCallback(
    async (patch: Partial<OrgSectionInput>): Promise<string | null> => {
      if (!settings) return "Organization settings aren't loaded yet."
      const next: OrgSectionInput = {
        proposalTermsTemplate: settings.proposalTermsTemplate,
        estimateTermsTemplate: settings.estimateTermsTemplate,
        estimateAccentColor: settings.estimateAccentColor,
        estimateFont: settings.estimateFont,
        estimateIntroTemplate: settings.estimateIntroTemplate,
        estimateBuilderSignerMode: settings.estimateBuilderSignerMode,
        estimateBuilderSignerUserId: settings.estimateBuilderSignerUserId,
        ...patch,
      }
      try {
        const outcome = unwrapAction(
          await updateOrganizationSettingsAction({
            section: "organization",
            proposalTermsTemplate: next.proposalTermsTemplate,
            estimateTermsTemplate: next.estimateTermsTemplate,
            estimateAccentColor: next.estimateAccentColor,
            estimateFont: next.estimateFont,
            estimateIntroTemplate: next.estimateIntroTemplate,
            estimateBuilderSignerMode: next.estimateBuilderSignerMode,
            estimateBuilderSignerUserId: next.estimateBuilderSignerUserId || null,
          }),
        )
        if (outcome && "error" in outcome && outcome.error) return outcome.error
        setSettings((prev) => (prev ? { ...prev, ...next } : prev))
        return null
      } catch (error) {
        return error instanceof Error ? error.message : "Unable to save settings."
      }
    },
    [settings],
  )

  const handleLogoSelection = (file: File | null) => {
    if (!file || updatingLogo || !canManage) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setLogoError("That file type isn't supported. Use PNG, JPG, WEBP, or SVG.")
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("That logo is larger than 5MB. Pick a smaller one.")
      return
    }

    setLogoPreview(URL.createObjectURL(file))
    setLogoError(null)
    setUpdatingLogo(true)
    void (async () => {
      try {
        const payload = new FormData()
        payload.set("logo", file)
        const outcome = unwrapAction(await updateOrganizationLogoAction(payload))
        if (outcome && "error" in outcome && outcome.error) {
          setLogoError(outcome.error)
          setLogoPreview(null)
          return
        }
        setLogoUrl("error" in outcome ? null : outcome.logoUrl ?? null)
        setLogoPreview(null)
        toast.success("Organization logo updated")
      } catch (error) {
        setLogoError(error instanceof Error ? error.message : "Couldn't update the logo. Try again.")
        setLogoPreview(null)
      } finally {
        setUpdatingLogo(false)
        if (logoInputRef.current) logoInputRef.current.value = ""
      }
    })()
  }

  const handleLogoRemove = () => {
    if (updatingLogo || !canManage) return
    setLogoError(null)
    setUpdatingLogo(true)
    void (async () => {
      try {
        const payload = new FormData()
        payload.set("remove", "true")
        const outcome = unwrapAction(await updateOrganizationLogoAction(payload))
        if (outcome && "error" in outcome && outcome.error) {
          setLogoError(outcome.error)
          return
        }
        setLogoUrl(null)
        setLogoPreview(null)
        toast.success("Organization logo removed")
      } catch (error) {
        setLogoError(error instanceof Error ? error.message : "Couldn't remove the logo. Try again.")
      } finally {
        setUpdatingLogo(false)
        if (logoInputRef.current) logoInputRef.current.value = ""
      }
    })()
  }

  if (loading) {
    return (
      <div className={CONTAINER}>
        <div className="flex items-center gap-4">
          <Skeleton className="size-16 rounded-none" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3.5 w-64" />
          </div>
        </div>
        {Array.from({ length: 2 }).map((_, group) => (
          <div key={group} className="space-y-3">
            <Skeleton className="h-3 w-32" />
            {Array.from({ length: 3 }).map((_, row) => (
              <Skeleton key={row} className="h-10 w-full rounded-none" />
            ))}
          </div>
        ))}
      </div>
    )
  }

  if (loadError || !settings) {
    return (
      <div className={CONTAINER}>
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <p className="max-w-sm text-sm text-destructive">{loadError ?? "Organization settings are unavailable."}</p>
          <Button size="sm" variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const orgName = settings.name?.trim() || "Your organization"
  // The action infers this loosely; it's always one of the three modes.
  const signerMode: SignerMode = settings.estimateBuilderSignerMode
  const signerMember = teamMembers.find((member) => member.user?.id === settings.estimateBuilderSignerUserId)
  const signerSummary =
    signerMode === "specific_user"
      ? signerMember?.user?.full_name || signerMember?.user?.email || "Assigned teammate"
      : SIGNER_MODE_LABEL[signerMode]

  return (
    <div className={CONTAINER}>
      {/* Identity — the logo is the one thing edited in place; the name is a fact
          an admin owns, shown alongside it rather than as a field. */}
      <div
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          if (!updatingLogo && canManage) setDragging(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          setDragging(false)
          handleLogoSelection(event.dataTransfer.files?.[0] ?? null)
        }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <button
            type="button"
            onClick={() => logoInputRef.current?.click()}
            disabled={updatingLogo || !canManage}
            aria-label={logoUrl ? "Change organization logo" : "Upload an organization logo"}
            title={canManage ? LOGO_HINT : undefined}
            className={cn(
              "group relative size-16 shrink-0 border border-border transition-shadow",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              !canManage && "cursor-default",
              dragging && "border-primary ring-2 ring-primary/40",
            )}
          >
            <Avatar className="size-full rounded-none">
              <AvatarImage src={logoPreview ?? logoUrl ?? undefined} alt="" className="object-contain" />
              <AvatarFallback className="rounded-none bg-muted text-muted-foreground">
                <Building2 className="size-6" />
              </AvatarFallback>
            </Avatar>
            {canManage ? (
              <>
                <span
                  className={cn(
                    "absolute inset-0 flex items-center justify-center bg-foreground/55 text-background opacity-0 transition-opacity duration-150",
                    "group-hover:opacity-100 group-focus-visible:opacity-100",
                    (updatingLogo || dragging) && "opacity-100",
                  )}
                >
                  {updatingLogo ? <Spinner className="size-4" /> : <Camera className="size-4" />}
                </span>
                <span
                  className={cn(
                    "pointer-events-none absolute -bottom-1 -right-1 flex size-5 items-center justify-center border border-border bg-background text-muted-foreground transition-opacity",
                    "group-hover:opacity-0 group-focus-visible:opacity-0",
                    (updatingLogo || dragging) && "opacity-0",
                  )}
                >
                  <Camera className="size-3" />
                </span>
              </>
            ) : null}
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-medium leading-6 text-foreground">{orgName}</p>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {dragging ? "Drop the image to use it as your logo" : "Shown in the org switcher and on client-facing documents."}
            </p>
          </div>

          <input
            ref={logoInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            className="hidden"
            onChange={(event) => handleLogoSelection(event.target.files?.[0] ?? null)}
            disabled={updatingLogo || !canManage}
          />
          {logoUrl && canManage ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={handleLogoRemove}
              disabled={updatingLogo}
            >
              Remove
            </Button>
          ) : null}
        </div>
        {logoError ? <SettingsError className="mt-3">{logoError}</SettingsError> : null}
        {!canManage ? (
          <p className="mt-3 text-xs text-muted-foreground">Only organization admins can change these settings.</p>
        ) : null}
      </div>

      <SettingsGroup
        title="Estimates & proposals"
        description="Defaults applied to client-facing estimates and proposals. Per-document values always take precedence."
      >
        <EditRow
          label="Estimate terms"
          hint="Shown on the estimate PDF when no per-estimate terms are entered."
          value={settings.estimateTermsTemplate}
          emptyLabel="No default terms"
          canManage={canManage}
          onEdit={() => setEditing("estimate_terms")}
        />
        <EditRow
          label="Proposal terms"
          hint="Added to the proposal PDF above the signature block."
          value={settings.proposalTermsTemplate}
          emptyLabel="No default terms"
          canManage={canManage}
          onEdit={() => setEditing("proposal_terms")}
        />
        <EditRow
          label="Cover note"
          hint="A short intro seeded into every new estimate, above the line items."
          value={settings.estimateIntroTemplate}
          emptyLabel="No cover note"
          canManage={canManage}
          onEdit={() => setEditing("cover_note")}
        />
        <SettingsField label="Appearance" hint="Accent color and font for the client-facing estimate portal and PDF.">
          <RowControl canManage={canManage} onEdit={() => setEditing("appearance")}>
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-4 shrink-0 border border-border"
                style={{ backgroundColor: settings.estimateAccentColor || "transparent" }}
              />
              <span className="truncate text-sm text-foreground">
                {settings.estimateAccentColor ? (
                  <span className="font-mono text-xs uppercase">{settings.estimateAccentColor}</span>
                ) : (
                  <span className="text-muted-foreground">Default accent</span>
                )}
                <span className="text-muted-foreground"> · {fontLabel(settings.estimateFont)}</span>
              </span>
            </span>
          </RowControl>
        </SettingsField>
        <SettingsField label="Builder signature" hint="Who countersigns after a client signs an estimate.">
          <RowControl canManage={canManage} onEdit={() => setEditing("signer")}>
            <span className="truncate text-sm text-foreground">{signerSummary}</span>
          </RowControl>
        </SettingsField>
      </SettingsGroup>

      <p className="-mt-4 text-sm">
        <Link href="/settings/templates" className="font-medium text-primary hover:underline">
          Manage estimate templates →
        </Link>
      </p>

      <SettingsGroup
        title="Contract templates"
        description="Standard terms PDFs prepended to signature packets as the paper terms, with the Arc document as the exhibit."
      >
        <ContractTemplateSettings canManage={canManage} />
      </SettingsGroup>

      {numbering ? (
        <SettingsGroup
          title="Document numbering"
          description="Prefixes and zero-padding for RFIs, submittals, change orders, meetings, and transmittals."
        >
          <SettingsField label="Numbering" hint="Display format only — stored sequence numbers never change.">
            <RowControl canManage buttonLabel="Configure" onEdit={() => setEditing("numbering")}>
              <span className="truncate font-mono text-xs tabular-nums text-muted-foreground">
                {[
                  formatDocNumber("rfi", 7, numbering),
                  formatDocNumber("submittal", 7, numbering),
                  formatDocNumber("change_order", 7, numbering),
                ].join("   ·   ")}
              </span>
            </RowControl>
          </SettingsField>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Workspace">
        <InfoRow label="Workspace ID">
          <span className="break-all font-mono text-xs text-muted-foreground">{settings.id}</span>
        </InfoRow>
        <InfoRow label="Arc version">
          <span className="tabular-nums">{APP_INFO.version}</span>
        </InfoRow>
      </SettingsGroup>

      <p className="text-xs text-muted-foreground">
        <Link href={APP_INFO.websiteUrl} target="_blank" className="underline-offset-2 hover:underline">
          Website
        </Link>
        {" · "}
        <Link href={APP_INFO.termsUrl} className="underline-offset-2 hover:underline">
          Terms
        </Link>
        {" · "}
        <Link href={APP_INFO.privacyUrl} className="underline-offset-2 hover:underline">
          Privacy
        </Link>
        {" · "}© {new Date().getFullYear()} {APP_INFO.company}
      </p>

      <TextTemplateDialog
        open={editing === "estimate_terms"}
        onOpenChange={(next) => setEditing(next ? "estimate_terms" : null)}
        title="Estimate terms"
        description="Shown on the estimate PDF when no per-estimate terms are entered."
        placeholder="Estimate valid for 30 days. Pricing subject to final measurements and selections."
        initialValue={settings.estimateTermsTemplate}
        onSave={(value) => saveOrgSection({ estimateTermsTemplate: value })}
      />
      <TextTemplateDialog
        open={editing === "proposal_terms"}
        onOpenChange={(next) => setEditing(next ? "proposal_terms" : null)}
        title="Proposal terms"
        description="Added to the proposal PDF above the signature block."
        placeholder="Payment schedule, scope of work, warranty, and change-order terms…"
        initialValue={settings.proposalTermsTemplate}
        onSave={(value) => saveOrgSection({ proposalTermsTemplate: value })}
      />
      <TextTemplateDialog
        open={editing === "cover_note"}
        onOpenChange={(next) => setEditing(next ? "cover_note" : null)}
        title="Cover note"
        description="A short intro seeded into every new estimate, above the line items."
        placeholder="Thanks for the opportunity to bid your project. Below is a detailed breakdown of the scope and pricing…"
        initialValue={settings.estimateIntroTemplate}
        onSave={(value) => saveOrgSection({ estimateIntroTemplate: value })}
      />
      <AppearanceDialog
        open={editing === "appearance"}
        onOpenChange={(next) => setEditing(next ? "appearance" : null)}
        initialColor={settings.estimateAccentColor}
        initialFont={settings.estimateFont}
        onSave={(color, font) => saveOrgSection({ estimateAccentColor: color, estimateFont: font })}
      />
      <SignerDialog
        open={editing === "signer"}
        onOpenChange={(next) => setEditing(next ? "signer" : null)}
        initialMode={signerMode}
        initialUserId={settings.estimateBuilderSignerUserId}
        members={teamMembers}
        membersLoading={teamLoading}
        onSave={(mode, userId) =>
          saveOrgSection({ estimateBuilderSignerMode: mode, estimateBuilderSignerUserId: userId })
        }
      />
      {numbering ? (
        <Dialog open={editing === "numbering"} onOpenChange={(next) => setEditing(next ? "numbering" : null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Document numbering</DialogTitle>
              <DialogDescription>
                Prefixes and zero-padding control how document numbers display across the app.
              </DialogDescription>
            </DialogHeader>
            <DocumentNumberingForm
              initial={numbering}
              onSaved={(next) => {
                setNumbering(next)
                setEditing(null)
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

function EditRow({
  label,
  hint,
  value,
  emptyLabel,
  canManage,
  onEdit,
}: {
  label: string
  hint: string
  value: string
  emptyLabel: string
  canManage: boolean
  onEdit: () => void
}) {
  const trimmed = value.trim()
  return (
    <SettingsField label={label} hint={hint}>
      <RowControl canManage={canManage} onEdit={onEdit}>
        {trimmed ? (
          <p className="line-clamp-2 text-sm leading-6 text-foreground">{trimmed}</p>
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">{emptyLabel}</p>
        )}
      </RowControl>
    </SettingsField>
  )
}

function TextTemplateDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  initialValue,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  placeholder: string
  initialValue: string
  onSave: (value: string) => Promise<string | null>
}) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(initialValue)
      setError(null)
    }
  }, [open, initialValue])

  const submit = async () => {
    setSaving(true)
    setError(null)
    const result = await onSave(value.trim())
    setSaving(false)
    if (result) {
      setError(result)
      return
    }
    toast.success(`${title} saved`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          placeholder={placeholder}
          className="min-h-[168px]"
          autoFocus
          disabled={saving}
        />
        {error ? <SettingsError>{error}</SettingsError> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AppearanceDialog({
  open,
  onOpenChange,
  initialColor,
  initialFont,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialColor: string
  initialFont: string
  onSave: (color: string, font: string) => Promise<string | null>
}) {
  const [color, setColor] = useState(initialColor)
  const [font, setFont] = useState(initialFont)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setColor(initialColor)
      setFont(initialFont)
      setError(null)
    }
  }, [open, initialColor, initialFont])

  const submit = async () => {
    const trimmedColor = color.trim()
    if (trimmedColor && !HEX_PATTERN.test(trimmedColor)) {
      setError("Use a 6-digit hex color like #2563eb.")
      return
    }
    setSaving(true)
    setError(null)
    const result = await onSave(trimmedColor, font)
    setSaving(false)
    if (result) {
      setError(result)
      return
    }
    toast.success("Estimate appearance saved")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Estimate appearance</DialogTitle>
          <DialogDescription>Applied to the client-facing estimate portal and PDF. Per-estimate overrides always win.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="estimate-accent-color" className="microlabel">
              Accent color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Accent color picker"
                value={HEX_PATTERN.test(color) ? color : "#1a1a1a"}
                onChange={(event) => {
                  setColor(event.target.value)
                  setError(null)
                }}
                disabled={saving}
                className="h-9 w-11 shrink-0 cursor-pointer border border-border bg-transparent p-1 disabled:opacity-50"
              />
              <Input
                id="estimate-accent-color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value)
                  setError(null)
                }}
                placeholder="#2563eb"
                className="h-9 max-w-[160px] font-mono"
                disabled={saving}
              />
              {color ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setColor("")
                    setError(null)
                  }}
                  disabled={saving}
                >
                  Reset
                </button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">Used for headers, section titles, and the total.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="estimate-font" className="microlabel">
              Portal font
            </label>
            <Select value={font || "__default"} onValueChange={(next) => setFont(next === "__default" ? "" : next)} disabled={saving}>
              <SelectTrigger id="estimate-font" className="h-9">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.map((option) => (
                  <SelectItem key={option.value || "__default"} value={option.value || "__default"}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Applies to the review portal document.</p>
          </div>
          {error ? <SettingsError>{error}</SettingsError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SignerDialog({
  open,
  onOpenChange,
  initialMode,
  initialUserId,
  members,
  membersLoading,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode: SignerMode
  initialUserId: string
  members: TeamMember[]
  membersLoading: boolean
  onSave: (mode: SignerMode, userId: string) => Promise<string | null>
}) {
  const [mode, setMode] = useState<SignerMode>(initialMode)
  const [userId, setUserId] = useState(initialUserId)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setUserId(initialUserId)
      setError(null)
    }
  }, [open, initialMode, initialUserId])

  const selectableMembers = members.filter(
    (member) => member.status !== "suspended" && member.user?.id && member.user?.email,
  )

  const submit = async () => {
    if (mode === "specific_user" && !userId) {
      setError("Choose the teammate who should countersign client-signed estimates.")
      return
    }
    setSaving(true)
    setError(null)
    const result = await onSave(mode, mode === "specific_user" ? userId : "")
    setSaving(false)
    if (result) {
      setError(result)
      return
    }
    toast.success("Builder signature saved")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Builder signature</DialogTitle>
          <DialogDescription>Choose who receives the countersignature request after a client signs an estimate.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="signer-mode" className="microlabel">
              Routing
            </label>
            <Select value={mode} onValueChange={(next) => setMode(next as SignerMode)} disabled={saving}>
              <SelectTrigger id="signer-mode" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="estimate_creator">Estimate creator</SelectItem>
                <SelectItem value="prospect_owner">Prospect owner</SelectItem>
                <SelectItem value="specific_user">Specific teammate</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "specific_user" ? (
            <div className="space-y-2">
              <label htmlFor="signer-user" className="microlabel">
                Teammate
              </label>
              <Select
                value={userId || "__none"}
                onValueChange={(next) => {
                  setUserId(next === "__none" ? "" : next)
                  setError(null)
                }}
                disabled={saving || membersLoading}
              >
                <SelectTrigger id="signer-user" className="h-9">
                  <SelectValue placeholder={membersLoading ? "Loading team…" : "Select a teammate"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select a teammate</SelectItem>
                  {selectableMembers.map((member) => (
                    <SelectItem key={member.user.id} value={member.user.id}>
                      {member.user.full_name || member.user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {error ? <SettingsError>{error}</SettingsError> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
