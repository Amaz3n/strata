import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  contentCard,
  contentLabel,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  link,
  paragraph,
  subjectText,
} from "./theme"

export interface ExternalPasswordResetEmailProps {
  recipientEmail?: string | null
  resetLink: string
}

/**
 * Reset mail for an external identity — a sub, buyer, or reviewer. Deliberately
 * Arc-branded rather than builder-branded: one identity spans every builder who
 * invites them, so naming one org here would misdescribe what they are resetting.
 */
export function ExternalPasswordResetEmail({
  recipientEmail,
  resetLink,
}: ExternalPasswordResetEmailProps) {
  const greeting = recipientEmail ? `Hi ${recipientEmail.split("@")[0]},` : "Hi,"

  return (
    <EmailLayout
      preview="Reset your Arc password"
      subtitle="Password Reset"
    >
      <Text style={eventLabelText}>Security</Text>
      <Heading style={heading}>Reset your password</Heading>
      <Text style={subjectText}>Use the secure link below to choose a new password.</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        We received a request to reset the password for your Arc account — the one you use to
        open the projects and bids that builders share with you.
      </Text>

      <Section style={contentCard}>
        <Text style={contentLabel}>Before you continue</Text>
        <Text style={contentText}>
          This link expires in one hour. Choosing a new password signs you out everywhere, so
          you will need to sign in again on your other devices.
        </Text>
        <Text style={contentTextMuted}>
          If you did not request this, you can safely ignore this email. Your current password
          will remain unchanged.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={resetLink}>
          Reset Password
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={resetLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

const contentTextMuted: React.CSSProperties = {
  margin: "10px 0 0 0",
  color: "#626262",
  fontSize: "13px",
  lineHeight: "1.6",
}

