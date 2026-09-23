import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Planet } from '../../world/Planet'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { Bricks } from './bricks'
import { Hologram } from './hologram'
import { Solid } from './solid'
import { Network } from './network'
import { HeroUI } from './ui'
import { MARK_SCALE, T } from './shared'
import './hero.css'

/*
 * HERO — "Signal". Hark means listen: the mark is picked up as a faint signal
 * and tuned in until it comes through loud and clear.
 *   0.00–0.08  SIGNAL    hologram of the mark over a planet, constellation network
 *   0.08–0.49  TUNING IN debris belt → bricks spiral in and lock on (green flash → gunmetal)
 *   0.49–0.66  CLEAR     scan-line dissolve into the polished chrome mark + signal core
 *   0.68–0.93  PAYOFF    pull back over the horizon, "Make the internet listen."
 *   0.93–1.00  OUT       dive into the glowing core → flash cut into the Work
 *                        chapter's field of crystal artifacts
 */

const MARK_POS = new THREE.Vector3(0, 0.3, 0)

interface Key {
  t: number
  az: number
  el: number
  dist: number
  /** landscape framing offset (camera right / up, world units) */
  tx: number
  ty: number
  /** portrait framing offset */
  px: number
  py: number
  fov: number
  roll: number
}
type Prop = Exclude<keyof Key, 't'>

// prettier-ignore
const KEYS: Key[] = [
  { t: 0.0,  az: -0.1,  el: 0.1,   dist: 8.4, tx: 0.3,   ty: -0.5,  px: 0, py: -0.35, fov: 34, roll: 0 },
  { t: 0.08, az: -0.03, el: 0.09,  dist: 7.6, tx: 0.2,   ty: -0.38, px: 0, py: -0.3,  fov: 34, roll: 0 },
  { t: 0.22, az: 0.2,   el: 0.15,  dist: 6.2, tx: 0,     ty: -0.1,  px: 0, py: -0.05, fov: 35, roll: 0.02 },
  { t: 0.37, az: 0.36,  el: 0.1,   dist: 5.5, tx: 0,     ty: 0,     px: 0, py: 0,     fov: 35, roll: 0.012 },
  { t: 0.48, az: 0.42,  el: 0.05,  dist: 5.2, tx: 0,     ty: 0,     px: 0, py: 0,     fov: 34, roll: 0 },
  { t: 0.59, az: 0.12,  el: 0.0,   dist: 5.0, tx: 0,     ty: 0,     px: 0, py: 0,     fov: 33, roll: -0.01 },
  { t: 0.7,  az: -0.17, el: 0.08,  dist: 7.0, tx: -1.62, ty: -0.45, px: 0, py: -1.12, fov: 34, roll: 0 },
  { t: 0.8,  az: -0.22, el: 0.1,   dist: 7.4, tx: -1.78, ty: -0.5,  px: 0, py: -1.25, fov: 34, roll: 0 },
  { t: 0.93, az: -0.18, el: 0.09,  dist: 7.0, tx: -1.72, ty: -0.48, px: 0, py: -1.2,  fov: 34, roll: 0 },
]

/** Smooth monotone cubic through the keys (no stops at each key). */
function sample(t: number, prop: Prop): number {
  const n = KEYS.length
  if (t <= KEYS[0].t) return KEYS[0][prop]
  if (t >= KEYS[n - 1].t) return KEYS[n - 1][prop]
  let i = 0
  while (i < n - 2 && t > KEYS[i + 1].t) i++
  const k0 = KEYS[i]
  const k1 = KEYS[i + 1]
  const h = k1.t - k0.t
  const s = (t - k0.t) / h
  const slope = (j: number) => {
    if (j <= 0 || j >= n - 1) return 0
    const a = KEYS[j - 1],
      b = KEYS[j],
      c = KEYS[j + 1]
    const d0 = (b[prop] - a[prop]) / (b.t - a.t)
    const d1 = (c[prop] - b[prop]) / (c.t - b.t)
    if (d0 * d1 <= 0) return 0
    return (2 * d0 * d1) / (d0 + d1)
  }
  const m0 = slope(i) * h
  const m1 = slope(i + 1) * h
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * k0[prop] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * k1[prop] + (s3 - s2) * m1
}

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const markRoot = new THREE.Group()
  markRoot.position.copy(MARK_POS)
  markRoot.scale.setScalar(MARK_SCALE)
  group.add(markRoot)

  let planet: Planet
  let bricks: Bricks
  let holo: Hologram
  let solid: Solid
  let network: Network
  let ui: HeroUI
  let revealAt = -1
  let initAt = 0
  let warm = 0
  let reduced = false

  const coreWorld = new THREE.Vector3()
  const tmpA = new THREE.Vector3()
  const tmpB = new THREE.Vector3()
  const right = new THREE.Vector3()
  const toWorld = (v: THREE.Vector3, out: THREE.Vector3) => out.copy(v).applyMatrix4(markRoot.matrixWorld)

  const now = () => performance.now() / 1000

  return {
    id: 'hero',
    group,

    init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      initAt = now()

      planet = new Planet({
        radius: 22,
        seed: 7,
        cityLights: true,
        atmosphere: 0x5cffb8,
        atmosphereStrength: 1.0,
        atmosphereMie: 0.5,
        sunDirection: new THREE.Vector3(0.5, -0.04, -0.86).normalize(),
        sunIntensity: 2.0,
        lightsIntensity: 0.5,
        clouds: 0.36,
        spin: 0.006,
        mobile: ctx.mobile,
      })
      planet.group.position.set(0, -24.4, -8)
      group.add(planet.group)

      bricks = new Bricks(ctx.mobile)
      markRoot.add(bricks.mesh)

      holo = new Hologram(ctx.mobile ? 0.026 : 0.019)
      markRoot.add(holo.group)

      solid = new Solid(ctx.renderer, ctx.mobile)
      markRoot.add(solid.group)

      markRoot.updateMatrixWorld(true)
      network = new Network(ctx.mobile, markRoot.matrixWorld.clone())
      group.add(network.group)
      markRoot.add(network.orbits)

      ui = new HeroUI(ctx.stage)
      ui.addCallouts(bricks.infos, ctx.mobile)

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
        ui.playIntro(ctx.reducedMotion)
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const t = frame.time
      const motion = reduced ? 0.25 : 1
      const clock = now()
      // power on once the loader has handed over. The event listener is the fast path;
      // polling the ready flag covers a reveal that fired before init, and a long
      // safety net covers a loader that never signals at all.
      if (revealAt < 0 && (document.documentElement.dataset.ready === '1' || clock - initAt > 20)) {
        revealAt = clock
        ui.playIntro(reduced)
      }

      // ---- power-on flicker (time-based, once) ----
      let on = revealAt < 0 ? 0 : clamp((clock - revealAt - 0.15) / 1.25)
      let flicker = 1
      if (revealAt >= 0 && on < 1) {
        flicker = hash(Math.floor(clock * 22)) < 0.3 + on * 0.85 ? 1 : 0.12
      } else if (!reduced) {
        flicker = 1 - 0.3 * (hash(Math.floor(clock * 13)) > 0.975 ? 1 : 0)
      }
      if (reduced && revealAt >= 0) on = Math.max(on, 0.999)

      // ---- idle float ----
      markRoot.position.set(MARK_POS.x, MARK_POS.y + Math.sin(t * 0.5) * 0.035 * motion, MARK_POS.z)
      markRoot.rotation.set(Math.sin(t * 0.31) * 0.015 * motion, Math.sin(t * 0.23) * 0.035 * motion, 0)
      group.updateMatrixWorld(true)

      // ---- phases ----
      const holoFade = 1 - smoothstep(T.holoFadeA, T.holoFadeB, local)
      const reveal = lerp(-0.16, 1.06, ease.inOutQuad(segment(local, T.resolveA, T.resolveB)))
      const outP = segment(local, T.outA, 1)
      const push = Math.pow(outP, 1.7)

      // first update is the engine's prewarm: show everything so every program compiles
      const warming = warm++ < 1

      const faceFade = 1 - smoothstep(0.1, 0.3, local)
      holo.update(warming ? 1 : on, warming ? 1 : holoFade, flicker, t, motion, warming ? 1 : faceFade)
      bricks.update(local, t, reveal, motion, 1)
      const payoff = smoothstep(T.payoffA - 0.02, T.payoffA + 0.1, local)
      const coreBase = lerp(0.85, 1.1, smoothstep(T.resolveA, T.resolveB, local)) + payoff * 0.2
      const coreOn = revealAt < 0 ? 0 : Math.min(1, on * 1.2) * (on < 1 ? flicker : 1)
      const core = (warming ? 1 : coreOn) * (coreBase + push * 2.6)
      const halo = (warming ? 1 : coreOn) * (0.09 + payoff * 0.05 + push * 1.1)
      solid.update(warming ? 0.5 : reveal, core, halo, 0.3, t, motion)
      solid.setHaloScale(0.6 + push * 1.4)

      const netFade = lerp(1, 0.4, smoothstep(0.25, 0.6, local)) * (warming ? 1 : Math.max(on, 0.001))
      const orbitFade =
        (0.9 * (1 - smoothstep(T.landEnd - 0.05, T.resolveA + 0.07, local)) + 0.55 * smoothstep(T.payoffA + 0.01, T.payoffA + 0.11, local)) *
        (1 - push) *
        (warming ? 1 : on)
      const dpr = ctx.renderer.getPixelRatio()
      const pointScale = (frame.height * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2))
      network.update(netFade, orbitFade, local * 5 + t * 0.05 * motion, t, motion, pointScale)

      planet.spinAngle = local * 0.22
      planet.update(frame)

      // core position for the dive
      toWorld(solid.coreCenter, coreWorld)

      // ---- post + sky ----
      const pp = ctx.post.params
      pp.bloomStrength = 0.85 + 0.12 * (1 - smoothstep(0.05, 0.2, local)) + push * 0.9
      pp.bloomRadius = 0.42 + push * 0.3
      pp.aberration = 0.0025 + push * 0.004
      pp.flash = Math.pow(segment(local, 0.97, 1), 2.4) * 0.28
      pp.exposure = 1 + push * 0.2
      pp.glitch = revealAt >= 0 && on < 1 && flicker < 1 ? 0.18 : 0
      const sp = ctx.sky.params
      sp.warp = smoothstep(0.95, 1, local) * 0.85
      sp.nebula = 0.9

      // ---- DOM ----
      const landed = bricks.landed(local)
      ui.update(local, landed, bricks.buildCount, segment(local, T.resolveA + 0.02, T.resolveB - 0.015), frame.dt, clock, reduced)
      ui.updateCallouts(local, ctx.camera, frame.width, frame.height, toWorld, frame.dt, clock)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      const q = clamp((1.25 - aspect) / 0.8)
      const tl = Math.min(local, T.outA)
      const idle = reduced ? 0 : 1
      const az = sample(tl, 'az') + Math.sin(frame.time * 0.11) * 0.012 * idle
      const el = sample(tl, 'el') + Math.sin(frame.time * 0.09) * 0.008 * idle
      const dist = sample(tl, 'dist') * (1 + 0.2 * q)
      const fov = sample(tl, 'fov') + 15 * q
      const ox = lerp(sample(tl, 'tx'), sample(tl, 'px'), q)
      const oy = lerp(sample(tl, 'ty'), sample(tl, 'py'), q)

      right.set(Math.cos(az), 0, -Math.sin(az))
      const target = tmpA.copy(MARK_POS).addScaledVector(right, ox)
      target.y += oy
      const dir = tmpB.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
      out.position.copy(target).addScaledVector(dir, dist)
      out.target.copy(target)
      out.fov = fov
      out.roll = sample(tl, 'roll')
      out.parallax = 0.42

      // ---- OUT: dive into the signal core ----
      if (local > T.outA) {
        const o = segment(local, T.outA, 1)
        const turn = ease.inOutCubic(smoothstep(0, 0.42, o))
        const push = Math.pow(o, 1.7)
        const from = out.position.clone().sub(coreWorld)
        const len0 = from.length()
        from.normalize()
        const endDir = new THREE.Vector3(0.02, 0.04, 1).normalize()
        const d = from.lerp(endDir, turn).normalize()
        const len = lerp(len0, 0.36, push)
        out.target.lerp(coreWorld, turn)
        out.position.copy(coreWorld).addScaledVector(d, len)
        out.fov = lerp(fov, 60, push * push)
        out.roll = lerp(out.roll, -0.08, push)
        out.parallax = 0.42 * (1 - turn)
      }
    },
  }
}
