import type * as THREE from 'three'

/**
 * World pieces that bake GPU data once (planet surfaces) register here. The
 * Sky flushes the queue from its per-frame update — it always runs, outside
 * any render call, from the very first frames (under the loader) — so the
 * bakes never hitch a chapter cut. Each item may also bake itself lazily if
 * it gets rendered before the flush.
 */
export interface Bakeable {
  bake(renderer: THREE.WebGLRenderer): void
}

export const bakeQueue = new Set<Bakeable>()

export function flushBakes(renderer: THREE.WebGLRenderer) {
  if (!bakeQueue.size) return
  for (const item of [...bakeQueue]) {
    bakeQueue.delete(item)
    try {
      item.bake(renderer)
    } catch (err) {
      console.warn('[hark] bake failed', err)
    }
  }
}
