"use client"

import { cn } from "@/lib/utils"
import { FolderOpen, Files } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { type FileCategory, FILE_CATEGORIES, type FileWithDetails } from "./types"

interface FileCategoryNavProps {
  files: FileWithDetails[]
  selectedCategory: FileCategory | "all"
  onCategoryChange: (category: FileCategory | "all") => void
  className?: string
}

export function FileCategoryNav({
  files,
  selectedCategory,
  onCategoryChange,
  className,
}: FileCategoryNavProps) {
  // Count files by category
  const categoryCounts = files.reduce<Record<string, number>>(
    (acc, file) => {
      const cat = file.category ?? "other"
      acc[cat] = (acc[cat] ?? 0) + 1
      return acc
    },
    {}
  )

  const totalCount = files.length

  return (
    <div className={cn("space-y-1", className)}>
      <div className="px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Categories
        </h3>
      </div>

      <ScrollArea className="h-[400px] px-1">
        <div className="space-y-0.5">
          {/* All files */}
          <Button
            variant={selectedCategory === "all" ? "secondary" : "ghost"}
            className={cn(
              "w-full justify-start gap-3 h-10",
              selectedCategory === "all" && "bg-primary/10"
            )}
            onClick={() => onCategoryChange("all")}
          >
            <Files className="h-4 w-4" />
            <span className="flex-1 text-left">All Files</span>
            <Badge
              variant="secondary"
              className={cn(
                "ml-auto text-xs px-2",
                selectedCategory === "all" && "bg-primary/20"
              )}
            >
              {totalCount}
            </Badge>
          </Button>

          {/* Category items */}
          {(Object.keys(FILE_CATEGORIES) as FileCategory[]).map((cat) => {
            const { label, icon, color } = FILE_CATEGORIES[cat]
            const count = categoryCounts[cat] ?? 0
            const isSelected = selectedCategory === cat

            return (
              <Button
                key={cat}
                variant={isSelected ? "secondary" : "ghost"}
                className={cn(
                  "w-full justify-start gap-3 h-10",
                  isSelected && "bg-primary/10"
                )}
                onClick={() => onCategoryChange(cat)}
              >
                <span className="text-base">{icon}</span>
                <span className="flex-1 text-left truncate">{label}</span>
                {count > 0 && (
                  <Badge
                    variant="secondary"
                    className={cn(
                      "ml-auto text-xs px-2",
                      isSelected && "bg-primary/20"
                    )}
                  >
                    {count}
                  </Badge>
                )}
              </Button>
            )
          })}
        </div>
      </ScrollArea>

      {/* Storage info */}
      <div className="px-3 pt-4 border-t">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Storage used</span>
          <span>
            {formatStorageSize(files.reduce((acc, f) => acc + (f.size_bytes ?? 0), 0))}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{
              width: `${Math.min(
                100,
                (files.reduce((acc, f) => acc + (f.size_bytes ?? 0), 0) /
                  (10 * 1024 * 1024 * 1024)) *
                  100
              )}%`,
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">of 10 GB</p>
      </div>
    </div>
  )
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}







