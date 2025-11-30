import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

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
        user_notification_prefs(email_enabled)
      `)
      .eq('id', notificationId)
      .single()

    if (!notification) {
      return new Response(JSON.stringify({ status: 'not_found' }), { status: 404 })
    }

    // Deliver via all enabled channels
    const results = await Promise.allSettled([
      deliverInApp(notification),
      deliverEmail(notification),
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

async function deliverEmail(notification: any): Promise<void> {
  // Check user preferences
  const prefs = notification.user_notification_prefs?.[0]
  if (!prefs?.email_enabled) {
    throw new Error('Email notifications disabled')
  }

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'notifications@yourapp.com', // TODO: Use your actual domain
      to: [notification.app_users.email],
      subject: notification.payload.title,
      html: generateEmailHTML(notification),
    }),
  })

  if (!emailResponse.ok) {
    const errorText = await emailResponse.text()
    throw new Error(`Resend API error: ${errorText}`)
  }

  return await emailResponse.json()
}

function generateEmailHTML(notification: any) {
  const { payload, app_users } = notification
  const userName = app_users?.full_name || 'there'

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${payload.title}</title>
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h1 style="color: #1a1b2e; margin: 0; font-size: 24px;">${payload.title}</h1>
        </div>

        <div style="background-color: white; padding: 20px; border-radius: 8px; border: 1px solid #e9ecef;">
          <p style="font-size: 16px; line-height: 1.6; color: #495057; margin: 0 0 20px 0;">
            Hi ${userName},
          </p>

          <p style="font-size: 16px; line-height: 1.6; color: #495057; margin: 0 0 20px 0;">
            ${payload.message}
          </p>

          <div style="text-align: center; margin-top: 30px;">
            <a href="${Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://yourapp.com'}"
               style="background-color: #1a1b2e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              View in App
            </a>
          </div>
        </div>

        <div style="text-align: center; margin-top: 20px; color: #6c757d; font-size: 14px;">
          <p>You received this notification because you're part of the team.</p>
          <p>
            <a href="#" style="color: #6c757d;">Unsubscribe</a> |
            <a href="${Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://yourapp.com'}/settings" style="color: #6c757d;">Notification Settings</a>
          </p>
        </div>
      </body>
    </html>
  `
}
