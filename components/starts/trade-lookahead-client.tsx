"use client"

import { useRouter } from "next/navigation"
import { Fragment, useState, useTransition } from "react"
import { toast } from "sonner"

import { ChevronDown, ChevronRight, Send } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { TradeLookaheadRow } from "@/lib/services/trade-lookahead"
import { cn } from "@/lib/utils"
import { sendTradeLookaheadAction } from "@/app/(app)/starts/actions"

const CONFIRMATION_TONES: Record<string, string> = {
  confirmed: "border-primary/30 bg-primary/10 text-primary",
  sent: "border-border bg-muted text-muted-foreground",
  declined: "border-destructive/30 bg-destructive/10 text-destructive",
  unsent: "border-border bg-secondary text-secondary-foreground",
}

function rowKey(row: TradeLookaheadRow) {
  return `${row.companyId ?? "none"}:${row.trade ?? ""}`
}

export function TradeLookaheadClient({ rows, weeks }: { rows: TradeLookaheadRow[]; weeks: 2 | 3 | 4 }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [expanded, setExpanded] = useState<string | null>(null)

  const send = (companyId: string, companyName: string) => {
    startTransition(async () => {
      try {
        unwrapAction(await sendTradeLookaheadAction(companyId, { weeks }))
        toast.success(`Look-ahead sent to ${companyName}`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to send look-ahead", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  if (!rows.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 border px-6 py-16 text-center">
        <p className="text-sm font-medium">No trade work in this window</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Scheduled production tasks with trade assignments will appear here as houses release and their schedules fill the next {weeks} weeks.
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto border">
      <Table>
        <TableHeader>
          <TableRow className="text-[11px] uppercase tracking-wide">
            <TableHead className="w-8" />
            <TableHead>Trade company</TableHead>
            <TableHead>Trade</TableHead>
            <TableHead className="text-right">Tasks</TableHead>
            <TableHead className="text-right">Confirmed</TableHead>
            <TableHead>First date</TableHead>
            <TableHead className="text-right">Dispatch</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const key = rowKey(row)
            const companyId = row.companyId
            const isOpen = expanded === key
            const confirmed = row.items.filter((item) => item.confirmation === "confirmed").length
            return (
              <Fragment key={key}>
                <TableRow className="cursor-pointer text-xs" onClick={() => setExpanded(isOpen ? null : key)}>
                  <TableCell className="text-muted-foreground">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </TableCell>
                  <TableCell className="font-medium">{row.companyName}</TableCell>
                  <TableCell className="text-muted-foreground">{row.trade ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.items.length}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", confirmed < row.items.length && "text-muted-foreground")}>
                    {confirmed}/{row.items.length}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.items[0]?.startDate ?? "—"}</TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    {companyId ? (
                      <Button size="sm" variant="outline" className="rounded-none" disabled={pending} onClick={() => send(companyId, row.companyName)}>
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                        Send
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">Assign trade</span>
                    )}
                  </TableCell>
                </TableRow>
                {isOpen ? (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell />
                    <TableCell colSpan={6} className="p-0">
                      <Table>
                        <TableBody>
                          {row.items.map((item) => (
                            <TableRow key={item.scheduleItemId} className="text-xs">
                              <TableCell className="w-56 font-medium">{item.communityName} · {item.lotLabel}</TableCell>
                              <TableCell>{item.name}</TableCell>
                              <TableCell className="w-44 tabular-nums text-muted-foreground">{item.startDate} → {item.endDate}</TableCell>
                              <TableCell className="w-28">
                                <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", CONFIRMATION_TONES[item.confirmation])}>
                                  {item.confirmation}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
