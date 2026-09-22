import * as THREE from 'three'
import type { Frame } from '../core/types'

/**
 * Always-on space backdrop: nebula dome + starfield, centered on the camera
 * so it reads as infinitely far away.
 *
 * STUB — the World agent replaces the internals. Keep the public API:
 *   object, params, resetParams(), update(frame, camera)
 */
export interface SkyParams {
  /** 0..1 hyperspace: stars stretch into streaks along view direction */
  warp: number
  /** 0..1 nebula brightness multiplier */
  nebula: number
  /** 0..1 star brightness multiplier */
  stars: number
  /** -1..1 shifts the nebula palette (0 = brand teal/green, -1 = cold violet, 1 = warm) */
  hue: number
}

export const SKY_DEFAULTS: SkyParams = { warp: 0, nebula: 1, stars: 1, hue: 0 }

export class Sky {
  object = new THREE.Group()
  params: SkyParams = { ...SKY_DEFAULTS }
  private current: SkyParams = { ...SKY_DEFAULTS }
  private stars: THREE.Points

  constructor(private mobile: boolean) {
    const n = mobile ? 2500 : 6000
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(600)
      pos.set([v.x, v.y, v.z], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0xffffff, depthWrite: false }),
    )
    this.stars.frustumCulled = false
    this.object.add(this.stars)
    this.object.renderOrder = -10
  }

  resetParams() {
    Object.assign(this.params, SKY_DEFAULTS)
  }

  update(frame: Frame, camera: THREE.PerspectiveCamera) {
    const k = 1 - Math.exp(-4 * frame.dt)
    for (const key of Object.keys(this.params) as (keyof SkyParams)[]) {
      this.current[key] += (this.params[key] - this.current[key]) * k
    }
    this.object.position.copy(camera.position)
    ;(this.stars.material as THREE.PointsMaterial).opacity = this.current.stars
  }
}
