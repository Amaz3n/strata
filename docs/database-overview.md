# Strata Database Overview

## Overview

Strata is a comprehensive construction management platform built on Supabase (PostgreSQL). This document provides a complete overview of the database structure, permissions, storage, and all related components.

**Project URL:** https://gzlfiskfkvqgpzqldnwk.supabase.co

## Database Architecture

### Core Principles

- **Multi-tenant architecture** with organization-level isolation
- **Row Level Security (RLS)** enabled on all tables
- **Audit logging** for compliance and tracking
- **Event-driven architecture** with background job processing
- **File management** with version control and access tracking

### Key Design Patterns

- **Org-scoped data**: All business data belongs to an organization
- **Project-scoped entities**: Most operational data belongs to specific projects
- **Flexible metadata**: JSONB fields for extensibility
- **Soft deletes**: Archive functionality instead of hard deletes where appropriate
- **Optimistic locking**: Version fields and timestamps for conflict resolution

## Schema Structure

### Core Tables

#### Organizations & Users
- **`orgs`** - Organization entities (billing, settings)
- **`org_settings`** - Organization-specific configuration
- **`app_users`** - User accounts linked to Supabase Auth
- **`memberships`** - User-organization relationships with roles

#### Permissions & Access Control
- **`roles`** - Role definitions (org-level and project-level)
- **`permissions`** - Granular permission definitions
- **`role_permissions`** - Many-to-many role-permission mappings
- **`portal_access_tokens`** - Temporary access tokens for client portals

#### Projects & Operations
- **`projects`** - Construction projects
- **`project_members`** - Project-specific team assignments
- **`project_settings`** - Project-specific configuration
- **`tasks`** - Project tasks and assignments
- **`task_assignments`** - Task-user/contact assignments

#### Pipeline & Preconstruction
- **`opportunities`** - Pipeline opportunities (job-centric, pre-estimate)
- **`bid_packages`** - Invite-to-bid packages per project
- **`bid_invites`** - Invited subcontractors/companies per package
- **`bid_access_tokens`** - Public portal access tokens for bid invites
- **`bid_submissions`** - Subcontractor bid submissions (versioned)
- **`bid_awards`** - Award decisions linked to submissions/commitments
- **`bid_addenda`** - Addenda issued per bid package
- **`bid_addendum_acknowledgements`** - Invite acknowledgements of addenda

#### Financial Management
- **`cost_codes`** - CSI MasterFormat cost codes
- **`estimates`** - Project estimates and quotes
- **`estimate_items`** - Line items within estimates
- **`proposals`** - Client proposals with signatures
- **`proposal_lines`** - Proposal line items with allowances/options
- **`contracts`** - Signed contracts with retainage tracking
- **`change_orders`** - Contract modifications
- **`budgets`** - Project budgets with variance tracking
- **`budget_lines`** - Budget line items
- **`budget_snapshots`** - Budget trend analysis
- **`commitments`** - Vendor/subcontractor commitments
- **`commitment_lines`** - Commitment line items
- **`vendor_bills`** - Bills from vendors/subcontractors
- **`bill_lines`** - Vendor bill line items
- **`invoices`** - Client invoices
- **`invoice_lines`** - Invoice line items
- **`payments`** - Payment records (in/out)
- **`payment_intents`** - Stripe payment intents
- **`payment_methods`** - Stored payment methods
- **`payment_schedules`** - Recurring payment plans

#### Project Operations
- **`schedule_items`** - Project schedule items
- **`schedule_dependencies`** - Task dependencies
- **`schedule_assignments`** - Resource assignments to schedule items
- **`schedule_baselines`** - Schedule baselines for comparison
- **`schedule_templates`** - Reusable schedule templates
- **`daily_logs`** - Daily construction logs
- **`daily_log_entries`** - Individual log entries
- **`punch_items`** - Quality control items
- **`photos`** - Project photos with metadata

#### Document Management
- **`files`** - File storage with versioning
- **`doc_versions`** - File version history
- **`file_links`** - File attachments to entities
- **`file_access_events`** - Audit log of file downloads/views

#### Drawings & Plans
- **`drawing_sets`** - Uploaded drawing packages
- **`drawing_revisions`** - Drawing revision tracking
- **`drawing_sheets`** - Individual drawing sheets
- **`drawing_sheet_versions`** - Sheet version history
- **`drawing_markups`** - Vector annotations on drawings
- **`drawing_pins`** - Entity location markers on drawings

#### Communication
- **`conversations`** - Message threads
- **`messages`** - Individual messages
- **`mentions`** - @ mentions in messages
- **`notifications`** - User notifications
- **`notification_deliveries`** - Notification delivery tracking

#### RFIs & Submittals
- **`rfis`** - Requests for Information
- **`rfi_responses`** - RFI responses and answers
- **`submittals`** - Submittal packages
- **`submittal_items`** - Individual submittal items

#### Client Interactions
- **`companies`** - Client/vendor companies
- **`contacts`** - Individual contacts
- **`contact_company_links`** - Contact-company relationships
- **`project_vendors`** - Project-specific vendor relationships

#### Selection Management
- **`selection_categories`** - Selection categories (fixtures, finishes, etc.)
- **`selection_options`** - Available selection choices
- **`project_selections`** - Client selections for projects

#### Billing & Subscriptions
- **`plans`** - Subscription plans
- **`plan_features`** - Plan feature definitions
- **`plan_feature_limits`** - Feature limits per plan
- **`subscriptions`** - Organization subscriptions
- **`entitlements`** - Feature entitlements
- **`licenses`** - License-based customers
- **`support_contracts`** - Support agreements

#### Compliance & Legal
- **`approvals`** - Approval workflows
- **`lien_waivers`** - Lien waiver documents
- **`retainage`** - Retainage tracking
- **`allowances`** - Allowance budgets

#### Automation & Customization
- **`workflows`** - Automated business processes
- **`workflow_runs`** - Workflow execution history
- **`form_templates`** - Custom form definitions
- **`form_instances`** - Form instances
- **`form_responses`** - Form submission data
- **`custom_fields`** - Custom field definitions
- **`custom_field_values`** - Custom field values

#### Monitoring & Analytics
- **`audit_log`** - Comprehensive audit trail
- **`events`** - Event logging for analytics
- **`outbox`** - Background job queue
- **`variance_alerts`** - Budget variance alerts
- **`reminders`** - Automated reminders
- **`reminder_deliveries`** - Reminder delivery tracking
- **`invoice_views`** - Invoice view tracking
- **`late_fee_applications`** - Late fee tracking
- **`late_fees`** - Late fee rules
- **`receipts`** - Payment receipts
- **`change_requests`** - Feature requests/support tickets

#### QuickBooks Integration
- **`qbo_connections`** - QuickBooks Online connections
- **`qbo_sync_records`** - Sync status tracking
- **`qbo_invoice_reservations`** - Invoice number reservations

## Permissions & Security

### Row Level Security (RLS)

All tables have RLS enabled with policies that ensure:

1. **Organization Isolation**: Users can only access data from organizations they belong to
2. **Project Membership**: Project data requires project membership
3. **Role-Based Access**: Actions are gated by user roles and permissions
4. **Portal Access**: Client portals have restricted access via tokens

### Permission System

#### Organization-Level Permissions
- `org.admin` - Full organization administration
- `org.member` - Standard organization access
- `org.read` - Read-only organization access
- `project.manage` - Create and manage projects
- `project.read` - Read projects
- `billing.manage` - Manage billing and subscriptions
- `audit.read` - Read audit logs
- `features.manage` - Manage feature flags
- `members.manage` - Manage organization memberships

#### Roles
- **Owner**: Full organization permissions
- **Admin**: Most permissions except some admin functions
- **Staff**: Standard operational access
- **Read-only**: View-only access
- **Project Manager**: Project-level management
- **Field**: Field user access
- **Client**: Portal access for clients

### Security Features

- **JWT Authentication** via Supabase Auth
- **API Key Management** for integrations
- **Token Expiration** for portal access
- **IP Address Logging** for audit trails
- **File Access Auditing** for compliance
- **Signature Capture** for legal documents

## Storage

### Supabase Storage Buckets

#### Project Files Bucket
- **Name**: `project-files`
- **Public Access**: No
- **File Size Limit**: 100MB
- **Allowed MIME Types**:
  - Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
  - Documents: `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - Spreadsheets: `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - Text: `text/plain`, `text/csv`

### File Management Features

- **Version Control**: Full file versioning with history
- **Access Tracking**: Download/view audit logs
- **Sharing Controls**: Public/private with granular permissions
- **Metadata**: Rich metadata including categories, tags, descriptions
- **Folder Organization**: Virtual folder structure
- **Portal Sharing**: Client/vendor file access via portals

## Database Extensions

### Core Extensions
- **`pgcrypto`** - Cryptographic functions
- **`citext`** - Case-insensitive text
- **`pg_trgm`** - Text similarity and trigram indexing
- **`uuid-ossp`** - UUID generation

### Analytics & Search
- **`pg_stat_statements`** - Query performance monitoring
- **`pg_graphql`** - GraphQL API support

### Development Tools
- **`pgtap`** - Unit testing
- **`plpgsql_check`** - PL/pgSQL validation

### Advanced Features
- **`postgis`** - Geographic/spatial data
- **`vector`** - AI/vector embeddings
- **`pgmq`** - Message queuing
- **`pg_cron`** - Scheduled jobs

## Functions & Triggers

### Authentication Helpers
- **`is_org_member(org_id)`** - Check organization membership
- **`is_project_member(project_id)`** - Check project membership

### Business Logic Functions
- **`get_next_version_number(file_id)`** - File versioning
- **`next_rfi_number(project_id)`** - RFI numbering
- **`next_submittal_number(project_id)`** - Submittal numbering
- **`increment_portal_access(token_id)`** - Portal access tracking
- **`photo_timeline_for_portal(org_id, project_id)`** - Photo timeline aggregation

### Triggers
- **`tg_set_updated_at`** - Automatic timestamp updates
- **`budget_lock_guard`** - Prevent budget modifications when locked
- **`budget_line_lock_guard`** - Prevent budget line modifications when locked

## Migration History

### Recent Migrations (2025)
- **20251213192511**: Add client_id to projects
- **20251213192505**: Create project_vendors table
- **20251211024157**: QuickBooks integration
- **20251208035340**: Make invoice project nullable
- **20251208033715**: Add sent fields to invoices
- **20251208033438**: Add address to orgs
- **20251208004852**: Contract and proposal enhancements
- **20251208003639**: Budget lock guards
- **20251208001951**: Budget variance tracking
- **20251207225134**: Payment foundation (v3)
- **20251207221755**: Invoice views table
- **20251207221753**: Invoice viewed_at tracking
- **20251207221604**: Invoice sent tracking
- **20251207164940**: Invoice token addition
- **20251205042526**: Portal RFI/Submittal permissions
- **20251205034703**: Invoice tables creation
- **20251205020835**: Approval enhancements
- **20251205020829**: RFI/Submittal management
- **20251205020819**: Selection sheets
- **20251205020805**: Portal access tokens
- **20251205021016**: Portal access functions
- **20251201021225**: Project files bucket creation
- **20251201004756**: Schedule schema enhancements
- **20251130212605**: Project field additions
- **20251130172247**: RLS policies and seeding
- **20251130172153**: Custom communication features
- **20251130172046**: CRM and operations
- **20251130172013**: Core foundation schema

## Edge Functions

### Process Drawing Set
- **Function**: `process-drawing-set`
- **Purpose**: Processes uploaded drawing PDFs, extracts individual sheets, generates thumbnails, and performs OCR
- **Trigger**: File upload to drawing_sets
- **JWT Verification**: Enabled

## API & Integrations

### GraphQL API
- **Extension**: `pg_graphql`
- **Schema**: Automatic GraphQL schema generation from PostgreSQL schema
- **Authentication**: JWT-based via Supabase Auth

### QuickBooks Online Integration
- **Tables**: `qbo_connections`, `qbo_sync_records`, `qbo_invoice_reservations`
- **Features**:
  - Bidirectional sync of invoices and payments
  - Customer synchronization
  - Invoice number reservation system
  - Error handling and retry logic

### Webhook System
- **Events Table**: Comprehensive event logging
- **Outbox Pattern**: Reliable background job processing
- **Channels**: Activity, Integration, Notification

## Data Flow & Architecture

### Event-Driven Processing
1. **User Actions** → Database mutations
2. **Triggers** → Event logging
3. **Outbox** → Background processing
4. **Edge Functions** → File processing, notifications
5. **External APIs** → QuickBooks sync, payment processing

### Portal Architecture
- **Token-Based Access**: Secure portal access for clients/vendors
- **Permission Granularity**: Fine-grained control over portal features
- **Audit Logging**: All portal actions tracked
- **File Access Control**: Secure document sharing

### Financial Data Flow
```
Estimates → Proposals → Contracts → Change Orders
    ↓         ↓         ↓         ↓
Invoices ← Payments ← Commitments ← Vendor Bills
```

### Project Lifecycle
```
Planning → Bidding → Active → On Hold → Completed
    ↓        ↓        ↓       ↓         ↓
RFIs     Submittals  Dailies  Photos    Closeout
```

## Performance Considerations

### Indexing Strategy
- **Foreign Keys**: All foreign keys automatically indexed
- **Composite Indexes**: Multi-column indexes for common query patterns
- **Partial Indexes**: Conditional indexes for active records
- **GIN Indexes**: JSONB and text search indexes

### Query Optimization
- **RLS Policies**: Efficient policy implementation
- **Connection Pooling**: Supabase-managed connection pooling
- **Caching**: Application-level caching for frequently accessed data
- **Pagination**: Cursor-based pagination for large datasets

### Monitoring
- **Query Statistics**: `pg_stat_statements` for performance monitoring
- **Audit Logging**: Comprehensive activity tracking
- **Error Handling**: Robust error logging and retry mechanisms

## Backup & Recovery

### Supabase Features
- **Automatic Backups**: Point-in-time recovery
- **Database Forks**: Development environment isolation
- **Branching**: Feature branch database isolation
- **Export Capabilities**: Data portability

### Data Retention
- **Audit Logs**: Long-term retention for compliance
- **File Versions**: Complete version history
- **Soft Deletes**: Archive functionality for recovery

## Compliance & Security

### Data Protection
- **Encryption**: Data encrypted at rest and in transit
- **PII Handling**: Secure handling of personal information
- **Access Logging**: Comprehensive audit trails

### Industry Compliance
- **Construction Standards**: CSI MasterFormat, project management best practices
- **Financial Compliance**: Proper financial record keeping
- **Document Management**: Version control and access tracking

### Security Measures
- **Input Validation**: Comprehensive input sanitization
- **SQL Injection Prevention**: Parameterized queries
- **XSS Protection**: Content security policies
- **CSRF Protection**: Token-based request validation

---

This document provides a comprehensive overview of the Strata database architecture. For specific implementation details, refer to the individual table schemas and migration files.


