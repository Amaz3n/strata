import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface InviteTeamMemberEmailProps {
  orgName?: string | null
  inviterName?: string | null
  inviteLink: string
}

export function InviteTeamMemberEmail({
  orgName,
  inviterName,
  inviteLink,
}: InviteTeamMemberEmailProps) {
  const previewText = `You have been invited to join ${orgName ?? "Arc"}`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={logoText}>{orgName || "Arc"}</Text>
          </Section>
          <Section style={content}>
            <Heading style={heading}>You have been invited</Heading>
            <Text style={paragraph}>
              {inviterName ? `${inviterName} invited you to join` : "You have been invited to join"}{" "}
              <strong>{orgName ?? "Arc"}</strong>.
            </Text>
            <Section style={buttonContainer}>
              <Button style={button} href={inviteLink}>
                Set up your account
              </Button>
            </Section>
            <Text style={helpText}>
              This link is single-use and will expire. If it doesn’t work, ask the inviter to resend it.
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              If you weren’t expecting this invite, you can safely ignore this email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "600px",
}

const header: React.CSSProperties = {
  backgroundColor: "#111827",
  padding: "24px 40px",
}

const logoText: React.CSSProperties = {
  color: "#ffffff",
  fontSize: "24px",
  fontWeight: "700",
  margin: "0",
  letterSpacing: "-0.5px",
}

const content: React.CSSProperties = {
  padding: "40px",
}

const heading: React.CSSProperties = {
  color: "#111827",
  fontSize: "28px",
  fontWeight: "700",
  lineHeight: "1.3",
  margin: "0 0 16px 0",
}

const paragraph: React.CSSProperties = {
  color: "#4b5563",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 24px 0",
}

const buttonContainer: React.CSSProperties = {
  textAlign: "center",
  marginBottom: "24px",
}

const button: React.CSSProperties = {
  backgroundColor: "#111827",
  borderRadius: "8px",
  color: "#ffffff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  padding: "14px 32px",
  display: "inline-block",
}

const helpText: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "14px",
  lineHeight: "1.5",
  margin: "0",
  textAlign: "center",
}

const footer: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  padding: "24px 40px",
  borderTop: "1px solid #e5e7eb",
}

const footerText: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "13px",
  lineHeight: "1.5",
  margin: "0",
  textAlign: "center",
}

export default InviteTeamMemberEmail
