## Drawings UI/UX Redesign Gameplan (2026-01-11)

### TL;DR (North Star)
- **Drawings should feel like “Photos + Issues”**: instant open, buttery navigation, and builder-first workflows (pin → issue/task/RFI/punch) that are faster than Procore/Buildertrend.
- **Desktop**: 3-pane workspace (filters + sheet list + preview) + full-screen viewer only when you need tools.
- **Mobile**: “one thumb” navigation + bottom sheet controls + offline-ish behavior for last viewed sheets.
- **Performance is not optional**: pre-rendered images/tiles, virtualization, and “open viewer immediately” are the baseline.

This doc is intentionally **LLM-optimized**: explicit decisions, file targets, component boundaries, checklists, and acceptance criteria.

---

### 0) Current State Audit (What’s causing the “messy” feel)

#### 0.1 Where the page actually lives
- Drawings is effectively **project-scoped** today.
- `app/(app)/drawings/page.tsx` currently renders `NoProjectSelected` (placeholder) and can remain a simple “pick a project” screen or a redirect.
- The real “Drawings” experience is `app/(app)/projects/[id]/drawings/page.tsx` which mounts:
  - `components/drawings/drawings-client.tsx` (large “god component”, `use client`)
  - `components/drawings/drawing-viewer.tsx` (full-screen viewer, many tools)

#### 0.2 UX smells (high confidence from code review)
1) **Too much UI in one surface**
   - `DrawingsClient` is trying to be: project picker, set manager, sheets browser, uploader, selection/bulk actions, keyboard nav, plus the viewer orchestrator.
   - Result: the page feels “busy” and inconsistent compared to Proposals/Financials, which use simple composition and predictable layouts.

2) **Viewer is modal-fullscreen by default**
   - This is powerful, but it makes “browse → quick preview → move on” awkward.
   - It also creates context switching: you lose your place in the list and the mental model feels heavier than it needs to be.

3) **Information architecture conflates Sets vs Sheets**
   - Tabs “Sheets / Plan Sets” is okay, but the UI is not “obvious at a glance” for builders.
   - Builders typically want: **open the right sheet fast**, and **see what changed / what’s open (pins/issues)**.

4) **Thumbnails are fragile**
   - Grid thumbnails only render when URL includes a token; otherwise it shows a file icon.
   - This leads to “blank grid” vibes and kills perceived quality even if performance is good.

5) **Heavy client state + effects**
   - Multiple polling loops, debounced searching, post-fetch counts fetch, etc. all in one component.
   - Even if performance is okay, the UX often feels “laggy” due to re-renders + large DOM lists without virtualization.

#### 0.3 What “clean pages” do better (Proposals / Financials patterns)
- **Simple layout**: one header row, then one main content card/table (`ProposalsClient`).
- **Predictable composition**: server fetch in page → small client component for interactions.
- **Tight spacing + scannable tables/cards**: it reads like a professional app.
- **Low cognitive load**: the user always knows where to look.

---

### 1) Design Principles (non-negotiable)

#### 1.1 Builder-first usability
- “Get me to the right sheet in 3 seconds” is the primary job.
- Pins should map directly to construction workflows (issue → assign → close → verify).

#### 1.2 “Comfortable” UI on desktop + mobile
- Desktop: keyboard-first navigation + dense list modes.
- Mobile: thumb-first, with large targets and safe-area spacing; avoid hidden controls behind tiny icons.

#### 1.3 Extreme performance as a design feature
- Users should *feel* speed: thumbnails always show, viewer opens instantly, navigation is preloaded.

#### 1.4 Same app aesthetic
- Use the same UI language as other pages: consistent header spacing, consistent “card/table” patterns, consistent icon+label controls, minimal visual noise.

---

### 2) Proposed Information Architecture (IA)

#### 2.1 Surfaces
1) **Project Drawings Workspace** (`/projects/[id]/drawings`)
   - Primary daily surface.

2) **Drawing Viewer** (full-screen “tool mode”)
   - Only when you need markups, pin placement, compare, etc.

3) **Set Manager** (uploading + processing + revisions)
   - Ideally a focused panel/drawer, not a separate tab that nukes your browsing context.

Note: If you keep `/drawings`, treat it as a **lightweight entry point** (project picker / redirect), not a first-class browsing surface.

#### 2.2 Core mental model for builders
- **Browse**: Find sheet quickly (filters + search + recent + favorites).
- **Preview**: Open in-pane preview (fast, lightweight).
- **Work**: Full viewer with tools + linked items + compare revisions.

---

### 3) New UI: Project Drawings Workspace (Desktop)

#### 3.1 Layout (3-pane)
**Left pane (filters)** — ~260px, collapsible
- Project header (locked on project pages)
- Filters:
  - Discipline (existing `DisciplineTabs`, but in a filter section)
  - Plan set (combobox, searchable)
  - Status filters: “Has open pins”, “Has markups”, “Shared with clients/subs”
  - Sorting: Sheet #, Title, Updated, Most pinned
  - Toggle: Favorites only

**Middle pane (sheet list)** — flexible, virtualized list/grid
- Default: **List** (dense, fast scanning)
- Optional: Grid (for visual browsing)
- Each row/card shows:
  - Thumbnail (always, never “blank icon” if image exists)
  - Sheet # (strong)
  - Title (secondary)
  - Discipline badge
  - Status dots (pins/markups counts)
  - Sharing indicators (Clients/Subs)
  - Last updated / Revision badge (“Rev 4”)

**Right pane (preview)** — ~420px, collapsible
- “Preview” of the selected sheet:
  - Medium image
  - Quick actions:
    - Open full viewer
    - Download PDF
    - Share
  - Tabs:
    - Linked items (pins)
    - Markups
    - Revisions

This avoids full-screen modal for simple browsing.

#### 3.2 Interaction rules
- **Single click** a row: selects + loads preview pane (no modal).
- **Enter / double click**: opens full viewer at that sheet.
- **Up/Down**: navigates selection in list.
- **Cmd/Ctrl+F** focuses “sheet search”.
- **Cmd/Ctrl+K** uses global command search (already in header).

#### 3.3 Contextual bulk actions (cleaner than current)
- When multi-select is active:
  - A sticky contextual action bar appears at bottom of the middle pane (not in the global header).
  - Actions: Share with Clients, Share with Subs, Clear selection.
- Do NOT push the whole header down with a second row.

---

### 4) New UI: Project Drawings Workspace (Mobile)

#### 4.1 Layout
- Top: thin sticky search bar (sheet search).
- Main: list/grid of sheets.
- Bottom: a **filter sheet** (drawer) triggered by a single “Filter” button:
  - Discipline picker
  - Plan set picker
  - Status toggles
  - Sort
- Preview: opens as a **bottom sheet** with image + quick actions; full viewer is a button.

#### 4.2 Mobile affordances (builder-loved)
- “Recent sheets” section pinned at top (already exists conceptually via `useRecentSheets`).
- “Offline-ish”: keep last N sheet thumbnails/medium cached via HTTP caching.
- Large touch targets; avoid tiny icon-only controls except in viewer.

---

### 5) Drawing Viewer Redesign (Desktop + Mobile)

#### 5.1 Viewer goal
Viewer is “tool mode”, not “browsing mode”.

#### 5.2 Header cleanup
Current viewer header + toolbars are functional, but busy.
Redesign:
- Header left: Sheet # + Title + Discipline
- Header right: Compare, Download, Close
- Move zoom/overlay toggles into a compact “controls” row that can collapse on mobile.

#### 5.3 Right sidebar becomes a first-class panel (tabs)
Instead of only showing pins when `pins.length > 0`, always show panel with tabs:
- **Pins** (linked items)
- **Markups**
- **Revisions**
- **Sheet info** (set name, last updated, sharing)

This makes the viewer feel “structured” like the rest of the app.

#### 5.4 Tool rail strategy
- Default tool: Pan
- Keep the left tool rail, but:
  - Group tools into: “Annotate”, “Measure”, “Pin”
  - Put rarely-used tools behind a “More tools” popover.

#### 5.5 “Small features builders like” (high ROI)
1) **Issue/pin quick-create templates**
   - Long press menu already hints at this—make it polished:
   - “New Punch Item”, “New RFI”, “New Task”, “Photo pin”

2) **Photo pin (field workflow)**
   - Attach a jobsite photo to a pin; show photo preview in Pins tab.

3) **Measure tool that speaks construction**
   - Calibration step: “Set scale” using a known dimension on the drawing.
   - Display feet/inches, not pixels.

4) **Revision compare that’s “one click”**
   - Keep `ComparisonViewer`, but make entry point consistent:
   - “Compare with previous revision” primary option.

5) **“Open issues” heatmap / clusters**
   - You already have clustering behavior; add a toggle “Heatmap/Clusters” in viewer controls.

---

### 6) Performance Plan (how we keep it *extremely* fast)

This is aligned with existing docs:
- `docs/drawings-revamp-gameplan.md`
- `docs/drawings-performance-gameplan.md`

#### 6.1 Performance budgets
- **List first meaningful paint**: < 500ms warm / < 1.5s cold
- **Sheet select → preview visible**: < 150ms (thumbnail/medium)
- **Full viewer open → something visible**: < 150ms (thumbnail)
- **Next/prev navigation**: < 100ms (prefetch)

#### 6.2 Data budgets / query principles
- No N+1 calls for counts/status.
- List endpoints return:
  - sheet metadata
  - stable image URLs (or stable gateway URLs)
  - pin/markup counts (at least open counts)

#### 6.3 UI budgets
- Virtualize middle pane list (especially on large projects).
- Avoid huge “map over 1000 sheets” with heavy JSX (current approach will degrade).

#### 6.4 Viewer budgets
- Prefer optimized images; PDF rendering only as a fallback.
- Keep overlay layers cheap:
  - Pins: only render visible pins (cluster outside zoom threshold).
  - Markups: Canvas redraw only when data changes (not on every mouse move except in-progress stroke).

---

### 7) Implementation Gameplan (LLM-executable)

#### 7.1 Phase 0 — Decide contracts + guardrails (P0)
**Goal**: lock the “rules of the road” before touching UI.
- **Rule**: Lists must never generate signed URLs per item.
- **Rule**: DB stores canonical paths/keys, not ephemeral URLs.
- **Rule**: Viewer opens immediately; non-critical fetches load in background.

Deliverables:
- A single “sheet list DTO” type (server-side) that includes:
  - identifiers, set, discipline, sheet_number/title
  - image urls/paths
  - counts: pins_open, markups_count
  - sharing flags

Targets to review/update:
- `lib/services/drawings.ts` (list queries)
- `app/(app)/drawings/actions.ts` (list actions)
- `components/drawings/drawings-client.tsx` (stop doing extra fetches for counts)

Acceptance:
- Opening list does not trigger a second “counts fetch” effect.

#### 7.2 Phase 1 — Split the monolith (P0)
**Goal**: turn `DrawingsClient` into composable components.

Current:
- `components/drawings/drawings-client.tsx` contains everything.

Target structure (suggested):
- `components/drawings/workspace/drawings-workspace.tsx` (client, orchestrates local UI state)
- `components/drawings/workspace/drawings-filters-panel.tsx` (client)
- `components/drawings/workspace/drawings-sheets-list.tsx` (client, virtualized)
- `components/drawings/workspace/drawings-preview-panel.tsx` (client)
- `components/drawings/workspace/drawings-set-manager.tsx` (client or mixed)

Rules:
- “Workspace” component owns:
  - selected sheet id
  - filter state
  - view mode
  - selection state
- “List” component is pure and memoized; only renders rows.

Acceptance:
- No single component > ~300 lines (except viewer).

#### 7.3 Phase 2 — New desktop layout (P0)
**Goal**: implement 3-pane workspace UI.

Implementation notes:
- Use existing shadcn primitives (Card, Tabs, ScrollArea, Resizable panels if present).
- Make panes collapsible (icon button).
- Ensure `AppHeader` remains the global header; do not re-create a second global header inside the page.

Acceptance:
- Browsing does not require opening the full viewer.

#### 7.4 Phase 3 — New mobile browsing UX (P0)
**Goal**: thumb-first browsing with filter drawer + preview bottom sheet.

Acceptance:
- Filter controls are reachable within 1 tap.
- Preview is usable without losing scroll position.

#### 7.5 Phase 4 — Viewer polish (P1)
**Goal**: make viewer feel “professional and calm”.

Tasks:
- Sidebar with tabs (Pins/Markups/Revisions/Info) always present.
- Reduce always-visible buttons; group into menus.
- Ensure “Download” works even while the URL is loading (already partially handled).

Acceptance:
- User can understand “what can I do here?” in < 10 seconds.

#### 7.6 Phase 5 — Builder-delight features (P1)
Pick 2-3 to ship first:
- Photo pin
- Measurement calibration + feet/inches
- “Compare with previous revision” one-click
- Favorites / Starred sheets

Acceptance:
- Each feature has a clear place in UI (no random buttons).

---

### 8) Detailed UI Specs (component-level)

#### 8.1 Sheet row (list mode)
Fields:
- Thumbnail (always present if images exist)
- Sheet # (primary)
- Title (secondary, truncation)
- Discipline badge
- Status dots (open pins, markups)
- Sharing tags (Clients/Subs)

States:
- selected (keyboard focus)
- multi-selected (checkbox)
- loading (skeleton row)

#### 8.2 Preview panel
Tabs:
- Preview (image)
- Linked items (pins list, filterable by status)
- Markups (list)
- Revisions (list + quick compare)

Primary CTA:
- “Open viewer” (full-screen)

#### 8.3 Filters panel
Controls:
- Sheet search
- Discipline
- Plan set
- Toggles:
  - Favorites
  - Has open pins
  - Shared with clients/subs
- Sort

---

### 9) Rollout & Safety

#### 9.1 Feature flag
Add a single flag (example):
- `NEXT_PUBLIC_FEATURE_DRAWINGS_WORKSPACE_V2=true`

Rollout:
- Start with internal orgs only.
- Then project-by-project opt-in.

#### 9.2 Metrics to track (must)
- `drawings_list_loaded_ms`
- `drawings_preview_visible_ms`
- `drawing_viewer_open_thumbnail_ms`
- `drawing_viewer_open_full_ms`
- error rate for image loads vs pdf fallback

---

### 10) Acceptance Criteria (what “done” means)

#### UX
- Browsing drawings feels as clean as Proposals:
  - clear layout
  - calm controls
  - scannable list
- User can preview sheets without a modal.
- Viewer feels organized (tabs/panels, not a wall of tools).

#### Performance
- Large projects remain smooth (virtualized list, no jank).
- Viewer opens immediately with a thumbnail, then upgrades.

#### Consistency
- Uses the same spacing and component language as other pages.
- No duplicated “header inside header”.

---

### Appendix A — Concrete “Why it feels worse than Proposals”
- Proposals:
  - small, composable client component
  - one table, one filter row, clear hierarchy
- Drawings today:
  - multiple header rows + tabs + filters + selection bar all stacked
  - no “preview” state; you’re either browsing or fully modal
  - thumbnails often missing, which makes it look unfinished

---

### Appendix B — Existing assets we should keep (don’t throw away good work)
- `components/drawings/drawing-viewer.tsx`: strong base (prefetch, gestures, clustering)
- `components/drawings/discipline-tabs.tsx`: good pattern (primary + overflow)
- `components/drawings/recent-sheets-section.tsx`: builder-friendly
- Performance docs:
  - `docs/drawings-revamp-gameplan.md`
  - `docs/drawings-performance-gameplan.md`

