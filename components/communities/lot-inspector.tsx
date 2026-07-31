"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  attachProjectToLotAction,
  deleteLotAction,
  detachProjectFromLotAction,
  setLotStatusAction,
  updateLotAction,
} from "@/app/(app)/communities/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { unwrapAction } from "@/lib/action-result"
import { LAND_SETTABLE_LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
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

const NONE = "none"
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
  canWrite,
  onOpenChange,
}: {
  lot: InventoryLotDTO | null
  community: CommunityDetailDTO
  money: LotMoney | null
  /** Homes in this community with no lot yet — the linkage repair path. */
  projects: Array<{ id: string; name: string }>
  canWrite: boolean
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

  useEffect(() => {
    setAttachTo(NONE)
    setAddress(lot?.address ?? "")
    setPremium(lot ? (lot.premiumCents / 100).toFixed(2) : "")
    setCostBasis(lot?.costBasisCents != null ? (lot.costBasisCents / 100).toFixed(2) : "")
    setWidth(lot?.dimensions.widthFt != null ? String(lot.dimensions.widthFt) : "")
    setDepth(lot?.dimensions.depthFt != null ? String(lot.dimensions.depthFt) : "")
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

  function saveDimensions(next: { widthFt?: number; depthFt?: number }) {
    if (!lot) return
    const dimensions = { ...lot.dimensions, ...next }
    apply(
      () => updateLotAction(lot.id, community.id, { dimensions }),
      "Dimensions saved",
      "Unable to save the dimensions",
    )
  }

  // A lot past `developed` got there through a hold, a release, or a
  // settlement. Offering those values here would let the workbench and the
  // desks that own them drift apart.
  const statusIsOwnedElsewhere = lot != null && !LAND_SETTABLE_LOT_STATUSES.some((value) => value === lot.status)

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
                          apply(
                            () =>
                              updateLotAction(lot.id, community.id, {
                                swing: value as InventoryLotDTO["swing"],
                              }),
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
                </dl>
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
                    {lot.planName ? (
                      <>
                        {lot.planName}
                        {lot.elevationName ? ` · ${lot.elevationName}` : ""}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Not assigned</span>
                    )}
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
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 w-full rounded-none text-xs"
                        disabled={isPending}
                        onClick={() =>
                          apply(
                            () => detachProjectFromLotAction(lot.id, community.id),
                            "Home detached",
                            "Unable to detach the home",
                          )
                        }
                      >
                        Detach home
                      </Button>
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
                        <Button
                          size="sm"
                          className="h-7 w-full rounded-none text-xs"
                          disabled={attachTo === NONE || isPending}
                          onClick={() =>
                            apply(
                              () => attachProjectToLotAction(lot.id, community.id, attachTo),
                              "Home attached",
                              "Unable to attach the home",
                            )
                          }
                        >
                          Attach home
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
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
