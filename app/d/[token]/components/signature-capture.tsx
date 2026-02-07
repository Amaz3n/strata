"use client"

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent } from "react"

import { Check, PenLine, RotateCw, Trash2, Type, Upload } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type SignatureTab = "draw" | "type" | "upload"

type FontOption = {
  id: string
  label: string
  family: string
}

const TYPEFACE_OPTIONS: FontOption[] = [
  { id: "formal", label: "Formal", family: '"Snell Roundhand", "Brush Script MT", cursive' },
  { id: "pen", label: "Pen", family: '"Segoe Script", "Lucida Handwriting", cursive' },
  { id: "clean", label: "Clean", family: '"Bradley Hand", "Comic Sans MS", cursive' },
]

interface SignatureCaptureProps {
  fieldLabel: string
  adoptedSignature?: string | null
  onApply: (value: string, options: { adopt: boolean }) => void
}

function dataUrlToImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = dataUrl
  })
}

export function SignatureCapture({ fieldLabel, adoptedSignature, onApply }: SignatureCaptureProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [activeTab, setActiveTab] = useState<SignatureTab>("draw")
  const [typedName, setTypedName] = useState("")
  const [fontId, setFontId] = useState(TYPEFACE_OPTIONS[0].id)
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string | null>(null)
  const [drawSnapshots, setDrawSnapshots] = useState<string[]>([""])
  const [isDrawing, setIsDrawing] = useState(false)
  const [adoptForSession, setAdoptForSession] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (adoptedSignature) {
      setAdoptForSession(true)
    }
  }, [adoptedSignature])

  const selectedFont = useMemo(
    () => TYPEFACE_OPTIONS.find((option) => option.id === fontId) ?? TYPEFACE_OPTIONS[0],
    [fontId],
  )

  const initializeCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(320, rect.width * dpr)
    canvas.height = Math.max(150, rect.height * dpr)

    const context = canvas.getContext("2d")
    if (!context) return

    context.scale(dpr, dpr)
    context.lineWidth = 2
    context.lineJoin = "round"
    context.lineCap = "round"
    context.strokeStyle = "#0f172a"
    contextRef.current = context
  }

  const clearCanvas = () => {
    const canvas = canvasRef.current
    const context = contextRef.current
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
  }

  const restoreCanvas = async (dataUrl: string) => {
    clearCanvas()
    if (!dataUrl) return

    const canvas = canvasRef.current
    const context = contextRef.current
    if (!canvas || !context) return

    const image = await dataUrlToImage(dataUrl)
    const targetWidth = canvas.width / (window.devicePixelRatio || 1)
    const targetHeight = canvas.height / (window.devicePixelRatio || 1)
    context.drawImage(image, 0, 0, targetWidth, targetHeight)
  }

  useEffect(() => {
    initializeCanvas()

    const element = canvasRef.current
    if (!element) return

    const observer = new ResizeObserver(async () => {
      const latest = drawSnapshots[drawSnapshots.length - 1]
      initializeCanvas()
      await restoreCanvas(latest)
    })

    observer.observe(element)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getPointerPosition = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }

  const startDraw = (event: PointerEvent<HTMLCanvasElement>) => {
    const context = contextRef.current
    if (!context) return
    const { x, y } = getPointerPosition(event)
    context.beginPath()
    context.moveTo(x, y)
    setIsDrawing(true)
  }

  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return
    const context = contextRef.current
    if (!context) return
    const { x, y } = getPointerPosition(event)
    context.lineTo(x, y)
    context.stroke()
  }

  const finishDraw = () => {
    if (!isDrawing) return
    setIsDrawing(false)

    const canvas = canvasRef.current
    if (!canvas) return

    const dataUrl = canvas.toDataURL("image/png")
    setDrawSnapshots((current) => {
      if (current[current.length - 1] === dataUrl) return current
      return [...current, dataUrl]
    })
    setErrorMessage(null)
  }

  const clearDrawnSignature = () => {
    clearCanvas()
    setDrawSnapshots([""])
    setErrorMessage(null)
  }

  const undoDraw = async () => {
    if (drawSnapshots.length <= 1) return
    const nextSnapshots = drawSnapshots.slice(0, -1)
    setDrawSnapshots(nextSnapshots)
    await restoreCanvas(nextSnapshots[nextSnapshots.length - 1])
  }

  const handleUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ""))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

    setUploadedDataUrl(dataUrl)
    setErrorMessage(null)
  }

  const typedPreviewDataUrl = useMemo(() => {
    if (typeof window === "undefined") return null
    if (!typedName.trim()) return null

    const canvas = document.createElement("canvas")
    canvas.width = 950
    canvas.height = 260
    const context = canvas.getContext("2d")
    if (!context) return null

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = "#0f172a"
    context.font = `116px ${selectedFont.family}`
    context.textBaseline = "middle"
    context.fillText(typedName.trim(), 44, canvas.height / 2)

    return canvas.toDataURL("image/png")
  }, [typedName, selectedFont.family])

  const applySignature = () => {
    let signatureDataUrl: string | null = null

    if (activeTab === "draw") {
      signatureDataUrl = drawSnapshots[drawSnapshots.length - 1] || null
      if (!signatureDataUrl) {
        setErrorMessage("Draw your signature before applying.")
        return
      }
    }

    if (activeTab === "type") {
      signatureDataUrl = typedPreviewDataUrl
      if (!signatureDataUrl) {
        setErrorMessage("Enter your name to generate a typed signature.")
        return
      }
    }

    if (activeTab === "upload") {
      signatureDataUrl = uploadedDataUrl
      if (!signatureDataUrl) {
        setErrorMessage("Upload a signature image before applying.")
        return
      }
    }

    if (!signatureDataUrl) {
      setErrorMessage("Unable to apply signature. Please try again.")
      return
    }

    onApply(signatureDataUrl, { adopt: adoptForSession })
    setErrorMessage(null)
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Signature input</p>
          <p className="text-sm font-medium">{fieldLabel}</p>
        </div>
        {adoptedSignature ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onApply(adoptedSignature, { adopt: true })}
          >
            Use adopted signature
          </Button>
        ) : null}
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SignatureTab)}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="draw">
            <PenLine className="h-4 w-4" /> Draw
          </TabsTrigger>
          <TabsTrigger value="type">
            <Type className="h-4 w-4" /> Type
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload className="h-4 w-4" /> Upload
          </TabsTrigger>
        </TabsList>

        <TabsContent value="draw" className="space-y-2">
          <div className="rounded-md border bg-muted/40 p-2">
            <canvas
              ref={canvasRef}
              className="h-40 w-full touch-none rounded-md bg-white"
              onPointerDown={startDraw}
              onPointerMove={draw}
              onPointerUp={finishDraw}
              onPointerLeave={finishDraw}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={undoDraw}>
              <RotateCw className="mr-1 h-3.5 w-3.5" /> Undo
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={clearDrawnSignature}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="type" className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="typed-signature-name">Type your name</Label>
            <Input
              id="typed-signature-name"
              value={typedName}
              onChange={(event) => {
                setTypedName(event.target.value)
                setErrorMessage(null)
              }}
              placeholder="Jane Doe"
              autoComplete="name"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Signature style</p>
            <div className="flex flex-wrap gap-2">
              {TYPEFACE_OPTIONS.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant={option.id === selectedFont.id ? "default" : "outline"}
                  className={cn(option.id === selectedFont.id ? "" : "bg-background")}
                  onClick={() => setFontId(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3">
            <div className="h-24 rounded-md bg-background px-3 py-2 text-4xl" style={{ fontFamily: selectedFont.family }}>
              {typedName.trim() || "Signature preview"}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="upload" className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleUploadChange}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-2 h-4 w-4" />
            Choose image
          </Button>
          <div className="rounded-md border bg-muted/40 p-3">
            {uploadedDataUrl ? (
              <img src={uploadedDataUrl} alt="Uploaded signature" className="h-28 w-full object-contain" />
            ) : (
              <p className="text-sm text-muted-foreground">No image uploaded yet.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
        <Checkbox id="adopt-signature" checked={adoptForSession} onCheckedChange={(checked) => setAdoptForSession(checked === true)} />
        <Label htmlFor="adopt-signature" className="text-sm font-medium">
          Adopt as my signature for the rest of this session
        </Label>
      </div>

      {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

      <div className="flex justify-end">
        <Button type="button" onClick={applySignature}>
          <Check className="mr-1.5 h-4 w-4" />
          {adoptForSession ? "Adopt & Apply" : "Apply Signature"}
        </Button>
      </div>
    </div>
  )
}
