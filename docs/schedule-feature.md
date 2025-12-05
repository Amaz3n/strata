# Schedule Feature Documentation

This document describes the comprehensive scheduling system implemented for Strata, designed to be competitive with industry-leading construction management tools like Procore and Buildertrend.

## Overview

The scheduling system provides multiple visualization modes, resource management, dependency tracking, and construction-specific workflows to help manage subcontractors and employees across projects.

---

## Database Schema

### Enhanced `schedule_items` Table

New columns added to support advanced scheduling:

| Column | Type | Description |
|--------|------|-------------|
| `phase` | text | Construction phase (e.g., foundation, framing, finishes) |
| `trade` | text | Trade/specialty (e.g., electrical, plumbing, HVAC) |
| `location` | text | Physical location within the project |
| `planned_hours` | numeric | Estimated hours for the task |
| `actual_hours` | numeric | Actual hours spent |
| `constraint_type` | text | Scheduling constraint (ASAP, ALAP, must_start_on, etc.) |
| `constraint_date` | date | Date for the constraint |
| `is_critical_path` | boolean | Whether item is on the critical path |
| `float_days` | integer | Available slack/float days |
| `color` | text | Custom color for visualization |
| `sort_order` | integer | Manual ordering |

### Enhanced `schedule_dependencies` Table

| Column | Type | Description |
|--------|------|-------------|
| `dependency_type` | text | FS (Finish-to-Start), SS, FF, SF |
| `lag_days` | integer | Lead/lag time in days |

### New `schedule_assignments` Table

Links schedule items to resources (users, contacts, or companies):

```sql
schedule_assignments (
  id, org_id, project_id, schedule_item_id,
  user_id, contact_id, company_id,  -- Polymorphic assignment
  role, planned_hours, actual_hours,
  hourly_rate_cents, notes, confirmed_at
)
```

### New `schedule_baselines` Table

Stores snapshots of the schedule for comparison:

```sql
schedule_baselines (
  id, org_id, project_id, name, description,
  snapshot_at, items (jsonb), is_active, created_by
)
```

### New `schedule_templates` Table

Reusable schedule templates:

```sql
schedule_templates (
  id, org_id, name, description,
  project_type, property_type, items (jsonb),
  is_public, created_by
)
```

---

## Component Architecture

```
components/schedule/
├── index.ts                    # Public exports
├── types.ts                    # TypeScript types and utilities
├── schedule-context.tsx        # React context for state management
├── schedule-view.tsx           # Main component with view switching
├── schedule-toolbar.tsx        # Controls and actions bar
├── schedule-item-sheet.tsx     # Add/edit item form
├── gantt-chart.tsx             # Interactive Gantt view
├── lookahead-view.tsx          # Field-focused weekly view
├── resource-view.tsx           # Resource capacity planning
└── timeline-view.tsx           # Executive roadmap view
```

---

## Views

### 1. Gantt Chart View

The primary scheduling view with full interactivity.

**Features:**
- **Drag-and-drop**: Move tasks by dragging the bar
- **Resize**: Adjust start/end dates by dragging bar edges
- **Zoom levels**: Day, Week, Month, Quarter
- **Grouping**: By phase, trade, status, or none
- **Dependencies**: SVG curved lines with arrowheads
- **Critical path**: Highlighted items that affect project end date
- **Today marker**: Visual indicator of current date
- **Progress bars**: Visual progress overlay on each bar

**Interaction:**
```typescript
// Drag to reschedule
onMouseDown → track start position
onMouseMove → calculate day delta, update preview
onMouseUp → save new dates via onItemUpdate
```

### 2. Lookahead View

A 2-4 week rolling schedule designed for field teams.

**Features:**
- Configurable 2, 3, or 4-week display
- Grouped by crew/subcontractor (trade)
- Weather integration (placeholder for API)
- Quick status updates from tooltips
- Day-by-day task cards
- Summary statistics

**Use Case:** Weekly coordination meetings, superintendent daily planning

### 3. Resource View

Capacity planning and workload management.

**Features:**
- Weekly view with daily breakdown
- Hours allocated per resource per day
- Capacity warnings (under/near/over)
- Utilization percentage calculations
- Color-coded cells for quick identification

**Calculations:**
```typescript
utilization = (totalPlannedHours / weeklyCapacity) * 100
// Under: < 50%, Near: 50-80%, Full: 80-100%, Over: > 100%
```

### 4. Timeline View

Executive-level project roadmap.

**Features:**
- Phase-based horizontal bars
- Milestone diamonds
- Overall progress tracking
- Month-based timeline
- Today marker
- Phase completion percentages

**Use Case:** Client presentations, executive updates, project status reports

### 5. List View

Table-based view for detailed task management.

**Features:**
- Sortable columns
- Inline status editing
- Progress sliders
- Quick actions menu
- Filter by status, phase, trade

---

## Construction-Specific Constants

### Phases (in typical sequence)

```typescript
constructionPhases = [
  "pre_construction",
  "site_work",
  "foundation",
  "framing",
  "roofing",
  "mep_rough",      // Mechanical, Electrical, Plumbing rough-in
  "insulation",
  "drywall",
  "finishes",
  "mep_trim",       // MEP finish/trim
  "landscaping",
  "punch_list",
  "closeout"
]
```

### Trades

```typescript
constructionTrades = [
  "general", "demolition", "concrete", "framing",
  "roofing", "electrical", "plumbing", "hvac",
  "insulation", "drywall", "painting", "flooring",
  "tile", "cabinets", "countertops", "landscaping", "other"
]
```

### Item Types

```typescript
scheduleItemTypes = [
  "task",        // Standard work item
  "milestone",   // Key date/achievement
  "inspection",  // Required inspection
  "handoff",     // Transition between trades
  "phase",       // Phase marker
  "delivery"     // Material delivery
]
```

### Dependency Types

```typescript
dependencyTypes = [
  "FS",  // Finish-to-Start (most common)
  "SS",  // Start-to-Start
  "FF",  // Finish-to-Finish
  "SF"   // Start-to-Finish (rare)
]
```

---

## Service Layer API

### Schedule Items

```typescript
// List all items for org
listScheduleItems(orgId?: string): Promise<ScheduleItem[]>

// List items for specific project
listScheduleItemsByProject(projectId: string, orgId?: string): Promise<ScheduleItem[]>

// Get item with assignments and dependencies
getScheduleItemWithDetails(itemId: string, orgId?: string): Promise<ScheduleItem>

// Create new item
createScheduleItem({ input, orgId }): Promise<ScheduleItem>

// Update item
updateScheduleItem({ itemId, input, orgId }): Promise<ScheduleItem>

// Delete item
deleteScheduleItem(itemId: string, orgId?: string): Promise<void>

// Bulk update (for drag operations)
bulkUpdateScheduleItems(updates: ScheduleBulkUpdate, orgId?: string): Promise<ScheduleItem[]>
```

### Dependencies

```typescript
createDependency(input, projectId, orgId?): Promise<ScheduleDependency>
deleteDependency(dependencyId, orgId?): Promise<void>
listDependenciesByProject(projectId, orgId?): Promise<ScheduleDependency[]>
```

### Assignments

```typescript
listAssignmentsByItem(itemId, orgId?): Promise<ScheduleAssignment[]>
listAssignmentsByProject(projectId, orgId?): Promise<ScheduleAssignment[]>
createAssignment(input, projectId, orgId?): Promise<ScheduleAssignment>
deleteAssignment(assignmentId, orgId?): Promise<void>
```

### Baselines

```typescript
listBaselinesByProject(projectId, orgId?): Promise<ScheduleBaseline[]>
createBaseline(input, orgId?): Promise<ScheduleBaseline>
setActiveBaseline(baselineId, projectId, orgId?): Promise<void>
deleteBaseline(baselineId, orgId?): Promise<void>
```

### Templates

```typescript
listTemplates(orgId?): Promise<ScheduleTemplate[]>
createTemplate(input, orgId?): Promise<ScheduleTemplate>
applyTemplate(templateId, projectId, orgId?): Promise<ScheduleItem[]>
deleteTemplate(templateId, orgId?): Promise<void>
```

---

## Server Actions (Project Detail)

Located in `app/projects/[id]/actions.ts`:

```typescript
// Get schedule items with dependencies
getProjectScheduleAction(projectId: string): Promise<ScheduleItem[]>

// Get dependencies for project
getProjectDependenciesAction(projectId: string): Promise<ScheduleDependency[]>

// Create schedule item
createProjectScheduleItemAction(projectId, input): Promise<ScheduleItem>

// Update schedule item
updateProjectScheduleItemAction(projectId, itemId, input): Promise<ScheduleItem>

// Delete schedule item
deleteProjectScheduleItemAction(projectId, itemId): Promise<void>
```

---

## Usage Example

```tsx
import { ScheduleView } from "@/components/schedule"

function ProjectScheduleTab({ project, scheduleItems }) {
  return (
    <ScheduleView
      projectId={project.id}
      items={scheduleItems}
      onItemCreate={async (item) => {
        const created = await createProjectScheduleItemAction(project.id, item)
        return created
      }}
      onItemUpdate={async (id, updates) => {
        const updated = await updateProjectScheduleItemAction(project.id, id, updates)
        return updated
      }}
      onItemDelete={async (id) => {
        await deleteProjectScheduleItemAction(project.id, id)
      }}
    />
  )
}
```

---

## Styling

Custom CSS classes added to `globals.css`:

| Class | Purpose |
|-------|---------|
| `.gantt-bar` | Smooth transitions for bar interactions |
| `.today-marker` | Subtle pulse animation |
| `.dependency-line` | Draw animation for dependency arrows |
| `.schedule-scroll` | Custom scrollbar styling |
| `.dragging` | Ghost styling during drag |
| `.critical-path` | Highlight ring for critical items |
| `.at-risk-indicator` | Pulse animation for at-risk items |
| `.milestone-diamond` | Diamond clip-path shape |
| `.schedule-toolbar-glass` | Glass morphism effect |

---

## Future Enhancements

1. **Real weather API integration** for lookahead view
2. **Import/Export** to MS Project, Primavera P6
3. **Auto-scheduling** with constraint propagation
4. **Resource leveling** algorithm
5. **Notifications** for schedule changes, approaching deadlines
6. **Mobile-optimized** views for field use
7. **Offline support** with sync queue
8. **AI suggestions** for schedule optimization
9. **Client portal** schedule view (read-only)
10. **Comparison view** for baseline vs actual

---

## Competitive Comparison

| Feature | Strata | Procore | Buildertrend |
|---------|--------|---------|--------------|
| Interactive Gantt | ✅ | ✅ | ✅ |
| Lookahead View | ✅ | ✅ | ❌ |
| Resource Planning | ✅ | ✅ | Limited |
| Dependency Types | 4 (FS/SS/FF/SF) | 4 | 2 |
| Critical Path | ✅ | ✅ | ✅ |
| Baselines | ✅ | ✅ | ✅ |
| Templates | ✅ | ✅ | ✅ |
| Weather Integration | Planned | ✅ | ❌ |
| Mobile Drag-Drop | Planned | Limited | ❌ |

---

## Technical Notes

- **State Management**: React Context with optimistic updates
- **Date Handling**: date-fns for all date operations
- **Validation**: Zod schemas for all inputs
- **Styling**: Tailwind CSS with custom CSS for animations
- **Performance**: Virtualization planned for large schedules (1000+ items)
- **Accessibility**: ARIA labels, keyboard navigation planned

