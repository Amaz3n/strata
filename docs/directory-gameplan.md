Directory Management Implementation Plan

  The Big Picture

  For a construction management app competing with Procore/Buildertrend, your directory needs to
  handle three distinct but related concepts:

  | Entity    | What It Is                         | Examples
           |
  |-----------|------------------------------------|------------------------------------------------
  ---------|
  | Team      | Internal employees with app logins | Your project managers, superintendents, office
  staff    |
  | Contacts  | Individual people you work with    | Client homeowner, plumber foreman, architect,
  inspector |
  | Companies | Businesses you contract with       | ABC Plumbing LLC, Smith Architecture, Home
  Depot        |

  The schema already models this correctly with memberships (team), contacts, and companies + the
  junction table contact_company_links.

  ---
  Phase 1: Core Types & Validation

  Create these files:

  lib/types.ts          → Add Contact, Company, ContactCompanyLink types
  lib/validation/contacts.ts
  lib/validation/companies.ts
  lib/validation/team.ts

  Types to add:

  // Companies
  export type CompanyType = "subcontractor" | "supplier" | "client" | "architect" | "engineer" |
  "other"

  export interface Company {
    id: string
    org_id: string
    name: string
    company_type: CompanyType
    trade?: string  // e.g., "Electrical", "Plumbing", "HVAC"
    phone?: string
    email?: string
    website?: string
    address?: Address
    license_number?: string
    insurance_expiry?: string
    notes?: string
    created_at: string
  }

  // Contacts
  export type ContactType = "internal" | "subcontractor" | "client" | "vendor" | "consultant"

  export interface Contact {
    id: string
    org_id: string
    full_name: string
    email?: string
    phone?: string
    role?: string  // e.g., "Foreman", "Owner", "Project Manager"
    contact_type: ContactType
    primary_company_id?: string
    primary_company?: Company  // joined
    has_portal_access?: boolean
    created_at: string
  }

  // Team Members (wrapped membership with user data)
  export interface TeamMember {
    id: string  // membership id
    user: User
    role: OrgRole
    status: "active" | "invited" | "suspended"
    project_count?: number
    last_active_at?: string
    invited_by?: User
    created_at: string
  }

  ---
  Phase 2: Services Layer

  Create:
  lib/services/companies.ts
  lib/services/contacts.ts
  lib/services/team.ts

  Each service follows your established pattern with these operations:

  Companies Service:
  - listCompanies(orgId, filters?) - with type/trade filtering
  - getCompany(companyId) - with contacts included
  - createCompany({ input, orgId })
  - updateCompany({ companyId, input })
  - archiveCompany(companyId) - soft delete, check for active assignments first
  - getCompanyContacts(companyId) - all contacts linked to company
  - getCompanyProjects(companyId) - projects where this company is assigned

  Contacts Service:
  - listContacts(orgId, filters?) - filter by type, company
  - getContact(contactId) - with companies and assignments
  - createContact({ input, orgId })
  - updateContact({ contactId, input })
  - archiveContact(contactId)
  - linkContactToCompany({ contactId, companyId, relationship })
  - unlinkContactFromCompany({ contactId, companyId })
  - getContactAssignments(contactId) - tasks/schedules assigned to them

  Team Service:
  - listTeamMembers(orgId) - with project counts
  - inviteTeamMember({ email, role, orgId }) - sends invite email
  - updateMemberRole({ membershipId, role })
  - suspendMember(membershipId)
  - reactivateMember(membershipId)
  - removeMember(membershipId) - only if no critical assignments
  - resendInvite(membershipId)

  ---
  Phase 3: UI Components

  File structure:
  components/
  ├── team/
  │   ├── team-table.tsx
  │   ├── invite-member-dialog.tsx
  │   └── member-role-badge.tsx
  ├── contacts/
  │   ├── contacts-table.tsx
  │   ├── contact-form.tsx
  │   ├── contact-card.tsx
  │   └── contact-companies-list.tsx
  ├── companies/
  │   ├── companies-table.tsx
  │   ├── company-form.tsx
  │   ├── company-card.tsx
  │   ├── company-contacts-list.tsx
  │   └── trade-badge.tsx
  └── directory/
      └── directory-search.tsx  # unified search across all three

  ---
  Phase 4: Page Implementation

  Team Page (app/team/page.tsx):
  - Table with: Name, Email, Role, Status, Last Active, Projects
  - Invite member button → dialog with email + role selector
  - Row actions: Change role, Suspend, Remove
  - Filter by: Role, Status
  - Show pending invites separately

  Contacts Page (app/contacts/page.tsx):
  - Table with: Name, Company, Role, Type, Phone, Email, Portal Access
  - Quick create + full form dialog
  - Row actions: Edit, View assignments, Grant portal access, Archive
  - Filter by: Type (client/sub/vendor), Company
  - Bulk actions: Add to company, Export

  Companies Page (app/companies/page.tsx):
  - Card grid OR table view toggle
  - Card shows: Name, Type, Trade badge, Contact count, Phone
  - Row actions: View details, Add contact, Archive
  - Filter by: Type (subcontractor/supplier/client), Trade
  - Detail sheet: Shows all contacts, project history, documents

  ---
  Phase 5: Construction-Specific Features

  These differentiate you from generic CRM:

  1. Trade Categories (for subcontractors)
  const TRADES = [
    "General", "Electrical", "Plumbing", "HVAC", "Roofing",
    "Framing", "Drywall", "Painting", "Flooring", "Concrete",
    "Masonry", "Landscaping", "Pool", "Fencing", "Windows/Doors",
    "Cabinets", "Countertops", "Tile", "Insulation", "Stucco"
  ] as const

  2. Insurance/License Tracking
  - Add to company form: License #, Insurance expiry date
  - Dashboard widget showing expiring insurance (30/60/90 days)
  - Prevent scheduling companies with expired insurance (optional warning)

  3. Project Relationship View
  - On company detail: Show all projects they've worked on
  - On contact detail: Show task/schedule assignments across projects
  - Quick link to add them to current project

  4. Crew Assignment Integration
  - When scheduling, allow selecting a company → then pick contacts from that company
  - "Assign ABC Plumbing" → "Select crew members: John (Foreman), Mike, Dave"

  5. Portal Access (leverage existing portal_access_tokens)
  - One-click "Send portal invite" from contact row
  - Contact can then view project updates, schedules, photos
  - Track when they last accessed

  ---
  Database Additions (Optional Enhancements)

  Your schema is solid, but consider adding:

  -- Trade categories enum or table
  ALTER TABLE companies ADD COLUMN trade text;  -- Already have this via metadata, but make explicit

  -- Insurance tracking
  ALTER TABLE companies ADD COLUMN license_number text;
  ALTER TABLE companies ADD COLUMN insurance_expiry timestamptz;
  ALTER TABLE companies ADD COLUMN insurance_document_id uuid REFERENCES files(id);

  -- Contact preferences
  ALTER TABLE contacts ADD COLUMN preferred_contact_method text; -- 'phone', 'email', 'text'
  ALTER TABLE contacts ADD COLUMN notes text;

  -- Performance tracking (future)
  CREATE TABLE company_ratings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id),
    company_id uuid NOT NULL REFERENCES companies(id),
    project_id uuid REFERENCES projects(id),
    rating smallint CHECK (rating BETWEEN 1 AND 5),
    notes text,
    created_by uuid REFERENCES app_users(id),
    created_at timestamptz DEFAULT now()
  );

  ---
  Implementation Order

  I recommend building in this sequence:

  1. Types & Validation (30 min) - Foundation for everything
  2. Companies Service + UI - Simplest entity, no dependencies
  3. Contacts Service + UI - Builds on companies (links)
  4. Team Service + UI - Slightly different (auth integration)
  5. Integration Points - Connect to schedule/task assignment dropdowns
  6. Polish - Unified search, bulk actions, exports

  ---
  Key Integration Points

  Once directory is built, wire it into:

  | Feature       | Integration                                                  |
  |---------------|--------------------------------------------------------------|
  | Schedule      | Assignment dropdown shows Team + Contacts grouped by company |
  | Tasks         | Assignee picker includes contacts with type badge            |
  | Daily Logs    | "On site" field lists from contacts/companies                |
  | Change Orders | "Requested by" links to contact                              |
  | Invoices      | Bill to company, attention to contact                        |
  | RFIs          | Addressed to contact (architect, engineer)                   |

  ---
  UI/UX Recommendations

  1. Unified Directory Search - Global search that spans team/contacts/companies with type
  indicators
  2. Quick Add - Floating action button to add contact while in other contexts (e.g., creating a
  schedule item)
  3. Smart Defaults - When adding contact to company, auto-populate company phone/address
  4. Mobile First - Card layouts on mobile, table on desktop for contacts/companies
  5. Recently Used - Show recently accessed contacts at top of assignment pickers

  ---
  This plan gives you a solid directory system that:
  - Follows your existing patterns exactly
  - Leverages the schema you already have
  - Addresses construction-specific needs (trades, insurance, crews)
  - Integrates cleanly with your other features
  - Scales from small builders to larger operations

  I'd suggest beginning with the types and
  validation schemas, then moving to the Companies feature as it's the simplest and sets up patterns
   for the others.