import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, reveal } from '../../core/dom'
import { Scramble, scrambleAt } from '../../core/scramble'
import { clamp, ease, lerp, rng, segment, smoothstep, window01 } from '../../core/math'
import { PROCESS, STATS } from '../../content'
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
 * GATE — how we work. A segmented ring dials in clockwise from 12 o'clock.
 * Its four Hark-diamond keystones (N, E, S, W) are Hark's process — Listen,
 * Prototype, Build, Support — and each one lights its step in the HUD as it
 * locks. The gate readouts are real proof points, not invented telemetry.
 *
 *   0.00–0.10  energy lines collapse into a point → the core ignites
 *   0.14–0.64  segments lock clockwise; keystones at 0.14 Listen · 0.27
 *              Prototype · 0.40 Build · 0.53 Support; gimbal rings align
 *   0.64–0.86  the gate is complete: the core swells into an event horizon
 *   0.86–1.00  fly through: warp, flash, glitch → cut to Arrival ("Say hello")
 */

/** first / last segment lock */
const T0 = 0.14
const T1 = 0.64
const FLY = 0.13
const KEYSTONES = [9, 0, 27, 18] // N, E, S, W (segment i sits at angle i·10°)
/** clockwise from the top: N → E → S → W */
const lockRank = (i: number) => (9 - i + GATE.N) % GATE.N
const lockAt = (i: number) => T0 + (lockRank(i) / (GATE.N - 1)) * (T1 - T0)
/** when each process step's keystone locks */
const KEY_T = KEYSTONES.map(lockAt)

/** The gate readouts: real proof points from the original service pages. */
const PROOF = ['10 years', '$1M+', '15']
  .map(v => STATS.find(s => s.value === v))
  .filter((s): s is (typeof STATS)[number] => !!s)

const TITLE = 'We listen first. Then we build.'

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

interface Step {
  li: HTMLElement
  fill: HTMLElement
  title: HTMLElement
  text: string
  read: HTMLElement
  s: Scramble
  on: boolean
  active: boolean
  fillTx: string
}

/** stacked HUD (top/bottom) instead of side columns — matches the CSS breakpoint */
const isPortrait = (w: number, h: number) => w < 768 || w / Math.max(1, h) < 0.8
/** room kept around the ring for the keystone tags (px) */
const TAG_ROOM = 30

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
    sideL: HTMLElement
    sideR: HTMLElement
    proc: HTMLElement
    proof: HTMLElement
    cue: HTMLElement
    cueWrap: HTMLElement
    cueTx: string
    steps: Step[]
    stats: Decode[]
    keys: HTMLElement[]
    keyTx: string[]
  }
  /** cached HUD column edges (CSS px), re-measured only on resize */
  const box = { dirty: true, w: 0, h: 0, left: 0, right: 0, top: 0, bottom: 0 }

  const m4 = new THREE.Matrix4()
  const m4b = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const q2 = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  const keyScale = new THREE.Vector3(0.46, 0.46, 1.6)
  const segMats: THREE.Matrix4[] = []

  function buildHud(stage: HTMLElement) {
    // ---- how we work: the four keystones -------------------------------
    const sideL = el('div', 'gt-side gt-side--left', undefined, stage)
    const proc = el('div', 'gt-panel gt-proc', undefined, sideL)
    el('p', 'hud-eyebrow gt-eyebrow', 'How we work', proc)
    el('h2', 'gt-title', TITLE, proc)
    const ol = el('ol', 'gt-steps', undefined, proc)
    // phones show only the active step's text, cross-faded in one slot
    const read = el('div', 'gt-read', undefined, proc)
    const steps: Step[] = PROCESS.map((s, i) => {
      const li = el('li', 'gt-step', undefined, ol)
      const fill = el('i', 'gt-step-fill', undefined, li)
      el('i', 'gt-step-dot', undefined, li)
      const head = el('div', 'gt-step-head', undefined, li)
      el('span', 'gt-step-n', String(i + 1).padStart(2, '0'), head)
      const title = el('span', 'gt-step-t', s.title, head)
      el('p', 'gt-step-x', s.text, li)
      const r = el('p', 'gt-read-x', s.text, read)
      return { li, fill, title, text: s.title, read: r, s: new Scramble(title, s.title), on: false, active: false, fillTx: '' }
    })

    // ---- gate readouts: real proof points -------------------------------
    const sideR = el('div', 'gt-side gt-side--right', undefined, stage)
    const proof = el('div', 'gt-panel gt-proof', undefined, sideR)
    el('p', 'hud-label gt-proof-k', 'By the numbers', proof)
    const dl = el('dl', 'gt-stats', undefined, proof)
    const stats = PROOF.map(s => {
      const row = el('div', 'gt-stat', undefined, dl)
      const v = el('dt', 'gt-stat-v', undefined, row)
      el('dd', 'gt-stat-l', s.label, row)
      return new Decode(v)
    })

    // ---- keystone tags: tie each diamond to its step number --------------
    const keys = KEYSTONES.map((_, k) => el('div', 'gt-key', String(k + 1).padStart(2, '0'), stage))

    // ---- the way through leads to contact ("Say hello.") -----------------
    const cueWrap = el('div', 'gt-cue-wrap', undefined, stage)
    const cue = el('div', 'gt-cue', undefined, cueWrap)
    el('span', 'gt-cue-title', 'It starts with hello', cue)
    const cueSub = el('span', 'gt-cue-sub', undefined, cue)
    el('span', '', 'Scroll through', cueSub)
    el('span', 'gt-cue-arrow', '↓', cueSub)

    Object.assign(hud, { sideL, sideR, proc, proof, cue, cueWrap, cueTx: '', steps, stats, keys, keyTx: keys.map(() => '') })

    // the camera frames the ring between the HUD columns; measure them only
    // when their size (fonts, viewport) actually changes
    const dirty = () => (box.dirty = true)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(dirty)
      ro.observe(sideL)
      ro.observe(sideR)
    }
    window.addEventListener('resize', dirty)
  }

  function measure(frame: Frame) {
    if (!box.dirty && box.w === frame.width && box.h === frame.height) return
    const { sideL, sideR } = hud
    if (!sideL) return
    box.dirty = false
    box.w = frame.width
    box.h = frame.height
    box.left = sideL.offsetLeft + sideL.offsetWidth
    box.right = sideR.offsetLeft
    box.top = sideL.offsetTop + sideL.offsetHeight
    box.bottom = sideR.offsetTop
  }

  function buildSegments() {
    const rand = rng(61)
    const N = GATE.N
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
        tLock: lockAt(i),
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

    // keystones ride on their segments and light the moment they lock
    const dInst = ring.dInst.array as Float32Array
    m4b.compose(p.set(3.2, 0, 0.35), q.identity(), keyScale)
    for (let k = 0; k < KEYSTONES.length; k++) {
      m4.multiplyMatrices(segMats[KEYSTONES[k]], m4b)
      ring.diamonds.setMatrixAt(k, m4)
      const tk = KEY_T[k]
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

  function updateHud(l: number, frame: Frame, cam: THREE.Camera) {
    const portrait = isPortrait(frame.width, frame.height)
    const procV = window01(l, 0.06, 0.93, 0.05)
    reveal(hud.proc, procV)
    reveal(hud.proof, window01(l, 0.1, 0.93, 0.05))
    reveal(hud.cue, window01(l, 0.79, 0.9, 0.03))

    // ---- process steps: one per keystone ---------------------------------
    let active = -1
    for (let j = 0; j < KEY_T.length; j++) if (l >= KEY_T[j]) active = j
    for (let j = 0; j < hud.steps.length; j++) {
      const st = hud.steps[j]
      const on = j <= active
      const isActive = j === active
      if (on !== st.on) {
        st.on = on
        st.li.classList.toggle('is-on', on)
      }
      if (isActive !== st.active) {
        st.active = isActive
        st.li.classList.toggle('is-active', isActive)
        st.read.classList.toggle('is-active', isActive)
        if (isActive) {
          // the keystone just locked: its step name decodes once, then holds
          st.s.clear()
          st.title.textContent = scrambleAt(st.text, 0.05)
          st.s.play(st.text, { duration: 0.5 })
        } else {
          st.s.at(st.text, 1)
        }
      }
      // the rail fills from this keystone to the next (the last runs to the final lock)
      const f = segment(l, KEY_T[j], j + 1 < KEY_T.length ? KEY_T[j + 1] : T1)
      const tx = portrait ? `scaleX(${f.toFixed(3)})` : `scaleY(${f.toFixed(3)})`
      if (tx !== st.fillTx) {
        st.fillTx = tx
        st.fill.style.transform = tx
      }
    }

    // ---- gate readouts decode in turn as the panel comes up -------------
    for (let i = 0; i < hud.stats.length; i++) hud.stats[i].set(PROOF[i].value, l >= 0.12 + i * 0.03, 0.7)

    // ---- keystone tags, just outside each diamond --------------------------
    const tagWin = procV * (1 - smoothstep(0.66, 0.71, l))
    p.set(0, 0, 0).applyMatrix4(group.matrixWorld).project(cam)
    const cx = (p.x * 0.5 + 0.5) * frame.width
    const cy = (-p.y * 0.5 + 0.5) * frame.height

    // the cue sits in the throat of the horizon, wherever the ring is framed
    if (l > 0.75 && Number.isFinite(cx) && Number.isFinite(cy)) {
      const tx = `translate3d(${cx.toFixed(1)}px, ${(cy + (portrait ? 24 : 34)).toFixed(1)}px, 0)`
      if (tx !== hud.cueTx) {
        hud.cueTx = tx
        hud.cueWrap.style.transform = tx
      }
    }

    for (let k = 0; k < hud.keys.length; k++) {
      const tag = hud.keys[k]
      const v = tagWin * smoothstep(KEY_T[k] - 0.002, KEY_T[k] + 0.012, l)
      ring.diamonds.getMatrixAt(k, m4)
      p2.setFromMatrixPosition(m4).applyMatrix4(group.matrixWorld).project(cam)
      const ok = p2.z < 1 && Number.isFinite(p2.x) && Number.isFinite(p2.y)
      reveal(tag, ok ? v : 0, 0)
      if (!ok || v <= 0) continue
      const kx = (p2.x * 0.5 + 0.5) * frame.width
      const ky = (-p2.y * 0.5 + 0.5) * frame.height
      const dx = kx - cx
      const dy = ky - cy
      const r = Math.hypot(dx, dy) || 1
      const out = r * 0.075 + 16
      const tx = `translate3d(${(kx + (dx / r) * out).toFixed(1)}px, ${(ky + (dy / r) * out).toFixed(1)}px, 0) translate(-50%, -50%)`
      if (tx !== hud.keyTx[k]) {
        hud.keyTx[k] = tx
        tag.style.transform = tx
      }
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
      const grow = ease.inOutCubic(segment(l, T1, 0.76))
      const open = ease.outCubic(segment(l, 0.67, 0.81))
      const stable = segment(l, 0.79, 0.86)
      const jump = segment(l, 0.86, 1)
      const jumpE = ease.inCubic(jump)
      // a soft beat each time a keystone (process step) locks
      let keyBeat = 0
      for (const tk of KEY_T) keyBeat += bump(l, tk + 0.004, 0.01)

      // ---- ring ---------------------------------------------------------
      updateSegments(l, time)
      const allLocked = smoothstep(T1 - 0.04, T1, l)
      ring.mat.uniforms.uFlashAll.value = bump(l, T1 + 0.005, 0.02)
      ring.mat.uniforms.uGlow.value = 1 + open * 0.2 + jumpE * 0.4
      ring.leakMat.uniforms.uGlow.value = 0.8 + allLocked * 0.6 + open * 0.6
      ring.dMat.uniforms.uGlow.value = 1 + open * 0.5

      const alignA = ease.inOutCubic(segment(l, 0.26, T1))
      const ia = 1 - alignA
      dial.mesh.rotation.set(ia * 1.1, ia * -0.42, ia * (4.2 + time * 0.3))
      dial.mat.uniforms.uGlow.value = 0.25 + alignA * 0.75 + bump(l, T1, 0.02) * 2.5

      const alignB = ease.inOutCubic(segment(l, 0.22, T1 - 0.02))
      const ib = 1 - alignB
      ticks.mesh.rotation.set(ib * -0.62, ib * 1.25, -ib * (5.0 + time * 0.4) + time * 0.02)
      ticks.mat.uniforms.uGlow.value = (0.45 + alignB * 0.9) * (1 - open * 0.3) * (1 - jump)
      ticksInner.mesh.rotation.set(ib * 0.9, ib * 0.6, ib * (3.0 + time * 0.55) - time * 0.035)
      ticksInner.mat.uniforms.uGlow.value = (0.3 + alignB * 0.5) * (1 - open)

      // ---- core ---------------------------------------------------------
      const pulse = 1 + Math.sin(time * 2.1) * 0.02 + Math.sin(time * 5.3) * 0.01
      let r = 0.6 * Math.max(0, ease.outBack(ign)) * pulse
      r = lerp(r, 1.45, grow)
      const coreFade = 1 - segment(l, 0.73, 0.8)
      core.sphere.scale.set(r, r, r * lerp(1, 0.22, grow))
      core.sphere.visible = r > 0.002 && coreFade > 0.001
      core.sphereMat.uniforms.uIntensity.value = coreFade * (0.8 + bump(l, 0.07, 0.03) * 1.2) * lerp(1, 0.4, grow)
      core.sphereMat.uniforms.uHeat.value = grow + bump(l, 0.07, 0.04)

      // the singular point before ignition, then the corona around the core
      const pre = segment(l, 0, 0.065)
      const coronaSize = lerp(0.35 + pre * 0.5, 2.9 * Math.max(r, 0.25), ign) * (1 - grow * 0.2)
      core.coronaMat.uniforms.uSize.value = coronaSize
      core.coronaMat.uniforms.uIntensity.value =
        (lerp(0.8 + pre * 2.5, 1, ign) + bump(l, 0.068, 0.02) * 2.5 + keyBeat * 0.35) *
        (1 - grow * 0.5) *
        (1 - open * 0.5) *
        (1 - jump * 0.5)
      core.flareMat.uniforms.uIntensity.value =
        0.9 * bump(l, 0.066, 0.028) + 0.18 * (1 - ign) + 0.08 * ign * (1 - open) + 0.5 * bump(l, 0.69, 0.05)
      core.flareMat.uniforms.uW.value = mobile ? 4.5 : 8

      core.arcMat.uniforms.uR.value = Math.max(r, 0.05)
      core.arcMat.uniforms.uIntensity.value = smoothstep(0.07, 0.11, l) * coreFade
      core.arcMat.uniforms.uReach.value = 0.55 + grow * 0.3
      lockArcs.mat.uniforms.uR0.value = Math.max(r, 0.1)
      lockArcs.lines.visible = l > 0.1 && l < T1 + 0.04

      shared.uCorePower.value =
        smoothstep(0.06, 0.12, l) * 0.9 + bump(l, 0.07, 0.025) * 1.4 + keyBeat * 0.3 + grow * 0.4 + open * 0.1 + jumpE * 0.5

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

      rush.lines.visible = l > 0.84
      rush.mat.uniforms.uTravel.value = jumpE * 2.2 + time * 0.05
      rush.mat.uniforms.uIntensity.value = smoothstep(0.85, 0.94, l)
      rush.mat.uniforms.uCamZ.value = ctx.camera.position.z

      // ---- post / sky ---------------------------------------------------
      const pp = ctx.post.params
      pp.bloomStrength = 0.72 + bump(l, 0.07, 0.03) * 0.4 + keyBeat * 0.12 + jumpE * 0.3
      pp.bloomRadius = 0.12 + jumpE * 0.3
      pp.bloomThreshold = 0.66
      pp.flash = 0.22 * bump(l, 0.066, 0.012) + ease.inCubic(segment(l, 0.93, 1)) * 0.8 + (1 - segment(l, 0, 0.02)) * 0.2
      pp.glitch = 0.25 * (1 - segment(l, 0, 0.03)) + 0.45 * ease.inQuad(segment(l, 0.94, 1))
      pp.aberration = 0.0025 + jumpE * 0.012 + bump(l, 0.07, 0.02) * 0.004
      pp.vignette = 0.6

      // voices hands over mid-warp (its pulsar flares out); carry a little of
      // that streak in so the cut lands on motion, then settle to still stars
      ctx.sky.params.warp = ease.inQuad(segment(l, 0.85, 1)) + (1 - ease.outCubic(segment(l, 0, 0.07))) * 0.5
      ctx.sky.params.nebula = 0.85 - open * 0.25
      ctx.sky.params.stars = 1

      group.updateMatrixWorld()
      updateHud(l, frame, ctx.camera)
    },

    camera(l, frame, out: CameraPose) {
      const W = frame.width
      const H = Math.max(1, frame.height)
      const aspect = W / H
      const portrait = isPortrait(W, H)
      const baseFov = portrait ? 52 : 38
      const t = Math.tan((baseFov * Math.PI) / 360)
      const R = GATE.R1 + 0.1
      measure(frame)

      // Frame the ring in the clear space the HUD leaves: between the side
      // columns on landscape screens, between the top and bottom stacks on
      // portrait ones. Sized for the dialing phase (1.03·D); the horizon
      // phase then pushes in past it on purpose.
      let D = R / (t * (portrait ? 0.92 * Math.min(1, aspect) : 0.7))
      let minDist = 0
      let offX = 0
      let offY = 0
      if (portrait) {
        const top = box.top + TAG_ROOM
        const bot = box.bottom - TAG_ROOM
        if (bot - top > 80) {
          const ringPx = clamp(Math.min(W * 0.9, bot - top), W * 0.5, W * 0.92)
          D = (R * H) / (t * ringPx) / 1.03
          offY = (top + bot) * 0.5 - H * 0.5
        }
      } else if (box.right > box.left) {
        const a = box.left + 20 + TAG_ROOM
        const b = box.right - 20 - TAG_ROOM
        const maxRing = Math.max(120, b - a)
        minDist = (R * 1.06 * H) / (t * maxRing)
        offX = (a + b) * 0.5 - W * 0.5
      }

      const pIn = ease.outCubic(segment(l, 0, 0.12))
      const pDial = ease.inOutQuad(segment(l, 0.1, T1))
      const pHor = ease.inOutQuad(segment(l, T1 - 0.02, 0.87))
      const jump = segment(l, 0.86, 1)
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
      // slide the frame (camera + target together) so the ring sits centred in
      // the clear space; ease back to dead centre for the fly-through
      const wpp = (2 * dist * t) / H
      const sx = -offX * wpp * (1 - jumpE)
      const sy = offY * wpp * (1 - jumpE)
      out.position.x += sx
      out.target.x += sx
      out.position.y += sy
      out.target.y += sy
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
