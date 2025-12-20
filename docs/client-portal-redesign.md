# Client Portal Redesign - Implementation Plan

## Goal
Redesign `/app/p/[token]/portal-client.tsx` to be mobile-first with PIN protection, financial summary, and photo timeline.

---

## Task 1: Database Schema Changes

**File:** Create migration or update schema

Add columns to `portal_access_tokens` table:
```sql
ALTER TABLE portal_access_tokens
ADD COLUMN pin_hash TEXT,
ADD COLUMN pin_required BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0,
ADD COLUMN pin_locked_until TIMESTAMPTZ;
```

---

## Task 2: Type Definitions

**File:** `lib/types.ts`

Add after `ClientPortalData` interface (around line 859):

```typescript
export interface PortalFinancialSummary {
  contractTotal: number
  totalPaid: number
  balanceRemaining: number
  nextDraw?: {
    id: string
    draw_number: number
    title: string
    amount_cents: number
    due_date?: string | null
    status: string
  }
  draws: DrawSchedule[]
}
```

Extend `ClientPortalData` interface - add field:
```typescript
financialSummary?: PortalFinancialSummary
```

Extend `PortalAccessToken` interface - add fields:
```typescript
pin_required: boolean
pin_locked_until?: string | null
```

---

## Task 3: Service Layer - PIN Functions

**File:** `lib/services/portal-access.ts`

Add at top of file:
```typescript
import { compare, hash } from "bcryptjs"
```

Add constants:
```typescript
const PIN_SALT_ROUNDS = 10
const MAX_PIN_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
```

Add function `setPortalTokenPin`:
```typescript
export async function setPortalTokenPin({
  tokenId,
  pin,
  orgId,
}: {
  tokenId: string
  pin: string
  orgId?: string
}): Promise<void> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const pinHash = await hash(pin, PIN_SALT_ROUNDS)

  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({
      pin_hash: pinHash,
      pin_required: true,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to set PIN: ${error.message}`)
}
```

Add function `removePortalTokenPin`:
```typescript
export async function removePortalTokenPin({
  tokenId,
  orgId,
}: {
  tokenId: string
  orgId?: string
}): Promise<void> {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  const serviceClient = createServiceSupabaseClient()

  const { error } = await serviceClient
    .from("portal_access_tokens")
    .update({
      pin_hash: null,
      pin_required: false,
      pin_attempts: 0,
      pin_locked_until: null,
    })
    .eq("id", tokenId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to remove PIN: ${error.message}`)
}
```

Add function `validatePortalPin`:
```typescript
export async function validatePortalPin({
  token,
  pin,
}: {
  token: string
  pin: string
}): Promise<{ valid: boolean; attemptsRemaining?: number; lockedUntil?: string }> {
  const supabase = createServiceSupabaseClient()

  const { data, error } = await supabase
    .from("portal_access_tokens")
    .select("id, pin_hash, pin_attempts, pin_locked_until")
    .eq("token", token)
    .is("revoked_at", null)
    .maybeSingle()

  if (error || !data || !data.pin_hash) {
    return { valid: false }
  }

  if (data.pin_locked_until && new Date(data.pin_locked_until) > new Date()) {
    return { valid: false, lockedUntil: data.pin_locked_until }
  }

  const isValid = await compare(pin, data.pin_hash)

  if (isValid) {
    await supabase
      .from("portal_access_tokens")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("id", data.id)
    return { valid: true }
  }

  const newAttempts = (data.pin_attempts ?? 0) + 1
  const lockoutTime = newAttempts >= MAX_PIN_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString()
    : null

  await supabase
    .from("portal_access_tokens")
    .update({
      pin_attempts: newAttempts,
      pin_locked_until: lockoutTime,
    })
    .eq("id", data.id)

  return {
    valid: false,
    attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - newAttempts),
    lockedUntil: lockoutTime ?? undefined,
  }
}
```

Update `mapAccessToken` function to include new fields:
```typescript
pin_required: !!row.pin_required,
pin_locked_until: row.pin_locked_until ?? null,
```

---

## Task 4: Service Layer - Financial Summary

**File:** `lib/services/portal-access.ts`

Add function `loadPortalFinancialSummary`:
```typescript
async function loadPortalFinancialSummary({
  orgId,
  projectId,
}: {
  orgId: string
  projectId: string
}): Promise<PortalFinancialSummary> {
  const supabase = createServiceSupabaseClient()

  const [contractResult, projectResult, paymentsResult, nextDrawResult, drawsResult] = await Promise.all([
    supabase
      .from("contracts")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("projects")
      .select("total_value")
      .eq("id", projectId)
      .single(),
    supabase
      .from("payments")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "succeeded"),
    supabase
      .from("draw_schedules")
      .select("id, draw_number, title, amount_cents, due_date, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "pending")
      .order("due_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("draw_schedules")
      .select("*")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("draw_number", { ascending: true }),
  ])

  const contractTotal = contractResult.data?.total_cents ??
    (projectResult.data?.total_value ? projectResult.data.total_value * 100 : 0)
  const totalPaid = (paymentsResult.data ?? []).reduce((sum, p) => sum + (p.amount_cents ?? 0), 0)

  return {
    contractTotal,
    totalPaid,
    balanceRemaining: contractTotal - totalPaid,
    nextDraw: nextDrawResult.data ?? undefined,
    draws: drawsResult.data ?? [],
  }
}
```

Update `loadClientPortalData` function - add financial summary fetch:

In the Promise.all array, add:
```typescript
permissions.can_view_budget ? loadPortalFinancialSummary({ orgId, projectId }) : Promise.resolve(undefined),
```

In the return object, add:
```typescript
financialSummary: financialSummaryResult,
```

---

## Task 5: PIN Verification Server Action

**File:** Create `app/p/[token]/actions.ts`

```typescript
"use server"

import { validatePortalPin } from "@/lib/services/portal-access"

export async function verifyPortalPinAction({
  token,
  pin,
}: {
  token: string
  pin: string
}) {
  return validatePortalPin({ token, pin })
}
```

---

## Task 6: Portal Components

### 6a: Portal Header

**File:** Create `components/portal/portal-header.tsx`

```typescript
"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/types"

const statusStyles: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

interface PortalHeaderProps {
  orgName: string
  project: Project
}

export function PortalHeader({ orgName, project }: PortalHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-xs text-muted-foreground">{orgName}</p>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold truncate">{project.name}</h1>
          <Badge variant="outline" className={cn("capitalize shrink-0", statusStyles[project.status] ?? "")}>
            {project.status.replaceAll("_", " ")}
          </Badge>
        </div>
      </div>
    </header>
  )
}
```

### 6b: Bottom Navigation

**File:** Create `components/portal/portal-bottom-nav.tsx`

```typescript
"use client"

import { Home, Camera, FileText, CheckSquare, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export type PortalTab = "home" | "timeline" | "documents" | "actions" | "messages"

interface PortalBottomNavProps {
  activeTab: PortalTab
  onTabChange: (tab: PortalTab) => void
  hasMessages?: boolean
  hasPendingActions?: boolean
}

const tabs: { id: PortalTab; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "timeline", label: "Timeline", icon: Camera },
  { id: "documents", label: "Docs", icon: FileText },
  { id: "actions", label: "Actions", icon: CheckSquare },
  { id: "messages", label: "Messages", icon: MessageCircle },
]

export function PortalBottomNav({ activeTab, onTabChange, hasPendingActions }: PortalBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const showDot = tab.id === "actions" && hasPendingActions

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {showDot && (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive" />
                )}
              </div>
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
```

### 6c: Financial Summary

**File:** Create `components/portal/portal-financial-summary.tsx`

```typescript
"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { format } from "date-fns"
import type { PortalFinancialSummary } from "@/lib/types"

interface PortalFinancialSummaryProps {
  summary: PortalFinancialSummary
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function PortalFinancialSummaryCard({ summary }: PortalFinancialSummaryProps) {
  const paidPercent = summary.contractTotal > 0
    ? Math.round((summary.totalPaid / summary.contractTotal) * 100)
    : 0

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Contract Total</span>
          <span className="text-lg font-semibold">{formatCurrency(summary.contractTotal)}</span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium">{formatCurrency(summary.totalPaid)} ({paidPercent}%)</span>
          </div>
          <Progress value={paidPercent} className="h-2" />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-medium">{formatCurrency(summary.balanceRemaining)}</span>
          </div>
        </div>

        {summary.nextDraw && (
          <div className="border-t pt-3 mt-3">
            <p className="text-sm font-medium">Next Draw: {summary.nextDraw.title}</p>
            <p className="text-sm text-muted-foreground">
              {formatCurrency(summary.nextDraw.amount_cents)}
              {summary.nextDraw.due_date && (
                <> · Due {format(new Date(summary.nextDraw.due_date), "MMM d, yyyy")}</>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

### 6d: PIN Gate

**File:** Create `components/portal/portal-pin-gate.tsx`

```typescript
"use client"

import { useState, useTransition } from "react"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { verifyPortalPinAction } from "@/app/p/[token]/actions"

interface PortalPinGateProps {
  token: string
  projectName: string
  orgName: string
  onSuccess: () => void
}

export function PortalPinGate({ token, projectName, orgName, onSuccess }: PortalPinGateProps) {
  const [pin, setPin] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    if (pin.length < 4) return

    setError(null)
    startTransition(async () => {
      const result = await verifyPortalPinAction({ token, pin })

      if (result.valid) {
        onSuccess()
      } else if (result.lockedUntil) {
        setError("Too many attempts. Please try again later.")
      } else if (result.attemptsRemaining !== undefined) {
        setError(`Incorrect PIN. ${result.attemptsRemaining} attempts remaining.`)
        setPin("")
      } else {
        setError("Incorrect PIN. Please try again.")
        setPin("")
      }
    })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <p className="text-xs text-muted-foreground mb-1">{orgName}</p>
          <CardTitle>{projectName}</CardTitle>
          <CardDescription>Enter your PIN to access the portal</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center">
            <InputOTP
              maxLength={6}
              value={pin}
              onChange={setPin}
              onComplete={handleSubmit}
              disabled={isPending}
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
          </div>

          {error && (
            <p className="text-sm text-destructive text-center">{error}</p>
          )}

          <Button
            onClick={handleSubmit}
            disabled={pin.length < 4 || isPending}
            className="w-full"
          >
            {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
```

### 6e: Photo Timeline

**File:** Create `components/portal/photo-timeline.tsx`

```typescript
"use client"

import { useState } from "react"
import { format } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import type { PhotoTimelineEntry, Photo } from "@/lib/types"

interface PhotoTimelineProps {
  entries: PhotoTimelineEntry[]
}

export function PhotoTimeline({ entries }: PhotoTimelineProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null)

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No photos yet</p>
        <p className="text-sm">Photos from daily logs will appear here</p>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {entries.map((entry, idx) => (
          <Card key={idx}>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-medium">
                Week of {format(new Date(entry.week_start), "MMM d")} - {format(new Date(entry.week_end), "MMM d")}
              </h3>

              <div className="grid grid-cols-3 gap-2">
                {entry.photos.slice(0, 6).map((photo) => (
                  <button
                    key={photo.id}
                    onClick={() => setSelectedPhoto(photo)}
                    className="aspect-square rounded-md overflow-hidden bg-muted"
                  >
                    <img
                      src={photo.url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
                {entry.photos.length > 6 && (
                  <div className="aspect-square rounded-md bg-muted flex items-center justify-center text-sm text-muted-foreground">
                    +{entry.photos.length - 6} more
                  </div>
                )}
              </div>

              {entry.log_summaries.length > 0 && (
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {entry.log_summaries[0]}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedPhoto} onOpenChange={() => setSelectedPhoto(null)}>
        <DialogContent className="max-w-3xl p-0">
          {selectedPhoto && (
            <img
              src={selectedPhoto.url}
              alt=""
              className="w-full h-auto"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
```

---

## Task 7: Tab Content Components

### 7a: Home Tab

**File:** Create `components/portal/tabs/portal-home-tab.tsx`

```typescript
"use client"

import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { PortalFinancialSummaryCard } from "@/components/portal/portal-financial-summary"
import type { ClientPortalData } from "@/lib/types"

interface PortalHomeTabProps {
  data: ClientPortalData
}

export function PortalHomeTab({ data }: PortalHomeTabProps) {
  const pendingCount = data.pendingChangeOrders.length + data.pendingSelections.length
  const upcomingSchedule = data.schedule.filter(s => s.status === "planned" || s.status === "in_progress").slice(0, 3)

  return (
    <div className="space-y-4">
      {data.financialSummary && (
        <PortalFinancialSummaryCard summary={data.financialSummary} />
      )}

      {pendingCount > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Items needing your attention</span>
              <Badge variant="destructive">{pendingCount}</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Upcoming Schedule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {upcomingSchedule.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upcoming items</p>
          ) : (
            upcomingSchedule.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{item.name}</p>
                  {item.start_date && (
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(item.start_date), "MMM d")}
                      {item.end_date && item.end_date !== item.start_date && (
                        <> - {format(new Date(item.end_date), "MMM d")}</>
                      )}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="capitalize text-xs">
                  {item.status.replaceAll("_", " ")}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {data.project.start_date && data.project.end_date && (
        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between text-sm">
              <div>
                <p className="text-muted-foreground">Started</p>
                <p className="font-medium">{format(new Date(data.project.start_date), "MMM d, yyyy")}</p>
              </div>
              <div className="text-right">
                <p className="text-muted-foreground">Target Completion</p>
                <p className="font-medium">{format(new Date(data.project.end_date), "MMM d, yyyy")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

### 7b: Timeline Tab

**File:** Create `components/portal/tabs/portal-timeline-tab.tsx`

```typescript
"use client"

import { PhotoTimeline } from "@/components/portal/photo-timeline"
import type { ClientPortalData } from "@/lib/types"

interface PortalTimelineTabProps {
  data: ClientPortalData
}

export function PortalTimelineTab({ data }: PortalTimelineTabProps) {
  return <PhotoTimeline entries={data.photos} />
}
```

### 7c: Documents Tab

**File:** Create `components/portal/tabs/portal-documents-tab.tsx`

```typescript
"use client"

import { format } from "date-fns"
import { FileText, Download } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { ClientPortalData } from "@/lib/types"

interface PortalDocumentsTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
}

export function PortalDocumentsTab({ data, token, portalType }: PortalDocumentsTabProps) {
  const basePath = portalType === "client" ? "p" : "s"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet</p>
          ) : (
            data.invoices.map((inv) => (
              <a
                key={inv.id}
                href={inv.token ? `/i/${inv.token}` : `/${basePath}/${token}/invoices/${inv.id}`}
                className="flex items-center justify-between py-3 border-b last:border-0 hover:bg-muted/50 -mx-2 px-2 rounded"
              >
                <div>
                  <p className="text-sm font-medium">{inv.invoice_number}</p>
                  <p className="text-xs text-muted-foreground">{inv.title}</p>
                </div>
                <div className="text-right">
                  <Badge variant="outline" className="capitalize text-xs mb-1">
                    {inv.status}
                  </Badge>
                  {inv.total_cents != null && (
                    <p className="text-sm font-medium">${(inv.total_cents / 100).toLocaleString()}</p>
                  )}
                </div>
              </a>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Shared Files</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.sharedFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files shared yet</p>
          ) : (
            data.sharedFiles.map((file) => (
              <div key={file.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                <FileText className="h-8 w-8 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.file_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(file.created_at), "MMM d, yyyy")}
                  </p>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

### 7d: Actions Tab

**File:** Create `components/portal/tabs/portal-actions-tab.tsx`

```typescript
"use client"

import { format } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { ClientPortalData } from "@/lib/types"

interface PortalActionsTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
}

export function PortalActionsTab({ data, token, portalType }: PortalActionsTabProps) {
  const basePath = portalType === "client" ? "p" : "s"

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Change Orders</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.pendingChangeOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No change orders awaiting review</p>
          ) : (
            data.pendingChangeOrders.map((co) => (
              <a
                key={co.id}
                href={`/${basePath}/${token}/change-orders/${co.id}`}
                className="block py-3 border-b last:border-0 hover:bg-muted/50 -mx-2 px-2 rounded"
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium">{co.title}</p>
                  <Badge variant="outline" className="capitalize text-xs">
                    {co.status}
                  </Badge>
                </div>
                {co.total_cents != null && (
                  <p className="text-sm font-semibold">${(co.total_cents / 100).toLocaleString()}</p>
                )}
                {co.summary && (
                  <p className="text-xs text-muted-foreground line-clamp-1">{co.summary}</p>
                )}
              </a>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Selections</CardTitle>
          {data.pendingSelections.length > 0 && (
            <a href={`/${basePath}/${token}/selections`} className="text-sm text-primary">
              View all
            </a>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {data.pendingSelections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No selections pending</p>
          ) : (
            data.pendingSelections.slice(0, 3).map((selection) => (
              <div key={selection.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">Selection #{selection.id.slice(0, 6)}</p>
                  {selection.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {format(new Date(selection.due_date), "MMM d")}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="capitalize text-xs">
                  {selection.status}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">Punch List</CardTitle>
          {portalType === "client" && (
            <a href={`/p/${token}/punch-list`} className="text-sm text-primary">
              Add item
            </a>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {data.punchItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No punch items</p>
          ) : (
            data.punchItems.slice(0, 5).map((item) => (
              <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">{item.title}</p>
                  {item.location && (
                    <p className="text-xs text-muted-foreground">{item.location}</p>
                  )}
                </div>
                <Badge variant="outline" className="capitalize text-xs">
                  {item.status}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

### 7e: Messages Tab

**File:** Create `components/portal/tabs/portal-messages-tab.tsx`

```typescript
"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { format } from "date-fns"
import { Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { loadPortalMessagesAction, sendPortalMessageAction } from "@/app/p/[token]/messages/actions"
import type { ClientPortalData } from "@/lib/types"

interface PortalMessagesTabProps {
  data: ClientPortalData
  token: string
  portalType: "client" | "sub"
  canMessage: boolean
}

export function PortalMessagesTab({ data, token, portalType, canMessage }: PortalMessagesTabProps) {
  const [messages, setMessages] = useState(data.messages)
  const [body, setBody] = useState("")
  const [isPending, startTransition] = useTransition()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = () => {
    if (!body.trim() || !canMessage) return

    startTransition(async () => {
      try {
        const message = await sendPortalMessageAction({
          token,
          body,
          senderName: portalType === "client" ? "Client" : "Sub"
        })
        setMessages((prev) => [...prev, message])
        setBody("")
      } catch (error) {
        console.error("Failed to send message", error)
      }
    })
  }

  const handleRefresh = () => {
    startTransition(async () => {
      const latest = await loadPortalMessagesAction(token)
      setMessages(latest)
    })
  }

  if (!canMessage) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>Messaging is not enabled for this portal</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pb-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No messages yet</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-sm font-medium">{msg.sender_name ?? "Portal user"}</p>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(msg.sent_at), "MMM d, h:mm a")}
                </span>
              </div>
              <p className="text-sm whitespace-pre-line">{msg.body}</p>
            </div>
          ))
        )}
      </div>

      <div className="border-t pt-3 space-y-2">
        <Textarea
          placeholder="Type a message..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isPending}
          className="min-h-[80px] resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isPending}>
            {isPending && <Spinner className="mr-2 h-3 w-3" />}
            Refresh
          </Button>
          <Button onClick={handleSend} disabled={isPending || !body.trim()} size="sm">
            <Send className="h-4 w-4 mr-1" />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
```

---

## Task 8: Rewrite Portal Client

**File:** `app/p/[token]/portal-client.tsx`

Replace entire file with:

```typescript
"use client"

import { useState } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import { PortalBottomNav, type PortalTab } from "@/components/portal/portal-bottom-nav"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { PortalHomeTab } from "@/components/portal/tabs/portal-home-tab"
import { PortalTimelineTab } from "@/components/portal/tabs/portal-timeline-tab"
import { PortalDocumentsTab } from "@/components/portal/tabs/portal-documents-tab"
import { PortalActionsTab } from "@/components/portal/tabs/portal-actions-tab"
import { PortalMessagesTab } from "@/components/portal/tabs/portal-messages-tab"
import type { ClientPortalData } from "@/lib/types"

interface PortalPublicClientProps {
  data: ClientPortalData
  token: string
  portalType?: "client" | "sub"
  canMessage?: boolean
  pinRequired?: boolean
}

export function PortalPublicClient({
  data,
  token,
  portalType = "client",
  canMessage = false,
  pinRequired = false,
}: PortalPublicClientProps) {
  const [activeTab, setActiveTab] = useState<PortalTab>("home")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const isMobile = useIsMobile()

  const hasPendingActions = data.pendingChangeOrders.length > 0 || data.pendingSelections.length > 0

  if (!pinVerified) {
    return (
      <PortalPinGate
        token={token}
        projectName={data.project.name}
        orgName={data.org.name}
        onSuccess={() => setPinVerified(true)}
      />
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <PortalHeader orgName={data.org.name} project={data.project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">
            {activeTab === "home" && <PortalHomeTab data={data} />}
            {activeTab === "timeline" && <PortalTimelineTab data={data} />}
            {activeTab === "documents" && <PortalDocumentsTab data={data} token={token} portalType={portalType} />}
            {activeTab === "actions" && <PortalActionsTab data={data} token={token} portalType={portalType} />}
            {activeTab === "messages" && <PortalMessagesTab data={data} token={token} portalType={portalType} canMessage={canMessage} />}
          </main>
          <PortalBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasPendingActions={hasPendingActions}
          />
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PortalTab)}>
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="home">Home</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="actions">
                Actions
                {hasPendingActions && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
            </TabsList>
            <TabsContent value="home"><PortalHomeTab data={data} /></TabsContent>
            <TabsContent value="timeline"><PortalTimelineTab data={data} /></TabsContent>
            <TabsContent value="documents"><PortalDocumentsTab data={data} token={token} portalType={portalType} /></TabsContent>
            <TabsContent value="actions"><PortalActionsTab data={data} token={token} portalType={portalType} /></TabsContent>
            <TabsContent value="messages"><PortalMessagesTab data={data} token={token} portalType={portalType} canMessage={canMessage} /></TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
```

---

## Task 9: Update Portal Page

**File:** `app/p/[token]/page.tsx`

Replace with:

```typescript
import { notFound } from "next/navigation"

import { validatePortalToken, loadClientPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { PortalPublicClient } from "./portal-client"

interface PortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function ClientPortalPage({ params }: PortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
    portalType: "client",
  })

  await recordPortalAccess(access.id)

  return (
    <PortalPublicClient
      data={data}
      token={token}
      portalType="client"
      canMessage={access.permissions.can_message}
      pinRequired={access.pin_required}
    />
  )
}
```

---

## Task 10: Update Portal Layout

**File:** `app/p/[token]/layout.tsx`

Replace with:

```typescript
import "@/styles/globals.css"

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  )
}
```

---

## Task 11: Install bcryptjs (if needed)

Run in terminal:
```bash
npm install bcryptjs
npm install -D @types/bcryptjs
```

---

## Execution Order

1. Task 11 - Install bcryptjs
2. Task 1 - Database migration
3. Task 2 - Type definitions
4. Task 3 - PIN service functions
5. Task 4 - Financial summary service
6. Task 5 - Server action
7. Task 6a-6e - Portal components (can be done in parallel)
8. Task 7a-7e - Tab components (can be done in parallel)
9. Task 8 - Rewrite portal client
10. Task 9 - Update portal page
11. Task 10 - Update layout

---

## Testing Checklist

- [ ] Portal loads without PIN when pin_required is false
- [ ] PIN gate appears when pin_required is true
- [ ] PIN validation works (correct/incorrect)
- [ ] PIN lockout after 5 failed attempts
- [ ] Financial summary shows correct values
- [ ] Financial summary shows $0 when no contract exists
- [ ] Photo timeline displays weekly groupings
- [ ] Bottom nav works on mobile
- [ ] Tabs work on desktop
- [ ] All existing functionality preserved (invoices, change orders, etc.)
