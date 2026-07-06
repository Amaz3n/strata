export const metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  )
}



