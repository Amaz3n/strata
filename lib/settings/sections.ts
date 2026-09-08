import {
  Bell,
  Building2,
  ClipboardCheck,
  CreditCard,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Layers,
  Link2,
  Receipt,
  Ruler,
  ShieldCheck,
  Tag,
  User as UserIcon,
  Users,
  Wallet,
} from "@/components/icons"
import type { ProductTier } from "@/lib/product-tier"
import type { LucideIcon } from "@/components/icons"

export interface SettingsItem {
  title: string
  url: string
  icon: LucideIcon
  requiredAny?: string[]
  productTiers?: readonly ProductTier[]
}
export interface SettingsSection {
  label: string
  items: SettingsItem[]
}

export const settingsSections: SettingsSection[] = [
  {
    label: "You",
    items: [
      { title: "Profile", url: "/settings?tab=profile", icon: UserIcon },
      { title: "Notifications", url: "/settings?tab=notifications", icon: Bell },
    ],
  },
  {
    label: "Organization",
    items: [
      { title: "Organization", url: "/settings?tab=organization", icon: Building2 },
      { title: "Team", url: "/settings?tab=team", icon: Users },
      {
        title: "External access",
        url: "/settings?tab=external-access",
        icon: KeyRound,
        requiredAny: ["project.manage"],
      },
      { title: "Divisions", url: "/settings/divisions", icon: Layers, productTiers: ["production"] },
      { title: "Billing", url: "/settings?tab=billing", icon: CreditCard },
    ],
  },
  {
    label: "Financial",
    items: [
      { title: "Invoicing", url: "/settings?tab=invoicing", icon: Receipt },
      { title: "Accounting", url: "/settings?tab=accounting", icon: FileSpreadsheet },
      { title: "Cost coding", url: "/settings/cost-coding", icon: Tag },
      { title: "Vendor compliance", url: "/settings?tab=compliance", icon: ShieldCheck },
      {
        title: "Vendor payments",
        url: "/settings?tab=payments",
        icon: Wallet,
        requiredAny: ["payment.release"],
      },
      {
        title: "Payment reconciliation",
        url: "/payables/reconciliation",
        icon: FileSpreadsheet,
        requiredAny: ["payment.reconcile"],
      },
      { title: "Integrations", url: "/settings?tab=integrations", icon: Link2 },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Templates", url: "/settings/templates", icon: FileText },
      { title: "Takeoff", url: "/settings/takeoff", icon: Ruler, requiredAny: ["takeoff.read"] },
      {
        title: "Warranty",
        url: "/settings/warranty",
        icon: ClipboardCheck,
        requiredAny: ["warranty.manage"],
      },
      {
        title: "Data imports",
        url: "/settings/imports",
        icon: FileSpreadsheet,
        requiredAny: ["import.manage"],
      },
    ],
  },
]

export const SETTINGS_TABS = [
  "profile",
  "organization",
  "invoicing",
  "billing",
  "accounting",
  "payments",
  "notifications",
  "integrations",
  "team",
  "compliance",
  "external-access",
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && SETTINGS_TABS.some((tab) => tab === value)
}
export function settingsHref(tab: SettingsTab, returnTo?: string | null) {
  const params = new URLSearchParams({ tab })
  if (returnTo) params.set("returnTo", returnTo)
  return `/settings?${params}`
}
export function canViewSettingsItem(item: SettingsItem, permissions: readonly string[]) {
  return (
    !item.requiredAny?.length ||
    permissions.includes("*") ||
    permissions.includes("org.admin") ||
    item.requiredAny.some((key) => permissions.includes(key))
  )
}
export function visibleSettingsSections(permissions: readonly string[], productTier: ProductTier) {
  return settingsSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        canViewSettingsItem(item, permissions) && (!item.productTiers || item.productTiers.includes(productTier)),
      ),
    }))
    .filter((section) => section.items.length > 0)
}
