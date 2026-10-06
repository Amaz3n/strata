import { FINISH_PRESETS } from "./architectural-model";
import type { FloorplanEdit, FloorplanModel } from "./floorplan-model";
import { roomMatches, type ModelChange } from "./model-options";

/**
 * Designer palettes: a whole house's floors in one move. A palette is the
 * same shape as an option's model changes (room matches → finish), applied in
 * order so a later, more specific rule (baths) wins over a broad one (every
 * room). Palettes are looks, not upgrades — they carry no price; a priced
 * finish is a Design Studio option.
 */

export interface DesignPalette {
  id: string;
  name: string;
  /** Floor finishes, broadest first. */
  changes: Array<Extract<ModelChange, { kind: "floor_finish" }>>;
}

const WET = ["bath", "laundry", "mud", "powder", "wc"];
const SOFT = ["bed", "primary", "master", "nursery"];
const UTILITY = ["garage", "mech", "storage", "utility"];

const floor = (finish: string, rooms: string[]) => ({ kind: "floor_finish" as const, finish, rooms, unitPriceCents: 0 });

export const DESIGN_PALETTES: readonly DesignPalette[] = [
  { id: "warm-oak", name: "Warm oak", changes: [floor("oak", []), floor("carpet", SOFT), floor("porcelain", WET), floor("concrete", UTILITY)] },
  { id: "walnut-stone", name: "Walnut & stone", changes: [floor("walnut", []), floor("limestone", WET), floor("concrete", UTILITY)] },
  { id: "quiet-modern", name: "Quiet modern", changes: [floor("concrete", []), floor("oak", SOFT), floor("porcelain", WET)] },
];

/** The edits that put a palette on the model; rooms already in that finish are left alone. */
export function paletteEdits(model: Pick<FloorplanModel, "levels">, palette: DesignPalette): FloorplanEdit[] {
  const edits: FloorplanEdit[] = [];
  for (const level of model.levels) {
    for (const room of level.rooms) {
      const rule = [...palette.changes].reverse().find((change) => roomMatches(room, change.rooms));
      const finish = rule ? FINISH_PRESETS[rule.finish] : undefined;
      if (!finish) continue;
      if (room.finish?.color === finish.color && room.finish?.pattern === finish.pattern) continue;
      edits.push({ type: "room.update", levelId: level.id, roomId: room.id, changes: { finish: { ...finish } } });
    }
  }
  return edits;
}
