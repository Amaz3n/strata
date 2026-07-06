export interface WeatherData {
  temperature: number
  condition: string
  windSpeed: number
}

export async function getCoordinatesFromAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(address)}&count=1&format=json`
    const response = await fetch(url)
    if (!response.ok) return null
    const data = await response.json()
    if (data.results && data.results.length > 0) {
      return {
        lat: data.results[0].latitude,
        lon: data.results[0].longitude,
      }
    }
    return null
  } catch (error) {
    console.error("Failed to fetch coordinates:", error)
    return null
  }
}

export function mapWmoCodeToLabel(code: number): string {
  // WMO Weather interpretation codes (WW)
  // https://open-meteo.com/en/docs
  if (code === 0) return "Sunny"
  if (code === 1 || code === 2) return "Partly Cloudy"
  if (code === 3) return "Cloudy"
  if ([45, 48].includes(code)) return "Cloudy" // Fog
  if ([51, 53, 55, 56, 57].includes(code)) return "Light Rain" // Drizzle
  if ([61, 63].includes(code)) return "Light Rain"
  if ([65, 66, 67, 80, 81, 82].includes(code)) return "Heavy Rain"
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Heavy Rain" // Snow mapped to rain for SWFL
  if ([95, 96, 99].includes(code)) return "Heavy Rain" // Thunderstorm
  return "Partly Cloudy" // Default fallback
}

export interface DailyWeather {
  condition: string
  tempMax: number | null
}

/**
 * Condition + high temp for one calendar day. Recent dates come from the
 * forecast API (which also serves the past ~3 months); older dates fall back
 * to the historical archive.
 */
export async function getDailyWeather(lat: number, lon: number, dateKey: string): Promise<DailyWeather | null> {
  try {
    const date = new Date(`${dateKey}T12:00:00`)
    const ageDays = (Date.now() - date.getTime()) / 86_400_000
    if (ageDays < 0) return null

    const host = ageDays > 85 ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast"
    const url = `${host}?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&start_date=${dateKey}&end_date=${dateKey}`
    const response = await fetch(url)
    if (!response.ok) return null
    const data = await response.json()

    const code = data.daily?.weather_code?.[0]
    if (code == null) return null
    const tempMax = data.daily?.temperature_2m_max?.[0] ?? null
    const windMax = data.daily?.wind_speed_10m_max?.[0] ?? null

    let condition = mapWmoCodeToLabel(code)
    // Only override calm conditions — a storm stays a storm even when it's hot.
    const isPrecip = /rain/i.test(condition)
    if (!isPrecip && windMax != null && windMax > 20) condition = "Windy"
    if (!isPrecip && tempMax != null && tempMax > 90) condition = "Hot"

    return { condition, tempMax: tempMax != null ? Math.round(tempMax) : null }
  } catch (error) {
    console.error("Failed to fetch daily weather:", error)
    return null
  }
}

export async function getCurrentWeather(lat: number, lon: number): Promise<WeatherData | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`
    const response = await fetch(url)
    if (!response.ok) return null
    const data = await response.json()

    if (data.current) {
      const temp = data.current.temperature_2m
      const windSpeed = data.current.wind_speed_10m
      let condition = mapWmoCodeToLabel(data.current.weather_code)

      // Override condition if extreme temperature or wind, but keep it simple if we just want base condition
      if (temp > 90) condition = "Hot" // Lowered threshold for SWFL "Hot"
      if (windSpeed > 20) condition = "Windy"

      return {
        temperature: temp,
        condition,
        windSpeed,
      }
    }
    return null
  } catch (error) {
    console.error("Failed to fetch weather:", error)
    return null
  }
}
