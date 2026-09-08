"use client"
import {
  WAIVER_KINDS,
  WAIVER_KIND_LABELS,
  normalizeWaiverKind,
} from "@/lib/lien-waivers/coverage"
import { useState } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table"
import { PayableWaivers } from "@/components/payables/payable-waivers"
import { WaiverClaimantSheet } from "./waiver-claimant-sheet"
import { createSubtierRequirementAction, chaseWaiversAction } from "./actions"
import {
  manageSubtierWaiverAction,
  carryForwardClaimantsAction,
} from "@/app/(app)/payables/waiver-actions"
import { unwrapAction } from "@/lib/action-result"
import type {
  WaiverRegister,
  RegisterRequirement,
} from "@/lib/services/waiver-register"
import type { CommitmentSummary } from "@/lib/services/commitments"
const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n / 100,
  )
const csv = (v: unknown) =>
  `"${String(v ?? "")
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`
export function WaiverRegisterClient({
  projectId,
  register,
  commitments,
}: {
  projectId?: string
  register: WaiverRegister
  commitments: CommitmentSummary[]
}) {
  const router = useRouter(),
    params = useSearchParams(),
    pathname = usePathname()
  const [billId, setBillId] = useState<string | null>(null),
    [combined, setCombined] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [claimantOpen, setClaimantOpen] = useState(false)
  const [claimant, setClaimant] = useState<RegisterRequirement | null>(null),
    [operation, setOperation] = useState("record"),
    [waiverId, setWaiverId] = useState(""),
    [note, setNote] = useState("")
  function change(key: string, value: string) {
    const next = new URLSearchParams(params)
    value ? next.set(key, value) : next.delete(key)
    if (key !== "page") next.delete("page")
    setSelected([])
    router.push(`${pathname}?${next}`)
  }
  async function act(task: () => Promise<unknown>) {
    setBusy(true)
    try {
      await task()
      router.refresh()
      setSelected([])
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not complete action")
      return false
    } finally {
      setBusy(false)
    }
  }
  function exportPage() {
    const rows = [
      [
        "Vendor",
        "Project",
        "Bill",
        "Work through",
        "Bill amount",
        "Paid",
        "Held",
        "Collection state",
        "Review needed",
        "Unconditional outstanding",
      ],
      ...register.entries.map((e) => [
        e.companyName,
        e.projectName,
        e.bill.bill_number,
        e.coverage.through,
        money(e.bill.total_cents),
        money(e.bill.paid_cents ?? 0),
        money(e.coverage.heldCents),
        e.coverage.status,
        e.coverage.needsReview,
        e.coverage.postPaymentOutstanding,
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob([rows.map((r) => r.map(csv).join(",")).join("\n")], {
        type: "text/csv",
      }),
    )
    const a = document.createElement("a")
    a.href = url
    a.download = "waiver-register.csv"
    a.click()
    URL.revokeObjectURL(url)
  }
  function manage(r: RegisterRequirement, op: string, id = "") {
    setClaimant(r)
    setOperation(op)
    setWaiverId(id)
    setNote("")
  }
  return (
    <div className="desk-rise">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="flex gap-3 text-sm">
          <a
            className="underline"
            href={
              projectId
                ? `/projects/${projectId}/financials/payables`
                : "/payables"
            }
          >
            Payables
          </a>
          <span>Waivers</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportPage}>
            Export page CSV
          </Button>
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/payables/waivers/export?${new URLSearchParams({ ...Object.fromEntries(params), ...(projectId ? { projectId } : {}), format: "csv" })}`}
            >
              Export full register
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/payables/waivers/export?${new URLSearchParams({ ...Object.fromEntries(params), ...(projectId ? { projectId } : {}), format: "pdf" })}`}
            >
              Download packet
            </a>
          </Button>
          {projectId && (
            <Button size="sm" onClick={() => setClaimantOpen(true)}>
              Add claimant
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b p-4">
        <label className="text-xs">
          Search vendors, projects, bills
          <Input
            key={params.get("q")}
            defaultValue={params.get("q") ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") change("q", e.currentTarget.value)
            }}
            onBlur={(e) => {
              if (e.target.value !== (params.get("q") ?? ""))
                change("q", e.target.value)
            }}
          />
        </label>
        <label className="text-xs">
          Work through (optional)
          <Input
            type="date"
            value={register.periodEnd}
            onChange={(e) => change("periodEnd", e.target.value)}
          />
        </label>
        <label className="text-xs">
          View
          <select
            className="block h-9 border bg-background px-3"
            value={params.get("status") ?? "outstanding"}
            onChange={(e) => change("status", e.target.value)}
          >
            <option value="outstanding">All outstanding</option>
            <option value="all">All records</option>
            <option value="review">Needs review</option>
            <option value="unconditional">Unconditional outstanding</option>
            <option value="final">Final releases outstanding</option>
            <option value="accepted">Accepted</option>
          </select>
        </label>
        {projectId && register.periodEnd && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const n = unwrapAction(
                  await carryForwardClaimantsAction(
                    projectId,
                    register.periodEnd,
                  ),
                )
                toast.success(
                  `${n} claimant requirements carried forward; review their amounts`,
                )
              })
            }
          >
            Carry forward claimants
          </Button>
        )}
      </div>
      <p className="border-b px-4 py-3 text-sm text-muted-foreground">
        {register.total} payables · {register.totals.needsReview} need review ·{" "}
        {register.totals.postPayment} unconditional outstanding ·{" "}
        <span className="text-warning">
          {money(register.totals.heldCents)} blocked
        </span>
      </p>
      {selected.length > 0 && (
        <div className="flex items-center gap-3 border-b p-3">
          <span className="text-sm">{selected.length} selected</span>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const groups = new Map<string, string[]>()
                for (const e of register.entries.filter((e) =>
                  selected.includes(e.bill.id),
                ))
                  groups.set(e.bill.project_id, [
                    ...(groups.get(e.bill.project_id) ?? []),
                    e.bill.id,
                  ])
                for (const [pid, ids] of groups)
                  unwrapAction(
                    await chaseWaiversAction({ projectId: pid, billIds: ids }),
                  )
                toast.success("Reminders queued")
              })
            }
          >
            Send reminders
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const entries = register.entries.filter((e) =>
                selected.includes(e.bill.id),
              )
              if (new Set(entries.map((e) => e.bill.company_id)).size !== 1) {
                toast.error("Select payables for one vendor")
                return
              }
              setCombined(true)
              setBillId(entries[0].bill.id)
            }}
          >
            Prepare combined waiver
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <input
                aria-label="Select page"
                type="checkbox"
                checked={
                  register.entries.length > 0 &&
                  selected.length === register.entries.length
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? register.entries.map((r) => r.bill.id)
                      : [],
                  )
                }
              />
            </TableHead>
            <TableHead>Vendor / payable</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Work through</TableHead>
            <TableHead className="text-right">Bill / paid</TableHead>
            <TableHead className="text-right">Blocked</TableHead>
            <TableHead>Waiver status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {register.entries.map((e) => (
            <TableRow key={e.bill.id}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Select ${e.bill.bill_number}`}
                  checked={selected.includes(e.bill.id)}
                  onChange={(ev) =>
                    setSelected(
                      ev.target.checked
                        ? [...selected, e.bill.id]
                        : selected.filter((id) => id !== e.bill.id),
                    )
                  }
                />
              </TableCell>
              <TableCell>
                <button
                  className="text-left hover:underline"
                  onClick={() => setBillId(e.bill.id)}
                >
                  <span className="block font-medium">{e.companyName}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.bill.bill_number ?? "Payable"}
                  </span>
                </button>
                {e.requirements.map((r) => (
                  <div className="mt-3 border-l pl-3" key={r.id}>
                    <p className="text-xs">
                      {r.claimant_company_name} ·{" "}
                      {r.received ? "Accepted" : "Outstanding"}
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <button
                        className="underline"
                        onClick={() => manage(r, "edit")}
                      >
                        Edit amount
                      </button>
                      <button
                        className="underline"
                        onClick={() => manage(r, "record")}
                      >
                        Record PDF
                      </button>
                      <button
                        className="underline"
                        onClick={() => manage(r, "remind")}
                      >
                        Remind
                      </button>
                      <button
                        className="underline"
                        onClick={() => manage(r, "retire")}
                      >
                        Retire
                      </button>
                      {r.waivers.map((w) => (
                        <span key={w.id}>
                          {w.documentHref && (
                            <a
                              href={w.documentHref}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              PDF
                            </a>
                          )}{" "}
                          <button
                            className="underline"
                            onClick={() => manage(r, "accept", w.id)}
                          >
                            Review
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </TableCell>
              <TableCell>{e.projectName}</TableCell>
              <TableCell>{e.coverage.through ?? "Set coverage date"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(e.bill.total_cents)}
                <span className="block text-xs text-muted-foreground">
                  {money(e.bill.paid_cents ?? 0)} paid
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(e.coverage.heldCents)}
              </TableCell>
              <TableCell>
                <span
                  className={
                    e.coverage.reasons.length ||
                    e.coverage.needsReview ||
                    e.coverage.postPaymentOutstanding
                      ? "text-warning"
                      : "text-muted-foreground"
                  }
                >
                  {e.coverage.status}
                </span>
                {e.coverage.reasons.map((r) => (
                  <p className="max-w-64 text-xs text-muted-foreground" key={r}>
                    {r}
                  </p>
                ))}
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setBillId(e.bill.id)}
                >
                  Open
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {register.unbilledClaimants.length > 0 && (
        <section className="space-y-3 border-t p-4">
          <h2 className="text-sm font-medium">
            Claimants awaiting a matching payable · {register.unbilledTotal}
          </h2>
          {register.unbilledClaimants.map((r) => (
            <div
              className="flex flex-wrap justify-between gap-3 border-b py-3 text-xs"
              key={r.id}
            >
              <div>
                <p className="font-medium">
                  {r.claimant_company_name} · {r.projectName}
                </p>
                <p>
                  {r.period_end} · {money(r.amount_cents)} ·{" "}
                  {r.metadata?.amount_needs_review
                    ? "Review required amount"
                    : r.received
                      ? "Accepted"
                      : "Outstanding"}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button className="underline" onClick={() => manage(r, "edit")}>
                  Edit amount
                </button>
                <button
                  className="underline"
                  onClick={() => manage(r, "record")}
                >
                  Record PDF
                </button>
                <button
                  className="underline"
                  onClick={() => manage(r, "remind")}
                >
                  Remind
                </button>
                <button
                  className="underline"
                  onClick={() => manage(r, "retire")}
                >
                  Retire
                </button>
                {r.waivers.map((w) => (
                  <span key={w.id}>
                    {w.documentHref && (
                      <a
                        href={w.documentHref}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        PDF
                      </a>
                    )}{" "}
                    <button
                      className="underline"
                      onClick={() => manage(r, "accept", w.id)}
                    >
                      Review
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      {!register.entries.length && (
        <p className="px-6 py-20 text-center text-sm text-muted-foreground">
          No payables match this view. Clear the date or view all records.
        </p>
      )}
      <div className="flex items-center justify-between border-t p-4 text-sm">
        <span>
          Page {register.page} of {register.pages}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={register.page <= 1}
            onClick={() => change("page", String(register.page - 1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={register.page >= register.pages}
            onClick={() => change("page", String(register.page + 1))}
          >
            Next
          </Button>
        </div>
      </div>
      <Dialog
        open={Boolean(billId)}
        onOpenChange={(v) => {
          if (!v) {
            setBillId(null)
            setCombined(false)
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Payable waivers</DialogTitle>
          </DialogHeader>
          {billId && (
            <PayableWaivers
              billId={billId}
              allocations={
                combined
                  ? register.entries
                      .filter((e) => selected.includes(e.bill.id))
                      .map((e) => ({
                        bill_id: e.bill.id,
                        amount_cents:
                          e.coverage.outstandingCents ||
                          e.bill.paid_cents ||
                          e.bill.total_cents,
                      }))
                  : undefined
              }
            />
          )}
        </DialogContent>
      </Dialog>
      {projectId && (
        <WaiverClaimantSheet
          open={claimantOpen}
          onOpenChange={setClaimantOpen}
          commitments={commitments}
          periodEnd={
            register.periodEnd || new Date().toISOString().slice(0, 10)
          }
          isSubmitting={busy}
          onSubmit={async (values) => {
            const c = commitments.find((c) => c.id === values.commitment_id)
            if (!c?.company_id) return false
            const throughCompanyId=c.company_id
            return await act(async () =>
              unwrapAction(
                await createSubtierRequirementAction({
                  projectId,
                  commitmentId: c.id,
                  throughCompanyId,
                  claimantCompanyName: values.claimant_company_name,
                  amountCents: Math.round(values.amount_dollars * 100),
                  waiverType: values.waiver_type,
                  periodEnd:
                    register.periodEnd || new Date().toISOString().slice(0, 10),
                }),
              ),
            )
          }}
        />
      )}
      <Dialog
        open={Boolean(claimant)}
        onOpenChange={(v) => {
          if (!v) setClaimant(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{claimant?.claimant_company_name}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              f.set(
                "input",
                JSON.stringify({
                  requirementId: claimant?.id,
                  operation,
                  waiverId: waiverId || undefined,
                  note,
                  signedDate: f.get("signedDate") || undefined,
                  waiverType: f.get("waiverType") || undefined,
                  throughDate: f.get("throughDate") || undefined,
                  amountCents: f.get("amount")
                    ? Math.round(parseFloat(String(f.get("amount"))) * 100)
                    : undefined,
                  signerName: f.get("signerName") || undefined,
                }),
              )
              void act(async () => {
                unwrapAction(await manageSubtierWaiverAction(f))
                setClaimant(null)
              })
            }}
          >
            {operation === "edit" && (
              <>
                <label className="block text-xs">
                  Required amount
                  <Input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={(claimant?.amount_cents ?? 0) / 100}
                  />
                </label>
                <label className="block text-xs">
                  Required type
                  <select
                    name="waiverType"
                    className="h-9 w-full border bg-background"
                    required
                    defaultValue={
                      normalizeWaiverKind(claimant?.waiver_type ?? "") ?? ""
                    }
                  >
                    <option value="">Choose the explicit waiver type</option>
                    {WAIVER_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {WAIVER_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {operation === "record" && (
              <>
                <label className="block text-xs">
                  Signed PDF
                  <Input
                    name="file"
                    required
                    type="file"
                    accept="application/pdf"
                  />
                </label>
                <label className="block text-xs">
                  Signed by
                  <Input name="signerName" required />
                </label>
                <label className="block text-xs">
                  Signature date
                  <Input name="signedDate" required type="date" />
                </label>
                <label className="block text-xs">
                  Work through
                  <Input
                    name="throughDate"
                    required
                    type="date"
                    defaultValue={claimant?.period_end}
                  />
                </label>
                <label className="block text-xs">
                  Covered amount
                  <Input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={(claimant?.amount_cents ?? 0) / 100}
                  />
                </label>
              </>
            )}
            {["accept", "reject"].includes(operation) && (
              <label className="block text-xs">
                Review decision
                <select
                  className="h-9 w-full border bg-background"
                  onChange={(e) => setOperation(e.target.value)}
                >
                  <option value="accept">Accept coverage</option>
                  <option value="reject">Needs correction</option>
                </select>
              </label>
            )}
            <Textarea
              required
              aria-label="Reason or review notes"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Review notes or reason"
            />
            <Button disabled={busy} type="submit">
              {busy ? "Saving…" : "Save"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
