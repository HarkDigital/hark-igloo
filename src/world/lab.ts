import * as THREE from 'three'
import type { Chapter } from '../core/types'
import { Planet } from './Planet'

// Dev preview for the world pieces (?only=lab-world). Owned by the World build.
export default function create(): Chapter {
  const group = new THREE.Group()
  const planet = new Planet({ radius: 10, cityLights: true })
  group.add(planet.group)
  return {
    id: 'lab-world',
    group,
    init() {},
    update(_local, frame) {
      planet.update(frame)
    },
    camera(local, _frame, out) {
      out.position.set(0, 4, 30 - local * 12)
      out.target.set(0, 0, 0)
      out.fov = 40
    },
  }
}
