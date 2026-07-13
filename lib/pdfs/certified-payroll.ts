import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CertifiedPayrollDetail, CertifiedPayrollLine } from "@/lib/services/certified-payroll"

const ink = rgb(0.08, 0.09, 0.11)
const muted = rgb(0.35, 0.37, 0.41)
const rule = rgb(0.78, 0.79, 0.81)

function money(cents: number | null | undefined) {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`
}

function text(page: PDFPage, font: PDFFont, value: string, x: number, y: number, size = 8, color = ink) {
  page.drawText(value.slice(0, 70), { x, y, size, font, color })
}

function line(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: rule })
}

function totalHours(lineItem: CertifiedPayrollLine) {
  return Object.values(lineItem.day_hours).reduce((sum, day) => sum + day.st + day.ot + day.dt, 0)
}

export async function renderCertifiedPayrollPdf({
  report,
  projectName,
  contractorName,
  contractorAddress,
}: {
  report: CertifiedPayrollDetail
  projectName: string
  contractorName: string
  contractorAddress: string | null
}) {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const page = pdf.addPage([792, 612])
  text(page, bold, "CERTIFIED PAYROLL REPORT (WH-347 FORMAT)", 36, 574, 14)
  text(page, regular, `${contractorName}${contractorAddress ? ` · ${contractorAddress}` : ""}`, 36, 556, 8, muted)
  text(page, bold, projectName, 36, 536, 10)
  text(page, regular, `Payroll #${report.payroll_number} · Week ending ${report.week_ending}${report.is_no_work ? " · NO WORK" : ""}${report.is_final ? " · FINAL" : ""}`, 36, 521, 9)

  const columns = [36, 145, 240, 390, 448, 506, 572, 648, 756]
  const headers = ["Worker", "Classification", "Daily hours (ST / OT / DT)", "ST rate", "OT rate", "Fringe", "Gross", "Deductions / Net"]
  let y = 492
  line(page, columns[0], y + 16, columns[8], y + 16)
  headers.forEach((header, index) => text(page, bold, header, columns[index] + 3, y + 4, 6.5))
  line(page, columns[0], y, columns[8], y)
  for (const x of columns) line(page, x, y + 16, x, 70)

  if (report.is_no_work) {
    text(page, bold, "No work was performed on this project during the reporting week.", 44, y - 28, 10)
  } else {
    for (const payrollLine of report.lines) {
      const rowHeight = 48
      if (y - rowHeight < 70) break
      const daySummary = Object.entries(payrollLine.day_hours)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, hours]) => `${date.slice(5)} ${hours.st}/${hours.ot}/${hours.dt}`)
        .join("  ")
      const deductions = Object.values(payrollLine.deductions ?? {}).reduce((sum, value) => sum + Number(value), 0)
      text(page, bold, payrollLine.worker.display_name, columns[0] + 3, y - 14, 7)
      text(page, regular, payrollLine.worker.tax_id_last4 ? `ID xxx-xx-${payrollLine.worker.tax_id_last4}` : "ID not provided", columns[0] + 3, y - 27, 6, muted)
      text(page, regular, payrollLine.classification?.classification ?? "Unclassified", columns[1] + 3, y - 14, 6.5)
      text(page, regular, daySummary || "—", columns[2] + 3, y - 14, 5.5)
      text(page, regular, money(payrollLine.st_rate_cents), columns[3] + 3, y - 14, 6.5)
      text(page, regular, money(payrollLine.ot_rate_cents), columns[4] + 3, y - 14, 6.5)
      text(page, regular, `${money(payrollLine.fringe_rate_cents)}/hr`, columns[5] + 3, y - 14, 6.5)
      text(page, bold, money(payrollLine.gross_this_project_cents), columns[6] + 3, y - 14, 6.5)
      text(page, regular, `Ded. ${money(deductions)}`, columns[7] + 3, y - 13, 6)
      text(page, regular, `Net ${payrollLine.net_pay_cents == null ? "See attached payroll register" : money(payrollLine.net_pay_cents)}`, columns[7] + 3, y - 27, 5.5)
      text(page, regular, `${totalHours(payrollLine).toFixed(2)} total hours`, columns[2] + 3, y - 28, 6, muted)
      y -= rowHeight
      line(page, columns[0], y, columns[8], y)
    }
  }
  text(page, regular, "Arc records hours, wage classifications, deductions entered by the contractor, and the certified statement. It does not calculate taxes or transmit payroll.", 36, 42, 6.5, muted)

  const statement = pdf.addPage([612, 792])
  text(statement, bold, "STATEMENT OF COMPLIANCE", 48, 744, 15)
  text(statement, regular, `Certified payroll #${report.payroll_number} · Week ending ${report.week_ending}`, 48, 724, 9, muted)
  const paragraphs = [
    `I certify that the payroll identified above is correct and complete; that the wage rates shown are not less than the applicable prevailing rates for the classifications of work performed; and that each worker has been paid the amounts shown, subject to the deductions recorded or an attached payroll register.`,
    `I further certify that fringe-benefit obligations have been satisfied through approved plans, funds, or programs, through cash paid in lieu of benefits, or through a permitted combination of both methods, as indicated below.`,
  ]
  let statementY = 680
  for (const paragraph of paragraphs) {
    const words = paragraph.split(" ")
    let current = ""
    for (const word of words) {
      if (regular.widthOfTextAtSize(`${current} ${word}`, 9) > 510) {
        text(statement, regular, current, 48, statementY, 9)
        statementY -= 14
        current = word
      } else current = current ? `${current} ${word}` : word
    }
    text(statement, regular, current, 48, statementY, 9)
    statementY -= 34
  }
  const cashWorkers = report.lines.filter((item) => item.worker.fringe_paid_in_cash).map((item) => item.worker.display_name)
  const planWorkers = report.lines.filter((item) => !item.worker.fringe_paid_in_cash).map((item) => item.worker.display_name)
  text(statement, bold, "Fringe benefit method", 48, statementY, 10)
  statementY -= 24
  text(statement, regular, `[ ] 4(a) Approved plans, funds, or programs: ${planWorkers.join(", ") || "None"}`, 58, statementY, 9)
  statementY -= 22
  text(statement, regular, `[ ] 4(b) Cash paid in lieu of benefits: ${cashWorkers.join(", ") || "None"}`, 58, statementY, 9)
  statementY -= 55
  line(statement, 48, statementY, 285, statementY)
  line(statement, 325, statementY, 564, statementY)
  text(statement, regular, "Authorized signature", 48, statementY - 14, 8, muted)
  text(statement, regular, "Date", 325, statementY - 14, 8, muted)
  statementY -= 70
  line(statement, 48, statementY, 285, statementY)
  line(statement, 325, statementY, 564, statementY)
  text(statement, regular, "Printed name and title", 48, statementY - 14, 8, muted)
  text(statement, regular, "Contractor", 325, statementY - 14, 8, muted)
  text(statement, regular, "This Arc-generated report follows WH-347 information conventions in an original layout and is not a U.S. Department of Labor form.", 48, 42, 7, muted)

  return Buffer.from(await pdf.save())
}
