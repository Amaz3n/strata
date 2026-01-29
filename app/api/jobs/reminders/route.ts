import { NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendReminderEmail, sendReminderSMS } from "@/lib/services/mailer"
import { generateSignedPayLink } from "@/lib/services/payments"

export async function POST() {
  const supabase = createServiceSupabaseClient()

  const { data: reminders, error } = await supabase
    .from("reminders")
    .select(
      `
      id, org_id, invoice_id, channel, schedule, offset_days, template_id,
      invoice:invoices(
        id, org_id, project_id, invoice_number, status, due_date,
        balance_due_cents, total_cents,
        recipient:contacts(id, full_name, email, phone)
      )
    `,
    )
    .not("invoice.status", "in", '("paid","void")')

  if (error || !reminders) {
    return NextResponse.json({ error: error?.message }, { status: 500 })
  }

  const now = new Date()
  const today = now.toISOString().split("T")[0]
  let sentCount = 0

  for (const r of reminders) {
    const reminder = r as any
    if (!reminder.invoice?.due_date || !reminder.invoice?.balance_due_cents) continue

    const dueDate = new Date(reminder.invoice.due_date)
    const daysDiff = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const daysOverdue = -daysDiff

    let shouldSend = false
    if (reminder.schedule === "before_due" && daysDiff === reminder.offset_days) {
      shouldSend = true
    } else if (reminder.schedule === "after_due" && daysOverdue === reminder.offset_days) {
      shouldSend = true
    } else if (reminder.schedule === "overdue" && daysOverdue >= reminder.offset_days && daysOverdue % 7 === 0) {
      shouldSend = true
    }

    if (!shouldSend) continue

    const { data: existing } = await supabase
      .from("reminder_deliveries")
      .select("id")
      .eq("reminder_id", reminder.id)
      .eq("invoice_id", reminder.invoice.id)
      .eq("channel", reminder.channel)
      .gte("created_at", `${today}T00:00:00Z`)
      .maybeSingle()

    if (existing) continue

    try {
      let providerMessageId: string | undefined
      let payLink: string | undefined

      try {
        const signed = generateSignedPayLink({
          orgId: reminder.org_id,
          projectId: reminder.invoice.project_id,
          invoiceId: reminder.invoice.id,
          expiresInHours: 72,
        })
        payLink = signed.url
      } catch {
        payLink = `${process.env.NEXT_PUBLIC_APP_URL}/p/pay/${reminder.invoice.id}`
      }

      if (reminder.channel === "email" && reminder.invoice.recipient?.email) {
        providerMessageId = await sendReminderEmail({
          to: reminder.invoice.recipient.email,
          recipientName: reminder.invoice.recipient.full_name,
          invoiceNumber: reminder.invoice.invoice_number,
          amountDue: reminder.invoice.balance_due_cents,
          dueDate: reminder.invoice.due_date,
          daysOverdue: daysOverdue > 0 ? daysOverdue : undefined,
          payLink,
        })
      } else if (reminder.channel === "sms" && reminder.invoice.recipient?.phone) {
        providerMessageId = await sendReminderSMS({
          to: reminder.invoice.recipient.phone,
          message: `Payment reminder: Invoice #${reminder.invoice.invoice_number} for $${(
            reminder.invoice.balance_due_cents / 100
          ).toFixed(2)} is ${daysOverdue > 0 ? `${daysOverdue} days overdue` : `due ${reminder.invoice.due_date}`}. Pay now: ${payLink}`,
        })
      }

      if (!providerMessageId) continue

      await supabase.from("reminder_deliveries").insert({
        org_id: reminder.org_id,
        reminder_id: reminder.id,
        invoice_id: reminder.invoice.id,
        channel: reminder.channel,
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: providerMessageId,
      })

      sentCount += 1
    } catch (err) {
      await supabase.from("reminder_deliveries").insert({
        org_id: reminder.org_id,
        reminder_id: reminder.id,
        invoice_id: reminder.invoice.id,
        channel: reminder.channel,
        status: "failed",
        error_message: err instanceof Error ? err.message : "Unknown error",
      })
    }
  }

  return NextResponse.json({ processed: reminders.length, sent: sentCount })
}
