"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { SettingsError, SettingsField } from "@/components/settings/settings-section"
import {
  ArcInvoiceDocument,
  type ArcInvoiceDocumentData,
  type ArcInvoiceLine,
} from "@/components/invoices/arc-invoice-document"
import { getOrganizationSettingsAction, updateOrganizationSettingsAction } from "@/app/(app)/settings/actions"
import { unwrapAction } from "@/lib/action-result"

/**
 * Canonical US-Letter page in CSS px — the same fixed canvas the public pay page renders.
 * The document is ALWAYS laid out at these dimensions and then CSS-scaled as a single unit,
 * so type size, margins, and line breaks stay exactly proportional to the printed PDF.
 * Never feed the pane's measured size straight into ArcInvoiceDocument: its type sizes are
 * fixed, so that only re-flows the text instead of scaling the page.
 */
const PAGE_WIDTH = 750
const PAGE_HEIGHT = 1056

/** Sample line items so the preview reads like a real construction invoice, not a blank form. */
const SAMPLE_LINES: ArcInvoiceLine[] = [
  { description: "Foundation & site work", quantity: 1, unit: "LS", unitCostCents: 1_850_000, lineTotalCents: 1_850_000 },
  { description: "Framing — labor & materials", quantity: 1, unit: "LS", unitCostCents: 2_400_000, lineTotalCents: 2_400_000 },
  { description: "CO-03 — Kitchen island upgrade", quantity: 1, unit: "LS", unitCostCents: 625_000, lineTotalCents: 625_000 },
]
const SAMPLE_SUBTOTAL_CENTS = SAMPLE_LINES.reduce((sum, line) => sum + line.lineTotalCents, 0)
const SAMPLE_BILL_TO = ["Harborview Owners LLC", "owner@harborview.example", "48 Marina Way", "Naples, FL 34102"]

type FormState = {
  billingEmail: string
  address: string
  defaultPaymentTermsDays: number
  defaultInvoiceNote: string
}

const EMPTY_FORM: FormState = {
  billingEmail: "",
  address: "",
  defaultPaymentTermsDays: 15,
  defaultInvoiceNote: "",
}

function toForm(data: Awaited<ReturnType<typeof getOrganizationSettingsAction>>): FormState {
  return {
    billingEmail: data.billingEmail ?? "",
    address: data.address ?? "",
    defaultPaymentTermsDays: data.defaultPaymentTermsDays ?? 15,
    defaultInvoiceNote: data.defaultInvoiceNote ?? "",
  }
}

const accordionTriggerClass = "py-3.5 hover:no-underline"

export function InvoicingPanel() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [orgName, setOrgName] = useState("")
  // Pulled from the org; the logo is swapped on the Organization tab, not here.
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isSaving, startSaving] = useTransition()

  const applyData = useCallback((data: Awaited<ReturnType<typeof getOrganizationSettingsAction>>) => {
    setCanManage(Boolean(data.canManageOrganization))
    setOrgName(data.name ?? "")
    setLogoUrl(data.logoUrl ?? null)
    setForm(toForm(data))
    setDirty(false)
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)
    getOrganizationSettingsAction()
      .then((data) => {
        if (active) applyData(data)
      })
      .catch((error) => {
        console.error("Failed to load invoicing settings", error)
        if (active) setLoadError("Unable to load invoicing settings.")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [applyData])

  // Publish unsaved-edit state on window.__arcSettingsDirty — the settings nav and
  // sidebar read it to guard navigation — and warn before a full page unload.
  useEffect(() => {
    const w = window as typeof window & { __arcSettingsDirty?: boolean }
    w.__arcSettingsDirty = dirty
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    if (dirty) window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
      w.__arcSettingsDirty = false
    }
  }, [dirty])

  const updateField = useCallback(<K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    setDirty(true)
    setSaveError(null)
  }, [])

  const handleSave = () => {
    if (!canManage || isSaving) return
    setSaveError(null)
    startSaving(async () => {
      try {
        const outcome = unwrapAction(
          await updateOrganizationSettingsAction({
            section: "invoicing",
            billingEmail: form.billingEmail,
            address: form.address,
            defaultPaymentTermsDays: Number(form.defaultPaymentTermsDays ?? 15),
            defaultInvoiceNote: form.defaultInvoiceNote,
          }),
        )
        if (outcome && "error" in outcome && outcome.error) {
          setSaveError(outcome.error)
          toast.error("Couldn't save invoice settings", { description: outcome.error })
          return
        }
        applyData(await getOrganizationSettingsAction())
        toast.success("Invoice settings saved")
      } catch (error) {
        const message = error instanceof Error ? error.message : "Please try again."
        setSaveError(message)
        toast.error("Couldn't save invoice settings", { description: message })
      }
    })
  }

  // ── Live preview data (mirrors buildInvoicePdfData's field assembly) ────────
  const issueDate = useMemo(() => new Date(), [])
  const termsDays = Number.isFinite(form.defaultPaymentTermsDays) ? Math.max(0, form.defaultPaymentTermsDays) : 15
  const dueDate = useMemo(() => addDays(issueDate, termsDays), [issueDate, termsDays])

  const previewData: ArcInvoiceDocumentData = useMemo(
    () => ({
      invoiceNumber: "INV-1042",
      projectName: "Lakeside Residence — Phase 2",
      logoUrl,
      issueDate: issueDate.toISOString(),
      dueDate: dueDate.toISOString(),
      fromLines: [
        orgName.trim() || "Your company",
        form.billingEmail.trim(),
        ...form.address.split("\n").map((line) => line.trim()),
      ].filter(Boolean),
      billToLines: SAMPLE_BILL_TO,
      notes: form.defaultInvoiceNote.trim() || null,
      payUrl: "#",
      subtotalCents: SAMPLE_SUBTOTAL_CENTS,
      taxCents: 0,
      totalCents: SAMPLE_SUBTOTAL_CENTS,
      taxRate: null,
    }),
    [form, logoUrl, orgName, issueDate, dueDate],
  )

  /**
   * Fit the page to the pane's WIDTH and cap at 1 — 100% is actual print size, the most
   * honest answer to "how will this look". Height deliberately isn't a constraint: forcing
   * the whole page to fit a laptop-height pane would shrink the type below true scale.
   * A taller-than-pane page just scrolls, like any document viewer.
   */
  const canvasRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.75)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const GUTTER = 40 // breathing room so the page never touches the pane edges
    const update = () => {
      const availableWidth = el.clientWidth - GUTTER
      if (availableWidth <= 0) return
      setScale(Math.max(0.5, Math.min(1, availableWidth / PAGE_WIDTH)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading])

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="size-4" />
        <span className="text-sm">Loading invoice settings…</span>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <SettingsError>{loadError}</SettingsError>
      </div>
    )
  }

  return (
    // Mobile stacks and scrolls as one page; lg splits into two independently-scrolling panes.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* ── Controls ─────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col border-b border-border lg:min-h-0 lg:w-[24rem] lg:border-b-0 lg:border-r">
        <div className="px-5 py-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-6">
          {!canManage ? (
            <p className="mb-4 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
              Only organization admins can change invoice settings. These are read-only for you.
            </p>
          ) : null}

          <Accordion type="multiple" defaultValue={["sender", "defaults"]}>
            <AccordionItem value="sender">
              <AccordionTrigger className={accordionTriggerClass}>Sender</AccordionTrigger>
              <AccordionContent>
                <p className="pb-1 text-xs leading-5 text-muted-foreground">
                  The “From” block on every client invoice. Your logo comes from the Organization tab.
                </p>
                <div className="divide-y divide-border border-t border-border">
                  <SettingsField label="Invoice email" layout="stacked" htmlFor="invoicing-email" hint="Where client billing replies go.">
                    <Input
                      id="invoicing-email"
                      type="email"
                      value={form.billingEmail}
                      onChange={(event) => updateField("billingEmail", event.target.value)}
                      placeholder="billing@company.com"
                      disabled={!canManage}
                    />
                  </SettingsField>
                  <SettingsField
                    label="Remittance address" layout="stacked"
                    htmlFor="invoicing-address"
                    hint="Prints as typed — one item per line."
                  >
                    <Textarea
                      id="invoicing-address"
                      value={form.address}
                      onChange={(event) => updateField("address", event.target.value)}
                      placeholder={"Your Company LLC\n123 Main St, Suite 400\nNaples, FL 34102"}
                      rows={4}
                      className="min-h-[92px]"
                      disabled={!canManage}
                    />
                  </SettingsField>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="defaults">
              <AccordionTrigger className={accordionTriggerClass}>Invoice defaults</AccordionTrigger>
              <AccordionContent>
                <p className="pb-1 text-xs leading-5 text-muted-foreground">
                  Starting values for new invoices — always overridable per invoice.
                </p>
                <div className="divide-y divide-border border-t border-border">
                  <SettingsField
                    label="Payment terms" layout="stacked"
                    htmlFor="invoicing-terms"
                    hint={`Due ${format(dueDate, "MMM d, yyyy")} at Net ${termsDays}.`}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        id="invoicing-terms"
                        type="number"
                        min={0}
                        max={365}
                        value={form.defaultPaymentTermsDays}
                        onChange={(event) => updateField("defaultPaymentTermsDays", Number(event.target.value || 0))}
                        className="w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        disabled={!canManage}
                      />
                      <span className="text-sm text-muted-foreground">days</span>
                    </div>
                  </SettingsField>
                  <SettingsField
                    label="Payment details" layout="stacked"
                    htmlFor="invoicing-note"
                    hint="Bank / ACH / check instructions, printed in the footer."
                  >
                    <Textarea
                      id="invoicing-note"
                      value={form.defaultInvoiceNote}
                      onChange={(event) => updateField("defaultInvoiceNote", event.target.value)}
                      placeholder={"Make checks payable to Your Company LLC.\nACH: Routing 000000000 · Account 0000000000"}
                      className="min-h-[92px]"
                      disabled={!canManage}
                    />
                  </SettingsField>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* Pinned footer — the save affordance never scrolls out of reach. */}
        {canManage ? (
          <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-background px-5 py-3 lg:px-6">
            {saveError ? <SettingsError className="mb-2">{saveError}</SettingsError> : null}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={handleSave} disabled={isSaving || !dirty}>
                {isSaving ? "Saving…" : "Save changes"}
              </Button>
              <span className="text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "All changes saved"}</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Full-bleed preview: fixed page, uniformly scaled ─────────────────── */}
      <div ref={canvasRef} className="flex min-h-[60vh] min-w-0 flex-1 overflow-auto bg-muted/30 p-5 lg:min-h-0">
        {/* Outer box occupies the SCALED footprint so layout stays honest; the inner page
            keeps its true pixel size and is transformed as one unit. `m-auto` centers it
            when it fits and — unlike items-center — never clips it when it overflows. */}
        <div
          className="m-auto shrink-0 overflow-hidden border border-border/60 shadow-sm"
          style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}
        >
          <div className="origin-top-left" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})` }}>
            <ArcInvoiceDocument data={previewData} lines={SAMPLE_LINES} width={PAGE_WIDTH} height={PAGE_HEIGHT} />
          </div>
        </div>
      </div>
    </div>
  )
}
