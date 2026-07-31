import Link from "next/link"

import { ArrowUpRight } from "@/components/icons"
import { cn } from "@/lib/utils"

export type Tone = "neutral" | "success" | "warning" | "destructive"

export interface TileStatus {
  tone: Tone
  label: string
}

export interface TileContent {
  key: string
  label: string
  value: string
  detail: string
  status: TileStatus | null
  /** 0–1. Drives the hairline under the value; null where there is no honest denominator. */
  ratio: number | null
}

const pillStyles: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
}

const barStyles: Record<Tone, string> = {
  neutral: "bg-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
}

export function tileFrame(last: boolean) {
  return cn(
    "group flex w-full flex-col gap-4 border-b px-6 py-7 text-left transition-colors last:border-b-0 hover:bg-foreground/[0.015] sm:px-8 xl:border-b-0",
    !last && "sm:border-r",
  )
}

/** The inside of a tile. Shared so a link tile and a sheet-opening tile cannot drift. */
export function TileBody({ content }: { content: TileContent }) {
  return (
    <>
      {/* Fixed height so a two-line label on one tile cannot shove its
          neighbours' numbers out of alignment across the row. */}
      <div className="flex min-h-[1.6rem] items-start justify-between gap-3">
        <span className="text-[10px] font-medium uppercase leading-[1.4] tracking-[0.14em] text-muted-foreground/80">
          {content.label}
        </span>
        {content.status && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] tabular-nums",
              pillStyles[content.status.tone],
            )}
          >
            {content.status.tone !== "neutral" && <span className="h-1 w-1 rounded-full bg-current" />}
            {content.status.label}
          </span>
        )}
      </div>
      <div className="truncate text-[28px] font-semibold leading-none tracking-tight tabular-nums text-foreground sm:text-[32px]">
        {content.value}
      </div>
      {/* No honest denominator means no track at all — an empty bar reads as 0%.
          The row still reserves the height so tiles stay aligned. */}
      <div className={cn("h-1 overflow-hidden", content.ratio !== null && "bg-muted")}>
        {content.ratio !== null && (
          <div
            className={cn("h-full", barStyles[content.status?.tone ?? "neutral"])}
            style={{ width: `${Math.min(100, Math.max(0, content.ratio * 100))}%` }}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{content.detail}</span>
        <ArrowUpRight
          aria-hidden
          className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground/85"
        />
      </div>
    </>
  )
}

/** A tile whose detail already has a desk of its own — go there, don't reprint it. */
export function LinkTile({ content, href, last }: { content: TileContent; href: string; last: boolean }) {
  return (
    <Link className={tileFrame(last)} href={href}>
      <TileBody content={content} />
    </Link>
  )
}
