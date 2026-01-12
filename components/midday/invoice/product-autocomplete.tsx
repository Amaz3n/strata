"use client"

type Props = {
  index: number
  value: string
  onChange: (value: string) => void
  onProductSelect?: (product: any) => void
  disabled?: boolean
}

// Simplified autocomplete: plain input, no product catalog
export function ProductAutocomplete({ value, onChange, disabled = false }: Props) {
  return (
    <div className="relative">
      <input
        type="text"
        className="w-full border-none bg-transparent text-primary placeholder:text-[#878787] text-[13px] outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Item name"
        disabled={disabled}
      />
    </div>
  )
}









