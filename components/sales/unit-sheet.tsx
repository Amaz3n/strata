"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { ExternalLink, Loader2, Lock } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  convertHoldToReservationAction,
  createLotHoldAction,
  getUnitSheetDataAction,
  releaseReservationAction,
  setLotAskingPriceAction,
} from "@/app/(app)/sales/actions"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { LotActivityEntry, SellableUnitDTO } from "@/lib/services/community-sales"
import { cn } from "@/lib/utils"

import { BuyerCombobox, type BuyerOption } from "./buyer-combobox"
import { AVAILABILITY_BADGE, AVAILABILITY_BANDS, formatCountdown, formatDay, money } from "./sales-format"

type Mode = "view" | "hold" | "reserve" | "release" | "price"

interface SheetData {
  unit: SellableUnitDTO
  activity: LotActivityEntry[]
  incentives: { id: string; name: string; appliesTo: string }[]
}

function humanEvent(type: string) {
  return type.replace(/^lot_|^purchase_agreement_/, "").replaceAll("_", " ")
}

export function UnitSheet({
  lotId,
  fallback,
  canManage,
  onClose,
  onWrite,
}: {
  lotId: string
  fallback: SellableUnitDTO | null
  canManage: boolean
  onClose: () => void
  onWrite: () => void
}) {
  const router = useRouter()
  const [data, setData] = useState<SheetData | null>(fallback ? { unit: fallback, activity: [], incentives: [] } : null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>("view")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    setLoading(true)
    getUnitSheetDataAction(lotId)
      .then((result) => {
        if (!active) return
        if (result.success && result.data) setData(result.data)
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [lotId])

  const unit = data?.unit ?? fallback
  const refresh = () => {
    router.refresh()
    getUnitSheetDataAction(lotId).then((result) => result.success && result.data && setData(result.data))
  }

  const act = (operation: () => Promise<ActionResult<unknown>>, message: string, onDone?: () => void) =>
    startTransition(async () => {
      try {
        unwrapAction(await operation())
        toast.success(message)
        setMode("view")
        onDone?.()
        refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Action failed")
      }
    })

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-xl" side="right">
        {!unit ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {loading ? <Loader2 className="size-5 animate-spin" /> : "This unit isn't in your scope."}
          </div>
        ) : (
          <>
            <SheetHeader className="flex-row items-start justify-between gap-4 space-y-0 border-b bg-muted/30 p-5">
              <div className="min-w-0">
                <SheetTitle className="text-base">{unit.communityName ?? "Community"} · Lot {unit.lotLabel}</SheetTitle>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[unit.planLabel ?? "Unassigned plan", unit.elevationLabel, unit.swing !== "either" ? `${unit.swing} swing` : null, unit.heatedSqft != null ? `${unit.heatedSqft.toLocaleString()} sf` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              <div className="text-right">
                <div className="font-mono text-2xl font-semibold tabular-nums">{unit.askingPriceCents > 0 ? money.format(unit.askingPriceCents / 100) : "—"}</div>
                <Badge variant="outline" className={cn("mt-1 rounded-none text-[10px] uppercase tracking-wide", AVAILABILITY_BADGE[unit.availability])}>
                  {AVAILABILITY_BANDS[unit.availability].label}
                </Badge>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {/* Mode panels */}
              {mode === "hold" ? (
                <HoldForm unit={unit} pending={pending} onCancel={() => setMode("view")} onSubmit={(payload) => act(() => createLotHoldAction(payload), `Lot ${unit.lotLabel} on hold`)} />
              ) : mode === "reserve" ? (
                <ReserveForm unit={unit} pending={pending} onCancel={() => setMode("view")} onSubmit={(payload) => act(() => convertHoldToReservationAction(payload), "Reservation created")} />
              ) : mode === "release" ? (
                <ReleaseForm unit={unit} pending={pending} onCancel={() => setMode("view")} onSubmit={(payload) => act(() => releaseReservationAction(payload), "Reservation released")} />
              ) : mode === "price" ? (
                <PriceForm unit={unit} pending={pending} onCancel={() => setMode("view")} onSubmit={(payload) => act(() => setLotAskingPriceAction(payload), "Asking price updated")} />
              ) : (
                <div className="space-y-6">
                  <Section label="Price">
                    <PriceRow label="Base price" value={unit.basePriceCents} muted={unit.basePriceCents === 0 ? "No community price set" : undefined} />
                    {unit.premiumCents > 0 ? <PriceRow label="Lot premium" value={unit.premiumCents} /> : null}
                    {unit.optionsCents > 0 ? <PriceRow label="Structural options" value={unit.optionsCents} /> : null}
                    <div className="mt-1 flex items-center justify-between border-t pt-2">
                      <span className="text-xs font-medium">Asking</span>
                      <span className="font-mono text-sm font-semibold tabular-nums">{money.format(unit.askingPriceCents / 100)}</span>
                    </div>
                    {unit.askingOverrideCents != null ? (
                      <p className="text-[11px] text-[var(--age-2)]">Overridden from list {money.format(unit.listPriceCents / 100)}</p>
                    ) : null}
                    {canManage && unit.availability !== "sold" && unit.availability !== "closed" ? (
                      <button type="button" onClick={() => setMode("price")} className="text-[11px] font-medium text-primary underline-offset-2 hover:underline">Change asking price</button>
                    ) : null}
                  </Section>

                  <Section label="Availability">
                    <Fact label="Status" value={AVAILABILITY_BANDS[unit.availability].label} />
                    <Fact label="Days on market" value={`${unit.agingDays}d`} tone={unit.agingDays >= 90 ? "warn" : undefined} />
                    {unit.reservationExpiresAt && unit.availability === "held" ? (
                      <Fact label="Hold expires" value={formatCountdown(unit.reservationExpiresAt)?.label ?? formatDay(unit.reservationExpiresAt)} tone={formatCountdown(unit.reservationExpiresAt)?.soon ? "warn" : undefined} />
                    ) : null}
                    {unit.buyerName ? <Fact label="Buyer" value={unit.buyerName} /> : null}
                    {unit.depositRequiredCents > 0 ? <Fact label="Earnest deposit" value={money.format(unit.depositRequiredCents / 100)} /> : null}
                  </Section>

                  <Section label="Home">
                    <Fact label="Plan" value={<span className="inline-flex items-center gap-1.5">{unit.planLabel ?? "Unassigned"}{unit.availability === "sold" ? <Lock className="size-3 text-muted-foreground" /> : null}</span>} />
                    {unit.elevationLabel ? <Fact label="Elevation" value={unit.elevationLabel} /> : null}
                    <Fact label="Projected close" value={unit.projectedCloseDate ? formatDay(unit.projectedCloseDate) : "—"} />
                    {unit.projectId ? (
                      <div className="flex flex-wrap gap-3 pt-1 text-xs">
                        <Link href={`/projects/${unit.projectId}`} className="inline-flex items-center gap-1 text-primary hover:underline">Open project <ExternalLink className="size-3" /></Link>
                        <Link href={`/projects/${unit.projectId}/drawings`} className="inline-flex items-center gap-1 text-primary hover:underline">Drawings</Link>
                        <Link href={`/projects/${unit.projectId}/selections`} className="inline-flex items-center gap-1 text-primary hover:underline">Selections</Link>
                      </div>
                    ) : null}
                  </Section>

                  {data && data.incentives.length > 0 ? (
                    <Section label="Active incentives">
                      <div className="flex flex-wrap gap-1.5">
                        {data.incentives.map((incentive) => (
                          <Badge key={incentive.id} variant="secondary" className="rounded-none text-[11px]">{incentive.name}</Badge>
                        ))}
                      </div>
                    </Section>
                  ) : null}

                  <Section label="Activity">
                    {loading && (!data || data.activity.length === 0) ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : data && data.activity.length > 0 ? (
                      <ul className="space-y-1.5">
                        {data.activity.map((entry) => (
                          <li key={entry.id} className="flex items-center justify-between gap-3 text-xs">
                            <span className="capitalize">{humanEvent(entry.eventType)}</span>
                            <span className="tabular-nums text-muted-foreground">{formatDay(entry.createdAt)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">No activity yet.</p>
                    )}
                  </Section>
                </div>
              )}
            </div>

            {mode === "view" && canManage ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t p-4">
                {unit.availability === "available" ? (
                  <>
                    <Button className="rounded-none" onClick={() => setMode("hold")}>Hold</Button>
                    <Button variant="outline" className="rounded-none" onClick={onWrite}>Write contract</Button>
                  </>
                ) : null}
                {unit.availability === "held" ? (
                  <>
                    <Button className="rounded-none" onClick={() => setMode("reserve")}>Convert to reservation</Button>
                    <Button variant="outline" className="rounded-none" onClick={() => setMode("release")}>Release</Button>
                  </>
                ) : null}
                {unit.availability === "reserved" ? (
                  <>
                    <Button className="rounded-none" onClick={onWrite}>Write contract</Button>
                    <Button variant="outline" className="rounded-none" onClick={() => setMode("release")}>Release</Button>
                  </>
                ) : null}
                {unit.availability === "sold" && unit.projectId ? (
                  <Button variant="outline" className="rounded-none" asChild><Link href={`/projects/${unit.projectId}/closing`}>Open closing</Link></Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="microlabel">{label}</p>
      {children}
    </section>
  )
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", tone === "warn" && "font-medium text-[var(--age-1)]")}>{value}</span>
    </div>
  )
}

function PriceRow({ label, value, muted }: { label: string; value: number; muted?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {muted ? <span className="text-muted-foreground">{muted}</span> : <span className="font-mono tabular-nums">{money.format(value / 100)}</span>}
    </div>
  )
}

const QUICK_EXPIRY = [
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
]

function HoldForm({ unit, pending, onCancel, onSubmit }: { unit: SellableUnitDTO; pending: boolean; onCancel: () => void; onSubmit: (payload: unknown) => void }) {
  const [buyer, setBuyer] = useState<BuyerOption | null>(null)
  const [coBuyer, setCoBuyer] = useState<BuyerOption | null>(null)
  const [hours, setHours] = useState(72)
  const [notes, setNotes] = useState("")
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString()
  return (
    <FormShell title={`Hold Lot ${unit.lotLabel}`} description="Holds expire automatically and return the lot to available.">
      <Field label="Buyer"><BuyerCombobox value={buyer?.id ?? null} selectedName={buyer?.name} onSelect={setBuyer} /></Field>
      <Field label="Co-buyer (optional)"><BuyerCombobox value={coBuyer?.id ?? null} selectedName={coBuyer?.name} onSelect={setCoBuyer} placeholder="Search co-buyer…" /></Field>
      <Field label="Hold for">
        <div className="flex items-center gap-1">
          {QUICK_EXPIRY.map((option) => (
            <button key={option.hours} type="button" onClick={() => setHours(option.hours)} className={cn("border px-2.5 py-1 text-xs", hours === option.hours ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>{option.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Notes"><Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} className="rounded-none" /></Field>
      <FormActions
        pending={pending}
        disabled={!buyer}
        submitLabel="Hold lot"
        onCancel={onCancel}
        onSubmit={() => onSubmit({ lotId: unit.lotId, buyerContactId: buyer!.id, coBuyerContactId: coBuyer?.id ?? null, expiresAt, notes: notes.trim() || null })}
      />
    </FormShell>
  )
}

function ReserveForm({ unit, pending, onCancel, onSubmit }: { unit: SellableUnitDTO; pending: boolean; onCancel: () => void; onSubmit: (payload: unknown) => void }) {
  const [deposit, setDeposit] = useState("")
  const [projectName, setProjectName] = useState(unit.buyerName ? `Lot ${unit.lotLabel} — ${unit.buyerName}` : `Lot ${unit.lotLabel}`)
  return (
    <FormShell title={`Reserve Lot ${unit.lotLabel}`} description="Creates the buyer's project and an earnest-deposit invoice.">
      <Field label="Earnest deposit"><Input inputMode="decimal" value={deposit} onChange={(event) => setDeposit(event.target.value)} placeholder="5000" className="rounded-none" /></Field>
      <Field label="Project name"><Input value={projectName} onChange={(event) => setProjectName(event.target.value)} className="rounded-none" /></Field>
      <p className="text-[11px] text-muted-foreground">{deposit ? `Creates a deposit invoice for ${money.format(Number(deposit) || 0)}.` : "No deposit invoice will be created."}</p>
      <FormActions
        pending={pending}
        submitLabel="Create reservation"
        onCancel={onCancel}
        onSubmit={() => onSubmit({ reservationId: unit.reservationId, depositCents: deposit ? Math.round(Number(deposit) * 100) : 0, projectName: projectName.trim() || undefined })}
      />
    </FormShell>
  )
}

const RELEASE_REASONS = ["Financing denied", "Cold feet", "Home-sale contingency", "Build delay", "Relocation", "Found another home", "Other"]

function ReleaseForm({ unit, pending, onCancel, onSubmit }: { unit: SellableUnitDTO; pending: boolean; onCancel: () => void; onSubmit: (payload: unknown) => void }) {
  const [reason, setReason] = useState(RELEASE_REASONS[0])
  const [note, setNote] = useState("")
  const [disposition, setDisposition] = useState<"refund" | "forfeit">("refund")
  const finalReason = reason === "Other" ? note.trim() : note.trim() ? `${reason} — ${note.trim()}` : reason
  return (
    <FormShell title={`Release Lot ${unit.lotLabel}`} description="The lot returns to available inventory.">
      <Field label="Reason">
        <Select value={reason} onValueChange={setReason}>
          <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
          <SelectContent>{RELEASE_REASONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label={reason === "Other" ? "Detail (required)" : "Note (optional)"}><Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} className="rounded-none" /></Field>
      {unit.depositRequiredCents > 0 ? (
        <Field label="Deposit disposition">
          <Select value={disposition} onValueChange={(value) => setDisposition(value as "refund" | "forfeit")}>
            <SelectTrigger className="rounded-none"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="refund">Refund to buyer</SelectItem><SelectItem value="forfeit">Forfeit</SelectItem></SelectContent>
          </Select>
        </Field>
      ) : null}
      <FormActions
        pending={pending}
        disabled={finalReason.length < 3}
        submitLabel="Release"
        destructive
        onCancel={onCancel}
        onSubmit={() => onSubmit({ reservationId: unit.reservationId, reason: finalReason, depositDisposition: unit.depositRequiredCents > 0 ? disposition : undefined })}
      />
    </FormShell>
  )
}

function PriceForm({ unit, pending, onCancel, onSubmit }: { unit: SellableUnitDTO; pending: boolean; onCancel: () => void; onSubmit: (payload: unknown) => void }) {
  const [price, setPrice] = useState(String(Math.round(unit.askingPriceCents / 100)))
  const [reason, setReason] = useState("")
  const cents = Math.round(Number(price) * 100)
  const delta = cents - unit.listPriceCents
  return (
    <FormShell title={`Change asking · Lot ${unit.lotLabel}`} description={`List price is ${money.format(unit.listPriceCents / 100)}.`}>
      <Field label="Asking price"><Input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="rounded-none" /></Field>
      {Number.isFinite(cents) && delta !== 0 ? (
        <p className={cn("text-[11px] tabular-nums", delta < 0 ? "text-[var(--age-2)]" : "text-muted-foreground")}>
          {delta < 0 ? "−" : "+"}{money.format(Math.abs(delta) / 100)} vs list ({((delta / unit.listPriceCents) * 100).toFixed(1)}%)
        </p>
      ) : null}
      <Field label="Reason (optional)"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Aging spec markdown" className="rounded-none" /></Field>
      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={() => onSubmit({ lotId: unit.lotId, askingPriceCents: null, reason: reason.trim() || null })} className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:underline">Clear override</button>
        <FormActions
          pending={pending}
          disabled={!Number.isFinite(cents) || cents < 0}
          submitLabel="Set price"
          onCancel={onCancel}
          inline
          onSubmit={() => onSubmit({ lotId: unit.lotId, askingPriceCents: cents, reason: reason.trim() || null })}
        />
      </div>
    </FormShell>
  )
}

function FormShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function FormActions({
  pending,
  disabled,
  submitLabel,
  onCancel,
  onSubmit,
  destructive,
  inline,
}: {
  pending: boolean
  disabled?: boolean
  submitLabel: string
  onCancel: () => void
  onSubmit: () => void
  destructive?: boolean
  inline?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-2", !inline && "pt-1")}>
      {!inline ? <Button variant="outline" className="rounded-none" onClick={onCancel} disabled={pending}>Cancel</Button> : null}
      <Button className="rounded-none" variant={destructive ? "destructive" : "default"} disabled={pending || disabled} onClick={onSubmit}>
        {pending ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : null}{submitLabel}
      </Button>
    </div>
  )
}
