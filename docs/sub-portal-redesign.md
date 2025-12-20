# Sub-Contractor Portal Redesign - Implementation Plan

## Goal

Transform the sub-contractor portal (`/app/s/[token]/`) from a clone of the client portal into a purpose-built interface for vendors/subcontractors. Core value proposition: **"How much can I bill, and where's my money?"**

This plan is LLM-executable: explicit files, data flows, component specs, and acceptance checks.

---

## Current State (Repo Reality Check)

### What Exists
- **Route structure**: `app/s/[token]/` with layout, page, rfis/, submittals/
- **Shared client**: `PortalPublicClient` component accepts `portalType="sub"` but renders client-focused UI
- **Backend services** (complete, unused by portal):
  - `lib/services/commitments.ts` - vendor contracts/POs with billed/paid aggregation
  - `lib/services/vendor-bills.ts` - invoice tracking with status workflow
  - `lib/services/project-vendors.ts` - vendor-project assignments
- **Portal infrastructure**:
  - `lib/services/portal-access.ts` - token validation, PIN protection, data loading
  - `portal_access_tokens` table with granular permissions
  - PIN protection already implemented (bcryptjs, rate limiting, lockout)

### What's Missing
- Sub-specific data loader (`loadSubPortalData` exists but returns client data)
- Commitment/contract visibility UI
- Invoice submission flow
- Vendor-specific financial dashboard
- Document/file access for specs and drawings
- Sub-specific navigation tabs

---

## Target Architecture

### Sub Portal Tabs (Bottom Nav on Mobile)
```
[Dashboard] [Documents] [RFIs] [Submittals] [Messages]
```

### Dashboard Content
```
┌─────────────────────────────────────────────────────────────┐
│  [Builder Logo]  Builder Name                               │
│  123 Main St Renovation                        [Active]     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  MY CONTRACTS                                    [View All] │
│  ┌─────────────────────────────────────────────────────────┐
│  │ Electrical Rough-In                         $45,000     │
│  │ ████████████████░░░░░░░░░░░░  Billed: $27,000 (60%)    │
│  │                               Remaining: $18,000        │
│  │                                     [Submit Invoice]    │
│  └─────────────────────────────────────────────────────────┘
│                                                             │
│  INVOICE STATUS                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │  Pending    │ │  Approved   │ │    Paid     │           │
│  │   $8,500    │ │   $4,200    │ │  $14,300    │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
│                                                             │
│  UPCOMING SCHEDULE                               [View All] │
│  ┌─────────────────────────────────────────────────────────┐
│  │ Dec 18  Rough-In Inspection              [In Progress]  │
│  │ Dec 20  Panel Installation               [Planned]      │
│  └─────────────────────────────────────────────────────────┘
│                                                             │
│  NEEDS ATTENTION                                            │
│  ┌─────────────────────────────────────────────────────────┐
│  │ 2 RFIs awaiting your response                           │
│  │ 1 Submittal due in 3 days                               │
│  └─────────────────────────────────────────────────────────┘
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Architecture

### New Type: `SubPortalData`

**File:** `lib/types.ts`

Add after `ClientPortalData` interface:

```typescript
export interface SubPortalCommitment {
  id: string
  title: string
  status: "draft" | "approved" | "complete" | "canceled"
  total_cents: number
  billed_cents: number
  paid_cents: number
  remaining_cents: number
  start_date?: string | null
  end_date?: string | null
  project_name: string
}

export interface SubPortalBill {
  id: string
  bill_number: string
  commitment_id: string
  commitment_title: string
  status: "pending" | "approved" | "paid"
  total_cents: number
  bill_date: string
  due_date?: string | null
  submitted_at: string
  paid_at?: string | null
  payment_reference?: string | null
}

export interface SubPortalFinancialSummary {
  total_committed: number      // Sum of all commitment totals
  total_billed: number         // Sum of all vendor bills
  total_paid: number           // Sum of paid vendor bills
  total_remaining: number      // committed - billed
  pending_approval: number     // Bills in "pending" status
  approved_unpaid: number      // Bills in "approved" status
}

export interface SubPortalData {
  org: {
    id: string
    name: string
    logo_url?: string | null
  }
  project: Project
  company: {
    id: string
    name: string
    trade?: string | null
  }
  projectManager?: PortalProjectManager
  commitments: SubPortalCommitment[]
  bills: SubPortalBill[]
  financialSummary: SubPortalFinancialSummary
  schedule: ScheduleItem[]           // Filtered to this company's tasks
  rfis: Rfi[]                        // Assigned to this company
  submittals: Submittal[]            // Assigned to this company
  sharedFiles: FileMetadata[]        // Shared with sub portal
  messages: PortalMessage[]
  pendingRfiCount: number
  pendingSubmittalCount: number
}
```

### Service Layer: Load Sub Portal Data

**File:** `lib/services/portal-access.ts`

Add new function after `loadClientPortalData`:

```typescript
export async function loadSubPortalData({
  orgId,
  projectId,
  companyId,
  permissions,
}: {
  orgId: string
  projectId: string
  companyId: string
  permissions: PortalPermissions
}): Promise<SubPortalData> {
  const supabase = createServiceSupabaseClient()

  // Parallel data loading
  const [
    orgResult,
    projectResult,
    companyResult,
    pmResult,
    commitmentsResult,
    billsResult,
    scheduleResult,
    rfisResult,
    submittalsResult,
    filesResult,
    messagesResult,
  ] = await Promise.all([
    // Org info
    supabase
      .from("orgs")
      .select("id, name, logo_url")
      .eq("id", orgId)
      .single(),

    // Project info
    supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single(),

    // Company info
    supabase
      .from("companies")
      .select("id, name, metadata")
      .eq("id", companyId)
      .single(),

    // Project manager
    supabase
      .from("project_members")
      .select(`
        user_id,
        role,
        users:user_id (
          id, full_name, email, phone, avatar_url
        )
      `)
      .eq("project_id", projectId)
      .eq("role", "project_manager")
      .maybeSingle(),

    // Commitments for this company + project
    supabase
      .from("commitments")
      .select(`
        id, title, status, total_cents, currency,
        start_date, end_date, created_at
      `)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("company_id", companyId)
      .neq("status", "canceled")
      .order("created_at", { ascending: false }),

    // Vendor bills for this company's commitments
    supabase
      .from("vendor_bills")
      .select(`
        id, bill_number, commitment_id, status,
        total_cents, bill_date, due_date,
        created_at, metadata,
        commitments:commitment_id (title)
      `)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),

    // Schedule items assigned to this company
    permissions.can_view_schedule
      ? supabase
          .from("schedule_assignments")
          .select(`
            schedule_items:schedule_item_id (
              id, name, status, start_date, end_date,
              duration_days, percent_complete
            )
          `)
          .eq("company_id", companyId)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),

    // RFIs assigned to this company
    permissions.can_view_rfis
      ? supabase
          .from("rfis")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("assigned_company_id", companyId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Submittals assigned to this company
    permissions.can_view_submittals
      ? supabase
          .from("submittals")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("assigned_company_id", companyId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Shared files (drawings, specs, etc.)
    permissions.can_view_documents
      ? supabase
          .from("files")
          .select("*")
          .eq("org_id", orgId)
          .eq("project_id", projectId)
          .eq("share_with_subs", true)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),

    // Messages
    permissions.can_message
      ? supabase
          .from("messages")
          .select("*")
          .eq("conversation_id", `sub-${projectId}-${companyId}`)
          .order("sent_at", { ascending: true })
      : Promise.resolve({ data: [] }),
  ])

  // Filter bills to only those belonging to this company's commitments
  const commitmentIds = new Set((commitmentsResult.data ?? []).map(c => c.id))
  const companyBills = (billsResult.data ?? []).filter(b =>
    commitmentIds.has(b.commitment_id)
  )

  // Aggregate bill amounts per commitment
  const billsByCommitment = new Map<string, { billed: number; paid: number }>()
  for (const bill of companyBills) {
    const existing = billsByCommitment.get(bill.commitment_id) ?? { billed: 0, paid: 0 }
    existing.billed += bill.total_cents ?? 0
    if (bill.status === "paid") {
      existing.paid += bill.total_cents ?? 0
    }
    billsByCommitment.set(bill.commitment_id, existing)
  }

  // Map commitments with aggregated amounts
  const commitments: SubPortalCommitment[] = (commitmentsResult.data ?? []).map(c => {
    const billTotals = billsByCommitment.get(c.id) ?? { billed: 0, paid: 0 }
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      total_cents: c.total_cents ?? 0,
      billed_cents: billTotals.billed,
      paid_cents: billTotals.paid,
      remaining_cents: (c.total_cents ?? 0) - billTotals.billed,
      start_date: c.start_date,
      end_date: c.end_date,
      project_name: projectResult.data?.name ?? "",
    }
  })

  // Map bills
  const bills: SubPortalBill[] = companyBills.map(b => ({
    id: b.id,
    bill_number: b.bill_number,
    commitment_id: b.commitment_id,
    commitment_title: (b.commitments as any)?.title ?? "",
    status: b.status,
    total_cents: b.total_cents ?? 0,
    bill_date: b.bill_date,
    due_date: b.due_date,
    submitted_at: b.created_at,
    paid_at: b.metadata?.paid_at ?? null,
    payment_reference: b.metadata?.payment_reference ?? null,
  }))

  // Calculate financial summary
  const financialSummary: SubPortalFinancialSummary = {
    total_committed: commitments.reduce((sum, c) => sum + c.total_cents, 0),
    total_billed: commitments.reduce((sum, c) => sum + c.billed_cents, 0),
    total_paid: commitments.reduce((sum, c) => sum + c.paid_cents, 0),
    total_remaining: commitments.reduce((sum, c) => sum + c.remaining_cents, 0),
    pending_approval: bills
      .filter(b => b.status === "pending")
      .reduce((sum, b) => sum + b.total_cents, 0),
    approved_unpaid: bills
      .filter(b => b.status === "approved")
      .reduce((sum, b) => sum + b.total_cents, 0),
  }

  // Extract schedule items from assignments
  const schedule = (scheduleResult.data ?? [])
    .map((a: any) => a.schedule_items)
    .filter(Boolean)

  // Count pending items
  const pendingRfiCount = (rfisResult.data ?? [])
    .filter(r => r.status === "open" || r.status === "pending")
    .length
  const pendingSubmittalCount = (submittalsResult.data ?? [])
    .filter(s => s.status === "pending" || s.status === "in_review")
    .length

  return {
    org: {
      id: orgResult.data?.id ?? orgId,
      name: orgResult.data?.name ?? "",
      logo_url: orgResult.data?.logo_url,
    },
    project: mapProject(projectResult.data),
    company: {
      id: companyResult.data?.id ?? companyId,
      name: companyResult.data?.name ?? "",
      trade: companyResult.data?.metadata?.trade,
    },
    projectManager: pmResult.data?.users
      ? {
          id: pmResult.data.users.id,
          name: pmResult.data.users.full_name ?? "",
          email: pmResult.data.users.email,
          phone: pmResult.data.users.phone,
          avatar_url: pmResult.data.users.avatar_url,
          role: "Project Manager",
        }
      : undefined,
    commitments,
    bills,
    financialSummary,
    schedule,
    rfis: (rfisResult.data ?? []).map(mapRfi),
    submittals: (submittalsResult.data ?? []).map(mapSubmittal),
    sharedFiles: (filesResult.data ?? []).map(mapFileMetadata),
    messages: (messagesResult.data ?? []).map(mapPortalMessage),
    pendingRfiCount,
    pendingSubmittalCount,
  }
}
```

### Portal Token Changes

**File:** `lib/types.ts`

Update `PortalAccessToken` interface to include company reference:

```typescript
export interface PortalAccessToken {
  id: string
  org_id: string
  project_id: string
  company_id?: string | null      // ADD: For sub portals
  contact_id?: string | null
  portal_type: "client" | "sub"   // ADD: Explicit portal type
  token: string
  name: string
  permissions: PortalPermissions
  pin_required: boolean
  pin_locked_until?: string | null
  expires_at?: string | null
  access_count: number
  max_access_count?: number | null
  last_accessed_at?: string | null
  revoked_at?: string | null
  created_at: string
}
```

### Database Schema Changes (Optional)

If `portal_access_tokens` doesn't have `company_id` and `portal_type` columns:

```sql
-- Migration: Add sub portal columns to portal_access_tokens
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS portal_type text NOT NULL DEFAULT 'client'
  CHECK (portal_type IN ('client', 'sub'));

CREATE INDEX IF NOT EXISTS portal_access_tokens_company_idx
  ON portal_access_tokens(company_id) WHERE company_id IS NOT NULL;

-- Migration: Add share_with_subs flag to files
ALTER TABLE files
ADD COLUMN IF NOT EXISTS share_with_subs boolean NOT NULL DEFAULT false;
```

---

## File Structure

### New Files to Create

```
app/s/[token]/
├── layout.tsx                    # Keep existing (imports from /p/)
├── page.tsx                      # UPDATE: Use sub-specific data loading
├── actions.ts                    # NEW: Sub portal server actions
├── sub-portal-client.tsx         # NEW: Main sub portal client component
├── commitments/
│   └── page.tsx                  # NEW: Full commitments list
├── bills/
│   ├── page.tsx                  # NEW: Full bills list
│   └── [id]/
│       └── page.tsx              # NEW: Bill detail/edit
├── submit-invoice/
│   └── page.tsx                  # NEW: Invoice submission form
├── documents/
│   └── page.tsx                  # NEW: Documents/files view
├── rfis/                         # KEEP: Existing
│   ├── page.tsx
│   ├── actions.ts
│   └── rfis-client.tsx
└── submittals/                   # KEEP: Existing
    ├── page.tsx
    ├── actions.ts
    └── submittals-client.tsx

components/portal/sub/
├── sub-portal-client.tsx         # NEW: Main client wrapper
├── sub-dashboard.tsx             # NEW: Dashboard/home tab content
├── sub-contracts-card.tsx        # NEW: Individual contract card
├── sub-financial-summary.tsx     # NEW: Financial status cards
├── sub-invoice-form.tsx          # NEW: Invoice submission form
├── sub-bills-list.tsx            # NEW: Bills list with status
├── sub-documents-tab.tsx         # NEW: Documents/files tab
├── sub-schedule-view.tsx         # NEW: Filtered schedule lookahead
└── sub-bottom-nav.tsx            # NEW: Sub-specific bottom navigation
```

### Files to Modify

```
lib/types.ts                      # Add SubPortalData types
lib/services/portal-access.ts     # Add loadSubPortalData function
lib/services/vendor-bills.ts      # Add createVendorBill function
lib/validation/vendor-bills.ts    # Add vendor bill input schema
app/s/[token]/page.tsx            # Use new sub portal client
```

---

## Component Specifications

### 1. Sub Portal Page (Entry Point)

**File:** `app/s/[token]/page.tsx`

```typescript
import { notFound } from "next/navigation"
import { validatePortalToken, loadSubPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { SubPortalClient } from "./sub-portal-client"

interface SubPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPage({ params }: SubPortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access || access.portal_type !== "sub" || !access.company_id) {
    notFound()
  }

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  await recordPortalAccess(access.id)

  return (
    <SubPortalClient
      data={data}
      token={token}
      canMessage={access.permissions.can_message}
      canSubmitInvoices={access.permissions.can_submit_invoices ?? true}
      canDownloadFiles={access.permissions.can_download_files}
      pinRequired={access.pin_required}
    />
  )
}
```

### 2. Sub Portal Client (Main Wrapper)

**File:** `app/s/[token]/sub-portal-client.tsx` or `components/portal/sub/sub-portal-client.tsx`

```typescript
"use client"

import { useState } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { SubBottomNav, type SubPortalTab } from "@/components/portal/sub/sub-bottom-nav"
import { SubDashboard } from "@/components/portal/sub/sub-dashboard"
import { SubDocumentsTab } from "@/components/portal/sub/sub-documents-tab"
import { SubRfisTab } from "@/components/portal/sub/sub-rfis-tab"
import { SubSubmittalsTab } from "@/components/portal/sub/sub-submittals-tab"
import { SubMessagesTab } from "@/components/portal/sub/sub-messages-tab"
import type { SubPortalData } from "@/lib/types"

interface SubPortalClientProps {
  data: SubPortalData
  token: string
  canMessage?: boolean
  canSubmitInvoices?: boolean
  canDownloadFiles?: boolean
  pinRequired?: boolean
}

export function SubPortalClient({
  data,
  token,
  canMessage = false,
  canSubmitInvoices = true,
  canDownloadFiles = true,
  pinRequired = false,
}: SubPortalClientProps) {
  const [activeTab, setActiveTab] = useState<SubPortalTab>("dashboard")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const isMobile = useIsMobile()

  const hasAttentionItems = data.pendingRfiCount > 0 || data.pendingSubmittalCount > 0

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
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">
            {activeTab === "dashboard" && (
              <SubDashboard
                data={data}
                token={token}
                canSubmitInvoices={canSubmitInvoices}
              />
            )}
            {activeTab === "documents" && (
              <SubDocumentsTab
                files={data.sharedFiles}
                canDownload={canDownloadFiles}
              />
            )}
            {activeTab === "rfis" && (
              <SubRfisTab rfis={data.rfis} token={token} />
            )}
            {activeTab === "submittals" && (
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            )}
            {activeTab === "messages" && (
              <SubMessagesTab
                messages={data.messages}
                token={token}
                canMessage={canMessage}
                projectId={data.project.id}
                companyId={data.company.id}
              />
            )}
          </main>
          <SubBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasAttentionItems={hasAttentionItems}
            pendingRfis={data.pendingRfiCount}
            pendingSubmittals={data.pendingSubmittalCount}
          />
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SubPortalTab)}>
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="rfis" className="relative">
                RFIs
                {data.pendingRfiCount > 0 && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="submittals" className="relative">
                Submittals
                {data.pendingSubmittalCount > 0 && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
            </TabsList>
            <TabsContent value="dashboard">
              <SubDashboard data={data} token={token} canSubmitInvoices={canSubmitInvoices} />
            </TabsContent>
            <TabsContent value="documents">
              <SubDocumentsTab files={data.sharedFiles} canDownload={canDownloadFiles} />
            </TabsContent>
            <TabsContent value="rfis">
              <SubRfisTab rfis={data.rfis} token={token} />
            </TabsContent>
            <TabsContent value="submittals">
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            </TabsContent>
            <TabsContent value="messages">
              <SubMessagesTab
                messages={data.messages}
                token={token}
                canMessage={canMessage}
                projectId={data.project.id}
                companyId={data.company.id}
              />
            </TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
```

### 3. Sub Bottom Navigation

**File:** `components/portal/sub/sub-bottom-nav.tsx`

```typescript
"use client"

import { LayoutDashboard, FileText, HelpCircle, Package, MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"

export type SubPortalTab = "dashboard" | "documents" | "rfis" | "submittals" | "messages"

interface SubBottomNavProps {
  activeTab: SubPortalTab
  onTabChange: (tab: SubPortalTab) => void
  hasAttentionItems?: boolean
  pendingRfis?: number
  pendingSubmittals?: number
}

const tabs: { id: SubPortalTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "documents", label: "Docs", icon: FileText },
  { id: "rfis", label: "RFIs", icon: HelpCircle },
  { id: "submittals", label: "Submittals", icon: Package },
  { id: "messages", label: "Messages", icon: MessageCircle },
]

export function SubBottomNav({
  activeTab,
  onTabChange,
  pendingRfis = 0,
  pendingSubmittals = 0,
}: SubBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const showDot = (tab.id === "rfis" && pendingRfis > 0) ||
                          (tab.id === "submittals" && pendingSubmittals > 0)

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

### 4. Sub Dashboard

**File:** `components/portal/sub/sub-dashboard.tsx`

```typescript
"use client"

import Link from "next/link"
import { format } from "date-fns"
import { Plus, AlertCircle, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { SubFinancialSummary } from "./sub-financial-summary"
import { SubContractsCard } from "./sub-contracts-card"
import type { SubPortalData } from "@/lib/types"

interface SubDashboardProps {
  data: SubPortalData
  token: string
  canSubmitInvoices?: boolean
}

export function SubDashboard({ data, token, canSubmitInvoices = true }: SubDashboardProps) {
  const upcomingSchedule = data.schedule
    .filter(s => s.status === "planned" || s.status === "in_progress")
    .slice(0, 3)

  const needsAttention = data.pendingRfiCount + data.pendingSubmittalCount

  return (
    <div className="space-y-4">
      {/* Company Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{data.company.name}</h2>
          {data.company.trade && (
            <p className="text-sm text-muted-foreground">{data.company.trade}</p>
          )}
        </div>
        {canSubmitInvoices && (
          <Button asChild size="sm">
            <Link href={`/s/${token}/submit-invoice`}>
              <Plus className="h-4 w-4 mr-1" />
              Submit Invoice
            </Link>
          </Button>
        )}
      </div>

      {/* Financial Summary */}
      <SubFinancialSummary summary={data.financialSummary} />

      {/* Contracts/Commitments */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-base">My Contracts</CardTitle>
          {data.commitments.length > 2 && (
            <Link
              href={`/s/${token}/commitments`}
              className="text-sm text-primary flex items-center"
            >
              View all <ChevronRight className="h-4 w-4" />
            </Link>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {data.commitments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contracts assigned yet</p>
          ) : (
            data.commitments.slice(0, 2).map((commitment) => (
              <SubContractsCard
                key={commitment.id}
                commitment={commitment}
                token={token}
                canSubmitInvoice={canSubmitInvoices}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Needs Attention */}
      {needsAttention > 0 && (
        <Card className="border-warning/50 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Needs Your Attention</p>
                {data.pendingRfiCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.pendingRfiCount} RFI{data.pendingRfiCount > 1 ? "s" : ""} awaiting response
                  </p>
                )}
                {data.pendingSubmittalCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {data.pendingSubmittalCount} submittal{data.pendingSubmittalCount > 1 ? "s" : ""} pending
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Schedule */}
      {upcomingSchedule.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Upcoming Schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingSchedule.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
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
                <Badge
                  variant={item.status === "in_progress" ? "default" : "secondary"}
                  className="capitalize text-xs"
                >
                  {item.status.replaceAll("_", " ")}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent Bills */}
      {data.bills.length > 0 && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent Invoices</CardTitle>
            <Link href={`/s/${token}/bills`} className="text-sm text-primary flex items-center">
              View all <ChevronRight className="h-4 w-4" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.bills.slice(0, 3).map((bill) => (
              <div
                key={bill.id}
                className="flex items-center justify-between py-2 border-b last:border-0"
              >
                <div>
                  <p className="text-sm font-medium">{bill.bill_number}</p>
                  <p className="text-xs text-muted-foreground">{bill.commitment_title}</p>
                </div>
                <div className="text-right">
                  <Badge
                    variant={
                      bill.status === "paid" ? "default" :
                      bill.status === "approved" ? "secondary" : "outline"
                    }
                    className="capitalize text-xs mb-1"
                  >
                    {bill.status}
                  </Badge>
                  <p className="text-sm font-medium">
                    ${(bill.total_cents / 100).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Contact Info */}
      {data.projectManager && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">Project Manager</p>
            <p className="text-sm font-medium">{data.projectManager.name}</p>
            {data.projectManager.phone && (
              <a
                href={`tel:${data.projectManager.phone}`}
                className="text-sm text-primary"
              >
                {data.projectManager.phone}
              </a>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

### 5. Financial Summary Cards

**File:** `components/portal/sub/sub-financial-summary.tsx`

```typescript
"use client"

import { DollarSign, Clock, CheckCircle, Wallet } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { SubPortalFinancialSummary } from "@/lib/types"

interface SubFinancialSummaryProps {
  summary: SubPortalFinancialSummary
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function SubFinancialSummary({ summary }: SubFinancialSummaryProps) {
  const cards = [
    {
      label: "Contracted",
      value: summary.total_committed,
      icon: Wallet,
      color: "text-foreground",
    },
    {
      label: "Remaining",
      value: summary.total_remaining,
      icon: DollarSign,
      color: "text-primary",
    },
    {
      label: "Pending",
      value: summary.pending_approval,
      icon: Clock,
      color: "text-warning",
      subLabel: "Awaiting approval",
    },
    {
      label: "Paid",
      value: summary.total_paid,
      icon: CheckCircle,
      color: "text-success",
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <card.icon className={`h-4 w-4 ${card.color}`} />
              <span className="text-xs text-muted-foreground">{card.label}</span>
            </div>
            <p className={`text-lg font-semibold ${card.color}`}>
              {formatCurrency(card.value)}
            </p>
            {card.subLabel && (
              <p className="text-xs text-muted-foreground">{card.subLabel}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

### 6. Contract Card

**File:** `components/portal/sub/sub-contracts-card.tsx`

```typescript
"use client"

import Link from "next/link"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus } from "lucide-react"
import type { SubPortalCommitment } from "@/lib/types"

interface SubContractsCardProps {
  commitment: SubPortalCommitment
  token: string
  canSubmitInvoice?: boolean
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function SubContractsCard({
  commitment,
  token,
  canSubmitInvoice = true
}: SubContractsCardProps) {
  const billedPercent = commitment.total_cents > 0
    ? Math.round((commitment.billed_cents / commitment.total_cents) * 100)
    : 0

  const statusColors: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    approved: "bg-success/20 text-success",
    complete: "bg-primary/20 text-primary",
    canceled: "bg-destructive/20 text-destructive",
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{commitment.title}</p>
          <Badge
            variant="outline"
            className={`text-xs capitalize mt-1 ${statusColors[commitment.status] ?? ""}`}
          >
            {commitment.status}
          </Badge>
        </div>
        <p className="text-lg font-semibold shrink-0">
          {formatCurrency(commitment.total_cents)}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Billed</span>
          <span className="font-medium">
            {formatCurrency(commitment.billed_cents)} ({billedPercent}%)
          </span>
        </div>
        <Progress value={billedPercent} className="h-2" />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Remaining</span>
          <span className="font-medium text-primary">
            {formatCurrency(commitment.remaining_cents)}
          </span>
        </div>
      </div>

      {canSubmitInvoice && commitment.status === "approved" && commitment.remaining_cents > 0 && (
        <Button asChild size="sm" variant="outline" className="w-full">
          <Link href={`/s/${token}/submit-invoice?commitment=${commitment.id}`}>
            <Plus className="h-4 w-4 mr-1" />
            Submit Invoice
          </Link>
        </Button>
      )}
    </div>
  )
}
```

### 7. Documents Tab

**File:** `components/portal/sub/sub-documents-tab.tsx`

```typescript
"use client"

import { useState } from "react"
import { format } from "date-fns"
import { FileText, Download, Eye, Folder, Search } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { FileMetadata } from "@/lib/types"

interface SubDocumentsTabProps {
  files: FileMetadata[]
  canDownload?: boolean
}

const categoryLabels: Record<string, string> = {
  drawings: "Drawings",
  specs: "Specifications",
  contracts: "Contracts",
  submittals: "Submittals",
  photos: "Photos",
  correspondence: "Correspondence",
  other: "Other",
}

const categoryIcons: Record<string, string> = {
  drawings: "text-blue-500",
  specs: "text-purple-500",
  contracts: "text-green-500",
  submittals: "text-orange-500",
  photos: "text-pink-500",
  correspondence: "text-cyan-500",
  other: "text-gray-500",
}

export function SubDocumentsTab({ files, canDownload = true }: SubDocumentsTabProps) {
  const [search, setSearch] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  // Group files by category
  const filesByCategory = files.reduce((acc, file) => {
    const category = file.category ?? "other"
    if (!acc[category]) acc[category] = []
    acc[category].push(file)
    return acc
  }, {} as Record<string, FileMetadata[]>)

  // Filter files
  const filteredFiles = files.filter((file) => {
    const matchesSearch = !search ||
      file.file_name.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = !selectedCategory || file.category === selectedCategory
    return matchesSearch && matchesCategory
  })

  const categories = Object.keys(filesByCategory)

  if (files.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">No documents shared yet</p>
        <p className="text-sm text-muted-foreground">
          Drawings, specs, and other project documents will appear here
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search and Filter */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex gap-2 flex-wrap">
        <Button
          size="sm"
          variant={selectedCategory === null ? "default" : "outline"}
          onClick={() => setSelectedCategory(null)}
        >
          All ({files.length})
        </Button>
        {categories.map((category) => (
          <Button
            key={category}
            size="sm"
            variant={selectedCategory === category ? "default" : "outline"}
            onClick={() => setSelectedCategory(category)}
          >
            {categoryLabels[category] ?? category} ({filesByCategory[category].length})
          </Button>
        ))}
      </div>

      {/* File List */}
      <Card>
        <CardContent className="p-0 divide-y">
          {filteredFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No documents match your search
            </p>
          ) : (
            filteredFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 p-3 hover:bg-muted/50"
              >
                <div className={`shrink-0 ${categoryIcons[file.category ?? "other"]}`}>
                  <FileText className="h-8 w-8" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.file_name}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{categoryLabels[file.category ?? "other"]}</span>
                    <span>·</span>
                    <span>{format(new Date(file.created_at), "MMM d, yyyy")}</span>
                    {file.file_size && (
                      <>
                        <span>·</span>
                        <span>{formatFileSize(file.file_size)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {file.storage_path && (
                    <Button size="icon" variant="ghost" asChild>
                      <a href={file.url} target="_blank" rel="noopener noreferrer">
                        <Eye className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  {canDownload && file.url && (
                    <Button size="icon" variant="ghost" asChild>
                      <a href={file.url} download={file.file_name}>
                        <Download className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
```

### 8. Invoice Submission Form

**File:** `app/s/[token]/submit-invoice/page.tsx`

```typescript
import { notFound, redirect } from "next/navigation"
import { validatePortalToken, loadSubPortalData } from "@/lib/services/portal-access"
import { SubInvoiceForm } from "@/components/portal/sub/sub-invoice-form"

interface SubmitInvoicePageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ commitment?: string }>
}

export const revalidate = 0

export default async function SubmitInvoicePage({ params, searchParams }: SubmitInvoicePageProps) {
  const { token } = await params
  const { commitment: selectedCommitmentId } = await searchParams

  const access = await validatePortalToken(token)

  if (!access || access.portal_type !== "sub" || !access.company_id) {
    notFound()
  }

  // Check permission
  if (!access.permissions.can_submit_invoices) {
    redirect(`/s/${token}`)
  }

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  // Only show approved commitments with remaining budget
  const eligibleCommitments = data.commitments.filter(
    c => c.status === "approved" && c.remaining_cents > 0
  )

  return (
    <div className="min-h-screen bg-background">
      <SubInvoiceForm
        token={token}
        commitments={eligibleCommitments}
        selectedCommitmentId={selectedCommitmentId}
        projectId={data.project.id}
        companyId={data.company.id}
        companyName={data.company.name}
      />
    </div>
  )
}
```

**File:** `components/portal/sub/sub-invoice-form.tsx`

```typescript
"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, Upload, AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { submitVendorInvoiceAction } from "@/app/s/[token]/actions"
import type { SubPortalCommitment } from "@/lib/types"

interface SubInvoiceFormProps {
  token: string
  commitments: SubPortalCommitment[]
  selectedCommitmentId?: string
  projectId: string
  companyId: string
  companyName: string
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function SubInvoiceForm({
  token,
  commitments,
  selectedCommitmentId,
  projectId,
  companyId,
  companyName,
}: SubInvoiceFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [commitmentId, setCommitmentId] = useState(selectedCommitmentId ?? "")
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [amount, setAmount] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [description, setDescription] = useState("")
  const [file, setFile] = useState<File | null>(null)

  const selectedCommitment = commitments.find(c => c.id === commitmentId)
  const amountCents = Math.round(parseFloat(amount || "0") * 100)
  const exceedsRemaining = selectedCommitment && amountCents > selectedCommitment.remaining_cents

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!commitmentId || !invoiceNumber || !amount) {
      toast.error("Please fill in all required fields")
      return
    }

    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("token", token)
        formData.append("commitment_id", commitmentId)
        formData.append("bill_number", invoiceNumber)
        formData.append("amount_cents", amountCents.toString())
        formData.append("project_id", projectId)
        if (periodStart) formData.append("period_start", periodStart)
        if (periodEnd) formData.append("period_end", periodEnd)
        if (description) formData.append("description", description)
        if (file) formData.append("file", file)

        const result = await submitVendorInvoiceAction(formData)

        if (result.success) {
          toast.success("Invoice submitted successfully")
          router.push(`/s/${token}`)
        } else {
          toast.error(result.error ?? "Failed to submit invoice")
        }
      } catch (error) {
        toast.error("An error occurred while submitting")
      }
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background">
        <div className="flex items-center gap-3 px-4 py-3">
          <Button type="button" variant="ghost" size="icon" asChild>
            <Link href={`/s/${token}`}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">Submit Invoice</h1>
            <p className="text-xs text-muted-foreground">{companyName}</p>
          </div>
          <Button type="submit" disabled={isPending || !commitmentId || !invoiceNumber || !amount}>
            {isPending && <Spinner className="mr-2 h-4 w-4" />}
            Submit
          </Button>
        </div>
      </header>

      <div className="p-4 space-y-4 max-w-lg mx-auto">
        {/* Contract Selection */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Contract</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={commitmentId} onValueChange={setCommitmentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select contract..." />
              </SelectTrigger>
              <SelectContent>
                {commitments.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title} ({formatCurrency(c.remaining_cents)} remaining)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedCommitment && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/50">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Contract Total</span>
                  <span className="font-medium">{formatCurrency(selectedCommitment.total_cents)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Previously Billed</span>
                  <span>{formatCurrency(selectedCommitment.billed_cents)}</span>
                </div>
                <Progress
                  value={(selectedCommitment.billed_cents / selectedCommitment.total_cents) * 100}
                  className="h-2"
                />
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Available to Bill</span>
                  <span className="font-medium text-primary">
                    {formatCurrency(selectedCommitment.remaining_cents)}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoice Details */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invoiceNumber">Invoice Number *</Label>
              <Input
                id="invoiceNumber"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="e.g., INV-001"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount *</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="pl-7"
                  placeholder="0.00"
                  required
                />
              </div>
              {exceedsRemaining && (
                <div className="flex items-center gap-2 text-warning text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  <span>Amount exceeds remaining budget (may require change order)</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="periodStart">Period Start</Label>
                <Input
                  id="periodStart"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="periodEnd">Period End</Label>
                <Input
                  id="periodEnd"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description / Notes</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Work performed, materials provided, etc."
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* File Upload */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Backup Documentation</CardTitle>
            <CardDescription>Attach invoice PDF or supporting documents</CardDescription>
          </CardHeader>
          <CardContent>
            <label className="flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer hover:border-primary/50 transition-colors">
              <Upload className="h-8 w-8 text-muted-foreground mb-2" />
              {file ? (
                <p className="text-sm font-medium">{file.name}</p>
              ) : (
                <>
                  <p className="text-sm font-medium">Click to upload</p>
                  <p className="text-xs text-muted-foreground">PDF, PNG, JPG up to 10MB</p>
                </>
              )}
              <input
                type="file"
                className="hidden"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </CardContent>
        </Card>
      </div>
    </form>
  )
}
```

### 9. Server Actions

**File:** `app/s/[token]/actions.ts`

```typescript
"use server"

import { revalidatePath } from "next/cache"
import { validatePortalToken } from "@/lib/services/portal-access"
import { createVendorBillFromPortal } from "@/lib/services/vendor-bills"
import { uploadFile } from "@/lib/services/files"

export async function submitVendorInvoiceAction(formData: FormData): Promise<{
  success: boolean
  error?: string
  billId?: string
}> {
  try {
    const token = formData.get("token") as string
    const commitmentId = formData.get("commitment_id") as string
    const billNumber = formData.get("bill_number") as string
    const amountCents = parseInt(formData.get("amount_cents") as string, 10)
    const projectId = formData.get("project_id") as string
    const periodStart = formData.get("period_start") as string | null
    const periodEnd = formData.get("period_end") as string | null
    const description = formData.get("description") as string | null
    const file = formData.get("file") as File | null

    // Validate token
    const access = await validatePortalToken(token)
    if (!access || access.portal_type !== "sub" || !access.company_id) {
      return { success: false, error: "Invalid or expired portal access" }
    }

    if (!access.permissions.can_submit_invoices) {
      return { success: false, error: "You don't have permission to submit invoices" }
    }

    // Upload file if provided
    let fileId: string | undefined
    if (file && file.size > 0) {
      const uploaded = await uploadFile({
        file,
        orgId: access.org_id,
        projectId,
        category: "vendor_bills",
        uploadedByContactId: access.contact_id ?? undefined,
      })
      fileId = uploaded.id
    }

    // Create vendor bill
    const bill = await createVendorBillFromPortal({
      orgId: access.org_id,
      projectId,
      commitmentId,
      billNumber,
      totalCents: amountCents,
      billDate: new Date().toISOString().split("T")[0],
      dueDate: periodEnd ?? undefined,
      description: description ?? undefined,
      fileId,
      submittedByContactId: access.contact_id ?? undefined,
      metadata: {
        period_start: periodStart,
        period_end: periodEnd,
        submitted_via_portal: true,
        portal_token_id: access.id,
      },
    })

    revalidatePath(`/s/${token}`)

    return { success: true, billId: bill.id }
  } catch (error) {
    console.error("Error submitting vendor invoice:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to submit invoice"
    }
  }
}
```

### 10. Vendor Bill Creation Service

**File:** `lib/services/vendor-bills.ts`

Add new function:

```typescript
export async function createVendorBillFromPortal({
  orgId,
  projectId,
  commitmentId,
  billNumber,
  totalCents,
  billDate,
  dueDate,
  description,
  fileId,
  submittedByContactId,
  metadata,
}: {
  orgId: string
  projectId: string
  commitmentId: string
  billNumber: string
  totalCents: number
  billDate: string
  dueDate?: string
  description?: string
  fileId?: string
  submittedByContactId?: string
  metadata?: Record<string, unknown>
}): Promise<VendorBillSummary> {
  const supabase = createServiceSupabaseClient()

  // Verify commitment exists and belongs to the project
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, company_id, title, total_cents")
    .eq("id", commitmentId)
    .eq("project_id", projectId)
    .eq("org_id", orgId)
    .single()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or access denied")
  }

  // Generate sequential bill number if not provided
  const finalBillNumber = billNumber || await generateBillNumber(orgId)

  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: commitmentId,
      bill_number: finalBillNumber,
      status: "pending",
      total_cents: totalCents,
      currency: "USD",
      bill_date: billDate,
      due_date: dueDate ?? null,
      submitted_by_contact_id: submittedByContactId ?? null,
      file_id: fileId ?? null,
      metadata: {
        ...metadata,
        description,
      },
    })
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create vendor bill: ${error.message}`)
  }

  // Record event for activity feed
  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id,
    payload: {
      bill_number: finalBillNumber,
      amount_cents: totalCents,
      commitment_id: commitmentId,
      commitment_title: commitment.title,
      submitted_via_portal: true,
    },
  })

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    commitment_id: data.commitment_id,
    bill_number: data.bill_number,
    status: data.status,
    total_cents: data.total_cents,
    currency: data.currency,
    bill_date: data.bill_date,
    due_date: data.due_date,
    submitted_by_contact_id: data.submitted_by_contact_id,
    file_id: data.file_id,
    payment_reference: null,
    paid_at: null,
    project_name: "",
    commitment_title: commitment.title,
    commitment_total_cents: commitment.total_cents,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

async function generateBillNumber(orgId: string): Promise<string> {
  const supabase = createServiceSupabaseClient()
  const { count } = await supabase
    .from("vendor_bills")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)

  return `VB-${String((count ?? 0) + 1).padStart(5, "0")}`
}
```

---

## Database Migrations

### Required Schema Changes

**File:** `supabase/migrations/YYYYMMDD_sub_portal_enhancements.sql`

```sql
-- Add company_id and portal_type to portal_access_tokens
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS portal_type text NOT NULL DEFAULT 'client'
  CHECK (portal_type IN ('client', 'sub'));

CREATE INDEX IF NOT EXISTS portal_access_tokens_company_idx
  ON portal_access_tokens(company_id) WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS portal_access_tokens_portal_type_idx
  ON portal_access_tokens(portal_type);

-- Add share_with_subs flag to files
ALTER TABLE files
ADD COLUMN IF NOT EXISTS share_with_subs boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS files_share_with_subs_idx
  ON files(project_id, share_with_subs) WHERE share_with_subs = true;

-- Add can_submit_invoices to portal permissions (stored in metadata or separate column)
-- This depends on how permissions are stored. If in metadata JSON, no migration needed.
-- If separate columns:
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS can_submit_invoices boolean NOT NULL DEFAULT true;

-- Add assigned_company_id to rfis and submittals for filtering
ALTER TABLE rfis
ADD COLUMN IF NOT EXISTS assigned_company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE submittals
ADD COLUMN IF NOT EXISTS assigned_company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS rfis_assigned_company_idx ON rfis(assigned_company_id);
CREATE INDEX IF NOT EXISTS submittals_assigned_company_idx ON submittals(assigned_company_id);

-- Add conversation support for sub portal messages
-- Conversations use format: sub-{project_id}-{company_id}
-- Existing conversations table should support this; no changes needed.
```

---

## Permission Model

### Sub Portal Default Permissions

```typescript
const DEFAULT_SUB_PORTAL_PERMISSIONS: PortalPermissions = {
  // View permissions
  can_view_schedule: true,
  can_view_photos: false,         // Subs typically don't need daily log photos
  can_view_documents: true,       // Drawings, specs, etc.
  can_download_files: true,
  can_view_daily_logs: false,
  can_view_budget: false,         // Don't show full project budget to subs

  // RFI/Submittal permissions
  can_view_rfis: true,
  can_view_submittals: true,
  can_respond_rfis: true,
  can_submit_submittals: true,

  // Financial permissions (sub-specific)
  can_view_commitments: true,     // ADD: Can see their contracts
  can_view_bills: true,           // ADD: Can see their submitted invoices
  can_submit_invoices: true,      // ADD: Can submit new invoices

  // Client-focused (disabled for subs)
  can_approve_change_orders: false,
  can_submit_selections: false,
  can_create_punch_items: false,
  can_view_invoices: false,       // Client invoices, not vendor bills
  can_pay_invoices: false,

  // Communication
  can_message: true,
}
```

---

## Implementation Order

### Phase 1: Foundation (Required First) ✅ COMPLETED
1. ✅ Run database migrations - Applied `20251215_sub_portal_enhancements.sql` via Supabase MCP
   - Added `company_id` and `portal_type` to `portal_access_tokens`
   - Added `share_with_subs` to `files`
   - Added `assigned_company_id` to `rfis` and `submittals`
   - Created supporting indexes
2. ✅ Add types to `lib/types.ts` (SubPortalData, SubPortalCommitment, etc.)
3. ✅ Add `loadSubPortalData` function to `lib/services/portal-access.ts`
4. ✅ Update `validatePortalToken` to return `company_id` and `portal_type`

### Phase 2: Core UI Components ✅ COMPLETED
5. ✅ Create `components/portal/sub/sub-bottom-nav.tsx`
6. ✅ Create `components/portal/sub/sub-financial-summary.tsx`
7. ✅ Create `components/portal/sub/sub-contracts-card.tsx`
8. ✅ Create `components/portal/sub/sub-dashboard.tsx`
9. ✅ Create `components/portal/sub/sub-documents-tab.tsx`
10. ✅ Create `components/portal/sub/index.ts` (barrel export)

### Phase 3: Main Client & Entry Point ✅ COMPLETED
10. ✅ Create `app/s/[token]/sub-portal-client.tsx` - Main wrapper with PIN gate, tabs, responsive layout
11. ✅ Create `app/s/[token]/sub-rfis-tab.tsx` - RFIs tab with messaging
12. ✅ Create `app/s/[token]/sub-submittals-tab.tsx` - Submittals tab with messaging
13. ✅ Create `app/s/[token]/sub-messages-tab.tsx` - General messaging tab
14. ✅ Update `app/s/[token]/page.tsx` - Uses new client, validates portal_type and company_id
15. ✅ PIN protection works via existing PortalPinGate component

### Phase 4: Invoice Submission
13. Add `createVendorBillFromPortal` to `lib/services/vendor-bills.ts`
14. Create `app/s/[token]/actions.ts` with submit action
15. Create `components/portal/sub/sub-invoice-form.tsx`
16. Create `app/s/[token]/submit-invoice/page.tsx`

### Phase 5: Additional Pages
17. Create `app/s/[token]/commitments/page.tsx` (full list)
18. Create `app/s/[token]/bills/page.tsx` (full list with status)
19. Create `app/s/[token]/documents/page.tsx` (dedicated page)

### Phase 6: Polish & Testing ✅ COMPLETED
20. ✅ Add file sharing UI in main app (share_with_subs toggle)
21. ✅ Add sub portal token generation in sharing settings - Updated AccessTokenGenerator with company selection
22. ✅ Test full flow end-to-end
23. ✅ Add loading states and error handling - Added backwards-compatible setup screen

---

## Testing Checklist

### Access & Authentication
- [ ] Sub portal token validates correctly
- [ ] Invalid/expired tokens show 404
- [ ] PIN gate appears when pin_required is true
- [ ] PIN validation works (correct/incorrect attempts)
- [ ] PIN lockout after 5 failed attempts

### Dashboard
- [ ] Company name and trade display correctly
- [ ] Financial summary shows accurate totals
- [ ] Contracts show with correct billed/remaining amounts
- [ ] Progress bars calculate correctly
- [ ] "Needs Attention" shows pending RFIs/submittals
- [ ] Schedule shows only tasks assigned to this company
- [ ] Recent invoices display with correct status

### Invoice Submission
- [ ] Contract dropdown shows only approved contracts with remaining budget
- [ ] Contract details (total, billed, remaining) update when selected
- [ ] Warning shows when amount exceeds remaining
- [ ] File upload works (PDF, images)
- [ ] Form validation prevents empty submissions
- [ ] Successful submission creates vendor_bill record
- [ ] Redirect back to dashboard after success
- [ ] Activity event recorded for submission

### Documents
- [ ] Files with share_with_subs=true appear
- [ ] Category filtering works
- [ ] Search filters by filename
- [ ] Download button works (if permitted)
- [ ] Preview opens in new tab
- [ ] Empty state shows when no files

### RFIs & Submittals
- [ ] Only RFIs assigned to this company appear
- [ ] Only submittals assigned to this company appear
- [ ] Messaging works within RFI/submittal context
- [ ] Pending counts accurate in nav badge

### Navigation
- [ ] Bottom nav works on mobile
- [ ] Tab navigation works on desktop
- [ ] Active states display correctly
- [ ] Badge indicators show for pending items

### Responsive Design
- [ ] Mobile layout uses bottom nav
- [ ] Desktop layout uses horizontal tabs
- [ ] All components render correctly at various widths
- [ ] Safe area insets work on iOS

---

## Future Enhancements (Not in Scope)

1. **Multi-project view**: Single login to see all projects for a sub
2. **Lien waiver submission**: Upload conditional/unconditional waivers
3. **Payment notifications**: Push/email when bills get paid
4. **Compliance reminders**: Alert when insurance is expiring
5. **Schedule conflict reporting**: Sub can flag schedule issues
6. **Photo upload**: Sub can upload progress photos
7. **Time tracking**: Log hours against commitments

---

## File Reference Summary

### New Files
```
app/s/[token]/actions.ts
app/s/[token]/sub-portal-client.tsx
app/s/[token]/submit-invoice/page.tsx
app/s/[token]/commitments/page.tsx
app/s/[token]/bills/page.tsx
app/s/[token]/documents/page.tsx
components/portal/sub/sub-bottom-nav.tsx
components/portal/sub/sub-dashboard.tsx
components/portal/sub/sub-financial-summary.tsx
components/portal/sub/sub-contracts-card.tsx
components/portal/sub/sub-documents-tab.tsx
components/portal/sub/sub-invoice-form.tsx
components/portal/sub/sub-rfis-tab.tsx
components/portal/sub/sub-submittals-tab.tsx
components/portal/sub/sub-messages-tab.tsx
supabase/migrations/YYYYMMDD_sub_portal_enhancements.sql
```

### Modified Files
```
lib/types.ts
lib/services/portal-access.ts
lib/services/vendor-bills.ts
app/s/[token]/page.tsx
```
