"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"

import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import { applyConfigurationFixAction, approveGroupAction, declineApprovalAction, loadApprovalsAction, loadConfigurationIssuesAction, selectOptionAction, selectPackageAction, type PortalSelectionApproval } from "./actions"
import { ConfigurationIssues } from "@/components/selections/configuration-issues"
import type { ActionFailure, ActionResult } from "@/lib/action-result"
import type { ConfigurationFix } from "@/lib/selections/configuration-fixes"
import type { ConfigurationViolation } from "@/lib/selections/configuration-rules"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

type PortalSelection = Omit<Selection, "cost_cents_snapshot"> & {
  effective_due_date?: string | null
  locked?: boolean
  group?: {
    id: string
    name: string
    cutoff_date: string | null
    status: "open" | "locked"
  } | null
}

interface SelectionsData {
  selections: PortalSelection[]
  categories: SelectionCategory[]
  optionsByCategory: Record<string, Array<Omit<SelectionOption, "cost_cents" | "cost_code_id" | "vendor">>>
  packages: Array<{ id: string; name: string; description: string | null; image_url: string | null; price_cents: number; option_ids: string[] }>
  configuration: ActionResult<{ violations: ConfigurationViolation[]; fixes: ConfigurationFix[] }>
  approvals?: ActionResult<PortalSelectionApproval[]>
}

const APPROVAL_BADGE: Record<PortalSelectionApproval["state"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  approved: { label: "Approved", variant: "secondary" },
  sent: { label: "Awaiting your approval", variant: "default" },
  declined: { label: "Declined", variant: "destructive" },
  expired: { label: "Expired", variant: "outline" },
  unsigned: { label: "Open", variant: "outline" },
}

/** A choice the rules refused, held so its corrections can be applied together with it. */
type RefusedChoice = {
  groupId: string
  selectionId: string
  optionId: string
  violations: ConfigurationViolation[]
  fixes: ConfigurationFix[]
}

/** A choice the home cannot have in time, held with what it can have instead. */
type UnavailableChoice = {
  groupId: string
  selectionId: string
  message: string
  supply: NonNullable<ActionFailure["supply"]>
}

const CHANGE_ORDER_HINT = "Contact your builder to request a change order."

interface Props {
  token: string
  data: SelectionsData
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function formatPriceLabel(option: Pick<SelectionOption, "price_type" | "price_delta_cents" | "price_cents">): string | undefined {
  if (option.price_type === "included") return "Included"
  const cents = option.price_delta_cents ?? option.price_cents
  if (cents == null || cents === 0) return cents === 0 ? "Included" : undefined
  const amount = formatMoney(Math.abs(cents))
  if (option.price_type === "downgrade" || cents < 0) return `-${amount}`
  return `+${amount}`
}

function daysUntil(dateValue: string | null | undefined) {
  if (!dateValue) return null
  return Math.ceil((Date.parse(`${dateValue}T00:00:00`) - Date.now()) / 86_400_000)
}

export function SelectionsPortalClient(props: Props) {
  return <SelectionsPortalWorkspace key={props.token} {...props} />
}

function SelectionsPortalWorkspace({ token, data }: Props) {
  const [selections, setSelections] = useState(data.selections)
  const [selectionSource, setSelectionSource] = useState(data.selections)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [refused, setRefused] = useState<RefusedChoice | null>(null)
  const [unavailable, setUnavailable] = useState<UnavailableChoice | null>(null)
  const [fixError, setFixError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  if (selectionSource !== data.selections) {
    setSelectionSource(data.selections)
    setSelections(data.selections)
  }
  const [configuration, setConfiguration] = useState(data.configuration)
  const [configurationSource, setConfigurationSource] = useState(data.configuration)
  if (configurationSource !== data.configuration) {
    setConfigurationSource(data.configuration)
    setConfiguration(data.configuration)
  }
  const homeIssues = configuration.success ? configuration.data : { violations: [], fixes: [] }
  const [approvals, setApprovals] = useState(data.approvals)
  const [approvalsSource, setApprovalsSource] = useState(data.approvals)
  if (approvalsSource !== data.approvals) {
    setApprovalsSource(data.approvals)
    setApprovals(data.approvals)
  }
  const [declining, setDeclining] = useState<string | null>(null)
  const approvalFor = (groupId: string) =>
    approvals?.success ? approvals.data.find((approval) => approval.groupId === (groupId === "ungrouped" ? null : groupId)) ?? null : null
  const categoriesById = useMemo(() => new Map(data.categories.map((category) => [category.id, category])), [data.categories])
  const grouped = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; cutoff: string | null; locked: boolean; items: PortalSelection[] }>()
    for (const selection of selections) {
      const key = selection.group_id ?? "ungrouped"
      const current = groups.get(key) ?? {
        id: key,
        name: selection.group?.name ?? "Selections",
        cutoff: selection.group?.cutoff_date ?? selection.due_date ?? null,
        locked: Boolean(selection.locked || selection.group?.status === "locked"),
        items: [],
      }
      current.items.push(selection)
      groups.set(key, current)
    }
    return Array.from(groups.values())
  }, [selections])

  function showChoices(writes: Array<{ selectionId: string; optionId: string }>) {
    setSelections((current) => current.map((selection) => {
      const write = writes.find((candidate) => candidate.selectionId === selection.id)
      return write ? {
        ...selection,
        selected_option_id: write.optionId,
        selected_option: data.optionsByCategory[selection.category_id]?.find((option) => option.id === write.optionId) ?? null,
        status: "selected",
      } : selection
    }))
  }

  function handleSelect(selectionId: string, optionId: string, groupId: string) {
    setPendingId(selectionId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    setRefused(null)
    setUnavailable(null)
    setFixError(null)
    startTransition(async () => {
      const result = await selectOptionAction({ token, selectionId, optionId })
      if (!result.success) {
        if (result.violations?.length) setRefused({ groupId, selectionId, optionId, violations: result.violations, fixes: result.fixes ?? [] })
        else if (result.supply) setUnavailable({ groupId, selectionId, message: result.error, supply: result.supply })
        else setErrors((current) => ({ ...current, [groupId]: result.error }))
        setPendingId(null)
        return
      }
      showChoices([{ selectionId, optionId }])
      if (homeIssues.violations.length > 0) setConfiguration(await loadConfigurationIssuesAction(token))
      setApprovals(await loadApprovalsAction(token))
      setPendingId(null)
    })
  }

  function handleFix(fix: ConfigurationFix, proposal: RefusedChoice | null) {
    setPendingId(fix.id)
    setFixError(null)
    startTransition(async () => {
      const result = await applyConfigurationFixAction({
        token,
        fixId: fix.id,
        proposal: proposal ? { selectionId: proposal.selectionId, optionId: proposal.optionId } : null,
      })
      setPendingId(null)
      if (!result.success) {
        setFixError(result.error)
        return
      }
      showChoices(result.data.writes)
      setRefused(null)
      setConfiguration({ success: true, data: result.data.configuration })
      setApprovals(await loadApprovalsAction(token))
    })
  }

  function handleApprove(groupId: string, termsHash: string) {
    setPendingId(groupId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await approveGroupAction({ token, groupId: groupId === "ungrouped" ? null : groupId, termsHash })
      if (!result.success) {
        setErrors((current) => ({ ...current, [groupId]: result.error }))
        setApprovals(await loadApprovalsAction(token))
        setPendingId(null)
        return
      }
      setApprovals(result)
      setSelections((current) => current.map((selection) => (selection.group_id ?? "ungrouped") === groupId ? { ...selection, status: "confirmed", confirmed_at: new Date().toISOString() } : selection))
      setPendingId(null)
    })
  }

  function handleDecline(groupId: string, approvalId: string, formData: FormData) {
    setPendingId(groupId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await declineApprovalAction({ token, approvalId, reason: String(formData.get("reason") ?? "") || undefined })
      if (!result.success) setErrors((current) => ({ ...current, [groupId]: result.error }))
      else {
        setApprovals(result)
        setDeclining(null)
      }
      setPendingId(null)
    })
  }

  function handlePackage(packageId: string, groupId: string) {
    setPendingId(packageId)
    setErrors((current) => ({ ...current, [groupId]: "" }))
    startTransition(async () => {
      const result = await selectPackageAction({ token, packageId })
      if (!result.success) {
        setErrors((current) => ({ ...current, [groupId]: result.error }))
        setPendingId(null)
        return
      }
      const selectionPackage = data.packages.find((item) => item.id === packageId)
      const members = new Set(selectionPackage?.option_ids ?? [])
      setSelections((current) => current.map((selection) => {
        if (selection.group_id !== groupId) return selection
        const option = data.optionsByCategory[selection.category_id]?.find((candidate) => members.has(candidate.id))
        return option ? { ...selection, selected_option_id: option.id, selected_option: option, package_id: packageId, status: "selected" } : selection
      }))
      setApprovals(await loadApprovalsAction(token))
      setPendingId(null)
    })
  }

  return (
    <div>
      <div className="space-y-6">
        {!configuration.success || homeIssues.violations.length > 0 ? (
          <div className="border">
            <div className="border-b bg-muted/30 px-4 py-3">
              <h2 className="font-semibold">{configuration.success ? "Some choices don't work together" : "Your choices could not be checked"}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{configuration.success ? "Pick one of the corrections below, or contact your builder." : "Refresh the page to try again, or contact your builder."}</p>
            </div>
            <ConfigurationIssues
              violations={homeIssues.violations}
              fixes={homeIssues.fixes}
              error={configuration.success ? null : configuration.error}
              pendingFixId={pendingId}
              disabled={isPending}
              changeOrderHint={CHANGE_ORDER_HINT}
              onApply={(fix) => handleFix(fix, null)}
            />
            {fixError && !refused && <p role="alert" className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{fixError}</p>}
          </div>
        ) : null}
        {grouped.length === 0 && <div className="border border-border p-8 text-center text-sm text-muted-foreground">No selections have been assigned yet.</div>}

        {grouped.map((group) => {
          const selectedCount = group.items.filter((item) => item.selected_option_id).length
          const approval = approvalFor(group.id)
          const allConfirmed = approval?.confirmed ?? group.items.every((item) => item.status === "confirmed" || item.status === "ordered" || item.status === "received")
          const remaining = daysUntil(group.cutoff)
          const badge = APPROVAL_BADGE[allConfirmed ? "approved" : approval?.state ?? "unsigned"]
          const awaitingSignature = approval?.pending?.channel === "esign"
          const groupTotal = approval?.totalCents ?? group.items.reduce((sum, item) => sum + Number(item.price_cents_snapshot ?? 0), 0)
          return (
            <section key={group.id} className="border">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/30 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2"><h2 className="font-semibold">{group.name}</h2><Badge variant={group.locked && !allConfirmed ? "destructive" : badge.variant} className="rounded-none">{group.locked && !allConfirmed ? "Locked" : badge.label}</Badge></div>
                  <p className={`mt-1 text-xs ${remaining != null && remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {group.cutoff ? `Due ${format(new Date(`${group.cutoff}T00:00:00`), "MMM d")} — ${remaining != null && remaining >= 0 ? `${remaining} days left` : "deadline passed"}` : "Deadline pending schedule"}
                  </p>
                </div>
                <p className="text-sm tabular-nums text-muted-foreground">{selectedCount} of {group.items.length} selected</p>
              </div>

              {group.locked ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">Locked — contact your builder to make changes.</p>
              ) : (
                <div className="divide-y">
                  {data.packages.filter((item) => {
                    const optionIds = new Set(item.option_ids)
                    return group.items.some((selection) => data.optionsByCategory[selection.category_id]?.some((option) => optionIds.has(option.id)))
                  }).map((item) => <div key={item.id} className="bg-muted/20 p-4"><button type="button" disabled={isPending || allConfirmed} onClick={() => handlePackage(item.id, group.id)} className="flex w-full items-center gap-3 border bg-background p-3 text-left hover:bg-muted/40">{item.image_url ? <img src={item.image_url} alt="" className="h-14 w-14 border object-cover" /> : <div className="h-14 w-14 border bg-muted" />}<span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{item.name}</span><span className="block text-xs text-muted-foreground">Includes {item.option_ids.length} selections{item.description ? ` — ${item.description}` : ""}</span></span><span className="text-sm font-medium tabular-nums">+{formatMoney(item.price_cents)}</span><Badge variant="outline" className="rounded-none">{pendingId === item.id && isPending ? <Spinner className="h-3.5 w-3.5" /> : "Choose package"}</Badge></button></div>)}
                  {group.items.map((selection) => {
                    const category = categoriesById.get(selection.category_id)
                    const options = data.optionsByCategory[selection.category_id] ?? []
                    return (
                      <div key={selection.id} className="p-4">
                        <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{category?.name ?? "Selection"}</h3>{category?.description && <p className="mt-0.5 text-xs text-muted-foreground">{category.description}</p>}</div><Badge variant="outline" className="rounded-none text-[10px]">{selection.status}</Badge></div>
                        {options.length === 0 ? <p className="text-sm text-muted-foreground">No options are available.</p> : <div className="space-y-2">{options.map((option) => {
                          const selected = selection.selected_option_id === option.id
                          return <button key={option.id} type="button" aria-pressed={selected} disabled={isPending || allConfirmed} onClick={() => handleSelect(selection.id, option.id, group.id)} className={`flex w-full items-center gap-3 border p-2.5 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
                            {option.image_url ? <img src={option.image_url} alt="" className="h-12 w-12 border object-cover" /> : <div className="h-12 w-12 border bg-muted" />}
                            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{option.name}</span>{option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}</span>
                            <span className="text-sm font-medium tabular-nums">{formatPriceLabel(option) ?? "—"}</span>
                            <Badge variant={selected ? "default" : "outline"} className="w-20 justify-center rounded-none">{pendingId === selection.id && isPending ? <Spinner className="h-3.5 w-3.5" /> : selected ? "Selected" : "Choose"}</Badge>
                          </button>
                        })}</div>}
                      </div>
                    )
                  })}
                </div>
              )}

              {refused?.groupId === group.id && (
                <div className="border-t">
                  <p className="px-4 pt-3 text-sm font-medium">That choice needs a change first</p>
                  <div className="p-4 pt-2">
                    <ConfigurationIssues
                      violations={refused.violations}
                      fixes={refused.fixes}
                      pendingFixId={pendingId}
                      disabled={isPending}
                      changeOrderHint={CHANGE_ORDER_HINT}
                      onApply={(fix) => handleFix(fix, refused)}
                    />
                    {fixError && <p role="alert" className="mt-2 text-sm text-destructive">{fixError}</p>}
                  </div>
                </div>
              )}

              {unavailable?.groupId === group.id && (
                <div className="border-t" role="alert">
                  {unavailable.supply.alternates.length > 0 ? (
                    <div className="p-4">
                      <p className="text-sm font-medium">{unavailable.supply.reason}</p>
                      <p className="mt-1 text-xs text-muted-foreground">These can still arrive in time:</p>
                      <div className="mt-3 space-y-2">
                        {unavailable.supply.alternates.map((alternate) => (
                          <button
                            key={alternate.optionId}
                            type="button"
                            disabled={isPending}
                            onClick={() => handleSelect(unavailable.selectionId, alternate.optionId, group.id)}
                            className="flex w-full items-center gap-3 border p-2.5 text-left transition-colors hover:bg-muted/50"
                          >
                            <span className="min-w-0 flex-1 text-sm font-medium">{alternate.name}</span>
                            <span className="text-sm font-medium tabular-nums">{alternate.priceCents === 0 ? "Included" : formatMoney(alternate.priceCents)}</span>
                            <Badge variant="outline" className="w-24 justify-center rounded-none">{pendingId === unavailable.selectionId && isPending ? <Spinner className="h-3.5 w-3.5" /> : "Choose instead"}</Badge>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="p-4 text-sm">{unavailable.message}</p>
                  )}
                </div>
              )}

              {!group.locked && (approval || group.id !== "ungrouped") && (
                <div className="border-t bg-muted/20 p-4">
                  <h3 className="mb-2 text-sm font-semibold">Review &amp; approve</h3>
                  <Table><TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Choice</TableHead><TableHead className="text-right">Price</TableHead></TableRow></TableHeader><TableBody>{group.items.map((selection) => <TableRow key={selection.id}><TableCell>{categoriesById.get(selection.category_id)?.name ?? "Selection"}</TableCell><TableCell>{selection.selected_option?.name ?? "Not selected"}</TableCell><TableCell className="text-right tabular-nums">{selection.price_cents_snapshot == null ? "—" : selection.price_cents_snapshot === 0 ? "Included" : formatMoney(selection.price_cents_snapshot)}</TableCell></TableRow>)}</TableBody><TableFooter><TableRow><TableCell colSpan={2}>Group total</TableCell><TableCell className="text-right tabular-nums">{formatMoney(groupTotal)}</TableCell></TableRow></TableFooter></Table>
                  {approval?.state === "declined" && approval.reason && <p className="mt-3 text-xs text-muted-foreground">You declined these: “{approval.reason}”. Your builder will be in touch.</p>}
                  {approval?.state === "expired" && <p className="mt-3 text-xs text-muted-foreground">The request to approve these selections expired. Contact your builder.</p>}
                  {awaitingSignature && <p className="mt-3 text-sm text-muted-foreground">We sent these selections to you for e-signature. Sign them from the email we sent you.</p>}
                  {errors[group.id] && <p role="alert" className="mt-3 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errors[group.id]}</p>}
                  {declining === group.id && approval?.pending ? (
                    <form className="mt-3 space-y-2" action={(formData) => { if (approval.pending) handleDecline(group.id, approval.pending.id, formData) }}>
                      <Textarea name="reason" placeholder="What would you like to change? (optional)" maxLength={1000} className="rounded-none" />
                      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" className="rounded-none" onClick={() => setDeclining(null)}>Keep reviewing</Button><Button type="submit" variant="destructive" className="rounded-none" disabled={isPending}>Decline</Button></div>
                    </form>
                  ) : !awaitingSignature && (
                    <div className="mt-3 flex justify-end gap-2">
                      {approval?.pending?.channel === "portal" && !allConfirmed && <Button variant="outline" className="rounded-none" disabled={isPending} onClick={() => setDeclining(group.id)}>Decline</Button>}
                      <Button className="rounded-none" disabled={isPending || allConfirmed || selectedCount !== group.items.length || !approval?.complete} onClick={() => { if (approval) handleApprove(group.id, approval.termsHash) }}>{pendingId === group.id && isPending && <Spinner className="mr-2 h-4 w-4" />}{allConfirmed ? "Confirmed" : "Approve these selections"}</Button>
                    </div>
                  )}
                </div>
              )}
              {(group.locked || (!approval && group.id === "ungrouped")) && errors[group.id] && <p role="alert" className="m-4 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errors[group.id]}</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}
