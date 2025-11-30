# Strata Implementation Guide (Phase 0 → MVP)

This doc outlines how to finish Phase 0 and set up an enterprise-grade path for the SaaS: server actions + service layer, RLS enforcement, event/audit plumbing, and public API surfaces.

## Goals
- Single source of truth for domain rules in services (no logic in UI components).
- All data access scoped by `org_id` with RLS and membership checks.
- Clear split between internal UI flows (server actions) and external/public APIs (route handlers) that share the same services.
- Auditability and observability baked in (events, audit_log, outbox).

## Directory Shape
- `lib/auth/context.ts` — auth + org membership helpers (already added).
- `lib/supabase/server.ts` — supabase clients (server + service role) and demo org id.
- `lib/services/<module>.ts` — domain services per module (projects, tasks, daily logs, files, etc.).
- `app/(routes)/...` — UI pages using server actions that call services.
- `app/api/<domain>/route.ts` — optional HTTP endpoints for portals/integrations; delegate to services.
- `lib/validation/<module>.ts` — zod schemas for inputs/DTOs.
- `lib/types.ts` — shared UI-facing types/DTOs (no raw DB rows).

## Core Patterns
1) **Service layer first**
   - Each service exports CRUD functions that accept `{ orgId, userId }` plus validated input DTOs.
   - Enforce membership/permission checks up front via `requireOrgMembership(orgId)` (or role checks inside).
   - Call Supabase with `supabase.from(...).select/insert/update` using `org_id` filters.
   - Emit events (`recordEvent`) and audit rows (future helper) after successful mutations.

2) **Server actions for internal UI**
   - Server components call server actions that delegate to services.
   - Example shape:
     ```ts
     "use server"
     import { createProject } from "@/lib/services/projects"
     import { projectInputSchema } from "@/lib/validation/projects"
     import { requireOrgMembership } from "@/lib/auth/context"

     export async function createProjectAction(formData: FormData) {
       const { user, orgId } = await requireOrgMembership()
       const input = projectInputSchema.parse({
         name: formData.get("name"),
         start_date: formData.get("start_date"),
       })
       return createProject({ userId: user.id, orgId, input })
     }
     ```
   - Server components then call `const projects = await listProjectsAction()` instead of using mock data.

3) **Route handlers for external/public surfaces**
   - Use when you need a stable HTTP API (client portal, mobile apps, webhooks).
   - Same service calls underneath:
     ```ts
     export async function POST(req: Request) {
       const { user, orgId } = await requireOrgMembership()
       const body = await req.json()
       const input = projectInputSchema.parse(body)
       const project = await createProject({ userId: user.id, orgId, input })
       return NextResponse.json(project)
     }
     ```
   - Add auth (Supabase auth cookies/JWT), rate limiting, and structured logging here.

4) **Validation and DTOs**
   - Define zod schemas per module in `lib/validation`.
   - Map DB rows → DTOs in services so UI never touches raw table shapes.
   - Keep enums aligned with DB enum values (task_status, task_priority, etc.).

5) **RLS and permissions**
   - All tenant tables already have RLS; always pass `org_id` filters.
   - Membership check via `requireOrgMembership(orgId)` before Supabase queries.
   - Add role/permission checks inside services (e.g., only owner/admin can create projects).

6) **Events, audit, outbox**
   - Use `recordEvent` (in `lib/services/events.ts`) after successful writes.
   - Add an `audit` helper to insert into `audit_log` with before/after JSON for critical actions.
   - For async/integrations, insert into `outbox` with payload; process via edge function/cron worker.

7) **Environment/secrets**
   - Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
   - Optional: `NEXT_PUBLIC_DEMO_ORG_ID` (used for unauthenticated previews).

## Replace Mock Data: Step-by-Step
1) **Projects**
   - Create `lib/validation/projects.ts` with zod schemas.
   - Create `lib/services/projects.ts` with `listProjects`, `createProject`, `updateProject`, `archiveProject`.
   - Add server actions in `app/projects/actions.ts`.
   - Refactor `app/projects/page.tsx` and dashboard `ProjectList` to call actions, remove mock usage.

2) **Tasks**
   - `lib/validation/tasks.ts`, `lib/services/tasks.ts` (list by org/project, create, update status/priority/assignee).
   - Server actions in `app/tasks/actions.ts`.
   - Refactor `components/dashboard/tasks-preview.tsx` and tasks pages.

3) **Daily logs + photos**
   - Services for `daily_logs`, `photos` with event emission.
   - Use server actions in `app/daily-logs`.
   - Hook up uploads to Supabase Storage with signed URLs.

4) **Activity feed**
   - Already wired to `getOrgActivity`. Seed events for dev (`seedDemoActivity` or insert sample rows).

5) **Files + links**
   - Service for `files` and `file_links` with signed URL generation; enforce org scope.
   - Server actions for uploads/attachments.

6) **Notifications**
   - Insert notification rows + deliveries; process sending via outbox worker/edge function.

## Testing and Ops
- Add unit-like tests for services (zod validation + role checks) using server actions where possible.
- Log structured errors with `console.error({ orgId, userId, action, error })` (replace with logger later).
- Before go-live, add rate limiting and request logging to route handlers.

## Quick Checklist to Finish Phase 0
- [x] Environment vars set locally and in deployment.
- [x] Services: projects, tasks, daily logs, files.
- [x] Server actions wired into UI pages; mock data removed.
- [x] Events emitted on create/update for the above.
- [x] Activity feed shows real data.
- [x] Basic audit helper in place for critical mutations.
- [x] Outbox writer scaffolded (processing can be Phase 1).

## Phase 0 Complete ✅

**Completed:**
- ✅ Fixed Next.js cookies() async issues
- ✅ Implemented full service layer architecture
- ✅ Created server actions for all CRUD operations
- ✅ Added event emission and audit logging
- ✅ Built comprehensive UI with create/edit/delete functionality
- ✅ RLS policies properly scoped by org_id
- ✅ Demo mode with mock data for development

## Phase 1.1: Authentication Implementation

**Goal:** Enable real user authentication and remove mock data fallbacks

### Required Components:
1. **Auth Pages:**
   - `/auth/signin` - Sign in form
   - `/auth/signup` - Sign up form
   - `/auth/forgot-password` - Password reset

2. **Auth Components:**
   - SignInForm component
   - SignUpForm component
   - AuthGuard wrapper for protected routes

3. **Auth Logic:**
   - Supabase auth integration
   - Session management
   - Protected route middleware

4. **Org Membership Flow:**
   - Organization creation during signup
   - Organization selection/invitation
   - Membership management

5. **Remove Mock Data:**
   - Update all services to remove `demo-org-123` fallbacks
   - Enable real database operations for authenticated users
   - Update UI to handle real auth states

### Implementation Steps:
1. Create auth pages and components
2. Implement Supabase auth integration
3. Add protected route guards
4. Create organization membership flows
5. Remove mock data fallbacks from services
6. Test end-to-end authentication flow
