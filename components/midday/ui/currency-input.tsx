"use client"

import { Input } from "@/components/ui/input"

type CurrencyInputProps = React.ComponentProps<typeof Input>

export function CurrencyInput(props: CurrencyInputProps) {
  return <Input type="text" inputMode="decimal" {...props} />
}



