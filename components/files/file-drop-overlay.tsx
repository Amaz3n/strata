"use client"

import { cn } from "@/lib/utils"
import { Upload } from "@/components/icons"

interface FileDropOverlayProps {
  isVisible: boolean
  className?: string
}

export function FileDropOverlay({ isVisible, className }: FileDropOverlayProps) {
  if (!isVisible) return null

  return (
    <div
      className={cn(
        "absolute inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg transition-all animate-in fade-in duration-150",
        className
      )}
    >
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/20 ring-4 ring-primary/10">
          <Upload className="h-8 w-8 text-primary" />
        </div>
        <div>
          <p className="text-lg font-semibold text-primary">Drop files to upload</p>
          <p className="text-sm text-muted-foreground mt-1">
            Release to add files to this project
          </p>
        </div>
      </div>
    </div>
  )
}






