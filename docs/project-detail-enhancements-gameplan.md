# Project Detail Enhancements Gameplan

> **LLM Context**: This document is designed for AI/LLM consumption to implement features incrementally. Each stage is self-contained with clear inputs, outputs, and verification steps.

## Executive Summary

Enhance the Project Detail page (`app/projects/[id]/project-detail-client.tsx`) to be a comprehensive hub for construction project management, adding:
1. ✅ Sharing integration (already done - portal links in project detail header)
2. Contract UI & viewing capabilities  
3. Project info enhancements (client/homeowner, location details)
4. Enhanced Team tab with project directory (subs, vendors, consultants)
5. Financials consolidation tab
6. Document signing generalization

---

## Current State Analysis

### What Exists
| Feature | Status | Location |
|---------|--------|----------|
| Portal/Sharing Links | ✅ Complete | Share button in header → Sheet with `AccessTokenGenerator` |
| Contracts table | ✅ DB exists | `contracts` table with signature_data, retainage, etc. |
| Contract creation | ✅ Auto-created | When proposals are accepted (`lib/services/proposals.ts:229-251`) |
| Contract UI | ❌ Missing | No component to view/manage contracts |
| Project.client_id | ❌ Missing | Referenced in code, but column doesn't exist in DB |
| Project location | ✅ Exists | `projects.location` jsonb column |
| Team tab | ⚠️ Partial | Shows org users via `project_members`, not external contacts |
| Project directory | ❌ Missing | No `project_vendors` junction table |
| Budget summary | ✅ Complete | Shows in Overview tab |
| Document signing | ⚠️ Proposals only | `SignaturePad` component exists but only used for proposals |

### Database Tables Reference
```
projects           - Core project data (has location jsonb, missing client_id)
contracts          - Contract records with signature_data, retainage settings
project_members    - Links app_users to projects with roles
companies          - Org-level vendor/sub companies
contacts           - Org-level contacts
portal_access_tokens - Client/sub portal links
draw_schedules     - Payment draws
retainage          - Held retainage records
invoices           - Project invoices
```

### Key Files
- `app/projects/[id]/project-detail-client.tsx` - Main component (1445 lines)
- `app/projects/[id]/page.tsx` - Server component data fetching
- `app/projects/[id]/actions.ts` - Server actions for project operations
- `lib/services/projects.ts` - Project CRUD operations
- `lib/types.ts` - Type definitions
- `components/sharing/access-token-generator.tsx` - Portal link creation

---

## Implementation Stages

### Stage 1: Database Schema Additions ✅ COMPLETED

**Goal**: Add missing DB columns/tables for client linking and project directory.

**Prerequisites**: Supabase MCP access

**Migrations Applied**:

```sql
-- Migration: add_client_id_to_projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
COMMENT ON COLUMN projects.client_id IS 'Primary client contact for this project';
```

```sql
-- Migration: create_project_vendors
CREATE TABLE project_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'subcontractor', -- 'subcontractor', 'supplier', 'consultant', 'architect', 'engineer', 'client'
  scope text, -- e.g., 'Electrical', 'Plumbing', 'Structural'
  status text NOT NULL DEFAULT 'active', -- 'active', 'invited', 'inactive'
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_has_entity CHECK (company_id IS NOT NULL OR contact_id IS NOT NULL),
  UNIQUE (project_id, company_id),
  UNIQUE (project_id, contact_id)
);

CREATE INDEX idx_project_vendors_project ON project_vendors(project_id);
CREATE INDEX idx_project_vendors_company ON project_vendors(company_id);
CREATE INDEX idx_project_vendors_contact ON project_vendors(contact_id);

-- RLS policies
ALTER TABLE project_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view project vendors in their org"
  ON project_vendors FOR SELECT
  USING (org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.uid() AND status = 'active'));

CREATE POLICY "Users can manage project vendors in their org"
  ON project_vendors FOR ALL
  USING (org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.uid() AND status = 'active'));
```

**Verification**:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'client_id';
SELECT table_name FROM information_schema.tables WHERE table_name = 'project_vendors';
```

**Applied**: ✅ Both migrations successfully applied
- Added `client_id` column to `projects` table with foreign key to `contacts(id)`
- Created `project_vendors` junction table with proper constraints and indexes
- Enabled RLS with org-scoped policies

**Output**: Schema ready for client/vendor linking.

---

### Stage 2: Types & Validation Updates

**Goal**: Add TypeScript types and Zod schemas for new entities.

**File**: `lib/types.ts`

Add:
```typescript
export type ProjectVendorRole = 'subcontractor' | 'supplier' | 'consultant' | 'architect' | 'engineer' | 'client'

export interface ProjectVendor {
  id: string
  org_id: string
  project_id: string
  company_id?: string
  contact_id?: string
  role: ProjectVendorRole
  scope?: string
  status: 'active' | 'invited' | 'inactive'
  notes?: string
  created_at: string
  updated_at: string
  // Joined data
  company?: Company
  contact?: Contact
}

export interface Contract {
  id: string
  org_id: string
  project_id: string
  proposal_id?: string
  number?: string
  title: string
  status: 'draft' | 'active' | 'amended' | 'completed' | 'terminated'
  contract_type?: 'fixed_price' | 'cost_plus' | 'time_materials' | 'unit_price'
  total_cents?: number
  currency: string
  markup_percent?: number
  retainage_percent?: number
  retainage_release_trigger?: string
  terms?: string
  effective_date?: string
  signed_at?: string
  signature_data?: {
    signature_svg?: string
    signed_at?: string
    signer_name?: string
    signer_ip?: string
  }
  snapshot: Record<string, any>
  created_at: string
  updated_at: string
}
```

**File**: `lib/validation/projects.ts`

Update `ProjectInput` to include `client_id`:
```typescript
export const projectInputSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  status: z.enum(["planning", "bidding", "active", "on_hold", "completed", "cancelled"]).optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  address: z.string().optional(),
  location: z.record(z.unknown()).optional(),
  client_id: z.string().uuid().optional().nullable(), // NEW
  description: z.string().optional(),
  property_type: z.enum(["residential", "commercial"]).optional(),
  project_type: z.enum(["new_construction", "remodel", "addition", "renovation", "repair"]).optional(),
  total_value: z.number().optional(),
})
```

**Create**: `lib/validation/project-vendors.ts`
```typescript
import { z } from 'zod'

export const projectVendorInputSchema = z.object({
  project_id: z.string().uuid(),
  company_id: z.string().uuid().optional().nullable(),
  contact_id: z.string().uuid().optional().nullable(),
  role: z.enum(['subcontractor', 'supplier', 'consultant', 'architect', 'engineer', 'client']),
  scope: z.string().optional(),
  notes: z.string().optional(),
}).refine(data => data.company_id || data.contact_id, {
  message: "Either company_id or contact_id must be provided"
})

export type ProjectVendorInput = z.infer<typeof projectVendorInputSchema>
```

**Verification**: Run `npm run build` - no type errors.

---

### Stage 3: Service Layer - Project Vendors

**Goal**: Create CRUD service for project vendors.

**Create**: `lib/services/project-vendors.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ProjectVendor } from "@/lib/types"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

function mapProjectVendor(row: any): ProjectVendor {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    company_id: row.company_id,
    contact_id: row.contact_id,
    role: row.role,
    scope: row.scope,
    status: row.status,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    company: row.company,
    contact: row.contact,
  }
}

export async function listProjectVendors(projectId: string, orgId?: string): Promise<ProjectVendor[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const { data, error } = await supabase
    .from("project_vendors")
    .select(`
      *,
      company:companies(id, name, company_type, trade, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("role", { ascending: true })
    .order("created_at", { ascending: true })
  
  if (error) throw new Error(`Failed to list project vendors: ${error.message}`)
  return (data ?? []).map(mapProjectVendor)
}

export async function addProjectVendor({
  input,
  orgId,
}: {
  input: ProjectVendorInput
  orgId?: string
}): Promise<ProjectVendor> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  
  const { data, error } = await supabase
    .from("project_vendors")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      company_id: input.company_id,
      contact_id: input.contact_id,
      role: input.role,
      scope: input.scope,
      notes: input.notes,
    })
    .select(`
      *,
      company:companies(id, name, company_type, trade, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `)
    .single()
  
  if (error) throw new Error(`Failed to add project vendor: ${error.message}`)
  
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_vendor_added",
    entityType: "project",
    entityId: input.project_id,
    payload: { role: input.role, company_id: input.company_id, contact_id: input.contact_id },
  })
  
  return mapProjectVendor(data)
}

export async function removeProjectVendor(vendorId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const { error } = await supabase
    .from("project_vendors")
    .delete()
    .eq("id", vendorId)
    .eq("org_id", resolvedOrgId)
  
  if (error) throw new Error(`Failed to remove project vendor: ${error.message}`)
}

export async function updateProjectVendor({
  vendorId,
  updates,
  orgId,
}: {
  vendorId: string
  updates: Partial<Pick<ProjectVendorInput, 'role' | 'scope' | 'notes'>>
  orgId?: string
}): Promise<ProjectVendor> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const { data, error } = await supabase
    .from("project_vendors")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", vendorId)
    .eq("org_id", resolvedOrgId)
    .select(`
      *,
      company:companies(id, name, company_type, trade, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `)
    .single()
  
  if (error) throw new Error(`Failed to update project vendor: ${error.message}`)
  return mapProjectVendor(data)
}
```

**Verification**: Import service and test basic operations.

---

### Stage 4: Service Layer - Contracts

**Goal**: Create service for viewing/listing contracts.

**Create**: `lib/services/contracts.ts`

```typescript
import type { Contract } from "@/lib/types"
import { requireOrgContext } from "@/lib/services/context"

function mapContract(row: any): Contract {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    proposal_id: row.proposal_id,
    number: row.number,
    title: row.title,
    status: row.status,
    contract_type: row.contract_type,
    total_cents: row.total_cents,
    currency: row.currency,
    markup_percent: row.markup_percent ? Number(row.markup_percent) : undefined,
    retainage_percent: row.retainage_percent ? Number(row.retainage_percent) : undefined,
    retainage_release_trigger: row.retainage_release_trigger,
    terms: row.terms,
    effective_date: row.effective_date,
    signed_at: row.signed_at,
    signature_data: row.signature_data,
    snapshot: row.snapshot,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function getProjectContract(projectId: string, orgId?: string): Promise<Contract | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const { data, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  
  if (error) throw new Error(`Failed to get contract: ${error.message}`)
  return data ? mapContract(data) : null
}

export async function listProjectContracts(projectId: string, orgId?: string): Promise<Contract[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const { data, error } = await supabase
    .from("contracts")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
  
  if (error) throw new Error(`Failed to list contracts: ${error.message}`)
  return (data ?? []).map(mapContract)
}
```

**Verification**: Run build, check types compile.

---

### Stage 5: Project Settings Sheet Component

**Goal**: Create a sheet for editing project info (client, location, details).

**Create**: `components/projects/project-settings-sheet.tsx`

Key features:
- Contact picker for client_id
- Rich location display (uses existing Google Places if available)
- Property type / project type selectors
- Description field
- Timeline (start/end dates)

```typescript
// Structure:
// - Sheet triggered from project header dropdown
// - Tabs: General | Timeline | Client
// - Save updates via server action
```

**Implementation Notes**:
- Use existing contact picker pattern from `ContactForm`
- Location input can use `GooglePlacesAutocomplete` if configured
- On save, call `updateProject` with new fields

**Verification**: Sheet opens, saves, refreshes data.

---

### Stage 6: Enhanced Team Tab - Project Directory

**Goal**: Add sub-tabs to Team tab: "Your Team" (org users) + "Directory" (external vendors/subs).

**Modify**: `app/projects/[id]/project-detail-client.tsx` (Team TabsContent)

Structure:
```
Team Tab
├── Sub-tabs: [Your Team] [Directory]
│
├── YOUR TEAM (existing project_members UI)
│   └── Grid of org user cards with roles
│
└── DIRECTORY (new)
    ├── Filter by role: All | Subcontractors | Consultants | Suppliers
    ├── Add Company/Contact button
    └── Cards showing:
        - Company name + trade
        - Primary contact
        - Phone/email
        - Scope on this project
        - Quick actions (remove, edit scope)
```

**New Components**:
- `components/projects/project-directory.tsx` - Directory tab content
- `components/projects/add-vendor-sheet.tsx` - Sheet to add company/contact to project

**Data Flow**:
1. Server action loads `listProjectVendors(projectId)`
2. Passed to client as `vendors` prop
3. Add/remove calls server actions
4. Optimistic updates for UX

**Team Picker Rules**:
- Source list: all active org memberships for the project’s org (exclude suspended/inactive users).
- Exclude users already in `project_members` for the project.
- Include the currently signed-in user; label them as “You” in the list.
- Owners/admins are not auto-added—must be added through the picker.

---

### Stage 7: Financials Tab

**Goal**: Create a new "Financials" tab consolidating contract, budget, draws, and retainage.

**Add Tab**: After "Files" tab

**Structure**:
```
Financials Tab
├── Contract Summary Card
│   ├── Contract value, type, status
│   ├── Signed date, effective date
│   ├── Retainage % and release trigger
│   └── "View Contract" button → opens contract detail sheet
│
├── Budget Summary (move/duplicate from Overview)
│   └── Adjusted budget, committed, actual, invoiced
│
├── Draw Schedule
│   ├── Table of draws with status
│   ├── Progress bar of total invoiced
│   └── "Add Draw" button if editable
│
└── Retainage Tracker
    ├── Total held
    ├── Released amount
    └── Release schedule
```

**New Components**:
- `components/projects/financials-tab.tsx` - Tab content
- `components/projects/contract-summary-card.tsx` - Contract display card
- `components/projects/draw-schedule-table.tsx` - Draw schedule list
- `components/projects/retainage-tracker.tsx` - Retainage summary

**Data Requirements**:
- Contract from `getProjectContract()`
- Draws from `listDrawSchedules(projectId)` (existing service)
- Retainage from `getProjectRetainage(projectId)` (existing service)

---

### Stage 8: Contract Detail Sheet

**Goal**: Create sheet to view contract details and signature.

**Create**: `components/contracts/contract-detail-sheet.tsx`

**Features**:
- Contract metadata (number, type, dates)
- Financial terms (total, markup, retainage)
- Terms text (scrollable)
- Signature display (if signed)
- Download as PDF button (future enhancement)

---

### Stage 9: Server Actions & Page Data Loading

**Goal**: Wire up all new data to page.tsx and actions.ts.

**Modify**: `app/projects/[id]/page.tsx`

Add data fetching:
```typescript
// Add to page data loading
const [contract, projectVendors] = await Promise.all([
  getProjectContract(projectId),
  listProjectVendors(projectId),
])

// Pass to client
<ProjectDetailClient
  {...existingProps}
  contract={contract}
  projectVendors={projectVendors}
/>
```

**Modify**: `app/projects/[id]/actions.ts`

Add server actions:
```typescript
export async function addProjectVendorAction(projectId: string, input: ProjectVendorInput) {...}
export async function removeProjectVendorAction(projectId: string, vendorId: string) {...}
export async function updateProjectVendorAction(...) {...}
export async function updateProjectSettingsAction(projectId: string, input: Partial<ProjectInput>) {...}
```

---

### Stage 10: Document Signing Generalization (Future)

**Goal**: Extend `SignaturePad` to work for change orders, lien waivers.

**Current State**: `components/portal/signature-pad.tsx` works for proposals.

**Enhancements**:
1. Create `/sign/[token]` public route optimized for mobile
2. Generalize signature storage pattern
3. Add signing flow to change orders
4. Add lien waiver signing

**Implementation Pattern**:
```typescript
// Generic signable entity interface
interface Signable {
  id: string
  signature_data?: SignatureData
  signed_at?: string
}

// Reusable signing component
<DocumentSigner
  documentType="change_order"
  documentId={changeOrder.id}
  onSigned={handleSigned}
/>
```

---

## Implementation Order

Recommended sequence for incremental delivery:

```
Week 1:
├── Stage 1: Database migrations (2h)
├── Stage 2: Types & validation (1h)
├── Stage 3: Project vendors service (2h)
└── Stage 4: Contracts service (1h)

Week 2:
├── Stage 5: Project settings sheet (4h)
├── Stage 6: Enhanced Team tab with directory (6h)
└── Stage 9: Server actions wiring (2h)

Week 3:
├── Stage 7: Financials tab (6h)
├── Stage 8: Contract detail sheet (3h)
└── Testing & polish (3h)

Future:
└── Stage 10: Document signing generalization
```

---

## Testing Checklist

### Stage Verification Commands

```bash
# After Stage 1 - Check DB
# Run via Supabase MCP:
SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'client_id';
SELECT * FROM project_vendors LIMIT 1;

# After Stage 2-4 - Build check
npm run build

# After each UI stage - Visual check
# 1. Navigate to a project detail page
# 2. Verify new UI elements render
# 3. Test CRUD operations
# 4. Check mobile responsiveness
```

---

## Dependencies & Patterns to Follow

### Existing Patterns to Reuse
- **Sheet pattern**: See `AccessTokenGenerator` sheet in project-detail-client
- **Service pattern**: See `lib/services/projects.ts` for CRUD structure
- **Contact picker**: See `components/contacts/contact-form.tsx`
- **Card grid layout**: See Team tab member cards
- **Tab structure**: See existing tabs in project-detail-client

### UI Components Available
- All shadcn/ui components (`@/components/ui/*`)
- Icons from `@/components/icons`
- Existing domain components in `components/`

### Don't Reinvent
- Use `formatDistanceToNow` from date-fns for relative dates
- Use `toast` from sonner for notifications
- Use existing `Avatar`, `Badge`, `Card` patterns
- Follow existing responsive patterns (grid-cols-1 sm:grid-cols-2 lg:grid-cols-3)

---

## Notes for AI Implementation

1. **Start each stage by reading relevant existing files** - don't assume code structure
2. **Run build after each stage** - catch type errors early
3. **Test migrations with SELECT before production** - verify schema changes
4. **Use optimistic updates** - update local state before server confirms
5. **Follow existing toast patterns** - success for confirmations, error for failures
6. **Mobile-first responsive design** - start with mobile, add lg: breakpoints
7. **Don't over-engineer** - implement exactly what's specified, no extra features

---

## Questions to Clarify Before Implementation

1. **Client linking**: Should client_id be required when creating projects, or optional?
2. **Contract amendments**: Should we support multiple contracts per project (amendments)?
3. **Vendor invites**: Should adding a vendor to a project send them an invite/notification?
4. **Mobile document signing**: Priority for generalized signing vs. contract viewing?
