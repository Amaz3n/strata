"use client"

import { useMemo, useState } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { NotificationPreferences } from "@/components/settings/notification-preferences"
import { AlertCircle, Bell, Building2, Settings, User as UserIcon } from "@/components/icons"
import { useIsMobile } from "@/hooks/use-mobile"
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
  const [tab, setTab] = useState<string>("profile")
  const initials = useMemo(() => getInitials(user), [user])
  const isMobile = useIsMobile()

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <div className="flex h-full min-h-[calc(100vh-8rem)]">
        {/* Desktop Sidebar */}
        {!isMobile && (
          <div className="w-80 border-r bg-muted/30 p-6">
            <div className="flex items-center gap-3 rounded-lg border bg-background/80 p-4 shadow-sm">
              <Avatar className="h-12 w-12">
                <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                <AvatarFallback className="text-base font-semibold">{initials}</AvatarFallback>
              </Avatar>
              <div className="text-sm">
                <p className="font-semibold leading-tight">{user?.full_name ?? "Account"}</p>
                <p className="text-muted-foreground text-xs">{user?.email ?? "—"}</p>
              </div>
            </div>

            <div className="mt-8 space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Settings</p>
              <TabsList className="grid w-full gap-2 bg-transparent p-0">
              {sections.map((section) => (
                <TabsTrigger
                  key={section.value}
                  value={section.value}
                  className="justify-start gap-3 rounded-lg border bg-background/80 px-4 py-3 text-left shadow-sm transition-all hover:border-primary/50 hover:text-primary hover:shadow-md data-[state=active]:border-primary/60 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-md"
                >
                  <section.icon className="h-5 w-5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium leading-tight">{section.label}</p>
                    <p className="text-xs text-muted-foreground">{section.description}</p>
                  </div>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="mt-auto pt-8">
            <Separator />
            <p className="text-xs text-muted-foreground mt-4">Changes are saved automatically per section.</p>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Header */}
        {isMobile && (
          <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4">
            <div className="flex items-center gap-3 mb-4">
              <Settings className="h-5 w-5 text-primary" />
              <div>
                <h1 className="text-lg font-semibold">Settings</h1>
                <p className="text-sm text-muted-foreground">Manage your account and preferences</p>
              </div>
            </div>
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
        )}

        {/* Content Area */}
        <ScrollArea className="flex-1">
          <div className="max-w-4xl mx-auto space-y-8 p-6 lg:p-8">
                <TabsContent value="profile" className="m-0 mt-0">
                  <div className="rounded-xl border bg-card shadow-sm">
                    <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 className="text-lg font-semibold">Profile</h2>
                        <p className="text-sm text-muted-foreground">Update your personal information and preferences</p>
                      </div>
                      <Button size="sm">Save changes</Button>
                    </div>
                    <div className="space-y-8 p-6 lg:p-8">
                      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-center gap-4">
                          <Avatar className="h-20 w-20">
                            <AvatarImage src={user?.avatar_url || "/placeholder.svg"} alt={user?.full_name} />
                            <AvatarFallback className="text-xl font-semibold">{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-base font-medium">{user?.full_name ?? "Your profile"}</p>
                            <p className="text-sm text-muted-foreground">Choose a friendly face for your team</p>
                            <div className="flex gap-2 mt-3">
                              <Button variant="outline" size="sm">Change photo</Button>
                              <Button variant="ghost" size="sm">Remove</Button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="name" className="text-sm font-medium">Full name</Label>
                          <Input id="name" defaultValue={user?.full_name} placeholder="Alex Contractor" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                          <Input id="email" type="email" defaultValue={user?.email} placeholder="you@company.com" className="h-11" />
                        </div>
                      </div>

                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="phone" className="text-sm font-medium">Phone</Label>
                          <Input id="phone" type="tel" placeholder="(503) 555-0123" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="role" className="text-sm font-medium">Role</Label>
                          <Input id="role" placeholder="Project Manager" className="h-11" />
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="organization" className="m-0 mt-0">
                  <div className="rounded-xl border bg-card shadow-sm">
                    <div className="flex flex-col gap-3 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 className="text-lg font-semibold">Organization</h2>
                        <p className="text-sm text-muted-foreground">Manage your company details and settings</p>
                      </div>
                      <Button size="sm">Save changes</Button>
                    </div>
                    <div className="space-y-8 p-6 lg:p-8">
                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="company" className="text-sm font-medium">Company name</Label>
                          <Input id="company" defaultValue="Thompson Construction" placeholder="Company" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="org-phone" className="text-sm font-medium">Phone</Label>
                          <Input id="org-phone" type="tel" defaultValue="(503) 555-0123" placeholder="(555) 123-4567" className="h-11" />
                        </div>
                      </div>

                      <div className="space-y-3">
                        <Label htmlFor="address" className="text-sm font-medium">Address</Label>
                        <Input id="address" defaultValue="123 Builder Lane, Portland, OR 97201" placeholder="Street, City, State" className="h-11" />
                      </div>

                      <div className="grid gap-6 lg:grid-cols-2">
                        <div className="space-y-3">
                          <Label htmlFor="timezone" className="text-sm font-medium">Timezone</Label>
                          <Input id="timezone" placeholder="Pacific Time (PT)" className="h-11" />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="website" className="text-sm font-medium">Website</Label>
                          <Input id="website" type="url" placeholder="https://your-company.com" className="h-11" />
                        </div>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="notifications" className="m-0 mt-0">
                  <div className="max-w-2xl">
                    <NotificationPreferences />
                  </div>
                </TabsContent>

                <TabsContent value="danger" className="m-0 mt-0">
                  <div className="rounded-xl border border-destructive/50 bg-destructive/5 shadow-sm max-w-2xl">
                    <div className="flex items-center justify-between border-b border-destructive/30 px-6 py-5">
                      <div>
                        <h2 className="text-lg font-semibold text-destructive">Danger zone</h2>
                        <p className="text-sm text-muted-foreground">Irreversible and destructive actions</p>
                      </div>
                      <AlertCircle className="h-5 w-5 text-destructive" />
                    </div>
                    <div className="space-y-6 p-6 lg:p-8">
                      <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-background/80 p-6 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-medium text-base">Delete organization</p>
                          <p className="text-sm text-muted-foreground mt-1">
                            Permanently delete your organization and all data. This cannot be undone.
                          </p>
                        </div>
                        <Button variant="destructive" size="sm" className="w-full sm:w-auto mt-4 sm:mt-0">
                          Delete organization
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>
            </div>
          </ScrollArea>
        </div>
      </div>
    </Tabs>
  )
}
