import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

const SAMPLE_MARKER = { is_sample: true, sample_key: "naples-remodel-v1" }

export const SAMPLE_PROJECT_SPEC = {
  projectName: "Sample - Naples Remodel",
  client: {
    fullName: "Mia Carter",
    email: "mia.carter@example.com",
    phone: "239-555-0142",
  },
  contractCents: 45000000,
  budgetLines: [
    ["01-100", "General Conditions", 3600000],
    ["02-200", "Selective Demolition", 1800000],
    ["06-100", "Framing & Carpentry", 6200000],
    ["07-300", "Roofing & Waterproofing", 3100000],
    ["09-200", "Drywall & Finishes", 5400000],
    ["09-600", "Flooring", 4200000],
    ["12-300", "Cabinetry & Millwork", 6800000],
    ["15-100", "Plumbing", 4800000],
    ["16-100", "Electrical & Lighting", 5200000],
    ["22-500", "Fixtures & Appliances", 4100000],
  ] as Array<[string, string, number]>,
  commitments: [
    {
      title: "Framing subcontract",
      company: "Gulf Coast Framing Co.",
      totalCents: 5200000,
      lines: [["06-100", "Interior framing and structural carpentry", 1, "ls", 5200000]],
    },
    {
      title: "Plumbing rough-in",
      company: "Naples Bay Plumbing",
      totalCents: 3450000,
      lines: [["15-100", "Rough-in, trim, and fixture setting", 1, "ls", 3450000]],
    },
  ] as Array<{
    title: string
    company: string
    totalCents: number
    lines: Array<[string, string, number, string, number]>
  }>,
  expenses: [
    ["Permit pickup and recording fees", 125000, "other"],
    ["Temporary protection materials", 86000, "company_card"],
    ["Tile sample boards", 54000, "company_card"],
    ["Dumpster pull", 72000, "ach"],
  ] as Array<[string, number, string]>,
  draws: [
    ["Deposit / mobilization", 4500000],
  ] as Array<[string, number]>,
  dailyLogs: [
    ["Demo complete in kitchen and guest bath. Temporary dust partitions holding well."],
    ["MEP rough-in coordination walk completed. Plumbing team staged material for slab cuts."],
    ["Framing inspection prep underway. Client selected revised cabinet layout."],
  ],
  schedule: [
    ["Preconstruction handoff", -14, -10, "complete", 100],
    ["Selective demolition", -9, -4, "complete", 100],
    ["Framing corrections", -3, 4, "in_progress", 45],
    ["Plumbing rough-in", 2, 8, "planned", 0],
    ["Electrical rough-in", 5, 12, "planned", 0],
    ["Drywall hang and finish", 14, 24, "planned", 0],
    ["Cabinet install", 28, 34, "planned", 0],
    ["Substantial completion walkthrough", 42, 42, "planned", 0],
  ] as Array<[string, number, number, string, number]>,
}

function isoDate(offsetDays: number) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

async function findSampleProject(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("project_financial_settings")
    .select("project_id")
    .eq("org_id", orgId)
    .eq("metadata->>is_sample", "true")
    .limit(1)
    .maybeSingle()
  return data?.project_id as string | undefined
}

export async function seedSampleProject(orgId: string, actorUserId: string): Promise<{ projectId: string }> {
  const existingProjectId = await findSampleProject(orgId)
  if (existingProjectId) {
    return { projectId: existingProjectId }
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .insert({
      org_id: orgId,
      name: "Carter Residence",
      company_type: "client",
      phone: SAMPLE_PROJECT_SPEC.client.phone,
      email: SAMPLE_PROJECT_SPEC.client.email,
      address: { city: "Naples", state: "FL" },
      metadata: SAMPLE_MARKER,
    })
    .select("id")
    .single()
  if (companyError || !company) throw new Error(companyError?.message ?? "Failed to create sample client company.")

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      primary_company_id: company.id,
      full_name: SAMPLE_PROJECT_SPEC.client.fullName,
      email: SAMPLE_PROJECT_SPEC.client.email,
      phone: SAMPLE_PROJECT_SPEC.client.phone,
      role: "Owner",
      contact_type: "client",
      metadata: SAMPLE_MARKER,
    })
    .select("id")
    .single()
  if (contactError || !contact) throw new Error(contactError?.message ?? "Failed to create sample client contact.")

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      org_id: orgId,
      name: SAMPLE_PROJECT_SPEC.projectName,
      status: "active",
      start_date: isoDate(-14),
      end_date: isoDate(56),
      location: { street: "1480 Gulf Shore Blvd N", city: "Naples", state: "FL", postalCode: "34102" },
      client_id: contact.id,
      property_type: "residential",
      project_type: "remodel",
      description: "Whole-home residential remodel sample project for onboarding.",
      total_value: SAMPLE_PROJECT_SPEC.contractCents,
      total_contract_value_cents: SAMPLE_PROJECT_SPEC.contractCents,
      created_by: actorUserId,
    })
    .select("id")
    .single()
  if (projectError || !project) throw new Error(projectError?.message ?? "Failed to create sample project.")

  const projectId = project.id as string

  await supabase.from("project_financial_settings").upsert({
    org_id: orgId,
    project_id: projectId,
    billing_model: "fixed_price",
    cost_codes_enabled: true,
    setup_completed_at: nowIso,
    setup_completed_by: actorUserId,
    created_by: actorUserId,
    updated_by: actorUserId,
    metadata: SAMPLE_MARKER,
  }, { onConflict: "org_id,project_id" })

  const { data: costCodes, error: costCodeError } = await supabase
    .from("cost_codes")
    .upsert(
      SAMPLE_PROJECT_SPEC.budgetLines.map(([code, name]) => ({
        org_id: orgId,
        code,
        name,
        category: "sample",
        division: code.slice(0, 2),
        standard: "custom",
        unit: "ls",
        default_unit_cost_cents: 0,
        metadata: SAMPLE_MARKER,
      })),
      { onConflict: "org_id,code" },
    )
    .select("id, code")
  if (costCodeError) throw new Error(`Failed to create sample cost codes: ${costCodeError.message}`)
  const costCodeByCode = new Map((costCodes ?? []).map((row: any) => [row.code as string, row.id as string]))

  const totalBudget = SAMPLE_PROJECT_SPEC.budgetLines.reduce((sum, [, , amount]) => sum + amount, 0)
  const { data: budget, error: budgetError } = await supabase
    .from("budgets")
    .insert({
      org_id: orgId,
      project_id: projectId,
      version: 1,
      status: "approved",
      total_cents: totalBudget,
      metadata: SAMPLE_MARKER,
    })
    .select("id")
    .single()
  if (budgetError || !budget) throw new Error(budgetError?.message ?? "Failed to create sample budget.")

  const { error: budgetLinesError } = await supabase.from("budget_lines").insert(
    SAMPLE_PROJECT_SPEC.budgetLines.map(([code, description, amount], index) => ({
      org_id: orgId,
      budget_id: budget.id,
      cost_code_id: costCodeByCode.get(code),
      description,
      amount_cents: amount,
      sort_order: index,
      metadata: SAMPLE_MARKER,
    })),
  )
  if (budgetLinesError) throw new Error(`Failed to create sample budget lines: ${budgetLinesError.message}`)

  for (const commitmentSpec of SAMPLE_PROJECT_SPEC.commitments) {
    const { data: vendor, error: vendorError } = await supabase
      .from("companies")
      .insert({
        org_id: orgId,
        name: commitmentSpec.company,
        company_type: "vendor",
        phone: "239-555-0199",
        email: "estimating@example.com",
        address: { city: "Naples", state: "FL" },
        metadata: SAMPLE_MARKER,
      })
      .select("id")
      .single()
    if (vendorError || !vendor) throw new Error(vendorError?.message ?? "Failed to create sample vendor.")

    const { data: commitment, error: commitmentError } = await supabase
      .from("commitments")
      .insert({
        org_id: orgId,
        project_id: projectId,
        company_id: vendor.id,
        title: commitmentSpec.title,
        status: "approved",
        total_cents: commitmentSpec.totalCents,
        currency: "usd",
        issued_at: nowIso,
        start_date: isoDate(-5),
        end_date: isoDate(28),
        external_reference: `SAMPLE-${commitmentSpec.title.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
        metadata: SAMPLE_MARKER,
      })
      .select("id")
      .single()
    if (commitmentError || !commitment) throw new Error(commitmentError?.message ?? "Failed to create sample commitment.")

    const { error: commitmentLinesError } = await supabase.from("commitment_lines").insert(
      commitmentSpec.lines.map(([code, description, quantity, unit, amount], index) => ({
        org_id: orgId,
        commitment_id: commitment.id,
        cost_code_id: costCodeByCode.get(code),
        description,
        quantity,
        unit,
        unit_cost_cents: amount,
        sort_order: index,
        metadata: SAMPLE_MARKER,
      })),
    )
    if (commitmentLinesError) throw new Error(`Failed to create sample commitment lines: ${commitmentLinesError.message}`)
  }

  const { error: expensesError } = await supabase.from("project_expenses").insert(
    SAMPLE_PROJECT_SPEC.expenses.map(([description, amount, paymentMethod], index) => ({
      org_id: orgId,
      project_id: projectId,
      cost_code_id: costCodeByCode.get(SAMPLE_PROJECT_SPEC.budgetLines[index]?.[0] ?? "01-100"),
      expense_date: isoDate(-index - 1),
      description,
      amount_cents: amount,
      payment_method: paymentMethod,
      status: "approved",
      submitted_by_user_id: actorUserId,
      approved_by_pm_at: nowIso,
      approved_by_pm_user_id: actorUserId,
      metadata: SAMPLE_MARKER,
    })),
  )
  if (expensesError) throw new Error(`Failed to create sample expenses: ${expensesError.message}`)

  const { error: drawsError } = await supabase.from("draw_schedules").insert(
    SAMPLE_PROJECT_SPEC.draws.map(([title, amount], index) => ({
      org_id: orgId,
      project_id: projectId,
      draw_number: index + 1,
      title,
      description: "Sample owner draw.",
      amount_cents: amount,
      percent_of_contract: (amount / SAMPLE_PROJECT_SPEC.contractCents) * 100,
      due_date: isoDate(index * 30),
      due_trigger: "milestone",
      status: "pending",
      metadata: SAMPLE_MARKER,
    })),
  )
  if (drawsError) throw new Error(`Failed to create sample draw: ${drawsError.message}`)

  const { error: invoiceError } = await supabase.from("invoices").insert({
    org_id: orgId,
    project_id: projectId,
    invoice_number: "SAMPLE-001",
    status: "draft",
    issue_date: isoDate(-2),
    due_date: isoDate(28),
    total_cents: 4500000,
    subtotal_cents: 4500000,
    tax_cents: 0,
    balance_due_cents: 4500000,
    currency: "usd",
    recipient_contact_id: contact.id,
    title: "Sample Mobilization Invoice",
    notes: "Sample invoice for onboarding.",
    client_visible: false,
    tax_rate: 0,
    sent_to_emails: [],
    metadata: SAMPLE_MARKER,
  })
  if (invoiceError) throw new Error(`Failed to create sample invoice: ${invoiceError.message}`)

  const { error: dailyLogsError } = await supabase.from("daily_logs").insert(
    SAMPLE_PROJECT_SPEC.dailyLogs.map(([summary], index) => ({
      org_id: orgId,
      project_id: projectId,
      log_date: isoDate(index - 3),
      weather: { condition: "Sunny", high_f: 84, low_f: 71 },
      summary,
      created_by: actorUserId,
    })),
  )
  if (dailyLogsError) throw new Error(`Failed to create sample daily logs: ${dailyLogsError.message}`)

  const { error: scheduleError } = await supabase.from("schedule_items").insert(
    SAMPLE_PROJECT_SPEC.schedule.map(([name, startOffset, endOffset, status, progress], index) => ({
      org_id: orgId,
      project_id: projectId,
      name,
      item_type: "task",
      status,
      start_date: isoDate(startOffset),
      end_date: isoDate(endOffset),
      progress,
      assigned_to: actorUserId,
      phase: "Remodel",
      trade: "General",
      location: "Residence",
      planned_hours: 16,
      actual_hours: progress > 0 ? 8 : 0,
      constraint_type: "asap",
      constraint_date: isoDate(startOffset),
      is_critical_path: index >= 2 && index <= 5,
      float_days: 0,
      color: "#3A70EE",
      sort_order: index,
      metadata: SAMPLE_MARKER,
    })),
  )
  if (scheduleError) throw new Error(`Failed to create sample schedule: ${scheduleError.message}`)

  await recordEvent({
    orgId,
    actorId: actorUserId,
    eventType: "sample_project_seeded",
    entityType: "project",
    entityId: projectId,
    payload: SAMPLE_MARKER,
  })

  await recordAudit({
    orgId,
    actorId: actorUserId,
    action: "insert",
    entityType: "project",
    entityId: projectId,
    after: { id: projectId, ...SAMPLE_MARKER },
    source: "sample_project_seed",
  })

  return { projectId }
}

export async function deleteSampleProject(orgId: string, projectId: string, actorUserId?: string) {
  const sampleProjectId = await findSampleProject(orgId)
  if (sampleProjectId !== projectId) {
    throw new Error("Only sample projects can be removed with this action.")
  }

  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("projects").delete().eq("org_id", orgId).eq("id", projectId)
  if (error) {
    throw new Error(`Failed to remove sample project: ${error.message}`)
  }

  await recordAudit({
    orgId,
    actorId: actorUserId,
    action: "delete",
    entityType: "project",
    entityId: projectId,
    before: { id: projectId, ...SAMPLE_MARKER },
    source: "sample_project_delete",
  })
}
