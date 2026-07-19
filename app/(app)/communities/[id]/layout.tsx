import Link from "next/link"
import { notFound } from "next/navigation"
import type { ReactNode } from "react"

import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { getCommunity } from "@/lib/services/communities"

export default async function CommunityLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params
  const community = await getCommunity(id).catch(() => null)
  if (!community) notFound()
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{community.name}</h1><CommunityStatusBadge status={community.status} /></div><p className="mt-0.5 text-xs text-muted-foreground">{community.divisionName ? `${community.divisionName} · ` : ""}{[community.city, community.state].filter(Boolean).join(", ") || "Community workbench"}</p></div>
      </div>
      <nav className="flex h-10 items-end gap-5 border-b px-4 text-xs">
        <Link className="border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={`/communities/${id}`}>Lots</Link>
        <Link className="border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={`/communities/${id}/land`}>Land</Link>
        <Link className="border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={`/communities/${id}/starts`}>Starts</Link>
        <Link className="border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={`/communities/${id}/sales`}>Sales</Link>
        <Link className="border-b-2 border-transparent pb-2.5 text-muted-foreground hover:border-foreground hover:text-foreground" href={`/communities/${id}/settings`}>Settings</Link>
      </nav>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
