import {
  mappedValue,
  normalizeCostType,
  normalizeKey,
  normalizeUom,
  normalizeWhitespace,
  parseBoolean,
  parseCents,
  parseDate,
  parseInteger,
  parseNumber,
  requiredIssue,
  stableNaturalKey,
  type ImportIssue,
  type ImportParsedRow,
  type ImportRawRow,
} from "@/lib/services/import-parsers"

export const IMPORTER_KEYS = [
  "cost_codes", "plan_library", "option_catalog", "price_book",
  "communities_lots", "open_wip", "team",
] as const
export type ImporterKey = (typeof IMPORTER_KEYS)[number]

export type ImportColumnType = "text" | "integer" | "number" | "cents" | "date" | "boolean" | "uom" | "cost_type" | "email"

export interface ImportColumnSpec {
  key: string
  label: string
  required?: boolean
  type: ImportColumnType
  example?: string
  values?: readonly string[]
}

export interface ImporterDefinition {
  key: ImporterKey
  label: string
  description: string
  fileKinds?: readonly { key: string; label: string }[]
  columns: readonly ImportColumnSpec[]
  updateFields: readonly string[]
}

const text = (key: string, label: string, required = false, example?: string): ImportColumnSpec => ({ key, label, required, type: "text", example })
const typed = (key: string, label: string, type: ImportColumnType, required = false, example?: string): ImportColumnSpec => ({ key, label, type, required, example })

export const IMPORTER_DEFINITIONS: Record<ImporterKey, ImporterDefinition> = {
  cost_codes: {
    key: "cost_codes", label: "Cost codes", description: "Cost-code hierarchy, cost type, units, and default unit costs.",
    columns: [text("code", "Code", true, "3100"), text("name", "Name", true, "Wall framing"), text("parent_code", "Parent code"), text("division", "Division"), text("category", "Category"), typed("cost_type", "Cost type", "cost_type"), typed("unit", "Unit", "uom"), typed("default_unit_cost_cents", "Default unit cost", "cents")],
    updateFields: ["name", "parent_code", "division", "category", "cost_type", "unit", "default_unit_cost_cents"],
  },
  plan_library: {
    key: "plan_library", label: "Plan library", description: "Import plans and elevations first, then takeoff lines into their draft versions.",
    fileKinds: [{ key: "plans", label: "Plans & elevations" }, { key: "takeoffs", label: "Takeoff lines" }],
    columns: [text("plan_code", "Plan code", true), text("plan_name", "Plan name"), text("series", "Series"), typed("heated_sqft", "Heated sqft", "integer"), typed("total_sqft", "Total sqft", "integer"), typed("beds", "Beds", "number"), typed("baths", "Baths", "number"), typed("stories", "Stories", "number"), typed("garage_bays", "Garage bays", "number"), text("elevation_code", "Elevation code"), text("elevation_name", "Elevation name"), typed("elevation_sqft_delta", "Elevation sqft delta", "integer"), typed("swing_applicable", "Swing applicable", "boolean"), text("cost_code", "Cost code"), text("description", "Description"), typed("quantity", "Quantity", "number"), typed("uom", "UOM", "uom"), typed("unit_cost_cents", "Unit cost", "cents")],
    updateFields: ["plan_name", "series", "heated_sqft", "total_sqft", "beds", "baths", "stories", "garage_bays", "elevation_name", "elevation_sqft_delta", "swing_applicable", "quantity", "uom", "unit_cost_cents"],
  },
  option_catalog: {
    key: "option_catalog", label: "Option catalog", description: "Categories, options, cost/price, scope, vendor, and plan availability.",
    columns: [text("category", "Category", true), text("parent_category", "Parent category"), text("option_code", "Option code", true), text("option_name", "Option name", true), text("scope", "Scope", true), typed("price_cents", "Buyer price", "cents", true), typed("cost_cents", "Builder cost", "cents"), text("cost_code", "Cost code"), text("vendor", "Vendor"), typed("lead_time_days", "Lead time days", "integer"), typed("is_default", "Default", "boolean"), text("applicable_plans", "Applicable plans")],
    updateFields: ["option_name", "scope", "price_cents", "cost_cents", "cost_code", "vendor", "lead_time_days", "is_default", "applicable_plans"],
  },
  price_book: {
    key: "price_book", label: "Price book", description: "Effective-dated vendor pricing by cost code and optional plan/community/division scope.",
    columns: [text("vendor", "Vendor", true), text("cost_code", "Cost code", true), text("description", "Description", true), typed("uom", "UOM", "uom", true), typed("unit_price_cents", "Unit price", "cents", true), text("plan_code", "Plan code"), text("community", "Community"), text("division", "Division"), typed("effective_start", "Effective start", "date"), typed("effective_end", "Effective end", "date")],
    updateFields: ["description", "uom", "unit_price_cents", "effective_end"],
  },
  communities_lots: {
    key: "communities_lots", label: "Communities & lots", description: "Communities and phases are grouped from lot rows; started lots are deferred to Open WIP.",
    columns: [text("community", "Community", true), text("community_code", "Community code"), text("division", "Division"), text("phase", "Phase"), text("lot_number", "Lot number", true), text("block", "Block"), text("status", "Status", true), text("address", "Address"), text("city", "City"), text("state", "State"), text("postal_code", "Postal code"), typed("width_ft", "Width ft", "number"), typed("depth_ft", "Depth ft", "number"), typed("acreage", "Acreage", "number"), text("swing", "Swing"), typed("premium_cents", "Premium", "cents"), typed("cost_basis_cents", "Cost basis", "cents"), text("takedown", "Takedown"), typed("takedown_date", "Takedown date", "date"), text("plan_code", "Plan code"), text("elevation_code", "Elevation code")],
    updateFields: ["status", "address", "city", "state", "postal_code", "width_ft", "depth_ft", "acreage", "swing", "premium_cents", "cost_basis_cents", "takedown", "takedown_date", "plan_code", "elevation_code"],
  },
  open_wip: {
    key: "open_wip", label: "Open WIP", description: "Current-state houses, snapshot budgets, and remaining-value POs as of one cutover date.",
    fileKinds: [{ key: "houses", label: "Houses" }, { key: "budgets", label: "Budget snapshot" }, { key: "purchase_orders", label: "Open POs" }],
    columns: [text("community", "Community", true), text("lot_number", "Lot number", true), text("block", "Block"), text("plan_code", "Plan code"), text("elevation_code", "Elevation code"), text("stage_task", "Current stage task"), typed("stage_date", "Stage date", "date"), typed("budget_total_cents", "Budget total", "cents"), typed("sold", "Sold", "boolean"), text("buyer_name", "Buyer name"), typed("buyer_email", "Buyer email", "email"), typed("sale_price_cents", "Sale price", "cents"), typed("sale_date", "Sale date", "date"), text("cost_code", "Cost code"), typed("budget_cents", "Budget", "cents"), text("po_number", "PO number"), text("vendor", "Vendor"), text("description", "Description"), typed("remaining_cents", "Remaining", "cents"), typed("original_cents", "Original", "cents")],
    updateFields: [],
  },
  team: {
    key: "team", label: "Team & RBAC", description: "Roster and catalog role mapping. Invite delivery stays off until review is complete.",
    columns: [typed("email", "Email", "email", true), text("full_name", "Full name", true), text("role", "Role", true), text("division", "Division"), typed("send_invite", "Send invite", "boolean")],
    updateFields: [],
  },
}

const LOT_STATUS: Record<string, string> = {
  controlled: "controlled", optioned: "controlled", owned: "owned", developed: "developed",
  finished: "developed", "finished lot": "developed", assigned: "assigned", allocated: "assigned",
  started: "started", construction: "started", "under construction": "started", closed: "closed", sold: "closed",
}
const OPTION_SCOPE: Record<string, string> = { structural: "structural", structure: "structural", design: "design_studio", "design studio": "design_studio", design_studio: "design_studio" }
const SWING: Record<string, string> = { left: "left", l: "left", right: "right", r: "right", either: "either", both: "either" }
const ROLE_ALIASES: Record<string, string> = {
  owner: "org_owner", gm: "org_admin", "general manager": "org_admin", "division president": "org_admin",
  "land manager": "org_land_manager", "purchasing manager": "org_purchasing_manager", "purchasing agent": "org_purchasing_manager",
  "starts coordinator": "org_starts_coordinator", superintendent: "org_superintendent", super: "org_superintendent",
  "design studio coordinator": "org_design_studio_coordinator", "sales agent": "org_sales_agent", salesperson: "org_sales_agent",
  "warranty manager": "org_warranty_manager", "service manager": "org_warranty_manager", controller: "org_bookkeeper", bookkeeper: "org_bookkeeper",
  admin: "org_admin", user: "org_user", viewer: "org_viewer",
}

function parseTyped(type: ImportColumnType, value: string) {
  if (type === "cents") return parseCents(value)
  if (type === "integer") return parseInteger(value)
  if (type === "number") return parseNumber(value)
  if (type === "date") return parseDate(value)
  if (type === "boolean") return parseBoolean(value)
  if (type === "uom") return normalizeUom(value)
  if (type === "cost_type") return normalizeCostType(value)
  return normalizeWhitespace(value) || null
}

function conditionalRequired(importer: ImporterKey, fileKind: string | undefined, key: string) {
  if (importer === "plan_library") return fileKind === "takeoffs" ? ["plan_code", "cost_code", "description", "quantity", "uom"].includes(key) : ["plan_code", "plan_name", "elevation_code"].includes(key)
  if (importer === "open_wip") {
    if (fileKind === "budgets") return ["community", "lot_number", "cost_code", "budget_cents"].includes(key)
    if (fileKind === "purchase_orders") return ["community", "lot_number", "po_number", "vendor", "cost_code", "description", "remaining_cents"].includes(key)
    return ["community", "lot_number", "plan_code", "elevation_code", "stage_task", "budget_total_cents"].includes(key)
  }
  return IMPORTER_DEFINITIONS[importer].columns.find((column) => column.key === key)?.required ?? false
}

export function parseImporterRow(input: {
  importer: ImporterKey
  raw: ImportRawRow
  mapping: Record<string, string | null>
  context?: Record<string, unknown>
}): { parsed: ImportParsedRow; issues: ImportIssue[]; naturalKey: string } {
  const definition = IMPORTER_DEFINITIONS[input.importer]
  const fileKind = typeof input.context?.file_kind === "string" ? input.context.file_kind : undefined
  const parsed: ImportParsedRow = {}
  const issues: ImportIssue[] = []
  for (const column of definition.columns) {
    const source = mappedValue(input.raw, input.mapping, column.key)
    const required = conditionalRequired(input.importer, fileKind, column.key)
    if (required) issues.push(...requiredIssue(column.key, column.label, source))
    const typedValue = parseTyped(column.type, source)
    if (source && typedValue == null && column.type !== "text" && column.type !== "email") {
      issues.push({ level: "error", code: `invalid_${column.type}`, message: `${column.label} has an invalid value`, column: column.key })
    }
    if (column.type === "email" && source && !/^\S+@\S+\.\S+$/.test(source)) {
      issues.push({ level: "error", code: "invalid_email", message: `${column.label} is not a valid email`, column: column.key })
    }
    parsed[column.key] = typedValue
  }

  if (input.importer === "communities_lots") {
    const status = LOT_STATUS[normalizeKey(parsed.status)]
    if (parsed.status && !status) issues.push({ level: "error", code: "invalid_status", message: "Lot status is not recognized", column: "status" })
    parsed.status = status ?? parsed.status
    const swing = SWING[normalizeKey(parsed.swing)]
    if (parsed.swing && !swing) issues.push({ level: "error", code: "invalid_swing", message: "Swing must be left, right, or either", column: "swing" })
    parsed.swing = swing ?? (parsed.swing || "either")
    if (status === "started" || status === "closed") issues.push({ level: "warning", code: "requires_open_wip", message: "This lot needs a stage-10 Open WIP house; no project will be created here" })
    if (typeof parsed.premium_cents === "number" && parsed.premium_cents > 20_000_000) issues.push({ level: "warning", code: "premium_outlier", message: "Lot premium exceeds $200,000", column: "premium_cents" })
  }
  if (input.importer === "option_catalog") {
    const scope = OPTION_SCOPE[normalizeKey(parsed.scope)]
    if (parsed.scope && !scope) issues.push({ level: "error", code: "invalid_scope", message: "Scope must be structural or design studio", column: "scope" })
    parsed.scope = scope ?? parsed.scope
    if (typeof parsed.price_cents === "number" && parsed.price_cents < 0) issues.push({ level: "error", code: "negative_price", message: "Buyer price cannot be negative", column: "price_cents" })
    if (!parsed.cost_code) issues.push({ level: "warning", code: "missing_cost_code", message: "Option has no cost code for PO generation", column: "cost_code" })
  }
  if (input.importer === "team") {
    const role = ROLE_ALIASES[normalizeKey(parsed.role)] ?? normalizeKey(parsed.role).replace(/\s+/g, "_")
    parsed.role = role
    if (!role.startsWith("org_")) issues.push({ level: "error", code: "unmapped_role", message: "Role must map to an assignable organization role", column: "role" })
    parsed.send_invite = parsed.send_invite ?? false
  }
  if (input.importer === "price_book" && parsed.unit_price_cents === 0) issues.push({ level: "warning", code: "zero_price", message: "Unit price is zero", column: "unit_price_cents" })
  if (input.importer === "open_wip" && fileKind === "purchase_orders" && typeof parsed.original_cents === "number" && typeof parsed.remaining_cents === "number" && parsed.remaining_cents > parsed.original_cents) {
    issues.push({ level: "error", code: "remaining_gt_original", message: "Remaining PO value cannot exceed original value", column: "remaining_cents" })
  }

  let naturalKey: string
  if (input.importer === "cost_codes") naturalKey = stableNaturalKey([parsed.code])
  else if (input.importer === "plan_library") naturalKey = fileKind === "takeoffs" ? stableNaturalKey([parsed.plan_code, parsed.elevation_code, parsed.cost_code, parsed.description]) : stableNaturalKey([parsed.plan_code, parsed.elevation_code])
  else if (input.importer === "option_catalog") naturalKey = stableNaturalKey([parsed.option_code || `${parsed.category}:${parsed.option_name}`])
  else if (input.importer === "price_book") naturalKey = stableNaturalKey([parsed.vendor, parsed.cost_code, parsed.plan_code, parsed.community || parsed.division, parsed.effective_start])
  else if (input.importer === "communities_lots") naturalKey = stableNaturalKey([parsed.community, parsed.block, parsed.lot_number])
  else if (input.importer === "team") naturalKey = normalizeKey(parsed.email)
  else naturalKey = fileKind === "budgets" ? stableNaturalKey([parsed.community, parsed.block, parsed.lot_number, parsed.cost_code]) : fileKind === "purchase_orders" ? stableNaturalKey([parsed.community, parsed.block, parsed.lot_number, parsed.po_number]) : stableNaturalKey([parsed.community, parsed.block, parsed.lot_number])

  return { parsed, issues, naturalKey }
}

export function importerTemplateCsv(importer: ImporterKey) {
  const definition = IMPORTER_DEFINITIONS[importer]
  return `${definition.columns.map((column) => column.key).join(",")}\n${definition.columns.map((column) => column.example ?? "").join(",")}\n`
}
