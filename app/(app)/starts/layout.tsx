import type { ReactNode } from "react"

import { StartsNav } from "@/components/starts/starts-nav"
import { getStartAttentionCount } from "@/lib/services/starts"

export default async function StartsLayout({ children }: { children: ReactNode }) {
  const attentionCount = await getStartAttentionCount().catch(() => 0)
  return (
    <div className="flex min-h-full flex-col">
      <StartsNav attentionCount={attentionCount} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
