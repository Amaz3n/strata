import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface ProjectDailyWeather {
  conditions: string
  temperature: string
  notes: string
  source: "open_meteo"
  weather_code: number
  high_f: number
  low_f: number
  precipitation_inches: number
}

function numberAt(value: unknown, keys: string[]): number | null {
  let cursor: unknown = value
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : null
}

function condition(code: number) {
  if (code === 0) return "Clear"
  if (code <= 3) return "Partly cloudy"
  if (code <= 48) return "Fog"
  if (code <= 57) return "Drizzle"
  if (code <= 67) return "Rain"
  if (code <= 77) return "Snow"
  if (code <= 82) return "Rain showers"
  if (code <= 86) return "Snow showers"
  return "Thunderstorms"
}

export async function getProjectDailyWeather(orgId: string, projectId: string, date: string): Promise<ProjectDailyWeather | null> {
  const supabase = createServiceSupabaseClient()
  const { data: cached } = await supabase.from("project_weather_cache").select("weather").eq("org_id", orgId).eq("project_id", projectId).eq("weather_date", date).maybeSingle()
  if (cached?.weather && typeof cached.weather === "object" && !Array.isArray(cached.weather)) return cached.weather as ProjectDailyWeather
  const { data: project, error } = await supabase.from("projects").select("location").eq("org_id", orgId).eq("id", projectId).maybeSingle()
  if (error || !project) return null
  const latitude = numberAt(project.location, ["latitude"]) ?? numberAt(project.location, ["lat"]) ?? numberAt(project.location, ["coordinates", "latitude"]) ?? numberAt(project.location, ["coordinates", "lat"])
  const longitude = numberAt(project.location, ["longitude"]) ?? numberAt(project.location, ["lng"]) ?? numberAt(project.location, ["coordinates", "longitude"]) ?? numberAt(project.location, ["coordinates", "lng"])
  if (latitude == null || longitude == null) return null
  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), start_date: date, end_date: date, daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum", temperature_unit: "fahrenheit", precipitation_unit: "inch", timezone: "auto" })
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8_000), next: { revalidate: 3600 } })
  if (!response.ok) return null
  const body = await response.json() as { daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_sum?: number[] } }
  const code = Number(body.daily?.weather_code?.[0] ?? 0)
  const high = Math.round(Number(body.daily?.temperature_2m_max?.[0] ?? 0))
  const low = Math.round(Number(body.daily?.temperature_2m_min?.[0] ?? 0))
  const precipitation = Number(body.daily?.precipitation_sum?.[0] ?? 0)
  const weather: ProjectDailyWeather = { conditions: condition(code), temperature: `${low}–${high}°F`, notes: precipitation > 0 ? `${precipitation.toFixed(2)} in precipitation` : "No precipitation forecast", source: "open_meteo", weather_code: code, high_f: high, low_f: low, precipitation_inches: precipitation }
  await supabase.from("project_weather_cache").upsert({ org_id: orgId, project_id: projectId, weather_date: date, provider: "open_meteo", weather }, { onConflict: "project_id,weather_date" })
  return weather
}
