import * as THREE from 'three'
import type { Frame } from '../core/types'

/**
 * Reusable procedural planet.
 *
 * STUB — the World agent replaces the internals. Keep the public API:
 *   new Planet(opts), .group, .update(frame), .setSunDirection(v)
 */
export interface PlanetOptions {
  radius: number
  seed?: number
  /** dark surface base color */
  colorA?: THREE.ColorRepresentation
  /** lighter surface highlight color */
  colorB?: THREE.ColorRepresentation
  /** atmosphere rim glow color (defaults to brand signal green) */
  atmosphere?: THREE.ColorRepresentation
  atmosphereStrength?: number
  /** flat ring system around the equator */
  rings?: boolean
  /** glowing green "network" lines + city lights on the night side */
  cityLights?: boolean
  /** world-space direction the light comes FROM (normalized) */
  sunDirection?: THREE.Vector3
  /** radians per second of self-rotation */
  spin?: number
  /** lower detail for mobile */
  mobile?: boolean
}

export class Planet {
  group = new THREE.Group()
  opts: Required<Omit<PlanetOptions, 'seed' | 'mobile'>> & { seed: number; mobile: boolean }
  private body: THREE.Mesh

  constructor(opts: PlanetOptions) {
    this.opts = {
      seed: 1,
      colorA: 0x05080a,
      colorB: 0x1a2a2a,
      atmosphere: 0x00ff85,
      atmosphereStrength: 1,
      rings: false,
      cityLights: false,
      sunDirection: new THREE.Vector3(-0.6, 0.5, 0.6).normalize(),
      spin: 0.01,
      mobile: false,
      ...opts,
    }
    this.body = new THREE.Mesh(
      new THREE.SphereGeometry(this.opts.radius, 96, 64),
      new THREE.MeshStandardMaterial({ color: this.opts.colorB, roughness: 0.9 }),
    )
    this.group.add(this.body)
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.copy(this.opts.sunDirection).multiplyScalar(100)
    this.group.add(light)
  }

  setSunDirection(v: THREE.Vector3) {
    this.opts.sunDirection.copy(v).normalize()
  }

  update(frame: Frame) {
    this.body.rotation.y += this.opts.spin * frame.dt
  }
}
