# Project-Scoped Navigation Gameplan (LLM-Optimized)

Goal: Make the app feel simpler than Procore by defaulting to a **project workspace** and keeping **global views minimal**. Users pick a project, then every module and action is scoped to that project. Global navigation remains only for Projects and Directory.

---

## 0) Scope Decisions (Lock This In)

### 0.1 Global Views (Keep)
- **Projects**: global overview + primary entry point into a project.
- **Directory**: org-wide contacts/companies and relationship management.

### 0.2 Global Views (Do NOT Keep for Now)
- Documents, Drawings, RFIs, Submittals, Schedule, Financials, Tasks, Daily Logs, etc.
- These become **project-only** to avoid duplication and reduce confusion.

### 0.3 Rationale (Construction PM POV)
- PMs live inside a single job at a time.
- Global views add mental overhead without daily benefit.
- The admin/office use case is real, but it can be reintroduced later without harming the core PM workflow.

---

## 1) Target UX Model

### 1.1 Default Flow
1) User logs in → sees **Projects**.
2) User clicks a project → enters **project workspace**.
3) Sidebar switches to project-scoped modules.
4) Breadcrumb shows project context and allows switching.

### 1.2 Persistent Project Context
- Project context is derived from URL (`/projects/:projectId/...`).
- Breadcrumb project dropdown uses navigation to change project.
- Optional "Last Project" shortcut on Projects page (future).

---

## 2) Navigation Structure (Final)

### 2.1 Global Navigation (Outside a Project)
- Projects
  - Project cards/rows, search, filters, status.
  - CTA: “Open project” → enters project workspace.
- Directory (org-wide)
  - Companies, contacts, roles, trades.
  - Used by office/admin + PMs to manage vendor relationships.

### 2.2 Project Navigation (Inside a Project)
- Overview
- Drawings
- RFIs
- Submittals
- Files / Documents
- Tasks
- Daily Logs
- Financials
- Directory (project-specific assignments)

---

## 3) Breadcrumb + Project Switcher

### 3.1 Placement
- Breadcrumb always visible at top of app shell.
- Format: `Org / Project / Section`.
- Clicking **Project** opens a dropdown to switch projects.

### 3.2 Behavior
- When inside `/projects/:projectId/...`, the breadcrumb shows that project.
- Switching projects navigates to the same section for the new project when possible.
  - Example: `Project A / Drawings` → switch to `Project B / Drawings`.
- If the target project does not have access/feature for that section, fall back to `Project / Overview`.

### 3.3 Dropdown Contents
- Search by project name.
- Group by **Active** and **Archived/Closed**.
- Show status badges: `Active`, `On Hold`, `Closed`.
- Display key metadata: last updated, address, or client name (optional).
- Provide a “Back to Projects” link at bottom.

---

## 4) Handling No Project Selected (Empty State)

### 4.1 Trigger Scenarios
- User navigates to a project-scoped URL without `projectId`.
- User logs in and no last-project is set.
- User switches org, and no project is selected for that org.

### 4.2 UX Requirements
- Show a dedicated empty state component (e.g., shadcn empty).
- Clear CTA: “Select a project” + button to open project list.
- Secondary CTA: “Create new project” (if permissions allow).
- Explain what happens next in 1–2 lines.

### 4.3 Copy Suggestions
- Title: “Choose a project to get started”
- Body: “Everything in Strata is scoped to a project. Select one to continue.”
- Actions:
  - Primary: “View projects”
  - Secondary: “Create project”

---

## 5) Route + State Rules

### 5.1 Source of Truth
- Project context is **URL-based** only.
- No hidden global project state should override the URL.

### 5.2 Project Switch Logic
- Switching projects changes the URL.
- The UI re-fetches all project-scoped data.
- Local state resets for project modules (filters, tabs, selections).

### 5.3 Optional Convenience
- Store `last_project_id` in local storage or cookie.
- On login, if user has access, prompt “Continue in last project?”
- If user lacks access, ignore and show Projects list.

---

## 6) Sidebar Behavior Rules

### 6.1 Inside Project
- Show only project modules.
- No links to global docs/financials/schedule.
- Keep “Projects” and “Directory” accessible in header or via a minimal “Global” menu.

### 6.2 Outside Project
- Show only global items (Projects, Directory).
- Project modules are hidden to reduce confusion.

---

## 7) Permission / Access Model

### 7.1 Org Switcher
- Org switcher remains independent and always visible.
- Changing org resets project selection.

### 7.2 Project Access
- Project dropdown only lists projects the user can access.
- If access is revoked, redirect to Projects page.

---

## 8) Page-Level Acceptance Criteria

### 8.1 Projects Page
- Shows all accessible projects with quick stats.
- Clicking a project enters project workspace.
- Breadcrumb updates to show that project.

### 8.2 Project Pages
- Sidebar updates to project-scoped items.
- Breadcrumb project switcher works from any module.
- No global module duplication.

### 8.3 Empty State
- Attempting to enter project modules without a project shows the empty state.
- CTA reliably routes to Projects page.

---

## 9) Migration Strategy (Safe Transition)

### Phase 1 — Context Clarity
- Add breadcrumb project switcher.
- Add empty state for no-project context.
- Keep Projects page as primary entry.

### Phase 2 — Sidebar Simplification
- Make sidebar context-dependent (global vs project).
- Remove global links to project modules.

### Phase 3 — UX Cleanup
- Ensure all project modules derive projectId from URL.
- Remove legacy “global” stubs for modules (if any exist).

---

## 10) Risks + Mitigations

- Risk: Users miss cross-project visibility.
  - Mitigation: keep Projects overview and consider minimal reporting later.
- Risk: Switching projects feels slow.
  - Mitigation: add recent projects list + remember last project.
- Risk: Users deep-link to invalid project.
  - Mitigation: redirect to Projects with “Access needed” message.

---

## 11) Definition of Done

- Project context is always explicit in breadcrumb.
- Sidebar changes based on whether a project is selected.
- Only global views are Projects and Directory.
- No duplicate “global vs project” module confusion.
- Empty state handles missing project context gracefully.
