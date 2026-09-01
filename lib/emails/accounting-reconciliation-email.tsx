import { Button, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  fallbackText,
  link,
  palette,
  paragraph,
} from "./theme"

export type ReconciliationEmailSeverity = "critical" | "warning" | "info"

export type ReconciliationEmailFinding = {
  label: string
  severity: ReconciliationEmailSeverity
  description: string
  /** Project name when the finding belongs to one; org-wide findings have none. */
  projectName?: string | null
  amountLabel?: string | null
  href?: string | null
}

export type ReconciliationEmailGroup = {
  label: string
  severity: ReconciliationEmailSeverity
  countLabel: string
  amountLabel?: string | null
}

export interface AccountingReconciliationEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  runDateLabel: string
  headline: string
  /** New / Open / Critical / Unexplained money / Cleared — five at most, they sit in one row. */
  metrics: Array<{ label: string; value: string; tone?: ReconciliationEmailSeverity | "neutral" }>
  findings: ReconciliationEmailFinding[]
  /** How many findings exist beyond the ones listed, so the list never reads as the whole queue. */
  remainingCount: number
  groups: ReconciliationEmailGroup[]
  coverageNotes: string[]
  queueUrl: string
}

const SEVERITY_LABEL: Record<ReconciliationEmailSeverity, string> = {
  critical: "Critical",
  warning: "Review",
  info: "Info",
}

export function AccountingReconciliationEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  runDateLabel = "Nightly pass · Aug 8, 2026",
  headline = "24 new findings",
  metrics = [],
  findings = [],
  remainingCount = 0,
  groups = [],
  coverageNotes = [],
  queueUrl = "#",
}: AccountingReconciliationEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const criticalFindings = findings.filter((finding) => finding.severity === "critical").length
  const previewText = `${headline} · ${displayOrgName} accounting reconciliation`

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Accounting Reconciliation"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
      footerNote={<>You receive this because you can reconcile the books for {displayOrgName}.</>}
    >
      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        The nightly reconciliation compared Arc against your bank, your payment rails, and your accounting system.
        Here is what it could not tie out.
      </Text>

      {metrics.length > 0 ? (
        <Section style={sectionCard}>
          <Text style={sectionTitle}>This Pass</Text>
          <table style={metricsTable} cellPadding={0} cellSpacing={0} role="presentation">
            <tbody>
              <tr>
                {metrics.slice(0, 5).map((metric, index) => (
                  <td
                    key={metric.label}
                    style={index === Math.min(metrics.length, 5) - 1 ? metricCellLast : metricCell}
                  >
                    <Text style={metricLabel}>{metric.label}</Text>
                    <Text style={metric.tone === "critical" ? metricValueCritical : metricValue}>
                      {metric.value}
                    </Text>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </Section>
      ) : null}

      <Section style={sectionCard}>
        <Text style={sectionTitle}>Take These First</Text>
        <table style={findingTable} cellPadding={0} cellSpacing={0} role="presentation">
          <tbody>
            {findings.map((finding, index) => (
              <tr key={`${finding.label}-${index}`}>
                <td style={index === findings.length - 1 ? findingCellLast : findingCell}>
                  <Text style={findingHeadRow}>
                    <span style={severityChip(finding.severity)}>{SEVERITY_LABEL[finding.severity]}</span>
                    <span style={findingLabel}>{finding.label}</span>
                  </Text>
                  <Text style={findingDescription}>{finding.description}</Text>
                  <Text style={findingMeta}>
                    {finding.projectName ? <span style={findingProject}>{finding.projectName}</span> : null}
                    {finding.projectName && finding.amountLabel ? <span style={metaDivider}> · </span> : null}
                    {finding.amountLabel ? <span style={findingAmount}>{finding.amountLabel} unexplained</span> : null}
                    {(finding.projectName || finding.amountLabel) && finding.href ? (
                      <span style={metaDivider}> · </span>
                    ) : null}
                    {finding.href ? (
                      <Link href={finding.href} style={link}>
                        Open the record
                      </Link>
                    ) : null}
                  </Text>
                </td>
              </tr>
            ))}
            {findings.length === 0 ? (
              <tr>
                <td style={findingCellLast}>
                  <Text style={findingDescription}>No open findings carry detail for this pass.</Text>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {remainingCount > 0 ? (
          <Text style={moreNote}>
            + {remainingCount} more open finding{remainingCount === 1 ? "" : "s"} in the queue.
          </Text>
        ) : null}
      </Section>

      {groups.length > 0 ? (
        <Section style={sectionCard}>
          <Text style={sectionTitle}>Everything Open, By Type</Text>
          <table style={groupTable} cellPadding={0} cellSpacing={0} role="presentation">
            <tbody>
              {groups.map((group, index) => (
                <tr key={group.label}>
                  <td style={index === groups.length - 1 ? groupCellLast : groupCell}>
                    <span style={severityDot(group.severity)} />
                    <span style={groupLabel}>{group.label}</span>
                  </td>
                  <td style={index === groups.length - 1 ? groupNumberCellLast : groupNumberCell} align="right">
                    <span style={groupCount}>{group.countLabel}</span>
                  </td>
                  <td style={index === groups.length - 1 ? groupNumberCellLast : groupNumberCell} align="right">
                    <span style={groupAmount}>{group.amountLabel ?? "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {coverageNotes.length > 0 ? (
        <Section style={coverageCard}>
          <Text style={coverageTitle}>What this pass did not cover</Text>
          {coverageNotes.map((note, index) => (
            <Text key={`coverage-${index}`} style={coverageText}>
              • {note}
            </Text>
          ))}
        </Section>
      ) : null}

      <Section style={buttonWrap}>
        <Button style={button} href={queueUrl}>
          Open the finding queue
        </Button>
      </Section>

      <Text style={fallbackText}>
        Each finding can be resolved, explained, or ignored from{" "}
        <Link href={queueUrl} style={link}>
          Books · Period close
        </Link>
        . Explaining one keeps it out of tomorrow&apos;s email unless the amount changes.
      </Text>
    </EmailLayout>
  )
}

const SEVERITY_COLOR: Record<ReconciliationEmailSeverity, string> = {
  critical: palette.danger,
  warning: palette.warning,
  info: "#475467",
}

const SEVERITY_BACKGROUND: Record<ReconciliationEmailSeverity, string> = {
  critical: "#fef3f2",
  warning: "#fffaeb",
  info: "#f2f4f7",
}

function severityChip(severity: ReconciliationEmailSeverity): React.CSSProperties {
  return {
    display: "inline-block",
    marginRight: "8px",
    padding: "2px 6px",
    backgroundColor: SEVERITY_BACKGROUND[severity],
    color: SEVERITY_COLOR[severity],
    border: `1px solid ${SEVERITY_COLOR[severity]}33`,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.6px",
  }
}

function severityDot(severity: ReconciliationEmailSeverity): React.CSSProperties {
  return {
    display: "inline-block",
    width: "8px",
    height: "8px",
    marginRight: "8px",
    borderRadius: "9999px",
    backgroundColor: SEVERITY_COLOR[severity],
  }
}

const sectionCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #e3e3e3",
  backgroundColor: "#ffffff",
}

const sectionTitle: React.CSSProperties = {
  margin: "0",
  padding: "12px 14px",
  borderBottom: "1px solid #deebff",
  backgroundColor: "#f4f8ff",
  color: palette.brand,
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const metricsTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const metricCell: React.CSSProperties = {
  padding: "12px",
  borderRight: "1px solid #eaecf0",
  verticalAlign: "top",
}

const metricCellLast: React.CSSProperties = {
  padding: "12px",
  verticalAlign: "top",
}

const metricLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#666666",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
  lineHeight: "1.3",
}

const metricValue: React.CSSProperties = {
  margin: "0",
  color: palette.brand,
  fontSize: "20px",
  fontWeight: 700,
  lineHeight: "1.15",
  letterSpacing: "-0.3px",
}

const metricValueCritical: React.CSSProperties = {
  ...metricValue,
  color: palette.danger,
}

const findingTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const findingCell: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "top",
}

const findingCellLast: React.CSSProperties = {
  padding: "12px 14px",
  verticalAlign: "top",
}

const findingHeadRow: React.CSSProperties = {
  margin: "0 0 6px 0",
  lineHeight: "1.4",
}

const findingLabel: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
}

const findingDescription: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#344054",
  fontSize: "13px",
  lineHeight: "1.5",
}

const findingMeta: React.CSSProperties = {
  margin: "0",
  fontSize: "12px",
  lineHeight: "1.5",
}

const findingProject: React.CSSProperties = {
  color: "#475467",
  fontWeight: 600,
}

const findingAmount: React.CSSProperties = {
  color: palette.danger,
  fontWeight: 700,
}

const metaDivider: React.CSSProperties = {
  color: "#98a2b3",
}

const moreNote: React.CSSProperties = {
  margin: "0",
  padding: "10px 14px",
  borderTop: "1px solid #eaecf0",
  backgroundColor: "#fcfcfd",
  color: "#475467",
  fontSize: "12px",
}

const groupTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const groupCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "middle",
}

const groupCellLast: React.CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
}

const groupNumberCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "middle",
  textAlign: "right",
  width: "84px",
}

const groupNumberCellLast: React.CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
  textAlign: "right",
  width: "84px",
}

const groupLabel: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 500,
}

const groupCount: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
}

const groupAmount: React.CSSProperties = {
  color: "#475467",
  fontSize: "13px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
}

const coverageCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #fedf89",
  backgroundColor: "#fffaeb",
  padding: "12px 14px",
}

const coverageTitle: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: palette.warning,
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const coverageText: React.CSSProperties = {
  margin: "0 0 4px 0",
  color: "#7a4708",
  fontSize: "12px",
  lineHeight: "1.5",
}

