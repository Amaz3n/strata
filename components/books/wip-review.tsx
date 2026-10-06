"use client"
import { WipRevenueAllocation } from "@/components/books/wip-revenue-allocation"
import { expectedContractLoss } from "@/lib/financials/expected-loss"
import { hasInvalidWipInputs } from "@/lib/financials/wip-validation"
import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { loadWipReviewAction, saveWipReviewAction, prepareWipSnapshotAction, carryForwardWipSnapshotAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

type Workspace = Awaited<ReturnType<typeof import("@/lib/services/books/wip-review").getWipReviewWorkspace>>
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
export function WipReview({ periodId }: { periodId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()
  const detailsById = new Map(workspace?.details.map(row => [row.id, row]) ?? [])
  const invalid = !workspace || !workspace.sourcesCurrent || workspace.missing.length > 0 || workspace.snapshots.length === 0 || workspace.snapshots.some(row => hasInvalidWipInputs(row.warnings))
  return <>
    <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => {
      const result = await loadWipReviewAction(periodId)
      if (!result.success) { toast.error(result.error); return }
      setWorkspace(result.data); setNote(""); setOpen(true)
    })}>Review period-end WIP</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>Review WIP through {workspace?.periodEnd}</DialogTitle><DialogDescription>Review estimates, contract changes, and costs for each job. Approval applies to these snapshots; new evidence requires another review.</DialogDescription></DialogHeader>
        {workspace && <WipPreparation periodId={periodId} workspace={workspace} onPrepared={async () => {
          const result = await loadWipReviewAction(periodId)
          if (!result.success) { toast.error(result.error); return }
          setWorkspace(result.data); setNote(""); router.refresh()
        }} />}
        {workspace && !workspace.sourcesCurrent && <p role="alert" className="text-sm text-destructive">Dated source evidence changed or has not been prepared. Prepare the affected period-end snapshots before approving.</p>}
        {workspace?.missing.length ? <p role="alert" className="text-sm text-destructive">{workspace.missing.length} projects need an exact period-end snapshot before approval. <Link className="underline" href="/reports/wip-over-under">Open WIP report</Link></p> : null}
        {workspace?.snapshots.map(snapshot => {
          const detail = detailsById.get(snapshot.snapshotId)
          const loss = detail && detail.eac_cents >= detail.cost_to_date_cents && detail.cost_to_date_cents >= 0 && detail.revised_contract_cents >= 0 && snapshot.earnedRevenueCents >= 0
            ? expectedContractLoss({ contractCents: detail.revised_contract_cents, eacCents: detail.eac_cents, costCents: detail.cost_to_date_cents, earnedCents: snapshot.earnedRevenueCents }) : null
          return <section key={snapshot.projectId} className="space-y-2 rounded-md border p-3">
            <Link className="font-medium underline" href={`/projects/${snapshot.projectId}/financials/budget`}>{workspace.projectNames[snapshot.projectId] ?? snapshot.projectId}</Link>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              {([["Contract value", detail?.revised_contract_cents], ["Cost to date", detail?.cost_to_date_cents], ["Estimate at completion", detail?.eac_cents], ["Earned revenue", snapshot.earnedRevenueCents], ["Billed", detail?.billed_cents], ["Forecast gross profit", detail?.forecast_gross_profit_cents]] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{typeof value === "number" ? money(value) : "Unavailable"}</dd></div>)}
            </dl>
            {loss && loss.totalExpectedLossCents > 0 && <p className="text-sm text-destructive">Expected contract loss: {money(loss.totalExpectedLossCents)}. Remaining provision after losses already incurred: {money(loss.reserveCents)}. The close posts the adjustment to this reserve.</p>}
            {detail?.preparationNote && <p className="whitespace-pre-wrap text-sm"><span className="font-medium">Preparation basis: </span>{detail.preparationNote}</p>}
            {detail && <WipRevenueAllocation key={snapshot.inputsHash} periodId={periodId} detail={detail} workspace={workspace} onSaved={async () => {
              const result = await loadWipReviewAction(periodId)
              if (!result.success) { toast.error(result.error); return }
              setWorkspace(result.data); setNote(""); router.refresh()
            }} />}
            {snapshot.warnings.length > 0 && <p className="text-sm text-warning">Review: {snapshot.warnings.map(warning => warning.replaceAll("_", " ")).join(", ")}</p>}
          </section>
        })}
        <div className="space-y-2"><Label htmlFor={`wip-note-${periodId}`}>Review explanation</Label><Textarea id={`wip-note-${periodId}`} value={note} onChange={event => setNote(event.target.value)} placeholder="Explain estimate changes, unusual costs, and how you resolved warnings." maxLength={4000} /></div>
        <Button disabled={pending || invalid || note.trim().length < 10} onClick={() => startTransition(async () => {
          if (!workspace) return
          const result = await saveWipReviewAction({ periodId, snapshots: workspace.snapshots, note })
          if (!result.success) { toast.error(result.error); return }
          toast.success("WIP review saved and close checklist refreshed"); setOpen(false); router.refresh()
        })}>{pending ? "Saving…" : "Approve these WIP snapshots"}</Button>
      </DialogContent>
    </Dialog>
  </>
}


function WipPreparation({ periodId, workspace, onPrepared }: { periodId: string; workspace: Workspace; onPrepared: () => Promise<void> }) {
  const [projectId, setProjectId] = useState("")
  const [original, setOriginal] = useState("")
  const [changes, setChanges] = useState("0")
  const [eac, setEac] = useState("")
  const [note, setNote] = useState("")
  const [pending, startTransition] = useTransition()
  const originalCents = parseMoneyToCents(original), changesCents = parseMoneyToCents(changes), eacCents = parseMoneyToCents(eac)
  return <details className="rounded-md border p-3">
    <summary className="cursor-pointer text-sm font-medium">Prepare or revise period-end WIP</summary>
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted-foreground">Costs and billings come from records dated through {workspace.periodEnd}. Enter the contract and estimate applicable to that date. Preparing a revision requires a new review.</p>
      <Label htmlFor={`wip-project-${periodId}`}>Project</Label>
      <select id={`wip-project-${periodId}`} className="w-full rounded-md border bg-background p-2" value={projectId} onChange={event => {
        const nextId = event.target.value; setProjectId(nextId)
        const prior = workspace.details.find(row => row.project_id === nextId)
        setOriginal(prior ? String(prior.original_contract_cents / 100) : "")
        setChanges(prior ? String(prior.approved_change_orders_cents / 100) : "0")
        setEac(prior ? String(prior.eac_cents / 100) : ""); setNote("")
      }}><option value="">Choose a project</option>{workspace.projectIds.map(id => <option key={id} value={id}>{workspace.projectNames[id] ?? id}</option>)}</select>
      <div className="grid gap-3 sm:grid-cols-3">{([["original", "Original contract ($)", original, setOriginal], ["changes", "Approved changes ($)", changes, setChanges], ["eac", "Estimate at completion ($)", eac, setEac]] as const).map(([key,label,value,setValue]) => <div className="space-y-1" key={key}><Label htmlFor={`wip-${key}-${periodId}`}>{label}</Label><Input id={`wip-${key}-${periodId}`} inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} /></div>)}</div>
      <Label htmlFor={`wip-basis-${periodId}`}>Basis for this period</Label><Textarea id={`wip-basis-${periodId}`} maxLength={4000} value={note} onChange={event => setNote(event.target.value)} placeholder="Explain and cite the contract, change orders, and completion estimate supporting these figures." />
      {workspace.completedProjectIds.includes(projectId) && <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm text-muted-foreground">For a completed job, you can confirm the last approved final contract and estimate are unchanged. This uses the approved figures from a closed period; changed cost or billing evidence blocks carryforward.</p>
        <Button variant="outline" disabled={pending || note.trim().length < 10 || note.trim().length > 3500} onClick={() => startTransition(async () => {
          const result = await carryForwardWipSnapshotAction({ periodId, projectId, note })
          if (!result.success) { toast.error(result.error); return }
          toast.success("Final estimate carried forward. Review the new period snapshot before approval."); await onPrepared()
        })}>{pending ? "Preparing…" : "Confirm unchanged and carry forward"}</Button>
      </div>}
      <Button variant="outline" disabled={pending || !projectId || originalCents == null || originalCents < 0 || changesCents == null || eacCents == null || eacCents <= 0 || note.trim().length < 10} onClick={() => startTransition(async () => {
        if (originalCents == null || changesCents == null || eacCents == null) return
        const result = await prepareWipSnapshotAction({ periodId, projectId, originalContractCents: originalCents, approvedChangeOrdersCents: changesCents, eacCents, note })
        if (!result.success) { toast.error(result.error); return }
        toast.success("Period-end WIP prepared. Review the updated figures before approval."); await onPrepared()
      })}>{pending ? "Preparing…" : "Prepare dated snapshot"}</Button>
    </div>
  </details>
}
