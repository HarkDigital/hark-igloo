import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal } from '../../core/dom'
import { Scramble } from '../../core/scramble'
import { clamp, damp, ease, lerp, segment, smoothstep } from '../../core/math'
import { BRAND, CONTACT } from '../../content'
import { createMark, createPlatform, markUniforms } from './scene'
import './contact.css'

/*
 * ARRIVAL — the final chapter.
 *
 *   0.00–0.25  out of warp: particles overtake the camera as streaks and
 *              condense into the Hark mark above a holographic platform
 *   0.25–0.80  hold: calm, breathing, pointer-reactive; contact copy + links
 *   0.80–1.00  sign-off: the mark turns to face you, the pad's rings close,
 *              the frame breathes out and the HUD ends the transmission
 */

const MARK_Y = 0.42
const PLATFORM_Y = -1.18
const PLATFORM_R = 2.7

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

export default function create(): Chapter {
  const group = new THREE.Group()
  const markGroup = new THREE.Group()
  const u = markUniforms()
  let mobile = false
  let motion = 1
  let count = 0

  let mark!: ReturnType<typeof createMark>
  let platform!: ReturnType<typeof createPlatform>

  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane()
  const hit = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const tmp2 = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const lastRaw = new THREE.Vector2(0, 0)
  let pointerSeen = false
  let lastMove = -99
  let pointerAmt = 0
  let pulseAt = -99
  const pulseOrigin = new THREE.Vector3()
  const pointerLocal = new THREE.Vector3(99, 99, 0)

  const hud = {} as {
    scrim: HTMLElement
    wrap: HTMLElement
    eyebrow: HTMLElement
    title: HTMLElement
    body: HTMLElement
    cta: HTMLElement
    links: HTMLElement
    foot: HTMLElement
    endFlow: HTMLElement
    endFloat: HTMLElement
    endFlowTxt: Decode
    endFloatTxt: Decode
    teleK: Decode
    teleV: Decode
    teleC: Decode
    callout: Callout
    isEnd: boolean
  }

  function buildHud(stage: HTMLElement) {
    const scrim = el('div', 'ct-scrim', undefined, stage)
    scrim.setAttribute('aria-hidden', 'true')
    const wrap = el('div', 'ct-wrap', undefined, stage)
    const copy = el('div', 'ct-copy', undefined, wrap)

    const eyebrow = el('p', 'hud-eyebrow ct-eyebrow', CONTACT.eyebrow, copy)

    const title = el('h2', 'hud-title ct-title', undefined, copy)
    title.setAttribute('aria-label', CONTACT.title)
    const [first, ...rest] = CONTACT.title.replace(/\.$/, '').split(' ')
    const l1 = el('span', 'ct-line', first, title)
    l1.setAttribute('aria-hidden', 'true')
    title.append(' ')
    const l2 = el('span', 'ct-line', rest.join(' '), title)
    l2.setAttribute('aria-hidden', 'true')
    if (CONTACT.title.endsWith('.')) el('span', 'ct-dot', '.', l2)

    const body = el('p', 'hud-body ct-body', CONTACT.body, copy)

    const cta = el('div', 'ct-cta', undefined, copy)
    const btn = el('a', 'hud-btn ct-btn', undefined, cta)
    btn.href = CONTACT.href
    el('span', '', BRAND.email, btn)
    el('span', 'ct-btn-arrow', '→', btn).setAttribute('aria-hidden', 'true')

    // sign-off (decorative): in the copy column on desktop …
    const endFlow = el('div', 'ct-end ct-end--flow', undefined, cta)
    endFlow.setAttribute('aria-hidden', 'true')
    el('span', 'ct-end-rule', undefined, endFlow)
    const endFlowTxt = el('span', 'ct-end-txt', undefined, endFlow)
    el('i', 'ct-end-caret', undefined, endFlow)
    // … and centred between the pad and the copy on phones
    const endFloat = el('div', 'ct-end ct-end--float', undefined, stage)
    endFloat.setAttribute('aria-hidden', 'true')
    el('span', 'ct-end-rule', undefined, endFloat)
    const endFloatTxt = el('span', 'ct-end-txt', undefined, endFloat)
    el('span', 'ct-end-rule', undefined, endFloat)

    const bottom = el('div', 'ct-bottom', undefined, stage)
    const links = el('nav', 'ct-links', undefined, bottom)
    links.setAttribute('aria-label', 'Contact and site links')
    const email = el('a', 'ct-link', 'Email', links)
    email.href = `mailto:${BRAND.email}`
    el('span', 'ct-sep', '|', links).setAttribute('aria-hidden', 'true')
    const classic = el('a', 'ct-link', 'Classic site', links)
    classic.href = BRAND.classicSite
    classic.target = '_blank'
    classic.rel = 'noopener noreferrer'
    el('span', 'ct-ext', ' ↗', classic).setAttribute('aria-hidden', 'true')
    el('span', 'sr-only', ' (opens in a new tab)', classic)
    el('span', 'ct-sep', '|', links).setAttribute('aria-hidden', 'true')
    const top = el('button', 'ct-link ct-top', 'Back to top', links)
    top.type = 'button'
    el('span', 'ct-top-arrow', '↑', top).setAttribute('aria-hidden', 'true')
    top.addEventListener('click', () => window.__hark?.goto(0))

    const foot = el('p', 'ct-foot', undefined, bottom)
    el('span', 'ct-foot-name', `© 2026 ${BRAND.name}`, foot)
    el('span', 'ct-foot-sep', ' · ', foot)
    el('span', 'ct-foot-loc', BRAND.locale, foot)

    // a single HUD callout on the mark, igloo-style
    const callout = new Callout(stage, { side: 'right', offset: { x: 90, y: -70 } })
    callout.root.setAttribute('aria-hidden', 'true')
    callout.root.classList.add('ct-callout')
    callout.label.innerHTML =
      '<span class="ct-co-k"></span><span class="ct-co-v"></span><span class="ct-co-c"></span>'
    const teleK = new Decode(callout.label.querySelector<HTMLElement>('.ct-co-k')!)
    const teleV = new Decode(callout.label.querySelector<HTMLElement>('.ct-co-v')!)
    const teleC = new Decode(callout.label.querySelector<HTMLElement>('.ct-co-c')!)

    Object.assign(hud, {
      scrim,
      wrap,
      eyebrow,
      title,
      body,
      cta,
      links,
      foot,
      endFlow,
      endFloat,
      endFlowTxt: new Decode(endFlowTxt),
      endFloatTxt: new Decode(endFloatTxt),
      teleK,
      teleV,
      teleC,
      callout,
      isEnd: false,
    })
  }

  function layout(frame: Frame) {
    const aspect = frame.width / Math.max(1, frame.height)
    const portrait = aspect < 0.9
    return { aspect, portrait }
  }

  /** Project a world point to CSS pixels. */
  function toScreen(world: THREE.Vector3, camera: THREE.Camera, frame: Frame) {
    tmp2.copy(world).project(camera)
    return { x: (tmp2.x * 0.5 + 0.5) * frame.width, y: (-tmp2.y * 0.5 + 0.5) * frame.height, behind: tmp2.z > 1 }
  }

  /**
   * Keep the callout fully on-screen: prefer the natural side, flip when the
   * label would cross the gutter, shorten the leader if needed, stay below the
   * header band. Returns false when there is simply no room (then it hides).
   */
  function placeCallout(anchor: THREE.Vector3, portrait: boolean, frame: Frame, camera: THREE.Camera) {
    const c = hud.callout
    const { x, y } = toScreen(anchor, camera, frame)
    const W = frame.width
    const H = frame.height
    const lw = c.label.offsetWidth
    const g = clamp(W * 0.034, 16, 44)
    const safeTop = clamp(H * 0.11, 84, 118)
    let side: 'left' | 'right' = portrait ? 'left' : 'right'
    let ox = portrait ? 46 : 96
    const oy = Math.max(portrait ? -24 : -64, safeTop + 12 - y)
    if (side === 'right' && x + ox + 8 + lw > W - g) side = 'left'
    if (side === 'left' && x - ox - 8 - lw < g) ox = x - 8 - lw - g
    c.side = side
    c.offset.x = ox
    c.offset.y = oy
    c.root.classList.toggle('is-left', side === 'left')
    return ox >= 18
  }

  /** Raycast the pointer onto the plane of the mark; result in mark-local units. */
  function projectPointer(raw: THREE.Vector2, camera: THREE.Camera) {
    raycaster.setFromCamera(raw, camera)
    markGroup.updateMatrixWorld()
    normal.set(0, 0, 1).transformDirection(markGroup.matrixWorld)
    tmp.setFromMatrixPosition(markGroup.matrixWorld)
    plane.setFromNormalAndCoplanarPoint(normal, tmp)
    if (!raycaster.ray.intersectPlane(plane, hit)) return false
    mark.points.worldToLocal(pointerLocal.copy(hit))
    return true
  }

  function updatePointer(frame: Frame, ctx: ChapterContext, settle: number) {
    const raw = frame.pointerRaw
    if (raw.x !== lastRaw.x || raw.y !== lastRaw.y) {
      // (0,0) is the engine's initial value — only react once a real pointer exists
      pointerSeen = true
      lastMove = frame.time
      lastRaw.copy(raw)
    }
    let target = 0
    if (pointerSeen && projectPointer(raw, ctx.camera)) {
      const idle = frame.time - lastMove
      // touch has no hover: let the dent relax after a moment
      const hold = mobile ? 1 - smoothstep(0.8, 2.2, idle) : 1
      target = hold * settle * (pointerLocal.length() < 1.2 ? 1 : 0)
    }
    pointerAmt = damp(pointerAmt, target, 5, frame.dt)
    u.uPointer.value.copy(pointerLocal)
    u.uPointerAmt.value = pointerAmt
  }

  function updateHud(l: number, end: number, portrait: boolean, frame: Frame, ctx: ChapterContext) {
    reveal(hud.scrim, smoothstep(0.12, 0.26, l), 0)
    reveal(hud.eyebrow, smoothstep(0.13, 0.2, l))
    reveal(hud.title, smoothstep(0.15, 0.24, l), 22)
    reveal(hud.body, smoothstep(0.19, 0.27, l))
    reveal(hud.cta, smoothstep(0.22, 0.3, l))
    reveal(hud.links, smoothstep(0.25, 0.33, l), 8)
    reveal(hud.foot, smoothstep(0.27, 0.35, l), 8)

    // callout: decodes once when it appears, then holds clean text
    const co = smoothstep(0.27, 0.36, l)
    const on = co > 0.3
    hud.teleK.set('HARK_MARK', on, 0.5)
    if (portrait) {
      hud.teleV.set(`${count.toLocaleString('en-US')} PTS`, on, 0.7, 0.1)
      hud.teleC.set('LOCKED', on, 0.6, 0.25)
    } else {
      hud.teleV.set(`${count.toLocaleString('en-US')} PTS · LOCKED`, on, 0.7, 0.1)
      hud.teleC.set('39.9526 N · 75.1652 W', on, 0.8, 0.25)
    }
    // anchor: the top loop (desktop, label right) / its left flank (phones, label left)
    if (portrait) tmp.set(-0.1, 0.3, 0)
    else tmp.set(0.25, 0.38, 0)
    tmp.applyMatrix4(mark.points.matrixWorld)
    const fits = placeCallout(tmp, portrait, frame, ctx.camera)
    hud.callout.update(tmp, ctx.camera, frame.width, frame.height, fits ? co : 0)

    // sign-off
    const ev = smoothstep(0.86, 0.95, l)
    reveal(hud.endFlow, ev, 6)
    hud.endFlowTxt.set('End of transmission', l >= 0.87, 0.9)
    if (portrait) {
      // centre it in the gap between the pad's front rim and the copy
      tmp.set(0, 0, PLATFORM_R).applyMatrix4(platform.group.matrixWorld)
      const rim = toScreen(tmp, ctx.camera, frame).y
      const top = hud.wrap.offsetTop
      const gap = top - rim
      const h = hud.endFloat.offsetHeight || 12
      const y = rim + (gap - h) * 0.5
      if (hud.endFloat.dataset.y !== y.toFixed(0)) {
        hud.endFloat.dataset.y = y.toFixed(0)
        hud.endFloat.style.top = `${y.toFixed(0)}px`
      }
      const room = gap > h + 20 ? 1 : 0
      reveal(hud.endFloat, ev * room, 0)
      hud.endFloatTxt.set('End of transmission', l >= 0.87 && room > 0, 0.9)
    } else {
      reveal(hud.endFloat, 0, 0)
      hud.endFloatTxt.set('', false)
    }
    const isEnd = end > 0.6
    if (isEnd !== hud.isEnd) {
      hud.isEnd = isEnd
      hud.links.classList.toggle('is-end', isEnd)
    }
  }

  return {
    id: 'contact',
    group,

    init(ctx) {
      mobile = ctx.mobile
      motion = ctx.reducedMotion ? 0.3 : 1
      count = mobile ? 34000 : 68000
      mark = createMark(count, mobile, u)
      markGroup.add(mark.points, mark.trails)
      markGroup.position.y = MARK_Y
      group.add(markGroup)

      platform = createPlatform(mobile)
      platform.group.position.y = PLATFORM_Y
      group.add(platform.group)

      u.uPR.value = ctx.renderer.getPixelRatio()
      platform.moteMat.uniforms.uPR.value = ctx.renderer.getPixelRatio()
      buildHud(ctx.stage)
    },

    update(l, frame, ctx) {
      const time = frame.time * motion
      const { portrait } = layout(frame)
      const pr = ctx.renderer.getPixelRatio()
      u.uPR.value = pr
      platform.moteMat.uniforms.uPR.value = pr

      // ---- arrival ------------------------------------------------------
      const arrive = segment(l, 0.0, 0.26)
      const end = smoothstep(0.8, 1, l)
      u.uAssemble.value = arrive
      u.uTime.value = time
      u.uMotion.value = motion
      const S = portrait ? 1.6 : 1.9
      markGroup.scale.setScalar(S)
      // particles start just behind the camera (in mark-local units)
      const camLocalZ = (ctx.camera.position.z - markGroup.position.z) / S
      u.uStartZ.value = camLocalZ + 0.4
      u.uSize.value = (portrait ? 9 : 10) * S
      u.uBright.value = 1 + (1 - smoothstep(0.2, 0.34, l)) * 0.25 + end * 0.12
      mark.trails.visible = arrive < 0.99

      // holographic scan sweeps up the mark every few seconds
      const cycle = (time * 0.16) % 1
      u.uScanY.value = lerp(-0.9, 0.9, cycle) + (arrive < 1 ? 9 : 0)

      // gentle float + sway; a slow scroll-driven turn during the hold that
      // resolves to face the viewer square-on at the very end
      const hold = smoothstep(0.22, 1, l)
      const calm = 1 - end * 0.7
      markGroup.position.y = MARK_Y + Math.sin(time * 0.55) * 0.035 * calm
      markGroup.rotation.y = Math.sin(time * 0.21) * 0.16 * calm + lerp(-0.12, 0.14, hold) * (1 - end)
      markGroup.rotation.x = (Math.sin(time * 0.17) * 0.03 - 0.04) * calm

      // pointer + click pulse
      updatePointer(frame, ctx, smoothstep(0.2, 0.3, l))
      u.uPulse.value.set(pulseOrigin.x, pulseOrigin.y, 0, frame.time - pulseAt)

      // ---- platform -----------------------------------------------------
      platform.uTime.value = time
      const pOn = smoothstep(0.06, 0.24, l)
      platform.uOn.value = pOn
      platform.rings[0].rotation.z = time * 0.12
      platform.rings[1].rotation.z = -time * 0.05
      platform.rings[2].rotation.z = time * 0.03
      // docked: the dashed rings close into solid circles
      for (const r of platform.rings) {
        r.material.uniforms.uDuty.value = lerp(r.userData.duty as number, 1, ease.inOutCubic(end))
        r.material.uniforms.uBright.value = (r.userData.bright as number) * (1 + end * 0.35)
      }
      platform.group.scale.setScalar(lerp(0.6, 1, ease.outCubic(pOn)) * (portrait ? 0.72 : 0.78))

      // ---- post / sky -----------------------------------------------------
      const pp = ctx.post.params
      pp.bloomStrength = 0.62 + (1 - arrive) * 0.3 + end * 0.08
      pp.bloomRadius = 0.16 + (1 - arrive) * 0.2
      pp.bloomThreshold = 0.62
      pp.flash = (1 - smoothstep(0, 0.05, l)) * 0.45
      pp.glitch = (1 - smoothstep(0, 0.035, l)) * 0.3
      pp.aberration = 0.0025 + (1 - smoothstep(0, 0.2, l)) * 0.008
      pp.vignette = 0.62 + end * 0.12
      ctx.sky.params.warp = 1 - ease.outCubic(segment(l, 0, 0.2))
      ctx.sky.params.nebula = 0.8 + hold * 0.2 - end * 0.35
      ctx.sky.params.stars = 1

      // matrices are needed by the HUD projection this frame
      group.updateMatrixWorld()
      updateHud(l, end, portrait, frame, ctx)
    },

    camera(l, frame, out: CameraPose) {
      const { aspect, portrait } = layout(frame)
      const settle = ease.outCubic(segment(l, 0, 0.3))
      const hold = smoothstep(0.25, 1, l)
      const end = ease.inOutCubic(segment(l, 0.8, 1))

      if (portrait) {
        // mark in the upper half, copy below
        const fov = 46
        const dist = 9.4 / Math.max(0.62, Math.min(1, aspect / 0.46)) + end * 0.35
        const z = lerp(dist + 7, dist, settle)
        const az = lerp(-0.06, 0.06, hold) * (1 - end) + Math.sin(frame.time * 0.1) * 0.01 * motion
        out.position.set(Math.sin(az) * z, 0.65 + end * 0.2, Math.cos(az) * z)
        out.target.set(0, -1.75, 0)
        out.fov = lerp(78, fov, settle)
      } else {
        const fov = 34
        const dist = 8.2 + end * 0.55
        const z = lerp(dist + 8, dist, settle)
        // frame the mark right of centre; copy lives on the left
        const halfW = Math.tan((fov * Math.PI) / 360) * 8.2 * aspect
        const ox = -halfW * 0.4
        const az = lerp(-0.08, 0.08, hold) * (1 - end) + Math.sin(frame.time * 0.1) * 0.012 * motion
        out.position.set(ox + Math.sin(az) * z, 0.95 + end * 0.3, Math.cos(az) * z)
        out.target.set(ox, 0.05 + end * 0.06, 0)
        out.fov = lerp(74, fov, settle)
      }
      out.roll = (1 - settle) * 0.09
      out.parallax = 0.28 * settle * (1 - end * 0.5)
    },

    onPointerDown(frame, ctx) {
      if (!mark) return
      pointerSeen = true
      lastMove = frame.time
      lastRaw.copy(frame.pointerRaw)
      if (!projectPointer(frame.pointerRaw, ctx.camera) || pointerLocal.length() > 1.1) return
      pulseOrigin.copy(pointerLocal)
      pulseAt = frame.time
    },
  }
}
