"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import {
  setBooksWorkspaceEnabledAction,
  updateBooksFiscalSettingsAction,
} from "@/app/(app)/settings/accounting-actions"
import { ArrowRight, FileSpreadsheet, Link2, Lock, ShieldCheck } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingsError, SettingsField, SettingsGroup, SettingsToggle } from "@/components/settings/settings-section"
import type { getBooksModuleSettings } from "@/lib/services/books/module"

type ModuleSettings = Awaited<ReturnType<typeof getBooksModuleSettings>>

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function AccountingSettingsPanel({
  initialSettings,
  canManage,
}: {
  initialSettings: ModuleSettings
  canManage: boolean
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialSettings.enabled)
  const [fiscalMonth, setFiscalMonth] = useState(String(initialSettings.settings?.fiscal_year_start_month ?? 1))
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const settings = initialSettings.settings

  const toggleBooks = (nextEnabled: boolean) => {
    if (!nextEnabled && !window.confirm("Disable the Arc Books workspace? Existing ledger data is preserved, and connected accounting systems will keep syncing normally.")) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await setBooksWorkspaceEnabledAction(nextEnabled)
      if (!result.success) {
        setError(result.error ?? "Unable to update Arc Books")
        return
      }
      setEnabled(nextEnabled)
      toast.success(nextEnabled ? "Arc Books enabled" : "Arc Books disabled")
      router.refresh()
    })
  }

  const saveFiscalMonth = () => {
    setError(null)
    startTransition(async () => {
      const result = await updateBooksFiscalSettingsAction(Number(fiscalMonth))
      if (!result.success) {
        setError(result.error ?? "Unable to update fiscal settings")
        return
      }
      toast.success("Accounting calendar updated")
      router.refresh()
    })
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-5 py-8 lg:px-8 lg:py-10">
      <div className="border-l-2 border-primary pl-4">
        <p className="microlabel">Accounting strategy</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight">Choose how far Arc goes.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          External accounting connections are always independent. Arc can keep syncing invoices, bills, expenses, and payments to QuickBooks or another provider whether Arc Books is on or off.
        </p>
      </div>

      <SettingsGroup
        title="Arc Books workspace"
        description="An optional construction-native general ledger, bank reconciliation, period close, and accountant handoff inside Arc."
      >
        <SettingsToggle
          id="arc-books-enabled"
          label="Enable Arc Books"
          checked={enabled}
          onCheckedChange={toggleBooks}
          disabled={pending || !canManage || (enabled && !initialSettings.canDisable)}
          description={
            enabled && !initialSettings.canDisable
              ? "Arc is the official ledger. Disablement requires the controlled rollback or migration workflow."
              : "When off, Books disappears from Arc and Books-only jobs stop. No ledger data or external accounting connection is deleted."
          }
        />
        {error ? <SettingsError className="py-3">{error}</SettingsError> : null}
        {!canManage ? (
          <div className="flex items-start gap-2 py-4 text-xs leading-5 text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            Organization admin access is required to change the accounting workspace.
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="Books of record"
        description="Authority is deliberately separate from whether the Arc Books interface is visible."
      >
        <div className="grid gap-4 py-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Official ledger</p>
            <p className="mt-1 text-sm font-medium">{settings?.ledger_authority === "arc" ? "Arc Books" : "External provider"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Arc ledger mode</p>
            <p className="mt-1 text-sm font-medium">{humanize(settings?.arc_ledger_mode ?? "disabled")}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">External sync</p>
            <p className="mt-1 text-sm font-medium">{humanize(settings?.external_sync_posture ?? "normal")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 py-4 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0 text-success" />
          Enabling Books starts in shadow mode. Making Arc official is a separate dual-approved cutover with reconciliation prerequisites.
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="External accounting"
        description="Connections and entity routing continue to operate even when Arc Books is disabled."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/settings?tab=integrations">
              Manage connections <ArrowRight className="ml-1.5 size-3.5" />
            </Link>
          </Button>
        }
      >
        {initialSettings.connections.length > 0 ? initialSettings.connections.map((connection) => (
          <div key={connection.id} className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <Link2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{connection.label || humanize(connection.provider)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {connection.last_sync_at ? `Last sync ${connection.last_sync_at.slice(0, 16).replace("T", " ")} UTC` : "Ready for accounting routing"}
                </p>
              </div>
            </div>
            <Badge variant="outline">{humanize(connection.status)}</Badge>
          </div>
        )) : (
          <div className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
            <Link2 className="size-4" /> No accounting provider connected yet.
          </div>
        )}
      </SettingsGroup>

      {enabled ? (
        <SettingsGroup title="Ledger policy" description="Organization-wide accounting calendar and immutable reporting basis.">
          <SettingsField label="Fiscal year starts" htmlFor="fiscal-year-start" hint="Used to organize periods and year-end close controls.">
            <div className="flex max-w-sm items-center gap-2">
              <Select value={fiscalMonth} onValueChange={setFiscalMonth} disabled={!canManage || pending}>
                <SelectTrigger id="fiscal-year-start"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((month, index) => <SelectItem key={month} value={String(index + 1)}>{month}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" onClick={saveFiscalMonth} disabled={!canManage || pending || Number(fiscalMonth) === settings?.fiscal_year_start_month}>Save</Button>
            </div>
          </SettingsField>
          <SettingsField label="Reporting basis" hint="Arc Books currently posts accrual-basis construction accounting.">
            <p className="pt-2 text-sm font-medium">Accrual</p>
          </SettingsField>
          <SettingsField label="Functional currency" hint="The ledger currency cannot be changed after transactions are posted.">
            <p className="pt-2 text-sm font-medium uppercase">{settings?.functional_currency ?? "USD"}</p>
          </SettingsField>
        </SettingsGroup>
      ) : null}

      {enabled ? (
        <div className="border bg-muted/30 p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
          <div className="flex items-start gap-3">
            <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium">Accounting workspace is ready</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Open the ledger, banking, close, accountant, and optional cutover workspaces.</p>
            </div>
          </div>
          <Button asChild className="mt-4 sm:mt-0"><Link href="/books">Open Arc Books</Link></Button>
        </div>
      ) : null}
    </div>
  )
}
