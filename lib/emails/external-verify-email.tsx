import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

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
    <Html>
      <Head />
      <Preview>Confirm your Arc email</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={logoFallback}>A</Text>
            <Text style={brandName}>Arc</Text>
            <Text style={brandSub}>Confirm Your Email</Text>
          </Section>

          <Section style={content}>
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
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#ececea",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "32px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "620px",
  border: "1px solid #dcdcdc",
}

const header: React.CSSProperties = {
  textAlign: "center",
  padding: "36px 40px 22px 40px",
  borderBottom: "1px solid #ebebeb",
}

const logoFallback: React.CSSProperties = {
  margin: "0",
  width: "56px",
  height: "56px",
  display: "block",
  marginLeft: "auto",
  marginRight: "auto",
  textAlign: "center",
  lineHeight: "56px",
  border: "1px solid #d6d6d6",
  backgroundColor: "#fff",
  color: "#111111",
  fontWeight: 700,
  fontSize: "18px",
}

const brandName: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#111111",
  fontSize: "15px",
  fontWeight: 700,
}

const brandSub: React.CSSProperties = {
  margin: "4px 0 0 0",
  color: "#6b6b6b",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const content: React.CSSProperties = {
  padding: "30px 40px 32px 40px",
}

const eventLabelText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#666666",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heading: React.CSSProperties = {
  margin: "0",
  color: "#111111",
  fontSize: "34px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.9px",
}

const subjectText: React.CSSProperties = {
  margin: "12px 0 24px 0",
  color: "#111111",
  fontSize: "18px",
  fontWeight: 600,
  lineHeight: "1.5",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
}

const contentCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#ffffff",
}

const contentText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "26px",
  marginBottom: "16px",
}

const button: React.CSSProperties = {
  backgroundColor: "#3A70EE",
  color: "#ffffff",
  border: "1px solid #3A70EE",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
  padding: "12px 24px",
  display: "inline-block",
}

const fallbackText: React.CSSProperties = {
  margin: "0",
  color: "#666666",
  fontSize: "12px",
  textAlign: "center",
}

const link: React.CSSProperties = {
  color: "#3A70EE",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "14px 40px 18px 40px",
  textAlign: "center",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#8a8a8a",
  fontSize: "11px",
}
