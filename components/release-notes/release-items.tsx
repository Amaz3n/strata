import Link from "next/link"

import type { ReleaseNoteItem } from "@/lib/services/release-notes"
import { cn } from "@/lib/utils"

import { ITEM_TYPE_META, groupItemsByType } from "./release-meta"

/**
 * The shipped features of a release, one block per change type. Shared by What's New and the
 * announcement dialog so the two stay in step. `detailed` adds the per-item detail line and
 * deep links, which the dialog deliberately leaves out to stay a summary.
 */
export function ReleaseItemGroups({
  items,
  detailed = false,
}: {
  items: ReleaseNoteItem[]
  detailed?: boolean
}) {
  if (items.length === 0) return null

  return (
    <div className="flex flex-col gap-5">
      {groupItemsByType(items).map((group) => (
        <div
          key={group.type}
          className="grid gap-x-4 gap-y-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]"
        >
          <span className="flex items-center gap-1.5 self-start text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:mt-[0.2rem]">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0", ITEM_TYPE_META[group.type].dotClassName)}
            />
            {ITEM_TYPE_META[group.type].label}
          </span>

          <ul className={cn("flex min-w-0 flex-col", detailed ? "gap-3" : "gap-1.5")}>
            {group.items.map((item, index) => (
              <li key={index} className="min-w-0 text-sm leading-relaxed text-foreground">
                {detailed && item.href ? (
                  <Link href={item.href} className="hover:underline">
                    {item.title}
                  </Link>
                ) : (
                  item.title
                )}
                {detailed && item.detail && (
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {item.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
