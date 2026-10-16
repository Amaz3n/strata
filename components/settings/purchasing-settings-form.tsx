"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition, type ReactNode } from "react"
import { toast } from "sonner"

import { saveVarianceReasonCodeAction, setVarianceReasonCodeActiveAction, updatePurchasingSettingsAction } from "@/app/(app)/settings/purchasing/actions"
import { Plus } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import { MAX_APPROVAL_BANDS, VPO_BAND_PERMISSIONS, vpoBandsError } from "@/lib/validation/purchasing-settings"
import type { PurchasingSettings, VarianceReasonCode } from "@/lib/services/purchasing-settings"

type BandDraft = { limit: string; permission: string }

const PERMISSION_LABELS: Record<string, string> = {
  "vpo.approve": "Standard approver (vpo.approve)",
  "vpo.approve_large": "Large-order approver (vpo.approve_large)",
}

const toDollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2))
const toCents = (dollars: string) => {
  const value = Number(dollars)
  return dollars.trim() !== "" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null
}

function Section({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b px-4 py-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function ToggleRow({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

export function PurchasingSettingsForm({ settings, reasons, canWrite }: { settings: PurchasingSettings; reasons: VarianceReasonCode[]; canWrite: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [flags, setFlags] = useState({
    pay_on_po_enabled: settings.pay_on_po_enabled,
    po_completion_requires_verification: settings.po_completion_requires_verification,
    po_completion_requires_inspection: settings.po_completion_requires_inspection,
    vpo_reason_code_required: settings.vpo_reason_code_required,
  })
  const [bands, setBands] = useState<BandDraft[]>(settings.vpo_approval_thresholds.map((band) => ({ limit: toDollars(band.up_to_cents), permission: band.permission })))
  const [evidenceRequired, setEvidenceRequired] = useState(settings.vpo_evidence_required_over_cents !== null)
  const [evidenceOver, setEvidenceOver] = useState(toDollars(settings.vpo_evidence_required_over_cents ?? 100_000))
  const [leadDays, setLeadDays] = useState(String(settings.expiring_agreement_lead_days))
  const [newCode, setNewCode] = useState({ code: "", label: "", isBackcharge: false })

  const run = (operation: () => Promise<unknown>, success: string, after?: () => void) => startTransition(async () => {
    try {
      await operation()
      toast.success(success)
      after?.()
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save")
    }
  })

  const bandPayload = bands.map((band, index) => ({ up_to_cents: index === bands.length - 1 ? null : toCents(band.limit), permission: band.permission }))
  const bandsProblem = bandPayload.slice(0, -1).some((band) => band.up_to_cents === null)
    ? "Enter a dollar limit for every band except the last."
    : vpoBandsError(bandPayload)

  const evidenceCents = toCents(evidenceOver)
  const evidenceProblem = evidenceRequired && evidenceCents === null ? "Enter the dollar amount from which evidence is required." : null

  const save = () => run(async () => {
    unwrapAction(await updatePurchasingSettingsAction({
      ...flags,
      vpo_approval_thresholds: bandPayload,
      vpo_evidence_required_over_cents: evidenceRequired ? evidenceCents : null,
      expiring_agreement_lead_days: Number(leadDays),
      expected_updated_at: settings.updated_at,
    }))
  }, "Purchasing settings saved")

  const addCode = () => run(async () => {
    unwrapAction(await saveVarianceReasonCodeAction({ code: newCode.code.trim(), label: newCode.label.trim(), is_backcharge: newCode.isBackcharge }))
  }, "Variance reason added", () => setNewCode({ code: "", label: "", isBackcharge: false }))

  const setFlag = (key: keyof typeof flags) => (value: boolean) => setFlags((current) => ({ ...current, [key]: value }))
  const locked = !canWrite || pending

  return (
    <div className="border-t" aria-busy={pending}>
      {!canWrite && <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">You can read these settings. Changing them needs the purchasing settings permission.</p>}

      <Section title="Pay on purchase order" detail="Trades are paid on a verified field completion instead of an invoice.">
        <ToggleRow label="Pay on purchase order" detail="Completions can be reported against approved purchase orders, and a bill on one is paid only against an approved completion." checked={flags.pay_on_po_enabled} disabled={locked} onChange={setFlag("pay_on_po_enabled")} />
        <ToggleRow label="A second person verifies each report" detail="Office reports are not self-verified. Whoever reported or verified a completion can never approve the payment." checked={flags.po_completion_requires_verification} disabled={locked} onChange={setFlag("po_completion_requires_verification")} />
        <ToggleRow label="Require a passed inspection before approval" detail="Approval needs a completed, passed inspection on the home, or a waiver with a reason that is kept on the completion and in the audit trail." checked={flags.po_completion_requires_inspection} disabled={locked} onChange={setFlag("po_completion_requires_inspection")} />
      </Section>

      <Section title="Variance orders" detail="Who may approve a variance order, and what must be on file first. A back-charge always needs the large-order approver and evidence.">
        <ToggleRow label="A reason is required on every purchase-order change" detail="Reasons drive the variance report. Turn off only if changes are tracked elsewhere." checked={flags.vpo_reason_code_required} disabled={locked} onChange={setFlag("vpo_reason_code_required")} />
        <div>
          <Label className="text-sm font-medium">Approval bands</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">An order is approved by someone holding the permission of the first band its amount fits. The last band has no limit.</p>
          <Table className="mt-2 border">
            <TableHeader><TableRow><TableHead>Up to (USD)</TableHead><TableHead>Approver</TableHead><TableHead className="w-20" /></TableRow></TableHeader>
            <TableBody>
              {bands.map((band, index) => {
                const last = index === bands.length - 1
                return (
                  <TableRow key={index}>
                    <TableCell>
                      {last ? <span className="text-muted-foreground">No limit</span> : (
                        <Input aria-label={`Band ${index + 1} limit`} inputMode="decimal" className="h-8 w-40 text-right tabular-nums" value={band.limit} disabled={locked}
                          onChange={(event) => setBands((current) => current.map((row, at) => at === index ? { ...row, limit: event.target.value } : row))} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Select value={band.permission} disabled={locked} onValueChange={(permission) => setBands((current) => current.map((row, at) => at === index ? { ...row, permission } : row))}>
                        <SelectTrigger size="sm" className="w-72"><SelectValue /></SelectTrigger>
                        <SelectContent>{VPO_BAND_PERMISSIONS.map((key) => <SelectItem key={key} value={key}>{PERMISSION_LABELS[key]}</SelectItem>)}</SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      {!last && bands.length > 1 && <Button size="sm" variant="ghost" disabled={locked} onClick={() => setBands((current) => current.filter((_, at) => at !== index))}>Remove</Button>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="mt-2 flex items-center gap-3">
            {canWrite && bands.length < MAX_APPROVAL_BANDS && (
              <Button size="sm" variant="outline" disabled={locked} onClick={() => setBands((current) => [...current.slice(0, -1), { limit: "", permission: "vpo.approve" }, current[current.length - 1]])}><Plus /> Add band</Button>
            )}
            {bandsProblem && <p className="text-xs text-destructive">{bandsProblem}</p>}
          </div>
        </div>
        <div className="space-y-2">
          <ToggleRow label="Require cost evidence" detail="A quote, invoice or receipt attached to the order, checked again when it is approved." checked={evidenceRequired} disabled={locked} onChange={setEvidenceRequired} />
          {evidenceRequired && (
            <div className="flex items-center gap-2">
              <Label htmlFor="evidence-over" className="text-xs text-muted-foreground">For orders of at least (USD)</Label>
              <Input id="evidence-over" inputMode="decimal" className="h-8 w-36 text-right tabular-nums" value={evidenceOver} disabled={locked} onChange={(event) => setEvidenceOver(event.target.value)} />
            </div>
          )}
          {evidenceProblem && <p className="text-xs text-destructive">{evidenceProblem}</p>}
        </div>
      </Section>

      <Section title="Price agreements" detail="How early the Purchasing desk and PO generation warn about agreements about to lapse.">
        <div className="flex items-center gap-2">
          <Label htmlFor="lead-days" className="text-sm">Warn</Label>
          <Input id="lead-days" inputMode="numeric" className="h-8 w-20 text-right tabular-nums" value={leadDays} disabled={locked} onChange={(event) => setLeadDays(event.target.value)} />
          <span className="text-sm text-muted-foreground">days before an agreement ends</span>
        </div>
      </Section>

      {canWrite && (
        <div className="flex justify-end border-b px-4 py-3">
          <Button disabled={pending || Boolean(bandsProblem) || Boolean(evidenceProblem)} onClick={save}>{pending ? "Saving…" : "Save settings"}</Button>
        </div>
      )}

      <Section title="Variance reasons" detail="The taxonomy behind every variance order and the variance report. Retire a reason instead of deleting it; orders already raised keep theirs.">
        <Table className="border">
          <TableHeader><TableRow><TableHead>Reason</TableHead><TableHead>Code</TableHead><TableHead>Type</TableHead><TableHead className="w-28 text-right">Active</TableHead></TableRow></TableHeader>
          <TableBody>
            {reasons.map((reason) => (
              <TableRow key={reason.id} className={reason.is_active ? undefined : "text-muted-foreground"}>
                <TableCell className="font-medium">{reason.label}</TableCell>
                <TableCell className="font-mono text-xs">{reason.code}</TableCell>
                <TableCell>{reason.is_backcharge ? <Badge variant="outline" className="rounded-none">Back-charge</Badge> : null}</TableCell>
                <TableCell className="text-right">
                  <Switch checked={reason.is_active} disabled={locked} aria-label={`${reason.label} active`}
                    onCheckedChange={(value) => run(async () => { unwrapAction(await setVarianceReasonCodeActiveAction(reason.id, value)) }, value ? "Reason restored" : "Reason retired")} />
                </TableCell>
              </TableRow>
            ))}
            {reasons.length === 0 && <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No variance reasons yet. Save the settings above to load the standard set.</TableCell></TableRow>}
          </TableBody>
        </Table>
        {canWrite && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1"><Label htmlFor="new-reason-label" className="text-xs">New reason</Label><Input id="new-reason-label" className="h-8 w-64" value={newCode.label} disabled={locked} onChange={(event) => setNewCode((current) => ({ ...current, label: event.target.value }))} /></div>
            <div className="grid gap-1"><Label htmlFor="new-reason-code" className="text-xs">Code</Label><Input id="new-reason-code" className="h-8 w-44 font-mono" placeholder="storm_damage" value={newCode.code} disabled={locked} onChange={(event) => setNewCode((current) => ({ ...current, code: event.target.value }))} /></div>
            <div className="flex items-center gap-2 pb-1.5"><Switch checked={newCode.isBackcharge} disabled={locked} aria-label="Back-charge" onCheckedChange={(value) => setNewCode((current) => ({ ...current, isBackcharge: value }))} /><Label className="text-xs">Back-charge</Label></div>
            <Button size="sm" variant="outline" disabled={locked || !newCode.label.trim() || !newCode.code.trim()} onClick={addCode}><Plus /> Add</Button>
          </div>
        )}
      </Section>
    </div>
  )
}
