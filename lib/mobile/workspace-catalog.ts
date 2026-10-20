import { budgetDraftFields } from "@/lib/mobile/workspace-estimate-fields"
import { isTradeSurface, surfaceAllowsPath, type WorkspaceSurface } from "@/lib/workspace-surface"
/** Native workspace contract. Only explicitly projected product fields leave the API. */
export type WorkspaceField = { key: string; label: string; kind: "text" | "multiline" | "date" | "money" | "number" | "choice" | "rows"; fields?: WorkspaceField[]; options?: string[]; option_labels?: Record<string, string>; required?: boolean }
export type WorkspaceModule = {
  id: string; title: string; group: string; symbol: string; permission: string;
  scope: "project" | "organization" | "both";
  postures?: string[]; moduleKey?: string;
  titleKeys: string[]; fields: WorkspaceField[];
  createPermission?: string; createFields?: WorkspaceField[];
  editPermission?: string; editFields?: WorkspaceField[];
}
const text = (key: string, label: string, required = false): WorkspaceField => ({ key, label, kind: "text", required })
const note = (key: string, label: string, required = false): WorkspaceField => ({ key, label, kind: "multiline", required })
const date = (key: string, label: string): WorkspaceField => ({ key, label, kind: "date" })
const money = (key: string, label: string): WorkspaceField => ({ key, label, kind: "money" })
const basics = [text("status", "Status"), note("description", "Description"), date("due_date", "Due date")]

export const workspaceModules: WorkspaceModule[] = [
  { id: "estimates", title: "Proposals & Estimates", group: "Plan", symbol: "doc.text", permission: "project.manage", scope: "project", titleKeys: ["title"], fields: [text("status", "Status"), text("version", "Version"), date("valid_until", "Valid until"), money("total_cents", "Total")], createPermission: "project.manage", createFields: budgetDraftFields },
  { id: "schedule", title: "Schedule", group: "Build", symbol: "calendar", permission: "schedule.read", scope: "both", titleKeys: ["name"], fields: [text("status", "Status"), date("start_date", "Start"), date("end_date", "Finish"), { key: "progress", label: "Progress (%)", kind: "number" }, text("phase", "Phase"), text("trade", "Trade"), text("location", "Location")] },
  { id: "punch", title: "Punch List", group: "Build", symbol: "exclamationmark.bubble", permission: "project.read", scope: "project", titleKeys: ["title"], fields: [...basics, text("location", "Location"), text("severity", "Severity"), text("assigned_company_name", "Assigned company"), text("verification_required", "Verification required"), note("verification_notes", "Verification notes"), date("verified_at", "Verified"), date("resolved_at", "Resolved")] },
  { id: "correspondence", title: "Correspondence", group: "Build", symbol: "envelope", permission: "correspondence.read", scope: "project", titleKeys: ["subject"], fields: [text("from_address", "From"), text("direction", "Direction"), text("classification", "Classification"), date("occurred_at", "Date"), note("preview", "Preview"), text("attachment_count", "Attachments")] },
  { id: "signatures", title: "Signatures", group: "Plan", symbol: "signature", permission: "org.member", scope: "project", titleKeys: ["document_title"], fields: [text("status", "Status"), text("document_type", "Document type"), date("sent_at", "Sent"), date("executed_at", "Executed"), date("expires_at", "Expires")] },
  { id: "time", title: "Time", group: "Build", symbol: "clock", permission: "time.read", scope: "project", postures: ["residential", "commercial"], titleKeys: ["worker_name"], fields: [text("status", "Status"), date("work_date", "Work date"), { key: "hours", label: "Hours", kind: "number" }, note("notes", "Notes"), text("is_overtime", "Overtime"), text("is_double_time", "Double time")], createPermission: "time.write", createFields: [{ ...date("work_date", "Work date"), required: true }, { key: "hours", label: "Hours", kind: "number", required: true }, note("notes", "Notes")] },
  { id: "tasks", title: "Tasks", group: "Build", symbol: "checklist", permission: "org.member", scope: "both", titleKeys: ["title"], fields: [...basics, text("priority", "Priority"), text("location", "Location")], createPermission: "org.member", createFields: [text("title", "Title", true), note("description", "Description"), date("due_date", "Due date")] },
  { id: "rfis", title: "RFIs", group: "Build", symbol: "questionmark.bubble", permission: "rfi.read", scope: "project", postures: ["residential", "commercial"], titleKeys: ["subject"], fields: [text("rfi_number", "RFI number"), ...basics, note("question", "Question"), text("priority", "Priority"), text("location", "Location")], createPermission: "rfi.write", createFields: [text("subject", "Subject", true), note("question", "Question", true), date("due_date", "Due date"), text("location", "Location")] },
  { id: "submittals", title: "Submittals", group: "Build", symbol: "doc.badge.arrow.up", permission: "submittal.read", scope: "project", postures: ["residential", "commercial"], titleKeys: ["title"], fields: [...basics, text("spec_section", "Specification"), date("required_on_site", "Required on site")], createPermission: "submittal.write", createFields: [text("title", "Title", true), note("description", "Description"), text("spec_section", "Specification"), date("due_date", "Due date")] },
  { id: "decisions", title: "Decisions", group: "Build", symbol: "checkmark.bubble", permission: "decision.read", scope: "project", postures: ["residential", "commercial"], titleKeys: ["title"], fields: basics, createPermission: "decision.write", createFields: [text("title", "Title", true), note("description", "Description"), date("due_date", "Due date")] },
  { id: "inspections", title: "Inspections", group: "Build", symbol: "checkmark.seal", permission: "project.read", scope: "project", postures: ["commercial", "production"], titleKeys: ["title", "name"], fields: [...basics, date("scheduled_date", "Scheduled"), text("location", "Location"), note("notes", "Notes")] },
  { id: "meetings", title: "Meeting Minutes", group: "Build", symbol: "person.3", permission: "project.read", scope: "project", postures: ["commercial"], titleKeys: ["title", "display_number"], fields: [...basics, date("meeting_date", "Meeting date"), text("location", "Location"), note("notes", "Notes")] },
  { id: "transmittals", title: "Transmittals", group: "Build", symbol: "paperplane", permission: "project.read", scope: "project", postures: ["commercial"], titleKeys: ["subject", "title"], fields: [...basics, text("transmittal_number", "Number"), note("notes", "Notes")] },
  { id: "safety", title: "Safety Incidents", group: "Build", symbol: "shield", permission: "safety.read", scope: "project", postures: ["commercial", "production"], titleKeys: ["description"], fields: [text("status", "Status"), note("description", "Description"), date("occurred_at", "Incident date"), text("severity", "Severity"), text("location", "Location"), note("immediate_action", "Immediate action"), note("root_cause", "Root cause")] },
  { id: "selections", title: "Selections", group: "Build", symbol: "swatchpalette", permission: "selections.read", scope: "project", postures: ["production"], titleKeys: ["title", "category_name", "name"], fields: [...basics, text("selection_number", "Number"), money("allowance_cents", "Allowance"), money("selected_price_cents", "Selected price")] },
  { id: "specs", title: "Specifications", group: "Plan", symbol: "doc.text", permission: "docs.read", scope: "project", postures: ["commercial"], titleKeys: ["title", "section_number"], fields: [text("section_number", "Section"), note("description", "Description"), note("content", "Content")] },
  { id: "bids", title: "Bids", group: "Plan", symbol: "hammer", permission: "bid.read", scope: "both", postures: ["residential", "commercial"], titleKeys: ["title"], fields: [...basics, date("due_at", "Due"), text("trade", "Trade")] },
  { id: "budget", title: "Budget", group: "Financials", symbol: "chart.bar", permission: "budget.read", scope: "project", titleKeys: ["description", "cost_code_name", "name"], fields: [money("amount_cents", "Budget"), money("revised_budget_cents", "Revised budget"), money("committed_cents", "Committed"), money("actual_cents", "Actual"), note("notes", "Notes")] },
  { id: "commitments", title: "Commitments", group: "Financials", symbol: "doc.plaintext", permission: "commitment.read", scope: "project", titleKeys: ["title", "contract_number"], fields: [...basics, text("contract_number", "Contract number"), money("total_cents", "Total")] },
  { id: "billing", title: "Billing", group: "Financials", symbol: "dollarsign.circle", permission: "invoice.read", scope: "both", titleKeys: ["invoice_number", "title"], fields: [...basics, date("issue_date", "Issued"), money("total_cents", "Total"), money("balance_due_cents", "Balance due"), text("approval_status", "Review"), text("delivery_status", "Delivery"), text("customer_name", "Customer"), note("notes", "Notes")] },
  { id: "payables", title: "Payables", group: "Financials", symbol: "creditcard", permission: "bill.read", scope: "project", titleKeys: ["bill_number", "invoice_number", "description"], fields: [...basics, money("total_cents", "Total"), money("balance_cents", "Balance")] },
  { id: "change-orders", title: "Change Orders", group: "Financials", symbol: "arrow.triangle.2.circlepath", permission: "change_order.read", scope: "project", titleKeys: ["title", "number"], fields: [...basics, money("total_cents", "Total"), text("schedule_impact_days", "Schedule impact days")] },
  { id: "tm-tickets", title: "T&M Tickets", group: "Financials", symbol: "clock", permission: "invoice.read", scope: "project", titleKeys: ["title", "ticket_number"], fields: [...basics, date("work_date", "Work date"), money("total_cents", "Total")] },
  { id: "closeout", title: "Closeout", group: "Close", symbol: "flag.checkered", permission: "closeout.read", scope: "project", titleKeys: ["title", "name"], fields: [...basics, text("category", "Category"), note("notes", "Notes")] },
  { id: "warranty", title: "Warranty", group: "Close", symbol: "shield.checkered", permission: "warranty.read", scope: "both", titleKeys: ["title", "description"], fields: [...basics, text("severity", "Severity"), text("location", "Location"), note("resolution_notes", "Resolution")] },
  { id: "pipeline", title: "Pipeline", group: "Sell", symbol: "person.crop.rectangle", permission: "pipeline.read", scope: "organization", postures: ["residential", "commercial"], titleKeys: ["name", "project_name", "title"], fields: [...basics, text("stage", "Stage"), text("address", "Address"), money("estimated_value_cents", "Estimated value")] },
  { id: "sales", title: "Sales", group: "Sell", symbol: "target", permission: "sales.read", scope: "organization", postures: ["production"], titleKeys: ["buyer_name", "name", "lot_label"], fields: [...basics, text("community_name", "Community"), text("lot_label", "Lot"), money("contract_price_cents", "Contract price")] },
  { id: "communities", title: "Communities", group: "Sell", symbol: "map", permission: "community.read", scope: "organization", postures: ["production"], titleKeys: ["name"], fields: [...basics, text("city", "City"), text("state", "State"), text("lot_count", "Lots")] },
  { id: "plans", title: "Plans", group: "Sell", symbol: "square.stack.3d.up", permission: "plan.read", scope: "organization", postures: ["production"], titleKeys: ["name", "code"], fields: [...basics, text("code", "Plan code"), text("square_feet", "Square feet"), text("bedrooms", "Bedrooms"), text("bathrooms", "Bathrooms")] },
  { id: "design-studio", title: "Design Studio", group: "Sell", symbol: "slider.horizontal.3", permission: "selections.read", scope: "organization", postures: ["production"], titleKeys: ["name", "title"], fields: [note("description", "Description"), text("sort_order", "Order")] },
  { id: "starts", title: "Starts", group: "Build", symbol: "calendar.badge.clock", permission: "start.read", scope: "organization", postures: ["production"], titleKeys: ["lot_label", "project_name", "name"], fields: [...basics, date("target_week", "Target week"), date("scheduled_start_date", "Scheduled start"), text("community_name", "Community")] },
  { id: "purchasing", title: "Purchasing", group: "Office", symbol: "cart", permission: "price_book.read", scope: "organization", titleKeys: ["description", "company_name", "cost_code_name"], fields: [...basics, money("unit_price_cents", "Unit price"), date("effective_from", "Effective from"), date("effective_to", "Effective to")] },
  { id: "directory", title: "Directory", group: "Office", symbol: "building.2", permission: "directory.read", scope: "organization", titleKeys: ["name"], fields: [text("company_type", "Type"), text("email", "Email"), text("phone", "Phone"), text("address", "Address"), note("notes", "Notes")] },
  { id: "contacts", title: "Contacts", group: "Office", symbol: "person.2", permission: "directory.read", scope: "organization", titleKeys: ["full_name", "name"], fields: [text("email", "Email"), text("phone", "Phone"), text("role", "Role"), note("notes", "Notes")] },
  { id: "reports", title: "Reports", group: "Office", symbol: "chart.xyaxis.line", permission: "report.read", scope: "both", titleKeys: ["title"], fields: [note("description", "Description"), text("group", "Group")] },
  { id: "period-close", title: "Period Close", group: "Books", symbol: "calendar.badge.checkmark", permission: "books.read", scope: "organization", titleKeys: ["title"], fields: [text("status", "Status"), date("period_start", "Period start"), date("period_end", "Period end"), text("fiscal_year", "Fiscal year"), text("fiscal_period", "Fiscal period"), date("closed_at", "Closed"), date("reopened_at", "Reopened")] },
  { id: "banking", title: "Bank Accounts", group: "Books", symbol: "building.columns", permission: "books.read", scope: "organization", titleKeys: ["name"], fields: [text("account_type", "Type"), text("mask", "Ending in"), text("currency", "Currency"), money("current_balance_cents", "Current balance"), money("available_balance_cents", "Available balance"), date("balance_as_of", "Balance as of"), date("last_reconciled_on", "Last reconciled")] },
  { id: "bank-transactions", title: "Bank Transactions", group: "Books", symbol: "arrow.left.arrow.right", permission: "books.read", scope: "organization", titleKeys: ["merchant_name", "description"], fields: [note("description", "Description"), date("transaction_date", "Date"), money("amount_cents", "Amount"), text("direction", "Direction"), text("status", "Status")] },
  { id: "bank-reconciliations", title: "Reconciliations", group: "Books", symbol: "checkmark.circle", permission: "books.reconcile", scope: "organization", titleKeys: ["title"], fields: [text("status", "Status"), date("statement_start", "Statement start"), date("statement_end", "Statement end"), money("beginning_balance_cents", "Beginning balance"), money("ending_balance_cents", "Ending balance"), money("difference_cents", "Difference")] },
  { id: "chart", title: "Chart of Accounts", group: "Books", symbol: "list.number", permission: "books.read", scope: "organization", titleKeys: ["title", "name"], fields: [text("code", "Code"), text("name", "Name"), text("account_type", "Type"), text("subtype", "Subtype"), text("normal_balance", "Normal balance"), text("active", "Active"), note("description", "Description"), text("cash_flow_category", "Cash flow category")], createPermission: "books.manage", createFields: [text("code", "Code", true), text("name", "Name", true), { key: "subtype", label: "Subtype", kind: "choice", required: true }] },
  { id: "assets", title: "Fixed Assets", group: "Books", symbol: "shippingbox", permission: "books.adjust", scope: "organization", titleKeys: ["name"], fields: [text("asset_number", "Asset number"), text("status", "Status"), date("placed_in_service_on", "Placed in service"), money("acquisition_cost_cents", "Acquisition cost"), money("depreciation_cents", "Accumulated depreciation"), money("book_value_cents", "Book value"), text("useful_life_months", "Useful life (months)")] },
  { id: "loans", title: "Loans", group: "Books", symbol: "banknote", permission: "books.adjust", scope: "organization", titleKeys: ["name"], fields: [date("opened_on", "Opened"), date("maturity_on", "Maturity"), money("original_principal_cents", "Original principal"), money("balance_cents", "Balance"), text("annual_interest_bps", "Annual interest (basis points)"), text("payment_frequency", "Payment frequency"), text("active", "Active")] },
  { id: "ledger", title: "General Ledger", group: "Books", symbol: "book.closed", permission: "books.read", scope: "organization", titleKeys: ["memo", "entry_kind"], fields: [text("status", "Status"), date("entry_date", "Entry date"), text("entry_kind", "Kind"), money("debit_cents", "Debit"), money("credit_cents", "Credit")] },
]

const choice = (key: string, label: string, options: string[]): WorkspaceField => ({ key, label, kind: "choice", options, required: true })
const titleFields = [text("title", "Title", true), note("description", "Description"), date("due_date", "Due date")]
const editors: Record<string, { permission: string; fields: WorkspaceField[] }> = {
  schedule: { permission: "schedule.edit", fields: [text("name", "Name", true), choice("item_type", "Type", ["task", "milestone", "inspection", "handoff", "phase", "delivery"]), choice("status", "Status", ["planned", "in_progress", "at_risk", "blocked", "completed", "cancelled"]), date("start_date", "Start"), date("end_date", "Finish"), { key: "progress", label: "Progress (%)", kind: "number", required: true }, text("phase", "Phase"), text("trade", "Trade"), text("location", "Location")] },
  punch: { permission: "org.member", fields: [...titleFields, text("location", "Location"), text("severity", "Severity"), choice("status", "Status", ["open", "in_progress", "ready_for_review", "closed"]), choice("verification_required", "Require verification", ["false", "true"]), note("verification_notes", "Verification notes")] },
  tasks: { permission: "org.member", fields: [...titleFields, choice("status", "Status", ["todo", "in_progress", "blocked", "done"]), choice("priority", "Priority", ["low", "normal", "high", "urgent"])] },
  decisions: { permission: "decision.write", fields: [...titleFields, choice("status", "Status", ["requested", "pending", "approved", "declined", "revised"])] },
  closeout: { permission: "closeout.write", fields: [text("title", "Title", true), choice("status", "Status", ["missing", "in_progress", "complete"]), date("due_date", "Due date"), text("responsible_party", "Responsible party"), note("notes", "Notes")] },
  warranty: { permission: "warranty.write", fields: [text("title", "Title", true), note("description", "Description"), choice("priority", "Priority", ["low", "normal", "high", "urgent"]), choice("severity", "Severity", ["emergency", "routine_30", "routine_60"]), text("category", "Category"), date("scheduled_date", "Scheduled date"), note("resolution_note", "Resolution note")] },
  meetings: { permission: "meeting.write", fields: [text("title", "Title", true), text("location", "Location")] },
  inspections: { permission: "inspection.write", fields: [text("title", "Title", true), text("location", "Location"), text("inspector_name", "Inspector"), note("notes", "Notes")] },
  safety: { permission: "safety.write", fields: [note("description", "Description", true), text("location", "Location"), note("immediate_action", "Immediate action"), note("root_cause", "Root cause"), choice("status", "Status", ["open", "under_review", "closed"])] },
}
const fieldForTemplate = (): WorkspaceField => ({ key: "template_id", label: "Checklist template", kind: "choice", required: true })
for (const workspaceModule of workspaceModules) {
  const editor = editors[workspaceModule.id]
  if (editor) {
    workspaceModule.editPermission = editor.permission
    workspaceModule.editFields = editor.fields
    for (const field of editor.fields) if (!workspaceModule.fields.some(f => f.key === field.key)) workspaceModule.fields.push(field)
  if (workspaceModule.id === "pipeline") { workspaceModule.editPermission = undefined; workspaceModule.editFields = undefined; workspaceModule.fields.push(date("next_follow_up_at", "Next follow-up"), text("lost_reason", "Lost reason")) }
  }
  if (workspaceModule.id === "schedule") {
    workspaceModule.createPermission = "schedule.edit"
    workspaceModule.createFields = workspaceModule.editFields
  }
  if (workspaceModule.id === "punch") {
    workspaceModule.createPermission = "org.member"
    workspaceModule.createFields = workspaceModule.editFields?.filter(field => !["status", "verification_notes"].includes(field.key))
  }
  if (workspaceModule.id === "billing") {
    workspaceModule.createPermission = "invoice.write"
    workspaceModule.createFields = [text("title", "Title", true)]
  }
  if (workspaceModule.id === "closeout") {
    workspaceModule.createPermission = "closeout.write"
    workspaceModule.createFields = workspaceModule.editFields
  }
  if (workspaceModule.id === "warranty") {
    workspaceModule.createPermission = "warranty.write"
    workspaceModule.createFields = workspaceModule.editFields?.filter(field => !["scheduled_date", "resolution_note"].includes(field.key))
    workspaceModule.fields.push(date("first_response_due_at", "First response due"), date("first_responded_at", "First response recorded"), date("resolution_due_at", "Resolution due"), text("coverage_status", "Coverage"))
  }
  if (workspaceModule.id === "inspections") {
    workspaceModule.createPermission = "inspection.write"
    workspaceModule.createFields = [text("title", "Title", true), { ...fieldForTemplate() }, text("location", "Location")]
  }
  if (workspaceModule.id === "meetings") {
    workspaceModule.createPermission = "meeting.write"
    workspaceModule.createFields = [text("title", "Title", true), choice("series", "Series", ["oac", "sub", "safety", "custom"]), text("location", "Location")]
  }
  if (workspaceModule.id === "safety") {
    workspaceModule.titleKeys = ["description"]
    workspaceModule.createPermission = "safety.write"
    workspaceModule.createFields = [{ ...date("occurred_at", "Occurred"), required: true }, choice("severity", "Severity", ["near_miss", "first_aid", "medical_treatment", "lost_time", "fatality"]), note("description", "Description", true), text("location", "Location"), text("involved_person_name", "Person involved"), note("immediate_action", "Immediate action")]
    workspaceModule.fields.push(date("occurred_at", "Occurred"), text("involved_person_name", "Person involved"))
  }
}

const rows = (key: string, label: string, fields: WorkspaceField[]): WorkspaceField => ({ key, label, kind: "rows", required: true, fields })
const number = (key: string, label: string, required = false): WorkspaceField => ({ key, label, kind: "number", required })
const documentCreators: Record<string, { permission: string; fields: WorkspaceField[] }> = {
  transmittals: { permission: "transmittal.write", fields: [text("subject", "Subject", true), choice("purpose", "Purpose", ["for_review", "for_approval", "for_record", "for_construction", "as_requested"]), note("notes", "Notes"), rows("recipients", "Recipients", [text("display_name", "Name", true), text("email", "Email", true), text("company_name", "Company")]), rows("items", "Enclosures", [text("description", "Description", true), number("copies", "Copies"), { key: "file_id", label: "Project document", kind: "choice", options: ["none"], option_labels: { none: "No digital attachment" } }])] },
  "change-orders": { permission: "change_order.write", fields: [text("title", "Title", true), note("summary", "Summary", true), note("description", "Description"), number("days_impact", "Schedule impact (days)"), number("tax_rate", "Tax (%)"), number("markup_percent", "Markup (%)"), rows("lines", "Line Items", [text("description", "Description", true), number("quantity", "Quantity", true), text("unit", "Unit"), number("unit_cost", "Unit price ($)", true), choice("taxable", "Taxable", ["true", "false"])])] },
  commitments: { permission: "commitment.write", fields: [text("title", "Title", true), { key: "company_id", label: "Company", kind: "choice", required: true }, choice("commitment_type", "Type", ["subcontract", "purchase_order"]), text("contract_number", "Contract number"), number("total", "Contract amount ($)", true), number("retainage_percent", "Retainage (%)"), date("start_date", "Start"), date("end_date", "Finish"), note("scope", "Scope"), note("terms", "Terms")] },
  bids: { permission: "bid.write", fields: [text("title", "Title", true), choice("mode", "Mode", ["quote", "tender"]), text("trade", "Trade"), note("scope", "Scope"), note("instructions", "Instructions")] },
}
for (const workspaceModule of workspaceModules) {
  const creator = documentCreators[workspaceModule.id]
  if (creator) { workspaceModule.createPermission = creator.permission; workspaceModule.createFields = creator.fields }
}

const officeEditors: Record<string, { permission: string; fields: WorkspaceField[] }> = {
  pipeline: { permission: "org.member", fields: [text("name", "Opportunity name", true), text("source", "Source"), text("project_type", "Project type"), text("budget_range", "Budget range"), text("timeline_preference", "Timeline"), note("notes", "Notes")] },
  directory: { permission: "directory.write", fields: [text("name", "Company name", true), choice("company_type", "Type", ["subcontractor", "supplier", "client", "architect", "engineer", "other"]), text("phone", "Phone"), text("email", "Email"), text("website", "Website"), text("trade", "Trade"), note("notes", "Notes")] },
  contacts: { permission: "directory.write", fields: [text("full_name", "Full name", true), choice("contact_type", "Type", ["internal", "subcontractor", "client", "vendor", "consultant", "prospect", "buyer", "homeowner", "agent"]), text("email", "Email"), text("phone", "Phone"), text("role", "Role"), text("address", "Address"), note("notes", "Notes")] },
  communities: { permission: "community.write", fields: [text("name", "Name", true), text("code", "Code"), choice("status", "Status", ["planning", "active", "sold_out", "closed"]), text("address", "Address"), text("city", "City"), text("state", "State"), text("postalCode", "Postal code"), note("description", "Description")] },
  plans: { permission: "plan.write", fields: [text("code", "Code", true), text("name", "Name", true), text("series", "Series"), choice("status", "Status", ["draft", "active", "retired"]), note("description", "Description")] },
}
for (const workspaceModule of workspaceModules) {
  const editor = officeEditors[workspaceModule.id]
  if (!editor) continue
  workspaceModule.createPermission = editor.permission
  workspaceModule.createFields = editor.fields
  workspaceModule.editPermission = editor.permission
  workspaceModule.editFields = editor.fields
  for (const field of editor.fields) if (!workspaceModule.fields.some(f => f.key === field.key)) workspaceModule.fields.push(field)
  if (workspaceModule.id === "pipeline") { workspaceModule.editPermission = undefined; workspaceModule.editFields = undefined; workspaceModule.fields.push(date("next_follow_up_at", "Next follow-up"), text("lost_reason", "Lost reason")) }
}

export function projectModuleVisible(module: WorkspaceModule, posture: string, phase?: string | null, overrides: Record<string, boolean> = {}) {
  if (phase === "precon" && module.group !== "Plan") return false
  return overrides[module.moduleKey ?? module.id.replaceAll("-", "_")] ?? (!module.postures || module.postures.includes(posture))
}

/** The web desk each organization module mirrors, so the workspace surface decides both the same way. */
const MODULE_DESK_PATHS: Record<string, string> = {
  estimates: "/estimates", bids: "/bids", warranty: "/warranty", sales: "/sales", communities: "/communities",
  plans: "/plans", "design-studio": "/design-studio", starts: "/starts", purchasing: "/purchasing",
}
/** The project workbench tab each project module mirrors. */
const MODULE_PROJECT_TABS: Record<string, string> = {
  bids: "/bids", selections: "/selections", decisions: "/decisions", meetings: "/meetings", transmittals: "/transmittals",
  specs: "/specs", budget: "/financials/budget", closeout: "/closeout", warranty: "/warranty",
  commitments: "/commitments", rfis: "/rfis", submittals: "/submittals", inspections: "/inspections", safety: "/safety",
}

/** Whether the org's plan and business profile include a module; project overrides can switch a tab back on. */
export function surfaceAllowsModule(module: WorkspaceModule, surface: WorkspaceSurface, projectOverrides?: Record<string, boolean>) {
  const tab = projectOverrides ? MODULE_PROJECT_TABS[module.id] : undefined
  if (tab) return surfaceAllowsPath(surface, `/projects/project${tab}`, projectOverrides)
  const desk = MODULE_DESK_PATHS[module.id]
  return !desk || surfaceAllowsPath(surface, desk)
}

const TRADE_MODULE_TITLES: Record<string, string> = { time: "Crew time", pipeline: "Opportunities" }
const TRADE_FIELD_LABELS: Record<string, string> = { "Project type": "Job type" }

export function workspaceModuleTitle(module: WorkspaceModule, surface: WorkspaceSurface) {
  return (isTradeSurface(surface) && TRADE_MODULE_TITLES[module.id]) || module.title
}

/** A module's form fields in the workspace's words: a trade company is never asked for a "Project type". */
export function workspaceModuleFields(fields: WorkspaceField[], surface: WorkspaceSurface): WorkspaceField[] {
  if (!isTradeSurface(surface)) return fields
  return fields.map((field) => ({ ...field, label: TRADE_FIELD_LABELS[field.label] ?? field.label }))
}

export function workspaceRecord(module: WorkspaceModule, value: unknown, index: number) {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const scalar = (value: unknown): string | null => typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null
  const read = (key: string) => row[key] ?? row[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())]
  const title = module.titleKeys.map(key => scalar(read(key))).find(value => value?.trim()) ?? `${module.title} ${index + 1}`
  return {
    id: scalar(row.id) ?? `${module.id}-${index}`,
    title, status: scalar(row.status),
    fields: module.fields.flatMap(field => {
      const value = scalar(read(field.key))
      return value === null || value === "" ? [] : [{ ...field, value }]
    }),
  }
}
