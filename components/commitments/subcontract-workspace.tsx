"use client"

import dynamic from "next/dynamic"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"

import {
  createCommitmentLineAction,
  deleteCommitmentLineAction,
  generateSubcontractDocumentAction,
  getCommitmentDetailAction,
  previewSubcontractPdfAction,
  updateCommitmentLineAction,
  updateProjectCommitmentAction,
} from "@/app/(app)/projects/[id]/commitments/actions"
import type { CommitmentDetail, CommitmentLine } from "@/lib/services/commitments"
import type { EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { SUBCONTRACT_STAGE_LABELS, subcontractStage, type SubcontractStage } from "@/lib/bids/package-move"
import { unwrapAction } from "@/lib/action-result"
import { cn, formatMoneyCents } from "@/lib/utils"
import { RecordExecutionDialog } from "@/components/commitments/record-execution-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Download, MoreHorizontal, Plus, Trash2 } from "@/components/icons"

/** Heavy: PDF viewer plus drag-and-drop field placement. Loaded when asked for. */
const EnvelopeWizard = dynamic(
  () => import("@/components/esign/envelope-wizard").then((module) => module.EnvelopeWizard),
  { ssr: false },
)

const STAGE_TONE: Record<SubcontractStage, string> = {
  draft: "text-muted-foreground",
  approved: "text-primary",
  out_for_signature: "text-warning",
  partially_signed: "text-warning",
  executed: "text-success",
  canceled: "text-destructive",
}

interface AgreementForm {
  title: string
  contract_number: string
  retainage_percent: string
  start_date: string
  end_date: string
  scope: string
  terms: string
}

interface LineDraft {
  id: string
  description: string
  quantity: string
  unit: string
  unitCost: string
  costCode: string | null
}

function toForm(detail: CommitmentDetail): AgreementForm {
  const commitment = detail.commitment
  return {
    title: commitment.title ?? "",
    contract_number: commitment.contract_number ?? "",
    retainage_percent: commitment.retainage_percent != null ? String(commitment.retainage_percent) : "",
    start_date: commitment.start_date ?? "",
    end_date: commitment.end_date ?? "",
    scope: commitment.scope ?? "",
    terms: commitment.terms ?? "",
  }
}

function toLineDraft(line: CommitmentLine): LineDraft {
  return {
    id: line.id,
    description: line.description,
    quantity: String(line.quantity),
    unit: line.unit,
    unitCost: (line.unit_cost_cents / 100).toFixed(2),
    costCode: line.cost_code_code ?? null,
  }
}

function centsFrom(value: string): number | null {
  const amount = Number.parseFloat(value.replace(/[$,\s]/g, ""))
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null
}

function lineTotal(line: LineDraft): number {
  const quantity = Number(line.quantity)
  const unit = centsFrom(line.unitCost)
  return Number.isFinite(quantity) && unit != null ? Math.round(quantity * unit) : 0
}

/**
 * The subcontract an award produced, opened over the bid package: the
 * agreement on the left, the exact PDF the trade will sign on the right.
 * Every edit saves itself and re-renders the document, so what you approve is
 * what goes out. Editing locks once it is out for signature.
 */
export function SubcontractWorkspace({
  commitmentId,
  projectId,
  envelope,
  awardedTotalCents,
  onClose,
  onChanged,
}: {
  commitmentId: string
  projectId: string
  envelope: { status: string; sent_at: string | null } | null
  awardedTotalCents: number | null
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [detail, setDetail] = useState<CommitmentDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<AgreementForm | null>(null)
  const [lines, setLines] = useState<LineDraft[]>([])
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [view, setView] = useState<"edit" | "document">("edit")
  const [overrideNote, setOverrideNote] = useState<string | null>(null)
  const [signingDocumentId, setSigningDocumentId] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  const refreshPreview = useCallback(async () => {
    setPreviewing(true)
    try {
      const { pdfBase64 } = unwrapAction(await previewSubcontractPdfAction(commitmentId))
      const bytes = Uint8Array.from(atob(pdfBase64), (character) => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = url
      setPreviewUrl(url)
      setPreviewError(null)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Unable to render the agreement")
    } finally {
      setPreviewing(false)
    }
  }, [commitmentId])

  const schedulePreview = useCallback(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => void refreshPreview(), 500)
  }, [refreshPreview])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const next = unwrapAction(await getCommitmentDetailAction(commitmentId))
      setDetail(next)
      setForm(toForm(next))
      setLines(next.lines.map(toLineDraft))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load the subcontract")
    }
  }, [commitmentId])

  useEffect(() => {
    void load()
    void refreshPreview()
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (previewTimer.current) clearTimeout(previewTimer.current)
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [load, refreshPreview])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !signingDocumentId && !recordOpen) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, signingDocumentId, recordOpen])

  const commitment = detail?.commitment ?? null
  const stage: SubcontractStage = commitment
    ? subcontractStage({ status: String(commitment.status), executed_at: commitment.executed_at ?? null }, envelope)
    : "draft"
  const editable = stage === "draft" || stage === "approved"
  const sovTotal = lines.reduce((sum, line) => sum + lineTotal(line), 0)

  const saveAgreement = useCallback(
    (next: AgreementForm) => {
      if (next.title.trim().length < 2) return
      const retainage = next.retainage_percent.trim() === "" ? null : Number(next.retainage_percent)
      if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        setSaveState("saving")
        try {
          unwrapAction(
            await updateProjectCommitmentAction(projectId, commitmentId, {
              title: next.title.trim(),
              contract_number: next.contract_number.trim() || null,
              retainage_percent: retainage,
              start_date: next.start_date || undefined,
              end_date: next.end_date || undefined,
              scope: next.scope.trim() || null,
              terms: next.terms.trim() || null,
            }),
          )
          setSaveState("saved")
          schedulePreview()
        } catch (error) {
          setSaveState("error")
          toast.error("Changes not saved", { description: error instanceof Error ? error.message : "Please try again." })
        }
      }, 700)
    },
    [commitmentId, projectId, schedulePreview],
  )

  function patchForm(patch: Partial<AgreementForm>) {
    if (!form) return
    const next = { ...form, ...patch }
    setForm(next)
    saveAgreement(next)
  }

  async function persistLine(line: LineDraft) {
    const original = detail?.lines.find((entry) => entry.id === line.id)
    const quantity = Number(line.quantity)
    const unitCost = centsFrom(line.unitCost)
    if (!original || !line.description.trim() || !line.unit.trim() || !Number.isFinite(quantity) || quantity < 0 || unitCost == null) {
      toast.error("Each line needs a description, a unit, a quantity and a cost")
      return
    }
    if (
      original.description === line.description.trim() &&
      original.quantity === quantity &&
      original.unit === line.unit.trim() &&
      original.unit_cost_cents === unitCost
    ) {
      return
    }
    setSaveState("saving")
    try {
      unwrapAction(
        await updateCommitmentLineAction(line.id, {
          description: line.description.trim(),
          quantity,
          unit: line.unit.trim(),
          unit_cost_cents: unitCost,
        }),
      )
      await load()
      setSaveState("saved")
      schedulePreview()
    } catch (error) {
      setSaveState("error")
      toast.error("Line not saved", { description: error instanceof Error ? error.message : "Please try again." })
    }
  }

  function addLine() {
    const anchor = detail?.lines[0]
    startTransition(async () => {
      try {
        unwrapAction(
          await createCommitmentLineAction(commitmentId, {
            description: "New line",
            quantity: 1,
            unit: "LS",
            unit_cost_cents: 0,
            cost_code_id: anchor?.cost_code_id ?? null,
            budget_line_id: anchor?.budget_line_id ?? null,
          }),
        )
        await load()
        schedulePreview()
      } catch (error) {
        toast.error("Unable to add a line", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  function removeLine(id: string) {
    startTransition(async () => {
      try {
        unwrapAction(await deleteCommitmentLineAction(id))
        await load()
        schedulePreview()
      } catch (error) {
        toast.error("Unable to remove the line", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  /** Approves when needed, renders the agreement into a signing draft, and opens the signer setup. */
  function approveAndSend() {
    startTransition(async () => {
      try {
        if (stage === "draft") {
          const result = await updateProjectCommitmentAction(projectId, commitmentId, {
            status: "approved",
            ...(overrideNote?.trim() ? { prequal_override_note: overrideNote.trim() } : {}),
          })
          if (!result.success) {
            if (/override justification/i.test(result.error)) {
              setOverrideNote((current) => current ?? "")
              toast.error("This trade's prequalification needs an override", {
                description: "Record why you're proceeding, then approve again.",
              })
              return
            }
            throw new Error(result.error)
          }
          await load()
          await onChanged()
        }
        const generated = unwrapAction(await generateSubcontractDocumentAction(projectId, commitmentId))
        if (!generated.documentId) {
          toast.error("The agreement couldn't be prepared for e-signature", {
            description: `${generated.reason ?? "Please try again."} You can still record a copy signed on paper.`,
          })
          return
        }
        setSigningDocumentId(generated.documentId)
      } catch (error) {
        toast.error("Unable to send the subcontract", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const readiness = useMemo(() => {
    if (!form) return []
    const footsToAward = awardedTotalCents == null || sovTotal === awardedTotalCents
    return [
      { ok: form.scope.trim().length > 0, label: "Scope of work is written" },
      { ok: form.terms.trim().length > 0, label: "Terms are written" },
      {
        ok: footsToAward,
        label: footsToAward
          ? "Schedule of values matches the award"
          : `Schedule of values is ${formatMoneyCents(Math.abs(sovTotal - (awardedTotalCents ?? 0)))} ${sovTotal > (awardedTotalCents ?? 0) ? "over" : "under"} the award`,
      },
      { ok: form.retainage_percent.trim() !== "", label: form.retainage_percent.trim() ? `Retainage ${form.retainage_percent}%` : "No retainage set" },
    ]
  }, [form, sovTotal, awardedTotalCents])

  const primaryLabel = stage === "draft" ? "Approve & send for signature" : stage === "approved" ? "Send for signature" : null
  const title = commitment?.contract_number ? `Subcontract ${commitment.contract_number}` : "Subcontract"

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-150 motion-reduce:animate-none">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Back to the bid package">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", STAGE_TONE[stage])}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {SUBCONTRACT_STAGE_LABELS[stage]}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {commitment?.company_name ?? "Trade"} · <span className="font-mono tabular-nums">{formatMoneyCents(sovTotal)}</span>
            </span>
            {saveState === "saving" ? (
              <span role="status">Saving…</span>
            ) : saveState === "saved" ? (
              <span className="inline-flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>
            ) : saveState === "error" ? (
              <span className="text-destructive">Not saved</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1 lg:hidden" aria-label="View">
          <Button size="sm" variant={view === "edit" ? "secondary" : "ghost"} aria-pressed={view === "edit"} onClick={() => setView("edit")}>Edit</Button>
          <Button size="sm" variant={view === "document" ? "secondary" : "ghost"} aria-pressed={view === "document"} onClick={() => setView("document")}>Document</Button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {previewUrl ? (
              <DropdownMenuItem asChild>
                <a href={previewUrl} download={`${title}.pdf`}>
                  <Download className="mr-2 h-4 w-4" />
                  Download PDF
                </a>
              </DropdownMenuItem>
            ) : null}
            {commitment?.executed_file_id ? (
              <DropdownMenuItem asChild>
                <a href={`/api/files/${commitment.executed_file_id}/raw`} target="_blank" rel="noreferrer">
                  <Download className="mr-2 h-4 w-4" />
                  Signed agreement
                </a>
              </DropdownMenuItem>
            ) : null}
            {stage !== "executed" && stage !== "canceled" ? (
              <DropdownMenuItem onClick={() => setRecordOpen(true)}>Record a copy signed on paper</DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={`/projects/${projectId}/financials/budget`}>Open the budget</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {primaryLabel ? (
          <Button size="sm" onClick={approveAndSend} disabled={isPending || !detail || saveState === "saving"}>
            {isPending ? "Preparing…" : primaryLabel}
          </Button>
        ) : null}
      </header>

      {stage === "out_for_signature" || stage === "partially_signed" ? (
        <div role="status" className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground lg:px-6">
          Out for signature. Editing is locked so the signed document matches what was sent.
        </div>
      ) : stage === "executed" ? (
        <div role="status" className="shrink-0 border-b px-4 py-2 text-sm text-success lg:px-6">
          Signed. Changes from here go through a subcontract change order.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className={cn("min-h-0 overflow-y-auto border-r lg:w-[min(600px,46%)] lg:shrink-0", view === "document" && "hidden lg:block")}>
          {loadError ? (
            <div role="alert" className="m-6 space-y-3 border border-destructive/30 p-4 text-sm">
              <p className="text-destructive">{loadError}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
            </div>
          ) : !form || !detail ? (
            <div className="space-y-4 p-6">
              <Skeleton className="h-9 w-2/3" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <fieldset disabled={!editable} className="min-w-0 space-y-8 p-6">
              {overrideNote !== null && stage === "draft" ? (
                <div className="space-y-2 border border-warning/40 p-3">
                  <Label htmlFor="prequal-override" className="text-sm">Why you're proceeding despite prequalification</Label>
                  <Textarea id="prequal-override" rows={2} value={overrideNote} onChange={(event) => setOverrideNote(event.target.value)} placeholder="Who approved it and on what conditions" />
                </div>
              ) : null}

              {editable ? (
                <section className="space-y-2">
                  <p className="microlabel">Before it goes out</p>
                  <ul className="space-y-1.5">
                    {readiness.map((item) => (
                      <li key={item.label} className="flex items-center gap-2 text-sm">
                        {item.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
                        <span className={item.ok ? "text-muted-foreground" : undefined}>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="space-y-3">
                <p className="microlabel">Agreement</p>
                <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="sc-title">Title</Label>
                    <Input id="sc-title" value={form.title} onChange={(event) => patchForm({ title: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sc-number">Number</Label>
                    <Input id="sc-number" value={form.contract_number} onChange={(event) => patchForm({ contract_number: event.target.value })} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="sc-start">Start</Label>
                    <Input id="sc-start" type="date" value={form.start_date} onChange={(event) => patchForm({ start_date: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sc-end">Finish</Label>
                    <Input id="sc-end" type="date" value={form.end_date} onChange={(event) => patchForm({ end_date: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sc-retainage">Retainage %</Label>
                    <Input id="sc-retainage" inputMode="decimal" className="text-right tabular-nums" value={form.retainage_percent} onChange={(event) => patchForm({ retainage_percent: event.target.value })} placeholder="10" />
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <p className="microlabel">Schedule of values</p>
                  {editable ? (
                    <Button variant="ghost" size="sm" className="h-7" onClick={addLine} disabled={isPending}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Line
                    </Button>
                  ) : null}
                </div>
                <div className="overflow-x-auto border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="px-2 py-1.5 text-left font-medium">Description</th>
                        <th className="w-16 px-2 py-1.5 text-right font-medium">Qty</th>
                        <th className="w-16 px-2 py-1.5 text-left font-medium">Unit</th>
                        <th className="w-28 px-2 py-1.5 text-right font-medium">Unit cost</th>
                        <th className="w-28 px-2 py-1.5 text-right font-medium">Amount</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, index) => {
                        const update = (patch: Partial<LineDraft>) =>
                          setLines((current) => current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)))
                        const commit = () => void persistLine(lines[index])
                        return (
                          <tr key={line.id} className="border-b last:border-b-0 align-top">
                            <td className="px-1 py-1">
                              <Input aria-label="Line description" className="h-8 border-transparent shadow-none hover:border-border focus-visible:border-border" value={line.description} onChange={(event) => update({ description: event.target.value })} onBlur={commit} />
                              {line.costCode ? <p className="px-2 pt-0.5 font-mono text-[11px] text-muted-foreground">{line.costCode}</p> : null}
                            </td>
                            <td className="px-1 py-1">
                              <Input aria-label="Quantity" inputMode="decimal" className="h-8 border-transparent text-right tabular-nums shadow-none hover:border-border" value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} onBlur={commit} />
                            </td>
                            <td className="px-1 py-1">
                              <Input aria-label="Unit" className="h-8 border-transparent shadow-none hover:border-border" value={line.unit} onChange={(event) => update({ unit: event.target.value })} onBlur={commit} />
                            </td>
                            <td className="px-1 py-1">
                              <Input aria-label="Unit cost" inputMode="decimal" className="h-8 border-transparent text-right tabular-nums shadow-none hover:border-border" value={line.unitCost} onChange={(event) => update({ unitCost: event.target.value })} onBlur={commit} />
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums">{formatMoneyCents(lineTotal(line))}</td>
                            <td className="px-1 py-1.5">
                              {editable && lines.length > 1 ? (
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label="Remove line" onClick={() => removeLine(line.id)} disabled={isPending}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="px-2 py-2" colSpan={4}>Contract sum</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">{formatMoneyCents(sovTotal)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              <section className="space-y-2">
                <Label htmlFor="sc-scope" className="microlabel">Scope of work</Label>
                <Textarea id="sc-scope" rows={10} value={form.scope} onChange={(event) => patchForm({ scope: event.target.value })} className="text-sm leading-relaxed" />
              </section>

              <section className="space-y-2">
                <Label htmlFor="sc-terms" className="microlabel">Terms</Label>
                <Textarea id="sc-terms" rows={7} value={form.terms} onChange={(event) => patchForm({ terms: event.target.value })} className="text-sm leading-relaxed" placeholder="Payment terms, schedule, insurance, warranty and anything agreed at award" />
              </section>
            </fieldset>
          )}
        </div>

        <div className={cn("relative min-h-0 flex-1 bg-muted/40 p-3 lg:p-5", view === "edit" && "hidden lg:block")}>
          {previewError ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-sm">
              <p className="text-destructive">{previewError}</p>
              <Button variant="outline" size="sm" onClick={() => void refreshPreview()}>Try again</Button>
            </div>
          ) : previewUrl ? (
            <iframe title="Subcontract document" src={previewUrl} className="h-full w-full border bg-card" />
          ) : (
            <Skeleton className="h-full w-full" />
          )}
          {previewing && previewUrl ? (
            <span role="status" className="absolute right-6 top-6 bg-card px-2 py-1 text-xs text-muted-foreground shadow-sm">Updating…</span>
          ) : null}
        </div>
      </div>

      {signingDocumentId && commitment ? (
        <EnvelopeWizard
          open
          onOpenChange={(open) => {
            if (!open) setSigningDocumentId(null)
          }}
          resumeDocumentId={signingDocumentId}
          sourceEntity={
            {
              type: "subcontract",
              id: commitment.id,
              project_id: projectId,
              title: commitment.title,
              document_type: "contract",
            } satisfies EnvelopeWizardSourceEntity
          }
          sourceLabel="Subcontract"
          sheetTitle="Send subcontract for signature"
          sheetDescription="The agreement is attached. Add the signers and place their fields, then send."
          onEnvelopeSent={async () => {
            setSigningDocumentId(null)
            toast.success("Subcontract sent for signature")
            await onChanged()
          }}
        />
      ) : null}

      {commitment ? (
        <RecordExecutionDialog
          open={recordOpen}
          onOpenChange={setRecordOpen}
          projectId={projectId}
          commitmentId={commitment.id}
          onRecorded={async () => {
            await load()
            await onChanged()
          }}
        />
      ) : null}
    </div>,
    document.body,
  )
}
