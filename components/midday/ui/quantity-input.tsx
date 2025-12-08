"use client"

import { Input } from "@/components/ui/input"

type QuantityInputProps = React.ComponentProps<typeof Input>

export function QuantityInput(props: QuantityInputProps) {
  return <Input type="number" step="1" {...props} />
}



