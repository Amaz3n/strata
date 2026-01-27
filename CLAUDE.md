# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `pnpm run dev` - Start development server (Turbopack disabled) [Note: Don't use this unless otherwise told to]
- `pnpm lint` - Type-aware 0xlint linting (also reports TypeScript errors)
- Node.js version: 22.22.0 (see `.nvmrc`)
- `pnpm lint --fix` - Apply fixes for autofixable lint issues 
- `pnpm check` - Runs format & lint 

** Do not run:** `pnpm dev` (assume already running), `pnpm build` (CI only)

### Supabase Commands
- `npx supabase db push` - Push migrations to remote database
- `npx supabase db diff -f <name>` - Generate migration from schema changes
- `npx supabase functions serve` - Run Edge Functions locally
- `npx supabase functions deploy <function-name>` - Deploy Edge Function

## Project Overview

Arc is a construction management SaaS platform built with Next.js for local builders and contractors. Features include project management, scheduling, daily logs, file/drawings management, client portals, and financial tracking (invoices, payments, change orders).

## Architecture

### Tech Stack
- **Frontend**: Next.js 16 (App Router), TypeScript, shadcn/ui, Tailwind CSS v4
- **Backend**: Supabase (PostgreSQL + Auth + Storage + Edge Functions)
- **Payments**: Stripe (invoices, subscriptions)
- **Email**: React Email templates (`lib/emails/`)
- **Rich Text**: Tiptap editor
- **PDF**: react-pdf, @react-pdf/renderer

### Route Structure
- `app/(app)/` - Authenticated routes with sidebar shell layout
- `app/(auth)/` - Authentication pages (signin, signup, forgot-password)
- `app/p/[token]/` - Client portal (public, token-based)
- `app/s/[token]/` - Subcontractor portal (public, token-based)
- `app/proposal/[token]/` - Public proposal viewing
- `app/i/[token]/` - Public invoice receipts
- `app/api/` - API routes and webhooks

### Project Structure
- `app/` - Next.js App Router pages, layouts, and server actions
- `components/` - UI components organized by domain
- `lib/services/` - Domain service layer (business logic)
- `lib/validation/` - Zod schemas for input validation
- `lib/auth/` - Authentication context and helpers
- `lib/supabase/` - Database client configuration
- `lib/emails/` - React Email templates
- `lib/types.ts` - Shared TypeScript types
- `supabase/migrations/` - SQL migration files
- `supabase/functions/` - Deno Edge Functions

### Service Layer Pattern

All business logic is in `lib/services/`. Each service:
- Uses `requireOrgContext()` to get authenticated context with tenant isolation
- Uses `requirePermission()` for authorization checks
- Emits events via `recordEvent()` for activity feeds
- Records changes via `recordAudit()` for audit trails
- Maps database rows to clean DTOs

```typescript
export async function createProject({ input, orgId }: { input: ProjectInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })
  // ... business logic
  await recordEvent({ orgId: resolvedOrgId, eventType: "project_created", entityType: "project", entityId: data.id, payload: { name: input.name } })
  return mapProject(data)
}
```

### Database Architecture

- **Multi-tenant**: All data scoped by `org_id` with Row Level Security (RLS)
- **Event sourcing**: `events` table for activity feeds
- **Audit logging**: `audit_log` table for change tracking
- **Outbox pattern**: `outbox` table for reliable async processing (emails, integrations)

### Authentication & Authorization

- Supabase Auth with email/password
- Organization-based multi-tenancy with membership management
- Two-layer permissions: org-level roles + project-level roles
- Public portals use token-based access (no login required)

### UI Patterns

- Server Components by default, Client Components where needed
- Server actions for mutations (files named `actions.ts`)
- react-hook-form + Zod for form validation
- Sonner for toast notifications
- next-themes for dark mode

## Code Conventions

- Services accept optional `orgId` parameter, resolved via `requireOrgContext()`
- Server actions go in `actions.ts` files alongside page components
- Route handlers (`route.ts`) for external APIs and webhooks
- Always scope database queries with `org_id` for RLS compatibility
- Emit events after successful mutations