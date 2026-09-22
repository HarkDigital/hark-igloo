import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el } from '../../core/dom'

// PLACEHOLDER — replaced by the work chapter build.
export default function create(): Chapter {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.4, 1),
    new THREE.MeshBasicMaterial({ color: 0x00ff85, wireframe: true }),
  )
  group.add(mesh)
  return {
    id: 'work',
    group,
    init(ctx) {
      el('p', 'hud-eyebrow', 'Artifacts', ctx.stage).style.cssText = 'position:absolute;left:var(--gutter);top:var(--safe-top)'
      el('h2', 'hud-h2', 'Selected work', ctx.stage).style.cssText = 'position:absolute;left:var(--gutter);top:calc(var(--safe-top) + 28px)'
    },
    update(local, frame) {
      mesh.rotation.set(local * 3, frame.time * 0.2, 0)
    },
    camera(_local, _frame, out) {
      out.position.set(0, 0, 6)
      out.target.set(0, 0, 0)
      out.fov = 45
      out.parallax = 0.4
    },
  }
}
