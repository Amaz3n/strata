export type NumberEvidence = {
  sheet_number: string | null
  confidence: string
  number_evidence: { text: string; location: string; is_title_block: boolean } | null
}
const normalize = (text: string) => text.trim().toUpperCase().replace(/\s+/g, "")
export function hasTitleBlockEvidence(result: NumberEvidence): boolean {
  const evidence = result.number_evidence
  return Boolean(result.sheet_number && result.confidence === "high" &&
    evidence?.is_title_block && evidence.location.trim() &&
    normalize(evidence.text) === normalize(result.sheet_number))
}
export function needsNumberVerification(result: NumberEvidence, textGuess: string): boolean {
  return !hasTitleBlockEvidence(result) || normalize(result.sheet_number ?? "") !== normalize(textGuess)
}
