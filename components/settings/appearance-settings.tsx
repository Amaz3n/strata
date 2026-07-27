"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"

import { Monitor, Moon, SunMedium } from "@/components/icons"
import {
  DEFAULT_UI_SIZE,
  UI_SIZE_CHANGE_EVENT,
  getStoredUiSize,
  setStoredUiSize,
  uiSizeOptions,
  type UiSize,
} from "@/components/personalization-provider"
import { SettingsField, SettingsGroup } from "@/components/settings/settings-section"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const themeOptions = [
  { value: "light", label: "Light", icon: SunMedium },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

const segmentedClass = "grid w-full max-w-sm grid-cols-3"
const segmentedItemClass = "h-9 gap-2 px-2 text-sm"

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

  // Both preferences live in the browser, so nothing is settled until mount.
  // Selecting nothing for one frame beats selecting the wrong thing.
  const activeTheme = mounted ? theme ?? "system" : ""
  const activeSize = mounted ? uiSize : ""
  const activeSizeDescription = uiSizeOptions.find((option) => option.value === uiSize)?.description

  return (
    <SettingsGroup
      title="Appearance"
      action={<span className="text-xs text-muted-foreground">Saved to this browser</span>}
    >
      <SettingsField label="Theme" hint="Light, dark, or whatever your system is set to.">
        <ToggleGroup
          type="single"
          variant="outline"
          value={activeTheme}
          onValueChange={(value) => {
            if (value) setTheme(value)
          }}
          className={segmentedClass}
          aria-label="Theme"
        >
          {themeOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value} className={segmentedItemClass}>
              <option.icon className="size-4 shrink-0" />
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingsField>

      <SettingsField label="Interface size" hint="Scales text, controls, and spacing across Arc.">
        <div className="space-y-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={activeSize}
            onValueChange={(value) => {
              if (!value) return
              const nextSize = value as UiSize
              setUiSize(nextSize)
              setStoredUiSize(nextSize)
            }}
            className={segmentedClass}
            aria-label="Interface size"
          >
            {uiSizeOptions.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                className={segmentedItemClass}
                title={option.description}
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="min-h-5 text-xs leading-5 text-muted-foreground">
            {mounted ? activeSizeDescription : null}
          </p>
        </div>
      </SettingsField>
    </SettingsGroup>
  )
}
