"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState, useTransition } from "react"

import { resumePurchaseAgreementSigningAction } from "@/app/(app)/sales/actions"
import {
  approveCommissionPlanAction,
  getAgreementCommissionPlanAction,
  proposeCommissionPlanAction,
  searchCommissionCompaniesAction,
  searchCommissionConsultantsAction,
} from "@/app/(app)/sales/commission-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { unwrapAction } from "@/lib/action-result"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { commissionAmountCents, type CommissionBasis } from "@/lib/financials/sales-commissions"
import type { AgreementCommissionView, CommissionPlanLineView } from "@/lib/services/sales-commissions"
import { formatMoneyCentsExact } from "@/lib/utils"
import type { CommissionLineInput, CommissionPlanInput } from "@/lib/validation/sales-commissions"

type DraftLine = {
  key: string
  kind: "coop_broker" | "sales_consultant"
  company: SearchPickerItem | null
  consultant: SearchPickerItem | null
  payoutChannel: "payroll" | "accounts_payable"
  agentName: string
  basis: CommissionBasis
  percent: string
  flat: string
}

/** The editor's working copy of a plan before it is proposed. */
export type CommissionPlanDraft = { coopBroker: "none" | "broker"; lines: DraftLine[] }

let sequence = 0
const nextKey = () => `line-${(sequence += 1)}`

function brokerLine(): DraftLine {
  return { key: nextKey(), kind: "coop_broker", company: null, consultant: null, payoutChannel: "accounts_payable", agentName: "", basis: "percent_of_authorized_price", percent: "", flat: "" }
}

function consultantLine(): DraftLine {
  return { key: nextKey(), kind: "sales_consultant", company: null, consultant: null, payoutChannel: "payroll", agentName: "", basis: "percent_of_authorized_price", percent: "", flat: "" }
}

export function emptyCommissionPlanDraft(): CommissionPlanDraft {
  return { coopBroker: "none", lines: [] }
}

function lineTerms(line: DraftLine): { basis: CommissionBasis; rateBps: number | null; flatCents: number | null } | null {
  if (line.basis === "flat") {
    const cents = parseMoneyToCents(line.flat)
    return cents && cents > 0 ? { basis: "flat", rateBps: null, flatCents: cents } : null
  }
  const percent = Number(line.percent)
  if (!line.percent.trim() || !Number.isFinite(percent)) return null
  const rateBps = Math.round(percent * 100)
  return rateBps >= 1 && rateBps <= 1500 ? { basis: "percent_of_authorized_price", rateBps, flatCents: null } : null
}

/**
 * The draft as the service takes it, or the first thing still missing. The lead
 * passes the input to `proposeCommissionPlan` once the agreement exists.
 */
export function commissionPlanDraftInput(draft: CommissionPlanDraft): { input: CommissionPlanInput } | { missing: string } {
  const lines: CommissionLineInput[] = []
  for (const line of draft.lines) {
    const terms = lineTerms(line)
    if (!terms) return { missing: "Give each commission a rate (0.01% to 15%) or a flat amount" }
    if (line.kind === "coop_broker") {
      if (!line.company) return { missing: "Choose the co-op broker's brokerage" }
      lines.push({ kind: "coop_broker", payeeCompanyId: line.company.id, agentName: line.agentName.trim() || null, ...terms })
    } else {
      if (!line.consultant) return { missing: "Choose the sales consultant" }
      if (line.payoutChannel === "accounts_payable" && !line.company) return { missing: "Choose the consultant's company, or pay them through payroll" }
      lines.push({ kind: "sales_consultant", payeeUserId: line.consultant.id, payoutChannel: line.payoutChannel,
        payeeCompanyId: line.payoutChannel === "accounts_payable" ? line.company?.id ?? null : null, ...terms })
    }
  }
  if (draft.coopBroker === "broker" && !draft.lines.some((line) => line.kind === "coop_broker")) return { missing: "Add the co-op broker's terms, or declare no co-op broker" }
  return { input: { coopBroker: draft.coopBroker, lines } }
}

function draftFromPlan(lines: CommissionPlanLineView[], coopBroker: "none" | "broker"): CommissionPlanDraft {
  return {
    coopBroker,
    lines: lines.map((line) => ({
      key: nextKey(),
      kind: line.kind,
      company: line.payeeCompanyId ? { id: line.payeeCompanyId, name: line.kind === "coop_broker" ? line.payeeName : line.payeeName.split(" · ")[1] ?? line.payeeName, detail: "Company" } : null,
      consultant: line.payeeUserId ? { id: line.payeeUserId, name: line.payeeName.split(" · ")[0], detail: "Member" } : null,
      payoutChannel: line.payoutChannel,
      agentName: line.agentName ?? "",
      basis: line.basis,
      percent: line.rateBps === null ? "" : String(line.rateBps / 100),
      flat: line.flatCents === null ? "" : String(line.flatCents / 100),
    })),
  }
}

function termsLabel(line: { basis: CommissionBasis; rateBps: number | null; flatCents: number | null }) {
  return line.basis === "flat" ? `${formatMoneyCentsExact(line.flatCents)} flat` : `${((line.rateBps ?? 0) / 100).toFixed(2)}%`
}

/**
 * The commission terms editor: co-op broker (None / Broker) and the sales
 * consultant's comp, each a percent of the authorized price or a flat amount,
 * with a live estimate on today's price. Controlled; it saves nothing itself.
 */
export function CommissionPlanEditor({ value, onChange, authorizedPriceCents, disabled = false }: {
  value: CommissionPlanDraft
  onChange: (value: CommissionPlanDraft) => void
  authorizedPriceCents: number
  disabled?: boolean
}) {
  const update = (key: string, patch: Partial<DraftLine>) => onChange({ ...value, lines: value.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) })
  const remove = (key: string) => {
    const lines = value.lines.filter((line) => line.key !== key)
    onChange({ coopBroker: lines.some((line) => line.kind === "coop_broker") ? value.coopBroker : "none", lines })
  }
  const setCoop = (next: string) => {
    if (next !== "none" && next !== "broker") return
    const others = value.lines.filter((line) => line.kind !== "coop_broker")
    onChange({ coopBroker: next, lines: next === "broker" ? [brokerLine(), ...others] : others })
  }
  const estimate = (line: DraftLine) => {
    const terms = lineTerms(line)
    return terms ? commissionAmountCents(terms, authorizedPriceCents) : null
  }
  const total = value.lines.reduce((sum, line) => sum + (estimate(line) ?? 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label className="text-xs">Co-op broker</Label>
        <ToggleGroup type="single" variant="outline" size="sm" value={value.coopBroker} onValueChange={setCoop} disabled={disabled}>
          <ToggleGroupItem value="none">None</ToggleGroupItem>
          <ToggleGroupItem value="broker">Broker</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {value.lines.map((line) => {
        const amount = estimate(line)
        return (
          <div key={line.key} className="space-y-3 border bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{line.kind === "coop_broker" ? "Co-op broker" : "Sales consultant"}</p>
              {line.kind === "sales_consultant" ? (
                <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => remove(line.key)}>Remove</Button>
              ) : null}
            </div>
            {line.kind === "coop_broker" ? (
              <>
                <SearchPicker label="Brokerage" noun="companies" value={line.company} onChange={(company) => update(line.key, { company })} search={searchCommissionCompaniesAction} disabled={disabled} />
                <div className="space-y-1">
                  <Label htmlFor={`${line.key}-agent`} className="text-xs">Agent</Label>
                  <Input id={`${line.key}-agent`} value={line.agentName} maxLength={200} placeholder="Co-op agent's name" disabled={disabled} onChange={(event) => update(line.key, { agentName: event.target.value })} />
                </div>
              </>
            ) : (
              <>
                <SearchPicker label="Consultant" noun="members" placeholder="Search members by name or email" value={line.consultant} onChange={(consultant) => update(line.key, { consultant })} search={searchCommissionConsultantsAction} disabled={disabled} />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Label className="text-xs">Paid through</Label>
                  <ToggleGroup type="single" variant="outline" size="sm" value={line.payoutChannel} disabled={disabled}
                    onValueChange={(next) => { if (next === "payroll" || next === "accounts_payable") update(line.key, { payoutChannel: next, company: next === "payroll" ? null : line.company }) }}>
                    <ToggleGroupItem value="payroll">Payroll</ToggleGroupItem>
                    <ToggleGroupItem value="accounts_payable">Their company (1099)</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {line.payoutChannel === "accounts_payable" ? (
                  <SearchPicker label="Consultant's company" noun="companies" value={line.company} onChange={(company) => update(line.key, { company })} search={searchCommissionCompaniesAction} disabled={disabled} />
                ) : null}
              </>
            )}
            <div className="grid grid-cols-[auto_1fr_auto] items-end gap-3">
              <ToggleGroup type="single" variant="outline" size="sm" value={line.basis} disabled={disabled}
                onValueChange={(next) => { if (next === "flat" || next === "percent_of_authorized_price") update(line.key, { basis: next }) }}>
                <ToggleGroupItem value="percent_of_authorized_price">%</ToggleGroupItem>
                <ToggleGroupItem value="flat">Flat</ToggleGroupItem>
              </ToggleGroup>
              {line.basis === "flat" ? (
                <Input aria-label="Flat amount" inputMode="decimal" placeholder="0.00" className="tabular-nums" value={line.flat} disabled={disabled} onChange={(event) => update(line.key, { flat: event.target.value })} />
              ) : (
                <Input aria-label="Rate in percent" inputMode="decimal" placeholder="2.5" className="tabular-nums" value={line.percent} disabled={disabled} onChange={(event) => update(line.key, { percent: event.target.value })} />
              )}
              <p className="min-w-24 text-right text-sm tabular-nums">{amount === null ? "—" : formatMoneyCentsExact(amount)}</p>
            </div>
          </div>
        )
      })}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" size="sm" variant="outline" disabled={disabled || value.lines.length >= 10} onClick={() => onChange({ ...value, lines: [...value.lines, consultantLine()] })}>
          Add consultant comp
        </Button>
        <p className="text-xs text-muted-foreground">
          {value.lines.length === 0 ? "No commissions on this sale" : <>Estimate on today&apos;s price <span className="ml-1 font-medium text-foreground tabular-nums">{formatMoneyCentsExact(total)}</span></>}
        </p>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = { proposed: "Waiting for approval", approved: "Approved", superseded: "Superseded", void: "Void" }

export function AgreementCommissionPlanSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading commission terms">
      <div className="flex items-center justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-5 w-28" /></div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

/**
 * The agreement's commission terms: what was proposed, who approved it, and the
 * approval or revision itself. Signing waits on an approved plan (or "none").
 */
export function AgreementCommissionPlan({ contractId, projectId, onChange }: {
  contractId: string
  projectId: string
  /** Called with the saved view after a proposal or approval, e.g. to resume signing. */
  onChange?: (view: AgreementCommissionView) => void
}) {
  const [view, setView] = useState<AgreementCommissionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<CommissionPlanDraft | null>(null)
  const [note, setNote] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let current = true
    getAgreementCommissionPlanAction(contractId).then((result) => {
      if (!current) return
      if (result.success) { setView(result.data); setError(null) } else setError(result.error)
    }).catch(() => { if (current) setError("Commission terms could not be loaded.") })
    return () => { current = false }
  }, [contractId, reload])

  const saved = useCallback((next: AgreementCommissionView) => {
    setView(next)
    setEditing(null)
    setNote("")
    setActionError(null)
    onChange?.(next)
  }, [onChange])

  const run = (work: () => Promise<AgreementCommissionView>) => startTransition(async () => {
    try { saved(await work()) } catch (failure) { setActionError(failure instanceof Error ? failure.message : "The commission terms were not saved") }
  })

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 border border-destructive/40 p-3 text-sm">
        <p className="text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => { setError(null); setReload((value) => value + 1) }}>Retry</Button>
      </div>
    )
  }
  if (!view) return <AgreementCommissionPlanSkeleton />

  const plan = view.plan
  const open = view.contractStatus === "draft" || view.contractStatus === "active"

  if (editing) {
    const ready = commissionPlanDraftInput(editing)
    return (
      <div className="space-y-3">
        <CommissionPlanEditor value={editing} onChange={setEditing} authorizedPriceCents={view.authorizedPriceCents} disabled={pending} />
        {"missing" in ready ? <p className="text-xs text-muted-foreground">{ready.missing}</p> : null}
        {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setEditing(null); setActionError(null) }}>Cancel</Button>
          <Button size="sm" disabled={pending || "missing" in ready}
            onClick={() => { if ("input" in ready) run(async () => unwrapAction(await proposeCommissionPlanAction(projectId, { contractId, plan: ready.input, reason: plan ? "Commission terms revised" : null }))) }}>
            {editing.lines.length === 0 ? "Declare no commissions" : view.canApprove ? "Propose for approval" : "Send for approval"}
          </Button>
        </div>
      </div>
    )
  }

  if (!plan) {
    return (
      <div className="space-y-3">
        <div className="border border-dashed p-4 text-sm">
          <p className="font-medium">No commission terms yet</p>
          <p className="mt-1 text-muted-foreground">The agreement goes out for signature, and the home closes, only once its commissions are approved or declared none.</p>
        </div>
        {view.canManage && open ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={pending}
              onClick={() => run(async () => unwrapAction(await proposeCommissionPlanAction(projectId, { contractId, plan: { coopBroker: "none", lines: [] } })))}>
              Declare no commissions
            </Button>
            <Button size="sm" disabled={pending} onClick={() => setEditing(emptyCommissionPlanDraft())}>Set commissions</Button>
          </div>
        ) : null}
        {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Revision {plan.revision} · proposed by {plan.proposedByName ?? "a member"}
          {plan.approvedByName ? ` · approved by ${plan.approvedByName}` : ""}
        </p>
        <Badge variant="outline" className={plan.status === "approved" ? "border-success/40 text-success" : "border-warning/40 text-warning"}>
          {plan.lineCount === 0 && plan.status === "approved" ? "No commissions" : STATUS_LABEL[plan.status]}
        </Badge>
      </div>
      {plan.lines.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">Payee</th>
              <th className="py-1.5 font-medium">Paid through</th>
              <th className="py-1.5 text-right font-medium">Terms</th>
              <th className="py-1.5 text-right font-medium">Est.</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {plan.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2">
                  <p className="font-medium">{line.payeeName}</p>
                  <p className="text-xs text-muted-foreground">{line.kind === "coop_broker" ? line.agentName ?? "Co-op broker" : "Sales consultant"}</p>
                </td>
                <td className="py-2 text-muted-foreground">{line.payoutChannel === "payroll" ? "Payroll" : "Payables"}</td>
                <td className="py-2 text-right tabular-nums">{termsLabel(line)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoneyCentsExact(line.estimateCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {plan.hiddenLineCount > 0 ? <p className="text-xs text-muted-foreground">{plan.hiddenLineCount} consultant {plan.hiddenLineCount === 1 ? "line is" : "lines are"} private to the payee and approvers.</p> : null}
      {plan.lines.length ? (
        <p className="text-xs text-muted-foreground">Estimated on today&apos;s authorized price of {formatMoneyCentsExact(view.authorizedPriceCents)}; settled on the price at closing.</p>
      ) : null}
      {plan.status === "proposed" ? (
        view.canApprove && !view.approvalRefusal ? (
          <div className="space-y-2 border-t pt-3">
            <Label htmlFor={`${contractId}-commission-note`} className="text-xs">Approval note</Label>
            <Textarea id={`${contractId}-commission-note`} rows={2} maxLength={1000} value={note} disabled={pending} onChange={(event) => setNote(event.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" disabled={pending} onClick={() => run(async () => unwrapAction(await approveCommissionPlanAction(projectId, { planId: plan.id, note: note.trim() || null })))}>
                Approve commissions
              </Button>
            </div>
          </div>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">{view.approvalRefusal && view.canApprove ? view.approvalRefusal : "Needs approval by a sales manager before the agreement goes out for signature."}</p>
        )
      ) : null}
      {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
      {view.canManage && open && plan.hiddenLineCount === 0 ? (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setEditing(draftFromPlan(plan.lines, plan.coopBroker))}>Revise terms</Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * A draft agreement's commission hold. Signing waits on approved terms (or a
 * declared "none"); once the terms clear, signing preparation resumes from
 * here, so the person who clears the hold never has to find a second button.
 */
export function AgreementCommissionSigningHold({ contractId, projectId, onResumed }: {
  contractId: string
  projectId: string
  /** Called after signing preparation is attempted; defaults to refreshing the page. */
  onResumed?: () => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [, startTransition] = useTransition()
  const resume = useCallback((view: AgreementCommissionView) => {
    if (view.signingRefusal !== null || view.contractStatus !== "draft") return
    startTransition(async () => {
      const result = await resumePurchaseAgreementSigningAction({ contractId, projectId })
      if (!result.success) {
        toast({ title: "Commissions cleared; signing not resumed", description: result.error })
        return
      }
      const sent = Boolean(result.data.documentId && result.data.envelopeId && !result.data.reason)
      toast({ title: sent ? "Agreement sent for signature" : "Commissions cleared", description: result.data.reason ?? "Buyer invitations were accepted for email delivery." })
      if (onResumed) onResumed()
      else router.refresh()
    })
  }, [contractId, onResumed, projectId, router, toast])
  return <AgreementCommissionPlan contractId={contractId} projectId={projectId} onChange={resume} />
}
