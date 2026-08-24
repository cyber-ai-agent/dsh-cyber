import { describe, expect, it } from 'vitest'
import { minimumCoverageZoom } from '../src/features/world/renderer/pixi-world-renderer.js'

describe('world renderer coverage', () => {
  it('fills a tall 4K world pane even when coverage exceeds the interactive zoom ceiling', () => {
    const viewport = { width: 960, height: 2_048 }
    const scene = { width: 1_600, height: 900 }
    const containScale = Math.min(viewport.width / scene.width, viewport.height / scene.height)

    const zoom = minimumCoverageZoom(viewport.width, viewport.height, scene.width, scene.height, containScale)

    expect(zoom).toBeGreaterThan(2.2)
    expect(scene.width * containScale * zoom).toBeGreaterThanOrEqual(viewport.width)
    expect(scene.height * containScale * zoom).toBeGreaterThanOrEqual(viewport.height)
  })

  it('fills a wide world pane after the surrounding navigation changes width', () => {
    const viewport = { width: 1_520, height: 760 }
    const scene = { width: 1_536, height: 1_024 }
    const containScale = Math.min(viewport.width / scene.width, viewport.height / scene.height)

    const zoom = minimumCoverageZoom(viewport.width, viewport.height, scene.width, scene.height, containScale)

    expect(scene.width * containScale * zoom).toBeGreaterThanOrEqual(viewport.width)
    expect(scene.height * containScale * zoom).toBeGreaterThanOrEqual(viewport.height)
  })
})
