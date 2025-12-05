"use client"

import { useState, useMemo } from "react"
import {
  format,
  parseISO,
  isSameDay,
  addDays,
  startOfDay,
  endOfDay,
  isBefore,
  isAfter,
} from "date-fns"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"

import type { DailyLog } from "@/lib/types"
import type { EnhancedFileMetadata, FileCategory } from "@/app/projects/[id]/actions"
import { dailyLogInputSchema, type DailyLogInput } from "@/lib/validation/daily-logs"
import { cn } from "@/lib/utils"

import { FileViewer } from "@/components/files/file-viewer"
import { isImageFile } from "@/components/files/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  CalendarDays,
  Plus,
  MoreHorizontal,
  Camera,
  FileText,
  ClipboardList,
  Filter,
} from "@/components/icons"
import { DateRange } from "react-day-picker"

const weatherOptions = [
  { value: "Sunny", emoji: "☀️" },
  { value: "Partly Cloudy", emoji: "⛅" },
  { value: "Cloudy", emoji: "☁️" },
  { value: "Light Rain", emoji: "🌧️" },
  { value: "Heavy Rain", emoji: "⛈️" },
  { value: "Snow", emoji: "❄️" },
  { value: "Windy", emoji: "💨" },
  { value: "Hot", emoji: "🌡️" },
  { value: "Cold", emoji: "🥶" },
]

function getWeatherEmoji(weather: string | undefined): string {
  if (!weather) return ""
  const found = weatherOptions.find(w => w.value === weather)
  return found?.emoji ?? ""
}

interface DailyLogsTabProps {
  projectId: string
  dailyLogs: DailyLog[]
  files: EnhancedFileMetadata[]
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onUploadFiles: (files: File[], category?: FileCategory) => Promise<void>
  onDownloadFile: (file: EnhancedFileMetadata) => Promise<void>
}

export function DailyLogsTab({
  projectId,
  dailyLogs,
  files,
  onCreateLog,
  onUploadFiles,
  onDownloadFile,
}: DailyLogsTabProps) {
  const today = new Date()
  
  // State
  const [logSheetOpen, setLogSheetOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [feedFilter, setFeedFilter] = useState<'all' | 'text' | 'photos'>('all')
  const [logDateRange, setLogDateRange] = useState<DateRange | undefined>()
  
  // Image viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<EnhancedFileMetadata | null>(null)
  
  // Form
  const logForm = useForm<DailyLogInput>({
    resolver: zodResolver(dailyLogInputSchema),
    defaultValues: {
      project_id: projectId,
      date: format(today, "yyyy-MM-dd"),
      summary: "",
      weather: "",
    },
  })

  // Get all image files for gallery navigation
  const imageFiles = useMemo(() => 
    files.filter(f => f.mime_type && f.mime_type.startsWith('image/')),
    [files]
  )

  // Filter and group feed items
  const { groupedItems, sortedDates, feedItems } = useMemo(() => {
    const items = [
      ...dailyLogs.map(log => ({ type: 'log' as const, data: log, date: log.date })),
      ...imageFiles.map(f => ({ type: 'photo' as const, data: f, date: f.created_at }))
    ]
    .filter(item => {
      if (feedFilter === 'text' && item.type !== 'log') return false
      if (feedFilter === 'photos' && item.type !== 'photo') return false
      const itemDate = parseISO(item.date)
      const from = logDateRange?.from ? startOfDay(logDateRange.from) : null
      const to = logDateRange?.to ? endOfDay(logDateRange.to) : null
      if (from && isBefore(itemDate, from)) return false
      if (to && isAfter(itemDate, to)) return false
      return true
    })

    const grouped = items.reduce<Record<string, typeof items>>((groups, item) => {
      const dateKey = format(parseISO(item.date), 'yyyy-MM-dd')
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
      return groups
    }, {})

    const dates = Object.keys(grouped).sort((a, b) => 
      new Date(b).getTime() - new Date(a).getTime()
    )

    return { groupedItems: grouped, sortedDates: dates, feedItems: items }
  }, [dailyLogs, imageFiles, feedFilter, logDateRange])

  // Handlers
  async function handleCreateDailyLog(values: DailyLogInput) {
    setIsSubmitting(true)
    try {
      if (selectedFiles.length > 0) {
        await onUploadFiles(selectedFiles)
      }
      if (values.summary || values.weather) {
        const created = await onCreateLog(values)
        toast.success("Daily log created", { 
          description: `Log for ${format(parseISO(created.date), "MMM d, yyyy")}` 
        })
      } else if (selectedFiles.length > 0) {
        toast.success("Photos uploaded")
      }
      logForm.reset({
        project_id: projectId,
        date: format(today, "yyyy-MM-dd"),
        summary: "",
        weather: "",
      })
      setSelectedFiles([])
      setLogSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Failed to create daily log")
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleImageClick(file: EnhancedFileMetadata) {
    setViewerFile(file)
    setViewerOpen(true)
  }

  const hasActiveFilters = feedFilter !== 'all' || logDateRange?.from

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar - All controls in one row */}
      <div className="flex-shrink-0 flex items-center justify-between gap-3 pb-4 border-b mb-4">
        <div className="flex items-center gap-2">
          {/* Type Filter Pills */}
          <div className="flex items-center p-0.5 bg-muted border">
            {([
              { key: 'all', label: 'All', icon: ClipboardList },
              { key: 'text', label: 'Logs', icon: FileText },
              { key: 'photos', label: 'Photos', icon: Camera },
            ] as const).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setFeedFilter(key)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all",
                  feedFilter === key 
                    ? "bg-background text-foreground shadow-sm" 
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          <Separator orientation="vertical" className="h-6" />
          
          {/* Date Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button 
                variant={logDateRange?.from ? "secondary" : "ghost"} 
                size="sm" 
                className="gap-2"
              >
                <CalendarDays className="h-4 w-4" />
                {logDateRange?.from ? (
                  logDateRange.to ? (
                    <span className="text-xs">
                      {format(logDateRange.from, "MMM d")} – {format(logDateRange.to, "MMM d")}
                    </span>
                  ) : (
                    format(logDateRange.from, "MMM d, yyyy")
                  )
                ) : (
                  <span className="hidden sm:inline">Date Range</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <div className="p-3 border-b">
                <div className="flex flex-wrap gap-1">
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange(undefined)}
                  >
                    All Time
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange({ from: addDays(today, -7), to: today })}
                  >
                    Last 7 Days
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setLogDateRange({ from: addDays(today, -30), to: today })}
                  >
                    Last 30 Days
                  </Button>
                </div>
              </div>
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={logDateRange?.from}
                selected={logDateRange}
                onSelect={setLogDateRange}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>

          {hasActiveFilters && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={() => {
                setFeedFilter('all')
                setLogDateRange(undefined)
              }}
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              Clear filters
            </Button>
          )}
        </div>

        {/* Right side - count and new entry */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground hidden sm:inline">
            {feedItems.length} {feedItems.length === 1 ? "item" : "items"}
          </span>
          
          {/* New Entry Button */}
          <Sheet open={logSheetOpen} onOpenChange={(open) => {
            setLogSheetOpen(open)
            if (!open) setSelectedFiles([]) 
          }}>
            <SheetTrigger asChild>
              <Button size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New Entry</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="sm:max-w-md w-full flex flex-col">
              <div className="flex-1 overflow-y-auto">
                <SheetHeader className="pt-6 pb-4 px-4">
                  <SheetTitle className="text-lg font-semibold">New Daily Log</SheetTitle>
                  <SheetDescription className="text-sm text-muted-foreground">
                    Record site activity, weather, and attach photos.
                  </SheetDescription>
                </SheetHeader>
                <Form {...logForm}>
                  <form className="space-y-5 px-1">
                    {/* Date Field */}
                    <FormField
                      control={logForm.control}
                      name="date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium">Log Date</FormLabel>
                          <Popover>
                            <PopoverTrigger asChild>
                              <FormControl>
                                <Button
                                  variant="outline"
                                  className={cn(
                                    "w-full justify-start text-left font-normal",
                                    !field.value && "text-muted-foreground"
                                  )}
                                >
                                  <CalendarDays className="mr-2 h-4 w-4" />
                                  {field.value ? format(parseISO(field.value), "EEEE, MMMM d, yyyy") : "Select date"}
                                </Button>
                              </FormControl>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={field.value ? parseISO(field.value) : undefined}
                                onSelect={(date) => field.onChange(date ? format(date, "yyyy-MM-dd") : "")}
                                disabled={(date) => isAfter(date, today)}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Weather Section */}
                    <FormField
                      control={logForm.control}
                      name="weather"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium">Weather Conditions</FormLabel>
                          <div className="grid grid-cols-3 gap-2">
                            {weatherOptions.slice(0, 6).map(({ value, emoji }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => field.onChange(field.value === value ? "" : value)}
                                className={cn(
                                  "flex flex-col items-center gap-1 p-3 border text-xs font-medium transition-all",
                                  field.value === value 
                                    ? "border-primary bg-primary/5 text-primary" 
                                    : "border-border hover:border-muted-foreground/50"
                                )}
                              >
                                <span className="text-lg">{emoji}</span>
                                <span className="text-[10px] text-center leading-tight">{value}</span>
                              </button>
                            ))}
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Work Summary */}
                    <FormField
                      control={logForm.control}
                      name="summary"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm font-medium">Work Summary</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Describe work performed today, crew activity, deliveries, delays, or any notable events..."
                              className="min-h-[120px] resize-none"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    {/* Photo Upload Section */}
                    <div className="space-y-3">
                      <FormLabel className="text-sm font-medium">Site Photos</FormLabel>
                      <div className="grid grid-cols-4 gap-2">
                        {selectedFiles.map((file, i) => (
                          <div key={i} className="relative aspect-square bg-muted overflow-hidden group">
                            <img 
                              src={URL.createObjectURL(file)} 
                              alt="Preview" 
                              className="object-cover w-full h-full" 
                            />
                            <button
                              type="button"
                              onClick={() => setSelectedFiles(prev => prev.filter((_, idx) => idx !== i))}
                              className="absolute inset-0 bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                            >
                              <Plus className="h-5 w-5 rotate-45" />
                            </button>
                          </div>
                        ))}
                        <label className="flex flex-col items-center justify-center aspect-square bg-muted/30 border-2 border-dashed border-muted-foreground/25 cursor-pointer hover:bg-muted/50 hover:border-muted-foreground/40 transition-colors">
                          <Camera className="h-5 w-5 text-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground font-medium mt-1">Add</span>
                          <input 
                            type="file" 
                            accept="image/*" 
                            multiple 
                            className="hidden" 
                            onChange={(e) => {
                              if (e.target.files) {
                                setSelectedFiles(prev => [...prev, ...Array.from(e.target.files!)])
                              }
                            }}
                          />
                        </label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selectedFiles.length > 0 
                          ? `${selectedFiles.length} photo${selectedFiles.length === 1 ? "" : "s"} attached`
                          : "Attach progress photos, deliveries, or site conditions"
                        }
                      </p>
                    </div>
                  </form>
                </Form>
              </div>
              <div className="flex-shrink-0 border-t bg-background p-4 -mx-6 px-6">
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      logForm.reset({
                        project_id: projectId,
                        date: format(today, "yyyy-MM-dd"),
                        summary: "",
                        weather: "",
                      })
                      setSelectedFiles([])
                      setLogSheetOpen(false)
                    }}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={isSubmitting || (!logForm.getValues("summary") && selectedFiles.length === 0)}
                    className="flex-1"
                    onClick={() => handleCreateDailyLog(logForm.getValues())}
                  >
                    {isSubmitting ? "Saving..." : "Save Log"}
                  </Button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Timeline Feed */}
      <div className="flex-1 overflow-y-auto">
        {feedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-16 w-16 items-center justify-center bg-muted mb-4">
              <ClipboardList className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">No daily logs yet</h3>
            <p className="text-sm text-muted-foreground max-w-[300px] mb-4">
              Start documenting site activity, weather conditions, and progress with daily logs.
            </p>
            <Button onClick={() => setLogSheetOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create First Log
            </Button>
          </div>
        ) : (
          <div className="space-y-6 max-w-2xl">
            {sortedDates.map((dateKey) => {
              const items = groupedItems[dateKey]
              const dateObj = parseISO(dateKey)
              const isToday = isSameDay(dateObj, today)
              const isYesterday = isSameDay(dateObj, addDays(today, -1))
              const logItems = items.filter(i => i.type === 'log')
              const photoItems = items.filter(i => i.type === 'photo')

              return (
                <div key={dateKey} className="relative">
                  {/* Date Header */}
                  <div className="sticky top-0 z-10 bg-background pb-3 -mx-1 px-1">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "flex h-10 w-10 items-center justify-center text-sm font-bold",
                        isToday ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        {format(dateObj, "d")}
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold">
                          {isToday ? "Today" : isYesterday ? "Yesterday" : format(dateObj, "EEEE")}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {format(dateObj, "MMMM d, yyyy")}
                        </p>
                      </div>
                      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        {logItems.length > 0 && (
                          <span className="flex items-center gap-1">
                            <FileText className="h-3.5 w-3.5" />
                            {logItems.length}
                          </span>
                        )}
                        {photoItems.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Camera className="h-3.5 w-3.5" />
                            {photoItems.length}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Day's Content */}
                  <div className="space-y-3 pl-[52px]">
                    {/* Text Logs */}
                    {logItems.map((item) => {
                      const log = item.data as DailyLog
                      return (
                        <Card key={log.id} className="group">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-3 mb-3">
                              <div className="flex items-center gap-2">
                                {log.weather && (
                                  <Badge variant="outline" className="gap-1 font-normal">
                                    <span>{getWeatherEmoji(log.weather)}</span>
                                    {log.weather}
                                  </Badge>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  {format(parseISO(log.created_at), "h:mm a")}
                                </span>
                              </div>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button 
                                    variant="ghost" 
                                    size="icon" 
                                    className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem>Edit</DropdownMenuItem>
                                  <DropdownMenuItem>Duplicate</DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                            <p className="text-sm leading-relaxed whitespace-pre-wrap">
                              {log.notes || (
                                <span className="text-muted-foreground italic">No notes recorded</span>
                              )}
                            </p>
                          </CardContent>
                        </Card>
                      )
                    })}

                    {/* Photo Grid */}
                    {photoItems.length > 0 && (
                      <Card className="overflow-hidden">
                        <div className={cn(
                          "grid gap-0.5",
                          photoItems.length === 1 && "grid-cols-1",
                          photoItems.length === 2 && "grid-cols-2",
                          photoItems.length >= 3 && "grid-cols-3"
                        )}>
                          {photoItems.slice(0, 6).map((photoItem, idx) => {
                            const photo = photoItem.data as EnhancedFileMetadata
                            const isLast = idx === 5 && photoItems.length > 6
                            return (
                              <button
                                key={photo.id}
                                onClick={() => handleImageClick(photo)}
                                className={cn(
                                  "relative aspect-square bg-muted overflow-hidden group/photo",
                                  photoItems.length === 1 && "aspect-video"
                                )}
                              >
                                {photo.thumbnail_url ? (
                                  <img 
                                    src={photo.thumbnail_url} 
                                    alt={photo.file_name} 
                                    className="absolute inset-0 w-full h-full object-cover group-hover/photo:scale-105 transition-transform duration-300"
                                  />
                                ) : (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <Camera className="h-8 w-8 text-muted-foreground/50" />
                                  </div>
                                )}
                                {isLast && (
                                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                    <span className="text-white font-semibold text-lg">+{photoItems.length - 6}</span>
                                  </div>
                                )}
                                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover/photo:opacity-100 transition-opacity" />
                              </button>
                            )
                          })}
                        </div>
                        <div className="p-3 border-t flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            {photoItems.length} photo{photoItems.length === 1 ? "" : "s"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {format(parseISO(photoItems[0].data.created_at), "h:mm a")}
                          </span>
                        </div>
                      </Card>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Image Viewer */}
      <FileViewer
        file={viewerFile ? {
          ...viewerFile,
          download_url: viewerFile.download_url,
          thumbnail_url: viewerFile.thumbnail_url,
        } : null}
        files={imageFiles.map(f => ({
          ...f,
          download_url: f.download_url,
          thumbnail_url: f.thumbnail_url,
        }))}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(file) => onDownloadFile(file as EnhancedFileMetadata)}
      />
    </div>
  )
}



