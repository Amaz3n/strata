import { normalizeKey, parseCents, parseCsv, parseDate } from "@/lib/services/import-parsers"

export type ParsedBankStatementRow = {
  sourceId: string | null
  date: string
  description: string
  merchantName: string | null
  amountCents: number
}

type PositiveDirection = "inflow" | "outflow"

const DATE_HEADERS = ["date", "posted date", "posting date", "transaction date"]
const DESCRIPTION_HEADERS = ["description", "memo", "name", "payee", "merchant"]
const ID_HEADERS = ["id", "fitid", "transaction id", "reference"]
const AMOUNT_HEADERS = ["amount", "transaction amount"]
const DEBIT_HEADERS = ["debit", "withdrawal", "withdrawals", "money out"]
const CREDIT_HEADERS = ["credit", "deposit", "deposits", "money in"]

function firstValue(row: Record<string, string>, aliases: string[]) {
  const entry = Object.entries(row).find(([key]) => aliases.includes(normalizeKey(key)))
  return entry?.[1]?.trim() ?? ""
}

function normalizeDelimited(text: string) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ""
  if (!firstLine.includes("\t") || firstLine.includes(",")) return text
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t").map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\n")
}

function parseDelimitedStatement(text: string, positiveDirection: PositiveDirection) {
  const { headers, rows } = parseCsv(normalizeDelimited(text))
  const normalizedHeaders = headers.map(normalizeKey)
  if (!DATE_HEADERS.some((header) => normalizedHeaders.includes(header))) {
    throw new Error("Statement needs a Date or Posted Date column")
  }
  if (!DESCRIPTION_HEADERS.some((header) => normalizedHeaders.includes(header))) {
    throw new Error("Statement needs a Description, Memo, Payee, or Merchant column")
  }
  const hasAmount = AMOUNT_HEADERS.some((header) => normalizedHeaders.includes(header))
  const hasDebitCredit = DEBIT_HEADERS.some((header) => normalizedHeaders.includes(header)) || CREDIT_HEADERS.some((header) => normalizedHeaders.includes(header))
  if (!hasAmount && !hasDebitCredit) {
    throw new Error("Statement needs an Amount column or Debit/Credit columns")
  }

  return rows.map((row, index): ParsedBankStatementRow => {
    const date = parseDate(firstValue(row, DATE_HEADERS))
    if (!date) throw new Error(`Row ${index + 2} has an unreadable date`)
    const description = firstValue(row, DESCRIPTION_HEADERS)
    if (!description) throw new Error(`Row ${index + 2} has no description`)

    const amount = parseCents(firstValue(row, AMOUNT_HEADERS))
    const debit = parseCents(firstValue(row, DEBIT_HEADERS))
    const credit = parseCents(firstValue(row, CREDIT_HEADERS))
    let amountCents: number
    if (hasAmount) {
      if (amount === null || amount === 0) throw new Error(`Row ${index + 2} has an unreadable or zero amount`)
      amountCents = positiveDirection === "inflow" ? amount : -amount
    } else {
      const debitMagnitude = Math.abs(debit ?? 0)
      const creditMagnitude = Math.abs(credit ?? 0)
      if ((debitMagnitude === 0) === (creditMagnitude === 0)) {
        throw new Error(`Row ${index + 2} must have exactly one debit or credit amount`)
      }
      amountCents = creditMagnitude > 0 ? creditMagnitude : -debitMagnitude
    }
    return {
      sourceId: firstValue(row, ID_HEADERS) || null,
      date,
      description,
      merchantName: firstValue(row, ["merchant", "payee", "name"]) || null,
      amountCents,
    }
  })
}

function ofxField(block: string, name: string) {
  const match = new RegExp(`<${name}>([^<\\r\\n]+)`, "i").exec(block)
  return match?.[1]?.trim() ?? ""
}

function parseOfxStatement(text: string) {
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>|<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>)/gi) ?? []
  if (blocks.length === 0) throw new Error("No transactions were found in the OFX/QFX statement")
  return blocks.map((block, index): ParsedBankStatementRow => {
    const rawDate = ofxField(block, "DTPOSTED").slice(0, 8)
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate)
    const amountCents = parseCents(ofxField(block, "TRNAMT"))
    const description = ofxField(block, "NAME") || ofxField(block, "MEMO")
    if (!date) throw new Error(`OFX transaction ${index + 1} has an unreadable posted date`)
    if (amountCents === null || amountCents === 0) throw new Error(`OFX transaction ${index + 1} has an unreadable or zero amount`)
    if (!description) throw new Error(`OFX transaction ${index + 1} has no description`)
    return {
      sourceId: ofxField(block, "FITID") || null,
      date: `${date[1]}-${date[2]}-${date[3]}`,
      description,
      merchantName: ofxField(block, "NAME") || null,
      amountCents,
    }
  })
}

export function parseBankStatement(
  text: string,
  positiveDirection: PositiveDirection = "inflow",
): ParsedBankStatementRow[] {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Statement file is empty")
  const rows = /<(OFX|STMTTRN)>/i.test(trimmed)
    ? parseOfxStatement(trimmed)
    : parseDelimitedStatement(trimmed, positiveDirection)
  if (rows.length > 5_000) throw new Error("Import at most 5,000 transactions at a time")
  return rows
}
