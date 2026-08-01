"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  replacePaymentFeePolicyAction,
  retireOrganizationPaymentFeePolicyAction,
} from "@/app/(app)/admin/payment-fees/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertTriangle, Building2, DollarSign, History, Plus, Receipt, Settings } from "@/components/icons"
import { unwrapAction } from "@/lib/action-result"
import type {
  PaymentFeePolicyOrganization,
  PaymentFeePolicyRecord,
} from "@/lib/services/payment-fee-policies"

type PolicyForm = {
  scope: "platform" | "organization"
  orgId: string
  passThroughProcessorFees: boolean
  processorPercent: string
  processorFixedDollars: string
  processorCapDollars: string
  platformPercent: string
  platformFlatDollars: string
  markupConfirmed: boolean
}

const PAYMENT_EXAMPLE_CENTS = 1_000_000

function centsToInput(value: number | null) {
  return value == null ? "" : (value / 100).toFixed(2)
}

function bpsToInput(value: number | null) {
  return value == null ? "" : (value / 100).toFixed(2)
}

function parseOptionalCents(value: string) {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error("Enter a valid dollar amount.")
  return Math.round(amount * 100)
}

function parseCents(value: string) {
  return parseOptionalCents(value) ?? 0
}

function parseOptionalBps(value: string) {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error("Enter a valid percentage.")
  return Math.round(amount * 100)
}

function parseBps(value: string) {
  return parseOptionalBps(value) ?? 0
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function policyForm(scope: "platform" | "organization", policy?: PaymentFeePolicyRecord): PolicyForm {
  return {
    scope,
    orgId: policy?.orgId ?? "",
    passThroughProcessorFees: policy?.passThroughProcessorFees ?? true,
    processorPercent: bpsToInput(policy?.processorFeeBps ?? null),
    processorFixedDollars: centsToInput(policy?.processorFeeFixedCents ?? null),
    processorCapDollars: centsToInput(policy?.processorFeeCapCents ?? null),
    platformPercent: bpsToInput(policy?.platformFeeBps ?? 0),
    platformFlatDollars: centsToInput(policy?.platformFeeFlatCents ?? 0),
    markupConfirmed: false,
  }
}

function FeeSummary({ policy }: { policy: PaymentFeePolicyRecord }) {
  const processorParts = policy.passThroughProcessorFees
    ? [
        policy.processorFeeBps == null ? null : `${(policy.processorFeeBps / 100).toFixed(2)}%`,
        policy.processorFeeFixedCents == null ? null : money(policy.processorFeeFixedCents),
      ].filter(Boolean)
    : []
  const arcParts = [
    policy.platformFeeBps > 0 ? `${(policy.platformFeeBps / 100).toFixed(2)}%` : null,
    policy.platformFeeFlatCents > 0 ? money(policy.platformFeeFlatCents) : null,
  ].filter(Boolean)

  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <div className="border-l-2 border-primary/60 pl-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Processor cost</p>
        <p className="mt-1 font-medium">
          {policy.passThroughProcessorFees ? processorParts.join(" + ") || "Incomplete" : "Absorbed by Arc"}
        </p>
        {policy.processorFeeCapCents != null && policy.passThroughProcessorFees ? (
          <p className="text-xs text-muted-foreground">Capped at {money(policy.processorFeeCapCents)}</p>
        ) : null}
      </div>
      <div className="border-l-2 border-warning/60 pl-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Arc transaction fee</p>
        <p className="mt-1 font-medium">{arcParts.join(" + ") || "$0.00 — no markup"}</p>
        <p className="text-xs text-muted-foreground">Applied to each AP disbursement</p>
      </div>
    </div>
  )
}

export function PaymentFeesClient({
  initialPolicies,
  organizations,
}: {
  initialPolicies: PaymentFeePolicyRecord[]
  organizations: PaymentFeePolicyOrganization[]
}) {
  const router = useRouter()
  const [form, setForm] = useState<PolicyForm | null>(null)
  const [retireTarget, setRetireTarget] = useState<PaymentFeePolicyRecord | null>(null)
  const [isPending, startTransition] = useTransition()

  const activePolicies = useMemo(
    () => initialPolicies.filter((policy) => policy.effectiveTo == null),
    [initialPolicies],
  )
  const platformPolicy = activePolicies.find((policy) => policy.orgId == null) ?? null
  const orgPolicies = activePolicies
    .filter((policy) => policy.orgId != null)
    .sort((a, b) => (a.orgName ?? "").localeCompare(b.orgName ?? ""))
  const historicalPolicies = initialPolicies.filter((policy) => policy.effectiveTo != null)
  const organizationsWithoutOverrides = organizations.filter(
    (org) => !orgPolicies.some((policy) => policy.orgId === org.id),
  )

  function openPlatformPolicy() {
    setForm(policyForm("platform", platformPolicy ?? undefined))
  }

  function openOrganizationPolicy(policy?: PaymentFeePolicyRecord) {
    const source = policy ?? platformPolicy ?? undefined
    setForm({
      ...policyForm("organization", source),
      scope: "organization",
      orgId: policy?.orgId ?? organizationsWithoutOverrides[0]?.id ?? "",
    })
  }

  function savePolicy() {
    if (!form) return

    startTransition(async () => {
      try {
        const platformFeeFlatCents = parseCents(form.platformFlatDollars)
        const platformFeeBps = parseBps(form.platformPercent)
        unwrapAction(await replacePaymentFeePolicyAction({
          orgId: form.scope === "organization" ? form.orgId : null,
          passThroughProcessorFees: form.passThroughProcessorFees,
          processorFeeBps: form.passThroughProcessorFees ? parseOptionalBps(form.processorPercent) : null,
          processorFeeFixedCents: form.passThroughProcessorFees ? parseOptionalCents(form.processorFixedDollars) : null,
          processorFeeCapCents: form.passThroughProcessorFees ? parseOptionalCents(form.processorCapDollars) : null,
          platformFeeFlatCents,
          platformFeeBps,
          markupConfirmed: platformFeeFlatCents === 0 && platformFeeBps === 0 ? true : form.markupConfirmed,
        }))
        toast.success("Payment fee policy saved", {
          description: "The prior version was retained in policy history.",
        })
        setForm(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save fee policy", {
          description: error instanceof Error ? error.message : "Please check the fee inputs and try again.",
        })
      }
    })
  }

  function retireOverride() {
    if (!retireTarget?.orgId) return
    startTransition(async () => {
      try {
        unwrapAction(await retireOrganizationPaymentFeePolicyAction({ orgId: retireTarget.orgId }))
        toast.success("Organization override retired", {
          description: `${retireTarget.orgName} now uses the platform default.`,
        })
        setRetireTarget(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to retire override", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const preview = useMemo(() => {
    if (!form) return null
    try {
      const processorUncapped = Math.round(PAYMENT_EXAMPLE_CENTS * (parseOptionalBps(form.processorPercent) ?? 0) / 10_000)
        + (parseOptionalCents(form.processorFixedDollars) ?? 0)
      const cap = parseOptionalCents(form.processorCapDollars)
      const processorFee = form.passThroughProcessorFees
        ? cap == null ? processorUncapped : Math.min(processorUncapped, cap)
        : 0
      const arcFee = Math.round(PAYMENT_EXAMPLE_CENTS * parseBps(form.platformPercent) / 10_000)
        + parseCents(form.platformFlatDollars)
      return { processorFee, arcFee, total: PAYMENT_EXAMPLE_CENTS + processorFee + arcFee }
    } catch {
      return null
    }
  }, [form])

  const formHasMarkup = form
    ? (Number(form.platformPercent) || 0) > 0 || (Number(form.platformFlatDollars) || 0) > 0
    : false

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {!platformPolicy ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>AP fee pricing is not configured</AlertTitle>
          <AlertDescription>
            Payment runs are blocked until a platform default exists. Enter the provider pricing you have approved; Arc markup can remain zero.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-px overflow-hidden border bg-border md:grid-cols-3">
        <div className="bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Platform default</p>
          <p className="mt-2 text-2xl font-semibold">{platformPolicy ? "Active" : "Missing"}</p>
          <p className="mt-1 text-sm text-muted-foreground">Fallback pricing for every organization</p>
        </div>
        <div className="bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Organization overrides</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{orgPolicies.length}</p>
          <p className="mt-1 text-sm text-muted-foreground">Explicit customer pricing exceptions</p>
        </div>
        <div className="bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Arc fee posture</p>
          <p className="mt-2 text-2xl font-semibold">
            {activePolicies.some((policy) => policy.platformFeeBps > 0 || policy.platformFeeFlatCents > 0)
              ? "Markup active"
              : "No markup"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Processor cost remains separately visible</p>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle className="flex items-center gap-2"><Receipt className="h-4 w-4" /> Platform default</CardTitle>
            <CardDescription className="mt-1">
              Used when an organization does not have a customer-specific override.
            </CardDescription>
          </div>
          <div data-slot="card-action">
            <Button variant={platformPolicy ? "outline" : "default"} onClick={openPlatformPolicy}>
              <Settings className="mr-2 h-4 w-4" />
              {platformPolicy ? "Create new version" : "Configure default"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {platformPolicy ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Active</Badge>
                <Badge variant="outline">
                  {platformPolicy.pricingModel === "custom" ? "Custom pricing" : "Subscription + pass-through"}
                </Badge>
                <span className="text-xs text-muted-foreground">Effective {dateTime(platformPolicy.effectiveFrom)}</span>
              </div>
              <FeeSummary policy={platformPolicy} />
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No default has been approved. Arc will not guess processor pricing.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" /> Organization overrides</CardTitle>
            <CardDescription className="mt-1">
              Exceptions replace the platform default only for the selected organization.
            </CardDescription>
          </div>
          <div data-slot="card-action">
            <Button
              variant="outline"
              onClick={() => openOrganizationPolicy()}
              disabled={organizationsWithoutOverrides.length === 0}
            >
              <Plus className="mr-2 h-4 w-4" /> New override
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {orgPolicies.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              No organization overrides. Every organization uses the platform default.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Organization</TableHead>
                  <TableHead>Processor pass-through</TableHead>
                  <TableHead>Arc fee</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgPolicies.map((policy) => (
                  <TableRow key={policy.id}>
                    <TableCell className="pl-6 font-medium">{policy.orgName}</TableCell>
                    <TableCell>{policy.passThroughProcessorFees ? "Yes" : "No — Arc absorbs it"}</TableCell>
                    <TableCell>
                      {policy.platformFeeBps === 0 && policy.platformFeeFlatCents === 0
                        ? "$0.00"
                        : `${(policy.platformFeeBps / 100).toFixed(2)}% + ${money(policy.platformFeeFlatCents)}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{dateTime(policy.effectiveFrom)}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openOrganizationPolicy(policy)}>New version</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRetireTarget(policy)}>Use default</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><History className="h-4 w-4" /> Policy history</CardTitle>
          <CardDescription>Closed versions are read-only and remain available for audit and reconciliation.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {historicalPolicies.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">No prior versions yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Scope</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Effective period</TableHead>
                  <TableHead className="pr-6">Created by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historicalPolicies.map((policy) => (
                  <TableRow key={policy.id}>
                    <TableCell className="pl-6 font-medium">{policy.orgName ?? "Platform default"}</TableCell>
                    <TableCell>{policy.pricingModel === "custom" ? "Custom" : "Pass-through"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {dateTime(policy.effectiveFrom)} – {policy.effectiveTo ? dateTime(policy.effectiveTo) : "Active"}
                    </TableCell>
                    <TableCell className="pr-6 text-muted-foreground">{policy.createdByName ?? "System"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={Boolean(form)} onOpenChange={(open) => !open && setForm(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {form ? (
            <>
              <SheetHeader className="border-b px-6 py-5">
                <SheetTitle>{form.scope === "platform" ? "Platform fee default" : "Organization fee override"}</SheetTitle>
                <SheetDescription>
                  Saving creates a new effective version. Existing payment records keep their original fee snapshots.
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-7 px-6 py-2">
                {form.scope === "organization" ? (
                  <div className="space-y-2">
                    <Label htmlFor="fee-org">Organization</Label>
                    <Select
                      value={form.orgId}
                      onValueChange={(orgId) => setForm({ ...form, orgId })}
                      disabled={Boolean(activePolicies.find((policy) => policy.orgId === form.orgId))}
                    >
                      <SelectTrigger id="fee-org"><SelectValue placeholder="Select an organization" /></SelectTrigger>
                      <SelectContent>
                        {organizations
                          .filter((org) => org.id === form.orgId || !orgPolicies.some((policy) => policy.orgId === org.id))
                          .map((org) => <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <section className="space-y-4">
                  <div>
                    <h3 className="font-medium">Processor cost</h3>
                    <p className="text-sm text-muted-foreground">Enter the contracted provider cost. These values are not Arc revenue.</p>
                  </div>
                  <div className="flex items-center justify-between border p-4">
                    <div>
                      <Label htmlFor="pass-through">Pass processor cost to the organization</Label>
                      <p className="mt-1 text-xs text-muted-foreground">Turn off only if Arc has decided to absorb provider costs.</p>
                    </div>
                    <Switch
                      id="pass-through"
                      checked={form.passThroughProcessorFees}
                      onCheckedChange={(checked) => setForm({ ...form, passThroughProcessorFees: checked })}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FeeInput
                      id="processor-percent"
                      label="Processor percentage"
                      suffix="%"
                      value={form.processorPercent}
                      disabled={!form.passThroughProcessorFees}
                      onChange={(processorPercent) => setForm({ ...form, processorPercent })}
                    />
                    <FeeInput
                      id="processor-fixed"
                      label="Processor fixed fee"
                      prefix="$"
                      value={form.processorFixedDollars}
                      disabled={!form.passThroughProcessorFees}
                      onChange={(processorFixedDollars) => setForm({ ...form, processorFixedDollars })}
                    />
                  </div>
                  <FeeInput
                    id="processor-cap"
                    label="Processor fee cap (optional)"
                    prefix="$"
                    value={form.processorCapDollars}
                    disabled={!form.passThroughProcessorFees}
                    onChange={(processorCapDollars) => setForm({ ...form, processorCapDollars })}
                  />
                </section>

                <section className="space-y-4 border-t pt-6">
                  <div>
                    <h3 className="font-medium">Arc transaction fee</h3>
                    <p className="text-sm text-muted-foreground">Leave both fields at zero for the approved subscription + pass-through model.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FeeInput
                      id="arc-percent"
                      label="Arc percentage"
                      suffix="%"
                      value={form.platformPercent}
                      onChange={(platformPercent) => setForm({ ...form, platformPercent, markupConfirmed: false })}
                    />
                    <FeeInput
                      id="arc-flat"
                      label="Arc flat fee"
                      prefix="$"
                      value={form.platformFlatDollars}
                      onChange={(platformFlatDollars) => setForm({ ...form, platformFlatDollars, markupConfirmed: false })}
                    />
                  </div>
                  {formHasMarkup ? (
                    <Alert>
                      <AlertTriangle />
                      <AlertTitle>This adds Arc transaction revenue</AlertTitle>
                      <AlertDescription>
                        <label className="mt-2 flex cursor-pointer items-start gap-2 text-foreground">
                          <Checkbox
                            checked={form.markupConfirmed}
                            onCheckedChange={(checked) => setForm({ ...form, markupConfirmed: checked === true })}
                          />
                          <span>I confirm this non-zero Arc fee is commercially approved.</span>
                        </label>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </section>

                <section className="space-y-3 border-t pt-6">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    <h3 className="font-medium">Example on a {money(PAYMENT_EXAMPLE_CENTS)} vendor payment</h3>
                  </div>
                  <div className="grid grid-cols-3 gap-px overflow-hidden border bg-border text-sm">
                    <PreviewCell label="Processor" value={preview ? money(preview.processorFee) : "—"} />
                    <PreviewCell label="Arc" value={preview ? money(preview.arcFee) : "—"} />
                    <PreviewCell label="Total debit" value={preview ? money(preview.total) : "—"} strong />
                  </div>
                </section>
              </div>

              <SheetFooter className="border-t px-6 py-4 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setForm(null)} disabled={isPending}>Cancel</Button>
                <Button
                  onClick={savePolicy}
                  disabled={isPending || (form.scope === "organization" && !form.orgId) || (formHasMarkup && !form.markupConfirmed)}
                >
                  {isPending ? "Saving…" : "Create effective version"}
                </Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog open={Boolean(retireTarget)} onOpenChange={(open) => !open && setRetireTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use the platform default?</AlertDialogTitle>
            <AlertDialogDescription>
              This closes the active override for {retireTarget?.orgName}. The organization will immediately fall back to the platform default. The old version remains in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); retireOverride() }} disabled={isPending || !platformPolicy}>
              {isPending ? "Updating…" : "Use platform default"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FeeInput({
  id,
  label,
  value,
  onChange,
  prefix,
  suffix,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  prefix?: string
  suffix?: string
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {prefix ? <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span> : null}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min="0"
          max={suffix === "%" ? "100" : undefined}
          step="0.01"
          value={value}
          disabled={disabled}
          className={prefix ? "pl-7" : suffix ? "pr-8" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix ? <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  )
}

function PreviewCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 tabular-nums ${strong ? "font-semibold" : "font-medium"}`}>{value}</p>
    </div>
  )
}
