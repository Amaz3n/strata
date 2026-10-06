import type { SiteOrientation } from "@/lib/drawings/architectural-model";

/**
 * Where the sun is, for a building that knows which way is north.
 *
 * Standard low-precision solar geometry (declination from the day of year,
 * hour angle from local solar time) — within a degree or two, which is all a
 * shadow study needs. Pure and tested; the scene only places a light along
 * the returned direction.
 *
 * World axes are the model's: x is plan-right, z is plan-down, y is up. A
 * site's `northDeg` is the bearing of plan-up, clockwise from true north.
 */

/** No site recorded: plan-up is north, mid-latitude (most of the US). */
export const DEFAULT_SITE: SiteOrientation = { northDeg: 0, latitudeDeg: 35 };

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Degrees above the horizon; negative is night. */
  altitudeDeg: number;
  /** Compass bearing, degrees clockwise from true north. */
  azimuthDeg: number;
  /** Unit vector toward the sun in world axes. */
  direction: [number, number, number];
}

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((today - start) / 86_400_000);
}

/** `solarHour` is local solar time, 12 = solar noon. */
export function sunPosition(site: SiteOrientation, day: number, solarHour: number): SunPosition {
  const latitude = site.latitudeDeg * RAD;
  const declination = 23.44 * RAD * Math.sin(((2 * Math.PI) / 365) * (284 + day));
  const hourAngle = 15 * RAD * (solarHour - 12);
  const sinAltitude =
    Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAltitude)));
  // Azimuth measured from south, positive west, then turned to a compass bearing.
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
  );
  const azimuthDeg = (((fromSouth / RAD + 180) % 360) + 360) % 360;
  const bearing = (azimuthDeg - site.northDeg) * RAD;
  const flat = Math.cos(altitude);
  return {
    altitudeDeg: altitude / RAD,
    azimuthDeg,
    direction: [Math.sin(bearing) * flat, Math.sin(altitude), -Math.cos(bearing) * flat],
  };
}

/** "7:30 AM" from a fractional hour. */
export function formatSolarHour(hour: number): string {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const h = ((whole + 11) % 12) + 1;
  return `${h}:${String(minutes === 60 ? 0 : minutes).padStart(2, "0")} ${whole < 12 ? "AM" : "PM"}`;
}
