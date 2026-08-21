import { describe, expect, it } from 'vitest'
import { HARNESS_COMPATIBILITY_MATRIX } from '../src/compatibility.js'
import { SUPPORTED_HARNESS_VERSION } from '../src/profile.js'

describe('DSH rc.8 compatibility', () => { it('pins the bundled and candidate runtime to rc.8', () => { expect(SUPPORTED_HARNESS_VERSION).toBe('0.1.0-rc.8'); expect(HARNESS_COMPATIBILITY_MATRIX.some((entry)=>entry.dshVersion==='0.1.0-rc.8')).toBe(true) }) })
