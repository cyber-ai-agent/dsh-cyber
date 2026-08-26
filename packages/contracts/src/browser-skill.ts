import type { IsoTimestamp } from './index.js'

/** The official, read-only Browser capability package. */
export const BROWSER_PACKAGE_ID = 'official-browser'
export const BROWSER_ADAPTER_ID = 'builtin.browser'

export const BROWSER_SKILL_IDS = [
  'browser.open',
  'browser.read',
  'browser.extract',
  'browser.screenshot',
] as const

export type BrowserSkillId = (typeof BROWSER_SKILL_IDS)[number]
export type BrowserActionKind = 'open' | 'read' | 'extract' | 'screenshot'

/** Provider-neutral parameters accepted by the trusted host adapter. */
export interface BrowserActionParameters {
  url: string
  selector?: string
  width?: number
  height?: number
}

/**
 * Browser output is factual input from an untrusted external source. It is
 * deliberately separate from ordinary conversation text so callers cannot
 * mistake a page instruction for a host instruction.
 */
export interface BrowserFactualResult {
  kind: 'browser.factual-result'
  sourceUrl: string
  action: BrowserActionKind
  untrusted: true
  title?: string
  text?: string
  extracted?: Array<{ text: string; selector: string }>
  screenshot?: {
    width: number
    height: number
    byteLength: number
    artifactId?: string
    artifactVersion?: number
  }
  fetchedAt: IsoTimestamp
}
