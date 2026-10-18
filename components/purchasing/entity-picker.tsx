"use client"

import { searchPurchasingEntitiesAction } from "@/app/(app)/purchasing/actions"
import { SearchPicker, type SearchPickerItem } from "@/components/ui/search-picker"

export type PurchasingEntity = SearchPickerItem

export function PurchasingEntityPicker({ kind, value, onChange, disabled = false }: {
  kind: "home" | "vendor" | "community" | "plan"
  value: PurchasingEntity | null
  onChange: (value: PurchasingEntity | null) => void
  disabled?: boolean
}) {
  const label = { home: "Home", vendor: "Vendor", community: "Community", plan: "Plan" }[kind]
  return <SearchPicker label={label} value={value} onChange={onChange} disabled={disabled} search={(query) => searchPurchasingEntitiesAction({ kind, ...query })} />
}
