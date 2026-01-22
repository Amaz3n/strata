"use client"

import { cn } from "@/lib/utils"
import { FileText, Check, Users, Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { SheetStatusDots } from "./sheet-status-dots"
import type { DrawingSheet, SheetStatusCounts } from "@/app/(app)/drawings/actions"

interface SheetCardProps {
  sheet: DrawingSheet
  statusCounts?: SheetStatusCounts
  isSelected?: boolean
  isKeyboardFocused?: boolean
  onSelect?: () => void
  onToggleSelection?: (e: React.MouseEvent) => void
  className?: string
}

export function SheetCard({
  sheet,
  statusCounts,
  isSelected,
  isKeyboardFocused,
  onSelect,
  onToggleSelection,
  className,
}: SheetCardProps) {
  const tileThumbnailUrl = sheet.tile_base_url && sheet.thumbnail_url ? sheet.thumbnail_url : null
  const thumbnailSrc = tileThumbnailUrl ?? sheet.image_thumbnail_url ?? sheet.thumbnail_url

  return (
    <div
      className={cn(
        "group relative bg-card border border-border/60 overflow-hidden transition-all duration-150",
        "hover:border-border hover:shadow-sm",
        "active:scale-[0.98] active:shadow-none",
        "cursor-pointer",
        isSelected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
        isKeyboardFocused && !isSelected && "ring-2 ring-primary/50 ring-offset-1 ring-offset-background",
        className
      )}
      onClick={onSelect}
    >
      {/* Thumbnail area */}
      <div className="aspect-[8.5/11] bg-muted/50 relative overflow-hidden">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={sheet.sheet_number}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <FileText className="h-8 w-8 sm:h-10 sm:w-10 text-muted-foreground/40" />
          </div>
        )}

        {/* Selection checkbox - top left, larger touch target on mobile */}
        <button
          className={cn(
            "absolute top-1.5 left-1.5 sm:top-2 sm:left-2",
            "w-6 h-6 sm:w-5 sm:h-5 flex items-center justify-center",
            "border bg-background/90 backdrop-blur-sm transition-all duration-150",
            // Always visible on mobile (no hover), hidden on desktop until hover
            "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
            isSelected && "opacity-100 bg-primary border-primary"
          )}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelection?.(e)
          }}
        >
          {isSelected && <Check className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-primary-foreground" strokeWidth={2.5} />}
        </button>

        {/* Sharing badges - top right */}
        {(sheet.share_with_clients || sheet.share_with_subs) && (
          <div className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 flex gap-0.5 sm:gap-1">
            {sheet.share_with_clients && (
              <div className="w-5 h-5 flex items-center justify-center bg-background/90 backdrop-blur-sm border border-border/60">
                <Users className="h-3 w-3 text-muted-foreground" />
              </div>
            )}
            {sheet.share_with_subs && (
              <div className="w-5 h-5 flex items-center justify-center bg-background/90 backdrop-blur-sm border border-border/60">
                <Building2 className="h-3 w-3 text-muted-foreground" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Info section - tighter on mobile */}
      <div className="p-2 sm:p-2.5 space-y-0.5 sm:space-y-1">
        <div className="flex items-start justify-between gap-1.5 sm:gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-xs sm:text-sm leading-tight truncate">
              {sheet.sheet_number}
            </p>
            <p className="text-[11px] sm:text-xs text-muted-foreground truncate mt-0.5">
              {sheet.sheet_title || "Untitled"}
            </p>
            {sheet.current_revision_label && (
              <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5">
                Rev {sheet.current_revision_label}
              </p>
            )}
          </div>
          {sheet.discipline && (
            <Badge variant="secondary" className="text-[9px] sm:text-[10px] px-1 sm:px-1.5 py-0 h-4 shrink-0 font-medium">
              {sheet.discipline}
            </Badge>
          )}
        </div>

        {statusCounts && (statusCounts.open > 0 || statusCounts.inProgress > 0 || statusCounts.completed > 0) && (
          <SheetStatusDots counts={statusCounts} size="sm" />
        )}
      </div>
    </div>
  )
}
