import { AccountingSection } from "@/components/settings/accounting-section";
import { TaxRegister } from "@/components/books/tax-register";

export default function TaxSettingsPage() {
  return <AccountingSection title="Taxes"><div className="mx-auto max-w-5xl p-6"><TaxRegister mode="settings" /></div></AccountingSection>;
}
