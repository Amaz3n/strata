const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Strata Notifications <notifications@strata.build>"

export interface EmailPayload {
  to: (string | null | undefined)[]
  subject: string
  html: string
  text?: string
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
  const amount = (payload.amountDue / 100).toFixed(2)
  const dueDate = new Date(payload.dueDate).toLocaleDateString()

  const subject = payload.daysOverdue
    ? `Payment Reminder: Invoice #${payload.invoiceNumber} is ${payload.daysOverdue} days overdue`
    : `Payment Reminder: Invoice #${payload.invoiceNumber} due ${dueDate}`

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Payment Reminder</h2>
      <p>Dear ${payload.recipientName || 'Valued Customer'},</p>

      <p>This is a reminder that your invoice is ${payload.daysOverdue ? `${payload.daysOverdue} days overdue` : `due on ${dueDate}`}.</p>

      <div style="background-color: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 5px;">
        <p><strong>Invoice Number:</strong> ${payload.invoiceNumber}</p>
        <p><strong>Amount Due:</strong> $${amount}</p>
        <p><strong>Due Date:</strong> ${dueDate}</p>
        ${payload.daysOverdue ? `<p><strong>Days Overdue:</strong> ${payload.daysOverdue}</p>` : ''}
      </div>

      <p>Please click the link below to make your payment:</p>
      <p><a href="${payload.payLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Pay Invoice</a></p>

      <p>If you have already made this payment, please disregard this reminder.</p>

      <p>Thank you for your business!</p>
    </div>
  `

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








