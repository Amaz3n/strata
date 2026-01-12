# Project Overview – Share Sheet Revamp (Portal Links)

## Why this change
The current “Share” sheet is powerful but **feels complex by default**:
- The sheet opens into a wide, multi-panel layout that reads like a settings page.
- Creating a link immediately surfaces granular permissions, expiry, and PIN, even though most users just want “make a link + copy”.
- Active links display every permission flag up-front, which is visually noisy and slows scanning.

This clashes with Strata’s core positioning: **simpler than Procore/Buildertrend**.

## Goals
- **Fast path in <10 seconds**: open → create link → copy.
- **Progressive disclosure**: advanced options exist but don’t block the main flow.
- **Scanability**: active links list should answer “which links exist + are they safe?” without showing 16+ toggles by default.
- Preserve existing security model (server-side permission defaults, PIN hashing + lockout, revocation).

## Non-goals (for this iteration)
- Email invitations / contact targeting / templates
- Link naming, tagging, or analytics dashboards
- QR codes, SMS, deep integrations

## Proposed UX (new IA)

### 1) Create a link (primary)
- **Audience picker**: Client / Sub
- If Sub: **company select**
- Primary CTA: **Create link**
- After creation: show a “Link ready” block with:
  - read-only URL field
  - **Copy** and **Open** actions

### 2) Advanced (optional)
Collapsed by default:
- Expiry date (+90 days, no-expiry)
- PIN enable + entry
- Permissions preset:
  - Standard (current defaults)
  - Read-only (remove “do” capabilities)
  - Custom (shows full permission toggles)

### 3) Active links (secondary)
Collapsed by default:
- Summary pill: total active + client/sub breakdown
- Each token row shows:
  - audience + status + expiry + PIN badge
  - copy + revoke
  - “Details” expander for:
    - PIN edit/remove
    - full permission grid (read-only display)

## Implementation plan (code)
- Add a new simplified creator component:
  - `components/sharing/portal-link-creator.tsx`
  - Uses existing server actions: `createPortalTokenAction`, `loadProjectVendorsAction`
  - Preserves server-side defaults via `permissionsToColumns`
- Reduce visual noise in active links:
  - Update `components/sharing/access-token-list.tsx` to hide permission grid behind a “Details” expander
- Wire into Overview share sheet:
  - Update `components/projects/overview/project-overview-actions.tsx`
  - Make the sheet narrower (`sm:max-w-xl`) and copy-focused

## Acceptance criteria
- From the Overview page:
  - Clicking **Share** opens a simple sheet with “Create a link” first.
  - A user can create a client link and copy it without touching advanced settings.
  - Active links are readable at a glance; permissions are visible only when expanded.
- No changes to DB schema or RLS required for this iteration.

## Follow-ups (nice-to-have)
- “Send via email” action (pre-filled subject/body, optional contact picker)
- Link “label” field (e.g. “Owner – weekly updates”)
- Token last-opened auditing UI + suspicious-activity warnings
- Permission presets per org (admin-configurable defaults)




