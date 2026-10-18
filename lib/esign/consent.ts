/** Shared by presentation and acceptance; clients cannot choose the recorded wording. */
export const ESIGN_CONSENT_VERSION = "esign-consent-2026-05-24"
export const ELECTRONIC_SIGNATURE_CONSENT_TEXT =
  "I agree to use electronic records and signatures for this document, I can access and retain the document electronically, and I intend my electronic signature to be legally binding."

export function assertElectronicSignatureConsent(text: unknown): void {
  if (text !== ELECTRONIC_SIGNATURE_CONSENT_TEXT) {
    throw new Error("Please review and accept the current electronic signature consent.")
  }
}
