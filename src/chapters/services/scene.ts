import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { logoGeometry, logoParts } from '../../logo/logo'
import { Planet } from '../../world/Planet'
import { rng } from '../../core/math'
import type { Frame } from '../../core/types'
import * as S from './shaders'
import {
  AERIAL,
  COUNT,
  DEG,
  ECOM,
  RING_COUNT,
  SAT_RING,
  SPEED,
  STAR_R,
  WORLDS,
  focusCenter,
  focusPose,
  makePose,
  worldAngle,
  worldPosition,
} from './system'

const TAU = Math.PI * 2
const SAT_ORBIT = WORLDS[AERIAL].radius * 1.75

/** Everything 3D in the Orbit chapter. Pure view of state handed in each frame. */
export class OrbitScene {
  group = new THREE.Group()
  positions: THREE.Vector3[] = WORLDS.map(() => new THREE.Vector3())
  /** world-space position of the distant (next-chapter) planet */
  farPos = new THREE.Vector3()
  farRadius = 7.5
  satPos = new THREE.Vector3()

  private starMat: THREE.ShaderMaterial
  private coronaMat: THREE.ShaderMaterial
  private markMats: THREE.ShaderMaterial[] = []
  private worldMeshes: THREE.Mesh[] = []
  private worldMats: THREE.ShaderMaterial[] = []
  private glowMeshes: THREE.Mesh[] = []
  private glowMats: THREE.ShaderMaterial[] = []
  private hexShell: THREE.Mesh
  private hexMat: THREE.ShaderMaterial
  private seoHalo: THREE.Mesh
  private adaHalo: THREE.Mesh
  private reticle: THREE.Mesh
  private reticleMat: THREE.ShaderMaterial
  private orbitMat: THREE.ShaderMaterial
  orbits: THREE.Mesh
  private ring: THREE.Mesh
  private ringMat: THREE.ShaderMaterial
  private sat: THREE.Mesh
  private satMat: THREE.ShaderMaterial
  private dustMat: THREE.ShaderMaterial
  private planet: Planet
  private farHex: THREE.Mesh
  private farHexMat: THREE.ShaderMaterial
  private satBasis = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4().makeRotationY(0.6).multiply(new THREE.Matrix4().makeRotationX(34 * DEG)),
  )

  constructor(private mobile: boolean) {
    const g = this.group
    const star = new THREE.Vector3()

    /* ---- star core ---- */
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: S.worldVert,
      fragmentShader: S.starFrag,
      uniforms: { uTime: { value: 0 }, uHeat: { value: 1 } },
    })
    const starMesh = new THREE.Mesh(new THREE.SphereGeometry(STAR_R, 64, 48), this.starMat)
    g.add(starMesh)

    this.coronaMat = new THREE.ShaderMaterial({
      vertexShader: S.coronaVert,
      fragmentShader: S.coronaFrag,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 5.2 },
        uR: { value: STAR_R },
        uStrength: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.coronaMat)
    corona.frustumCulled = false
    g.add(corona)

    /* ---- the Hark mark, silhouetted against the star ---- */
    const parts = logoParts()
    const loopGeo = logoGeometry({ depth: 0.12, shapes: [...parts.loopA, ...parts.loopB], curveSegments: 32 })
    const diamondGeo = logoGeometry({ depth: 0.16, shapes: parts.diamond, bevelSize: 0.006 })
    for (const [geo, diamond] of [
      [loopGeo, 0],
      [diamondGeo, 1],
    ] as const) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: S.markVert,
        fragmentShader: S.markFrag,
        uniforms: {
          uScale: { value: 1.3 },
          uOffset: { value: STAR_R + 0.12 },
          uYaw: { value: 0 },
          uPitch: { value: 0 },
          uDiamond: { value: diamond },
          uHeat: { value: 1 },
          uTime: { value: 0 },
        },
      })
      const m = new THREE.Mesh(geo, mat)
      m.frustumCulled = false
      m.renderOrder = 2
      this.markMats.push(mat)
      g.add(m)
    }

    /* ---- worlds ---- */
    const sphere = mobile ? new THREE.SphereGeometry(1, 64, 44) : new THREE.SphereGeometry(1, 96, 64)
    const shell = new THREE.SphereGeometry(1, 48, 32)
    const worldBase = new THREE.ShaderMaterial({
      vertexShader: S.worldVert,
      fragmentShader: S.worldFrag,
      uniforms: {
        uKind: { value: 0 },
        uTime: { value: 0 },
        uSeed: { value: 0 },
        uFocus: { value: 0 },
        uHeal: { value: 0 },
        uSpin: { value: 0 },
        uTilt: { value: 0 },
        uDim: { value: 1 },
        uStar: { value: star },
        uAxis: { value: new THREE.Vector3(0, 1, 0) },
      },
    })
    const glowBase = new THREE.ShaderMaterial({
      vertexShader: S.shellVert,
      fragmentShader: S.glowFrag,
      uniforms: {
        uStar: { value: star },
        uCenter: { value: new THREE.Vector3() },
        uStrength: { value: 1 },
        uPower: { value: 2.2 },
        uEdge: { value: 0.5 },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    for (const w of WORLDS) {
      const mat = worldBase.clone()
      mat.uniforms.uKind.value = w.index
      mat.uniforms.uSeed.value = 1.7 + w.index * 3.13
      mat.uniforms.uTilt.value = w.tilt
      mat.uniforms.uStar.value = star
      mat.uniforms.uAxis.value = new THREE.Vector3(0, 1, 0)
      const mesh = new THREE.Mesh(sphere, mat)
      mesh.scale.setScalar(w.radius)
      g.add(mesh)
      this.worldMeshes.push(mesh)
      this.worldMats.push(mat)

      const k = w.index === 4 ? 1.35 : w.index === 10 ? 1.1 : 1.22
      const gm = glowBase.clone()
      gm.uniforms.uStar.value = star
      gm.uniforms.uEdge.value = Math.sqrt(1 - 1 / (k * k))
      gm.uniforms.uStrength.value = w.index === 10 ? 0.3 : w.index === 4 ? 0.55 : 0.6
      gm.uniforms.uPower.value = w.index === 4 ? 1.4 : 2.2
      const glow = new THREE.Mesh(shell, gm)
      glow.scale.setScalar(w.radius * k)
      g.add(glow)
      this.glowMeshes.push(glow)
      this.glowMats.push(gm)
    }
    worldBase.dispose()
    glowBase.dispose()

    /* ---- security: hex shield shell ---- */
    this.hexMat = new THREE.ShaderMaterial({
      vertexShader: S.shellVert,
      fragmentShader: S.hexShellFrag,
      uniforms: {
        uStar: { value: star },
        uTime: { value: 0 },
        uStrength: { value: 1 },
        uDensity: { value: 11 },
        uSpin: { value: 0 },
        uTilt: { value: 0.5 },
        uSweep: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.hexShell = new THREE.Mesh(shell, this.hexMat)
    this.hexShell.scale.setScalar(WORLDS[8].radius * 1.12)
    g.add(this.hexShell)

    /* ---- billboard halos ---- */
    const quad = new THREE.PlaneGeometry(2, 2)
    const halo = (mode: number, R: number, size: number, max: number) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: S.haloVert,
        fragmentShader: S.haloFrag,
        uniforms: {
          uMode: { value: mode },
          uTime: { value: 0 },
          uVis: { value: 1 },
          uMax: { value: max },
          uSize: { value: size },
          uR: { value: R },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      const m = new THREE.Mesh(quad, mat)
      m.frustumCulled = false
      g.add(m)
      return m
    }
    this.seoHalo = halo(0, WORLDS[3].radius, WORLDS[3].radius * 4.2, 4.1)
    this.adaHalo = halo(1, WORLDS[9].radius, WORLDS[9].radius * 3.7, 3.6)
    this.reticle = halo(2, 1, 1.9, 1.85)
    this.reticleMat = this.reticle.material as THREE.ShaderMaterial

    /* ---- orbit ribbons ---- */
    this.orbitMat = new THREE.ShaderMaterial({
      vertexShader: S.orbitVert,
      fragmentShader: S.orbitFrag,
      uniforms: {
        uBasis: { value: [...WORLDS.map(w => w.basis), this.satBasis] },
        uCenter: { value: Array.from({ length: RING_COUNT }, () => new THREE.Vector3()) },
        uRadius: { value: [...WORLDS.map(w => w.orbit), SAT_ORBIT] },
        uPlanet: { value: new Array(RING_COUNT).fill(0) },
        uFocus: { value: new Array(RING_COUNT).fill(0) },
        uGap: { value: [...WORLDS.map(w => (w.radius / w.orbit) * 1.35), 0.09] },
        uAlpha: { value: [...new Array(COUNT).fill(1), 0.9] },
        uPxWorld: { value: 0.001 },
        uTime: { value: 0 },
        uMaster: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    this.orbits = new THREE.Mesh(buildOrbitGeometry(), this.orbitMat)
    this.orbits.frustumCulled = false
    this.orbits.renderOrder = 1
    g.add(this.orbits)

    /* ---- ecommerce ring system ---- */
    const ew = WORLDS[ECOM]
    const inner = ew.radius * 1.35
    const outer = ew.radius * 2.3
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: S.ringVert,
      fragmentShader: S.ringFrag,
      uniforms: {
        uStar: { value: star },
        uPlanetPos: { value: this.positions[ECOM] },
        uPlanetR: { value: ew.radius },
        uInner: { value: inner },
        uOuter: { value: outer },
        uDim: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 1), this.ringMat)
    g.add(this.ring)

    /* ---- aerial satellite ---- */
    this.satMat = new THREE.ShaderMaterial({
      vertexShader: S.satVert,
      fragmentShader: S.satFrag,
      uniforms: { uStarDir: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 } },
    })
    this.sat = new THREE.Mesh(buildSatellite(), this.satMat)
    this.sat.scale.setScalar(0.5)
    g.add(this.sat)

    /* ---- distant planet (next chapter's shield world) ---- */
    const view = { aspect: 1.6, portrait: false }
    const last = WORLDS[COUNT - 1]
    const p10 = worldPosition(last, focusCenter(COUNT - 1), new THREE.Vector3())
    const pose = focusPose(last, p10, view, makePose())
    const fwd = pose.target.clone().sub(pose.pos).normalize()
    const right = fwd.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()
    const up = right.clone().cross(fwd)
    this.farPos.copy(pose.pos).addScaledVector(fwd, 70).addScaledVector(right, -17).addScaledVector(up, 9)
    const sunDir = this.farPos.clone().negate().normalize()
    this.planet = new Planet({
      radius: this.farRadius,
      seed: 5,
      cityLights: true,
      atmosphere: 0x00ff85,
      atmosphereStrength: 0.9,
      sunDirection: sunDir,
      spin: 0.01,
      mobile,
    })
    this.planet.group.position.copy(this.farPos)
    g.add(this.planet.group)
    this.farHexMat = this.hexMat.clone()
    this.farHexMat.uniforms.uStar.value = star
    this.farHexMat.uniforms.uDensity.value = 26
    this.farHexMat.uniforms.uStrength.value = 0.35
    this.farHex = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), this.farHexMat)
    this.farHex.scale.setScalar(this.farRadius * 1.035)
    this.farHex.position.copy(this.farPos)
    g.add(this.farHex)

    /* ---- dust: outer belt, disk dust, solar wind, exit stream ---- */
    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: S.dustVert,
      fragmentShader: S.dustFrag,
      uniforms: { uTime: { value: 0 }, uPxScale: { value: 500 }, uAlpha: { value: 0.8 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const dust = new THREE.Points(buildDust(mobile, pose.pos, this.farPos), this.dustMat)
    dust.frustumCulled = false
    g.add(dust)
  }

  /** Point a world's pattern axis (SEO beacon, ADA rings) along a world-space direction. */
  setAxis(k: number, dir: THREE.Vector3) {
    ;(this.worldMats[k].uniforms.uAxis.value as THREE.Vector3).copy(dir).normalize()
  }

  /** Per-frame state. `focus[k]` is 0..1 attention on world k. */
  update(
    local: number,
    frame: Frame,
    s: {
      focus: number[]
      reticleWorld: number
      reticleVis: number
      heal: number
      coreHeat: number
      orbitMaster: number
      farHex: number
      pxWorld: number
      pxScale: number
    },
  ) {
    const t = frame.time * (frame.reducedMotion ? 0.3 : 1)
    this.starMat.uniforms.uTime.value = t
    this.starMat.uniforms.uHeat.value = s.coreHeat
    this.coronaMat.uniforms.uTime.value = t
    this.coronaMat.uniforms.uStrength.value = s.coreHeat
    for (const m of this.markMats) {
      m.uniforms.uTime.value = t
      m.uniforms.uHeat.value = 0.8 + 0.4 * s.coreHeat
      m.uniforms.uYaw.value = Math.sin(t * 0.21) * 0.16 + (local - 0.5) * 0.3
      m.uniforms.uPitch.value = Math.sin(t * 0.17 + 1.3) * 0.07
    }

    const planetAngles = this.orbitMat.uniforms.uPlanet.value as number[]
    const ringFocus = this.orbitMat.uniforms.uFocus.value as number[]
    for (const w of WORLDS) {
      const k = w.index
      const p = worldPosition(w, local, this.positions[k])
      const f = s.focus[k]
      const mesh = this.worldMeshes[k]
      mesh.position.copy(p)
      const u = this.worldMats[k].uniforms
      u.uTime.value = t
      u.uFocus.value = f
      u.uSpin.value = t * w.spin + local * 3.0
      u.uDim.value = 0.7 + 0.3 * f
      u.uHeal.value = s.heal
      this.glowMeshes[k].position.copy(p)
      const gu = this.glowMats[k].uniforms
      gu.uCenter.value.copy(p)
      planetAngles[k] = worldAngle(w, local)
      ringFocus[k] = f
    }

    // hex shield around security
    this.hexShell.position.copy(this.positions[8])
    this.hexMat.uniforms.uTime.value = t
    this.hexMat.uniforms.uSpin.value = t * 0.05
    this.hexMat.uniforms.uSweep.value = Math.sin(t * 0.6) * 1.1
    this.hexMat.uniforms.uStrength.value = 0.55 + 0.6 * s.focus[8]

    // halos
    this.seoHalo.position.copy(this.positions[3])
    this.adaHalo.position.copy(this.positions[9])
    ;(this.seoHalo.material as THREE.ShaderMaterial).uniforms.uTime.value = t
    ;(this.seoHalo.material as THREE.ShaderMaterial).uniforms.uVis.value = 0.14 + 0.86 * s.focus[3]
    ;(this.adaHalo.material as THREE.ShaderMaterial).uniforms.uTime.value = t
    ;(this.adaHalo.material as THREE.ShaderMaterial).uniforms.uVis.value = 0.12 + 0.88 * s.focus[9]
    const rw = WORLDS[s.reticleWorld]
    const rR = rw.radius * Math.max(1, rw.vis * 0.78)
    this.reticle.position.copy(this.positions[s.reticleWorld])
    this.reticleMat.uniforms.uR.value = rR
    this.reticleMat.uniforms.uSize.value = rR * 1.9
    this.reticleMat.uniforms.uVis.value = s.reticleVis
    this.reticleMat.uniforms.uTime.value = t
    this.reticle.visible = s.reticleVis > 0.002

    // ecommerce rings: equatorial, tilted with the body
    const ep = this.positions[ECOM]
    this.ring.position.copy(ep)
    this.ring.rotation.set(-Math.PI / 2 + 0.38, 0.2, 0)
    this.ringMat.uniforms.uDim.value = 0.75 + 0.25 * s.focus[ECOM]

    // satellite around the aerial world
    const ap = this.positions[AERIAL]
    const sa = t * 0.35 + local * 9.0
    planetAngles[SAT_RING] = sa
    ringFocus[SAT_RING] = s.focus[AERIAL]
    ;(this.orbitMat.uniforms.uCenter.value as THREE.Vector3[])[SAT_RING].copy(ap)
    this.satPos.set(Math.cos(sa) * SAT_ORBIT, 0, Math.sin(sa) * SAT_ORBIT).applyMatrix3(this.satBasis).add(ap)
    this.sat.position.copy(this.satPos)
    this.sat.lookAt(ap)
    this.sat.rotateZ(t * 0.2)
    ;(this.satMat.uniforms.uStarDir.value as THREE.Vector3).copy(this.satPos).negate().normalize()
    this.satMat.uniforms.uTime.value = t

    this.orbitMat.uniforms.uTime.value = t
    this.orbitMat.uniforms.uPxWorld.value = s.pxWorld
    this.orbitMat.uniforms.uMaster.value = s.orbitMaster

    this.dustMat.uniforms.uTime.value = t
    this.dustMat.uniforms.uPxScale.value = s.pxScale

    this.planet.update(frame)
    this.farHexMat.uniforms.uTime.value = t
    this.farHexMat.uniforms.uSpin.value = t * 0.02
    this.farHexMat.uniforms.uSweep.value = Math.sin(t * 0.4) * 1.1
    this.farHexMat.uniforms.uStrength.value = s.farHex
  }
}

/* ------------------------------------------------------------------ */

function buildOrbitGeometry() {
  const ring: number[] = []
  const angle: number[] = []
  const rad: number[] = []
  const side: number[] = []
  const kind: number[] = []
  const tt: number[] = []
  const index: number[] = []
  let v = 0
  const strip = (count: number, fn: (i: number) => [number, number, number], r: number, k: number) => {
    const start = v
    for (let i = 0; i < count; i++) {
      const [a, rd, t] = fn(i)
      for (const sd of [-1, 1]) {
        ring.push(r)
        angle.push(a)
        rad.push(rd)
        side.push(sd)
        kind.push(k)
        tt.push(t)
      }
      v += 2
    }
    for (let i = 0; i < count - 1; i++) {
      const a = start + i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  for (let r = 0; r < RING_COUNT; r++) {
    const segs = r === SAT_RING ? 128 : 400
    strip(segs + 1, i => [(i / segs) * TAU, 1, 0], r, 0)
  }
  for (let r = 0; r < COUNT; r++) {
    const n = 48
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + 0.04 * r
      const len = j % 12 === 0 ? 0.32 : j % 4 === 0 ? 0.15 : 0.07
      strip(2, i => [a, i === 0 ? 0.03 : 0.03 + len, 0], r, 1)
    }
  }
  const tailSegs = 72
  const gap = (WORLDS[SPEED].radius / WORLDS[SPEED].orbit) * 1.1
  strip(tailSegs + 1, i => [-gap - (i / tailSegs) * 1.05, 1, i / tailSegs], SPEED, 2)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(v * 3), 3))
  geo.setAttribute('aRing', new THREE.Float32BufferAttribute(ring, 1))
  geo.setAttribute('aAngle', new THREE.Float32BufferAttribute(angle, 1))
  geo.setAttribute('aRad', new THREE.Float32BufferAttribute(rad, 1))
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  geo.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1))
  geo.setIndex(index)
  return geo
}

function buildSatellite() {
  const withEmit = (geo: THREE.BufferGeometry, e: number) => {
    const n = geo.attributes.position.count
    geo.setAttribute('aEmit', new THREE.Float32BufferAttribute(new Float32Array(n).fill(e), 1))
    return geo
  }
  const body = withEmit(new THREE.BoxGeometry(0.05, 0.05, 0.075), 0)
  const p1 = withEmit(new THREE.BoxGeometry(0.2, 0.004, 0.06).translate(0.135, 0, 0), 0)
  const p2 = withEmit(new THREE.BoxGeometry(0.2, 0.004, 0.06).translate(-0.135, 0, 0), 0)
  const beacon = withEmit(new THREE.SphereGeometry(0.014, 10, 8).translate(0, 0.034, 0.02), 1)
  const dish = withEmit(new THREE.ConeGeometry(0.03, 0.03, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.05), 0)
  const merged = mergeGeometries([body, p1, p2, beacon, dish])
  return merged ?? body
}

function buildDust(mobile: boolean, exitFrom: THREE.Vector3, exitTo: THREE.Vector3) {
  const r = rng(42)
  const scale = mobile ? 0.5 : 1
  const belt = Math.round(3200 * scale)
  const disk = Math.round(2000 * scale)
  const wind = Math.round(600 * scale)
  const stream = Math.round(900 * scale)
  const n = belt + disk + wind + stream
  const pos = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const seed = new Float32Array(n)
  let i = 0
  const put = (x: number, y: number, z: number, s: number) => {
    pos[i * 3] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
    size[i] = s
    seed[i] = r()
    i++
  }
  for (let k = 0; k < belt; k++) {
    const a = r() * TAU
    const rr = 15.2 + Math.pow(r(), 0.7) * 2.8 + Math.sin(a * 3) * 0.3
    put(Math.cos(a) * rr, (r() - 0.5) * 0.5 * (1 + r()), Math.sin(a) * rr, 0.012 + r() * r() * 0.03)
  }
  for (let k = 0; k < disk; k++) {
    const a = r() * TAU
    const rr = 1.6 + Math.pow(r(), 0.8) * 13
    put(Math.cos(a) * rr, (r() - 0.5) * 0.35, Math.sin(a) * rr, 0.003 + r() * 0.006)
  }
  for (let k = 0; k < wind; k++) {
    const d = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
    const rr = 0.95 + Math.pow(r(), 1.5) * 2.6
    put(d.x * rr, d.y * rr, d.z * rr, 0.003 + r() * 0.005)
  }
  const dir = exitTo.clone().sub(exitFrom)
  const len = dir.length()
  dir.normalize()
  const a1 = new THREE.Vector3(0, 1, 0).cross(dir).normalize()
  const a2 = dir.clone().cross(a1)
  for (let k = 0; k < stream; k++) {
    const t = r() * 0.85
    const a = r() * TAU
    const rr = 0.6 + r() * 4.5
    const p = exitFrom
      .clone()
      .addScaledVector(dir, t * len)
      .addScaledVector(a1, Math.cos(a) * rr)
      .addScaledVector(a2, Math.sin(a) * rr)
    put(p.x, p.y, p.z, 0.008 + r() * 0.016)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  return geo
}
