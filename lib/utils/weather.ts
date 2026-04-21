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
