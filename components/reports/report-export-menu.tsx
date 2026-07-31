"use client"

import { useSearchParams } from "next/navigation"

import type { ReportFormat } from "@/lib/reports/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown, Download, FileSpreadsheet, FileText } from "@/components/icons"

const FORMAT_LABELS: Record<ReportFormat, { label: string; icon: typeof FileText }> = {
  csv: { label: "Download CSV", icon: FileSpreadsheet },
  pdf: { label: "Download PDF", icon: FileText },
  json: { label: "Download JSON", icon: Download },
}

/**
 * Exports carry the current parameters and the ambient scope, so the file always
 * matches what is on screen. Every download writes an immutable report run.
 */
export function ReportExportMenu({
  slug,
  projectId,
  formats,
}: {
  slug: string
  projectId?: string
  formats: ReportFormat[]
}) {
  const searchParams = useSearchParams()

  function href(format: ReportFormat) {
    const params = new URLSearchParams(searchParams.toString())
    params.set("format", format)
    if (projectId) params.set("projectId", projectId)
    return `/api/reports/${slug}?${params.toString()}`
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="size-4" />
          Export
          <ChevronDown className="size-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {formats.map((format) => {
          const { label, icon: Icon } = FORMAT_LABELS[format]
          return (
            <DropdownMenuItem key={format} asChild>
              <a href={href(format)} download>
                <Icon className="size-4" />
                {label}
              </a>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
