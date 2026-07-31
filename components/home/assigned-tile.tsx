"use client"

import Link from "next/link"
import { useState } from "react"

import { TileBody, tileFrame, type TileContent } from "@/components/home/stat-tile"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { MyHouseDTO } from "@/lib/services/my-houses"
import { cn } from "@/lib/utils"

/**
 * The per-house roster used to be a page, then a panel. It is neither — it is
 * reference you check, not work you do, so it lives one click behind the number
 * it belongs to and keeps Home a glimpse.
 */
export function AssignedTile({
  content,
  houses,
  last,
}: {
  content: TileContent
  houses: MyHouseDTO[]
  last: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className={tileFrame(last)} onClick={() => setOpen(true)} type="button">
        <TileBody content={content} />
      </button>

      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg" side="right">
          <SheetHeader className="shrink-0 space-y-1 border-b px-5 pb-4 pr-12 pt-5 text-left">
            <SheetTitle className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              {content.label}
            </SheetTitle>
            <SheetDescription asChild>
              <p className="text-[30px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
                {content.value}
                <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">{content.detail}</span>
              </p>
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {houses.map((house) => (
              <Link
                className="block border-b px-5 py-3 transition-colors last:border-b-0 hover:bg-foreground/[0.03]"
                href={`/projects/${house.projectId}`}
                key={house.projectId}
                onClick={() => setOpen(false)}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[13px] font-medium text-foreground">{house.lotLabel}</span>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                    {house.percentComplete}%
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden bg-muted">
                  <div
                    className={cn("h-full", house.lateCount ? "bg-destructive" : "bg-foreground")}
                    style={{ width: `${Math.min(100, Math.max(0, house.percentComplete))}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {[house.communityName, house.planCode, house.currentPhase].filter(Boolean).join(" · ")}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {house.daysInProgress}
                    {house.targetDays ? ` / ${house.targetDays}` : ""}d
                  </span>
                </div>
                {(house.lateCount > 0 || house.openPunch > 0 || !house.lastDailyLogDate) && (
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] tabular-nums">
                    {house.lateCount > 0 && (
                      <span className="font-medium text-destructive">{house.lateCount} late</span>
                    )}
                    {house.openPunch > 0 && (
                      <span className="text-muted-foreground">{house.openPunch} punch</span>
                    )}
                    {!house.lastDailyLogDate && <span className="text-warning">No daily log</span>}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
