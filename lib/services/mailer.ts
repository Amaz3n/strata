import { render } from "@react-email/components"
import type { ReactElement } from "react"
import { InvoiceReminderEmail } from "@/lib/emails/invoice-reminder-email"
import { InviteTeamMemberEmail } from "@/lib/emails/invite-team-member-email"

const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev"

export interface EmailPayload {
  to: (string | null | undefined)[]
  subject: string
  html: string
  text?: string
}

/**
 * Render a React Email component to HTML string
 */
export async function renderEmailTemplate(template: ReactElement): Promise<string> {
  return await render(template)
}

/**
 * Send a transactional email via Resend.
 * - No-ops if API key missing or no recipients.
 * - Deduplicates recipients and filters falsy values.
 */
export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set; skipping email send")
    return
  }

  const recipients = Array.from(new Set(payload.to.filter(Boolean))) as string[]
  if (recipients.length === 0) {
    console.warn("No email recipients provided; skipping email send")
    return
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: recipients,
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? stripHtml(payload.html),
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("Resend API error", response.status, errorText)
    }
  } catch (error) {
    console.error("Failed to send email via Resend", error)
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
}

export interface ReminderEmailPayload {
  to: string
  recipientName: string | null
  invoiceNumber: string
  amountDue: number // in cents
  dueDate: string
  daysOverdue?: number
  payLink: string
}

/**
 * Send a reminder email for an overdue invoice
 */
export async function sendReminderEmail(payload: ReminderEmailPayload): Promise<string | undefined> {
  const amount = `$${(payload.amountDue / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
  const dueDate = new Date(payload.dueDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

  const subject = payload.daysOverdue
    ? `Payment Reminder: Invoice #${payload.invoiceNumber} is ${payload.daysOverdue} days overdue`
    : `Payment Reminder: Invoice #${payload.invoiceNumber} due ${dueDate}`

  const html = await renderEmailTemplate(
    InvoiceReminderEmail({
      recipientName: payload.recipientName,
      invoiceNumber: payload.invoiceNumber,
      amount,
      dueDate,
      daysOverdue: payload.daysOverdue,
      payLink: payload.payLink,
    })
  )

  const emailPayload: EmailPayload = {
    to: [payload.to],
    subject,
    html,
  }

  await sendEmail(emailPayload)

  // For now, return a mock message ID since Resend doesn't return one in the response
  // In a real implementation, you'd parse the response from Resend to get the actual message ID
  return `reminder-${payload.invoiceNumber}-${Date.now()}`
}

export interface InviteEmailPayload {
  to: string
  inviteLink: string
  orgName?: string | null
  inviterName?: string | null
  inviterEmail?: string | null
}

export async function sendInviteEmail(payload: InviteEmailPayload): Promise<void> {
  const html = await renderEmailTemplate(
    InviteTeamMemberEmail({
      orgName: payload.orgName,
      inviterName: payload.inviterName,
      inviterEmail: payload.inviterEmail,
      inviteeEmail: payload.to,
      inviteLink: payload.inviteLink,
    }),
  )

  await sendEmail({
    to: [payload.to],
    subject: `You have been invited to join ${payload.orgName ?? "Arc"}`,
    html,
  })
}

export interface ReminderSMSPayload {
  to: string
  message: string
}

/**
 * Send a reminder SMS for an overdue invoice
 * Note: This currently logs a warning since SMS functionality is not implemented
 */
export async function sendReminderSMS(payload: ReminderSMSPayload): Promise<string | undefined> {
  console.warn("SMS reminders not yet implemented", payload)

  // For now, return undefined to indicate SMS sending failed
  // In a real implementation, you'd integrate with an SMS service like Twilio
  return undefined
}








