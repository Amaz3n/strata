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
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { PlatLotDTO } from "@/lib/services/lots"
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

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function lotLabel(lot: PlatLotDTO) {
  return lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber
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
 * Everything about one lot, in one place. Before this the same facts were split
 * across five workbench tabs — land on one, price on another, buyer on a third,
 * money on a fourth — so nobody could answer "what is going on with lot 47".
 */
export function LotInspector({
  lot,
  community,
  money: lotMoney,
  projects,
  canWrite,
  onOpenChange,
}: {
  lot: PlatLotDTO | null
  community: CommunityDetailDTO
  money: LotMoney | null
  projects: Array<{ id: string; name: string }>
  canWrite: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [premium, setPremium] = useState("")
  const [attachTo, setAttachTo] = useState(NONE)

  useEffect(() => {
    setPremium(lot ? (lot.premiumCents / 100).toFixed(2) : "")
    setAttachTo(NONE)
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
              <section>
                <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Land</h3>
                <dl>
                  <Row label="Status">
                    {canWrite ? (
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
                          {LOT_STATUSES.map((status) => (
                            <SelectItem key={status} value={status}>
                              {LOT_STATUS_META[status].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      LOT_STATUS_META[lot.status].label
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
                      lot.phaseName ?? "Unphased"
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
                      lot.takedownName ?? "Unassigned"
                    )}
                  </Row>
                </dl>
              </section>

              <section>
                <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Price</h3>
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
                  <Row label="Plan">{lot.planName ?? <span className="text-muted-foreground">Not assigned</span>}</Row>
                </dl>
              </section>

              <section>
                <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Home</h3>
                {lot.projectId ? (
                  <div className="space-y-2">
                    <Link
                      href={`/projects/${lot.projectId}`}
                      className="block text-xs font-medium hover:underline"
                    >
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
                ) : canWrite ? (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">No home is attached to this lot.</Label>
                    <Select value={attachTo} onValueChange={setAttachTo} disabled={isPending || projects.length === 0}>
                      <SelectTrigger className="h-7 w-full rounded-none text-xs">
                        <SelectValue placeholder={projects.length === 0 ? "No unlinked homes" : "Choose a home"} />
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
                ) : (
                  <p className="text-xs text-muted-foreground">Not started</p>
                )}
              </section>

              {lotMoney ? (
                <section>
                  <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Money</h3>
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
                      <span className="tabular-nums font-medium">
                        {money(lotMoney.projectedMarginCents)} · {lotMoney.projectedMarginPercent.toFixed(1)}%
                      </span>
                    </Row>
                  </dl>
                </section>
              ) : null}

              {canWrite && !lot.projectId && ["controlled", "owned", "developed"].includes(lot.status) ? (
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
