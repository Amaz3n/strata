"use client"

import { FileText, Upload, FolderOpen, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface DrawingsEmptyStateProps {
  variant: "no-project" | "no-sheets" | "no-sets" | "no-results" | "processing"
  isProcessing?: boolean
  onUpload?: () => void
  className?: string
}

export function DrawingsEmptyState({
  variant,
  isProcessing,
  onUpload,
  className,
}: DrawingsEmptyStateProps) {
  const configs = {
    "no-project": {
      icon: FolderOpen,
      title: "Select a Project",
      description: "Choose a project from the dropdown to view and manage its drawings.",
      showUpload: false,
    },
    "no-sheets": {
      icon: FileText,
      title: isProcessing ? "Processing Sheets" : "No Sheets Yet",
      description: isProcessing
        ? "Your plan set is being processed. Sheets will appear here shortly."
        : "Upload a plan set to automatically generate individual sheets.",
      showUpload: !isProcessing,
    },
    "no-sets": {
      icon: Upload,
      title: "No Plan Sets",
      description: "Upload a PDF plan set to get started with drawings.",
      showUpload: true,
    },
    "no-results": {
      icon: Search,
      title: "No Results",
      description: "Try adjusting your search or filters to find what you're looking for.",
      showUpload: false,
    },
    "processing": {
      icon: FileText,
      title: "Processing Sheets",
      description: "Your plan set is being processed. This usually takes a few seconds.",
      showUpload: false,
    },
  }

  const config = configs[variant]
  const Icon = config.icon

  return (
    <div className={cn("flex flex-col items-center justify-center py-10 sm:py-16 px-4 text-center", className)}>
      <div className="w-14 h-14 flex items-center justify-center bg-muted/50 mb-4">
        <Icon className={cn(
          "h-7 w-7 text-muted-foreground/60",
          isProcessing && "animate-pulse"
        )} />
      </div>
      <h2 className="text-base font-semibold text-foreground mb-1">
        {config.title}
      </h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        {config.description}
      </p>
      {config.showUpload && onUpload && (
        <Button onClick={onUpload} className="mt-4">
          <Upload className="h-4 w-4 mr-2" />
          Upload Plan Set
        </Button>
      )}
    </div>
  )
}
