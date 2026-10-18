import { vectorLeafDoors } from "./vector-leaf-doors";
import { rasterSwingDoors } from "./raster-swing-doors";

/** Consumers share the source assembly result; vector and pixel provenance
 * retain different validation rules instead of reusing exact CAD tolerances. */
export function sourceLeafDoors(input: Parameters<typeof rasterSwingDoors>[0]) {
  return input.evidence?.raster
    ? rasterSwingDoors(input)
    : vectorLeafDoors(input);
}
