"use client"

import { useMemo, useState } from "react"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { AlertCircle, Bell, Building2, Settings, User as UserIcon } from "@/components/icons"
import type { User } from "@/lib/types"

const sections = [
  { value: "profile", label: "Profile", description: "Name, email, avatar", icon: UserIcon },
  { value: "organization", label: "Organization", description: "Company details", icon: Building2 },
  { value: "notifications", label: "Notifications", description: "How you get updates", icon: Bell },
  { value: "danger", label: "Danger zone", description: "Destructive actions", icon: AlertCircle },
]

interface SettingsWindowProps {
  user: User | null
}

function getInitials(user: User | null) {
  if (!user?.full_name) return "?"
  return user.full_name
    .split(" ")
    .map((name) => name[0])
    .join("")
    .slice(0, 3)
    .toUpperCase()
}

export function SettingsWindow({ user }: SettingsWindowProps) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<string>("profile")
  const initials = useMemo(() => getInitials(user), [user])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-5xl w-full p-0 overflow-hidden border shadow-2xl">
        <Tabs value={tab} onValueChange={setTab} className="flex h-[640px]">
          <div className="hidden w-64 flex-col border-r bg-muted/50 p-4 md:flex">
            <div className="flex items-center gap-3 rounded-lg border bg-background/60 p-3 shadow-sm">
              <Avatar className="h-12 w-12">
                <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="font-semibold leading-tight">{user?.full_name ?? "Account"}</p>
                <p className="text-muted-foreground text-xs">{user?.email ?? "—"}</p>
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Sections</p>
              <TabsList className="grid w-full gap-2 bg-transparent p-0">
                {sections.map((section) => (
                  <TabsTrigger
                    key={section.value}
                    value={section.value}
                    className="justify-start gap-3 rounded-lg border bg-background/60 px-3 py-2 text-left shadow-sm transition hover:border-primary/50 hover:text-primary data-[state=active]:border-primary/60 data-[state=active]:bg-primary/5 data-[state=active]:text-primary"
                  >
                    <section.icon className="h-4 w-4" />
                    <div className="flex-1">
                      <p className="text-sm font-medium leading-tight">{section.label}</p>
                      <p className="text-xs text-muted-foreground">{section.description}</p>
                    </div>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <div className="mt-auto space-y-3 pt-4">
              <Separator />
              <p className="text-xs text-muted-foreground">Changes are saved per section.</p>
              <Button variant="ghost" size="sm" className="w-full justify-center" onClick={() => setOpen(false)}>
                Close window
              </Button>
            </div>
          </div>

          <div className="flex flex-1 flex-col">
            <DialogHeader className="border-b bg-card/60 px-4 py-3 backdrop-blur md:px-6">
              <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
                <Settings className="h-4 w-4 text-primary" />
                Settings
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Quick tweaks without leaving your flow.
              </DialogDescription>
            </DialogHeader>

            <div className="border-b bg-background/70 px-4 py-3 md:hidden">
              <TabsList className="grid w-full grid-cols-2 gap-2 bg-transparent p-0">
                {sections.map((section) => (
                  <TabsTrigger
                    key={section.value}
                    value={section.value}
                    className="justify-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm shadow-sm data-[state=active]:border-primary/60 data-[state=active]:bg-primary/5 data-[state=active]:text-primary"
                  >
                    <section.icon className="h-4 w-4" />
                    {section.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            <ScrollArea className="flex-1">
              <div className="space-y-8 px-4 py-6 md:px-6">
                <TabsContent value="profile" className="m-0 space-y-6">
                  <div className="rounded-xl border bg-card shadow-sm">
                    <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold leading-tight">Profile</p>
                        <p className="text-sm text-muted-foreground">Update your personal information</p>
                      </div>
                      <Button size="sm">Save changes</Button>
                    </div>
                    <div className="space-y-6 p-4 md:p-6">
                      <div className="flex flex-col gap-4 md:flex-row md:items-center">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-16 w-16">
                            <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                            <AvatarFallback className="text-lg font-semibold">{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-medium">{user?.full_name ?? "Your profile"}</p>
                            <p className="text-xs text-muted-foreground">Choose a friendly face for your team</p>
                          </div>
                        </div>
                        <div className="flex gap-2 md:ml-auto">
                          <Button variant="outline" size="sm">Change photo</Button>
                          <Button variant="ghost" size="sm">Remove</Button>
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="name">Full name</Label>
                          <Input id="name" defaultValue={user?.full_name} placeholder="Alex Contractor" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="email">Email</Label>
                          <Input id="email" type="email" defaultValue={user?.email} placeholder="you@company.com" />
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="phone">Phone</Label>
                          <Input id="phone" type="tel" placeholder="(503) 555-0123" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="role">Role</Label>
                          <Input id="role" placeholder="Project Manager" />
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="organization" className="m-0 space-y-6">
                  <div className="rounded-xl border bg-card shadow-sm">
                    <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold leading-tight">Organization</p>
                        <p className="text-sm text-muted-foreground">Manage your company settings</p>
                      </div>
                      <Button size="sm">Save changes</Button>
                    </div>
                    <div className="space-y-6 p-4 md:p-6">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="company">Company name</Label>
                          <Input id="company" defaultValue="Thompson Construction" placeholder="Company" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="org-phone">Phone</Label>
                          <Input id="org-phone" type="tel" defaultValue="(503) 555-0123" placeholder="(555) 123-4567" />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="address">Address</Label>
                        <Input id="address" defaultValue="123 Builder Lane, Portland, OR 97201" placeholder="Street, City, State" />
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="timezone">Timezone</Label>
                          <Input id="timezone" placeholder="Pacific Time (PT)" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="website">Website</Label>
                          <Input id="website" type="url" placeholder="https://your-company.com" />
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="notifications" className="m-0 space-y-6">
                  <NotificationPreferences />
                </TabsContent>

                <TabsContent value="danger" className="m-0 space-y-6">
                  <div className="rounded-xl border border-destructive/50 bg-destructive/5 shadow-sm">
                    <div className="flex items-center justify-between border-b border-destructive/30 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold leading-tight text-destructive">Danger zone</p>
                        <p className="text-sm text-muted-foreground">Irreversible and destructive actions</p>
                      </div>
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    </div>
                    <div className="space-y-4 p-4 md:p-6">
                      <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-background/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-medium">Delete organization</p>
                          <p className="text-sm text-muted-foreground">
                            Permanently delete your organization and all data. This cannot be undone.
                          </p>
                        </div>
                        <Button variant="destructive" size="sm" className="w-full sm:w-auto">
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </div>
            </ScrollArea>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
