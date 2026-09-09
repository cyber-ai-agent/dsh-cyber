import type { Locator } from '@playwright/test'

export interface VisualAudit {
  /** Smallest rendered font size among visible text nodes. */
  minFontSize: number
  /** Smallest effective opacity of a text node (a parent dimming shows up here). */
  minOpacity: number
  /** Smallest contrast ratio between a text node and its effective background. */
  minContrast: number
  /** Worst horizontal overflow inside the audited subtree. */
  overflow: number
  /** Elements whose text could not be measured, for honest reporting. */
  unmeasured: number
}

/**
 * The parts of the visual gate that can be measured instead of eyeballed.
 *
 * Font size, parent-opacity dimming and contrast are objective: measuring them
 * in the real rendered page is stronger evidence than a screenshot alone.
 * Screenshots still go to the owner for the subjective half (layout taste,
 * whether the block reads well).
 */
export async function auditVisuals(target: Locator): Promise<VisualAudit> {
  return target.evaluate((root) => {
    const parseColor = (value: string): [number, number, number, number] | undefined => {
      const match = /rgba?\(([^)]+)\)/.exec(value)
      if (match === null) return undefined
      const parts = match[1]!.split(',').map((entry) => Number(entry.trim()))
      if (parts.length < 3 || parts.some((entry) => !Number.isFinite(entry))) return undefined
      return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1]
    }
    const luminance = ([red, green, blue]: [number, number, number, number]): number => {
      const channel = (value: number): number => {
        const normalized = value / 255
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const effectiveBackground = (element: Element): [number, number, number, number] => {
      let current: Element | null = element
      while (current !== null) {
        const color = parseColor(getComputedStyle(current).backgroundColor)
        if (color !== undefined && color[3] >= 0.99) return color
        current = current.parentElement
      }
      return [255, 255, 255, 1]
    }
    const effectiveOpacity = (element: Element): number => {
      let opacity = 1
      let current: Element | null = element
      while (current !== null) {
        opacity *= Number(getComputedStyle(current).opacity)
        current = current.parentElement
      }
      return opacity
    }
    const ratio = (left: number, right: number): number => {
      const lighter = Math.max(left, right)
      const darker = Math.min(left, right)
      return (lighter + 0.05) / (darker + 0.05)
    }

    let minFontSize = Number.POSITIVE_INFINITY
    let minOpacity = 1
    let minContrast = Number.POSITIVE_INFINITY
    let unmeasured = 0
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const text = (element.textContent ?? '').trim()
      if (text === '' || element.children.length > 0) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const fontSize = Number.parseFloat(style.fontSize)
      if (Number.isFinite(fontSize)) minFontSize = Math.min(minFontSize, fontSize)
      minOpacity = Math.min(minOpacity, effectiveOpacity(element))
      const foreground = parseColor(style.color)
      if (foreground === undefined) { unmeasured += 1; continue }
      const background = effectiveBackground(element)
      minContrast = Math.min(minContrast, ratio(luminance(foreground), luminance(background)))
    }

    let overflow = 0
    for (const element of [root, ...root.querySelectorAll('*')]) {
      overflow = Math.max(overflow, element.scrollWidth - element.clientWidth)
    }
    return {
      minFontSize: Number.isFinite(minFontSize) ? minFontSize : 0,
      minOpacity,
      minContrast: Number.isFinite(minContrast) ? minContrast : 0,
      overflow,
      unmeasured,
    }
  })
}
