"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"

import { Monitor, Moon, SunMedium, Type } from "lucide-react"

import {
  DEFAULT_UI_SIZE,
  UI_SIZE_CHANGE_EVENT,
  getStoredUiSize,
  setStoredUiSize,
  uiSizeOptions,
  type UiSize,
} from "@/components/personalization-provider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

const themeOptions = [
  { value: "light", label: "Light", icon: SunMedium },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [uiSize, setUiSize] = useState<UiSize>(DEFAULT_UI_SIZE)

  useEffect(() => {
    setMounted(true)
    setUiSize(getStoredUiSize())

    const handleUiSizeChange = (event: Event) => {
      setUiSize((event as CustomEvent<UiSize>).detail)
    }

    window.addEventListener(UI_SIZE_CHANGE_EVENT, handleUiSizeChange)
    return () => window.removeEventListener(UI_SIZE_CHANGE_EVENT, handleUiSizeChange)
  }, [])

  const currentTheme = mounted ? theme ?? "system" : "system"

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
        <div className="border-b border-border/70 px-4 py-4 lg:px-5">
          <h2 className="text-sm font-medium text-foreground">Theme</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Choose the color mode Arc uses across your workspace.
          </p>
        </div>
        <div className="px-4 py-4 lg:px-5">
          <ToggleGroup
            type="single"
            variant="outline"
            value={currentTheme}
            onValueChange={(value) => {
              if (value) setTheme(value)
            }}
            className="grid w-full grid-cols-3 sm:max-w-xl"
            aria-label="Theme"
          >
            {themeOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} className="h-11 gap-2 px-3">
                <option.icon className="h-4 w-4" />
                <span>{option.label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </section>

      <section className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
        <div className="border-b border-border/70 px-4 py-4 lg:px-5">
          <h2 className="text-sm font-medium text-foreground">Font and UI size</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Adjust text, controls, and spacing for the way you scan project work.
          </p>
        </div>
        <div className="px-4 py-4 lg:px-5">
          <ToggleGroup
            type="single"
            variant="outline"
            value={uiSize}
            onValueChange={(value) => {
              if (value) {
                const nextSize = value as UiSize
                setUiSize(nextSize)
                setStoredUiSize(nextSize)
              }
            }}
            className="grid w-full grid-cols-1 sm:grid-cols-3"
            aria-label="Font and UI size"
          >
            {uiSizeOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value} className="h-auto min-h-20 flex-col items-start justify-center gap-1 px-4 py-3 text-left">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Type className={cn("h-4 w-4", option.value === "compact" && "h-3.5 w-3.5", option.value === "comfortable" && "h-5 w-5")} />
                  {option.label}
                </span>
                <span className="text-xs font-normal leading-5 text-muted-foreground">{option.description}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </section>
    </div>
  )
}
