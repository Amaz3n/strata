"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"

import type { Contact, CostCode } from "@/lib/types"
import type { EstimateInput } from "@/lib/validation/estimates"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Receipt, CalendarDays, ChevronsUpDown, Trash2, Plus, LayoutGrid, ImageIcon, X, ChevronUp, ChevronDown, Loader2 } from "@/components/icons"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { uploadEstimatePhotoAction } from "@/app/(app)/estimates/actions"
import type { PricingDisplayMode } from "@/lib/validation/estimates"

type LineDraft = {
  item_type: "line" | "group"
  description: string
  quantity: number | string
  unit_cost: number | string
  cost_code_id: string | undefined
  is_optional: boolean
}

type PhotoDraft = { path: string; url: string; caption: string }

const NEW_LINE: LineDraft = { item_type: "line", description: "", quantity: 1, unit_cost: "", cost_code_id: undefined, is_optional: false }
const newLine = (): LineDraft => ({ ...NEW_LINE })
const newSection = (): LineDraft => ({ item_type: "group", description: "", quantity: 1, unit_cost: "", cost_code_id: undefined, is_optional: false })

export type EstimateTemplateOption = {
  id: string
  name: string
  description?: string | null
  lines: Array<{
    item_type?: "line" | "group" | null
    description?: string | null
    quantity?: number | null
    unit_cost_cents?: number | null
    cost_code_id?: string | null
    is_optional?: boolean | null
  }>
}

const PRICING_DISPLAY_OPTIONS: Array<{ value: PricingDisplayMode; label: string; hint: string }> = [
  { value: "itemized", label: "Itemized", hint: "Show quantity, unit cost, and amount per line" },
  { value: "subtotals", label: "Amounts only", hint: "Hide unit costs — show line amounts and total" },
  { value: "lump_sum", label: "Lump sum", hint: "Hide all line pricing — show only the total" },
]

export type EstimateSheetInitial = {
  title?: string | null
  summary?: string | null
  terms?: string | null
  intro?: string | null
  pricing_display?: PricingDisplayMode | null
  valid_until?: string | null
  version?: number | null
  recipient_contact_id?: string | null
  recipient_name?: string | null
  recipient_email?: string | null
  photos?: Array<{ path: string; url?: string | null; caption?: string | null }>
  lines?: Array<{
    item_type?: "line" | "group" | null
    description?: string | null
    quantity?: number | null
    unit_cost_cents?: number | null
    cost_code_id?: string | null
    is_optional?: boolean | null
  }>
}

interface EstimateCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contacts: Contact[]
  costCodes: CostCode[]
  defaultTerms?: string
  defaultIntro?: string
  templates?: EstimateTemplateOption[]
  defaultRecipientId?: string
  defaultProjectId?: string
  defaultProspectId?: string
  /**
   * When creating from a prospect, the recipient is the prospect's primary contact
   * (which is not in the Directory yet). Defaults the Client picker to this person.
   */
  prospectRecipient?: { name: string; email?: string | null }
  /** Other contacts on the prospect, selectable as the estimate recipient. */
  prospectContacts?: Array<{ name: string; email?: string | null }>
  onCreate: (input: EstimateInput) => Promise<void> | void
  loading?: boolean
  /**
   * "revise" seeds the form from {@link initialEstimate} and saves a new version.
   * Mount the sheet with a `key` (e.g. the estimate id) so the seeded state is fresh.
   */
  mode?: "create" | "revise"
  initialEstimate?: EstimateSheetInitial
  /** Client's requested changes, shown as a reference panel while revising. */
  requestedChanges?: string | null
}

function centsToInput(cents?: number | null): number | string {
  if (cents === null || cents === undefined) return ""
  return cents / 100
}

function parseLocalDate(value?: string | null): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" })

const noSpinner =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"

export function EstimateCreateSheet({
  open,
  onOpenChange,
  contacts,
  costCodes,
  defaultTerms,
  defaultIntro,
  templates,
  defaultRecipientId,
  defaultProjectId,
  defaultProspectId,
  prospectRecipient,
  prospectContacts,
  onCreate,
  loading,
  mode = "create",
  initialEstimate,
  requestedChanges,
}: EstimateCreateSheetProps) {
  const isRevise = mode === "revise"
  const seededLines: LineDraft[] =
    initialEstimate?.lines && initialEstimate.lines.length > 0
      ? initialEstimate.lines.map((line) => ({
          item_type: line.item_type === "group" ? "group" : "line",
          description: line.description ?? "",
          quantity: line.quantity ?? 1,
          unit_cost: centsToInput(line.unit_cost_cents),
          cost_code_id: line.cost_code_id ?? undefined,
          is_optional: line.is_optional ?? false,
        }))
      : [newLine()]

  const [recipientId, setRecipientId] = useState<string>(
    initialEstimate?.recipient_contact_id ?? defaultRecipientId ?? "",
  )
  // Prospect mode: recipient is an ad-hoc name/email (not a Directory contact).
  const [prospectChoice, setProspectChoice] = useState<{ name: string; email: string | null }>(() => {
    if (initialEstimate?.recipient_name || initialEstimate?.recipient_email) {
      return { name: initialEstimate.recipient_name ?? "", email: initialEstimate.recipient_email ?? null }
    }
    return prospectRecipient ? { name: prospectRecipient.name, email: prospectRecipient.email ?? null } : { name: "", email: null }
  })
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false)
  const [addingRecipient, setAddingRecipient] = useState(false)
  const [newRecipientName, setNewRecipientName] = useState("")
  const [newRecipientEmail, setNewRecipientEmail] = useState("")
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "")
  const [title, setTitle] = useState(initialEstimate?.title ?? "")
  const [scope, setScope] = useState(initialEstimate?.summary ?? "")
  const [terms, setTerms] = useState(initialEstimate?.terms ?? defaultTerms ?? "")
  const [intro, setIntro] = useState(initialEstimate?.intro ?? defaultIntro ?? "")
  const [pricingDisplay, setPricingDisplay] = useState<PricingDisplayMode>(initialEstimate?.pricing_display ?? "itemized")
  const [photos, setPhotos] = useState<PhotoDraft[]>(
    (initialEstimate?.photos ?? []).map((p) => ({ path: p.path, url: p.url ?? "", caption: p.caption ?? "" })),
  )
  const [uploadingPhotos, setUploadingPhotos] = useState(false)
  const [validUntil, setValidUntil] = useState<Date | undefined>(parseLocalDate(initialEstimate?.valid_until))
  const [validUntilOpen, setValidUntilOpen] = useState(false)
  const [lines, setLines] = useState<LineDraft[]>(seededLines)
  const [showErrors, setShowErrors] = useState(false)

  // Base total excludes section headers and optional add-ons (shown separately as upgrades).
  const total = useMemo(
    () =>
      lines.reduce(
        (sum, line) =>
          line.item_type === "group" || line.is_optional
            ? sum
            : sum + (Number(line.unit_cost) || 0) * (Number(line.quantity) || 1),
        0,
      ),
    [lines],
  )
  const optionalTotal = useMemo(
    () =>
      lines.reduce(
        (sum, line) => (line.item_type !== "group" && line.is_optional ? sum + (Number(line.unit_cost) || 0) * (Number(line.quantity) || 1) : sum),
        0,
      ),
    [lines],
  )

  useEffect(() => {
    if (isRevise) return
    if (defaultRecipientId) setRecipientId(defaultRecipientId)
  }, [defaultRecipientId, isRevise])

  useEffect(() => {
    if (isRevise) return
    if (prospectRecipient) setProspectChoice({ name: prospectRecipient.name, email: prospectRecipient.email ?? null })
  }, [prospectRecipient, isRevise])

  useEffect(() => {
    if (defaultProjectId) setProjectId(defaultProjectId)
  }, [defaultProjectId])

  const updateLine = (idx: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)))

  const addLine = () => setLines((prev) => [...prev, newLine()])
  const addSection = () => setLines((prev) => [...prev, newSection()])
  const removeLine = (idx: number) => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)))
  const moveLine = (idx: number, dir: -1 | 1) =>
    setLines((prev) => {
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const copy = [...prev]
      ;[copy[idx], copy[next]] = [copy[next], copy[idx]]
      return copy
    })

  function applyTemplate(template: EstimateTemplateOption) {
    if (!template.lines || template.lines.length === 0) return
    setLines(
      template.lines.map((line) => ({
        item_type: line.item_type === "group" ? "group" : "line",
        description: line.description ?? "",
        quantity: line.quantity ?? 1,
        unit_cost: centsToInput(line.unit_cost_cents),
        cost_code_id: line.cost_code_id ?? undefined,
        is_optional: line.is_optional ?? false,
      })),
    )
    if (!title.trim()) setTitle(template.name)
    toast.success(`Loaded “${template.name}”`)
  }

  async function handlePhotoFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    setUploadingPhotos(true)
    try {
      for (const file of files) {
        const formData = new FormData()
        formData.append("photo", file)
        const result = await uploadEstimatePhotoAction(formData)
        if ("error" in result && result.error) {
          toast.error(result.error)
          continue
        }
        if ("path" in result && result.path) {
          setPhotos((prev) => [...prev, { path: result.path, url: result.url ?? "", caption: "" }])
        }
      }
    } finally {
      setUploadingPhotos(false)
    }
  }

  const updatePhotoCaption = (idx: number, caption: string) =>
    setPhotos((prev) => prev.map((p, i) => (i === idx ? { ...p, caption } : p)))
  const removePhoto = (idx: number) => setPhotos((prev) => prev.filter((_, i) => i !== idx))

  const resetForm = () => {
    setRecipientId(defaultRecipientId ?? "")
    setProspectChoice(
      prospectRecipient ? { name: prospectRecipient.name, email: prospectRecipient.email ?? null } : { name: "", email: null },
    )
    setAddingRecipient(false)
    setNewRecipientName("")
    setNewRecipientEmail("")
    setProjectId(defaultProjectId ?? "")
    setTitle("")
    setScope("")
    setTerms(defaultTerms ?? "")
    setIntro(defaultIntro ?? "")
    setPricingDisplay("itemized")
    setPhotos([])
    setValidUntil(undefined)
    setValidUntilOpen(false)
    setLines([newLine()])
    setShowErrors(false)
  }

  const handleCreate = () => {
    const hasEmptyDescription = lines.some((l) => !l.description.trim())
    const hasLineItem = lines.some((l) => l.item_type !== "group" && l.description.trim())

    if (!title.trim() || hasEmptyDescription || !hasLineItem) {
      setShowErrors(true)
      toast.error("Please fill out all required fields", {
        description: !title.trim()
          ? "The estimate title is required."
          : !hasLineItem
            ? "Add at least one line item (not just a section heading)."
            : "Every section and line item needs a description.",
      })
      return
    }

    const payload: EstimateInput = {
      title: title.trim(),
      project_id: projectId || undefined,
      prospect_id: defaultProspectId || undefined,
      // Prospect mode uses an ad-hoc name/email recipient; otherwise a Directory contact.
      recipient_contact_id: prospectRecipient ? undefined : recipientId || undefined,
      recipient_name: prospectRecipient ? prospectChoice.name || undefined : undefined,
      recipient_email: prospectRecipient ? prospectChoice.email || undefined : undefined,
      summary: scope || undefined,
      terms: terms || undefined,
      intro: intro || undefined,
      pricing_display: pricingDisplay,
      photos: photos.map((p) => ({ path: p.path, caption: p.caption.trim() || null })),
      valid_until: validUntil ? format(validUntil, "yyyy-MM-dd") : undefined,
      lines: lines.map((line) => ({
        cost_code_id: line.item_type === "group" ? undefined : line.cost_code_id,
        description: line.description.trim(),
        quantity: Number(line.quantity) || 1,
        unit_cost_cents: line.item_type === "group" ? 0 : Math.round((Number(line.unit_cost) || 0) * 100),
        markup_pct: 0,
        item_type: line.item_type,
        is_optional: line.item_type === "group" ? undefined : line.is_optional,
      })),
    }

    onCreate(payload)
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            {isRevise
              ? `Revise estimate${initialEstimate?.version ? ` · v${initialEstimate.version + 1}` : ""}`
              : "New estimate"}
          </SheetTitle>
          <SheetDescription>
            {isRevise
              ? "Address the client's requested changes, then save as a new version to send."
              : "Build a clear, client-ready estimate. You can revise and re-send versions later."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); handleCreate() }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-5 space-y-6">
              {isRevise && requestedChanges?.trim() ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">Client requested changes</p>
                  <p className="mt-1.5 whitespace-pre-line text-sm text-foreground">{requestedChanges.trim()}</p>
                </div>
              ) : null}

              {!isRevise && templates && templates.length > 0 ? (
                <div className="space-y-1.5">
                  <Label>Start from template</Label>
                  <Select
                    onValueChange={(id) => {
                      const template = templates.find((t) => t.id === id)
                      if (template) applyTemplate(template)
                    }}
                  >
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="Choose a template…" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Seeds sections and line items — edit everything after.</p>
                </div>
              ) : null}

              {/* Basics */}
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="est-title" className={cn(showErrors && !title.trim() && "text-destructive")}>Title</Label>
                  <Input
                    id="est-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Kitchen remodel"
                    className={cn(
                      "h-10",
                      showErrors && !title.trim() && "border-destructive focus-visible:ring-destructive"
                    )}
                  />
                  {showErrors && !title.trim() && (
                    <p className="text-xs text-destructive font-medium">Title is required</p>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Client</Label>
                    {prospectRecipient ? (
                      <Popover
                        open={recipientPickerOpen}
                        onOpenChange={(next) => {
                          setRecipientPickerOpen(next)
                          if (!next) setAddingRecipient(false)
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button variant="outline" className="w-full justify-between font-normal">
                            <span className="truncate">{prospectChoice.name || "Select client"}</span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] p-1" align="start">
                          {addingRecipient ? (
                            <div className="space-y-2 p-2">
                              <Input
                                value={newRecipientName}
                                onChange={(e) => setNewRecipientName(e.target.value)}
                                placeholder="Name"
                                className="h-9"
                              />
                              <Input
                                type="email"
                                value={newRecipientEmail}
                                onChange={(e) => setNewRecipientEmail(e.target.value)}
                                placeholder="Email"
                                className="h-9"
                              />
                              <div className="flex justify-end gap-2 pt-1">
                                <Button type="button" variant="ghost" size="sm" onClick={() => setAddingRecipient(false)}>
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={!newRecipientName.trim()}
                                  onClick={() => {
                                    setProspectChoice({
                                      name: newRecipientName.trim(),
                                      email: newRecipientEmail.trim() || null,
                                    })
                                    setAddingRecipient(false)
                                    setRecipientPickerOpen(false)
                                  }}
                                >
                                  Use
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              {(prospectContacts ?? []).map((contact, idx) => (
                                <button
                                  key={`${contact.name}-${idx}`}
                                  type="button"
                                  className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                                  onClick={() => {
                                    setProspectChoice({ name: contact.name, email: contact.email ?? null })
                                    setRecipientPickerOpen(false)
                                  }}
                                >
                                  {contact.name}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="mt-1 flex items-center gap-1.5 rounded-sm border-t px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
                                onClick={() => {
                                  setNewRecipientName("")
                                  setNewRecipientEmail("")
                                  setAddingRecipient(true)
                                }}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add new recipient
                              </button>
                            </div>
                          )}
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <Select value={recipientId} onValueChange={setRecipientId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select client" />
                        </SelectTrigger>
                        <SelectContent>
                          {contacts.map((contact) => (
                            <SelectItem key={contact.id} value={contact.id}>{contact.full_name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {prospectRecipient && !prospectChoice.email ? (
                      <p className="text-xs text-amber-600">No email — add one to send.</p>
                    ) : null}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Valid until</Label>
                    <Popover open={validUntilOpen} onOpenChange={setValidUntilOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !validUntil && "text-muted-foreground")}>
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {validUntil ? format(validUntil, "LLL dd, y") : "Optional"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={validUntil}
                          onSelect={(date) => {
                            setValidUntil(date)
                            setValidUntilOpen(false)
                          }}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="est-intro">Cover note</Label>
                  <Textarea id="est-intro" value={intro} onChange={(e) => setIntro(e.target.value)} rows={3} placeholder="A short, friendly intro shown above the line items…" />
                  <p className="text-xs text-muted-foreground">Prefilled from your organization default. Edit anytime in Settings → Organization.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="est-scope">Scope</Label>
                  <Textarea id="est-scope" value={scope} onChange={(e) => setScope(e.target.value)} rows={3} placeholder="Describe what this estimate covers…" />
                </div>
              </div>

              {/* Line items */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-semibold">Line items</Label>
                    <p className="text-xs text-muted-foreground">Group work into sections and mark upgrades as optional add-ons.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={addSection}>
                      <LayoutGrid className="mr-1.5 h-4 w-4" />
                      Section
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={addLine}>
                      <Plus className="mr-1.5 h-4 w-4" />
                      Item
                    </Button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {lines.map((line, idx) => {
                    const lineTotal = (Number(line.unit_cost) || 0) * (Number(line.quantity) || 1)
                    const Reorder = (
                      <div className="flex flex-col">
                        <button type="button" onClick={() => moveLine(idx, -1)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move up">
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => moveLine(idx, 1)} disabled={idx === lines.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move down">
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )

                    if (line.item_type === "group") {
                      return (
                        <div key={idx} className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 p-2.5">
                          {Reorder}
                          <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <Input
                            value={line.description}
                            onChange={(e) => updateLine(idx, { description: e.target.value })}
                            placeholder="Section heading (e.g. Demolition)"
                            className={cn(
                              "h-9 flex-1 font-semibold uppercase tracking-wide",
                              showErrors && !line.description.trim() && "border-destructive focus-visible:ring-destructive",
                            )}
                          />
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )
                    }

                    return (
                      <div key={idx} className={cn("border bg-muted/20 p-3 space-y-3", line.is_optional && "border-primary/40 bg-primary/5")}>
                        {/* Row 1: reorder · description · qty · unit cost */}
                        <div className="flex items-end gap-2">
                          {Reorder}
                          <div className="flex-1 space-y-1">
                            <Label className={cn("text-[10px] uppercase tracking-wide text-muted-foreground", showErrors && !line.description.trim() && "text-destructive")}>Description</Label>
                            <Input
                              value={line.description}
                              onChange={(e) => updateLine(idx, { description: e.target.value })}
                              placeholder="Work item"
                              className={cn(
                                "h-9",
                                showErrors && !line.description.trim() && "border-destructive focus-visible:ring-destructive"
                              )}
                            />
                          </div>
                          <div className="w-16 space-y-1">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Qty</Label>
                            <Input
                              type="number"
                              min={0}
                              step={0.01}
                              value={line.quantity}
                              onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                              className={cn("h-9 tabular-nums", noSpinner)}
                            />
                          </div>
                          <div className="w-28 space-y-1">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Unit cost</Label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none pointer-events-none">$</span>
                              <Input
                                type="number"
                                min={0}
                                step={0.01}
                                value={line.unit_cost}
                                onChange={(e) => updateLine(idx, { unit_cost: e.target.value })}
                                placeholder="0.00"
                                className={cn("h-9 pl-7 pr-3 tabular-nums", noSpinner)}
                              />
                            </div>
                          </div>
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        {/* Row 2: cost code · optional · total */}
                        <div className="flex items-end gap-2">
                          <div className="flex-1 space-y-1">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Cost code</Label>
                            <Select value={line.cost_code_id ?? "none"} onValueChange={(v) => updateLine(idx, { cost_code_id: v === "none" ? undefined : v })}>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="No cost code" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No cost code</SelectItem>
                                {(costCodes ?? []).map((code) => (
                                  <SelectItem key={code.id} value={code.id}>{code.code} · {code.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                            <Checkbox checked={line.is_optional} onCheckedChange={(c) => updateLine(idx, { is_optional: c === true })} />
                            Optional add-on
                          </label>
                          <div className="space-y-1 text-right">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Line total</Label>
                            <div className="flex h-9 items-center justify-end px-2 text-sm font-semibold tabular-nums">{money(lineTotal)}</div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {optionalTotal > 0 ? (
                  <div className="flex items-center justify-between border-t pt-2 text-sm text-muted-foreground">
                    <span className="text-xs uppercase tracking-wide">Optional add-ons</span>
                    <span className="tabular-nums">+ {money(optionalTotal)}</span>
                  </div>
                ) : null}

                <div className="flex items-center justify-between border-t-2 border-foreground/80 pt-3">
                  <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Base total</span>
                  <span className="text-xl font-bold tabular-nums">{money(total)}</span>
                </div>

                {/* Pricing display */}
                <div className="space-y-1.5 pt-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Client sees</Label>
                  <Select value={pricingDisplay} onValueChange={(v) => setPricingDisplay(v as PricingDisplayMode)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRICING_DISPLAY_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{PRICING_DISPLAY_OPTIONS.find((o) => o.value === pricingDisplay)?.hint}</p>
                </div>
              </div>

              {/* Photos */}
              <div className="space-y-3">
                <div>
                  <Label className="text-sm font-semibold">Photos</Label>
                  <p className="text-xs text-muted-foreground">Shown as an interactive gallery on the client portal — tap to enlarge.</p>
                </div>
                {photos.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {photos.map((photo, idx) => (
                      <div key={photo.path} className="space-y-1.5">
                        <div className="relative aspect-[4/3] overflow-hidden rounded-md border bg-muted">
                          {photo.url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={photo.url} alt={photo.caption || "Estimate photo"} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center"><ImageIcon className="h-6 w-6 text-muted-foreground" /></div>
                          )}
                          <button
                            type="button"
                            onClick={() => removePhoto(idx)}
                            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow hover:text-destructive"
                            aria-label="Remove photo"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <Input
                          value={photo.caption}
                          onChange={(e) => updatePhotoCaption(idx, e.target.value)}
                          placeholder="Caption (optional)"
                          className="h-8 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
                <label className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-5 text-center transition-colors hover:border-primary/50 hover:bg-muted/30",
                  uploadingPhotos && "pointer-events-none opacity-60",
                )}>
                  {uploadingPhotos ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : <ImageIcon className="h-5 w-5 text-muted-foreground" />}
                  <span className="text-sm font-medium">{uploadingPhotos ? "Uploading…" : "Add photos"}</span>
                  <span className="text-xs text-muted-foreground">PNG, JPG, WEBP or GIF · up to 15MB each</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    className="hidden"
                    disabled={uploadingPhotos}
                    onChange={(e) => {
                      void handlePhotoFiles(e.target.files)
                      e.target.value = ""
                    }}
                  />
                </label>
              </div>

              {/* Terms */}
              <div className="space-y-1.5">
                <Label htmlFor="est-terms">Terms</Label>
                <Textarea id="est-terms" value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} placeholder="Payment terms, validity, exclusions…" />
                <p className="text-xs text-muted-foreground">Prefilled from your organization defaults. Edit anytime in Settings → Organization.</p>
              </div>
            </div>
          </ScrollArea>

          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="flex-1" disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? "Saving..." : isRevise ? "Save new version" : "Create estimate"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
