"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  attachProjectToLotAction,
  deleteLotAction,
  detachProjectFromLotAction,
  recordLotDeliveryExceptionAction,
  revokeLotDeliveryExceptionAction,
  setLotStatusAction,
  updateLotAction,
} from "@/app/(app)/communities/actions"
import { LotFitSection } from "@/components/communities/lot-fit"
import { LotPlanAssignmentDialog } from "@/components/communities/lot-plan-assignment"
import { LotReasonDialog } from "@/components/communities/lot-reason-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { unwrapAction } from "@/lib/action-result"
import type { LotDimensions, Setbacks } from "@/lib/land/lot-dimensions"
import { LAND_SETTABLE_LOT_STATUSES, LOT_STATUS_META, MIN_DELIVERY_EXCEPTION_REASON_LENGTH, type LotStatus } from "@/lib/land/lot-lifecycle"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { InventoryLotDTO } from "@/lib/services/community-inventory"
import { cn } from "@/lib/utils"

export interface LotMoney {
  revenueCents: number
  budgetCents: number
  actualCostCents: number
  vpoCents: number
  projectedMarginCents: number
  projectedMarginPercent: number
}

/**
 * What this person may do beyond editing land facts. Each is a distinct
 * authority the services enforce, so the inspector names the missing one rather
 * than hiding the control and leaving the lot looking stuck.
 */
export interface LotCapabilities {
  /** lot.write and plan.instantiate */
  canAssignPlan: boolean
  /** plan.release */
  canOverrideOffering: boolean
  /** lot.write and community.write */
  canRecordDeliveryException: boolean
  /** lot.fit_override */
  canOverrideFit: boolean
}

const NONE = "none"
const SETBACKS: Array<{ key: keyof Setbacks; label: string }> = [
  { key: "frontSetbackFt", label: "Front" },
  { key: "rearSetbackFt", label: "Rear" },
  { key: "sideSetbackFt", label: "Side" },
  { key: "cornerSideSetbackFt", label: "Corner side" },
]

function feetText(value: number | undefined) {
  return value != null ? String(value) : ""
}
const SWINGS: Array<{ value: InventoryLotDTO["swing"]; label: string }> = [
  { value: "either", label: "Either" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
]

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    cents / 100,
  )
}

function lotLabel(lot: InventoryLotDTO) {
  return lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="microlabel mb-1.5">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs">{children}</dd>
    </div>
  )
}

/**
 * Everything about one lot, in one place — and this time that includes the
 * buyer.
 *
 * The community owns the lot's land facts and edits them here. Buyer, home, and
 * money are owned by the Sales desk, the project workbench, and accounting; they
 * are shown because they change what a land manager decides, and they link out
 * rather than being editable. One home per mutation.
 */
export function LotInspector({
  lot,
  community,
  money: lotMoney,
  projects,
  projectsTruncated,
  canWrite,
  capabilities,
  onOpenChange,
}: {
  lot: InventoryLotDTO | null
  community: CommunityDetailDTO
  money: LotMoney | null
  /** Homes in this community with no lot yet — the linkage repair path. */
  projects: Array<{ id: string; name: string }>
  /** True when more free homes exist than this list shows. Said out loud below. */
  projectsTruncated: boolean
  canWrite: boolean
  capabilities: LotCapabilities
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [attachTo, setAttachTo] = useState(NONE)
  const [address, setAddress] = useState("")
  const [premium, setPremium] = useState("")
  const [costBasis, setCostBasis] = useState("")
  const [width, setWidth] = useState("")
  const [depth, setDepth] = useState("")
  const [setbacks, setSetbacks] = useState<Record<keyof Setbacks, string>>({
    frontSetbackFt: "",
    rearSetbackFt: "",
    sideSetbackFt: "",
    cornerSideSetbackFt: "",
  })
  const [assigningPlan, setAssigningPlan] = useState(false)
  const [recordingException, setRecordingException] = useState(false)

  useEffect(() => {
    setAttachTo(NONE)
    setAddress(lot?.address ?? "")
    setPremium(lot ? (lot.premiumCents / 100).toFixed(2) : "")
    setCostBasis(lot?.costBasisCents != null ? (lot.costBasisCents / 100).toFixed(2) : "")
    setWidth(lot?.dimensions.widthFt != null ? String(lot.dimensions.widthFt) : "")
    setDepth(lot?.dimensions.depthFt != null ? String(lot.dimensions.depthFt) : "")
    setSetbacks({
      frontSetbackFt: feetText(lot?.dimensions.frontSetbackFt),
      rearSetbackFt: feetText(lot?.dimensions.rearSetbackFt),
      sideSetbackFt: feetText(lot?.dimensions.sideSetbackFt),
      cornerSideSetbackFt: feetText(lot?.dimensions.cornerSideSetbackFt),
    })
  }, [lot])

  function apply(operation: () => Promise<unknown>, success: string, failure: string) {
    startTransition(async () => {
      try {
        unwrapAction((await operation()) as Parameters<typeof unwrapAction>[0])
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: (error as Error).message })
      }
    })
  }

  /**
   * Dimensions, setbacks and the handing a lot takes are what a pinned home is
   * judged against, so saving one re-judges it; a home that stops fitting is
   * said out loud here and flagged on the lot, never silently unpinned.
   */
  function saveFitInput(patch: { dimensions?: LotDimensions; swing?: InventoryLotDTO["swing"] }, success: string, failure: string) {
    if (!lot) return
    startTransition(async () => {
      try {
        const saved = unwrapAction(await updateLotAction(lot.id, community.id, patch))
        if (saved.fitRefusal) toast.warning(`${success} — the pinned home no longer fits`, { description: saved.fitRefusal })
        else toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error(failure, { description: (error as Error).message })
      }
    })
  }

  function saveDimensions(next: Partial<LotDimensions>) {
    if (!lot) return
    saveFitInput({ dimensions: { ...lot.dimensions, ...next } }, "Dimensions saved", "Unable to save the dimensions")
  }

  // A lot past `developed` got there through a hold, a release, or a
  // settlement. Offering those values here would let the workbench and the
  // desks that own them drift apart.
  const statusIsOwnedElsewhere = lot != null && !LAND_SETTABLE_LOT_STATUSES.some((value) => value === lot.status)

  // Backward moves in the lot lifecycle. The service refuses them without an
  // explicit confirmation, so the button says what it is about to undo.
  const reversingDetach = lot != null && (lot.status === "started" || lot.status === "closed")
  const reversingAttach = lot != null && lot.status === "closed"

  // A plan is pinned to a lot only while nothing else speaks for it: a home owns
  // its own plan, a buyer's agreement owns the sold lot's, and a settled lot is
  // history. The service enforces the same list; this just keeps the control honest.
  const planAssignable =
    lot != null && !lot.projectId && !lot.buyer && lot.status !== "started" && lot.status !== "closed"
  const deliveryOpen = lot != null && !lot.projectId && lot.status !== "started" && lot.status !== "closed"

  return (
    <Sheet open={Boolean(lot)} onOpenChange={onOpenChange}>
      <SheetContent className="rounded-none sm:max-w-sm">
        {lot ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span className={cn("size-2.5 shrink-0", LOT_STATUS_META[lot.status].barClass)} />
                Lot {lotLabel(lot)}
              </SheetTitle>
              <SheetDescription>{lot.address ?? "No address recorded"}</SheetDescription>
            </SheetHeader>

            <div className="space-y-5 overflow-y-auto px-4 pb-6">
              <Section title="Land">
                <dl>
                  <Row label="Status">
                    {canWrite && !statusIsOwnedElsewhere ? (
                      <Select
                        value={lot.status}
                        disabled={isPending}
                        onValueChange={(value) =>
                          apply(
                            () => setLotStatusAction(lot.id, community.id, { status: value as LotStatus }),
                            `Lot ${lotLabel(lot)} is ${LOT_STATUS_META[value as LotStatus].label.toLowerCase()}`,
                            "Unable to change status",
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LAND_SETTABLE_LOT_STATUSES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {LOT_STATUS_META[value].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      LOT_STATUS_META[lot.status].label
                    )}
                  </Row>
                  <Row label="Address">
                    {canWrite ? (
                      <Input
                        aria-label={`Address for lot ${lotLabel(lot)}`}
                        className="ml-auto h-7 w-44 rounded-none text-right text-xs"
                        disabled={isPending}
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                        onBlur={() => {
                          const next = address.trim()
                          if (next === (lot.address ?? "")) return
                          apply(
                            () => updateLotAction(lot.id, community.id, { address: next || null }),
                            "Address saved",
                            "Unable to save the address",
                          )
                        }}
                      />
                    ) : (
                      (lot.address ?? "—")
                    )}
                  </Row>
                  <Row label="Phase">
                    {canWrite ? (
                      <Select
                        value={lot.phaseId ?? NONE}
                        disabled={isPending}
                        onValueChange={(value) =>
                          apply(
                            () => updateLotAction(lot.id, community.id, { phaseId: value === NONE ? null : value }),
                            "Phase updated",
                            "Unable to change phase",
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Unphased</SelectItem>
                          {community.phases.map((phase) => (
                            <SelectItem key={phase.id} value={phase.id}>
                              {phase.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      (lot.phaseName ?? "Unphased")
                    )}
                  </Row>
                  <Row label="Takedown">
                    {canWrite ? (
                      <Select
                        value={lot.takedownId ?? NONE}
                        disabled={isPending}
                        onValueChange={(value) =>
                          apply(
                            () => updateLotAction(lot.id, community.id, { takedownId: value === NONE ? null : value }),
                            "Takedown updated",
                            "Unable to change takedown",
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Unassigned</SelectItem>
                          {community.takedowns.map((takedown) => (
                            <SelectItem key={takedown.id} value={takedown.id}>
                              {takedown.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      (lot.takedownName ?? "Unassigned")
                    )}
                  </Row>
                  <Row label="Width × depth">
                    {canWrite ? (
                      <span className="flex items-center justify-end gap-1">
                        <Input
                          inputMode="decimal"
                          aria-label={`Lot width in feet for lot ${lotLabel(lot)}`}
                          className="h-7 w-16 rounded-none text-right text-xs tabular-nums"
                          disabled={isPending}
                          value={width}
                          onChange={(event) => setWidth(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur()
                          }}
                          onBlur={() => {
                            const next = width ? Number(width) : undefined
                            if (next === lot.dimensions.widthFt) return
                            if (next != null && !Number.isFinite(next)) return
                            saveDimensions({ widthFt: next })
                          }}
                        />
                        <span className="text-muted-foreground">×</span>
                        <Input
                          inputMode="decimal"
                          aria-label={`Lot depth in feet for lot ${lotLabel(lot)}`}
                          className="h-7 w-16 rounded-none text-right text-xs tabular-nums"
                          disabled={isPending}
                          value={depth}
                          onChange={(event) => setDepth(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur()
                          }}
                          onBlur={() => {
                            const next = depth ? Number(depth) : undefined
                            if (next === lot.dimensions.depthFt) return
                            if (next != null && !Number.isFinite(next)) return
                            saveDimensions({ depthFt: next })
                          }}
                        />
                      </span>
                    ) : lot.dimensions.widthFt != null || lot.dimensions.depthFt != null ? (
                      `${lot.dimensions.widthFt ?? "—"} × ${lot.dimensions.depthFt ?? "—"} ft`
                    ) : (
                      "—"
                    )}
                  </Row>
                  <Row label="Garage swing">
                    {canWrite ? (
                      <Select
                        value={lot.swing}
                        disabled={isPending}
                        onValueChange={(value) =>
                          saveFitInput(
                            { swing: value as InventoryLotDTO["swing"] },
                            "Swing updated",
                            "Unable to change the swing",
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SWINGS.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      (SWINGS.find((entry) => entry.value === lot.swing)?.label ?? "Either")
                    )}
                  </Row>
                  <Row label="Delivery">
                    {lot.deliveryRefusal ? (
                      <span className="text-warning">Not delivered</span>
                    ) : lot.deliveryException ? (
                      <span className="text-warning">Exception on record</span>
                    ) : (
                      "Delivered"
                    )}
                  </Row>
                </dl>
                {lot.deliveryException ? (
                  <div className="mt-1.5 flex items-start justify-between gap-3 text-xs">
                    <p className="text-muted-foreground">
                      Exception: {lot.deliveryException.reason}
                      <span className="block tabular-nums">Approved {lot.deliveryException.approvedAt.slice(0, 10)}</span>
                    </p>
                    {capabilities.canRecordDeliveryException ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 rounded-none text-xs"
                        disabled={isPending}
                        onClick={() =>
                          apply(
                            () => revokeLotDeliveryExceptionAction(lot.id, community.id),
                            "Delivery exception revoked",
                            "Unable to revoke the exception",
                          )
                        }
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {lot.deliveryRefusal && deliveryOpen ? (
                  <div className="mt-2 space-y-2 border border-warning/40 bg-warning/10 px-3 py-2.5">
                    <p className="text-xs text-warning">{lot.deliveryRefusal}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-none text-xs"
                      disabled={isPending || !capabilities.canRecordDeliveryException}
                      onClick={() => setRecordingException(true)}
                    >
                      Record delivery exception
                    </Button>
                    {capabilities.canRecordDeliveryException ? null : (
                      <p className="text-xs text-muted-foreground">
                        Recording an exception needs the lot.delivery_override permission.
                      </p>
                    )}
                  </div>
                ) : null}
              </Section>

              <Section title="Fit">
                <dl>
                  {SETBACKS.map((entry) => {
                    const fallback = community.setbacks[entry.key]
                    const own = lot.dimensions[entry.key]
                    return (
                      <Row key={entry.key} label={`${entry.label} setback`}>
                        {canWrite ? (
                          <Input
                            inputMode="decimal"
                            aria-label={`${entry.label} setback in feet for lot ${lotLabel(lot)}`}
                            placeholder={fallback != null ? `${fallback} (community)` : "ft"}
                            className="ml-auto h-7 w-28 rounded-none text-right text-xs tabular-nums"
                            disabled={isPending}
                            value={setbacks[entry.key]}
                            onChange={(event) => setSetbacks((current) => ({ ...current, [entry.key]: event.target.value }))}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur()
                            }}
                            onBlur={() => {
                              const raw = setbacks[entry.key].trim()
                              const next = raw ? Number(raw) : undefined
                              if (next === own) return
                              if (next != null && (!Number.isFinite(next) || next < 0)) return
                              saveDimensions({ [entry.key]: next })
                            }}
                          />
                        ) : own != null ? (
                          <span className="tabular-nums">{own} ft</span>
                        ) : fallback != null ? (
                          <span className="tabular-nums text-muted-foreground">{fallback} ft (community)</span>
                        ) : (
                          "—"
                        )}
                      </Row>
                    )
                  })}
                  <Row label="Lot shape">
                    {canWrite ? (
                      <Select
                        value={lot.dimensions.irregular ? "irregular" : lot.dimensions.corner ? "corner" : "interior"}
                        disabled={isPending}
                        onValueChange={(value) =>
                          saveDimensions({ corner: value === "corner" ? true : undefined, irregular: value === "irregular" ? true : undefined })
                        }
                      >
                        <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="interior">Interior</SelectItem>
                          <SelectItem value="corner">Corner</SelectItem>
                          <SelectItem value="irregular">Irregular</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : lot.dimensions.irregular ? (
                      "Irregular"
                    ) : lot.dimensions.corner ? (
                      "Corner"
                    ) : (
                      "Interior"
                    )}
                  </Row>
                </dl>
                <LotFitSection
                  lot={{
                    id: lot.id,
                    label: lotLabel(lot),
                    projectId: lot.projectId,
                    refreshKey: JSON.stringify([lot.dimensions, lot.swing, lot.planName, lot.elevationName]),
                  }}
                  communityId={community.id}
                  canWrite={canWrite}
                  canOverrideFit={capabilities.canOverrideFit}
                />
              </Section>

              <Section title="Price">
                <dl>
                  <Row label="Lot premium">
                    {canWrite ? (
                      <Input
                        inputMode="decimal"
                        aria-label={`Lot premium for lot ${lotLabel(lot)}`}
                        className="ml-auto h-7 w-28 rounded-none text-right text-xs tabular-nums"
                        disabled={isPending}
                        value={premium}
                        onChange={(event) => setPremium(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                        onBlur={() => {
                          const next = Math.round(Number(premium || 0) * 100)
                          if (!Number.isFinite(next) || next === lot.premiumCents) return
                          apply(
                            () => updateLotAction(lot.id, community.id, { premiumCents: next }),
                            "Premium saved",
                            "Unable to save the premium",
                          )
                        }}
                      />
                    ) : (
                      money(lot.premiumCents)
                    )}
                  </Row>
                  <Row label="Land cost">
                    {canWrite ? (
                      <Input
                        inputMode="decimal"
                        aria-label={`Land cost basis for lot ${lotLabel(lot)}`}
                        className="ml-auto h-7 w-28 rounded-none text-right text-xs tabular-nums"
                        disabled={isPending}
                        value={costBasis}
                        onChange={(event) => setCostBasis(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                        onBlur={() => {
                          const next = costBasis ? Math.round(Number(costBasis) * 100) : null
                          if (next != null && !Number.isFinite(next)) return
                          if (next === lot.costBasisCents) return
                          apply(
                            () => updateLotAction(lot.id, community.id, { costBasisCents: next }),
                            "Land cost saved",
                            "Unable to save the land cost",
                          )
                        }}
                      />
                    ) : lot.costBasisCents != null ? (
                      money(lot.costBasisCents)
                    ) : (
                      "—"
                    )}
                  </Row>
                  <Row label="Plan">
                    <span className="flex items-center justify-end gap-2">
                      {lot.planName ? (
                        <span>
                          {lot.planName}
                          {lot.elevationName ? ` · ${lot.elevationName}` : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not assigned</span>
                      )}
                      {planAssignable ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 rounded-none px-2 text-xs"
                          disabled={isPending || !capabilities.canAssignPlan}
                          title={capabilities.canAssignPlan ? undefined : "Assigning a plan needs lot.write and plan.instantiate"}
                          onClick={() => setAssigningPlan(true)}
                        >
                          {lot.planName ? "Change" : "Assign plan"}
                        </Button>
                      ) : null}
                    </span>
                  </Row>
                </dl>
              </Section>

              <Section title="Buyer">
                {lot.buyer ? (
                  <dl>
                    <Row label="Name">
                      {lot.buyer.prospectId ? (
                        <Link href={`/sales/${lot.buyer.prospectId}`} className="font-medium hover:underline">
                          {lot.buyer.name ?? "Open the deal"}
                        </Link>
                      ) : (
                        (lot.buyer.name ?? "—")
                      )}
                    </Row>
                    <Row label="Standing">{lot.buyer.status === "hold" ? "Hold" : "Reserved"}</Row>
                    {lot.buyer.expiresAt ? (
                      <Row label="Expires">
                        <span className="tabular-nums">{lot.buyer.expiresAt.slice(0, 10)}</span>
                      </Row>
                    ) : null}
                    {lot.buyer.askingPriceCents != null ? (
                      <Row label="Asking">
                        <span className="tabular-nums">{money(lot.buyer.askingPriceCents)}</span>
                      </Row>
                    ) : null}
                    {lot.closing ? (
                      <Row label="Closing">
                        <span className="tabular-nums">
                          {lot.closing.actualDate ?? lot.closing.scheduledDate ?? "—"}
                        </span>
                      </Row>
                    ) : null}
                  </dl>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No buyer.{" "}
                    <Link href={`/sales?community=${community.id}`} className="underline underline-offset-2">
                      Holds are placed on the Sales desk.
                    </Link>
                  </p>
                )}
              </Section>

              <Section title="Home">
                {lot.projectId ? (
                  <div className="space-y-2">
                    <Link href={`/projects/${lot.projectId}`} className="block text-xs font-medium hover:underline">
                      {lot.projectName ?? "Open the home"}
                    </Link>
                    {canWrite ? (
                      <div className="space-y-1.5">
                        {/* Pulling a home off a lot that is building or settled is a
                            backward move in the lot lifecycle, so it takes the same
                            explicit confirmation `setLotStatus` asks for. */}
                        {reversingDetach ? (
                          <p className="text-xs text-warning">
                            Lot {lotLabel(lot)} is {LOT_STATUS_META[lot.status].label.toLowerCase()}. Detaching reverses
                            that and returns the lot to inventory.
                          </p>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-full rounded-none text-xs"
                          disabled={isPending}
                          onClick={() =>
                            apply(
                              () => detachProjectFromLotAction(lot.id, community.id, reversingDetach),
                              "Home detached",
                              "Unable to detach the home",
                            )
                          }
                        >
                          {reversingDetach ? "Detach home anyway" : "Detach home"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Not started.{" "}
                      <Link href={`/starts?community=${community.id}`} className="underline underline-offset-2">
                        Homes are released from Starts.
                      </Link>
                    </p>
                    {/* Linking an existing home record to its dirt is a land fact and
                        belongs here; releasing a start is not, and does not. */}
                    {canWrite && projects.length > 0 ? (
                      <div className="space-y-2">
                        <Select value={attachTo} onValueChange={setAttachTo} disabled={isPending}>
                          <SelectTrigger className="h-7 w-full rounded-none text-xs">
                            <SelectValue placeholder="Link an existing home" />
                          </SelectTrigger>
                          <SelectContent>
                            {projects.map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {projectsTruncated ? (
                          <p className="text-xs text-muted-foreground">
                            Showing the first {projects.length} unlinked homes. More exist — open the home and link it
                            from there.
                          </p>
                        ) : null}
                        {reversingAttach ? (
                          <p className="text-xs text-warning">
                            Lot {lotLabel(lot)} has closed. Attaching a home reopens it as a house under construction.
                          </p>
                        ) : null}
                        <Button
                          size="sm"
                          className="h-7 w-full rounded-none text-xs"
                          disabled={attachTo === NONE || isPending}
                          onClick={() =>
                            apply(
                              () => attachProjectToLotAction(lot.id, community.id, attachTo, reversingAttach),
                              "Home attached",
                              "Unable to attach the home",
                            )
                          }
                        >
                          {reversingAttach ? "Attach home anyway" : "Attach home"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </Section>

              {lotMoney ? (
                <Section title="Money">
                  <dl>
                    <Row label="Revenue">
                      <span className="tabular-nums">{money(lotMoney.revenueCents)}</span>
                    </Row>
                    <Row label="Budget">
                      <span className="tabular-nums">{money(lotMoney.budgetCents)}</span>
                    </Row>
                    <Row label="Actual cost">
                      <span className="tabular-nums">{money(lotMoney.actualCostCents)}</span>
                    </Row>
                    <Row label="VPOs">
                      <span className="tabular-nums">{money(lotMoney.vpoCents)}</span>
                    </Row>
                    <Row label="Projected margin">
                      <span className="font-medium tabular-nums">
                        {money(lotMoney.projectedMarginCents)} · {lotMoney.projectedMarginPercent.toFixed(1)}%
                      </span>
                    </Row>
                  </dl>
                </Section>
              ) : null}

              {canWrite && !lot.projectId && !lot.buyer && !statusIsOwnedElsewhere ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-full rounded-none text-xs text-destructive hover:bg-destructive/10"
                  disabled={isPending}
                  onClick={() => {
                    apply(
                      () => deleteLotAction(lot.id, community.id),
                      `Lot ${lotLabel(lot)} deleted`,
                      "Unable to delete the lot",
                    )
                    onOpenChange(false)
                  }}
                >
                  Delete lot
                </Button>
              ) : null}
            </div>
            <LotPlanAssignmentDialog
              lot={lot}
              communityId={community.id}
              open={assigningPlan}
              onOpenChange={setAssigningPlan}
              canOverrideOffering={capabilities.canOverrideOffering}
              canOverrideFit={capabilities.canOverrideFit}
            />
            <LotReasonDialog
              open={recordingException}
              onOpenChange={setRecordingException}
              title={`Delivery exception · Lot ${lotLabel(lot)}`}
              description="Lets a house start on a lot land development has not delivered. It is recorded in your name with the reason, and the start gates read it back until it is revoked."
              minLength={MIN_DELIVERY_EXCEPTION_REASON_LENGTH}
              submitLabel="Record exception"
              success="Delivery exception recorded"
              onSubmit={async (reason) => {
                unwrapAction(await recordLotDeliveryExceptionAction(lot.id, community.id, { reason }))
                router.refresh()
              }}
            />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
