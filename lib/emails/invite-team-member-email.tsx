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

export interface InviteTeamMemberEmailProps {
  orgName?: string | null
  inviterName?: string | null
  inviterEmail?: string | null
  inviteeEmail?: string | null
  inviteLink: string
}

export function InviteTeamMemberEmail({
  orgName,
  inviterName,
  inviterEmail,
  inviteeEmail,
  inviteLink,
}: InviteTeamMemberEmailProps) {
  const previewText = `Join ${orgName ?? "Arc"} on Arc`
  const displayOrgName = orgName ?? "Arc"

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={logoSection}>
            <Text style={logo}>Arc</Text>
          </Section>
          <Heading style={heading}>
            Join <strong>{displayOrgName}</strong> on <strong>Arc</strong>
          </Heading>
          <Text style={paragraph}>Hello,</Text>
          <Text style={paragraph}>
            {inviterName ? (
              <>
                <strong>{inviterName}</strong>
                {inviterEmail && (
                  <>
                    {" "}(
                    <Link href={`mailto:${inviterEmail}`} style={link}>
                      {inviterEmail}
                    </Link>
                    )
                  </>
                )}
                {" "}has invited you to join the <strong>{displayOrgName}</strong> team on{" "}
                <strong>Arc</strong>.
              </>
            ) : (
              <>
                You have been invited to join the <strong>{displayOrgName}</strong> team on{" "}
                <strong>Arc</strong>.
              </>
            )}
          </Text>
          <Section style={buttonContainer}>
            <Button style={button} href={inviteLink}>
              Join the team
            </Button>
          </Section>
          <Text style={fallbackText}>
            or copy and paste this URL into your browser:{" "}
            <Link href={inviteLink} style={link}>
              {inviteLink}
            </Link>
          </Text>
          <Hr style={hr} />
          <Text style={footer}>
            This invitation was intended for{" "}
            <span style={footerHighlight}>{inviteeEmail ?? "you"}</span>. If you were not
            expecting this invitation, you can ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#ffffff",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #eaeaea",
  borderRadius: "5px",
  margin: "40px auto",
  padding: "20px",
  maxWidth: "465px",
}

const logoSection: React.CSSProperties = {
  marginTop: "32px",
  textAlign: "center",
}

const logo: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: "700",
  margin: "0",
  letterSpacing: "-0.5px",
}

const heading: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: "400",
  textAlign: "center",
  margin: "30px 0",
  padding: "0",
}

const paragraph: React.CSSProperties = {
  color: "#000000",
  fontSize: "14px",
  lineHeight: "24px",
  margin: "0 0 10px 0",
}

const buttonContainer: React.CSSProperties = {
  textAlign: "center",
  marginTop: "32px",
  marginBottom: "32px",
}

const button: React.CSSProperties = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  padding: "12px 20px",
  display: "inline-block",
}

const link: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "none",
}

const fallbackText: React.CSSProperties = {
  color: "#000000",
  fontSize: "14px",
  lineHeight: "24px",
  margin: "0",
}

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #eaeaea",
  margin: "26px 0",
  width: "100%",
}

const footer: React.CSSProperties = {
  color: "#666666",
  fontSize: "12px",
  lineHeight: "24px",
  margin: "0",
}

const footerHighlight: React.CSSProperties = {
  color: "#000000",
}

export default InviteTeamMemberEmail
