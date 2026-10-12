"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition, type ReactNode } from "react"
import { Plus } from "@/components/icons"
import { toast } from "sonner"

import {
  closeOutLandContractAction,
  createLandContractAction,
  executeLandContractAction,
  recordLandContractAmendmentAction,
  recordLandContractDepositPaymentAction,
  recordLandContractExtensionAction,
  recordLandContractFeePaymentAction,
  removeLandContractDepositAction,
  scheduleLandContractDepositAction,
  searchLandSellersAction,
  settleLandContractDepositAction,
  updateLandContractAction,
} from "@/app/(app)/communities/[id]/land/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import type { LotTakedownDTO } from "@/lib/services/communities"
import { uploadDocumentFileDirect } from "@/lib/services/files-client"
import type { LandAmendmentDTO, LandContractDTO, LandDepositDTO } from "@/lib/services/land-contracts"
import { cn } from "@/lib/utils"
import {
  LAND_AMENDMENT_KIND_LABELS,
  LAND_CONTRACT_STATUS_LABELS,
  LAND_DEPOSIT_REFUNDABILITY_LABELS,
  LAND_DEPOSIT_STATUS_LABELS,
  MIN_LAND_AMENDMENT_REASON_LENGTH,
} from "@/lib/validation/land-contracts"

function money(cents: number | null) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** Color reports state: what moved money, what is late, what is lost. */
const CONTRACT_TONE: Record<LandContractDTO["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  executed: "border-primary/30 bg-primary/10 text-primary",
  completed: "border-success/30 bg-success/10 text-success",
  terminated: "border-destructive/30 bg-destructive/10 text-destructive",
}
const DEPOSIT_TONE: Record<LandDepositDTO["status"], string> = {
  scheduled: "border-border bg-muted text-muted-foreground",
  paid: "border-success/30 bg-success/10 text-success",
  applied: "border-primary/30 bg-primary/10 text-primary",
  refunded: "border-border bg-secondary text-secondary-foreground",
  forfeited: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-border bg-muted text-muted-foreground",
}

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", tone)}>
      {children}
    </Badge>
  )
}

/** Deposits and takedown cash the contract still calls for, and what is at risk if the deal dies. */
function contractPosition(contract: LandContractDTO, takedowns: LotTakedownDTO[]) {
  const scheduled = contract.deposits.filter((deposit) => deposit.status === "scheduled")
  const paidCents = contract.deposits.filter((deposit) => deposit.status === "paid" || deposit.status === "applied").reduce((sum, deposit) => sum + deposit.amountCents, 0)
  const atRiskCents = contract.deposits
    .filter((deposit) => deposit.status === "paid" && (deposit.refundability === "non_refundable" || (deposit.refundability === "refundable_until" && (deposit.refundableUntil ?? "") < today())))
    .reduce((sum, deposit) => sum + deposit.amountCents, 0)
  const under = takedowns.filter((takedown) => takedown.landContractId === contract.id && takedown.status !== "cancelled")
  const nextDue = [
    ...scheduled.map((deposit) => deposit.dueOn),
    ...under.filter((takedown) => takedown.status === "scheduled" && takedown.scheduledDate).map((takedown) => takedown.scheduledDate as string),
    ...contract.amendments.filter((amendment) => amendment.feeCents > 0 && amendment.dueOn && !amendment.feePaidOn).map((amendment) => amendment.dueOn as string),
  ].sort()[0] ?? null
  return {
    scheduledCents: scheduled.reduce((sum, deposit) => sum + deposit.amountCents, 0),
    paidCents,
    atRiskCents,
    lotsUnder: under.reduce((sum, takedown) => sum + takedown.lotCount, 0),
    takedowns: under,
    nextDue,
  }
}

export function LandContracts({
  communityId,
  contracts,
  takedowns,
  canWrite,
}: {
  communityId: string
  contracts: LandContractDTO[]
  takedowns: LotTakedownDTO[]
  /** Holds land_contract.write. */
  canWrite: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const open = contracts.find((contract) => contract.id === openId) ?? null

  return (
    <section id="land-contracts" className="scroll-mt-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="microlabel">Land contracts</h2>
          <p className="text-xs text-muted-foreground">Signed terms, deposit schedules, extensions and penalties behind the takedowns.</p>
        </div>
        {canWrite ? (
          <Button variant="outline" size="sm" className="rounded-none" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" />Contract
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow className="microlabel">
              <TableHead>Contract</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lots</TableHead>
              <TableHead className="text-right">Deposits paid</TableHead>
              <TableHead className="text-right">Deposits due</TableHead>
              <TableHead className="text-right">At risk</TableHead>
              <TableHead>Next due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contracts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-xs text-muted-foreground">
                  No land contracts yet. Record the agreement a tranche is bought under to track its deposits and signed terms.
                </TableCell>
              </TableRow>
            ) : contracts.map((contract) => {
              const position = contractPosition(contract, takedowns)
              const late = position.nextDue != null && position.nextDue < today()
              return (
                <TableRow
                  key={contract.id}
                  className="cursor-pointer text-xs transition-colors hover:bg-muted/50"
                  onClick={() => setOpenId(contract.id)}
                >
                  <TableCell className="font-medium">
                    {contract.title}
                    <span className="block font-normal text-muted-foreground">
                      {[contract.contractNumber, contract.kind === "option" ? "Option" : "Purchase"].filter(Boolean).join(" · ")}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{contract.sellerName ?? "—"}</TableCell>
                  <TableCell><Chip tone={CONTRACT_TONE[contract.status]}>{LAND_CONTRACT_STATUS_LABELS[contract.status]}</Chip></TableCell>
                  <TableCell className="text-right tabular-nums">{position.lotsUnder} / {contract.totalLots}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(position.paidCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(position.scheduledCents)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", position.atRiskCents > 0 && "text-warning")}>{money(position.atRiskCents)}</TableCell>
                  <TableCell className={cn("tabular-nums", late ? "text-destructive" : "text-muted-foreground")}>{position.nextDue ?? "—"}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <ContractFormDialog communityId={communityId} open={creating} onOpenChange={setCreating} contract={null} />
      <ContractSheet
        communityId={communityId}
        contract={open}
        takedowns={takedowns}
        canWrite={canWrite}
        onOpenChange={(next) => { if (!next) setOpenId(null) }}
      />
    </section>
  )
}

function useLandMutation() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  function mutate(label: string, work: () => Promise<unknown>, done?: () => void) {
    startTransition(async () => {
      try {
        await work()
        toast.success(label)
        done?.()
        router.refresh()
      } catch (error) {
        toast.error("Unable to save", { description: (error as Error).message })
      }
    })
  }
  return { isPending, mutate }
}

async function uploadEvidence(file: File, folder: string) {
  const uploaded = await uploadDocumentFileDirect(file, { category: "contracts", folderPath: `/Land/${folder}`, visibility: "private" })
  return uploaded.id
}

function cents(value: string, label: string) {
  const parsed = parseMoneyToCents(value)
  if (parsed === null) throw new Error(`Enter ${label} as an amount`)
  return parsed
}

function ContractFormDialog({
  communityId,
  contract,
  open,
  onOpenChange,
}: {
  communityId: string
  contract: LandContractDTO | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { isPending, mutate } = useLandMutation()
  const [seller, setSeller] = useState<SearchPickerItem | null>(
    contract?.sellerCompanyId ? { id: contract.sellerCompanyId, name: contract.sellerName ?? "Seller", detail: "" } : null,
  )
  const [kind, setKind] = useState<LandContractDTO["kind"]>(contract?.kind ?? "purchase")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{contract ? "Edit contract terms" : "New land contract"}</DialogTitle>
          <DialogDescription>Terms can change until the contract is executed against its signed copy.</DialogDescription>
        </DialogHeader>
        <form
          id="land-contract-form"
          className="grid grid-cols-2 gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const price = String(data.get("price") ?? "").trim()
            mutate(contract ? "Contract saved" : "Contract created", async () => {
              const payload = {
                title: String(data.get("title") ?? ""),
                contractNumber: String(data.get("number") ?? "") || null,
                kind,
                sellerCompanyId: seller?.id ?? null,
                totalLots: Number(data.get("lots") ?? 0),
                basePricePerLotCents: price ? cents(price, "the price per lot") : null,
                extensionTerms: String(data.get("extensionTerms") ?? "") || null,
                penaltyTerms: String(data.get("penaltyTerms") ?? "") || null,
              }
              if (contract) unwrapAction(await updateLandContractAction(communityId, contract.id, payload))
              else unwrapAction(await createLandContractAction(communityId, payload))
            }, () => onOpenChange(false))
          }}
        >
          <div className="col-span-2 grid gap-1.5"><Label htmlFor="contract-title">Title</Label><Input id="contract-title" name="title" required defaultValue={contract?.title} placeholder="Phase 1 lot purchase" /></div>
          <div className="grid gap-1.5"><Label htmlFor="contract-number">Contract number</Label><Input id="contract-number" name="number" defaultValue={contract?.contractNumber ?? ""} /></div>
          <div className="grid gap-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(value) => setKind(value === "option" ? "option" : "purchase")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="purchase">Purchase</SelectItem>
                <SelectItem value="option">Option</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2"><SearchPicker label="Seller" noun="sellers" value={seller} onChange={setSeller} search={searchLandSellersAction} /></div>
          <div className="grid gap-1.5"><Label htmlFor="contract-lots">Total lots</Label><Input id="contract-lots" name="lots" type="number" min={0} defaultValue={contract?.totalLots ?? 0} /></div>
          <div className="grid gap-1.5"><Label htmlFor="contract-price">Base price per lot</Label><Input id="contract-price" name="price" inputMode="decimal" defaultValue={contract?.basePricePerLotCents != null ? String(contract.basePricePerLotCents / 100) : ""} /></div>
          <div className="col-span-2 grid gap-1.5"><Label htmlFor="contract-extension-terms">Extension terms</Label><Textarea id="contract-extension-terms" name="extensionTerms" rows={2} defaultValue={contract?.extensionTerms ?? ""} /></div>
          <div className="col-span-2 grid gap-1.5"><Label htmlFor="contract-penalty-terms">Penalty terms</Label><Textarea id="contract-penalty-terms" name="penaltyTerms" rows={2} defaultValue={contract?.penaltyTerms ?? ""} /></div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button form="land-contract-form" type="submit" disabled={isPending}>{isPending ? "Saving…" : contract ? "Save terms" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type SheetAction =
  | { kind: "edit" }
  | { kind: "execute" }
  | { kind: "deposit" }
  | { kind: "pay"; deposit: LandDepositDTO }
  | { kind: "payFee"; amendment: LandAmendmentDTO }
  | { kind: "extend" }
  | { kind: "amend" }

function ContractSheet({
  communityId,
  contract,
  takedowns,
  canWrite,
  onOpenChange,
}: {
  communityId: string
  contract: LandContractDTO | null
  takedowns: LotTakedownDTO[]
  canWrite: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { isPending, mutate } = useLandMutation()
  const [action, setAction] = useState<SheetAction | null>(null)
  const takedownName = useMemo(() => new Map(takedowns.map((takedown) => [takedown.id, takedown.name])), [takedowns])
  if (!contract) return <Sheet open={false} onOpenChange={onOpenChange} />
  const position = contractPosition(contract, takedowns)
  const draft = contract.status === "draft"
  const executed = contract.status === "executed"

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto rounded-none sm:max-w-2xl">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-2">
            <SheetTitle>{contract.title}</SheetTitle>
            <Chip tone={CONTRACT_TONE[contract.status]}>{LAND_CONTRACT_STATUS_LABELS[contract.status]}</Chip>
          </div>
          <SheetDescription>
            {[contract.sellerName, contract.contractNumber, contract.kind === "option" ? "Option" : "Purchase"].filter(Boolean).join(" · ")}
          </SheetDescription>
          {canWrite ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {draft ? (
                <>
                  <Button size="sm" variant="outline" className="rounded-none" onClick={() => setAction({ kind: "edit" })}>Edit terms</Button>
                  <Button size="sm" variant="outline" className="rounded-none" onClick={() => setAction({ kind: "deposit" })}>Schedule deposit</Button>
                  <Button size="sm" className="rounded-none" onClick={() => setAction({ kind: "execute" })}>Execute</Button>
                </>
              ) : null}
              {executed ? (
                <>
                  <Button size="sm" variant="outline" className="rounded-none" disabled={position.takedowns.every((takedown) => takedown.status !== "scheduled")} onClick={() => setAction({ kind: "extend" })}>Record extension</Button>
                  <Button size="sm" variant="outline" className="rounded-none" onClick={() => setAction({ kind: "amend" })}>Record penalty or amendment</Button>
                  <Button size="sm" variant="ghost" className="rounded-none" disabled={isPending} onClick={() => mutate("Contract completed", async () => unwrapAction(await closeOutLandContractAction(communityId, contract.id, { status: "completed" })))}>Mark completed</Button>
                  <Button size="sm" variant="ghost" className="rounded-none text-destructive" disabled={isPending} onClick={() => mutate("Contract terminated", async () => unwrapAction(await closeOutLandContractAction(communityId, contract.id, { status: "terminated" })))}>Terminate</Button>
                </>
              ) : null}
            </div>
          ) : null}
        </SheetHeader>

        <div className="space-y-6 px-4 pb-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            <div><dt className="text-muted-foreground">Lots</dt><dd className="tabular-nums">{position.lotsUnder} / {contract.totalLots}</dd></div>
            <div><dt className="text-muted-foreground">Base price / lot</dt><dd className="tabular-nums">{money(contract.basePricePerLotCents)}</dd></div>
            <div><dt className="text-muted-foreground">Deposits paid</dt><dd className="tabular-nums">{money(position.paidCents)}</dd></div>
            <div><dt className="text-muted-foreground">Non-refundable at risk</dt><dd className={cn("tabular-nums", position.atRiskCents > 0 && "text-warning")}>{money(position.atRiskCents)}</dd></div>
            <div className="col-span-2">
              <dt className="text-muted-foreground">Executed</dt>
              <dd>
                {contract.executedOn ? (
                  <>
                    <span className="tabular-nums">{contract.executedOn}</span>
                    {contract.executedFileId ? (
                      <a className="ml-2 underline underline-offset-2" href={`/api/files/${contract.executedFileId}/raw`} target="_blank" rel="noreferrer">Signed contract</a>
                    ) : null}
                  </>
                ) : "Not yet — terms are a draft"}
              </dd>
            </div>
          </dl>
          {contract.extensionTerms || contract.penaltyTerms ? (
            <div className="grid gap-3 text-xs sm:grid-cols-2">
              {contract.extensionTerms ? <div><p className="microlabel mb-1">Extension terms</p><p className="whitespace-pre-wrap text-muted-foreground">{contract.extensionTerms}</p></div> : null}
              {contract.penaltyTerms ? <div><p className="microlabel mb-1">Penalty terms</p><p className="whitespace-pre-wrap text-muted-foreground">{contract.penaltyTerms}</p></div> : null}
            </div>
          ) : null}

          <div>
            <p className="microlabel mb-2">Deposit schedule</p>
            <div className="overflow-x-auto border">
              <Table>
                <TableHeader>
                  <TableRow className="microlabel">
                    <TableHead>Due</TableHead>
                    <TableHead>Deposit</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Refundability</TableHead>
                    <TableHead>Status</TableHead>
                    {canWrite ? <TableHead className="w-10" /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contract.deposits.length === 0 ? (
                    <TableRow><TableCell colSpan={canWrite ? 6 : 5} className="py-6 text-center text-xs text-muted-foreground">No deposits scheduled.</TableCell></TableRow>
                  ) : contract.deposits.map((deposit) => {
                    const late = deposit.status === "scheduled" && deposit.dueOn < today()
                    return (
                      <TableRow key={deposit.id} className="text-xs">
                        <TableCell className={cn("tabular-nums", late && "text-destructive")}>{deposit.dueOn}</TableCell>
                        <TableCell>
                          {deposit.label ?? "Deposit"}
                          {deposit.takedownId ? <span className="block text-muted-foreground">Credited to {takedownName.get(deposit.takedownId) ?? "takedown"}</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(deposit.amountCents)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {LAND_DEPOSIT_REFUNDABILITY_LABELS[deposit.refundability]}
                          {deposit.refundableUntil ? <span className="tabular-nums"> {deposit.refundableUntil}</span> : null}
                        </TableCell>
                        <TableCell>
                          <Chip tone={DEPOSIT_TONE[deposit.status]}>{LAND_DEPOSIT_STATUS_LABELS[deposit.status]}</Chip>
                          {deposit.paidOn ? (
                            <span className="block text-muted-foreground tabular-nums">
                              {deposit.paidOn}
                              {deposit.evidenceFileId ? <a className="ml-1 underline underline-offset-2" href={`/api/files/${deposit.evidenceFileId}/raw`} target="_blank" rel="noreferrer">receipt</a> : null}
                            </span>
                          ) : null}
                        </TableCell>
                        {canWrite ? (
                          <TableCell className="whitespace-nowrap text-right">
                            {deposit.status === "scheduled" && !draft ? <Button size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setAction({ kind: "pay", deposit })}>Record payment</Button> : null}
                            {deposit.status === "scheduled" && draft ? <Button size="sm" variant="ghost" className="h-7 rounded-none" disabled={isPending} onClick={() => mutate("Deposit removed", async () => unwrapAction(await removeLandContractDepositAction(communityId, deposit.id)))}>Remove</Button> : null}
                            {deposit.status === "paid" ? (
                              <>
                                {deposit.refundability !== "non_refundable" ? <Button size="sm" variant="ghost" className="h-7 rounded-none" disabled={isPending} onClick={() => mutate("Refund recorded", async () => unwrapAction(await settleLandContractDepositAction(communityId, deposit.id, { outcome: "refunded" })))}>Refunded</Button> : null}
                                <Button size="sm" variant="ghost" className="h-7 rounded-none text-destructive" disabled={isPending} onClick={() => mutate("Forfeit recorded", async () => unwrapAction(await settleLandContractDepositAction(communityId, deposit.id, { outcome: "forfeited" })))}>Forfeited</Button>
                              </>
                            ) : null}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          <div>
            <p className="microlabel mb-2">Takedowns under this contract</p>
            {position.takedowns.length === 0 ? (
              <p className="text-xs text-muted-foreground">No takedowns yet. Add or edit a takedown on the Land tab and choose this contract while it is a draft.</p>
            ) : (
              <div className="overflow-x-auto border">
                <Table>
                  <TableBody>
                    {position.takedowns.map((takedown) => (
                      <TableRow key={takedown.id} className="text-xs">
                        <TableCell className="font-medium">{takedown.name}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{takedown.scheduledDate ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{takedown.lotCount} lots</TableCell>
                        <TableCell className="text-right tabular-nums">{money(takedown.pricePerLotCents)} / lot</TableCell>
                        <TableCell className="uppercase text-[10px] tracking-wide text-muted-foreground">{takedown.status}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div>
            <p className="microlabel mb-2">Amendments</p>
            {contract.amendments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No extensions, penalties or amendments recorded.</p>
            ) : (
              <ul className="divide-y border text-xs">
                {contract.amendments.map((amendment) => (
                  <li key={amendment.id} className="grid gap-1 p-3">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <span className="font-medium">{LAND_AMENDMENT_KIND_LABELS[amendment.kind]}</span>
                      {amendment.takedownId ? <span className="text-muted-foreground">{takedownName.get(amendment.takedownId) ?? "Takedown"}</span> : null}
                      {amendment.fromDate && amendment.toDate ? <span className="tabular-nums">{amendment.fromDate} → {amendment.toDate}</span> : null}
                      {amendment.feeCents > 0 && amendment.feePaidOn ? (
                        <span className="tabular-nums text-success">
                          {money(amendment.feeCents)} paid {amendment.feePaidOn}
                          {amendment.feeEvidenceFileId ? <a className="ml-1 underline underline-offset-2" href={`/api/files/${amendment.feeEvidenceFileId}/raw`} target="_blank" rel="noreferrer">receipt</a> : null}
                        </span>
                      ) : null}
                      {amendment.feeCents > 0 && !amendment.feePaidOn ? (
                        <span className={cn("tabular-nums", (amendment.dueOn ?? "") < today() ? "text-destructive" : "text-warning")}>{money(amendment.feeCents)} due {amendment.dueOn}</span>
                      ) : null}
                      <span className="ml-auto tabular-nums text-muted-foreground">{amendment.recordedAt.slice(0, 10)}</span>
                      {canWrite && amendment.feeCents > 0 && !amendment.feePaidOn ? <Button size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setAction({ kind: "payFee", amendment })}>Record payment</Button> : null}
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">{amendment.reason}</p>
                    <a className="w-fit underline underline-offset-2" href={`/api/files/${amendment.evidenceFileId}/raw`} target="_blank" rel="noreferrer">Signed evidence</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>

      <ContractFormDialog key={`edit-${contract.id}`} communityId={communityId} contract={contract} open={action?.kind === "edit"} onOpenChange={(next) => { if (!next) setAction(null) }} />
      <ExecuteDialog communityId={communityId} contract={contract} open={action?.kind === "execute"} onClose={() => setAction(null)} />
      <DepositDialog communityId={communityId} contract={contract} takedowns={position.takedowns} open={action?.kind === "deposit"} onClose={() => setAction(null)} />
      <PaymentDialog communityId={communityId} deposit={action?.kind === "pay" ? action.deposit : null} onClose={() => setAction(null)} />
      <FeePaymentDialog communityId={communityId} amendment={action?.kind === "payFee" ? action.amendment : null} onClose={() => setAction(null)} />
      <ExtensionDialog communityId={communityId} takedowns={position.takedowns.filter((takedown) => takedown.status === "scheduled")} open={action?.kind === "extend"} onClose={() => setAction(null)} />
      <AmendmentDialog communityId={communityId} contract={contract} takedowns={position.takedowns} open={action?.kind === "amend"} onClose={() => setAction(null)} />
    </Sheet>
  )
}

function EvidenceInput({ id, label, onFile }: { id: string; label: string; onFile: (file: File | null) => void }) {
  return (
    <div className="col-span-2 grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="file" accept="application/pdf,image/*" required onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
    </div>
  )
}

function FormDialog({
  open,
  onClose,
  title,
  description,
  formId,
  submitLabel,
  isPending,
  onSubmit,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  formId: string
  submitLabel: string
  isPending: boolean
  onSubmit: (data: FormData) => void
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !isPending) onClose() }}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          className="grid grid-cols-2 gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(new FormData(event.currentTarget))
          }}
        >
          {children}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={onClose}>Cancel</Button>
          <Button form={formId} type="submit" disabled={isPending}>{isPending ? "Saving…" : submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ExecuteDialog({ communityId, contract, open, onClose }: { communityId: string; contract: LandContractDTO; open: boolean; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [file, setFile] = useState<File | null>(null)
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Execute contract"
      description="Attach the signed contract. Its terms, deposit schedule and takedown lot counts and prices are then fixed; later changes are recorded as amendments."
      formId="land-contract-execute"
      submitLabel="Execute"
      isPending={isPending}
      onSubmit={(data) => mutate("Contract executed", async () => {
        if (!file) throw new Error("Attach the signed contract")
        const executedFileId = await uploadEvidence(file, "Contracts")
        unwrapAction(await executeLandContractAction(communityId, contract.id, { executedOn: String(data.get("executedOn") ?? ""), executedFileId }))
      }, onClose)}
    >
      <div className="col-span-2 grid gap-1.5"><Label htmlFor="execute-date">Executed on</Label><Input id="execute-date" name="executedOn" type="date" required defaultValue={today()} /></div>
      <EvidenceInput id="execute-file" label="Signed contract" onFile={setFile} />
    </FormDialog>
  )
}

function DepositDialog({ communityId, contract, takedowns, open, onClose }: { communityId: string; contract: LandContractDTO; takedowns: LotTakedownDTO[]; open: boolean; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [refundability, setRefundability] = useState<LandDepositDTO["refundability"]>("refundable")
  const [takedownId, setTakedownId] = useState("none")
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Schedule deposit"
      description="A deposit tied to a takedown is credited against its price at closing."
      formId="land-deposit-form"
      submitLabel="Schedule"
      isPending={isPending}
      onSubmit={(data) => mutate("Deposit scheduled", async () => {
        unwrapAction(await scheduleLandContractDepositAction(communityId, contract.id, {
          label: String(data.get("label") ?? "") || null,
          takedownId: takedownId === "none" ? null : takedownId,
          dueOn: String(data.get("dueOn") ?? ""),
          amountCents: cents(String(data.get("amount") ?? ""), "the deposit"),
          refundability,
          refundableUntil: refundability === "refundable_until" ? String(data.get("refundableUntil") ?? "") : null,
        }))
      }, onClose)}
    >
      <div className="col-span-2 grid gap-1.5"><Label htmlFor="deposit-label">Label</Label><Input id="deposit-label" name="label" placeholder="Initial earnest money" /></div>
      <div className="grid gap-1.5"><Label htmlFor="deposit-amount">Amount</Label><Input id="deposit-amount" name="amount" inputMode="decimal" required /></div>
      <div className="grid gap-1.5"><Label htmlFor="deposit-due">Due</Label><Input id="deposit-due" name="dueOn" type="date" required /></div>
      <div className="grid gap-1.5">
        <Label>Refundability</Label>
        <Select value={refundability} onValueChange={(value) => setRefundability(value === "non_refundable" || value === "refundable_until" ? value : "refundable")}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(LAND_DEPOSIT_REFUNDABILITY_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {refundability === "refundable_until" ? (
        <div className="grid gap-1.5"><Label htmlFor="deposit-refundable-until">Refundable until</Label><Input id="deposit-refundable-until" name="refundableUntil" type="date" required /></div>
      ) : <div />}
      <div className="col-span-2 grid gap-1.5">
        <Label>Credited against</Label>
        <Select value={takedownId} onValueChange={setTakedownId}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No takedown</SelectItem>
            {takedowns.map((takedown) => <SelectItem key={takedown.id} value={takedown.id}>{takedown.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </FormDialog>
  )
}

function PaymentDialog({ communityId, deposit, onClose }: { communityId: string; deposit: LandDepositDTO | null; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [file, setFile] = useState<File | null>(null)
  return (
    <FormDialog
      open={Boolean(deposit)}
      onClose={onClose}
      title="Record deposit payment"
      description={deposit ? `${money(deposit.amountCents)} due ${deposit.dueOn}. Attach the wire confirmation or receipt.` : ""}
      formId="land-deposit-payment"
      submitLabel="Record payment"
      isPending={isPending}
      onSubmit={(data) => mutate("Payment recorded", async () => {
        if (!deposit) return
        if (!file) throw new Error("Attach the payment receipt")
        const evidenceFileId = await uploadEvidence(file, "Deposits")
        unwrapAction(await recordLandContractDepositPaymentAction(communityId, deposit.id, {
          paidOn: String(data.get("paidOn") ?? ""),
          paymentReference: String(data.get("reference") ?? "") || null,
          evidenceFileId,
        }))
      }, onClose)}
    >
      <div className="grid gap-1.5"><Label htmlFor="payment-date">Paid on</Label><Input id="payment-date" name="paidOn" type="date" required defaultValue={today()} /></div>
      <div className="grid gap-1.5"><Label htmlFor="payment-reference">Reference</Label><Input id="payment-reference" name="reference" placeholder="Wire #" /></div>
      <EvidenceInput id="payment-receipt" label="Receipt" onFile={setFile} />
    </FormDialog>
  )
}

function FeePaymentDialog({ communityId, amendment, onClose }: { communityId: string; amendment: LandAmendmentDTO | null; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [file, setFile] = useState<File | null>(null)
  return (
    <FormDialog
      open={Boolean(amendment)}
      onClose={onClose}
      title="Record fee payment"
      description={amendment ? `${money(amendment.feeCents)} ${LAND_AMENDMENT_KIND_LABELS[amendment.kind].toLowerCase()} fee due ${amendment.dueOn}. Attach the wire confirmation or receipt.` : ""}
      formId="land-fee-payment"
      submitLabel="Record payment"
      isPending={isPending}
      onSubmit={(data) => mutate("Payment recorded", async () => {
        if (!amendment) return
        if (!file) throw new Error("Attach the payment receipt")
        const evidenceFileId = await uploadEvidence(file, "Amendments")
        unwrapAction(await recordLandContractFeePaymentAction(communityId, amendment.id, { paidOn: String(data.get("paidOn") ?? ""), evidenceFileId }))
      }, onClose)}
    >
      <div className="grid gap-1.5"><Label htmlFor="fee-payment-date">Paid on</Label><Input id="fee-payment-date" name="paidOn" type="date" required defaultValue={today()} /></div>
      <div />
      <EvidenceInput id="fee-payment-receipt" label="Receipt" onFile={setFile} />
    </FormDialog>
  )
}

function ExtensionDialog({ communityId, takedowns, open, onClose }: { communityId: string; takedowns: LotTakedownDTO[]; open: boolean; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [file, setFile] = useState<File | null>(null)
  const [takedownId, setTakedownId] = useState("")
  const selected = takedowns.find((takedown) => takedown.id === takedownId)
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Record extension"
      description="Moves a takedown's close date under the signed extension. The extension and the new date are recorded together and never edited."
      formId="land-extension"
      submitLabel="Record extension"
      isPending={isPending}
      onSubmit={(data) => mutate("Extension recorded", async () => {
        if (!file) throw new Error("Attach the signed extension")
        const fee = String(data.get("fee") ?? "").trim()
        const evidenceFileId = await uploadEvidence(file, "Amendments")
        unwrapAction(await recordLandContractExtensionAction(communityId, {
          takedownId,
          toDate: String(data.get("toDate") ?? ""),
          feeCents: fee ? cents(fee, "the extension fee") : 0,
          feeDueOn: String(data.get("feeDueOn") ?? "") || null,
          reason: String(data.get("reason") ?? ""),
          evidenceFileId,
        }))
      }, onClose)}
    >
      <div className="col-span-2 grid gap-1.5">
        <Label>Takedown</Label>
        <Select value={takedownId} onValueChange={setTakedownId}>
          <SelectTrigger><SelectValue placeholder="Choose a takedown" /></SelectTrigger>
          <SelectContent>
            {takedowns.map((takedown) => <SelectItem key={takedown.id} value={takedown.id}>{takedown.name} · {takedown.scheduledDate ?? "no date"}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5"><Label htmlFor="extension-to">New close date</Label><Input id="extension-to" name="toDate" type="date" required min={selected?.scheduledDate ?? undefined} /></div>
      <div className="grid gap-1.5"><Label htmlFor="extension-fee">Extension fee</Label><Input id="extension-fee" name="fee" inputMode="decimal" placeholder="0" /></div>
      <div className="col-span-2 grid gap-1.5"><Label htmlFor="extension-fee-due">Fee due</Label><Input id="extension-fee-due" name="feeDueOn" type="date" /></div>
      <div className="col-span-2 grid gap-1.5"><Label htmlFor="extension-reason">Reason</Label><Textarea id="extension-reason" name="reason" rows={2} required minLength={MIN_LAND_AMENDMENT_REASON_LENGTH} /></div>
      <EvidenceInput id="extension-file" label="Signed extension" onFile={setFile} />
    </FormDialog>
  )
}

function AmendmentDialog({ communityId, contract, takedowns, open, onClose }: { communityId: string; contract: LandContractDTO; takedowns: LotTakedownDTO[]; open: boolean; onClose: () => void }) {
  const { isPending, mutate } = useLandMutation()
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<"penalty" | "other">("penalty")
  const [takedownId, setTakedownId] = useState("none")
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Record penalty or amendment"
      description="Recorded against the executed contract with its signed evidence. Amendments are never edited."
      formId="land-amendment"
      submitLabel="Record"
      isPending={isPending}
      onSubmit={(data) => mutate("Amendment recorded", async () => {
        if (!file) throw new Error("Attach the signed amendment")
        const fee = String(data.get("fee") ?? "").trim()
        const evidenceFileId = await uploadEvidence(file, "Amendments")
        unwrapAction(await recordLandContractAmendmentAction(communityId, contract.id, {
          kind,
          takedownId: takedownId === "none" ? null : takedownId,
          feeCents: fee ? cents(fee, "the amount") : 0,
          dueOn: String(data.get("dueOn") ?? "") || null,
          reason: String(data.get("reason") ?? ""),
          evidenceFileId,
        }))
      }, onClose)}
    >
      <div className="grid gap-1.5">
        <Label>Kind</Label>
        <Select value={kind} onValueChange={(value) => setKind(value === "other" ? "other" : "penalty")}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="penalty">Penalty</SelectItem>
            <SelectItem value="other">Other amendment</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label>Takedown</Label>
        <Select value={takedownId} onValueChange={setTakedownId}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Whole contract</SelectItem>
            {takedowns.map((takedown) => <SelectItem key={takedown.id} value={takedown.id}>{takedown.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5"><Label htmlFor="amendment-fee">Amount owed</Label><Input id="amendment-fee" name="fee" inputMode="decimal" placeholder="0" /></div>
      <div className="grid gap-1.5"><Label htmlFor="amendment-due">Due</Label><Input id="amendment-due" name="dueOn" type="date" /></div>
      <div className="col-span-2 grid gap-1.5"><Label htmlFor="amendment-reason">Reason</Label><Textarea id="amendment-reason" name="reason" rows={2} required minLength={MIN_LAND_AMENDMENT_REASON_LENGTH} /></div>
      <EvidenceInput id="amendment-file" label="Signed evidence" onFile={setFile} />
    </FormDialog>
  )
}
