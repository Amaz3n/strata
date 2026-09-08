import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildDecisionRegister, type DecisionEvidence } from "./lib/accounting-d2-decisions"

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) throw new Error("Usage: accounting-d2-decision-register <captured-evidence.json> <new-output.json>")
const evidence: DecisionEvidence = JSON.parse(readFileSync(resolve(inputPath), "utf8"))
const register = buildDecisionRegister(evidence)
writeFileSync(resolve(outputPath), `${JSON.stringify(register, null, 2)}\n`, { flag: "wx", mode: 0o600 })
process.stdout.write(`Prepared ${register.unresolvedCount} unresolved decisions; no production writes.\n`)
