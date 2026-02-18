"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  createTaskAction,
  deleteTaskAction,
  listTasksAction,
  updateTaskAction,
  type UserTask,
} from "@/app/(app)/tasks/actions"
import { CheckSquare, Loader2, Plus, Trash2 } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export function GlobalTasksSheet() {
  const [open, setOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const [tasks, setTasks] = useState<UserTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)

  const openTasks = useMemo(() => tasks.filter((task) => task.status !== "done"), [tasks])
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === "done"), [tasks])

  const loadTasks = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await listTasksAction()
      setTasks(data)
      setHasLoaded(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load tasks."
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || hasLoaded) return
    void loadTasks()
  }, [hasLoaded, loadTasks, open])

  async function handleCreateTask() {
    const title = inputValue.trim()
    if (!title) return

    setIsCreating(true)
    try {
      const created = await createTaskAction({ title })
      setTasks((prev) => [created, ...prev])
      setInputValue("")
    } catch {
      toast.error("Failed to create task")
    } finally {
      setIsCreating(false)
    }
  }

  async function handleToggleTask(task: UserTask, checked: boolean | "indeterminate") {
    const nextStatus = checked ? "done" : "todo"
    const previousTasks = tasks

    setTasks((prev) =>
      prev.map((current) =>
        current.id === task.id
          ? {
              ...current,
              status: nextStatus,
              completed_at: nextStatus === "done" ? new Date().toISOString() : null,
            }
          : current,
      ),
    )

    try {
      await updateTaskAction(task.id, { status: nextStatus })
    } catch {
      setTasks(previousTasks)
      toast.error("Failed to update task")
    }
  }

  async function handleDeleteTask(taskId: string) {
    const previousTasks = tasks
    setTasks((prev) => prev.filter((task) => task.id !== taskId))

    try {
      await deleteTaskAction(taskId)
    } catch {
      setTasks(previousTasks)
      toast.error("Failed to delete task")
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Open tasks">
          <CheckSquare className="h-5 w-5" />
          {openTasks.length > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] px-1 grid place-items-center font-medium">
              {openTasks.length > 99 ? "99+" : openTasks.length}
            </span>
          )}
        </Button>
      </SheetTrigger>

      <SheetContent
        side="right"
        mobileFullscreen
        className="w-full sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 gap-0 overflow-hidden fast-sheet-animation"
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <CheckSquare className="h-5 w-5" />
            My Tasks
          </SheetTitle>
          <SheetDescription>Personal to-do list for quick task capture and completion.</SheetDescription>
        </SheetHeader>

        <div className="px-4 pt-4 pb-2 border-b">
          <div className="flex items-center gap-2">
            <Input
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Add a task..."
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void handleCreateTask()
                }
              }}
            />
            <Button onClick={() => void handleCreateTask()} disabled={isCreating || !inputValue.trim()} size="icon">
              {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          {isLoading ? (
            <div className="h-full grid place-items-center">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading tasks...
              </div>
            </div>
          ) : error ? (
            <div className="h-full grid place-items-center">
              <div className="space-y-3 text-center">
                <p className="text-sm text-destructive">{error}</p>
                <Button variant="outline" size="sm" onClick={() => void loadTasks()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="p-4 space-y-6">
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open ({openTasks.length})</p>
                  {openTasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4">No open tasks.</p>
                  ) : (
                    <div className="space-y-1">
                      {openTasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onToggle={handleToggleTask}
                          onDelete={handleDeleteTask}
                        />
                      ))}
                    </div>
                  )}
                </section>

                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Completed ({completedTasks.length})
                  </p>
                  {completedTasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-1">No completed tasks yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {completedTasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onToggle={handleToggleTask}
                          onDelete={handleDeleteTask}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </ScrollArea>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function TaskRow({
  task,
  onToggle,
  onDelete,
}: {
  task: UserTask
  onToggle: (task: UserTask, checked: boolean | "indeterminate") => Promise<void>
  onDelete: (taskId: string) => Promise<void>
}) {
  const isCompleted = task.status === "done"

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2",
        isCompleted && "bg-muted/40",
      )}
    >
      <Checkbox checked={isCompleted} onCheckedChange={(checked) => void onToggle(task, checked)} />
      <p className={cn("flex-1 text-sm", isCompleted && "line-through text-muted-foreground")}>{task.title}</p>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void onDelete(task.id)}>
        <Trash2 className="h-4 w-4 text-muted-foreground" />
      </Button>
    </div>
  )
}
