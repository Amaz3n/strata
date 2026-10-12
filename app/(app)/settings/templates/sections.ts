export const TEMPLATE_SECTIONS = [
  {
    key: "waivers",
    label: "Waivers",
    description: "Company documents that are ready for every project.",
  },
  {
    key: "agreements",
    label: "Agreements",
    description:
      "Your purchase agreement and addenda, as your counsel wrote them. Each version is immutable once live, and where it applies decides which homes are sold on it.",
  },
  {
    key: "estimates",
    label: "Estimates",
    description:
      "Reusable sections and line items to start a new estimate from. Terms, cover note, and branding live in Organization.",
  },
  {
    key: "budgets",
    label: "Budgets",
    description:
      "Reusable budget lines with fixed amounts or quantity-based costs.",
  },
  {
    key: "schedules",
    label: "Schedules",
    description:
      "Reusable activities with calendar-day start offsets and durations.",
  },
  {
    key: "checklists",
    label: "Checklists",
    description:
      "Safety and quality checklists used to run inspections. Running inspections snapshot their items, so edits never change past inspections.",
  },
] as const;


export function resolveTemplateSection(value?: string | null) {
  return TEMPLATE_SECTIONS.find(section => section.key === value)?.key ?? "waivers"
}
