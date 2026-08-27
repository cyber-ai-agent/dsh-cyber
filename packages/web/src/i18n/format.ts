import { getUiLocale } from './runtime.js'

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getUiLocale()).format(value)
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
