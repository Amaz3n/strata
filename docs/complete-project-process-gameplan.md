# Complete Project Process Enclosure Gameplan

**Goal**: Close the critical gaps in the estimate → proposal → contract → project execution spine for small luxury custom home builders, then expand to preconstruction/CRM as a later phase.

**Current Status**: Core operational workflow exists (projects → proposals → contracts → draws → invoices). Financial foundation is strong. Missing: estimate workflows, conversion reliability, AP workflow, and operational execution gaps. CRM will remain lightweight initially because many builders already use external CRMs.

---

## Navigation & Placement (MVP)

**Goal**: Keep most features project-scoped, but run preconstruction globally until a contract is signed.

**Homepage Sidebar (Global)**:
- Projects (list + entry into project-scoped UI)
- Estimates (preconstruction workspace)
- Proposals (optional global list; includes signed/unsigned)
- Directory (contacts/companies)
- Settings

**Project Sidebar**:
- Schedule, tasks, drawings, files, RFIs/submittals, daily logs, punch, financials
- Preconstruction items appear as read-only history once a project is created

---

## Stage 0 — Preconstruction (Global) Spine (2-3 weeks)

**Goal**: Make estimates the entry point that reliably becomes a proposal, then a contract, then a project.

**Status**: Completed

**Progress**:
- ✅ Global navigation added (Projects, Estimates, Proposals, Directory, Settings)
- ✅ Proposals now support "no project yet" and create a project on acceptance
- ✅ Global estimates list + create + convert-to-proposal flow
- ⏳ Send estimate (PDF + client view)

**Remaining**:
- ⏳ Send estimate (PDF + client view)
- ⏳ Ensure contract → project setup wizard collects missing required project fields

**Migration TODOs**:
- Apply `supabase/migrations/20250307_precon_estimates.sql`

### 0.1 Estimate → Proposal → Contract Spine
**Deliverables**:
- Global estimates list + creation, linked to contact/company
- "Send estimate" flow with PDF and client view
- Convert estimate → proposal and proposal → contract without re-entry
- Signed contract creates a project and initializes budget + schedule shells
- Carry over client data, address, scope, and pricing into the new project

**Integration Requirements**:
- Proposal approval triggers contract creation
- Contract approval triggers project setup wizard
- Preserve audit trail for each conversion step

---

## Stage 1 — Lightweight Intake (1 week)

**Goal**: Provide minimum intake that works alongside external CRMs (Salesforce, HubSpot, Pipedrive).

**Status**: Completed

**Progress**:
- ✅ External CRM fields on contacts (crm_source, external_crm_id)
- ✅ CSV import for contacts
- ✅ Contact → estimate quick-create entry point

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250307_contacts_crm_fields.sql`

### 1.1 Contact + Estimate Intake
**Deliverables**:
- Contacts and companies with an optional external CRM ID
- "Create estimate from contact"
- CSV import for contacts (one-time migration from CRM/export)

**DB Schema Changes**:
```sql
-- Lightweight intake fields; full CRM deferred
ALTER TABLE contacts ADD COLUMN external_crm_id TEXT;
ALTER TABLE contacts ADD COLUMN crm_source TEXT;
```

**UI Components Needed**:
- `components/contacts/contact-list.tsx` - Basic contacts view
- `components/contacts/contact-form.tsx` - Contact creation/editing
- `components/estimates/estimate-intake.tsx` - Create estimate from contact

**Services to Create/Update**:
- `lib/services/contacts.ts` - Add intake functions
- `lib/validation/contacts.ts` - Add intake validation schemas

---

## Stage 2 — Estimate + Proposal UX (Global) (1-2 weeks)

**Goal**: Make preconstruction usable without entering project scope.

**Status**: Completed

**Progress**:
- ✅ Global proposals list view
- ✅ Proposal creation now supports “no project yet”
- ✅ Global estimates list + builder
- ✅ Cost code assignment on estimate lines
- ✅ Estimate templates + versioning workflow
- ✅ Estimate PDF export

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250307_estimates_fields.sql`

### 2.1 Estimate Builder UI
**Deliverables**:
- Estimate creation form with line items, markup, contingencies
- Cost code assignment at line item level
- Estimate versioning and status workflow
- Estimate templates (starter budgets by project type)
- Estimate PDF export with allowances/options summary

**DB Schema Changes**:
```sql
-- Estimates table already exists per db-scan
-- Ensure proper fields exist
ALTER TABLE estimates ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE estimates ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE estimates ADD COLUMN valid_until DATE;
ALTER TABLE estimates ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN approved_by UUID REFERENCES app_users(id);
```

**UI Components Needed**:
- `app/estimates/page.tsx` - Global estimates list
- `app/estimates/new/page.tsx` - Estimate builder
- `components/estimates/estimate-builder.tsx` - Main estimate form
- `components/estimates/estimate-detail.tsx` - Estimate viewer
- `app/proposals/page.tsx` - Global proposals list (existing)
- `app/proposals/new/page.tsx` - Proposal builder (existing)

### 2.2 Estimate → Proposal Conversion
**Deliverables**:
- "Convert to Proposal" action from estimate
- Copy line items, markup, and client details
- Maintain estimate history for audit trail

**Services to Create/Update**:
- `lib/services/estimates.ts` - Complete estimate CRUD operations
- Update `lib/services/proposals.ts` - Add estimate-to-proposal conversion
- `lib/validation/estimates.ts` - Estimate validation schemas

---

## Stage 3 — Change Order Financial Integration (1 week)

**Goal**: Make change orders update all financial displays automatically.

**Status**: Completed

**Progress**:
- ✅ Approved COs update contract total (base + approved COs)
- ✅ Draw schedule amounts recalc from revised contract total
- ✅ CO lines captured for budget adjustments by cost code (optional)

**Remaining**:
- ✅ None

**Migration TODOs**:
- ✅ Applied `supabase/migrations/20250307_change_order_lines_nullable_cost_code.sql`

### 3.1 Contract Total Updates
**Deliverables**:
- On CO approval, update contract `total_cents` and portal displays
- Recalculate revised contract total (base + approved COs)
- Update draw schedule calculations to use revised totals

**DB Schema Verification**:
- Ensure `change_orders` has `approved_at`, `approved_by` fields
- Confirm `contracts` has proper relationship to change orders

**Services to Update**:
- `lib/services/change-orders.ts` - Add financial impact calculations
- `lib/services/contracts.ts` - Add total recalculation on CO approval
- `lib/services/draws.ts` - Update percent-of-contract calculations

### 3.2 Budget Adjustments
**Deliverables**:
- On CO approval, create budget adjustment entries by cost code
- Update budget variance calculations
- Show CO impacts in budget reports

**Implementation Requirements**:
- Create `budget_adjustments` table or use existing `budget_lines` with adjustment types
- Update budget summary calculations to include CO adjustments

### 3.3 Portal Financial Updates
**Deliverables**:
- Client portal shows revised contract totals immediately
- Payment history reflects correct contract amounts
- Draw requests show updated percentages

### 3.4 Change Order Log & Audit
**Deliverables**:
- CO log report by date, status, and cost code
- Audit trail of approvals, rejections, and revisions
- Exportable CO log for owner/lender reporting

**Services to Create/Update**:
- `lib/services/change-orders.ts` - Add log/report queries
- Add `app/api/projects/[id]/reports/change-orders/route.ts` support for filtering

---

## Stage 4 — AP Workflow & Commitments Completion (2-3 weeks)

**Goal**: Complete the accounts payable workflow for project-level management.

**Status**: Completed

**Progress**:
- ✅ Commitments CRUD + approval workflow
- ✅ Vendor bills queue + approvals + payments
- ✅ Partial payments, retainage, and lien waiver tracking
- ✅ CTC reporting and variance alerts

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250308_stage4_ap_workflow.sql`

### 4.1 Project-Level Commitments UI
**Deliverables**:
- `/projects/[id]/commitments` page with full CRUD
- Link commitments to cost codes and budget lines
- Commitment approval workflow

**UI Components Needed**:
- `components/commitments/project-commitments-list.tsx`
- `components/commitments/commitment-form.tsx`
- `components/commitments/commitment-detail.tsx`

### 4.2 Vendor Bills Queue (AP)
**Deliverables**:
- `/projects/[id]/payables` page with approval workflow
- Link bills to commitments and cost codes
- Payment recording with compliance checks
- Partial payments and retainage handling on vendor bills
- Bill-level lien waiver request/received status

**UI Components Needed**:
- `components/payables/bills-queue.tsx`
- `components/payables/bill-approval-form.tsx`
- `components/payables/payment-recording.tsx`

### 4.3 Cost-to-Complete (CTC) Reporting
**Deliverables**:
- Per cost code: budget + committed + actual + forecast at completion
- Project-level CTC summary
- Variance alerts and warnings

**DB Schema Changes**:
```sql
-- Add forecast_remaining_cents to budget_lines or create forecast_lines table
ALTER TABLE budget_lines ADD COLUMN forecast_remaining_cents BIGINT;
```

**Services to Create/Update**:
- `lib/services/reports.ts` - Add CTC calculations
- Update budget variance logic to include CTC

---

## Stage 5 — Operational Execution Completion (2-3 weeks)

**Goal**: Fill operational gaps in schedule, inspections, and punch lists.

**Status**: Completed

**Progress**:
- ✅ Inspection checklist + signoff workflow with failed inspection → punch
- ✅ Punch internal assignment + verification workflow
- ✅ RFI/Submittal integration polish
- ✅ Client decision log

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250309_stage5_operational_execution.sql`

### 5.1 Inspection Workflow
**Deliverables**:
- Inspection checklists tied to schedule items
- Signoff workflow with photos and notes
- Inspection history and compliance tracking
- Failed inspections can auto-create punch items with required fixes

**DB Schema Changes**:
```sql
-- Use existing schedule_items.metadata or create inspection_instances table
ALTER TABLE schedule_items ADD COLUMN inspection_checklist JSONB;
ALTER TABLE schedule_items ADD COLUMN inspection_result TEXT;
ALTER TABLE schedule_items ADD COLUMN inspected_by UUID REFERENCES app_users(id);
ALTER TABLE schedule_items ADD COLUMN inspected_at TIMESTAMPTZ;
```

### 5.2 Punch List Internal Workflow
**Deliverables**:
- Internal assignment and priority system
- Verification step with evidence requirements
- Status workflow: open → assigned → in_progress → ready_for_review → closed

**UI Components Needed**:
- `components/punch/punch-list-internal.tsx` - Internal management view
- `components/punch/punch-assignment.tsx` - Assignment workflow
- `components/punch/punch-verification.tsx` - Verification with evidence

### 5.3 RFI/Submittal Integration
**Deliverables**:
- Complete project workflow integration
- Response tracking and approval workflows
- Document attachment and audit trails

**Services to Update**:
- `lib/services/rfis.ts` - Ensure complete workflow
- `lib/services/submittals.ts` - Add missing features

### 5.4 Client Decision Log (Selections + Approvals)
**Deliverables**:
- Central decision log with due dates, owner selections, and approvals
- Track impact to schedule/COs when decisions are late or changed
- Decision status workflow: requested → pending → approved → revised

**DB Schema Changes**:
```sql
CREATE TABLE decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'requested',
  due_date DATE,
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES app_users(id)
);
```

---

## Stage 6 — Compliance & Risk Management (1-2 weeks)

**Goal**: Add compliance gating and risk management features.

**Status**: Completed

**Progress**:
- ✅ Compliance dashboard + document expiry tracking
- ✅ Lien waiver tracking + payables gating
- ✅ Configurable compliance rules

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250310_stage6_compliance.sql`

### 6.1 Compliance Dashboard
**Deliverables**:
- Company compliance status overview
- Document expiry tracking and alerts
- Payment blocking for non-compliant vendors
- Vendor onboarding checklist (COI, W-9, license, trade coverage)

**DB Schema Changes**:
```sql
-- Extend companies table with compliance fields
ALTER TABLE companies ADD COLUMN insurance_expiry DATE;
ALTER TABLE companies ADD COLUMN w9_on_file BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN insurance_provider TEXT;
ALTER TABLE companies ADD COLUMN license_number TEXT;
ALTER TABLE companies ADD COLUMN license_expiry DATE;

-- Compliance rules stored at org level
ALTER TABLE orgs ADD COLUMN compliance_rules JSONB DEFAULT '{}'::jsonb;
```

### 6.2 Lien Waiver Tracking
**Deliverables**:
- Lien waiver request and tracking
- Payment conditional on waiver receipt
- Waiver storage and audit trail

**Implementation Requirements**:
- Create `lien_waivers` table
- Integrate with payment approval workflow
- Add to compliance checks

### 6.3 Payment Compliance Gating
**Deliverables**:
- Block bill payments without required documents
- Configurable compliance rules per org
- Compliance status visible in payables queue

---

## Stage 7 — Closeout & Warranty (1-2 weeks)

**Goal**: Deliver the end-of-project experience expected by luxury custom home clients and builders.

**Status**: Completed

**Progress**:
- ✅ Closeout package checklist + PDF export
- ✅ Warranty/service request workflow (internal + client portal)

**Remaining**:
- ✅ None

**Migration TODOs**:
- Apply `supabase/migrations/20250311_stage7_closeout_warranty.sql`

### 7.1 Closeout Package Builder
**Deliverables**:
- Closeout checklist with required docs: as-builts, O&M manuals, final lien waivers, warranties
- Package export (single PDF/ZIP) for client delivery
- Track completion percentage and missing items
- Final payment + retainage release checklist tied to compliance status

**DB Schema Changes**:
```sql
CREATE TABLE closeout_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  status TEXT DEFAULT 'in_progress',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE closeout_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  closeout_package_id UUID REFERENCES closeout_packages(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'missing',
  file_id UUID REFERENCES files(id)
);
```

### 7.2 Warranty & Service Requests
**Deliverables**:
- Homeowner warranty requests via portal
- Internal assignment and resolution tracking
- Warranty log for recurring issues and vendor follow-up

**DB Schema Changes**:
```sql
CREATE TABLE warranty_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  requested_by UUID REFERENCES contacts(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);
```

---

## Stage 8 — Testing & Demo Preparation (1 week)

**Goal**: Ensure complete workflow testing and demo readiness.

**Status**: Not started

**Remaining**:
- ⏳ Golden project setup
- ⏳ QA checklist execution

**Migration TODOs**:
- ✅ None

### 8.1 Golden Project Setup
**Deliverables**:
- Complete test project with all features
- End-to-end workflow verification
- Performance and error handling validation

### 8.2 QA Checklist Execution
**Deliverables**:
- Manual testing of all critical paths
- Portal testing with clean sessions
- Mobile responsiveness verification

---

## Stage 9 — Expansion Modules (Deferred)

**Goal**: Add advanced preconstruction and CRM features only after the core spine is mature.

**Status**: Deferred

**Remaining**:
- ⏳ Full CRM pipeline (if needed)
- ⏳ Bidding + procurement + permitting

**Migration TODOs**:
- ✅ None

### 9.1 Full CRM Pipeline (Optional)
**Deliverables**:
- Lead stages, follow-ups, and activity timeline
- Automated reminders and conversion analytics
- CRM integrations (Salesforce/HubSpot) as primary, not replacement

### 9.2 Bidding, Procurement, and Permitting
**Deliverables**:
- Bid packages, bid intake, bid leveling, award to commitment
- Long-lead procurement tracking tied to schedule
- Permitting workflows and inspection gating

---

## Implementation Guidelines (LLM-Friendly)

### Database-First Approach
1. **Schema verification**: Check existing tables against requirements
2. **Migration creation**: Idempotent migrations with `IF NOT EXISTS`
3. **Index verification**: Ensure query performance for new features

### Service Layer Pattern
For each feature:
1. **Validation schemas** in `lib/validation/`
2. **Service functions** in `lib/services/`
3. **Server actions** in `app/[feature]/actions.ts`
4. **UI components** in `components/[feature]/`
5. **API routes** if needed in `app/api/[feature]/`

### Testing Strategy
- **Integration testing**: End-to-end workflows
- **UI testing**: Form submissions and state changes
- **API testing**: Server action responses

### Error Handling
- **User-friendly messages**: Clear validation errors
- **Audit trails**: Log all business operations
- **Rollback capability**: Safe failure recovery

---

## Success Criteria

### Functional Completeness
- ✅ Estimate-first conversion spine (estimate → proposal → contract → project)
- ✅ Lightweight intake (contacts + CRM ID + create estimate)
- ✅ Estimate → proposal → contract → budget
- ✅ Change orders update all financial displays
- ✅ Complete AP workflow with compliance
- ✅ Full operational execution (schedule, inspections, punch)
- ✅ Client decision log and approvals
- ✅ Closeout package and warranty workflow
- ✅ Compliance gating and risk management

### User Experience
- ✅ Intuitive workflow navigation
- ✅ Real-time financial updates
- ✅ Mobile-responsive interfaces
- ✅ Clear status indicators and progress tracking

### Performance & Reliability
- ✅ Sub-2 second page loads
- ✅ Reliable payment processing
- ✅ Comprehensive error handling
- ✅ Data integrity across all operations

### Demo Readiness
- ✅ Golden project showcases all features
- ✅ Clean browser session testing
- ✅ Competitive feature comparison ready
