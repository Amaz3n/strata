import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface InviteTeamMemberEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  inviterName?: string | null
  inviterEmail?: string | null
  inviteeEmail?: string | null
  inviteLink: string
}

export function InviteTeamMemberEmail({
  orgName,
  orgLogoUrl,
  inviterName,
  inviterEmail,
  inviteeEmail,
  inviteLink,
}: InviteTeamMemberEmailProps) {
  const previewText = `Join ${orgName ?? "Arc"} on Arc`
  const displayOrgName = orgName ?? "Arc"
  const inviterDisplay = inviterName ?? "Arc team"
  const greeting = inviteeEmail ? `Hi ${inviteeEmail.split("@")[0]},` : "Hi,"

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Team Invitation</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>Team Invitation</Text>
            <Heading style={heading}>Join {displayOrgName}</Heading>
            <Text style={subjectText}>You were invited to collaborate in Arc.</Text>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              <strong>{inviterDisplay}</strong>
              {inviterEmail ? (
                <>
                  {" "}(
                  <Link href={`mailto:${inviterEmail}`} style={link}>
                    {inviterEmail}
                  </Link>
                  )
                </>
              ) : null}{" "}
              invited you to join the <strong>{displayOrgName}</strong> workspace.
            </Text>

            <Section style={metaCard}>
              <Text style={metaRow}>
                <span style={metaLabel}>Organization:</span> <span style={metaValue}>{displayOrgName}</span>
              </Text>
              <Text style={metaRow}>
                <span style={metaLabel}>Invited By:</span> <span style={metaValue}>{inviterDisplay}</span>
              </Text>
              {inviteeEmail ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Invitee:</span> <span style={metaValue}>{inviteeEmail}</span>
                </Text>
              ) : null}
            </Section>

            <Section style={contentCard}>
              <Text style={contentLabel}>Access</Text>
              <Text style={contentText}>
                Open the invite to set your password and access projects, documents, and team workflows.
              </Text>
            </Section>

            <Section style={buttonWrap}>
              <Button style={button} href={inviteLink}>
                Join Team
              </Button>
            </Section>

            <Text style={fallbackText}>
              If the button does not open,{" "}
              <Link href={inviteLink} style={link}>
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

const logoImage: React.CSSProperties = {
  border: "1px solid #d6d6d6",
  backgroundColor: "#ffffff",
  display: "block",
  margin: "0 auto",
  padding: "6px",
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

const metaCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "14px 16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const metaRow: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#424242",
  fontSize: "13px",
  lineHeight: "1.5",
}

const metaLabel: React.CSSProperties = {
  color: "#6a6a6a",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const metaValue: React.CSSProperties = {
  color: "#111111",
  fontSize: "13px",
  fontWeight: 600,
}

const contentCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#ffffff",
}

const contentLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const contentText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
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
  fontWeight: 700,
  padding: "12px 24px",
  display: "inline-block",
}

const link: React.CSSProperties = {
  color: "#3A70EE",
  textDecoration: "underline",
}

const fallbackText: React.CSSProperties = {
  margin: "0",
  color: "#666666",
  fontSize: "12px",
  lineHeight: "1.65",
  textAlign: "center",
}

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "18px 40px 22px 40px",
  backgroundColor: "#ffffff",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#777777",
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

export default InviteTeamMemberEmail
