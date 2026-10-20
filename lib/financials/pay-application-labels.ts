/**
 * The wording on a pay application that changes with who is billed and what the
 * work is called. The G702 PDF and the on-screen document are twin renderers;
 * both read their labels here so a builder's "Owner" and "Project" and a
 * trade's "Customer" and "Job" cannot drift between them.
 */
export interface PayApplicationLabelInput {
  /** Who the application is addressed to; absent on snapshots from before it was recorded. */
  customerLabel?: string
  projectLabel?: string
}

export function payApplicationLabels(input: PayApplicationLabelInput) {
  const customer = input.customerLabel ?? "Owner"
  return {
    customer,
    project: input.projectLabel ?? "Project",
    to: `To (${customer})`,
    signatureLine: `${customer} / Architect — signature / date`,
    certificateTitle: `${customer}'s / Architect's Certificate for Payment`,
  }
}
