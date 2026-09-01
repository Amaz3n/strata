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

export interface PasswordResetEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientEmail?: string | null
  resetLink: string
}

export function PasswordResetEmail({
  orgName,
  orgLogoUrl,
  recipientEmail,
  resetLink,
}: PasswordResetEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const previewText = `Reset your ${displayOrgName} password`
  const greeting = recipientEmail ? `Hi ${recipientEmail.split("@")[0]},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Password Reset"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Security</Text>
      <Heading style={heading}>Reset your password</Heading>
      <Text style={subjectText}>Use the secure link below to choose a new password.</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        We received a request to reset the password for your <strong>{displayOrgName}</strong> account.
        If this was you, continue with the button below.
      </Text>

      <Section style={contentCard}>
        <Text style={contentLabel}>Security note</Text>
        <Text style={contentText}>
          If you did not request this, you can safely ignore this email. Your current password will remain unchanged.
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

