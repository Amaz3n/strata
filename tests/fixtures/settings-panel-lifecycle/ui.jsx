import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { AccountingSettingsPanel } from "@/components/settings/accounting-settings-panel"
import { TeamSettingsPanel } from "@/components/settings/team-settings-panel"
import { DocumentNumberingForm } from "@/components/settings/document-numbering-form"
import { OrganizationPanel } from "@/components/settings/organization-panel"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { WarrantySettingsClient } from "@/app/(app)/settings/warranty/warranty-settings-client"
import { ContractTemplateSettings } from "@/components/settings/contract-template-settings"
const kind = new URLSearchParams(window.location.search).get("kind")
const accounting = { enabled: false, canDisable: true, settings: { ledger_authority: "external" }, connections: [] }
const team = { teamMembers: [{ id: "one", name: "Original member" }], hasMore: true, roleOptions: [], permissionOptions: [], rolePermissions: {}, divisions: [], currentUserId: "actor", canManageMembers: true, canEditRoles: true, locked: false }
const numbering = { rfi: { prefix: "RFI-", pad: 3 }, submittal: { prefix: "SUB-", pad: 2 } }
const organization = { id: "organization", name: "Fixture organization", canManageOrganization: true, logoUrl: null, estimateBuilderSignerMode: "estimate_creator", estimateBuilderSignerUserId: "", estimateFont: "", estimateAccentColor: "", estimateIntroTemplate: "", proposalTermsTemplate: "", estimateTermsTemplate: "" }
const notifications = { email_enabled: true, weekly_snapshot_enabled: true, email_type_settings: { task_mentioned: false } }
const warrantyPrograms = [{ id: "00000000-0000-4000-8000-000000000001", name: "Original coverage", description: "Fixture coverage", is_default: true, is_active: true, enrolled_count: 5, terms: [{ key: "workmanship", label: "Workmanship", duration_months: 12, is_structural: false, description: null }] }]
const warrantyTargets = ["emergency", "routine_30", "routine_60"].map(severity => ({ severity, first_response_hours: 24, resolution_days: 7 }))
const contractTemplates = { success: true, data: [{ id: "estimate-template", template_for: "estimate", file_name: "original-estimate.pdf", size_bytes: 1024, updated_at: "2026-10-04" }] }
function Fixture() {
  const [mounted, setMounted] = useState(true)
  const [props, setProps] = useState(kind === "contracts" ? { initialTemplates: contractTemplates, canManage: true } : kind === "warranty" ? { programs: warrantyPrograms, targets: warrantyTargets, posture: "production" } : kind === "notifications" ? { initialPreferences: notifications } : kind === "organization" ? { initialSettings: organization, initialDocumentNumbering: numbering, initialContractTemplates: contractTemplates } : kind === "numbering" ? { initial: numbering } : kind === "team" ? { initialData: team } : { initialSettings: accounting, canManage: true })
  useEffect(() => { window.settingsFixture = { accounting, team, numbering, organization, notifications, warrantyPrograms, warrantyTargets, contractTemplates, refresh: patch => setProps(current => ({ ...current, ...patch })), unmount: () => setMounted(false) } }, [])
  useEffect(() => { window.settingsObservedCanManage = props.canManage }, [props.canManage])
  if (!mounted) return <p>Panel removed</p>
  if (kind === "numbering") return <DocumentNumberingForm {...props} onSaved={next => (window.numberingSaved ??= []).push(next)} />
  if (kind === "organization") return <OrganizationPanel {...props} teamMembers={[]} onSettingsSaved={() => {}} />
  if (kind === "notifications") return <NotificationPreferences {...props} />
  if (kind === "warranty") return <WarrantySettingsClient {...props} />
  if (kind === "contracts") return <ContractTemplateSettings {...props} />
  return kind === "team" ? <TeamSettingsPanel {...props} canManageBilling={false} onGoToBilling={() => {}} /> : <AccountingSettingsPanel {...props} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
