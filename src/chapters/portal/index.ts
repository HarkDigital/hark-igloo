import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { Scramble } from '../../core/scramble'
import { clamp, damp, ease, lerp, rng, segment, smoothstep, window01 } from '../../core/math'
import { BRAND } from '../../content'
import {
  GATE,
  createCollapse,
  createCore,
  createDial,
  createHorizon,
  createLockArcs,
  createRing,
  createRush,
  createTicks,
  makeShared,
} from './gate'
import './portal.css'

/*
 * GATE — the segmented ring portal.
 *
 *   0.00–0.10  energy lines collapse into a point → the core ignites
 *   0.10–0.60  segments fly in and lock like a gate dialing; gimbal rings align
 *   0.60–0.85  the core swells into a rippling event horizon
 *   0.85–1.00  fly through: warp, flash, glitch → cut to Arrival
 */

const FLY = 0.13
const KEYSTONES = [9, 0, 27, 18] // N, E, S, W (segment i sits at angle i·10°)

/**
 * Threshold-triggered decode: plays the time-based scramble ONCE when `on`
 * flips true (or the text changes), clears when it flips false. Settles to the
 * exact text within `duration` no matter where the scroll comes to rest.
 */
class Decode {
  private s: Scramble
  private on = false
  private text = ''
  constructor(node: HTMLElement) {
    this.s = new Scramble(node, '')
  }
  set(text: string, on: boolean, duration = 0.6, delay = 0) {
    if (on) {
      if (!this.on || text !== this.text) {
        this.on = true
        this.text = text
        this.s.play(text, { duration, delay })
      }
    } else if (this.on) {
      this.on = false
      this.text = ''
      this.s.clear()
    }
  }
}

/** a soft 0→1→0 bump centred on c with half-width w */
const bump = (v: number, c: number, w: number) => Math.exp(-(((v - c) / w) ** 2))

interface Seg {
  theta: number
  start: THREE.Vector3
  startQ: THREE.Quaternion
  finalQ: THREE.Quaternion
  final: THREE.Vector3
  radial: THREE.Vector3
  tumble: THREE.Vector3
  tLock: number
  lamp: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const shared = makeShared()
  let mobile = false
  let motion = 1

  let ring!: ReturnType<typeof createRing>
  let dial!: ReturnType<typeof createDial>
  let ticks!: ReturnType<typeof createTicks>
  let ticksInner!: ReturnType<typeof createTicks>
  let core!: ReturnType<typeof createCore>
  let lockArcs!: ReturnType<typeof createLockArcs>
  let horizon!: ReturnType<typeof createHorizon>
  let collapse!: ReturnType<typeof createCollapse>
  let rush!: ReturnType<typeof createRush>
  const segs: Seg[] = []
  const locks = new Float32Array(GATE.N)
  const flashes = new Float32Array(GATE.N)

  // HUD
  const hud = {} as {
    left: HTMLElement
    right: HTMLElement
    cue: HTMLElement
    pct: HTMLElement
    ticks: HTMLElement[]
    locked: HTMLElement
    dest: Decode
    status: Scramble
    flux: HTMLElement
    coord: Decode
    phase: string
    callout: Callout
    calloutState: Decode
    calloutTemp: HTMLElement
    key: Callout
  }

  const m4 = new THREE.Matrix4()
  const m4b = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const q2 = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  const keyScale = new THREE.Vector3(0.46, 0.46, 1.6)
  const coreWorld = new THREE.Vector3()
  const keyWorld = new THREE.Vector3()
  const segMats: THREE.Matrix4[] = []
  // 0..1: is there room for each callout's label on screen? (damped, no popping)
  let fitCore = 0
  let fitKey = 0

  /** True when a right-side callout's label lands fully inside the gutters and under the header. */
  function room(c: Callout, anchor: THREE.Vector3, frame: Frame, cam: THREE.Camera) {
    p.copy(anchor).project(cam)
    if (p.z > 1) return 0
    const x = (p.x * 0.5 + 0.5) * frame.width
    const y = (-p.y * 0.5 + 0.5) * frame.height
    const g = clamp(frame.width * 0.034, 16, 44)
    const safeTop = clamp(frame.height * 0.11, 84, 118)
    const right = x + c.offset.x + 8 + c.label.offsetWidth
    const top = y + c.offset.y - 10
    return right <= frame.width - g && top >= safeTop ? 1 : 0
  }

  function buildHud(stage: HTMLElement) {
    const h = el('h2', 'sr-only', `Transit gate: aligning to ${BRAND.short}`, stage)
    h.setAttribute('aria-live', 'off')

    const leftWrap = el('div', 'gt-side gt-side--left', undefined, stage)
    leftWrap.setAttribute('aria-hidden', 'true')
    const left = el('div', 'gt-panel', undefined, leftWrap)
    el('p', 'hud-eyebrow', 'Transit gate', left)
    const read = el('div', 'gt-readout', undefined, left)
    el('span', 'hud-label', 'Gate alignment', read)
    const big = el('div', 'gt-pct', undefined, read)
    const pct = el('span', 'gt-pct-num', '000', big)
    el('span', 'gt-pct-unit', '%', big)
    const bar = el('div', 'gt-bar', undefined, left)
    const tks: HTMLElement[] = []
    for (let i = 0; i < GATE.N; i++) tks.push(el('i', '', undefined, bar))
    const row = el('div', 'gt-row hud-label', undefined, left)
    el('span', '', 'Segments locked', row)
    const locked = el('span', 'gt-row-val', '00/36', row)

    const rightWrap = el('div', 'gt-side gt-side--right', undefined, stage)
    rightWrap.setAttribute('aria-hidden', 'true')
    const right = el('div', 'gt-panel gt-panel--tele', undefined, rightWrap)
    const dl = el('dl', 'gt-tele', undefined, right)
    const rowOf = (k: string, cls = '') => {
      const d = el('div', `gt-tele-row ${cls}`, undefined, dl)
      el('dt', '', k, d)
      return el('dd', '', '', d)
    }
    const dest = rowOf('Destination', 'is-dest')
    const status = rowOf('Status')
    const flux = rowOf('Core flux', 'is-extra')
    const coord = rowOf('Coordinates', 'is-extra')

    const cueWrap = el('div', 'gt-cue-wrap', undefined, stage)
    cueWrap.setAttribute('aria-hidden', 'true')
    const cue = el('div', 'gt-cue', undefined, cueWrap)
    el('span', 'gt-cue-title', 'Event horizon stable', cue)
    const cueSub = el('span', 'gt-cue-sub', undefined, cue)
    el('span', '', 'Scroll to jump', cueSub)
    el('span', 'gt-cue-arrow', '↓', cueSub)

    const callout = new Callout(stage, { side: 'right', offset: { x: 150, y: -120 } })
    callout.root.setAttribute('aria-hidden', 'true')
    callout.label.innerHTML =
      '<span class="gt-co-k">Core_01</span>' +
      '<span class="gt-co-v"><span class="gt-co-s"></span> · <span class="gt-co-t"></span> MK</span>'
    const calloutState = callout.label.querySelector<HTMLElement>('.gt-co-s')!
    const calloutTemp = callout.label.querySelector<HTMLElement>('.gt-co-t')!

    const key = new Callout(stage, { side: 'right', offset: { x: 70, y: -150 } })
    key.root.setAttribute('aria-hidden', 'true')
    key.label.innerHTML = '<span class="gt-co-k">Keystone</span><span class="gt-co-v">Hark_mark · locked</span>'

    Object.assign(hud, {
      left,
      right,
      cue,
      pct,
      ticks: tks,
      locked,
      dest: new Decode(dest),
      status: new Scramble(status, ''),
      flux,
      coord: new Decode(coord),
      phase: '',
      callout,
      calloutState: new Decode(calloutState),
      calloutTemp,
      key,
    })
  }

  function buildSegments() {
    const rand = rng(61)
    const N = GATE.N
    // lock order: outward from the top, left/right in pairs, finishing at the bottom
    const order = Array.from({ length: N }, (_, i) => i)
      .map(i => {
        const th = (i / N) * Math.PI * 2
        let d = Math.abs(th - Math.PI / 2)
        if (d > Math.PI) d = Math.PI * 2 - d
        return { i, d }
      })
      .sort((a, b) => a.d - b.d)
    const rank = new Array<number>(N)
    order.forEach((o, k) => (rank[o.i] = Math.round(o.d / ((Math.PI * 2) / N))))
    const maxRank = N / 2
    for (let i = 0; i < N; i++) {
      const theta = (i / N) * Math.PI * 2
      const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0)
      const dist = 4.5 + rand() * 9
      const spread = (rand() - 0.5) * 1.6
      const dir = radial.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), spread)
      const start = dir.multiplyScalar(dist)
      start.z = -13 + rand() * 15
      const startQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2),
      )
      const finalQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), theta)
      segs.push({
        theta,
        start,
        startQ,
        finalQ,
        final: new THREE.Vector3(),
        radial,
        tumble: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
        tLock: 0.15 + (rank[i] / maxRank) * 0.42,
        lamp: i % 3 === 0 && !KEYSTONES.includes(i) ? 1 : 0,
      })
      segMats.push(new THREE.Matrix4())
    }
  }

  function updateSegments(l: number, time: number) {
    const N = GATE.N
    const inst = ring.inst.array as Float32Array
    for (let i = 0; i < N; i++) {
      const s = segs[i]
      const t = clamp((l - (s.tLock - FLY)) / FLY)
      const approach = ease.outCubic(segment(t, 0, 0.8))
      const slam = ease.inCubic(segment(t, 0.8, 1))
      // pre-lock hover point just outside and in front of the slot
      p2.copy(s.radial).multiplyScalar(0.7)
      p2.z = 0.45
      p.copy(s.start).lerp(p2, approach)
      p.lerp(s.final, slam)
      const idle = (1 - approach) * motion
      p.x += Math.sin(time * 0.35 + i * 1.7) * 0.25 * idle
      p.y += Math.cos(time * 0.29 + i * 2.3) * 0.25 * idle
      q.slerpQuaternions(s.startQ, s.finalQ, ease.inOutQuad(segment(t, 0, 0.86)))
      if (idle > 0) {
        q2.setFromAxisAngle(s.tumble, time * 0.12 * idle)
        q.multiply(q2)
      }
      m4.compose(p, q, one)
      segMats[i].copy(m4)
      ring.mesh.setMatrixAt(i, m4)

      const lock = smoothstep(s.tLock - 0.004, s.tLock, l)
      const since = l - s.tLock
      const flash = since >= 0 ? Math.exp(-since * 42) : 0
      locks[i] = lock
      flashes[i] = since >= 0 && since < 0.06 ? flash : 0
      inst[i * 4] = i / N
      inst[i * 4 + 1] = lock
      inst[i * 4 + 2] = flash
      inst[i * 4 + 3] = s.lamp
    }
    ring.mesh.instanceMatrix.needsUpdate = true
    ring.inst.needsUpdate = true
    ;(ring.leakMat.uniforms.uLocks.value as Float32Array).set(locks)
    ;(lockArcs.mat.uniforms.uFlash.value as Float32Array).set(flashes)

    // keystones ride on their segments
    const dInst = ring.dInst.array as Float32Array
    m4b.compose(p.set(3.2, 0, 0.35), q.identity(), keyScale)
    for (let k = 0; k < KEYSTONES.length; k++) {
      m4.multiplyMatrices(segMats[KEYSTONES[k]], m4b)
      ring.diamonds.setMatrixAt(k, m4)
      const tk = 0.575 + k * 0.012
      const lit = smoothstep(tk - 0.004, tk, l)
      const since = l - tk
      dInst[k * 4] = k
      dInst[k * 4 + 1] = lit
      dInst[k * 4 + 2] = since >= 0 ? Math.exp(-since * 30) : 0
      dInst[k * 4 + 3] = 0
    }
    ring.diamonds.instanceMatrix.needsUpdate = true
    ring.dInst.needsUpdate = true
  }

  function updateHud(l: number, frame: Frame, ctx: ChapterContext) {
    reveal(hud.left, window01(l, 0.09, 0.92, 0.05))
    reveal(hud.right, window01(l, 0.12, 0.92, 0.05))
    reveal(hud.cue, window01(l, 0.76, 0.885, 0.03))

    let lockedCount = 0
    for (let i = 0; i < GATE.N; i++) if (l >= segs[i].tLock) lockedCount++
    const ringAlign = smoothstep(0.28, 0.6, l)
    const align = clamp((lockedCount / GATE.N) * 0.88 + ringAlign * 0.12)
    const pct = String(Math.floor(align * 100)).padStart(3, '0')
    if (hud.pct.textContent !== pct) hud.pct.textContent = pct
    const lk = `${String(lockedCount).padStart(2, '0')}/${GATE.N}`
    if (hud.locked.textContent !== lk) hud.locked.textContent = lk
    for (let i = 0; i < GATE.N; i++) {
      // bar reads left→right in lock order
      const on = i < lockedCount
      const t = hud.ticks[i]
      if (t.classList.contains('on') !== on) t.classList.toggle('on', on)
    }

    // decodes fire once on threshold crossings and always settle to clean text
    hud.dest.set(BRAND.short.toUpperCase(), l >= 0.15, 0.8)

    const phase =
      l < 0.075
        ? 'Signal collapse'
        : l < 0.15
          ? 'Core ignition'
          : l < 0.6
            ? 'Dialing'
            : l < 0.77
              ? 'Horizon forming'
              : l < 0.86
                ? 'Horizon stable'
                : 'Transit'
    if (phase !== hud.phase) {
      hud.phase = phase
      hud.status.play(phase.toUpperCase(), { duration: 0.45 })
    }

    // telemetry numbers tick at ~12Hz so they read as live but legible
    const tick = Math.floor(frame.time * 12)
    const flux = 0.4 + smoothstep(0.06, 0.14, l) * 3.2 + smoothstep(0.6, 0.8, l) * 5.1 + smoothstep(0.85, 1, l) * 9
    const jitter = (Math.sin(tick * 12.9898) * 43758.5453) % 1
    const fluxTxt = `${(flux + jitter * 0.04).toFixed(2)} TW`
    if (hud.flux.textContent !== fluxTxt) hud.flux.textContent = fluxTxt
    hud.coord.set('39.9526 N · 75.1652 W', l >= 0.2, 0.8, 0.15)

    // callouts (desktop only — mobile keeps the frame clean). On narrow or
    // portrait windows the ring fills the width and there is no room outside
    // it for a label, so each callout also checks it fits before showing.
    const cam = ctx.camera
    coreWorld.set(0, 0, 0).applyMatrix4(group.matrixWorld)
    const cWin = mobile ? 0 : window01(l, 0.16, 0.58, 0.04)
    if (cWin > 0 || hud.callout.root.style.opacity !== '0.000') {
      const temp = (4.1 + l * 3 + (tick % 7) * 0.013).toFixed(3)
      if (hud.calloutTemp.textContent !== temp) hud.calloutTemp.textContent = temp
      // put the label just outside the ring's upper-right shoulder
      p.copy(coreWorld).project(cam)
      p2.set(GATE.R1, 0, 0).applyMatrix4(group.matrixWorld).project(cam)
      const ringPx = Math.abs(p2.x - p.x) * 0.5 * frame.width
      hud.callout.offset.x = ringPx * 0.98 + 24
      hud.callout.offset.y = -ringPx * 0.74
      fitCore = damp(fitCore, room(hud.callout, coreWorld, frame, cam), 12, frame.dt)
      const cv = cWin * smoothstep(0.5, 0.95, fitCore)
      hud.calloutState.set('IGNITED', cv > 0.05, 0.5, 0.1)
      hud.callout.update(coreWorld, cam, frame.width, frame.height, cv)
    }
    ring.diamonds.getMatrixAt(1, m4)
    keyWorld.setFromMatrixPosition(m4).applyMatrix4(group.matrixWorld)
    const kWin = mobile ? 0 : window01(l, 0.6, 0.84, 0.04)
    if (kWin > 0 || hud.key.root.style.opacity !== '0.000') {
      fitKey = damp(fitKey, room(hud.key, keyWorld, frame, cam), 12, frame.dt)
      hud.key.update(keyWorld, cam, frame.width, frame.height, kWin * smoothstep(0.5, 0.95, fitKey))
    }
  }

  return {
    id: 'portal',
    group,

    init(ctx) {
      mobile = ctx.mobile
      motion = ctx.reducedMotion ? 0.25 : 1
      const rand = rng(17)

      ring = createRing(shared)
      dial = createDial(shared)
      ticks = createTicks(1.96, 2.12, 180, 36)
      ticksInner = createTicks(1.62, 1.7, 120, 12)
      core = createCore(shared, mobile)
      lockArcs = createLockArcs(shared)
      horizon = createHorizon(shared, mobile)
      collapse = createCollapse(mobile ? 380 : 760, rand)
      rush = createRush(mobile ? 420 : 900, rand)

      buildSegments()

      group.add(ring.mesh, ring.diamonds, ring.leak, dial.mesh, ticks.mesh, ticksInner.mesh)
      group.add(core.group, lockArcs.lines, horizon.mesh, collapse.lines, rush.lines)
      horizon.mesh.scale.setScalar(GATE.HORIZON)
      ticks.mesh.position.z = 0.03
      ticksInner.mesh.position.z = 0.05

      buildHud(ctx.stage)
    },

    update(l, frame, ctx) {
      const time = frame.time * motion
      shared.uTime.value = time

      // ---- phases -------------------------------------------------------
      const ign = segment(l, 0.058, 0.14)
      const grow = ease.inOutCubic(segment(l, 0.6, 0.73))
      const open = ease.outCubic(segment(l, 0.64, 0.79))
      const stable = segment(l, 0.77, 0.85)
      const jump = segment(l, 0.85, 1)
      const jumpE = ease.inCubic(jump)

      // ---- ring ---------------------------------------------------------
      updateSegments(l, time)
      const allLocked = smoothstep(0.56, 0.6, l)
      ring.mat.uniforms.uFlashAll.value = bump(l, 0.605, 0.02)
      ring.mat.uniforms.uGlow.value = 1 + open * 0.2 + jumpE * 0.4
      ring.leakMat.uniforms.uGlow.value = 0.8 + allLocked * 0.6 + open * 0.6
      ring.dMat.uniforms.uGlow.value = 1 + open * 0.5

      const alignA = ease.inOutCubic(segment(l, 0.26, 0.6))
      const ia = 1 - alignA
      dial.mesh.rotation.set(ia * 1.1, ia * -0.42, ia * (4.2 + time * 0.3))
      dial.mat.uniforms.uGlow.value = 0.25 + alignA * 0.75 + bump(l, 0.6, 0.02) * 2.5

      const alignB = ease.inOutCubic(segment(l, 0.22, 0.58))
      const ib = 1 - alignB
      ticks.mesh.rotation.set(ib * -0.62, ib * 1.25, -ib * (5.0 + time * 0.4) + time * 0.02)
      ticks.mat.uniforms.uGlow.value = (0.45 + alignB * 0.9) * (1 - open * 0.3) * (1 - jump)
      ticksInner.mesh.rotation.set(ib * 0.9, ib * 0.6, ib * (3.0 + time * 0.55) - time * 0.035)
      ticksInner.mat.uniforms.uGlow.value = (0.3 + alignB * 0.5) * (1 - open)

      // ---- core ---------------------------------------------------------
      const pulse = 1 + Math.sin(time * 2.1) * 0.02 + Math.sin(time * 5.3) * 0.01
      let r = 0.6 * Math.max(0, ease.outBack(ign)) * pulse
      r = lerp(r, 1.45, grow)
      const coreFade = 1 - segment(l, 0.7, 0.77)
      core.sphere.scale.set(r, r, r * lerp(1, 0.22, grow))
      core.sphere.visible = r > 0.002 && coreFade > 0.001
      core.sphereMat.uniforms.uIntensity.value = coreFade * (0.8 + bump(l, 0.07, 0.03) * 1.2) * lerp(1, 0.4, grow)
      core.sphereMat.uniforms.uHeat.value = grow + bump(l, 0.07, 0.04)

      // the singular point before ignition, then the corona around the core
      const pre = segment(l, 0, 0.065)
      const coronaSize = lerp(0.35 + pre * 0.5, 2.9 * Math.max(r, 0.25), ign) * (1 - grow * 0.2)
      core.coronaMat.uniforms.uSize.value = coronaSize
      core.coronaMat.uniforms.uIntensity.value =
        (lerp(0.8 + pre * 2.5, 1, ign) + bump(l, 0.068, 0.02) * 2.5) * (1 - grow * 0.5) * (1 - open * 0.5) * (1 - jump * 0.5)
      core.flareMat.uniforms.uIntensity.value =
        0.9 * bump(l, 0.066, 0.028) + 0.18 * (1 - ign) + 0.08 * ign * (1 - open) + 0.5 * bump(l, 0.66, 0.05)
      core.flareMat.uniforms.uW.value = mobile ? 4.5 : 8

      core.arcMat.uniforms.uR.value = Math.max(r, 0.05)
      core.arcMat.uniforms.uIntensity.value = smoothstep(0.07, 0.11, l) * coreFade
      core.arcMat.uniforms.uReach.value = 0.55 + grow * 0.3
      lockArcs.mat.uniforms.uR0.value = Math.max(r, 0.1)
      lockArcs.lines.visible = l > 0.1 && l < 0.66

      shared.uCorePower.value =
        smoothstep(0.06, 0.12, l) * 0.9 + bump(l, 0.07, 0.025) * 1.4 + grow * 0.4 + open * 0.1 + jumpE * 0.5

      // ---- horizon ------------------------------------------------------
      horizon.mesh.visible = open > 0.001
      horizon.mat.uniforms.uOpen.value = open
      horizon.mat.uniforms.uStable.value = stable
      horizon.mat.uniforms.uRush.value = jumpE
      horizon.mat.uniforms.uIntensity.value = 1 + jumpE * 0.6

      // ---- streaks ------------------------------------------------------
      const cIn = segment(l, 0, 0.075)
      collapse.lines.visible = cIn < 1
      collapse.mat.uniforms.uC.value = cIn
      collapse.mat.uniforms.uIntensity.value = 1

      rush.lines.visible = l > 0.83
      rush.mat.uniforms.uTravel.value = jumpE * 2.2 + time * 0.05
      rush.mat.uniforms.uIntensity.value = smoothstep(0.84, 0.93, l)
      rush.mat.uniforms.uCamZ.value = ctx.camera.position.z

      // ---- post / sky ---------------------------------------------------
      const pp = ctx.post.params
      pp.bloomStrength = 0.72 + bump(l, 0.07, 0.03) * 0.4 + jumpE * 0.3
      pp.bloomRadius = 0.12 + jumpE * 0.3
      pp.bloomThreshold = 0.66
      pp.flash = 0.22 * bump(l, 0.066, 0.012) + ease.inCubic(segment(l, 0.93, 1)) * 0.8 + (1 - segment(l, 0, 0.02)) * 0.2
      pp.glitch = 0.25 * (1 - segment(l, 0, 0.03)) + 0.45 * ease.inQuad(segment(l, 0.94, 1))
      pp.aberration = 0.0025 + jumpE * 0.012 + bump(l, 0.07, 0.02) * 0.004
      pp.vignette = 0.6

      ctx.sky.params.warp = ease.inQuad(segment(l, 0.84, 1))
      ctx.sky.params.nebula = 0.85 - open * 0.25
      ctx.sky.params.stars = 1

      updateHud(l, frame, ctx)
    },

    camera(l, frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      // matches the CSS breakpoint: stacked HUD (top/bottom) vs side panels
      const portrait = frame.width < 768 || aspect < 0.8
      const baseFov = portrait ? 52 : 38
      const t = Math.tan((baseFov * Math.PI) / 360)
      const D = (GATE.R1 + 0.1) / (t * (portrait ? 0.92 * Math.min(1, aspect) : 0.7))
      // side-panel layouts: never let the ring (keystones included) grow into
      // the HUD columns, however close the camera pushes in
      let minDist = 0
      if (!portrait) {
        const w = frame.width
        const panel = w <= 1180 ? clamp(w * 0.19, 220, 280) : 285
        const gutter = clamp(w * 0.034, 16, 44)
        const maxRing = Math.max(120, w - 2 * (panel + gutter + 20))
        const fMax = maxRing / Math.max(1, frame.height)
        minDist = ((GATE.R1 + 0.1) * 1.09) / (t * fMax)
      }

      const pIn = ease.outCubic(segment(l, 0, 0.12))
      const pDial = ease.inOutQuad(segment(l, 0.1, 0.62))
      const pHor = ease.inOutQuad(segment(l, 0.6, 0.86))
      const jump = segment(l, 0.85, 1)
      const jumpE = ease.inCubic(jump)

      let dist = lerp(D * 1.8, D * 1.3, pIn)
      dist = lerp(dist, D * 1.03, pDial)
      dist = lerp(dist, D * 0.84, pHor)
      dist = Math.max(dist, minDist)
      let az = lerp(0.7, 0.55, pIn)
      az = lerp(az, 0.1, pDial)
      az = lerp(az, 0, pHor)
      if (portrait) az *= 0.6
      let elv = lerp(0.3, 0.22, pIn)
      elv = lerp(elv, 0.05, pDial)
      elv = lerp(elv, 0, pHor)
      const drift = Math.sin(frame.time * 0.15) * 0.02 * motion * (1 - jump)

      out.position.set(
        Math.sin(az + drift) * Math.cos(elv) * dist,
        Math.sin(elv) * dist,
        Math.cos(az + drift) * Math.cos(elv) * dist,
      )
      out.target.set(0, 0, 0)
      // fly through the horizon
      const z = lerp(out.position.z, -7, jumpE)
      out.position.z = z
      out.target.z = lerp(0, z - 12, jumpE)
      out.fov = baseFov + jumpE * 38 + (1 - pIn) * 8
      out.roll = lerp(-0.22, -0.05, pIn) * (1 - pDial) + jumpE * 0.12
      out.parallax = 0.3 * (1 - jump)
    },

    onLeave() {
      // nothing persistent to clean — state is derived from local each frame
    },
  }
}
