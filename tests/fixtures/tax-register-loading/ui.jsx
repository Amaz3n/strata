import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { TaxRegister } from "@/components/books/tax-register"

function Fixture() {
  const [mounted, setMounted] = useState(true)
  useEffect(() => { window.taxFixture = { unmount: () => setMounted(false) } }, [])
  return mounted ? <TaxRegister mode={new URLSearchParams(window.location.search).get("mode") === "filings" ? "filings" : "settings"} /> : <p>Register removed</p>
}
createRoot(document.getElementById("root")).render(<Fixture />)
