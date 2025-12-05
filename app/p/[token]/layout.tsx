import "@/styles/globals.css"

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      {children}
    </div>
  )
}

