import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import AuthCallbackPage from "@/app/(auth)/auth/callback/page"
import { InviteHashHandler } from "@/components/auth/invite-hash-handler"
import ResetPasswordPage from "@/components/auth/auth-reset-page"
function Fixture() {
  const [mounted, setMounted] = useState(true)
  const [mode] = useState(() => new URLSearchParams(window.location.search).get("fixture"))
  useEffect(() => { window.callbackFixture = { unmount: () => setMounted(false), navigate: (url) => { window.history.pushState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); window.dispatchEvent(new HashChangeEvent("hashchange")) } } }, [])
  return mounted ? (mode === "invite" ? <InviteHashHandler /> : mode === "reset" ? <ResetPasswordPage /> : <AuthCallbackPage />) : <p>Callback removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)
