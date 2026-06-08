import type { Metadata } from "next"
import { HelpHome } from "@/components/help/help-home"
import { HelpShell } from "@/components/help/help-shell"
import { getHelpNavigation, getHelpSearchItems } from "@/lib/help/catalog"

export const metadata: Metadata = {
  title: "Help Center | Arc",
  description: "Find guides and answers for using Arc.",
}

export default function HelpPage() {
  const navigation = getHelpNavigation()
  const searchItems = getHelpSearchItems()

  return (
    <HelpShell navigation={navigation} searchItems={searchItems}>
      <HelpHome topics={navigation} searchItems={searchItems} />
    </HelpShell>
  )
}
