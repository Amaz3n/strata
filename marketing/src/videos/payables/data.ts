// The story's bills. Fictional vendors, a believable Gulf Coast custom-home job.
export type Bill = {
  vendor: string;
  invoice: string;
  due: string;
  dueTone?: "warning";
  totalCents: number;
};

export const DROPPED: Bill[] = [
  { vendor: "Gulf Coast Framing LLC", invoice: "GCF-2231", due: "Nov 1", totalCents: 2_300_000 },
  { vendor: "Bayou Electric Co.", invoice: "INV-1048", due: "Due Fri", dueTone: "warning", totalCents: 684_000 },
  { vendor: "Coastal Concrete Supply", invoice: "55710", due: "Nov 8", totalCents: 1_127_550 },
];

export const ALREADY_READY: Bill[] = [
  { vendor: "Sunbelt Rentals", invoice: "SR-88412", due: "Oct 24", totalCents: 191_240 },
  { vendor: "Harbor Lumber & Truss", invoice: "HLT-6620", due: "Oct 27", totalCents: 1_408_800 },
];

export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const DROPPED_TOTAL = DROPPED.reduce((sum, b) => sum + b.totalCents, 0);

// The invoice the reading shot zooms into: the first dropped bill.
export const INVOICE = {
  vendor: "Gulf Coast Framing LLC",
  vendorAddress: ["4410 Industrial Pkwy", "Mobile, AL 36609"],
  billTo: ["Gulfstone Homes", "Magnolia Residence · Lot 14", "Fairhope, AL 36532"],
  number: "GCF-2231",
  date: "Oct 2, 2026",
  due: "Nov 1, 2026",
  lines: [
    { description: "Wall & roof framing, labor", qty: "1", unit: "LS", amountCents: 1_840_000 },
    { description: "LVL beams 3½ × 11⅞, 20 ft", qty: "12", unit: "EA", amountCents: 343_200 },
    { description: "Hurricane ties & connectors", qty: "1", unit: "LS", amountCents: 116_800 },
  ],
  totalCents: 2_300_000,
};
