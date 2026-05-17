export const BILLING_FEATURE_CATALOG = [
  {
    key: "projects",
    name: "Projects",
    category: "Core",
    description: "Project workspaces, contacts, milestones, and overview tracking.",
  },
  {
    key: "schedule",
    name: "Scheduling",
    category: "Operations",
    description: "Schedules, lookaheads, assignments, and schedule reporting.",
  },
  {
    key: "daily_logs",
    name: "Daily Logs",
    category: "Operations",
    description: "Field daily logs, photos, weather, labor, and notes.",
  },
  {
    key: "files_drawings",
    name: "Files & Drawings",
    category: "Documents",
    description: "Project files, drawing sets, versions, markups, and sharing.",
  },
  {
    key: "client_portal",
    name: "Client Portal",
    category: "Client Experience",
    description: "Client-facing portal access for selections, invoices, files, and updates.",
  },
  {
    key: "rfis_submittals",
    name: "RFIs & Submittals",
    category: "Project Controls",
    description: "RFI and submittal workflows with portal collaboration.",
  },
  {
    key: "bids_proposals",
    name: "Bids & Proposals",
    category: "Preconstruction",
    description: "Bid packages, proposals, pipeline, and preconstruction workflows.",
  },
  {
    key: "financials_ar",
    name: "Receivables",
    category: "Financials",
    description: "Client invoices, payments, draws, retainage, and AR reporting.",
  },
  {
    key: "financials_ap",
    name: "Payables",
    category: "Financials",
    description: "Commitments, vendor bills, payments, lien waivers, and AP reporting.",
  },
  {
    key: "change_orders",
    name: "Change Orders",
    category: "Financials",
    description: "Change order requests, approvals, pricing, and logs.",
  },
  {
    key: "selections",
    name: "Selections",
    category: "Client Experience",
    description: "Selection sheets, client choices, allowances, and approvals.",
  },
  {
    key: "closeout_warranty",
    name: "Closeout & Warranty",
    category: "Client Experience",
    description: "Closeout packets, punch lists, warranty requests, and handoff tracking.",
  },
  {
    key: "qbo",
    name: "QuickBooks",
    category: "Integrations",
    description: "QuickBooks connection, sync, and accounting workflows.",
  },
  {
    key: "esign",
    name: "E-signatures",
    category: "Integrations",
    description: "Document packets, signature envelopes, and executed-file tracking.",
  },
  {
    key: "ai_search",
    name: "AI Search",
    category: "AI",
    description: "AI search, summaries, action assistance, and cross-record querying.",
  },
  {
    key: "cost_plus",
    name: "Cost Plus",
    category: "Financials",
    description: "Cost-plus billing, markup rules, time, expenses, and client billing packages.",
  },
] as const

export type BillingFeatureKey = (typeof BILLING_FEATURE_CATALOG)[number]["key"]

export function allBillingFeatureKeys() {
  return BILLING_FEATURE_CATALOG.map((feature) => feature.key)
}
