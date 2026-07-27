/**
 * Arc ESLint config.
 *
 * Beyond the Next.js defaults this enforces ONE thing the design standard
 * (docs/design.md §3) could never hold as prose: **tokens only**. Raw Tailwind
 * palette classes and hex literals are banned in .tsx.
 *
 * Kept as .eslintrc.js rather than .json purely so the grandfather list below
 * can carry an explanation.
 */

const PREFIX =
  "(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder)"
const PALETTE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)"

const RAW_PALETTE = `${PREFIX}-${PALETTE}-[0-9]{2,3}`
const HEX_LITERAL = "#[0-9a-fA-F]{6}\\b"

const PALETTE_MESSAGE =
  "Arc is tokens-only: replace this raw Tailwind palette class with a token " +
  "(bg-muted, text-warning, border-line-strong, bg-chart-1, text-success...). See docs/design.md §3."

const HEX_MESSAGE =
  "Arc is tokens-only: replace this hex literal with a token from app/globals.css " +
  "(var(--primary), var(--color-chart-1)...). Tokens are oklch — never wrap one in hsl(). See docs/design.md §3."

/** Both a plain string ("bg-red-500") and a template chunk (`bg-red-500 ${x}`). */
const TOKEN_RULES = [
  { selector: `Literal[value=/${RAW_PALETTE}/]`, message: PALETTE_MESSAGE },
  { selector: `TemplateElement[value.raw=/${RAW_PALETTE}/]`, message: PALETTE_MESSAGE },
  { selector: `Literal[value=/${HEX_LITERAL}/]`, message: HEX_MESSAGE },
  { selector: `TemplateElement[value.raw=/${HEX_LITERAL}/]`, message: HEX_MESSAGE },
]

/**
 * Files that predate the token lint. They are downgraded to `warn` so the rule
 * can be a hard `error` everywhere else — that is the whole point: new code is
 * clean, old code is a visible backlog.
 *
 * Delete a path from this list when you clean the file. NEVER add one.
 */
const GRANDFATHERED = [
  "app/(app)/documents/documents-client.tsx",
  "app/(app)/drawings/debug/page.tsx",
  "app/(app)/projects/\\[id\\]/reports/page.tsx",
  "app/(app)/projects/\\[id\\]/safety/safety-client.tsx",
  "app/(app)/projects/projects-client.tsx",
  "app/(app)/schedule/schedule-client.tsx",
  "app/d/\\[token\\]/components/pdf-field-viewer.tsx",
  "app/d/\\[token\\]/components/review-step.tsx",
  "app/d/\\[token\\]/components/signature-capture.tsx",
  "app/d/\\[token\\]/components/success-screen.tsx",
  "app/d/\\[token\\]/page.tsx",
  "app/dither-lab/page.tsx",
  "app/layout.tsx",
  "app/p/\\[token\\]/change-orders/\\[id\\]/approval-client.tsx",
  "app/p/\\[token\\]/invoices/\\[id\\]/portal-invoice-client.tsx",
  "app/proposal/\\[token\\]/page.tsx",
  "app/r/\\[token\\]/reviewer-rfis-tab.tsx",
  "app/s/\\[token\\]/sub-portal-client.tsx",
  "app/s/\\[token\\]/sub-punch-tab.tsx",
  "app/s/\\[token\\]/sub-rfis-tab.tsx",
  "app/s/\\[token\\]/sub-submittals-tab.tsx",
  "app/t/\\[token\\]/page.tsx",
  "components/auth/accept-invite-form.tsx",
  "components/auth/forgot-password-form.tsx",
  "components/auth/login-form.tsx",
  "components/auth/sign-up-form.tsx",
  "components/change-orders/change-order-detail-sheet.tsx",
  "components/change-orders/change-orders-client.tsx",
  "components/companies/trade-badge.tsx",
  "components/cost-inbox/review-queue-table.tsx",
  "components/crm/crm-dashboard.tsx",
  "components/crm/lead-status-badge.tsx",
  "components/crm/pipeline-card.tsx",
  "components/crm/prospect-detail-sheet.tsx",
  "components/crm/prospects-table.tsx",
  "components/daily-logs/completeness-ring.tsx",
  "components/daily-logs/daily-logs-tab.tsx",
  "components/daily-logs/date-navigator.tsx",
  "components/daily-logs/day-record.tsx",
  "components/daily-logs/quick-log-entry.tsx",
  "components/dashboard/onboarding-checklist.tsx",
  "components/decisions/decisions-client.tsx",
  "components/directory/import-contacts-sheet.tsx",
  "components/documents/documents-explorer.tsx",
  "components/documents/documents-mobile-layout.tsx",
  "components/documents/documents-table.tsx",
  "components/documents/file-properties-panel.tsx",
  "components/drawings/create-from-drawing-dialog.tsx",
  "components/drawings/drawing-pin-layer.tsx",
  "components/drawings/drawing-viewer.tsx",
  "components/drawings/drawings-sets-view.tsx",
  "components/drawings/sheet-status-dots.tsx",
  "components/drawings/viewer/svg-overlay.tsx",
  "components/esign/envelope-wizard.tsx",
  "components/esign/signatures-hub-client.tsx",
  "components/estimates/estimate-create-sheet.tsx",
  "components/estimates/estimates-client.tsx",
  "components/expenses/expense-form.tsx",
  "components/files/file-viewer.tsx",
  "components/financials/billing-autopilot-panel.tsx",
  "components/financials/budget-tab.tsx",
  "components/financials/payables-tab.tsx",
  "components/financials/period-close-workflow.tsx",
  "components/help/help-directory.tsx",
  "components/help/help-shell.tsx",
  "components/home/production-home.tsx",
  "components/integrations/qbo-import-sheet.tsx",
  "components/integrations/qbo-sync-sheet.tsx",
  "components/integrations/stripe-connection-card.tsx",
  "components/invoices/arc-invoice-document.tsx",
  "components/invoices/invoice-bottom-bar.tsx",
  "components/invoices/invoice-detail-sheet.tsx",
  "components/invoices/invoice-public-with-pay.tsx",
  "components/layout/command-search.tsx",
  "components/layout/mobile-bottom-nav.tsx",
  "components/layout/nav-main.tsx",
  "components/layout/nav-user.tsx",
  "components/layout/platform-session-control.tsx",
  "components/notifications/notification-item.tsx",
  "components/payments/pay-link-client.tsx",
  "components/pipeline/lead-status-badge.tsx",
  "components/pipeline/pipeline-attention-strip.tsx",
  "components/pipeline/pipeline-card.tsx",
  "components/platform/impersonation-panel.tsx",
  "components/platform/platform-bug-ui.tsx",
  "components/portal/estimate-builder-signing-client.tsx",
  "components/portal/estimate-portal-client.tsx",
  "components/portal/portal-drawings.tsx",
  "components/portal/quote-portal-shell.tsx",
  "components/portal/sub/sub-compliance-tab.tsx",
  "components/portal/sub/sub-invoice-form.tsx",
  "components/portal/tabs/portal-invoices-tab.tsx",
  "components/portal/tabs/portal-roadmap-tab.tsx",
  "components/projects/draw-schedule-manager.tsx",
  "components/projects/draw-schedule-table.tsx",
  "components/projects/project-financial-setup-fields.tsx",
  "components/projects/project-settings-sheet.tsx",
  "components/projects/retainage-tracker.tsx",
  "components/prospects/prospect-detail-sheet.tsx",
  "components/prospects/prospect-funnel-bar.tsx",
  "components/prospects/prospect-mobile-workspace.tsx",
  "components/prospects/prospects-client.tsx",
  "components/punch/punch-tab.tsx",
  "components/reports/project-profitability-report.tsx",
  "components/reports/reconciliation-report.tsx",
  "components/reports/wip-over-under-report.tsx",
  "components/rfis/rfi-detail-sheet.tsx",
  "components/rfis/rfis-client.tsx",
  "components/schedule/budget-summary-panel.tsx",
  "components/schedule/change-order-impact-badge.tsx",
  "components/schedule/draw-milestone-overlay.tsx",
  "components/schedule/gantt-chart.tsx",
  "components/schedule/lookahead-view.tsx",
  "components/schedule/mobile-item-sheet.tsx",
  "components/schedule/mobile-lookahead-view.tsx",
  "components/schedule/mobile-quick-actions.tsx",
  "components/schedule/schedule-empty-state.tsx",
  "components/schedule/schedule-item-sheet.tsx",
  "components/selections/selections-client.tsx",
  "components/settings/sessions-settings-card.tsx",
  "components/settings/settings-window.tsx",
  "components/sharing/access-token-list.tsx",
  "components/sharing/portal-account-list.tsx",
  "components/sharing/portal-link-creator.tsx",
  "components/submittals/submittal-detail-sheet.tsx",
  "components/submittals/submittals-client.tsx",
  "components/tasks/tasks-tab.tsx",
  "components/team/member-form-panel.tsx",
  "components/team/team-table.tsx",
  "components/ui/project-avatar.tsx",
  "components/ui/toast.tsx",
  "components/warranty/warranty-client.tsx",
]

module.exports = {
  extends: ["next/core-web-vitals", "next/typescript"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-require-imports": "off",
    "react/no-unescaped-entities": "off",
    "@next/next/no-img-element": "off",
  },
  overrides: [
    {
      files: ["app/**/*.tsx", "components/**/*.tsx"],
      rules: { "no-restricted-syntax": ["error", ...TOKEN_RULES] },
    },
    {
      files: GRANDFATHERED,
      rules: { "no-restricted-syntax": ["warn", ...TOKEN_RULES] },
    },
  ],
}
