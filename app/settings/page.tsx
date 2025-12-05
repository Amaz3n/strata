import { AppShell } from "@/components/layout/app-shell"
import { SettingsWindow } from "@/components/settings/settings-window"
import { getCurrentUserAction } from "../actions/user"

export default async function SettingsPage() {
  const currentUser = await getCurrentUserAction()

  return (
    <AppShell title="Settings" user={currentUser}>
      <div className="p-4 lg:p-6">
        <SettingsWindow user={currentUser} />
      </div>
    </AppShell>
  )
}
