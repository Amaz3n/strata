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


