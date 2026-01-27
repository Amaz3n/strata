# Strata Portal Redesign & Feature Optimization Gameplan

> **Purpose**: Transform the portal from an internal preview tool into a killer client/subcontractor-facing feature that differentiates Strata from Procore/Buildertrend for local builders.
>
> **Target Market**: Local city builders, residential remodelers, small commercial contractors (1-20 employees, $500K-$10M annual revenue)

---

### Progress Log (2025-12-05)
- ✅ Phase 1: External portal foundation
  - Public routes `/p/[token]`, `/s/[token]` with token validation and data loading
  - Internal `/sharing` page with token generation/revocation and permission toggles
  - Navigation restructured per plan
  - Portal access service + RPC helpers in DB
- ✅ Phase 2: Change Orders & Approvals
  - Portal approval page `/p/[token]/change-orders/[id]`
  - Signature capture via canvas; records approval + updates status
  - Portal home links to approval
- ✅ Phase 3: Selection Sheets
  - Portal selections UI `/p/[token]/selections` with option choosing
  - Types/services for categories/options/project selections
  - Portal home link to selections
- ✅ Phase 4: RFIs & Submittals
  - Sub portal RFIs `/s/[token]/rfis` (read-only list)
  - Sub portal submittals `/s/[token]/submittals` (read-only list)
  - Services to load RFIs/submittals
- ✅ Phase 5: Punch Lists & Closeout
  - Client portal punch list `/p/[token]/punch-list` with creation + listing
  - Portal home link to punch list
- 🚧 Phase 6: Photo Timeline & Daily Logs
  - Data aggregation RPC exists; UI not yet implemented
- 🚧 Messaging
  - Portal messaging still needs to align to portal tokens/permissions and be exposed in public portal

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Database Schema Assessment](#database-schema-assessment)
4. [Phase 1: External Portal Foundation](#phase-1-external-portal-foundation)
5. [Phase 2: Change Orders & Approvals](#phase-2-change-orders--approvals)
6. [Phase 3: Selection Sheets](#phase-3-selection-sheets)
7. [Phase 4: RFIs & Submittals](#phase-4-rfis--submittals)
8. [Phase 5: Punch Lists & Closeout](#phase-5-punch-lists--closeout)
9. [Phase 6: Photo Timeline & Daily Logs](#phase-6-photo-timeline--daily-logs)
10. [Features to Remove/Consolidate](#features-to-removeconsolidate)
11. [Navigation Restructure](#navigation-restructure)
12. [Database Migrations](#database-migrations)
13. [Service Layer Changes](#service-layer-changes)
14. [Security Considerations](#security-considerations)
15. [SaaS & Multi-Tenancy Considerations](#saas--multi-tenancy-considerations)

---

## Executive Summary

### The Problem
The current `/portal` page is an **internal admin view** that shows what clients/subs would see, but there is no actual external-facing portal URL. Clients have nowhere to go.

### The Solution
1. Create public portal routes (`/p/[token]` for clients, `/s/[token]` for subs) with magic link access
2. Transform `/portal` into a "Sharing & Access" management page
3. Build killer differentiating features: Change Order approvals, Selection Sheets, Photo Timeline
4. Consolidate redundant features (Tasks → Schedule, Budget → Project Detail)

### Key Differentiators for Local Market
- **Simplicity**: 5-minute setup vs Procore's enterprise onboarding
- **Mobile-first**: Photo capture → share with client in 30 seconds
- **One-click approvals**: Change orders approved via magic link, no account needed
- **WhatsApp/SMS notifications**: Meet builders where they communicate

---

## Current State Analysis

### What Exists (Frontend)

| Route | Status | Purpose |
|-------|--------|---------|
| `/` | Complete | Dashboard with stats, projects, tasks, activity |
| `/projects` | Complete | Project list with filtering |
| `/projects/[id]` | In Progress | Project detail (new) |
| `/tasks` | Complete | Kanban board (4 columns) |
| `/schedule` | Complete | Gantt chart, dependencies, baselines |
| `/portal` | **Misdesigned** | Internal preview, not client-facing |
| `/settings` | Complete | User preferences |
| `/auth/*` | Complete | Sign in, sign up, password reset |
| `/change-orders` | **Placeholder** | Nav item exists, no page |
| `/budget` | **Placeholder** | Nav item exists, no page |
| `/team` | **Placeholder** | Nav item exists, no page |
| `/contacts` | **Placeholder** | Nav item exists, no page |

### What Exists (Database)

The database schema is **comprehensive**. Key tables already exist:

**Core Domain** (all have org_id for multi-tenancy):
- `projects`, `project_members`, `project_settings`
- `tasks`, `task_assignments`
- `schedule_items`, `schedule_dependencies`
- `daily_logs`, `daily_log_entries`, `photos`
- `punch_items` (exists but unused in frontend)
- `files`, `file_links`, `doc_versions`

**Financials** (all exist):
- `change_orders`, `change_order_lines`
- `estimates`, `estimate_items`
- `proposals`, `contracts`
- `budgets`, `budget_lines`
- `invoices`, `invoice_lines`
- `payments`, `receipts`

**CRM** (all exist):
- `companies`, `contacts`, `contact_company_links`

**Communication** (all exist):
- `conversations`, `messages`, `mentions`
- `notifications`, `notification_deliveries`

**Approvals** (generic table exists):
- `approvals` - entity_type, entity_id, status, approver_id, decision_at

### What's Missing (Database)

| Table | Purpose | Priority |
|-------|---------|----------|
| `portal_access_tokens` | Magic link authentication for external users | P0 |
| `rfis` | Request for Information tracking | P1 |
| `rfi_responses` | RFI response chain | P1 |
| `submittals` | Product/material approval tracking | P1 |
| `submittal_items` | Individual items within a submittal | P1 |
| `selections` | Client finish/material selections | P1 |
| `selection_categories` | Categories for selections (countertops, fixtures, etc.) | P1 |
| `selection_options` | Available options within a category | P1 |
| `inspection_results` | Formal inspection tracking | P2 |

---

## Database Schema Assessment

### Tables to Keep (No Changes)
These tables are well-designed and ready for use:

```
orgs, org_settings, app_users, memberships, roles, permissions, role_permissions
projects, project_members, project_settings
schedule_items, schedule_dependencies
daily_logs, daily_log_entries, photos
files, file_links, doc_versions
companies, contacts, contact_company_links
conversations, messages, mentions
notifications, notification_deliveries, user_notification_prefs
change_orders, change_order_lines
estimates, estimate_items
proposals, contracts
approvals
cost_codes
events, audit_log, outbox
custom_fields, custom_field_values
form_templates, form_instances, form_responses
workflows, workflow_runs
plans, plan_features, plan_feature_limits, subscriptions, entitlements
```

### Tables to Deprecate/Remove
These create redundancy with schedule_items:

```
tasks - MERGE INTO schedule_items (item_type = 'task')
task_assignments - MERGE INTO schedule_assignments (already exists conceptually)
```

**Reasoning**: The `schedule_items` table already supports `item_type` which can be 'task', 'milestone', 'inspection', 'handoff', 'phase', 'delivery'. Having a separate `tasks` table creates confusion about where to create work items. The Gantt chart is the canonical view; quick tasks are just schedule items without dependencies.

### Tables Already Exist But Need Frontend

```
punch_items - Has columns: id, org_id, project_id, title, description, status,
              due_date, severity, location, assigned_to, resolved_at, file_id

change_orders - Has columns: id, org_id, project_id, contract_id, title,
                description, status, reason, total_cents, approved_by, approved_at

proposals - Has columns: id, org_id, project_id, estimate_id, recipient_contact_id,
            status, sent_at, accepted_at, rejected_at, snapshot

contracts - Full contract management ready to use
```

---

## Phase 1: External Portal Foundation

### Objective
Create public-facing portal routes that clients and subcontractors can access without logging in.

### New Database Tables

```sql
-- Portal access tokens for magic link authentication
CREATE TABLE portal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Who this token is for
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,

  -- Access configuration
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  portal_type TEXT NOT NULL CHECK (portal_type IN ('client', 'sub')),

  -- Permissions (what can they see/do)
  can_view_schedule BOOLEAN NOT NULL DEFAULT true,
  can_view_photos BOOLEAN NOT NULL DEFAULT true,
  can_view_documents BOOLEAN NOT NULL DEFAULT true,
  can_view_daily_logs BOOLEAN NOT NULL DEFAULT false,
  can_view_budget BOOLEAN NOT NULL DEFAULT false,
  can_approve_change_orders BOOLEAN NOT NULL DEFAULT true,
  can_submit_selections BOOLEAN NOT NULL DEFAULT true,
  can_create_punch_items BOOLEAN NOT NULL DEFAULT false,
  can_message BOOLEAN NOT NULL DEFAULT true,

  -- Lifecycle
  created_by UUID REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ, -- NULL = never expires
  last_accessed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,

  -- Rate limiting
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX portal_access_tokens_token_idx ON portal_access_tokens (token) WHERE revoked_at IS NULL;
CREATE INDEX portal_access_tokens_project_idx ON portal_access_tokens (project_id);
CREATE INDEX portal_access_tokens_org_idx ON portal_access_tokens (org_id);

-- RLS: Service role only (tokens are validated in edge functions)
ALTER TABLE portal_access_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portal_tokens_service_role" ON portal_access_tokens
  FOR ALL USING (auth.role() = 'service_role');
```

### New Routes

| Route | Access | Purpose |
|-------|--------|---------|
| `/p/[token]` | Public (token-validated) | Client portal |
| `/s/[token]` | Public (token-validated) | Subcontractor portal |
| `/portal` | Internal (authenticated) | Manage portal sharing settings |

### Route: `/p/[token]` - Client Portal

**File Structure:**
```
app/
  p/
    [token]/
      page.tsx              # Server component - validates token, loads data
      portal-client.tsx     # Client component - renders portal UI
      actions.ts            # Server actions for client interactions
      layout.tsx            # Minimal layout (no sidebar, branded header)
```

**What Clients See:**
1. **Project Header**: Name, address, status badge, progress percentage
2. **Photo Timeline**: Visual progress by week/month with swipeable gallery
3. **Schedule Overview**: Simplified Gantt or list view of upcoming milestones
4. **Pending Actions**: Change orders awaiting approval, selections to make
5. **Recent Updates**: Latest daily log summaries, shared files
6. **Message Thread**: Two-way communication with builder

**Data Loading (Server Component):**
```typescript
// app/p/[token]/page.tsx
interface PortalPageProps {
  params: { token: string }
}

export default async function ClientPortalPage({ params }: PortalPageProps) {
  // 1. Validate token (returns project_id, org_id, permissions, contact info)
  const access = await validatePortalToken(params.token)

  if (!access) {
    return <PortalExpired />
  }

  // 2. Load portal data based on permissions
  const data = await loadClientPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    permissions: access.permissions,
  })

  // 3. Record access for analytics
  await recordPortalAccess(access.token_id)

  return (
    <ClientPortalLayout org={data.org} project={data.project}>
      <ClientPortalView data={data} permissions={access.permissions} />
    </ClientPortalLayout>
  )
}
```

### Route: `/portal` - Internal Management (Rename to "Sharing")

**Transform current `/portal` page into:**
1. Project selector
2. Per-project sharing settings
3. Generate/revoke access links
4. View who has accessed and when
5. Configure what each audience can see

**UI Layout:**
```
+------------------------------------------+
| Sharing & Access                          |
| Control what clients and subs can see     |
+------------------------------------------+
| Project: [Dropdown: Kitchen Remodel v]    |
+------------------------------------------+
| CLIENT PORTAL                             |
| +--------------------------------------+  |
| | Access Link: https://app.../p/abc123 |  |
| | [Copy] [Regenerate] [Revoke]         |  |
| +--------------------------------------+  |
| | Shared with: John Smith (Client)     |  |
| | Last accessed: 2 hours ago           |  |
| +--------------------------------------+  |
| | Permissions:                         |  |
| | [x] View schedule                    |  |
| | [x] View photos                      |  |
| | [x] Approve change orders            |  |
| | [ ] View daily logs                  |  |
| | [ ] View budget details              |  |
| +--------------------------------------+  |
+------------------------------------------+
| SUBCONTRACTOR PORTAL                      |
| (Similar structure)                       |
+------------------------------------------+
```

### Service Layer

**New Service: `lib/services/portal-access.ts`**

```typescript
// Generate a new portal access token
export async function createPortalAccessToken({
  projectId,
  portalType,
  contactId,
  companyId,
  permissions,
  expiresAt,
  orgId,
}: CreatePortalAccessInput): Promise<PortalAccessToken>

// Validate a token and return access details
export async function validatePortalToken(token: string): Promise<PortalAccess | null>

// Revoke a token
export async function revokePortalToken(tokenId: string, orgId?: string): Promise<void>

// List all tokens for a project
export async function listPortalTokens(projectId: string, orgId?: string): Promise<PortalAccessToken[]>

// Record an access event
export async function recordPortalAccess(tokenId: string): Promise<void>

// Load client portal data (respects permissions)
export async function loadClientPortalData({
  orgId,
  projectId,
  permissions,
}: LoadPortalDataInput): Promise<ClientPortalData>

// Load sub portal data (respects permissions)
export async function loadSubPortalData({
  orgId,
  projectId,
  permissions,
}: LoadPortalDataInput): Promise<SubPortalData>
```

### Types

```typescript
// lib/types.ts additions

export interface PortalAccessToken {
  id: string
  org_id: string
  project_id: string
  contact_id?: string
  company_id?: string
  token: string
  portal_type: 'client' | 'sub'
  permissions: PortalPermissions
  created_by?: string
  created_at: string
  expires_at?: string
  last_accessed_at?: string
  revoked_at?: string
  access_count: number
  // Joined data
  contact?: Contact
  company?: Company
}

export interface PortalPermissions {
  can_view_schedule: boolean
  can_view_photos: boolean
  can_view_documents: boolean
  can_view_daily_logs: boolean
  can_view_budget: boolean
  can_approve_change_orders: boolean
  can_submit_selections: boolean
  can_create_punch_items: boolean
  can_message: boolean
}

export interface ClientPortalData {
  org: { name: string; logo_url?: string }
  project: Project
  schedule: ScheduleItem[]
  photos: PhotoTimelineEntry[]
  pendingChangeOrders: ChangeOrder[]
  pendingSelections: Selection[]
  recentLogs: DailyLog[]
  sharedFiles: FileMetadata[]
  messages: PortalMessage[]
  punchItems: PunchItem[]
}

export interface PhotoTimelineEntry {
  week_start: string
  week_end: string
  photos: Photo[]
  log_summaries: string[]
}
```

---

## Phase 2: Change Orders & Approvals

**Status: Complete (builder can create/publish change orders; client approval flow live).**

### Objective
Make change order approval the killer feature - one-click approval via magic link.

### Database Status
**Already exists**: `change_orders`, `change_order_lines`, `approvals` tables

### Enhancements Needed

```sql
-- Add signature capture to approvals
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_data TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_ip INET;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

-- Add client-facing fields to change_orders
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS requires_signature BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS days_impact INTEGER; -- schedule impact
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS summary TEXT; -- client-friendly summary
```

### Workflow

1. **Builder creates change order** (internal)
   - Title, description, line items, total
   - Mark as "client_visible" when ready

2. **System generates approval link**
   - Uses portal_access_tokens with `can_approve_change_orders = true`
   - Sends notification (email/SMS/WhatsApp)

3. **Client clicks link, views change order**
   - Shows: summary, line items, total, schedule impact
   - Options: [Approve] [Request Changes]

4. **Client approves**
   - Captures signature (canvas draw)
   - Records IP, timestamp
   - Updates change_order status to 'approved'
   - Creates approval record
   - Triggers notification to builder

5. **Client requests changes**
   - Opens message thread
   - Change order stays pending

### UI Components

**New Components:**
```
components/
  change-orders/
    change-order-list.tsx       # List view for internal users
    change-order-sheet.tsx      # Create/edit slide-out panel
    change-order-lines.tsx      # Line item editor
    change-order-preview.tsx    # Preview what client sees

  portal/
    change-order-approval.tsx   # Client-facing approval view
    signature-pad.tsx           # Canvas-based signature capture
    approval-success.tsx        # Confirmation after approval
```

**Client Approval View (`/p/[token]/change-orders/[id]`):**
```
+------------------------------------------+
| [Logo] Kitchen Remodel Project           |
+------------------------------------------+
| CHANGE ORDER #003                         |
| Requested: Nov 15, 2024                   |
+------------------------------------------+
| Add recessed lighting in living room     |
|                                          |
| This change order adds 6 recessed LED    |
| lights to the living room ceiling.       |
+------------------------------------------+
| ITEMIZED COSTS                           |
| +--------------------------------------+ |
| | 6x LED recessed fixtures    $480.00  | |
| | Electrical labor (4 hrs)    $320.00  | |
| | Permit fee                   $75.00  | |
| +--------------------------------------+ |
| | TOTAL                       $875.00  | |
| +--------------------------------------+ |
+------------------------------------------+
| SCHEDULE IMPACT                          |
| This adds approximately 1 day to the     |
| project timeline.                        |
+------------------------------------------+
| Sign below to approve this change order: |
| +--------------------------------------+ |
| |                                      | |
| |     [Signature Canvas]               | |
| |                                      | |
| +--------------------------------------+ |
| [ Clear ]                                |
|                                          |
| [    Approve Change Order    ]           |
|                                          |
| Have questions? [Request Changes]        |
+------------------------------------------+
```

### Service Layer

**Enhance: `lib/services/change-orders.ts`**

```typescript
// Create a change order
export async function createChangeOrder(input: ChangeOrderInput): Promise<ChangeOrder>

// Update change order
export async function updateChangeOrder(id: string, input: Partial<ChangeOrderInput>): Promise<ChangeOrder>

// Mark as client-visible (triggers notification)
export async function publishChangeOrder(id: string): Promise<ChangeOrder>

// Client approves (called from portal)
export async function approveChangeOrder({
  changeOrderId,
  tokenId,
  signatureData,
  signatureIp,
}: ApproveChangeOrderInput): Promise<Approval>

// Client requests changes (creates message)
export async function requestChangeOrderChanges({
  changeOrderId,
  tokenId,
  message,
}: RequestChangesInput): Promise<Message>

// List change orders for a project
export async function listChangeOrders(projectId: string, orgId?: string): Promise<ChangeOrder[]>

// Get change order with lines
export async function getChangeOrderWithLines(id: string, orgId?: string): Promise<ChangeOrderWithLines>
```

---

## Phase 3: Selection Sheets

### Objective
Let clients choose finishes, fixtures, and materials through the portal.

### New Database Tables

```sql
-- Selection categories (templates per org)
CREATE TABLE selection_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_template BOOLEAN NOT NULL DEFAULT false, -- org-wide template vs project-specific
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX selection_categories_org_idx ON selection_categories (org_id);
CREATE TRIGGER selection_categories_set_updated_at BEFORE UPDATE ON selection_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Selection options (available choices within a category)
CREATE TABLE selection_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,

  -- Pricing
  price_cents INTEGER,
  price_type TEXT CHECK (price_type IN ('included', 'upgrade', 'downgrade')),
  price_delta_cents INTEGER, -- difference from base

  -- Media
  image_url TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,

  -- Metadata
  sku TEXT,
  vendor TEXT,
  lead_time_days INTEGER,

  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false, -- pre-selected option
  is_available BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX selection_options_category_idx ON selection_options (category_id);
CREATE INDEX selection_options_org_idx ON selection_options (org_id);
CREATE TRIGGER selection_options_set_updated_at BEFORE UPDATE ON selection_options
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Project selections (client's choices)
CREATE TABLE project_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,

  -- The chosen option (NULL = not yet selected)
  selected_option_id UUID REFERENCES selection_options(id) ON DELETE SET NULL,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'selected', 'confirmed', 'ordered', 'received')),

  -- Deadlines
  due_date DATE,
  selected_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,

  -- Who made the selection
  selected_by_user_id UUID REFERENCES app_users(id),
  selected_by_contact_id UUID REFERENCES contacts(id),

  -- Notes
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, category_id)
);

CREATE INDEX project_selections_project_idx ON project_selections (project_id);
CREATE INDEX project_selections_org_idx ON project_selections (org_id);
CREATE TRIGGER project_selections_set_updated_at BEFORE UPDATE ON project_selections
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- RLS
ALTER TABLE selection_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE selection_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_selections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "selection_categories_access" ON selection_categories
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
CREATE POLICY "selection_options_access" ON selection_options
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
CREATE POLICY "project_selections_access" ON project_selections
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
```

### Workflow

1. **Builder sets up selection categories** (one-time or per project)
   - E.g., "Kitchen Countertops", "Master Bath Fixtures", "Flooring"

2. **Builder adds options to each category**
   - Name, photo, price (included/upgrade/downgrade)
   - Mark one as "default" if pre-selected in contract

3. **Builder assigns selections to project**
   - Sets due dates for time-sensitive items

4. **Client views selections in portal**
   - Sees categories with options
   - Current selection highlighted
   - Price impact shown

5. **Client makes selection**
   - Selects option
   - System records who selected, when
   - Notification sent to builder

6. **Builder confirms/orders**
   - Updates status: confirmed → ordered → received

### UI Components

**Client Selection View (`/p/[token]/selections`):**
```
+------------------------------------------+
| YOUR SELECTIONS                          |
| 3 of 8 selections made                   |
+------------------------------------------+
| KITCHEN COUNTERTOPS            Due: Dec 1 |
| +--------------------------------------+ |
| | [Image] Granite - Absolute Black     | |
| |         Included in contract         | |
| |         [Currently Selected]         | |
| +--------------------------------------+ |
| | [Image] Quartz - Calacatta           | |
| |         +$1,200 upgrade              | |
| |         [Select This Option]         | |
| +--------------------------------------+ |
| | [Image] Marble - Carrara             | |
| |         +$2,400 upgrade              | |
| |         [Select This Option]         | |
| +--------------------------------------+ |
+------------------------------------------+
| MASTER BATH FIXTURES           Due: Dec 15|
| Status: Pending your selection           |
| [View Options →]                         |
+------------------------------------------+
```

---

## Phase 4: RFIs & Submittals

### Objective
Professional document management for information requests and material approvals.

### New Database Tables

```sql
-- Request for Information
CREATE TABLE rfis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- RFI details
  rfi_number INTEGER NOT NULL, -- auto-increment per project
  subject TEXT NOT NULL,
  question TEXT NOT NULL,

  -- Status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'answered', 'closed')),
  priority TEXT CHECK (priority IN ('low', 'normal', 'high', 'urgent')),

  -- Assignments
  submitted_by UUID REFERENCES app_users(id),
  submitted_by_company_id UUID REFERENCES companies(id),
  assigned_to UUID REFERENCES app_users(id),

  -- Dates
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  answered_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  -- Cost/schedule impact (filled when answering)
  cost_impact_cents INTEGER,
  schedule_impact_days INTEGER,

  -- References
  drawing_reference TEXT, -- e.g., "Sheet A-201, Detail 3"
  spec_reference TEXT,    -- e.g., "Section 03300"
  location TEXT,          -- e.g., "2nd Floor, Unit 201"

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, rfi_number)
);

CREATE INDEX rfis_project_idx ON rfis (project_id);
CREATE INDEX rfis_org_idx ON rfis (org_id);
CREATE TRIGGER rfis_set_updated_at BEFORE UPDATE ON rfis
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- RFI responses (thread of answers)
CREATE TABLE rfi_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rfi_id UUID NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,

  response_type TEXT NOT NULL CHECK (response_type IN ('answer', 'clarification', 'comment')),
  body TEXT NOT NULL,

  -- Who responded
  responder_user_id UUID REFERENCES app_users(id),
  responder_contact_id UUID REFERENCES contacts(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rfi_responses_rfi_idx ON rfi_responses (rfi_id);

-- Submittals (material/product approvals)
CREATE TABLE submittals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Submittal details
  submittal_number INTEGER NOT NULL, -- auto-increment per project
  title TEXT NOT NULL,
  description TEXT,

  -- What's being submitted
  spec_section TEXT,      -- e.g., "09 91 00 - Painting"
  submittal_type TEXT CHECK (submittal_type IN ('product_data', 'shop_drawing', 'sample', 'mock_up', 'certificate', 'other')),

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),

  -- Parties
  submitted_by_company_id UUID REFERENCES companies(id),
  submitted_by_contact_id UUID REFERENCES contacts(id),
  reviewed_by UUID REFERENCES app_users(id),

  -- Dates
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  reviewed_at TIMESTAMPTZ,

  -- Review notes
  review_notes TEXT,

  -- Lead time tracking
  lead_time_days INTEGER,
  required_on_site DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, submittal_number)
);

CREATE INDEX submittals_project_idx ON submittals (project_id);
CREATE INDEX submittals_org_idx ON submittals (org_id);
CREATE TRIGGER submittals_set_updated_at BEFORE UPDATE ON submittals
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Submittal items (individual documents/samples within a submittal)
CREATE TABLE submittal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  submittal_id UUID NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,

  item_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  manufacturer TEXT,
  model_number TEXT,

  -- Attached file
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,

  -- Individual item status (optional, if tracking separately)
  status TEXT CHECK (status IN ('pending', 'approved', 'rejected')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (submittal_id, item_number)
);

CREATE INDEX submittal_items_submittal_idx ON submittal_items (submittal_id);

-- RLS
ALTER TABLE rfis ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfi_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE submittals ENABLE ROW LEVEL SECURITY;
ALTER TABLE submittal_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rfis_access" ON rfis
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
CREATE POLICY "rfi_responses_access" ON rfi_responses
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
CREATE POLICY "submittals_access" ON submittals
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
CREATE POLICY "submittal_items_access" ON submittal_items
  FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));

-- Auto-increment RFI number per project
CREATE OR REPLACE FUNCTION next_rfi_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(rfi_number), 0) + 1 FROM rfis WHERE project_id = p_project_id;
$$ LANGUAGE SQL;

-- Auto-increment submittal number per project
CREATE OR REPLACE FUNCTION next_submittal_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(submittal_number), 0) + 1 FROM submittals WHERE project_id = p_project_id;
$$ LANGUAGE SQL;
```

### Sub Portal RFI/Submittal View

Subcontractors should be able to:
1. View RFIs assigned to them
2. Submit RFI responses
3. Create and track submittals
4. Upload submittal documents

---

## Phase 5: Punch Lists & Closeout

### Objective
Enable clients to create punch items during walkthrough, with photo capture.

### Database Status
**Already exists**: `punch_items` table with all needed columns.

### Enhancements

```sql
-- Add portal-related fields
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS created_via_portal BOOLEAN DEFAULT false;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS portal_token_id UUID REFERENCES portal_access_tokens(id);
```

### Workflow

1. **Builder initiates punch list phase**
   - Marks project for punch list
   - Sends portal link to client

2. **Client walks through property**
   - Opens portal on phone
   - Takes photos of issues
   - Adds description, location

3. **Builder reviews punch items**
   - Assigns to team/subs
   - Sets priority, due dates

4. **Team resolves items**
   - Marks complete with photo
   - Client can verify via portal

5. **Final signoff**
   - All items resolved
   - Client approves completion

### Client Punch List View

```
+------------------------------------------+
| PUNCH LIST                               |
| 3 items remaining · 12 resolved          |
+------------------------------------------+
| [+ Add New Item]                         |
+------------------------------------------+
| OPEN ITEMS                               |
| +--------------------------------------+ |
| | [Photo] Paint touch-up needed        | |
| |         Living room, north wall      | |
| |         Created: Nov 15              | |
| |         Status: Assigned             | |
| +--------------------------------------+ |
| | [Photo] Cabinet door alignment       | |
| |         Kitchen, upper cabinets      | |
| |         Created: Nov 15              | |
| |         Status: In Progress          | |
| +--------------------------------------+ |
+------------------------------------------+
```

---

## Phase 6: Photo Timeline & Daily Logs

### Objective
Transform daily log photos into a visual project timeline that clients love.

### Implementation

**Data Aggregation Query:**
```sql
-- Aggregate photos by week with daily log context
SELECT
  date_trunc('week', p.taken_at) AS week_start,
  date_trunc('week', p.taken_at) + INTERVAL '6 days' AS week_end,
  ARRAY_AGG(DISTINCT jsonb_build_object(
    'id', p.id,
    'url', f.storage_path,
    'taken_at', p.taken_at,
    'tags', p.tags
  ) ORDER BY p.taken_at) AS photos,
  ARRAY_AGG(DISTINCT dl.summary) FILTER (WHERE dl.summary IS NOT NULL) AS summaries
FROM photos p
JOIN files f ON f.id = p.file_id
LEFT JOIN daily_logs dl ON dl.id = p.daily_log_id
WHERE p.project_id = $1 AND p.org_id = $2
GROUP BY date_trunc('week', p.taken_at)
ORDER BY week_start DESC;
```

**UI Component:**
```
+------------------------------------------+
| PHOTO TIMELINE                           |
| See your project come to life            |
+------------------------------------------+
| WEEK OF NOV 11-17                        |
| Framing complete, electrical rough-in    |
| +--------------------------------------+ |
| | [Photo] [Photo] [Photo] [Photo] +3   | |
| +--------------------------------------+ |
+------------------------------------------+
| WEEK OF NOV 4-10                         |
| Foundation poured, framing started       |
| +--------------------------------------+ |
| | [Photo] [Photo] [Photo] [Photo] +5   | |
| +--------------------------------------+ |
+------------------------------------------+
```

---

## Remaining Items to Reach Full Portal Readiness

- Photo timeline UI and daily logs surface in portal (timeline using `photo_timeline_for_portal`, daily log summaries).
- Internal management UIs: change orders (list/detail/create with `client_visible`), invoices/billing, RFIs/submittals (list/detail/status updates), selection management (categories/options assignment).
- Portal analytics & admin: per-token access history, revoke/regenerate, rate limiting/abuse protection, project-level sharing tab visibility.
- Messaging for builders: expose portal conversations in a first-class internal view (e.g., project Sharing tab) and add notifications (email/SMS/WhatsApp/Slack) for new portal messages.
- Notifications: change-order approval, selection submission, punch creation, RFI/submittal comments routed to the project team.
- Branding/polish: portal header with logo/contact info; improved empty/loading/error states.
- Authorization hardening: strict token-only actions (no org session bleed), IP capture for signatures, optional expiry/max access count per token.
- Documents: portal file access (respect `can_view_documents`) with simple file list/download.
- Tests/QA: e2e/regression around token validation, messaging, approvals, selections, punch flows; add edge-function guardrails if needed.
- Deployment hygiene: choose single package manager, set Next.js `turbopack.root`, ensure service-role env vars are configured in Vercel.

## Features to Remove/Consolidate

### 1. Remove: Separate `/tasks` Page

**Why**: Creates confusion with schedule_items. A task is just a schedule item without dependencies.

**Migration Path:**
1. Add `item_type = 'task'` to existing tasks when migrating to schedule_items
2. Update Tasks Kanban to filter `schedule_items WHERE item_type = 'task'`
3. Or embed Kanban as a view within Schedule page

**Database Migration:**
```sql
-- Migrate tasks to schedule_items
INSERT INTO schedule_items (
  id, org_id, project_id, name, item_type, status,
  start_date, end_date, metadata, created_at, updated_at
)
SELECT
  id, org_id, project_id, title, 'task',
  CASE status
    WHEN 'todo' THEN 'planned'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'blocked' THEN 'blocked'
    WHEN 'done' THEN 'completed'
  END,
  start_date, due_date,
  jsonb_build_object('priority', priority, 'description', description, 'migrated_from', 'tasks'),
  created_at, updated_at
FROM tasks
ON CONFLICT (id) DO NOTHING;

-- Migrate task_assignments to schedule_assignments
-- (Create schedule_assignments table if not exists based on existing service code)
```

**Alternative**: Keep tasks table but make `/tasks` a **filtered view** of Schedule, not a separate concept. Rename to "Quick Tasks" and embed in Schedule page.

### 2. Remove: Separate `/budget` Page

**Why**: For local builders, budget is just:
- Original contract amount
- Sum of approved change orders
- Current total

**Migration Path:**
1. Display budget summary in Project Detail header
2. Remove `/budget` from navigation
3. Keep budget tables for orgs that want detailed cost tracking (feature flag)

**UI in Project Detail:**
```
+------------------------------------------+
| Kitchen Remodel              [Active]    |
+------------------------------------------+
| Contract: $85,000                        |
| Change Orders: +$2,400 (2 approved)      |
| Current Total: $87,400                   |
+------------------------------------------+
```

### 3. Consolidate: Internal Messages

**Why**: The `channel = 'internal'` conversation type duplicates Slack/Teams functionality.

**Recommendation**:
- Remove internal channel from portal
- Focus conversations on client/sub external communication only
- Add Slack webhook integration for notifications instead

### 4. Remove: Standalone Daily Logs Page

**Status**: Already removed (`app/daily-logs/` deleted). Daily logs are now in Project Detail.

**Confirm**: Daily logs tab should be project-context only, not a global page.

---

## Navigation Restructure

### Current Navigation (app-sidebar.tsx)
```typescript
[
  { title: "Dashboard", url: "/" },
  { title: "Projects", url: "/projects" },
  { title: "Tasks", url: "/tasks" },      // REMOVE
  { title: "Schedule", url: "/schedule" },
  { title: "Portal", url: "/portal" },    // RENAME to "Sharing"
  { title: "Change Orders", url: "/change-orders" },  // PLACEHOLDER
  { title: "Budget", url: "/budget" },    // REMOVE
  { title: "Team", url: "/team" },        // PLACEHOLDER
  { title: "Contacts", url: "/contacts" }, // PLACEHOLDER
]
```

### New Navigation Structure

```typescript
const navigation = [
  // Core
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Projects", url: "/projects", icon: FolderOpen },
  { title: "Schedule", url: "/schedule", icon: CalendarDays },

  // Document Management (collapsible)
  {
    title: "Documents",
    icon: FileText,
    items: [
      { title: "Files", url: "/files" },
      { title: "RFIs", url: "/rfis" },
      { title: "Submittals", url: "/submittals" },
    ],
  },

  // Financial (collapsible)
  {
    title: "Financial",
    icon: Receipt,
    items: [
      { title: "Change Orders", url: "/change-orders" },
      { title: "Invoices", url: "/invoices" },
    ],
  },

  // Client/Sub facing
  { title: "Sharing", url: "/sharing", icon: Share2 },  // Renamed from Portal

  // Directory
  {
    title: "Directory",
    icon: Users,
    items: [
      { title: "Team", url: "/team" },
      { title: "Contacts", url: "/contacts" },
      { title: "Companies", url: "/companies" },
    ],
  },
]
```

### Project Detail Page Structure

When viewing `/projects/[id]`, show tabs:

```
[Overview] [Schedule] [Daily Logs] [Files] [Financials] [Sharing]
```

- **Overview**: Project details, status, key metrics, recent activity
- **Schedule**: Gantt chart filtered to this project
- **Daily Logs**: List of logs with photo gallery
- **Files**: Files filtered to this project
- **Financials**: Budget summary, change orders, invoices for this project
- **Sharing**: Portal access management for this project

---

## Database Migrations

### Migration 001: Portal Access Tokens

```sql
-- migrations/001_portal_access_tokens.sql

CREATE TABLE portal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  portal_type TEXT NOT NULL CHECK (portal_type IN ('client', 'sub')),
  can_view_schedule BOOLEAN NOT NULL DEFAULT true,
  can_view_photos BOOLEAN NOT NULL DEFAULT true,
  can_view_documents BOOLEAN NOT NULL DEFAULT true,
  can_view_daily_logs BOOLEAN NOT NULL DEFAULT false,
  can_view_budget BOOLEAN NOT NULL DEFAULT false,
  can_approve_change_orders BOOLEAN NOT NULL DEFAULT true,
  can_submit_selections BOOLEAN NOT NULL DEFAULT true,
  can_create_punch_items BOOLEAN NOT NULL DEFAULT false,
  can_message BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX portal_access_tokens_token_idx ON portal_access_tokens (token) WHERE revoked_at IS NULL;
CREATE INDEX portal_access_tokens_project_idx ON portal_access_tokens (project_id);
CREATE INDEX portal_access_tokens_org_idx ON portal_access_tokens (org_id);

ALTER TABLE portal_access_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "portal_tokens_service_role" ON portal_access_tokens
  FOR ALL USING (auth.role() = 'service_role');
```

### Migration 002: Selection Sheets

```sql
-- migrations/002_selection_sheets.sql

CREATE TABLE selection_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_template BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE selection_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER,
  price_type TEXT CHECK (price_type IN ('included', 'upgrade', 'downgrade')),
  price_delta_cents INTEGER,
  image_url TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  sku TEXT,
  vendor TEXT,
  lead_time_days INTEGER,
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES selection_categories(id) ON DELETE CASCADE,
  selected_option_id UUID REFERENCES selection_options(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'selected', 'confirmed', 'ordered', 'received')),
  due_date DATE,
  selected_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  selected_by_user_id UUID REFERENCES app_users(id),
  selected_by_contact_id UUID REFERENCES contacts(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, category_id)
);

-- Indexes and triggers...
```

### Migration 003: RFIs and Submittals

```sql
-- migrations/003_rfis_submittals.sql

CREATE TABLE rfis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rfi_number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'answered', 'closed')),
  priority TEXT CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  submitted_by UUID REFERENCES app_users(id),
  submitted_by_company_id UUID REFERENCES companies(id),
  assigned_to UUID REFERENCES app_users(id),
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  answered_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cost_impact_cents INTEGER,
  schedule_impact_days INTEGER,
  drawing_reference TEXT,
  spec_reference TEXT,
  location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, rfi_number)
);

CREATE TABLE rfi_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rfi_id UUID NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
  response_type TEXT NOT NULL CHECK (response_type IN ('answer', 'clarification', 'comment')),
  body TEXT NOT NULL,
  responder_user_id UUID REFERENCES app_users(id),
  responder_contact_id UUID REFERENCES contacts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE submittals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submittal_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  spec_section TEXT,
  submittal_type TEXT CHECK (submittal_type IN ('product_data', 'shop_drawing', 'sample', 'mock_up', 'certificate', 'other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),
  submitted_by_company_id UUID REFERENCES companies(id),
  submitted_by_contact_id UUID REFERENCES contacts(id),
  reviewed_by UUID REFERENCES app_users(id),
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  lead_time_days INTEGER,
  required_on_site DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, submittal_number)
);

CREATE TABLE submittal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  submittal_id UUID NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
  item_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  manufacturer TEXT,
  model_number TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  status TEXT CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submittal_id, item_number)
);

-- Auto-increment functions
CREATE OR REPLACE FUNCTION next_rfi_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(rfi_number), 0) + 1 FROM rfis WHERE project_id = p_project_id;
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION next_submittal_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(submittal_number), 0) + 1 FROM submittals WHERE project_id = p_project_id;
$$ LANGUAGE SQL;
```

### Migration 004: Approval Enhancements

```sql
-- migrations/004_approval_enhancements.sql

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_data TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_ip INET;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS requires_signature BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS days_impact INTEGER;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS summary TEXT;

ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS created_via_portal BOOLEAN DEFAULT false;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS portal_token_id UUID REFERENCES portal_access_tokens(id);
```

---

## Service Layer Changes

### New Services to Create

| Service | File | Purpose |
|---------|------|---------|
| Portal Access | `lib/services/portal-access.ts` | Token generation, validation, permission checking |
| Selections | `lib/services/selections.ts` | Selection categories, options, project selections |
| RFIs | `lib/services/rfis.ts` | RFI CRUD, responses, status workflow |
| Submittals | `lib/services/submittals.ts` | Submittal CRUD, items, review workflow |
| Punch Lists | `lib/services/punch-lists.ts` | Punch item CRUD, portal creation |

### Services to Enhance

| Service | Changes |
|---------|---------|
| `portal.ts` | Rename to `portal-data.ts`, update to use portal-access tokens |
| `change-orders.ts` | Add approval workflow, signature capture, client visibility |
| `schedule.ts` | Add task migration support, quick-add tasks |
| `projects.ts` | Add budget summary calculation |

### Services to Deprecate

| Service | Action |
|---------|--------|
| `tasks.ts` | Migrate to `schedule.ts` with `item_type = 'task'` filter |

---

## Security Considerations

### Portal Token Security

1. **Token Generation**: 256-bit random tokens (32 bytes hex = 64 chars)
2. **Token Storage**: Hashed in database, never logged
3. **Token Validation**: Constant-time comparison to prevent timing attacks
4. **Rate Limiting**: Max 100 accesses per hour per token
5. **Expiration**: Configurable, default 90 days
6. **Revocation**: Immediate effect, UI feedback
7. **IP Logging**: Record accessor IP for audit

### RLS Policies for Portal Tables

```sql
-- Portal tokens: service_role only (validation happens in edge function)
CREATE POLICY "portal_tokens_service_role" ON portal_access_tokens
  FOR ALL USING (auth.role() = 'service_role');

-- Portal data access: validated via edge function context
-- Edge function sets custom claims after token validation
```

### Signature Security

1. **Signature Data**: Store as data URL (canvas.toDataURL())
2. **IP Recording**: Capture client IP at signature time
3. **Timestamp**: Use database server time, not client
4. **Immutability**: Once signed, approval record cannot be modified
5. **Audit Trail**: All signature events recorded in audit_log

---

## SaaS & Multi-Tenancy Considerations

### Org Isolation

All new tables include `org_id` with:
- Foreign key to `orgs(id) ON DELETE CASCADE`
- Index on `org_id` for query performance
- RLS policy requiring `is_org_member(org_id)`

### Feature Flags

Use existing `feature_flags` table to gate features:

```typescript
const PORTAL_FEATURES = {
  selections: 'portal.selections',      // Selection sheets
  rfis: 'portal.rfis',                  // RFI management
  submittals: 'portal.submittals',      // Submittal management
  punch_lists: 'portal.punch_lists',    // Client punch list creation
  whatsapp: 'notifications.whatsapp',   // WhatsApp notifications
  signature: 'approvals.signature',     // Digital signatures
}
```

### Plan Limits

Use existing `plan_feature_limits` table:

| Feature | Starter | Pro | Enterprise |
|---------|---------|-----|------------|
| Active projects | 3 | 25 | Unlimited |
| Portal access tokens | 10 | 100 | Unlimited |
| File storage | 5 GB | 50 GB | 500 GB |
| Team members | 3 | 15 | Unlimited |
| Selection categories | 10 | Unlimited | Unlimited |
| RFIs/month | 20 | 200 | Unlimited |

### Webhook/Integration Points

For future integrations (QuickBooks, Stripe, etc.), use existing `outbox` table:

```sql
-- When change order approved, queue Stripe invoice creation
INSERT INTO outbox (org_id, job_type, payload)
VALUES (
  $org_id,
  'stripe.create_invoice',
  jsonb_build_object('change_order_id', $co_id, 'amount_cents', $amount)
);
```

---

## Implementation Priority

### Phase 1 (Weeks 1-2): Foundation
- [ ] Create `portal_access_tokens` table and migration
- [ ] Create `lib/services/portal-access.ts`
- [ ] Create `/p/[token]` public route structure
- [ ] Create `/s/[token]` public route structure
- [ ] Rename `/portal` to `/sharing` and rebuild as access management
- [ ] Basic client portal: project status, messages, schedule

### Phase 2 (Weeks 3-4): Change Orders
- [ ] Enhance `change_orders` table (client_visible, signature fields)
- [ ] Create change order approval flow
- [ ] Build signature pad component
- [ ] Create `lib/services/change-orders.ts` enhancements
- [ ] Change order list/detail pages for internal users
- [ ] Change order approval page for portal users

### Phase 3 (Weeks 5-6): Selections
- [ ] Create selection tables migration
- [ ] Create `lib/services/selections.ts`
- [ ] Build selection category/option management UI
- [ ] Build client selection interface in portal
- [ ] Selection status tracking and notifications

### Phase 4 (Weeks 7-8): RFIs & Submittals
- [ ] Create RFI/submittal tables migration
- [ ] Create `lib/services/rfis.ts` and `lib/services/submittals.ts`
- [ ] Build RFI management pages
- [ ] Build submittal management pages
- [ ] Sub portal RFI/submittal views

### Phase 5 (Week 9): Punch Lists
- [ ] Enhance `punch_items` table
- [ ] Create `lib/services/punch-lists.ts`
- [ ] Build punch list management UI
- [ ] Build client punch item creation in portal
- [ ] Photo capture integration

### Phase 6 (Week 10): Polish & Launch
- [ ] Photo timeline component
- [ ] Navigation restructure
- [ ] Remove/consolidate deprecated features
- [ ] Mobile optimization pass
- [ ] Documentation and help content

---

## File Structure Summary

### New Files to Create

```
app/
  p/
    [token]/
      page.tsx
      portal-client.tsx
      actions.ts
      layout.tsx
      change-orders/
        [id]/
          page.tsx
      selections/
        page.tsx
      punch-list/
        page.tsx
  s/
    [token]/
      page.tsx
      portal-client.tsx
      actions.ts
      layout.tsx
      rfis/
        page.tsx
      submittals/
        page.tsx
  sharing/                    # Renamed from portal
    page.tsx
    sharing-client.tsx
    actions.ts
  change-orders/
    page.tsx
    change-orders-client.tsx
    actions.ts
  rfis/
    page.tsx
    rfis-client.tsx
    actions.ts
  submittals/
    page.tsx
    submittals-client.tsx
    actions.ts

components/
  portal/
    portal-header.tsx         # Branded header for public portal
    portal-layout.tsx         # Layout wrapper for public portal
    change-order-approval.tsx
    signature-pad.tsx
    selection-picker.tsx
    punch-item-creator.tsx
    photo-timeline.tsx
    message-thread.tsx
  change-orders/
    change-order-list.tsx
    change-order-sheet.tsx
    change-order-lines.tsx
  selections/
    selection-category-list.tsx
    selection-option-editor.tsx
    selection-status-badge.tsx
  rfis/
    rfi-list.tsx
    rfi-sheet.tsx
    rfi-response-thread.tsx
  submittals/
    submittal-list.tsx
    submittal-sheet.tsx
    submittal-item-list.tsx
  sharing/
    access-token-list.tsx
    access-token-generator.tsx
    permission-toggles.tsx

lib/
  services/
    portal-access.ts          # Token management
    selections.ts             # Selection sheets
    rfis.ts                   # RFI management
    submittals.ts             # Submittal management
    punch-lists.ts            # Punch list management
  validation/
    portal-access.ts
    selections.ts
    rfis.ts
    submittals.ts
    punch-lists.ts
```

### Files to Delete/Deprecate

```
app/
  portal/                     # Rename to sharing/
    page.tsx
    portal-client.tsx
    actions.ts
  tasks/                      # Remove (merge into schedule)
    page.tsx
  budget/                     # Remove (embed in project detail)
    (placeholder)

lib/
  services/
    tasks.ts                  # Deprecate (migrate to schedule.ts)
```

---

## Success Metrics

### Portal Adoption
- % of active projects with portal access enabled
- Portal access frequency per project
- Time from change order creation to approval

### Feature Usage
- Change orders approved via portal vs internal
- Selections made via portal vs internal
- Punch items created by clients

### User Satisfaction
- Client NPS score
- Builder time saved (before/after)
- Support ticket volume related to client communication

---

*This gameplan was generated to transform Strata's portal from an internal preview tool into a killer client/subcontractor-facing feature that differentiates it from enterprise solutions like Procore and Buildertrend.*
