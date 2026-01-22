"use client"

import { cn } from "@/lib/utils"
import {
  FileText,
  CheckCircle2,
  AlertCircle,
  Clock,
  RefreshCw,
  MoreHorizontal,
  Trash2,
  ChevronRight,
  FileStack,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DrawingSet } from "@/app/(app)/drawings/actions"

interface PlanSetCardProps {
  set: DrawingSet
  onRetry?: () => void
  onDelete?: () => void
  onViewSheets?: () => void
  className?: string
}

export function PlanSetCard({
  set,
  onRetry,
  onDelete,
  onViewSheets,
  className,
}: PlanSetCardProps) {
  const progress = set.total_pages ? (set.processed_pages / set.total_pages) * 100 : 0

  return (
    <div
      className={cn(
        "group bg-card border border-border/60 p-4 transition-all duration-150",
        "hover:border-border hover:shadow-sm",
        className
      )}
    >
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div className={cn(
          "shrink-0 w-12 h-12 flex items-center justify-center bg-muted/50",
          set.status === "processing" && "bg-blue-500/10",
          set.status === "ready" && "bg-success/10",
          set.status === "failed" && "bg-destructive/10"
        )}>
          <FileStack className={cn(
            "h-6 w-6",
            set.status === "processing" && "text-blue-500",
            set.status === "ready" && "text-success",
            set.status === "failed" && "text-destructive",
            !["processing", "ready", "failed"].includes(set.status || "") && "text-muted-foreground"
          )} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="font-medium text-sm truncate">{set.title}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {set.sheet_count ?? 0} sheets
                {set.description && <span className="mx-1.5">·</span>}
                {set.description && <span className="truncate">{set.description}</span>}
              </p>
            </div>

            {/* Status badge */}
            <div className="shrink-0 flex items-center gap-2">
              {set.status === "processing" && (
                <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 border-0">
                  <Clock className="h-3 w-3 mr-1 animate-pulse" />
                  Processing
                </Badge>
              )}
              {set.status === "ready" && (
                <Badge variant="secondary" className="bg-success/10 text-success border-0">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Ready
                </Badge>
              )}
              {set.status === "failed" && (
                <Badge variant="secondary" className="bg-destructive/10 text-destructive border-0">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Failed
                </Badge>
              )}
            </div>
          </div>

          {/* Progress bar for processing */}
          {set.status === "processing" && (
            <div className="mt-3 flex items-center gap-3">
              <Progress value={progress} className="h-1.5 flex-1" />
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {set.processed_pages}/{set.total_pages ?? "?"}
              </span>
            </div>
          )}

          {/* Error message */}
          {set.status === "failed" && set.error_message && (
            <p className="mt-2 text-xs text-destructive line-clamp-2">
              {set.error_message}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="shrink-0 flex items-center gap-1">
          {set.status === "failed" && onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} className="h-8">
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Retry
            </Button>
          )}

          {set.status === "ready" && onViewSheets && (
            <Button variant="ghost" size="sm" onClick={onViewSheets} className="h-8">
              View Sheets
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDelete} className="text-destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
