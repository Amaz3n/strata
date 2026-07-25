"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { AlertTriangle, Plus, Trash2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  InfoRow,
  RowControl,
  SettingsError,
  SettingsField,
  SettingsGroup,
  SettingsToggle,
} from "@/components/settings/settings-section"
import { saveWarrantyProgramAction, saveWarrantySlaTargetsAction } from "@/app/(app)/warranty/actions"
import type { WarrantyProgramWithUsageDTO, WarrantySlaTargetDTO } from "@/lib/services/warranty"
import type { ProjectPosture } from "@/lib/product-tier"
import { terminology } from "@/lib/terminology"
import {
  getCoverageStartLabel,
  getWarrantySeverities,
  usesWarrantyProgramRoster,
  type WarrantySeverityVocabulary,
} from "@/lib/warranty-vocabulary"
import { cn } from "@/lib/utils"

const CONTAINER = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

/** Terms shown per program before the row collapses into a tally. */
const TERM_PREVIEW_LIMIT = 4
const MAX_TERMS = 25
const MAX_TERM_MONTHS = 600
const MAX_RESPONSE_HOURS = 8760
const MAX_RESOLUTION_DAYS = 3650

type TermDraft = {
  /** Stable across reorders and removals so an editing row never loses focus. */
  uid: string
  /** Empty until the term is first saved — keys are derived from the label then frozen. */
  key: string
  label: string
  months: string
  isStructural: boolean
  description: string
}

let termDraftCounter = 0

function newTermDraft(): TermDraft {
  termDraftCounter += 1
  return { uid: `draft-${termDraftCounter}`, key: "", label: "", months: "12", isStructural: false, description: "" }
}

type TargetDraft = {
  severity: WarrantySlaTargetDTO["severity"]
  firstResponseHours: string
  resolutionDays: string
}

function formatDuration(months: number) {
  if (months % 12 === 0) {
    const years = months / 12
    return `${years} ${years === 1 ? "yr" : "yrs"}`
  }
  return `${months} mo`
}

function formatHours(hours: number) {
  return `${hours} ${hours === 1 ? "hour" : "hours"}`
}

function formatDays(days: number) {
  return `${days} ${days === 1 ? "day" : "days"}`
}

/** Coverage keys are referenced by every enrolled home, so they're derived once and frozen. */
function slugifyTermKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
}

function uniqueTermKey(candidate: string, taken: Set<string>, index: number) {
  const base = candidate || `term_${index + 1}`
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base}_${suffix}`)) suffix += 1
  return `${base}_${suffix}`
}

function toTermDrafts(program: WarrantyProgramWithUsageDTO | null): TermDraft[] {
  if (!program) return [newTermDraft()]
  return program.terms.map((term) => ({
    uid: term.key,
    key: term.key,
    label: term.label,
    months: String(term.duration_months),
    isStructural: term.is_structural,
    description: term.description ?? "",
  }))
}

export function WarrantySettingsClient({
  programs: initialPrograms,
  targets: initialTargets,
  posture,
}: {
  programs: WarrantyProgramWithUsageDTO[]
  targets: WarrantySlaTargetDTO[]
  posture: ProjectPosture
}) {
  const [programs, setPrograms] = useState(initialPrograms)
  const [targets, setTargets] = useState(initialTargets)
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null)
  const [creatingProgram, setCreatingProgram] = useState(false)
  const [editingTargets, setEditingTargets] = useState(false)

  const roster = usesWarrantyProgramRoster(posture)
  const severities = getWarrantySeverities(posture)
  const terms = terminology(posture)
  const coverageStart = getCoverageStartLabel(posture)
  const subject = terms.project.toLowerCase()
  const subjects = terms.projects.toLowerCase()

  const editingProgram = programs.find((program) => program.id === editingProgramId) ?? null
  // Below production there's exactly one warranty, so the roster collapses to it.
  const soleProgram = programs.find((program) => program.is_default) ?? programs[0] ?? null
  const hasLiveDefault = programs.some((program) => program.is_default && program.is_active)
  const targetsBySeverity = useMemo(
    () => new Map(targets.map((target) => [target.severity, target])),
    [targets],
  )

  const enrolledLabel = (count: number) =>
    count === 0 ? `No ${subjects} enrolled` : `${count} ${count === 1 ? subject : subjects} enrolled`

  const termList = (program: WarrantyProgramWithUsageDTO) => (
    <dl className="space-y-1">
      {program.terms.slice(0, TERM_PREVIEW_LIMIT).map((term) => (
        <div key={term.key} className="flex items-baseline justify-between gap-3">
          <dt className="min-w-0 truncate text-sm leading-6 text-foreground">
            {term.label}
            {term.is_structural && roster ? (
              <span className="ml-1.5 text-xs text-muted-foreground">structural</span>
            ) : null}
          </dt>
          <dd className="shrink-0 text-sm leading-6 tabular-nums text-muted-foreground">
            {formatDuration(term.duration_months)}
          </dd>
        </div>
      ))}
      {program.terms.length > TERM_PREVIEW_LIMIT ? (
        <p className="text-xs leading-5 text-muted-foreground">
          +{program.terms.length - TERM_PREVIEW_LIMIT} more terms
        </p>
      ) : null}
      {program.terms.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">No terms configured</p>
      ) : null}
    </dl>
  )

  return (
    <div className={CONTAINER}>
      <SettingsGroup
        title={roster ? "Coverage programs" : "Coverage"}
        description={`What a ${subject} is covered for, and for how long. Terms are copied onto the ${subject}'s record at ${coverageStart} — editing them never moves coverage already in force.`}
        action={
          roster ? (
            <Button variant="outline" size="sm" onClick={() => setCreatingProgram(true)}>
              <Plus className="size-3.5" />
              New program
            </Button>
          ) : null
        }
      >
        {roster && !hasLiveDefault ? (
          <div className="flex items-start gap-2 py-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-xs leading-5 text-destructive">
              No active default program. {terms.projects} won&apos;t enroll in coverage at {coverageStart} until one
              program is marked both default and active.
            </p>
          </div>
        ) : null}

        {!roster ? (
          soleProgram ? (
            <SettingsField
              label="Coverage terms"
              hint={`What you warrant, measured from ${coverageStart}.`}
            >
              <RowControl canManage align="start" onEdit={() => setEditingProgramId(soleProgram.id)}>
                {termList(soleProgram)}
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {enrolledLabel(soleProgram.enrolled_count)}
                </p>
              </RowControl>
            </SettingsField>
          ) : (
            <div className="py-6">
              <p className="text-sm leading-5 text-foreground">No coverage terms yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Arc seeds a standard workmanship term when an organization is created. Contact support if this is empty.
              </p>
            </div>
          )
        ) : programs.length === 0 ? (
          <div className="py-6">
            <p className="text-sm leading-5 text-foreground">No coverage programs yet</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              A program bundles the terms a {subject} is warranted for — workmanship, major systems, structural. Create
              one and mark it default so closings enroll automatically.
            </p>
          </div>
        ) : (
          programs.map((program) => (
            <SettingsField
              key={program.id}
              label={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate">{program.name}</span>
                  {program.is_default ? <ProgramBadge>Default</ProgramBadge> : null}
                  {!program.is_active ? <ProgramBadge tone="muted">Inactive</ProgramBadge> : null}
                </span>
              }
              hint={program.description ?? undefined}
            >
              <RowControl canManage align="start" onEdit={() => setEditingProgramId(program.id)}>
                {termList(program)}
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {enrolledLabel(program.enrolled_count)}
                </p>
              </RowControl>
            </SettingsField>
          ))
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Response targets"
        description="Due dates Arc stamps on a request the moment it's logged, by severity. Changing a target doesn't restamp requests already open."
        action={
          <Button variant="outline" size="sm" onClick={() => setEditingTargets(true)}>
            Edit
          </Button>
        }
      >
        {severities.map((severity) => {
          const target = targetsBySeverity.get(severity.key)
          return (
            <InfoRow key={severity.key} label={severity.label} hint={severity.hint}>
              {target ? (
                <span className="tabular-nums">
                  Respond within {formatHours(target.first_response_hours)}
                  <span className="text-muted-foreground"> · </span>
                  resolve within {formatDays(target.resolution_days)}
                </span>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )}
            </InfoRow>
          )
        })}
      </SettingsGroup>

      <ProgramDialog
        open={creatingProgram || editingProgram !== null}
        program={creatingProgram ? null : editingProgram}
        roster={roster}
        coverageStart={coverageStart}
        subject={subject}
        isOnlyDefault={
          !creatingProgram &&
          editingProgram !== null &&
          editingProgram.is_default &&
          programs.filter((program) => program.is_default).length === 1
        }
        onOpenChange={(open) => {
          if (open) return
          setCreatingProgram(false)
          setEditingProgramId(null)
        }}
        onSaved={(saved) => {
          setPrograms((rows) => {
            const existing = rows.find((row) => row.id === saved.id)
            const merged = { ...saved, enrolled_count: existing?.enrolled_count ?? 0 }
            const next = existing
              ? rows.map((row) => (row.id === saved.id ? merged : row))
              : [...rows, merged]
            // The service clears every other default when one is promoted.
            const withDefaults = saved.is_default
              ? next.map((row) => (row.id === saved.id ? row : { ...row, is_default: false }))
              : next
            return withDefaults.sort((a, b) => a.name.localeCompare(b.name))
          })
          setCreatingProgram(false)
          setEditingProgramId(null)
        }}
      />

      <TargetsDialog
        open={editingTargets}
        targets={targets}
        severities={severities}
        onOpenChange={setEditingTargets}
        onSaved={(saved) => {
          setTargets(saved)
          setEditingTargets(false)
        }}
      />
    </div>
  )
}

function ProgramBadge({ children, tone = "default" }: { children: string; tone?: "default" | "muted" }) {
  return (
    <span
      className={cn(
        "shrink-0 border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]",
        tone === "muted" ? "border-border text-muted-foreground" : "border-foreground/25 text-foreground",
      )}
    >
      {children}
    </span>
  )
}

function ProgramDialog({
  open,
  program,
  roster,
  coverageStart,
  subject,
  isOnlyDefault,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  program: WarrantyProgramWithUsageDTO | null
  /** Production runs several programs; everyone else edits their single warranty. */
  roster: boolean
  coverageStart: string
  subject: string
  isOnlyDefault: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (program: WarrantyProgramWithUsageDTO) => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [isDefault, setIsDefault] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [terms, setTerms] = useState<TermDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(program?.name ?? "")
    setDescription(program?.description ?? "")
    setIsDefault(program?.is_default ?? false)
    setIsActive(program?.is_active ?? true)
    setTerms(toTermDrafts(program))
    setError(null)
  }, [open, program])

  const updateTerm = (index: number, patch: Partial<TermDraft>) => {
    setTerms((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
    setError(null)
  }

  const submit = async () => {
    // Outside the roster the program has no name field — it keeps the one it was
    // seeded with, since there's only ever one.
    const trimmedName = roster ? name.trim() : name.trim() || "Standard warranty"
    if (!trimmedName) {
      setError("Give the program a name.")
      return
    }
    if (terms.length === 0) {
      setError(roster ? "A program needs at least one coverage term." : "Add at least one coverage term.")
      return
    }

    const taken = new Set(terms.filter((term) => term.key).map((term) => term.key))
    const payloadTerms = []
    for (const [index, term] of terms.entries()) {
      const label = term.label.trim()
      if (!label) {
        setError("Every term needs a label.")
        return
      }
      const months = Number(term.months)
      if (!Number.isInteger(months) || months < 1 || months > MAX_TERM_MONTHS) {
        setError(`"${label}" needs a whole number of months between 1 and ${MAX_TERM_MONTHS}.`)
        return
      }
      let key = term.key
      if (!key) {
        key = uniqueTermKey(slugifyTermKey(label), taken, index)
        taken.add(key)
      }
      payloadTerms.push({
        key,
        label,
        duration_months: months,
        is_structural: term.isStructural,
        description: term.description.trim() || null,
      })
    }

    setSaving(true)
    setError(null)
    const result = await saveWarrantyProgramAction({
      id: program?.id,
      name: trimmedName,
      description: description.trim() || null,
      is_default: isDefault,
      is_active: isActive,
      terms: payloadTerms,
    })
    setSaving(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    toast.success(!roster ? "Coverage saved" : program ? "Coverage program saved" : "Coverage program created")
    onSaved({ ...result.data, enrolled_count: program?.enrolled_count ?? 0 })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{roster ? (program ? "Coverage program" : "New coverage program") : "Coverage terms"}</DialogTitle>
          <DialogDescription>
            Terms are copied onto a {subject}&apos;s record at {coverageStart}, so edits here only affect {subject}s
            enrolled from now on.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1">
          {roster ? (
            <>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="warranty-program-name">Name</Label>
                  <Input
                    id="warranty-program-name"
                    value={name}
                    maxLength={120}
                    onChange={(event) => {
                      setName(event.target.value)
                      setError(null)
                    }}
                    placeholder="Standard 1-2-10"
                    autoFocus
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="warranty-program-description">Description</Label>
                  <Input
                    id="warranty-program-description"
                    value={description}
                    maxLength={2000}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Standard production-home coverage"
                    disabled={saving}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">Internal only — buyers see the term descriptions below.</p>
                </div>
              </div>

              <div className="divide-y divide-border border-y border-border">
                <SettingsToggle
                  id="warranty-program-default"
                  label="Default program"
                  description={
                    isOnlyDefault
                      ? "Homes enroll in this program at closing. Promote another program to move the default."
                      : "Homes enroll in this program at closing unless one is picked by hand."
                  }
                  checked={isDefault}
                  onCheckedChange={setIsDefault}
                  disabled={saving || isOnlyDefault}
                />
                <SettingsToggle
                  id="warranty-program-active"
                  label="Active"
                  description={
                    isDefault && isActive
                      ? "The default program has to stay active — closings enroll from it."
                      : "Inactive programs stay on existing homes but can't be picked for new enrollments."
                  }
                  checked={isActive}
                  onCheckedChange={setIsActive}
                  // Deactivating the default would silently stop closings from enrolling coverage.
                  // A default that's already inactive stays toggleable so it can be recovered.
                  disabled={saving || (isDefault && isActive)}
                />
              </div>
            </>
          ) : null}

          <div>
            <div className="flex min-h-7 items-center justify-between gap-3">
              <h3 className="microlabel">Coverage terms</h3>
              <Button
                variant="outline"
                size="sm"
                disabled={saving || terms.length >= MAX_TERMS}
                onClick={() => setTerms((rows) => [...rows, newTermDraft()])}
              >
                <Plus className="size-3.5" />
                Add term
              </Button>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Each term is a coverage bucket a request is filed against. Removing one leaves enrolled {subject}s
              untouched — it just stops appearing on new enrollments.
            </p>

            <div className="mt-3 divide-y divide-border border-t border-border">
              {terms.map((term, index) => (
                <div key={term.uid} className="space-y-3 py-4">
                  <div className="flex items-end gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <Label htmlFor={`warranty-term-label-${index}`}>Term</Label>
                      <Input
                        id={`warranty-term-label-${index}`}
                        value={term.label}
                        maxLength={120}
                        onChange={(event) => updateTerm(index, { label: event.target.value })}
                        placeholder="Workmanship & materials"
                        disabled={saving}
                      />
                    </div>
                    <div className="w-28 space-y-2">
                      <Label htmlFor={`warranty-term-months-${index}`}>Months</Label>
                      <Input
                        id={`warranty-term-months-${index}`}
                        type="number"
                        min={1}
                        max={MAX_TERM_MONTHS}
                        inputMode="numeric"
                        className="tabular-nums"
                        value={term.months}
                        onChange={(event) => updateTerm(index, { months: event.target.value })}
                        disabled={saving}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Remove ${term.label.trim() || "term"}`}
                      disabled={saving || terms.length <= 1}
                      onClick={() => {
                        setTerms((rows) => rows.filter((_, rowIndex) => rowIndex !== index))
                        setError(null)
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor={`warranty-term-description-${index}`}>Client-facing description</Label>
                    <Textarea
                      id={`warranty-term-description-${index}`}
                      value={term.description}
                      maxLength={2000}
                      onChange={(event) => updateTerm(index, { description: event.target.value })}
                      placeholder="What this term covers, in the words your client reads in the portal."
                      className="min-h-[64px]"
                      disabled={saving}
                    />
                  </div>

                  {/* Structural claims route to a warranty carrier — a production-builder
                      arrangement. Custom and commercial builders carry the obligation themselves. */}
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    {roster ? (
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`warranty-term-structural-${index}`}
                          checked={term.isStructural}
                          onCheckedChange={(checked) => updateTerm(index, { isStructural: checked === true })}
                          disabled={saving}
                        />
                        <Label htmlFor={`warranty-term-structural-${index}`} className="text-sm font-normal">
                          Structural — routed as a carrier claim
                        </Label>
                      </div>
                    ) : (
                      <span />
                    )}
                    <p className="font-mono text-xs text-muted-foreground">
                      {term.key || slugifyTermKey(term.label) || "key set on save"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

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

function TargetsDialog({
  open,
  targets,
  severities,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  targets: WarrantySlaTargetDTO[]
  severities: WarrantySeverityVocabulary[]
  onOpenChange: (open: boolean) => void
  onSaved: (targets: WarrantySlaTargetDTO[]) => void
}) {
  const [drafts, setDrafts] = useState<TargetDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setDrafts(
      severities.map((severity) => {
        const target = targets.find((row) => row.severity === severity.key)
        return {
          severity: severity.key,
          firstResponseHours: String(target?.first_response_hours ?? ""),
          resolutionDays: String(target?.resolution_days ?? ""),
        }
      }),
    )
    setError(null)
  }, [open, targets, severities])

  const submit = async () => {
    const payload: WarrantySlaTargetDTO[] = []
    for (const draft of drafts) {
      const label = severities.find((severity) => severity.key === draft.severity)?.label ?? draft.severity
      const hours = Number(draft.firstResponseHours)
      const days = Number(draft.resolutionDays)
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_RESPONSE_HOURS) {
        setError(`${label}: first response must be between 1 and ${MAX_RESPONSE_HOURS} hours.`)
        return
      }
      if (!Number.isInteger(days) || days < 1 || days > MAX_RESOLUTION_DAYS) {
        setError(`${label}: resolution must be between 1 and ${MAX_RESOLUTION_DAYS} days.`)
        return
      }
      payload.push({ severity: draft.severity, first_response_hours: hours, resolution_days: days })
    }

    setSaving(true)
    setError(null)
    const result = await saveWarrantySlaTargetsAction({ targets: payload })
    setSaving(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    toast.success("Response targets saved")
    onSaved(payload)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Response targets</DialogTitle>
          <DialogDescription>
            Arc stamps both due dates when a request is logged. Requests already open keep the targets they were stamped
            with.
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border border-y border-border">
          {drafts.map((draft, index) => {
            const severity = severities.find((entry) => entry.key === draft.severity)
            return (
              <div key={draft.severity} className="space-y-3 py-4">
                <div>
                  <p className="text-sm font-medium leading-5 text-foreground">{severity?.label}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{severity?.hint}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`warranty-response-${draft.severity}`}>First response (hours)</Label>
                    <Input
                      id={`warranty-response-${draft.severity}`}
                      type="number"
                      min={1}
                      max={MAX_RESPONSE_HOURS}
                      inputMode="numeric"
                      className="tabular-nums"
                      value={draft.firstResponseHours}
                      onChange={(event) => {
                        const value = event.target.value
                        setDrafts((rows) =>
                          rows.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, firstResponseHours: value } : row,
                          ),
                        )
                        setError(null)
                      }}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`warranty-resolution-${draft.severity}`}>Resolution (days)</Label>
                    <Input
                      id={`warranty-resolution-${draft.severity}`}
                      type="number"
                      min={1}
                      max={MAX_RESOLUTION_DAYS}
                      inputMode="numeric"
                      className="tabular-nums"
                      value={draft.resolutionDays}
                      onChange={(event) => {
                        const value = event.target.value
                        setDrafts((rows) =>
                          rows.map((row, rowIndex) => (rowIndex === index ? { ...row, resolutionDays: value } : row)),
                        )
                        setError(null)
                      }}
                      disabled={saving}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>

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
