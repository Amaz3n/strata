"use client"

import { useState } from "react"
import { JaguarDither, DEFAULT_CONFIG, type JaguarDitherConfig } from "@/components/animation/jaguar-dither"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"

type BgMode = "dark" | "light" | "black"

const BG: Record<BgMode, { canvas: string; page: string }> = {
  dark: { canvas: "transparent", page: "#0b0e1a" },
  light: { canvas: "transparent", page: "#f4f6fb" },
  black: { canvas: "transparent", page: "#000000" },
}

export default function DitherLabPage() {
  const [config, setConfig] = useState<JaguarDitherConfig>(DEFAULT_CONFIG)
  const [bg, setBg] = useState<BgMode>("dark")
  const [restartSignal, setRestartSignal] = useState(0)
  const [panelOpen, setPanelOpen] = useState(true)
  const [copied, setCopied] = useState(false)

  const set = <K extends keyof JaguarDitherConfig>(key: K, value: JaguarDitherConfig[K]) =>
    setConfig((c) => ({ ...c, [key]: value }))

  const copyConfig = async () => {
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: BG[bg].page }}>
      <JaguarDither
        config={{ ...config, background: BG[bg].canvas }}
        restartSignal={restartSignal}
        className="absolute inset-0"
      />

      {/* Toggle button (always visible) */}
      <button
        type="button"
        onClick={() => setPanelOpen((o) => !o)}
        className="absolute right-4 top-4 z-20 rounded-none border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-xs text-white/80 backdrop-blur transition hover:bg-black/70"
      >
        {panelOpen ? "hide controls" : "controls"}
      </button>

      {panelOpen && (
        <Card className="absolute right-4 top-14 z-10 max-h-[calc(100vh-5rem)] w-80 overflow-y-auto rounded-none border-white/10 bg-black/70 p-4 text-white backdrop-blur-md">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-xs uppercase tracking-widest text-white/50">dither lab</span>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-none px-2 text-xs"
                onClick={() => setRestartSignal((s) => s + 1)}
              >
                ↻ replay
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-none px-2 text-xs"
                onClick={() => set("paused", !config.paused)}
              >
                {config.paused ? "▶" : "❚❚"}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            <ToggleRow label="Loop" value={config.loop} onChange={(v) => set("loop", v)} />
            <ToggleRow label="Logo intro" value={config.showLogoIntro} onChange={(v) => set("showLogoIntro", v)} />
            <ToggleRow label="Running" value={config.running} onChange={(v) => set("running", v)} />

            <div className="h-px bg-white/10" />

            <SliderRow label="Speed" value={config.timeScale} min={0.25} max={2.5} step={0.05} suffix="×" onChange={(v) => set("timeScale", v)} />
            <SliderRow label="Jaguar size" value={config.jaguarScale} min={0.3} max={0.95} step={0.01} onChange={(v) => set("jaguarScale", v)} />
            <SliderRow label="Dot gap" value={config.dotGap} min={8} max={30} step={1} suffix="px" onChange={(v) => set("dotGap", v)} />
            <SliderRow label="Dot radius" value={config.dotRadius} min={0.2} max={0.6} step={0.02} onChange={(v) => set("dotRadius", v)} />

            <div className="h-px bg-white/10" />
            <span className="block font-mono text-[10px] uppercase tracking-widest text-white/40">gait</span>

            <SliderRow label="Stride period" value={config.runPeriod} min={300} max={1200} step={20} suffix="ms" onChange={(v) => set("runPeriod", v)} />
            <SliderRow label="Hip swing" value={config.hipSwing} min={0} max={50} step={1} suffix="°" onChange={(v) => set("hipSwing", v)} />
            <SliderRow label="Knee bend" value={config.kneeBend} min={0} max={60} step={1} suffix="°" onChange={(v) => set("kneeBend", v)} />
            <SliderRow label="Body bob" value={config.bodyBob} min={0} max={30} step={1} onChange={(v) => set("bodyBob", v)} />
            <SliderRow label="Tail sway" value={config.tailSway} min={0} max={30} step={1} suffix="°" onChange={(v) => set("tailSway", v)} />

            <div className="h-px bg-white/10" />
            <span className="block font-mono text-[10px] uppercase tracking-widest text-white/40">timing (ms)</span>

            <SliderRow label="Logo in" value={config.logoIn} min={0} max={1500} step={20} onChange={(v) => set("logoIn", v)} />
            <SliderRow label="Logo hold" value={config.logoHold} min={0} max={1500} step={20} onChange={(v) => set("logoHold", v)} />
            <SliderRow label="Logo out" value={config.logoOut} min={0} max={1500} step={20} onChange={(v) => set("logoOut", v)} />
            <SliderRow label="Dots stagger" value={config.dotsStagger} min={0} max={2000} step={20} onChange={(v) => set("dotsStagger", v)} />
            <SliderRow label="Dot fly" value={config.dotFly} min={100} max={1600} step={20} onChange={(v) => set("dotFly", v)} />
            <SliderRow label="Run before loop" value={config.holdAfter} min={500} max={8000} step={100} suffix="ms" onChange={(v) => set("holdAfter", v)} />

            <div className="h-px bg-white/10" />

            <div>
              <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-white/40">background</span>
              <div className="flex gap-1.5">
                {(["dark", "light", "black"] as BgMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setBg(m)}
                    className={`flex-1 rounded-none border px-2 py-1 font-mono text-[11px] capitalize transition ${
                      bg === m ? "border-white/60 bg-white/15" : "border-white/10 text-white/60 hover:bg-white/5"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm"
                variant="secondary"
                className="flex-1 rounded-none text-xs"
                onClick={() => setConfig(DEFAULT_CONFIG)}
              >
                Reset
              </Button>
              <Button size="sm" className="flex-1 rounded-none text-xs" onClick={copyConfig}>
                {copied ? "Copied!" : "Copy config"}
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-white/80">{label}</Label>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="text-sm text-white/80">{label}</Label>
        <span className="font-mono text-xs text-white/50">
          {value}
          {suffix}
        </span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  )
}
