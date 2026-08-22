import { describe, expect, it } from 'vitest'
import { HARNESS_COMPATIBILITY_MATRIX } from '../src/compatibility.js'
import { SUPPORTED_HARNESS_VERSION } from '../src/profile.js'

describe('DSH 0.1.1-rc.1 compatibility', () => { it('pins the bundled and candidate runtime to 0.1.1-rc.1', () => { expect(SUPPORTED_HARNESS_VERSION).toBe('0.1.1-rc.1'); expect(HARNESS_COMPATIBILITY_MATRIX.some((entry)=>entry.dshVersion==='0.1.1-rc.1')).toBe(true) }) })
