"use client"

import Link from "next/link"

import { Check, ChevronDown, Filter } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DEAL_VIEWS, DEAL_VIEW_LABELS, type DealView } from "@/lib/sales/board"
import { cn } from "@/lib/utils"

/**
 * Which book you are reading. Links rather than client state, because switching
 * books changes what has to be fetched — closed and lost deals are not held in
 * memory behind the open board.
 */
export function DealViewFilter({ view }: { view: DealView }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 rounded-none">
          <Filter className="size-4" />
          {DEAL_VIEW_LABELS[view]}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40 rounded-none">
        <DropdownMenuLabel className="text-[10px] tracking-wider text-muted-foreground uppercase">
          Show
        </DropdownMenuLabel>
        {DEAL_VIEWS.map((value) => (
          <DropdownMenuItem key={value} asChild>
            <Link href={value === "open" ? "/sales" : `/sales?view=${value}`} className="justify-between">
              {DEAL_VIEW_LABELS[value]}
              <Check className={cn("size-3.5", value === view ? "opacity-100" : "opacity-0")} />
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
