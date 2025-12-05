# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

## Project Overview

Strata is a construction management SaaS platform built with Next.js, designed for local builders and contractors. It provides project management, scheduling, daily logs, file management, and client portals with a focus on mobile-first usage.

## Architecture

### Tech Stack
- **Frontend**: Next.js 16 (App Router), TypeScript, shadcn/ui components, Tailwind CSS
- **Backend**: Supabase (PostgreSQL + Auth + Storage + Edge Functions)
- **State Management**: Server actions with service layer pattern
- **UI Components**: Radix UI primitives via shadcn/ui
- **Styling**: Tailwind CSS with CSS variables for theming

### Project Structure
- `app/` - Next.js App Router pages and layouts
- `components/` - Reusable UI components organized by domain
- `lib/` - Core business logic and utilities
  - `lib/services/` - Domain service layer (projects, tasks, etc.)
  - `lib/validation/` - Zod schemas for input validation
  - `lib/auth/` - Authentication context and helpers
  - `lib/supabase/` - Database client configuration
  - `lib/types.ts` - Shared TypeScript types

### Service Layer Pattern

All business logic is centralized in service modules under `lib/services/`. Each service:

- Exports functions that accept `{ orgId, userId }` plus validated DTOs
- Enforces tenant isolation with org_id scoping and RLS
- Handles permission checks via `requireOrgContext()`
- Emits events for audit trails and activity feeds
- Maps database rows to clean DTOs for UI consumption

Example service function:
```typescript
export async function createProject({ input, orgId }: { input: ProjectInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  // ... business logic
  await recordEvent({ orgId: resolvedOrgId, eventType: "project_created", ... })
  return mapProject(data)
}
```

### Database Architecture

- **Multi-tenant**: All tenant data scoped by `org_id` with Row Level Security (RLS)
- **Event sourcing**: `events` table captures domain events for activity feeds
- **Audit logging**: `audit_log` table tracks changes to critical entities
- **Outbox pattern**: `outbox` table for reliable async processing

Key entities:
- `orgs` - Tenant organizations
- `projects` - Construction projects
- `tasks` - Work items with status/priority tracking
- `daily_logs` - Field reports with photos
- `files` - Document management with polymorphic links

### Authentication & Authorization

- **Authentication**: Supabase Auth with email/password
- **Multi-tenancy**: Organization-based with membership management
- **Permissions**: Two-layer system (org-level + project-level roles)
- **Demo mode**: `demo-org-123` fallback for unauthenticated development

### UI Patterns

- **App Shell**: Consistent layout with sidebar navigation (`components/layout/`)
- **Server Components**: Default approach with server actions for mutations
- **Form Handling**: react-hook-form + Zod validation
- **Toast Notifications**: Sonner for user feedback
- **Theming**: Dark mode support via next-themes

## Development Notes

### Environment Variables Required
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anon public key
- `SUPABASE_SERVICE_ROLE_KEY` - Service role for server operations
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` - Google Places API (optional)

### Code Conventions
- All services accept orgId parameter and enforce tenant scoping
- Use server actions for UI interactions, route handlers for external APIs
- Components follow shadcn/ui patterns with consistent styling
- Database operations always include RLS-compatible org_id filters
- Event emission after successful mutations for audit trails

### Current Status
Phase 0 complete with:
- ✅ Service layer architecture with tenant isolation
- ✅ Projects, tasks, daily logs, file management
- ✅ Activity feeds and audit logging
- ✅ UI shell with navigation and forms

Phase 1.1 in progress:
- Authentication integration (sign up/in flows)
- Organization membership management
- Notification delivery system
- Removing mock data fallbacks

### Testing
Run all commands from project root. Check existing services in `lib/services/` for patterns when adding new functionality.