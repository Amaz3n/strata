import type { ProspectContact } from "@/lib/services/prospects"
import { formatPhone } from "@/lib/utils"

interface Person {
  key: string
  name: string
  detail: string
  phone: string | null
  email: string | null
}

/**
 * Everyone on the deal. A buyer is rarely one person — there is a spouse, a
 * co-op agent, sometimes a relocation coordinator — so this is a list that
 * grows rather than a fixed set of contact fields that can only ever hold one.
 *
 * Read-only: correcting a contact is an occasional act that lives in the deal's
 * actions menu, so the pane stays something you scan mid-call rather than a
 * form you edit by accident.
 */
export function DealPeople({
  buyerName,
  buyerPhone,
  buyerEmail,
  contacts,
}: {
  buyerName: string
  buyerPhone: string | null
  buyerEmail: string | null
  contacts: ProspectContact[]
}) {
  // An imported agreement has no lead record behind it, so the deal row's own
  // buyer fields are the only person there is to show.
  const people: Person[] =
    contacts.length > 0
      ? [...contacts]
          .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
          .map((contact) => ({
            key: contact.id,
            name: contact.full_name,
            detail: [contact.role ?? (contact.is_primary ? "Buyer" : "Contact"), contact.company_name]
              .filter(Boolean)
              .join(" · "),
            phone: contact.phone ?? null,
            email: contact.email ?? null,
          }))
      : [{ key: "buyer", name: buyerName, detail: "Buyer", phone: buyerPhone, email: buyerEmail }]

  return (
    <ul className="divide-y">
      {people.map((person) => (
        <li key={person.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{person.name}</p>
            <p className="truncate text-xs text-muted-foreground">{person.detail}</p>
          </div>
          <div className="flex min-w-0 flex-col items-end text-[13px]">
            {person.phone ? (
              <a href={`tel:${person.phone}`} className="tabular-nums hover:text-primary hover:underline">
                {formatPhone(person.phone) || person.phone}
              </a>
            ) : null}
            {person.email ? (
              <a href={`mailto:${person.email}`} className="max-w-full truncate hover:text-primary hover:underline">
                {person.email}
              </a>
            ) : null}
            {!person.phone && !person.email ? (
              <span className="text-xs text-muted-foreground">No contact details</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
