import * as THREE from 'three'
import type { Frame } from '../core/types'
import { rng } from '../core/math'
import { snoise, fbm } from './cpuNoise'
import {
  ARC_FRAG,
  ARC_VERT,
  ATMO_FRAG,
  ATMO_VERT,
  BODY_FRAG,
  BODY_VERT,
  NODE_FRAG,
  NODE_VERT,
  RING_FRAG,
  RING_VERT,
} from './planetShaders'

/**
 * Reusable cinematic procedural planet.
 *
 *   const planet = new Planet({ radius: 10, cityLights: true, rings: true })
 *   group.add(planet.group)            // position / tilt / scale the group freely
 *   planet.update(frame)               // every frame
 *   planet.setSunDirection(dir)        // world-space direction light comes FROM
 *
 * Layers: fbm continents + oceans with relief shading and a sun glint,
 * drifting cloud deck, soft terminator, green city lights + a data network of
 * arcs/nodes on the night side, an analytically ray-marched atmosphere shell
 * (rim scattering that blooms on the lit limb, forward-scatter glow when the
 * sun is behind the planet), and optional banded rings with planet shadow
 * (and ring shadows cast back onto the surface).
 *
 * Most options can be changed at runtime by editing `planet.opts.*`; they're
 * pushed to the GPU on the next update(). (`rings`, `cityLights`, `network`,
 * `seed`, `mobile`, `radius` are construction-time.)
 */
export interface PlanetOptions {
  radius: number
  seed?: number
  /** dark surface base color */
  colorA?: THREE.ColorRepresentation
  /** lighter surface highlight color */
  colorB?: THREE.ColorRepresentation
  /** atmosphere rim glow color (defaults to a brand green-teal) */
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

  // ---- optional extras (all have defaults) ----
  /** atmosphere shell thickness as a fraction of the radius (default 0.05) */
  atmosphereThickness?: number
  /** strength of the forward-scatter sun glow in the atmosphere (default 1) */
  atmosphereMie?: number
  /** cloud coverage 0..1 (default 0.36, 0 = no clouds) */
  clouds?: number
  /** radians per second the cloud deck drifts relative to the ground (default 0.006) */
  cloudDrift?: number
  /** city lights + network brightness multiplier (default 1) */
  lightsIntensity?: number
  /** show the arc/node data network above the night side (default = cityLights) */
  network?: boolean
  /** how visible the network stays on the day side, 0..1 (default 0.03) */
  networkDay?: number
  /** fraction of the surface covered by ocean, 0..1 (default 0.6) */
  ocean?: number
  /** terrain relief shading strength (default 1) */
  relief?: number
  /** polar ice caps 0..1 (default 0.4) */
  ice?: number
  /** sunlight intensity on the surface (default 2.4) */
  sunIntensity?: number
  /** sunlight color (default a neutral warm white) */
  sunColor?: THREE.ColorRepresentation
  /** ring inner / outer radius in planet radii (defaults 1.45 / 2.35) */
  ringInner?: number
  ringOuter?: number
  ringColor?: THREE.ColorRepresentation
  /** 0..1 ring opacity (default 0.78) */
  ringOpacity?: number
}

type ResolvedOptions = Required<Omit<PlanetOptions, 'seed' | 'mobile'>> & { seed: number; mobile: boolean }

const _v = new THREE.Vector3()
const _c = new THREE.Vector3()
const _s = new THREE.Vector3()

export class Planet {
  group = new THREE.Group()
  opts: ResolvedOptions
  /** Base self-rotation (radians). Add scroll-driven rotation here; spin*time is added on top. */
  spinAngle = 0
  /** The spinning part (surface + network). Children rotate with the ground. */
  readonly spinner = new THREE.Group()
  readonly body: THREE.Mesh
  readonly atmosphereMesh: THREE.Mesh
  readonly ringMesh: THREE.Mesh | null = null

  private uniforms: Record<string, THREE.IUniform>
  private bodyMat: THREE.ShaderMaterial
  private atmoMat: THREE.ShaderMaterial
  private ringMat: THREE.ShaderMaterial | null = null
  private arcMat: THREE.ShaderMaterial | null = null
  private nodeMat: THREE.ShaderMaterial | null = null
  private tmpSize = new THREE.Vector2()
  private seedVec: THREE.Vector3
  private oceanLevel: number
  private popLevel: number

  constructor(options: PlanetOptions) {
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as PlanetOptions
    const cityLights = defined.cityLights ?? false
    this.opts = {
      seed: 1,
      colorA: 0x080c0e,
      colorB: 0x44463f,
      atmosphere: 0x2bffc0,
      atmosphereStrength: 1,
      rings: false,
      cityLights,
      sunDirection: new THREE.Vector3(-0.6, 0.5, 0.6),
      spin: 0.01,
      mobile: false,
      atmosphereThickness: 0.05,
      atmosphereMie: 1,
      clouds: 0.36,
      cloudDrift: 0.006,
      lightsIntensity: 1,
      network: cityLights,
      networkDay: 0.03,
      ocean: 0.6,
      relief: 1,
      ice: 0.4,
      sunIntensity: 2.4,
      sunColor: 0xfff4e8,
      ringInner: 1.45,
      ringOuter: 2.35,
      ringColor: 0xb9c3c4,
      ringOpacity: 0.78,
      ...defined,
    }
    // never alias (and later mutate) a vector the caller owns
    this.opts.sunDirection = this.opts.sunDirection.clone().normalize()
    const o = this.opts
    const R = o.radius
    const mobile = o.mobile
    const r = rng(Math.floor(o.seed * 7919) + 17)
    const seedVec = new THREE.Vector3(r() * 60 - 30, r() * 60 - 30, r() * 60 - 30)

    // sea level / population thresholds from the actual noise distribution
    const { ocean, pop } = this.calibrate(seedVec, o.ocean)
    this.seedVec = seedVec
    this.oceanLevel = ocean
    this.popLevel = pop

    this.uniforms = {
      uSun: { value: o.sunDirection.clone() },
      uSunColor: { value: new THREE.Color(o.sunColor) },
      uSunIntensity: { value: o.sunIntensity },
      uR: { value: R },
      uRa: { value: R * (1 + o.atmosphereThickness) },
      uAtm: { value: new THREE.Color(o.atmosphere) },
      uTime: { value: 0 },
      uRings: { value: o.rings ? 1 : 0 },
      uRingIn: { value: o.ringInner },
      uRingOut: { value: o.ringOuter },
      uRingSeed: { value: Math.floor(r() * 1000) },
    }
    const U = this.uniforms

    // ---- body
    const seg = mobile ? 160 : 256
    this.bodyMat = new THREE.ShaderMaterial({
      vertexShader: BODY_VERT,
      fragmentShader: BODY_FRAG,
      defines: { TERRAIN_OCT: mobile ? 5 : 7, CLOUD_OCT: mobile ? 4 : 5, NET_LEVELS: mobile ? 1 : 2 },
      uniforms: {
        ...U,
        uSeed: { value: seedVec },
        uColA: { value: new THREE.Color(o.colorA) },
        uColB: { value: new THREE.Color(o.colorB) },
        uOcean: { value: ocean },
        uPopT: { value: pop },
        uClouds: { value: o.clouds },
        uCloudRot: { value: 0 },
        uLights: { value: o.cityLights ? o.lightsIntensity : 0 },
        uRelief: { value: o.relief },
        uIce: { value: o.ice },
      },
    })
    this.body = new THREE.Mesh(new THREE.SphereGeometry(R, seg, seg / 2), this.bodyMat)
    this.spinner.add(this.body)
    this.group.add(this.spinner)

    // ---- atmosphere (analytic ray march inside a bounding shell)
    this.atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      defines: { ATMO_STEPS: mobile ? 7 : 12 },
      uniforms: {
        ...U,
        uAtmStrength: { value: o.atmosphereStrength },
        uMie: { value: o.atmosphereMie },
        uFalloff: { value: 0.13 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.FrontSide,
    })
    this.atmosphereMesh = new THREE.Mesh(
      new THREE.SphereGeometry(R * (1 + o.atmosphereThickness) * 1.02, mobile ? 96 : 128, mobile ? 48 : 64),
      this.atmoMat,
    )
    this.atmosphereMesh.renderOrder = 1
    this.atmosphereMesh.onBeforeRender = (_r, _s2, camera) => {
      // inside the shell we have to draw its back faces
      this.atmosphereMesh.getWorldPosition(_c)
      this.atmosphereMesh.getWorldScale(_s)
      const ra = this.uniforms.uRa.value * _s.x * 1.01
      const side = camera.position.distanceTo(_c) < ra ? THREE.BackSide : THREE.FrontSide
      if (this.atmoMat.side !== side) {
        this.atmoMat.side = side
        this.atmoMat.needsUpdate = true
      }
    }
    this.group.add(this.atmosphereMesh)

    // ---- rings
    if (o.rings) {
      const g = new THREE.RingGeometry(R * o.ringInner, R * o.ringOuter, mobile ? 160 : 256, 1)
      g.rotateX(-Math.PI / 2)
      this.ringMat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          ...U,
          uRingColor: { value: new THREE.Color(o.ringColor) },
          uRingOpacity: { value: o.ringOpacity },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      })
      const ring = new THREE.Mesh(g, this.ringMat)
      ring.renderOrder = 2
      this.ringMesh = ring
      this.group.add(ring)
    }

    // ---- network (arcs + nodes) on the night side
    if (o.cityLights && o.network) this.buildNetwork(seedVec, ocean, pop, r)
  }

  /** Terrain / population thresholds from the real noise distribution. */
  private calibrate(seed: THREE.Vector3, oceanFrac: number) {
    const n = 1400
    const hs: number[] = []
    const ps: number[] = []
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2
      const rad = Math.sqrt(1 - y * y)
      const th = Math.PI * (3 - Math.sqrt(5)) * i
      const x = Math.cos(th) * rad
      const z = Math.sin(th) * rad
      hs.push(terrainCPU(x, y, z, seed, 4))
      ps.push(snoise(x * 4.5 + seed.y, y * 4.5 + seed.x, z * 4.5 + seed.z) * 0.5 + 0.5)
    }
    hs.sort((a, b) => a - b)
    ps.sort((a, b) => a - b)
    const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * arr.length)))]
    return { ocean: q(hs, THREE.MathUtils.clamp(oceanFrac, 0, 0.98)), pop: q(ps, 0.45) }
  }

  private buildNetwork(seed: THREE.Vector3, ocean: number, popT: number, r: () => number) {
    const o = this.opts
    const R = o.radius
    const maxNodes = o.mobile ? 30 : 48
    // candidates: jittered fibonacci lattice, scored by land + population
    const M = 2400
    const cands: { v: THREE.Vector3; s: number }[] = []
    for (let i = 0; i < M; i++) {
      const y = 1 - ((i + r() * 0.8) / M) * 2
      const rad = Math.sqrt(Math.max(0, 1 - y * y))
      const th = Math.PI * (3 - Math.sqrt(5)) * i + r() * 0.05
      const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad)
      if (Math.abs(v.y) > 0.8) continue // no cities under the ice
      const h = terrainCPU(v.x, v.y, v.z, seed, 5)
      if (h < ocean + 0.02) continue
      const p = snoise(v.x * 4.5 + seed.y, v.y * 4.5 + seed.x, v.z * 4.5 + seed.z) * 0.5 + 0.5
      cands.push({ v, s: p - popT + r() * 0.08 })
    }
    cands.sort((a, b) => b.s - a.s)
    const nodes: THREE.Vector3[] = []
    const minAng = 0.17
    for (const c of cands) {
      if (nodes.length >= maxNodes) break
      if (nodes.every(n => n.angleTo(c.v) > minAng)) nodes.push(c.v)
    }
    if (nodes.length < 3) return

    // edges: nearest neighbours + a few long-haul links
    const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)
    const edges = new Map<string, [number, number]>()
    nodes.forEach((a, i) => {
      const near = nodes
        .map((b, j) => ({ j, d: a.angleTo(b) }))
        .filter(e => e.j !== i && e.d < 0.95)
        .sort((x, y) => x.d - y.d)
        .slice(0, 2)
      for (const e of near) edges.set(key(i, e.j), [i, e.j])
    })
    const longHaul = o.mobile ? 4 : 7
    for (let k = 0; k < longHaul * 4 && edges.size < nodes.length * 2 + longHaul; k++) {
      const i = Math.floor(r() * nodes.length)
      const j = Math.floor(r() * nodes.length)
      const d = nodes[i].angleTo(nodes[j])
      if (i !== j && d > 0.7 && d < 1.9) edges.set(key(i, j), [i, j])
    }

    const pos: number[] = []
    const ts: number[] = []
    const arc: number[] = []
    const q = new THREE.Quaternion()
    const axis = new THREE.Vector3()
    const pt = new THREE.Vector3()
    for (const [i, j] of edges.values()) {
      const a = nodes[i]
      const b = nodes[j]
      const ang = a.angleTo(b)
      axis.crossVectors(a, b).normalize()
      const segs = Math.max(10, Math.ceil(ang * 48))
      const lift = 0.004 + ang * 0.018
      const seedA = r()
      let prev: [number, number, number, number] | null = null
      for (let s = 0; s <= segs; s++) {
        const t = s / segs
        q.setFromAxisAngle(axis, ang * t)
        pt.copy(a).applyQuaternion(q).multiplyScalar(R * (1.004 + lift * Math.sin(Math.PI * t)))
        const cur: [number, number, number, number] = [pt.x, pt.y, pt.z, t]
        if (prev) {
          pos.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2])
          ts.push(prev[3], cur[3])
          arc.push(seedA, ang, seedA, ang)
        }
        prev = cur
      }
    }
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    lg.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1))
    lg.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 2))
    this.arcMat = new THREE.ShaderMaterial({
      vertexShader: ARC_VERT,
      fragmentShader: ARC_FRAG,
      uniforms: {
        uSun: this.uniforms.uSun,
        uTime: this.uniforms.uTime,
        uLights: { value: o.lightsIntensity },
        uDay: { value: o.networkDay },
        uPulse: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const lines = new THREE.LineSegments(lg, this.arcMat)
    lines.renderOrder = 3
    this.spinner.add(lines)

    const np: number[] = []
    const ns: number[] = []
    const nseed: number[] = []
    const degree = new Array(nodes.length).fill(0)
    for (const [i, j] of edges.values()) {
      degree[i]++
      degree[j]++
    }
    nodes.forEach((n, i) => {
      _v.copy(n).multiplyScalar(R * 1.004)
      np.push(_v.x, _v.y, _v.z)
      // node size in units of uNodeScale (world); hubs (degree >= 4) bigger
      ns.push(degree[i] >= 4 ? 0.9 : 0.55)
      nseed.push(r())
    })
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.Float32BufferAttribute(np, 3))
    pg.setAttribute('aSize', new THREE.Float32BufferAttribute(ns, 1))
    pg.setAttribute('aSeed', new THREE.Float32BufferAttribute(nseed, 1))
    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      uniforms: {
        uSun: this.uniforms.uSun,
        uTime: this.uniforms.uTime,
        uLights: { value: o.lightsIntensity },
        uDay: { value: o.networkDay },
        uPulse: { value: 1 },
        uResY: { value: 1000 },
        uPx: { value: 1 },
        uNodeScale: { value: 0.012 * R },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(pg, this.nodeMat)
    points.renderOrder = 3
    points.onBeforeRender = renderer => {
      renderer.getDrawingBufferSize(this.tmpSize)
      this.nodeMat!.uniforms.uResY.value = this.tmpSize.y
      this.nodeMat!.uniforms.uPx.value = renderer.getPixelRatio()
    }
    this.spinner.add(points)
  }

  /**
   * Sample the (low-detail) surface at an object-space direction: terrain
   * height relative to sea level, whether it's land, and 0..1 population
   * (where the city lights cluster). Handy for placing markers on land.
   * Note the surface rotates with `spinner`; convert world directions with
   * `planet.spinner.worldToLocal` (or rotate by -spin) first.
   */
  surfaceAt(dir: THREE.Vector3) {
    _v.copy(dir).normalize()
    const h = terrainCPU(_v.x, _v.y, _v.z, this.seedVec, 5) - this.oceanLevel
    const p = snoise(_v.x * 4.5 + this.seedVec.y, _v.y * 4.5 + this.seedVec.x, _v.z * 4.5 + this.seedVec.z) * 0.5 + 0.5
    const population = THREE.MathUtils.smoothstep(p, this.popLevel, this.popLevel + 0.3)
    return { height: h, land: h > 0, population: h > 0 ? population : 0 }
  }

  setSunDirection(v: THREE.Vector3) {
    this.opts.sunDirection.copy(v).normalize()
  }

  update(frame: Frame) {
    const o = this.opts
    const U = this.uniforms
    const t = frame.time
    const calm = frame.reducedMotion ? 0.35 : 1
    U.uTime.value = t
    U.uSun.value.copy(o.sunDirection).normalize()
    ;(U.uSunColor.value as THREE.Color).set(o.sunColor)
    U.uSunIntensity.value = o.sunIntensity
    ;(U.uAtm.value as THREE.Color).set(o.atmosphere)
    this.spinner.rotation.y = this.spinAngle + o.spin * t * calm

    const bu = this.bodyMat.uniforms
    ;(bu.uColA.value as THREE.Color).set(o.colorA)
    ;(bu.uColB.value as THREE.Color).set(o.colorB)
    bu.uClouds.value = o.clouds
    bu.uCloudRot.value = o.cloudDrift * t * calm
    bu.uLights.value = o.cityLights ? o.lightsIntensity : 0
    bu.uRelief.value = o.relief
    bu.uIce.value = o.ice

    const au = this.atmoMat.uniforms
    au.uAtmStrength.value = o.atmosphereStrength
    au.uMie.value = o.atmosphereMie

    if (this.ringMat) {
      ;(this.ringMat.uniforms.uRingColor.value as THREE.Color).set(o.ringColor)
      this.ringMat.uniforms.uRingOpacity.value = o.ringOpacity
    }
    for (const m of [this.arcMat, this.nodeMat]) {
      if (!m) continue
      m.uniforms.uLights.value = o.cityLights ? o.lightsIntensity : 0
      m.uniforms.uDay.value = o.networkDay
      m.uniforms.uPulse.value = calm
    }
  }
}

/** CPU twin of the GLSL terrain() (fewer octaves) — used to place cities on land. */
function terrainCPU(px: number, py: number, pz: number, seed: THREE.Vector3, octaves: number) {
  let qx = px * 1.3 + seed.x
  let qy = py * 1.3 + seed.y
  let qz = pz * 1.3 + seed.z
  const wx = snoise(qx * 0.8 + 11.3, qy * 0.8, qz * 0.8)
  const wy = snoise(qx * 0.8 - 7.1, qy * 0.8 + 3.3, qz * 0.8 + 5.9)
  const wz = snoise(qx * 0.8 + 2.7, qy * 0.8 - 9.4, qz * 0.8 + 1.3)
  qx += wx * 0.45
  qy += wy * 0.45
  qz += wz * 0.45
  return fbm(qx * 1.4, qy * 1.4, qz * 1.4, octaves)
}
