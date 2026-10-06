import { FileWarning } from "lucide-react"

import type { DrawingSheet } from "@/lib/services/drawings"
import { cn } from "@/lib/utils"

/** A sheet's rendered preview, top-aligned the way a title block reads; a quiet placeholder until it renders. */
export function SheetThumbnail({ sheet, className }: { sheet: Pick<DrawingSheet, "image_thumbnail_url">; className?: string }) {
  const url = sheet.image_thumbnail_url
  if (!url) {
    return (
      <div className={cn("flex items-center justify-center border bg-muted text-muted-foreground", className)}>
        <FileWarning className="h-3 w-3" />
      </div>
    )
  }
  return <img src={url} alt="" loading="lazy" className={cn("border bg-background object-cover object-top", className)} />
}
