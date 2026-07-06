"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Selection, SelectionCategory, SelectionOption } from "@/lib/types"
import { selectOptionAction } from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface SelectionsData {
  selections: Selection[]
  categories: SelectionCategory[]
  optionsByCategory: Record<string, SelectionOption[]>
}

interface Props {
  token: string
  data: SelectionsData
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function formatPriceLabel(option: SelectionOption): string | undefined {
  if (option.price_type === "included") return "Included"
  const cents = option.price_delta_cents ?? option.price_cents
  if (cents == null) return undefined
  const amount = formatMoney(Math.abs(cents))
  if (option.price_type === "upgrade") return `+${amount}`
  if (option.price_type === "downgrade") return `-${amount}`
  return amount
}

export function SelectionsPortalClient({ token, data }: Props) {
  const [selections, setSelections] = useState(data.selections)
  const [isPending, startTransition] = useTransition()

  const handleSelect = (selectionId: string, optionId: string) => {
    startTransition(async () => {
      try {
        await selectOptionAction({ token, selectionId, optionId })
        setSelections((prev) =>
          prev.map((s) =>
            s.id === selectionId
              ? {
                  ...s,
                  selected_option_id: optionId,
                  selected_option: data.optionsByCategory[s.category_id]?.find((option) => option.id === optionId) ?? null,
                  status: "selected",
                }
              : s,
          ),
        )
        toast.success("Selection saved")
      } catch (error) {
        console.error("Failed to submit selection", error)
        toast.error("Could not save your selection")
      }
    })
  }

  const categoriesById = Object.fromEntries(data.categories.map((c) => [c.id, c]))

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Selections</p>
          <h1 className="text-2xl font-bold">Make your choices</h1>
          <p className="text-sm text-muted-foreground">Pick the option you want for each category.</p>
        </header>

        {selections.length === 0 && (
          <Card>
            <CardContent className="p-6 text-muted-foreground text-center">No selections assigned yet.</CardContent>
          </Card>
        )}

        <div className="space-y-4">
          {selections.map((selection) => {
            const category = categoriesById[selection.category_id]
            const options = data.optionsByCategory[selection.category_id] ?? []
            return (
              <Card key={selection.id}>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{category?.name ?? "Selection"}</CardTitle>
                    {selection.due_date && (
                      <p className="text-xs text-muted-foreground">
                        Due {format(new Date(selection.due_date), "MMM d, yyyy")}
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className="capitalize text-[11px]">
                    {selection.status}
                  </Badge>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {options.length === 0 && (
                    <p className="text-sm text-muted-foreground col-span-2">No options available.</p>
                  )}
                  {options.map((opt) => {
                    const isSelected = selection.selected_option_id === opt.id
                    const priceLabel = formatPriceLabel(opt)

                    return (
                      <div
                        key={opt.id}
                        className="rounded-lg border bg-card/50 p-3 space-y-2 transition hover:border-primary/50"
                      >
                        {opt.image_url && (
                          <img
                            src={opt.image_url}
                            alt={opt.name}
                            className="h-36 w-full rounded-md border object-cover"
                          />
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <div className="space-y-1">
                            <p className="text-sm font-semibold">{opt.name}</p>
                            {opt.description && <p className="text-xs text-muted-foreground">{opt.description}</p>}
                          </div>
                          <Badge variant={isSelected ? "default" : "outline"} className="text-[11px]">
                            {isSelected ? "Selected" : opt.price_type ?? "option"}
                          </Badge>
                        </div>
                        {priceLabel && <p className="text-xs text-muted-foreground">{priceLabel}</p>}
                        <Button
                          size="sm"
                          className="w-full"
                          variant={isSelected ? "secondary" : "default"}
                          disabled={isPending}
                          onClick={() => handleSelect(selection.id, opt.id)}
                        >
                          {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
                          {isSelected ? "Selected" : "Choose this option"}
                        </Button>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}






