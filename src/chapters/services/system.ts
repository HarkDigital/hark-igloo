import * as THREE from 'three'
import { ease, lerp, segment } from '../../core/math'

/*
 * The Orbit star system: data for the 11 service worlds, the scroll timeline
 * and every camera pose. Everything here is a pure function of `local`
 * (plus the viewport aspect), so jumping straight to any scroll position
 * always produces the same frame.
 */

export const DEG = Math.PI / 180
export const COUNT = 11
/** orbit ribbons: 11 service orbits + the aerial world's satellite orbit */
export const RING_COUNT = 12
export const SAT_RING = 11
export const AERIAL = 6
export const SPEED = 4
export const HACK = 7
export const ECOM = 2
export const STAR_R = 0.42

/** Scroll timeline (chapter-local 0..1). */
export const TL = {
  /** camera has emerged from the logo core */
  emergeEnd: 0.08,
  /** establishing shot starts travelling to the first world */
  holdEnd: 0.1,
  /** first service slot starts */
  s0: 0.13,
  /** last service slot ends; exit beat begins */
  s1: 0.94,
}
export const SLOT = (TL.s1 - TL.s0) / COUNT
/** local progress at which service k is centered */
export const focusCenter = (k: number) => TL.s0 + SLOT * (k + 0.5)
/** continuous focus coordinate: equals k at the center of service k */
export const focusCoord = (local: number) => (local - TL.s0) / SLOT - 0.5

export interface World {
  index: number
  radius: number
  orbit: number
  incl: number
  node: number
  /** orbital angle (in the orbit's own frame) at the moment it is focused */
  phase: number
  /** radians of orbital motion per unit of local scroll */
  omega: number
  tilt: number
  spin: number
  /** camera azimuth around the world, measured from the outward radial, degrees */
  beta: number
  /** camera elevation, degrees */
  alpha: number
  /** on-screen size multiplier when focused */
  size: number
  /** visual radius multiplier (rings, satellites) */
  vis: number
  basis: THREE.Matrix3
  /** fake telemetry */
  period: number
}

// radius, incl°, node°, beta°, alpha°, axial tilt, spin rad/s, size, vis
const SPEC: [number, number, number, number, number, number, number, number, number][] = [
  [0.34, 4, 20, 64, 11, 0.35, 0.1, 1.0, 1.0], // 01 software development — circuit glow
  [0.4, -7, 80, 72, 15, -0.25, 0.07, 1.0, 1.0], // 02 web design — lat/long wireframe
  [0.44, 10, 140, 58, 21, 0.42, 0.06, 0.95, 2.1], // 03 ecommerce — ringed giant
  [0.3, -4, 200, 76, 12, 0.85, 0.06, 1.0, 1.35], // 04 seo / geo — radar beacon
  [0.2, 12, 260, 84, 14, 0.1, 0.3, 0.9, 1.3], // 05 page speed — comet
  [0.38, -9, 320, 54, 9, 0.3, 0.06, 1.0, 1.0], // 06 ai — neural filaments
  [0.33, 6, 30, 82, 16, 0.4, 0.05, 1.0, 1.7], // 07 aerial — survey world + satellite
  [0.36, -12, 100, 50, 8, -0.3, 0.05, 1.0, 1.0], // 08 hack remediation — healing cracks
  [0.4, 3, 170, 62, 13, 0.25, 0.04, 1.0, 1.15], // 09 security — hex shield shell
  [0.36, 8, 230, 88, 18, 0.95, 0.05, 1.0, 1.4], // 10 ada — concentric pulses
  [0.4, -5, 300, 148, 9, 0.05, 0.02, 1.0, 1.0], // 11 wordpress — classic moon
]

const PHASE0 = -20 * DEG
const PHASE_STEP = 68 * DEG

export const WORLDS: World[] = SPEC.map(([radius, incl, node, beta, alpha, tilt, spin, size, vis], index) => {
  const orbit = 2.55 + index * 1.06
  const basis = new THREE.Matrix3().setFromMatrix4(
    new THREE.Matrix4().makeRotationY(node * DEG).multiply(new THREE.Matrix4().makeRotationX(incl * DEG)),
  )
  // choose the orbit-frame phase so the focus azimuths march evenly around the star
  const phase = PHASE0 + index * PHASE_STEP + node * DEG
  return {
    index,
    radius,
    orbit,
    incl: incl * DEG,
    node: node * DEG,
    phase,
    omega: 1.9 * Math.pow(2.55 / orbit, 1.5),
    tilt,
    spin,
    beta,
    alpha,
    size,
    vis,
    basis,
    period: Math.pow(orbit, 1.5) * 1.37,
  }
})

export const worldAngle = (w: World, local: number) => w.phase + w.omega * (local - focusCenter(w.index))

export function worldPosition(w: World, local: number, out: THREE.Vector3) {
  const a = worldAngle(w, local)
  return out.set(Math.cos(a) * w.orbit, 0, Math.sin(a) * w.orbit).applyMatrix3(w.basis)
}

/* ------------------------------------------------------------------ */
/* camera poses                                                        */
/* ------------------------------------------------------------------ */

export interface Pose {
  pos: THREE.Vector3
  target: THREE.Vector3
  fov: number
  roll: number
}

export const makePose = (): Pose => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 40, roll: 0 })

export function copyPose(src: Pose, out: Pose) {
  out.pos.copy(src.pos)
  out.target.copy(src.target)
  out.fov = src.fov
  out.roll = src.roll
  return out
}

export interface View {
  aspect: number
  portrait: boolean
}

const UP = new THREE.Vector3(0, 1, 0)
const _u = new THREE.Vector3()
const _m = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _view = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()

/** Frame a world: it sits right of center (desktop) or high (portrait). */
export function focusPose(w: World, P: THREE.Vector3, view: View, out: Pose) {
  const portrait = view.portrait
  const fov = portrait ? 50 : 38
  const tanV = Math.tan((fov * DEG) / 2)
  // fraction of the viewport height the body's visual diameter should take
  const frac = (portrait ? Math.min(0.44 * view.aspect, 0.3) : 0.25) * w.size
  const rEff = w.radius * (1 + (w.vis - 1) * 0.55)
  const d = rEff / (frac * tanV)

  _u.set(P.x, 0, P.z).normalize()
  _m.set(-_u.z, 0, _u.x)
  const b = w.beta * DEG
  const a = w.alpha * DEG
  _dir
    .copy(_u)
    .multiplyScalar(Math.cos(b))
    .addScaledVector(_m, Math.sin(b))
    .multiplyScalar(Math.cos(a))
    .addScaledVector(UP, Math.sin(a))
    .normalize()
  out.pos.copy(P).addScaledVector(_dir, d)

  _view.copy(_dir).negate()
  _right.crossVectors(_view, UP).normalize()
  _up.crossVectors(_right, _view)
  const nx = portrait ? 0.0 : 0.2
  const ny = portrait ? 0.3 : 0.06
  out.target
    .copy(P)
    .addScaledVector(_right, -nx * d * tanV * view.aspect)
    .addScaledVector(_up, -ny * d * tanV)
  out.fov = fov
  out.roll = 0
  return out
}

interface Cyl {
  r: number
  a: number
  y: number
}
const toCyl = (v: THREE.Vector3, c: Cyl) => {
  c.r = Math.hypot(v.x, v.z)
  c.a = Math.atan2(v.z, v.x)
  c.y = v.y
  return c
}
const angLerp = (a: number, b: number, t: number) => {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
const cA: Cyl = { r: 0, a: 0, y: 0 }
const cB: Cyl = { r: 0, a: 0, y: 0 }

/**
 * Blend two poses by swinging around the star (cylindrical interpolation)
 * so the camera arcs through the system instead of cutting across it.
 * `bump` lifts and pulls back mid-flight so the system reads between stops.
 */
export function blendPose(A: Pose, B: Pose, t: number, bump: number, out: Pose) {
  const arc = Math.sin(Math.PI * t)
  toCyl(A.pos, cA)
  toCyl(B.pos, cB)
  const r = lerp(cA.r, cB.r, t) + arc * bump * 1.2
  const a = angLerp(cA.a, cB.a, t)
  const y = lerp(cA.y, cB.y, t) + arc * bump * 1.6
  out.pos.set(Math.cos(a) * r, y, Math.sin(a) * r)
  toCyl(A.target, cA)
  toCyl(B.target, cB)
  const tr = lerp(cA.r, cB.r, t)
  const ta = angLerp(cA.a, cB.a, t)
  out.target.set(Math.cos(ta) * tr, lerp(cA.y, cB.y, t) - arc * bump * 0.35, Math.sin(ta) * tr)
  // mid-flight the gaze drifts back toward the star so the system reads in transit
  out.target.multiplyScalar(1 - arc * 0.24)
  out.fov = lerp(A.fov, B.fov, t) + arc * bump * 2.5
  out.roll = lerp(A.roll, B.roll, t)
  return out
}

/** Wide establishing shot of the whole orrery. */
export function establishPose(local: number, view: View, azimuth: number, out: Pose) {
  const portrait = view.portrait
  const az = azimuth + (local - TL.emergeEnd) * 0.9
  // portrait looks down steeper so the rings stack tall and fill the screen
  const rho = portrait ? 28.5 : 21.5
  const y = portrait ? 25 : 10.2
  out.pos.set(Math.cos(az) * rho, y, Math.sin(az) * rho)
  out.target.set(0, portrait ? -3.4 : -0.9, 0)
  out.fov = portrait ? 58 : 42
  out.roll = 0
  return out
}

const _ed = new THREE.Vector3()
/** Emerge from the glowing diamond of the logo core and pull back to the establishing shot. */
export function emergePose(local: number, E: Pose, out: Pose) {
  // log-distance pull-back: glare-filled at the cut, a whoosh through the
  // inner system around 0.04, then an easy settle into the wide shot
  const s = segment(local, 0, TL.emergeEnd)
  const e = ease.inOutQuad(s)
  _ed.copy(E.pos).sub(E.target)
  const dE = _ed.length()
  const elE = Math.asin(_ed.y / dE)
  const azE = Math.atan2(_ed.z, _ed.x)
  const el = lerp(0.04, elE, ease.inOutQuad(e))
  const az = azE + (1 - e) * 0.9
  const dist = Math.exp(lerp(Math.log(0.8), Math.log(dE), e))
  out.target.copy(E.target).multiplyScalar(e)
  out.pos.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(dist).add(out.target)
  out.fov = lerp(56, E.fov, e)
  out.roll = (1 - e) * (1 - e) * 0.42
  return out
}
