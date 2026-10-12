"use client"

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsError, SettingsField, SettingsGroup } from "@/components/settings/settings-section"

type Source = "changes" | "access"

interface CompletedExport {
  digest: string
  rows: string
  filename: string
  source: Source
}

const SOURCES: Source[] = ["changes", "access"]

const SOURCE_LABELS: Record<Source, string> = {
  changes: "Changes",
  access: "Access decisions",
}

function localDay(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function daysAgo(days: number) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return localDay(date)
}

/** Local midnight at the start of `day`, `offset` days later, as an instant. */
function startOfDay(day: string, offset = 0) {
  const [year, month, date] = day.split("-").map(Number)
  return new Date(year, month - 1, date + offset).toISOString()
}

function filenameFrom(disposition: string | null) {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "arc-audit-export.csv"
}

/**
 * The auditor's export. Every row of the chosen record set in the range, for the
 * whole organization, as a CSV whose digest can be checked without Arc. The
 * server decides who may export; this group only appears for audit readers.
 */
export function AuditExportGroup() {
  const [source, setSource] = useState<Source>("changes")
  const [from, setFrom] = useState(() => daysAgo(90))
  const [to, setTo] = useState(() => localDay(new Date()))
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<CompletedExport | null>(null)

  const rangeError = from && to && from > to ? "The start date is after the end date." : null
  const canExport = Boolean(from && to) && !rangeError && !exporting

  const runExport = async () => {
    setError(null)
    setExporting(true)
    try {
      const params = new URLSearchParams({ source, from: startOfDay(from), to: startOfDay(to, 1) })
      const response = await fetch(`/api/audit/export?${params}`, { cache: "no-store" })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
            ? body.error
            : "The audit export could not be produced."
        setError(message)
        return
      }
      const blob = await response.blob()
      const filename = filenameFrom(response.headers.get("Content-Disposition"))
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      setLast({
        digest: (response.headers.get("X-Arc-Export-Digest") ?? "").replace(/^sha256:/, ""),
        rows: response.headers.get("X-Arc-Export-Rows") ?? "0",
        filename,
        source,
      })
      toast.success("Audit export downloaded")
    } catch {
      setError("The audit export could not be downloaded. Check your connection and try again.")
    } finally {
      setExporting(false)
    }
  }

  return (
    <SettingsGroup
      title="Audit trail"
      description="Every change and access decision is kept unaltered for the life of this account; nothing purges it. Exports cover the whole organization and carry a SHA-256 digest an auditor can verify."
    >
      <SettingsField label="Records" htmlFor="audit-export-source" hint="Changes hold each record's before and after. Access decisions hold every refusal and sampled approval.">
        <Select value={source} onValueChange={(value) => setSource(value === "access" ? "access" : "changes")}>
          <SelectTrigger id="audit-export-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((key) => (
              <SelectItem key={key} value={key}>
                {SOURCE_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsField>
      <SettingsField label="Range" htmlFor="audit-export-from" hint="Both days included, in your local time.">
        <div className="flex items-center gap-2">
          <Input
            id="audit-export-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
            aria-label="From"
            className="tabular-nums"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            id="audit-export-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
            aria-label="To"
            className="tabular-nums"
          />
        </div>
        {rangeError ? <SettingsError className="mt-2">{rangeError}</SettingsError> : null}
      </SettingsField>
      <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1">
          {error ? <SettingsError>{error}</SettingsError> : null}
          {exporting ? (
            <div className="space-y-1.5" aria-label="Preparing export">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          ) : null}
          {!exporting && !error && last ? (
            <div className="min-w-0 text-xs leading-5">
              <p className="text-foreground">
                <span className="font-medium">{SOURCE_LABELS[last.source]}</span>
                <span className="text-muted-foreground"> · </span>
                <span className="tabular-nums">{Number(last.rows).toLocaleString()} rows</span>
                <span className="text-muted-foreground"> · {last.filename}</span>
              </p>
              <p className="break-all font-mono text-muted-foreground">sha256:{last.digest}</p>
            </div>
          ) : null}
          {!exporting && !error && !last ? (
            <p className="text-xs leading-5 text-muted-foreground">
              No export yet. The file's digest appears here so you can hand it to the auditor separately.
            </p>
          ) : null}
        </div>
        <Button size="sm" className="shrink-0" onClick={runExport} disabled={!canExport}>
          {exporting ? "Exporting..." : "Export CSV"}
        </Button>
      </div>
    </SettingsGroup>
  )
}
