import "server-only"
import { unstable_rethrow } from "next/navigation"
import { actionError, type ActionResult } from "@/lib/action-result"

import { requireOrgMembership } from "@/lib/auth/context"
import { requireOrgContext } from "@/lib/services/context"
import { getCurrentUserProfile } from "@/lib/services/users"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getStripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { getComplianceRules, getDefaultComplianceRequirements } from "@/lib/services/compliance"
import { listComplianceDocumentTypes } from "@/lib/services/compliance-documents"
import { getPrequalificationTemplate } from "@/lib/services/prequalification"
import { getDocumentNumbering } from "@/lib/services/document-numbering"
import { getPaymentRailSettings } from "@/lib/services/payment-rail-setup"
import { getBooksModuleSettings, isBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { listOrganizationSigners } from "@/lib/services/team"
import {
  getBillingPageDataAction,
  getOrganizationSettingsAction,
  getTeamSettingsDataAction,
  getNotificationPreferencesAction,
  listContractTemplatesAction,
  type ContractTemplateSummary,
} from "@/app/(app)/settings/actions"
import { canViewSettingsItem, settingsSections, type SettingsTab } from "@/lib/settings/sections"

async function loadContractTemplates(): Promise<ActionResult<ContractTemplateSummary[]>> {
  try {
    return { success: true, data: await listContractTemplatesAction() }
  } catch (error) {
    unstable_rethrow(error)
    return actionError(error, "Unable to load contract templates")
  }
}

/** One section per request. Identity caching remains request-scoped; never cache authorization across users. */
export async function loadSettingsPanel(tab: SettingsTab, expectedOrgId: string) {
  const { orgId, membership } = await requireOrgMembership()
  if (orgId !== expectedOrgId) throw new Error("Organization changed. Reload settings to continue.")
  const { permissions } = await getCurrentUserPermissions(orgId)
  const item = settingsSections
    .flatMap((section) => section.items)
    .find((entry) => entry.url === `/settings?tab=${tab}`)
  if (!item || !canViewSettingsItem(item, permissions))
    throw new Error("You don't have access to this settings section.")
  const can = (key: string) =>
    permissions.includes(key) || permissions.includes("org.admin") || permissions.includes("*")
  if (tab !== "profile" && tab !== "billing") await requireOrgContext(orgId)

  switch (tab) {
    case "profile":
      return {
        tab,
        user: await getCurrentUserProfile(),
        roleLabel: (membership.role_key ?? "")
          .replace(/^org_/, "")
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
      }
    case "organization": {
      const [settings, numbering, signers, contractTemplates] = await Promise.all([
        getOrganizationSettingsAction(),
        getDocumentNumbering(),
        listOrganizationSigners(),
        can("billing.manage") ? loadContractTemplates() : Promise.resolve({ success: true as const, data: [] }),
      ])
      return { tab, settings, numbering, signers, contractTemplates }
    }
    case "invoicing":
      return { tab, settings: await getOrganizationSettingsAction() }
    case "billing":
      return {
        tab,
        canManage: can("billing.manage"),
        billing: can("billing.manage") ? (await getBillingPageDataAction()).billing : null,
      }
    case "accounting":
      return {
        tab,
        canManage: can("org.admin"),
        settings: await getBooksModuleSettings({ includeConnections: can("org.admin") }),
      }
    case "payments":
      return { tab, settings: await getPaymentRailSettings() }
    case "integrations": {
      const [stripe, booksEnabled] = await Promise.all([getStripeConnectedAccount(), isBooksWorkspaceEnabled(orgId)])
      return { tab, stripe, booksEnabled }
    }
    case "team":
      return {
        tab,
        team: await getTeamSettingsDataAction(),
        canManageBilling: can("billing.manage"),
      }
    case "compliance": {
      const [rules, requirements, documentTypes, prequalification] = await Promise.all([
        getComplianceRules(),
        getDefaultComplianceRequirements(),
        listComplianceDocumentTypes(),
        getPrequalificationTemplate(),
      ])
      return {
        tab,
        rules,
        requirements,
        documentTypes,
        prequalification,
        canManage: can("billing.manage"),
      }
    }
    case "notifications":
      return { tab, preferences: await getNotificationPreferencesAction() }
    case "external-access":
      return { tab }
  }
}

export type SettingsPanelData = Awaited<ReturnType<typeof loadSettingsPanel>>
