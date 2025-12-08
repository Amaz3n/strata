import { NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

export async function POST() {
  const supabase = createServiceSupabaseClient()

  const { data: rules, error: rulesError } = await supabase.from("late_fees").select("*")

  if (rulesError || !rules) {
    return NextResponse.json({ error: rulesError?.message }, { status: 500 })
  }

  const now = new Date()
  let applied = 0

  for (const rule of rules) {
    let query = supabase
      .from("invoices")
      .select("id, org_id, project_id, due_date, balance_due_cents, total_cents")
      .eq("org_id", rule.org_id)
      .in("status", ["sent", "overdue"])
      .gt("balance_due_cents", 0)
      .lt("due_date", now.toISOString().split("T")[0])

    if (rule.project_id) {
      query = query.eq("project_id", rule.project_id)
    }

    const { data: invoices } = await query

    for (const invoice of invoices ?? []) {
      if (!invoice.due_date) continue
      const dueDate = new Date(invoice.due_date)
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

      if (daysOverdue <= (rule.grace_days ?? 0)) continue

      const { count } = await supabase
        .from("late_fee_applications")
        .select("id", { count: "exact", head: true })
        .eq("invoice_id", invoice.id)
        .eq("late_fee_rule_id", rule.id)

      const applicationCount = count ?? 0
      if (rule.max_applications && applicationCount >= rule.max_applications) continue

      if (applicationCount > 0 && rule.repeat_days) {
        const { data: lastApplication } = await supabase
          .from("late_fee_applications")
          .select("applied_at")
          .eq("invoice_id", invoice.id)
          .eq("late_fee_rule_id", rule.id)
          .order("applied_at", { ascending: false })
          .limit(1)
          .single()

        if (lastApplication) {
          const daysSinceLast =
            (now.getTime() - new Date(lastApplication.applied_at).getTime()) / (1000 * 60 * 60 * 24)
          if (daysSinceLast < rule.repeat_days) continue
        }
      }

      let feeAmountCents: number
      if (rule.strategy === "fixed") {
        feeAmountCents = rule.amount_cents ?? 0
      } else {
        feeAmountCents = Math.round((invoice.balance_due_cents ?? 0) * ((rule.percent_rate ?? 0) / 100))
      }

      if (feeAmountCents <= 0) continue

      const { data: newLine, error: lineError } = await supabase
        .from("invoice_lines")
        .insert({
          org_id: invoice.org_id,
          invoice_id: invoice.id,
          description: `Late Fee (${daysOverdue} days overdue)`,
          quantity: 1,
          unit_price_cents: feeAmountCents,
          taxable: false,
          metadata: { late_fee_rule_id: rule.id, days_overdue: daysOverdue },
        })
        .select("id")
        .single()

      if (lineError || !newLine) continue

      await supabase.from("late_fee_applications").insert({
        org_id: invoice.org_id,
        invoice_id: invoice.id,
        late_fee_rule_id: rule.id,
        invoice_line_id: newLine.id,
        amount_cents: feeAmountCents,
        application_number: applicationCount + 1,
      })

      // Bump invoice totals/balance locally (no DB helper available)
      await supabase
        .from("invoices")
        .update({
          total_cents: (invoice.total_cents ?? 0) + feeAmountCents,
          balance_due_cents: (invoice.balance_due_cents ?? 0) + feeAmountCents,
          status: "overdue",
        })
        .eq("id", invoice.id)
        .eq("org_id", invoice.org_id)

      applied += 1
    }
  }

  return NextResponse.json({ applied })
}
