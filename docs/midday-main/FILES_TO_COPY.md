# Files to Copy for Invoice Integration

This document lists the exact files you need to copy from Midday to integrate the invoice system.

## Core Invoice Package

### Templates

**HTML Template:**
- `packages/invoice/src/templates/html/index.tsx`
- `packages/invoice/src/templates/html/format.tsx`
- `packages/invoice/src/templates/html/components/description.tsx`
- `packages/invoice/src/templates/html/components/editor-content.tsx`
- `packages/invoice/src/templates/html/components/line-items.tsx`
- `packages/invoice/src/templates/html/components/logo.tsx`
- `packages/invoice/src/templates/html/components/meta.tsx`
- `packages/invoice/src/templates/html/components/summary.tsx`

**PDF Template:**
- `packages/invoice/src/templates/pdf/index.tsx`
- `packages/invoice/src/templates/pdf/format.tsx`
- `packages/invoice/src/templates/pdf/components/description.tsx`
- `packages/invoice/src/templates/pdf/components/editor-content.tsx`
- `packages/invoice/src/templates/pdf/components/line-items.tsx`
- `packages/invoice/src/templates/pdf/components/meta.tsx`
- `packages/invoice/src/templates/pdf/components/note.tsx`
- `packages/invoice/src/templates/pdf/components/payment-details.tsx`
- `packages/invoice/src/templates/pdf/components/qr-code.tsx`
- `packages/invoice/src/templates/pdf/components/summary.tsx`

**Open Graph Template:**
- `packages/invoice/src/templates/og/index.tsx`
- `packages/invoice/src/templates/og/format.tsx`
- `packages/invoice/src/templates/og/components/avatar.tsx`
- `packages/invoice/src/templates/og/components/editor-content.tsx`
- `packages/invoice/src/templates/og/components/header.tsx`
- `packages/invoice/src/templates/og/components/logo.tsx`
- `packages/invoice/src/templates/og/components/meta.tsx`
- `packages/invoice/src/templates/og/components/status.tsx`

### Utilities

- `packages/invoice/src/utils/calculate.ts`
- `packages/invoice/src/utils/calculate.test.ts` (optional, for testing)
- `packages/invoice/src/utils/content.ts`
- `packages/invoice/src/utils/extract-text.ts`
- `packages/invoice/src/utils/logo.ts`
- `packages/invoice/src/utils/pdf-format.ts`
- `packages/invoice/src/utils/transform.ts`

### Types

- `packages/invoice/src/types.ts`

### Package Files

- `packages/invoice/src/index.tsx` (main export file)
- `packages/invoice/package.json` (for dependency reference)

## Dashboard Components (Invoice Editor)

### Core Editor Components

- `apps/dashboard/src/components/invoice/editor.tsx`
- `apps/dashboard/src/components/invoice/form.tsx`
- `apps/dashboard/src/components/invoice/form-context.tsx`
- `apps/dashboard/src/components/invoice/customer-details.tsx`
- `apps/dashboard/src/components/invoice/from-details.tsx`
- `apps/dashboard/src/components/invoice/payment-details.tsx`
- `apps/dashboard/src/components/invoice/note-details.tsx`
- `apps/dashboard/src/components/invoice/line-items.tsx`
- `apps/dashboard/src/components/invoice/summary.tsx`
- `apps/dashboard/src/components/invoice/meta.tsx`
- `apps/dashboard/src/components/invoice/logo.tsx`
- `apps/dashboard/src/components/invoice/edit-block.tsx`
- `apps/dashboard/src/components/invoice/submit-button.tsx`

### Supporting Files

- `apps/dashboard/src/components/invoice/utils.ts` (if exists, contains helper functions)

## UI Dependencies

You'll also need these UI components from Midday's UI package:

- `packages/ui/src/components/editor/` (Tiptap editor wrapper)
- `packages/ui/src/components/scroll-area/` (ScrollArea component)

**Note:** You may need to adapt these or use alternatives from your UI library.

## Example Usage Files (Reference Only)

These files show how the invoice system is used but don't need to be copied:

- `apps/dashboard/src/components/invoice-content.tsx`
- `apps/dashboard/src/components/sheets/invoice-sheet.tsx`
- `apps/dashboard/src/app/[locale]/(public)/i/[token]/page.tsx`
- `apps/dashboard/src/app/[locale]/(public)/i/[token]/opengraph-image.tsx`
- `apps/api/src/trpc/routers/invoice.ts` (API routes - adapt to your backend)

## QuickBooks Integration Files

You'll need to create these yourself:

- `lib/qbo/client.ts` - QBO API client wrapper
- `lib/qbo/mapping.ts` - Data conversion functions (Midday → QBO)
- `lib/qbo/sync.ts` - Sync logic

## Summary

**Total files to copy:** ~40 files

**Key Dependencies to Install:**
- `@react-pdf/renderer`
- `@tiptap/react` and related extensions
- `qrcode`
- `date-fns`

**Estimated Integration Time:**
- Copying files: 1-2 hours
- Adapting to your codebase: 4-8 hours
- QBO integration: 8-16 hours
- Testing and refinement: 4-8 hours

**Total:** 17-34 hours of development time



