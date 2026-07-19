import Link from "next/link"
import type { ReactNode } from "react"

const links = [
  ["Release board", "/starts"],
  ["Pipeline", "/starts/pipeline"],
  ["Reports", "/starts/reports"],
  ["Trade look-aheads", "/starts/trades"],
  ["Gate settings", "/starts/settings"],
] as const

export default function StartsLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col">
    <nav aria-label="Starts" className="flex h-10 items-end gap-5 overflow-x-auto border-b px-4 text-xs">
      {links.map(([label, href]) => <Link className="whitespace-nowrap border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={href} key={href}>{label}</Link>)}
    </nav>
    <div className="min-h-0 flex-1">{children}</div>
  </div>
}
