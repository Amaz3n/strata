import Link from "next/link"

import { cn } from "@/lib/utils"

export function CommunitiesDeskTabs({ active }: { active: "communities" | "land" }) {
  return (
    <nav className="flex h-10 items-end gap-5 border-b px-4 text-xs" aria-label="Communities desk">
      <Link className={cn("border-b-2 pb-2.5", active === "communities" ? "border-foreground font-medium" : "border-transparent text-muted-foreground")} href="/communities">Communities</Link>
      <Link className={cn("border-b-2 pb-2.5", active === "land" ? "border-foreground font-medium" : "border-transparent text-muted-foreground")} href="/communities?view=land">Land</Link>
    </nav>
  )
}
