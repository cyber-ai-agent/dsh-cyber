import { getUiLocale } from './runtime.js'

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getUiLocale()).format(value)
}

/**
 * Token-style magnitude abbreviation (e.g. 1.2M, 340K, 12.5B). Wide tables
 * keep whole counts for readability elsewhere; token columns use this so a
 * row stays narrow. Values below 1_000 keep their exact digits.
 */
export function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) return `${trimFraction(value / 1_000_000_000)}B`
  if (absolute >= 1_000_000) return `${trimFraction(value / 1_000_000)}M`
  if (absolute >= 1_000) return `${trimFraction(value / 1_000)}K`
  return String(value)
}

function trimFraction(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

export function formatDateTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(getUiLocale(), options).format(date)
}

export function formatTime(value: string | number | Date): string {
  return formatDateTime(value, { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(value: string | number | Date): string {
  return formatDateTime(value, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return new Intl.NumberFormat(getUiLocale(), { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(milliseconds)
  }
  return new Intl.NumberFormat(getUiLocale(), { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(milliseconds / 1_000)
}
