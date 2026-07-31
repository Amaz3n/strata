"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Lock, MoreHorizontal, Plus } from "@/components/icons"
import { createPlanVersionAction, updateHousePlanAction } from "@/app/(app)/plans/actions"
import { PlanStatusBadge } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { unwrapAction } from "@/lib/action-result"
import type { HousePlanDto, HousePlanVersionDto, PlanVersionDriftDto } from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

/**
 * Editions along a line, oldest to newest, because that is the order they
 * happened in and the shape of the question people bring here: what were we
 * building, what are we building, what are we about to build. The fact under each
 * one is the number of houses tied to it — the only reason a superseded edition
 * still matters.
 */
export function PlanEditions({
  plan,
  versions,
  selectedId,
  onSelect,
  drift,
  canWrite,
}: {
  plan: HousePlanDto
  versions: HousePlanVersionDto[]
  selectedId: string
  onSelect: (versionId: string) => void
  drift: PlanVersionDriftDto[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const ordered = [...versions].sort((left, right) => left.version_number - right.version_number)
  const draftVersion = versions.find((version) => version.status === "draft") ?? null

  function run(operation: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        router.refresh()
      } catch (error) {
        toast.error("The plan could not be updated", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  function startDraft() {
    run(async () => {
      const created = unwrapAction(await createPlanVersionAction(plan.id, { copyFromVersionId: selectedId || null }))
      onSelect(created.id)
    }, "Draft edition created")
  }

  return (
    <div id="plan-editions" className="flex scroll-mt-10 flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {ordered.map((version, index) => {
          const isSelected = version.id === selectedId
          const versionDrift = drift.find((entry) => entry.version_id === version.id) ?? null
          return (
            <div key={version.id} className="flex items-center">
              {index > 0 ? <span aria-hidden className="h-px w-6 shrink-0 bg-border" /> : null}
              <button
                type="button"
                onClick={() => onSelect(version.id)}
                aria-current={isSelected ? "true" : undefined}
                className={cn(
                  "relative shrink-0 border-b-2 px-3 py-1.5 text-left transition-colors",
                  isSelected ? "border-primary" : "border-transparent hover:bg-muted/50",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      version.status === "draft"
                        ? "bg-warning"
                        : version.status === "released"
                          ? "bg-primary"
                          : "bg-muted-foreground/50",
                    )}
                  />
                  <span className={cn("font-mono text-xs font-medium", !isSelected && "text-muted-foreground")}>
                    v{version.version_number}
                  </span>
                  {version.status !== "draft" ? <Lock className="h-3 w-3 text-muted-foreground" /> : null}
                </span>
                <span className="mt-0.5 block whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                  {version.status === "draft"
                    ? version.label || "draft"
                    : version.pinned_lot_count > 0
                      ? `${version.pinned_lot_count} ${version.pinned_lot_count === 1 ? "house" : "houses"}`
                      : version.status}
                  {versionDrift && versionDrift.changes.length > 0 && version.status === "superseded"
                    ? ` · ${versionDrift.changes.length} behind`
                    : ""}
                </span>
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <PlanStatusBadge status={plan.status} />
        {canWrite ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 rounded-none"
                disabled={pending}
                aria-label="Plan actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={startDraft}
                disabled={Boolean(draftVersion)}
                title={draftVersion ? `v${draftVersion.version_number} is already open` : undefined}
              >
                <Plus className="h-4 w-4" />
                New edition
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Plan status</DropdownMenuLabel>
              {(["draft", "active", "retired"] as const).map((status) => (
                <DropdownMenuItem
                  key={status}
                  disabled={status === plan.status}
                  onClick={() =>
                    run(
                      async () => unwrapAction(await updateHousePlanAction(plan.id, { status })),
                      "Plan status updated",
                    )
                  }
                >
                  <span className="capitalize">{status}</span>
                  {status === plan.status ? <span className="ml-auto text-[10px] text-muted-foreground">Current</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
