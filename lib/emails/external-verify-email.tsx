import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  contentCard,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  link,
  paragraph,
  subjectText,
} from "./theme"

export interface ExternalVerifyEmailProps {
  recipientEmail?: string | null
  orgName?: string | null
  verifyLink: string
}

/**
 * Sent once, when an external identity is first claimed. Confirming is not a gate
 * — the sub can work immediately — it just proves to the builder that the invited
 * mailbox is really theirs.
 */
export function ExternalVerifyEmail({
  recipientEmail,
  orgName,
  verifyLink,
}: ExternalVerifyEmailProps) {
  const greeting = recipientEmail ? `Hi ${recipientEmail.split("@")[0]},` : "Hi,"
  const invitedBy = orgName ? ` after ${orgName} invited you` : ""

  return (
    <EmailLayout
      preview="Confirm your Arc email"
      subtitle="Confirm Your Email"
    >
      <Text style={eventLabelText}>Account</Text>
      <Heading style={heading}>Confirm your email</Heading>
      <Text style={subjectText}>One tap and your Arc account is fully set up.</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        You created an Arc account{invitedBy}. Confirming this address lets builders know they
        are reaching the right person, and lets you reset your password later if you need to.
      </Text>

      <Section style={contentCard}>
        <Text style={contentText}>
          You do not have to confirm before you start working — everything the builder shared
          is already open to you.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={verifyLink}>
          Confirm Email
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={verifyLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

