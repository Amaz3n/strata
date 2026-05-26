import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'onboarding@resend.dev'

serve(async (req) => {
  try {
    const { notificationId } = await req.json()

    // Get notification details with user email
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: notification } = await supabase
      .from('notifications')
      .select(`
        *,
        app_users!inner(email, full_name),
        user_notification_prefs(email_enabled, email_type_settings)
      `)
      .eq('id', notificationId)
      .single()

    if (!notification) {
      return new Response(JSON.stringify({ status: 'not_found' }), { status: 404 })
    }

    // Deliver via all enabled channels
    const results = await Promise.allSettled([
      deliverInApp(notification),
      deliverEmail(notification, supabase),
      // SMS would go here in the future
    ])

    // Record delivery attempts
    for (let i = 0; i < results.length; i++) {
      const channel = ['in_app', 'email'][i]
      const result = results[i]

      await supabase
        .from('notification_deliveries')
        .insert({
          notification_id: notificationId,
          channel: channel as any,
          status: result.status === 'fulfilled' ? 'sent' : 'failed',
          sent_at: new Date().toISOString(),
          response: result.status === 'fulfilled'
            ? { status: 'success' }
            : { error: result.reason }
        })
    }

    return new Response(JSON.stringify({ status: 'processed' }))

  } catch (error) {
    console.error('Notification delivery failed:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})

async function deliverInApp(notification: any): Promise<void> {
  // In-app notifications are handled by the UI components
  // We just mark this channel as "sent" since the notification exists in the DB
  return Promise.resolve()
}

function getSendingDomain(): string {
  const emailMatch = RESEND_FROM_EMAIL.match(/<(.+)>|(\S+@\S+)/)
  const email = emailMatch ? (emailMatch[1] || emailMatch[2]) : RESEND_FROM_EMAIL
  const parts = email.split("@")
  return parts[1] || "app.arcnaples.com"
}

function getOrgSenderEmail(orgSlug?: string | null, orgName?: string | null): string {
  if (!orgSlug) return RESEND_FROM_EMAIL
  
  const domain = getSendingDomain()
  // Resend's free tier sandbox ONLY allows sending from onboarding@resend.dev
  if (domain === "resend.dev") {
    return RESEND_FROM_EMAIL
  }
  
  const cleanSlug = orgSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, "")
  const friendlyName = orgName ? orgName.replace(/"/g, '\\"') : "Arc"
  
  return `"${friendlyName}" <${cleanSlug}@${domain}>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function generateEmailHTML(args: {
  title: string
  messageHtml: string
  buttonText?: string
  buttonUrl?: string
  orgName?: string | null
  orgLogoUrl?: string | null
  appUrl?: string
}): string {
  const orgName = args.orgName || "Arc"
  const appUrl = (args.appUrl || Deno.env.get('NEXT_PUBLIC_APP_URL') || "https://arcnaples.com").replace(/\/$/, "")
  
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(args.title)}</title>
  </head>
  <body style="background-color: #ececea; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 32px 0;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 620px; background-color: #ffffff; border: 1px solid #dcdcdc; border-collapse: collapse; margin: 0 auto;">
      <!-- Header -->
      <tr>
        <td style="text-align: center; padding: 36px 40px 22px 40px; border-bottom: 1px solid #ebebeb;">
          ${args.orgLogoUrl ? `
            <img src="${args.orgLogoUrl}" alt="${escapeHtml(orgName)}" width="56" height="56" style="border: 1px solid #d6d6d6; background-color: #ffffff; display: block; margin: 0 auto; padding: 6px;" />
          ` : `
            <div style="margin: 0 auto 12px auto; width: 56px; height: 56px; line-height: 56px; text-align: center; border: 1px solid #d6d6d6; background-color: #ffffff; color: #111111; font-weight: 700; font-size: 18px;">
              ${escapeHtml(orgName.slice(0, 1).toUpperCase())}
            </div>
          `}
          <div style="margin: 12px 0 0 0; color: #111111; font-size: 15px; font-weight: 700;">${escapeHtml(orgName)}</div>
          <div style="margin: 4px 0 0 0; color: #6b6b6b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Notification</div>
        </td>
      </tr>
      
      <!-- Content -->
      <tr>
        <td style="padding: 30px 40px 32px 40px;">
          <div style="margin: 0 0 10px 0; color: #666666; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Update</div>
          <h1 style="margin: 0 0 16px 0; color: #111111; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.5px;">${escapeHtml(args.title)}</h1>
          
          <div style="margin: 0 0 24px 0; color: #2f2f2f; font-size: 14px; line-height: 1.6;">
            ${args.messageHtml}
          </div>
          
          ${args.buttonUrl ? `
            <table align="center" border="0" cellpadding="0" cellspacing="0" style="margin: 26px auto 16px auto;">
              <tr>
                <td align="center" style="background-color: #3A70EE; border-radius: 4px;">
                  <a href="${args.buttonUrl}" style="background-color: #3A70EE; color: #ffffff; border: 1px solid #3A70EE; text-decoration: none; font-size: 14px; font-weight: 700; padding: 12px 24px; display: inline-block; border-radius: 4px;">
                    ${escapeHtml(args.buttonText || 'Open in Arc')}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin: 16px 0 0 0; color: #666666; font-size: 12px; line-height: 1.65; text-align: center;">
              If the button does not open, <a href="${args.buttonUrl}" style="color: #3A70EE; text-decoration: underline;">open secure link</a>
            </p>
          ` : ''}
        </td>
      </tr>
      
      <!-- Footer -->
      <tr>
        <td style="padding: 18px 40px 22px 40px; background-color: #ffffff; border-top: 1px solid #ebebeb; text-align: center;">
          <div style="margin: 0 0 8px 0; color: #777777; font-size: 12px; line-height: 1.5;">Sent via Arc</div>
          <div style="margin: 0; color: #999999; font-size: 11px; line-height: 1.5;">
            <a href="${appUrl}/settings" style="color: #777777; text-decoration: underline;">Manage Notification Settings</a>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

async function deliverEmail(notification: any, supabase: any): Promise<void> {
  // Check user preferences
  const prefs = notification.user_notification_prefs?.[0]
  if (!prefs?.email_enabled) {
    throw new Error('Email notifications disabled')
  }
  if (!isEmailNotificationTypeEnabled(prefs.email_type_settings, notification.notification_type)) {
    throw new Error('Email notification type disabled')
  }

  // Fetch organization slug, name, and logo_url
  let orgSlug = null
  let orgName = null
  let orgLogoUrl = null
  if (notification.org_id) {
    const { data: org, error } = await supabase
      .from('orgs')
      .select('slug, name, logo_url')
      .eq('id', notification.org_id)
      .maybeSingle()
    if (error) {
      console.error('Failed to fetch org for email branding:', error)
    } else if (org) {
      orgSlug = org.slug
      orgName = org.name
      orgLogoUrl = org.logo_url
    }
  }

  const fromEmail = getOrgSenderEmail(orgSlug, orgName)
  const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://arcnaples.com'

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [notification.app_users.email],
      subject: notification.payload.title,
      html: generateEmailHTML({
        title: notification.payload.title,
        messageHtml: `Hi ${notification.app_users?.full_name || 'there'},<br/><br/>${notification.payload.message}`,
        buttonText: 'View in App',
        buttonUrl: appUrl,
        orgName,
        orgLogoUrl,
        appUrl
      }),
    }),
  })

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text()
    throw new Error(`Resend API error: ${errorText}`)
  }

  return await emailResponse.json()
}

function isEmailNotificationTypeEnabled(settings: any, notificationType: string | null | undefined): boolean {
  if (!notificationType) return true

  const configurableTypes = new Set([
    'change_order_approved',
    'recipient_signed',
    'payment_recorded',
    'rfi_created',
    'warranty_request_created',
    'submittal_decided',
    'schedule_risk',
  ])

  if (!configurableTypes.has(notificationType)) return true
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true

  return settings[notificationType] !== false
}










