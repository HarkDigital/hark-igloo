import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { OrbitScene } from './scene'
import { ServicesHud } from './hud'
import {
  COUNT,
  HACK,
  SLOT,
  TL,
  WORLDS,
  blendPose,
  emergePose,
  establishPose,
  focusCenter,
  focusCoord,
  focusPose,
  makePose,
  worldAngle,
  worldPosition,
  type Pose,
  type View,
} from './system'
import './services.css'

/*
 * ORBIT — the services chapter (4.6 viewport heights, between Work and Shield).
 *
 *  0.000–0.065  Work's out-beat collapses to a bright point; we emerge from that
 *               glare, the glowing diamond of the Hark mark (the star core), and
 *               pull back to reveal the whole orrery
 *  0.065–0.105  establishing shot: 11 worlds on tilted instrument rings, intro
 *               ("What we do · Eleven ways to be heard.")
 *  0.105–0.935  each service in turn (≈0.075 each): the camera holds on a world,
 *               then arcs around the star to the next. The panel names a world
 *               only while the camera is locked on it; mid-flight it collapses
 *               to an "IN TRANSIT 05 → 06" readout
 *  0.935–1.000  accelerate past the last world toward a distant hex-glinting
 *               planet, which Shield picks up
 */

/** Camera-lock thresholds on the eased focus coordinate (with hysteresis). */
const LOCK_IN = 0.1
const LOCK_OUT = 0.15

export default function create(): Chapter {
  const group = new THREE.Group()
  let scene: OrbitScene | null = null
  let hud: ServicesHud | null = null
  const pose = makePose()
  let parallax = 0
  const pA = makePose()
  const pB = makePose()
  const pE = makePose()
  const tmpP = new THREE.Vector3()
  const tmpD = new THREE.Vector3()
  let establishAz = 0
  const focus: number[] = new Array(COUNT).fill(0)
  const labels: number[] = new Array(COUNT).fill(0)
  const theta: number[] = new Array(COUNT).fill(0)
  let fw = 1440
  let fh = 900
  const raycaster = new THREE.Raycaster()
  const sphere = new THREE.Sphere()
  let hover = -1
  let canvas: HTMLCanvasElement | null = null
  /** world the camera is locked on (-1 = in transit / establishing) */
  let lockK = -1

  const viewOf = (frame: Frame): View => {
    const aspect = frame.width / Math.max(1, frame.height)
    return { aspect, portrait: aspect < 0.9 }
  }

  const worldPose = (k: number, local: number, v: View, out: Pose) => {
    worldPosition(WORLDS[k], local, tmpP)
    return focusPose(WORLDS[k], tmpP, v, out)
  }

  /** Writes the camera pose for `local`; returns the camera's focus coordinate. */
  function computePose(local: number, v: View, out: Pose): number {
    establishPose(local, v, establishAz, pE)
    if (local < TL.emergeEnd) {
      emergePose(local, pE, out)
      return -1
    }
    const c0 = focusCenter(0)
    if (local < c0) {
      const s = ease.inOutCubic(segment(local, TL.holdEnd, c0 - 0.2 * SLOT))
      worldPose(0, local, v, pB)
      blendPose(pE, pB, s, 0, out)
      return -1 + s
    }
    const cLast = focusCenter(COUNT - 1)
    if (local < cLast) {
      const F = (local - c0) / SLOT
      const k = Math.min(COUNT - 2, Math.floor(F))
      const frac = F - k
      const s = ease.inOutCubic(segment(frac, 0.3, 0.8))
      worldPose(k, local, v, pA)
      worldPose(k + 1, local, v, pB)
      blendPose(pA, pB, s, 1.8, out)
      return k + s
    }
    if (local < TL.s1 || !scene) {
      worldPose(COUNT - 1, local, v, out)
      return COUNT - 1
    }
    // exit: accelerate past the moon toward the distant planet
    const s = segment(local, TL.s1, 1)
    worldPose(COUNT - 1, TL.s1, v, pA)
    tmpD.copy(scene.farPos).sub(pA.pos)
    const dist = tmpD.length()
    tmpD.divideScalar(dist)
    const e = ease.inCubic(s)
    out.pos.copy(pA.pos).lerp(tmpP.copy(scene.farPos).addScaledVector(tmpD, -scene.farRadius * 2.05), e)
    out.target.copy(pA.target).lerp(scene.farPos, ease.inOutQuad(Math.min(1, s * 1.25)))
    out.fov = lerp(pA.fov, pA.fov + 20, ease.inQuad(s))
    out.roll = -0.14 * ease.inQuad(s)
    return COUNT - 1 + s
  }

  function pick(frame: Frame, ctx: ChapterContext): number {
    if (!scene) return -1
    raycaster.setFromCamera(frame.pointerRaw, ctx.camera)
    let best = -1
    let bestD = Infinity
    for (let k = 0; k < COUNT; k++) {
      sphere.center.copy(scene.positions[k])
      sphere.radius = WORLDS[k].radius * Math.max(1.35, WORLDS[k].vis)
      const hit = raycaster.ray.intersectSphere(sphere, tmpD)
      if (hit) {
        const d = hit.distanceTo(raycaster.ray.origin)
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
    }
    return best
  }

  return {
    id: 'services',
    group,

    init(ctx) {
      scene = new OrbitScene(ctx.mobile)
      group.add(scene.group)
      hud = new ServicesHud(ctx.stage)
      canvas = ctx.renderer.domElement
      // establishing azimuth: swing in from ~60° behind the first world's pose
      worldPose(0, focusCenter(0), { aspect: 1.6, portrait: false }, pA)
      establishAz = Math.atan2(pA.pos.z, pA.pos.x) - 1.05
      // SEO beacon + ADA rings face the camera at their moment of focus
      for (const k of [3, 9]) {
        worldPose(k, focusCenter(k), { aspect: 1.6, portrait: false }, pB)
        worldPosition(WORLDS[k], focusCenter(k), tmpP)
        scene.setAxis(k, tmpD.copy(pB.pos).sub(tmpP).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.25))
      }
      // DOM that tracks 3D is placed with the exact render camera (incl. parallax)
      scene.orbits.onBeforeRender = (_r, _s, camera) => {
        hud?.project(camera, scene!.positions, fw, fh)
      }
    },

    update(local, frame, ctx) {
      if (!scene || !hud) return
      fw = frame.width
      fh = frame.height
      const v = viewOf(frame)
      hud.compact = frame.width < 768 || v.portrait

      const Fc = computePose(local, v, pose)
      const F = focusCoord(local)
      const dist = pose.pos.distanceTo(pose.target)
      const settle = smoothstep(0.03, 0.08, local) * (1 - segment(local, TL.s1, 1))
      parallax = dist * 0.03 * settle

      for (let k = 0; k < COUNT; k++) {
        focus[k] = 1 - smoothstep(0, 0.85, Math.abs(Fc - k))
        theta[k] = (worldAngle(WORLDS[k], local) * 180) / Math.PI
      }

      // ---- what should be on screen (the HUD tweens it in/out in time) ----
      // Copy follows the CAMERA, not the scroll slot: a world is named only
      // while the eased camera is locked on it, so wherever the scroll rests
      // the panel agrees with the picture. The exit leg stays on the last world.
      const Fl = Math.min(Fc, COUNT - 1)
      const nearK = Math.round(Fl)
      const dLock = Math.abs(Fl - nearK)
      lockK = nearK >= 0 && (dLock < LOCK_IN || (nearK === lockK && dLock < LOCK_OUT)) ? nearK : -1
      const leg = Math.floor(Fl)
      const legT = clamp((Fl - leg - LOCK_IN) / (1 - 2 * LOCK_IN))
      const kF = clamp(nearK, 0, COUNT - 1)
      const panelOn = Fc > -0.88 && local < TL.s1 + 0.006
      for (let k = 0; k < COUNT; k++) labels[k] = smoothstep(0.1, 0.3, Math.abs(Fc - k))
      const reticleVis = (1 - smoothstep(0.06, 0.16, Math.abs(Fl - kF))) * (1 - smoothstep(TL.s1, TL.s1 + 0.014, local))

      // ---- post + sky: energetic in/out beats, calm holds ----
      const inBeat = 1 - smoothstep(0, 0.048, local)
      const out = segment(local, TL.s1, 1)
      const travel = Math.sin(Math.PI * (Fc - Math.floor(Fc))) * (local > TL.s0 && local < TL.s1 ? 1 : 0)
      const p = ctx.post.params
      // reduced motion keeps the beats but drops the streaks and fringing
      const calm = ctx.reducedMotion ? 0.3 : 1
      p.bloomStrength = 0.85 + 0.35 * inBeat + 0.4 * out * out
      p.bloomRadius = 0.46 + 0.2 * inBeat
      p.exposure = 1 + 0.12 * inBeat + 0.2 * out * out
      p.flash = 0.3 * Math.pow(1 - smoothstep(0, 0.02, local), 2) + 0.3 * smoothstep(0.978, 1, local)
      p.aberration = 0.0028 + calm * (0.003 * travel + 0.01 * out * out + 0.006 * inBeat)
      p.vignette = 0.6
      ctx.sky.params.warp = calm * (0.55 * inBeat * inBeat + 0.85 * out * out * out)
      ctx.sky.params.nebula = 0.75
      ctx.sky.params.stars = 0.9

      const tanV = Math.tan((pose.fov * Math.PI) / 360)
      scene.update(local, frame, {
        focus,
        reticleWorld: kF,
        reticleVis,
        heal: segment(local, focusCenter(HACK) - 0.45 * SLOT, focusCenter(HACK) + 0.38 * SLOT),
        coreHeat: 1 + 0.35 * inBeat * inBeat,
        orbitMaster: smoothstep(0.01, 0.05, local) * (1 - 0.5 * out),
        farHex: 0.16 + 0.5 * smoothstep(0.9, 1, local),
        pxWorld: (2 * tanV) / Math.max(1, frame.height),
        pxScale: (frame.height * ctx.renderer.getPixelRatio()) / (2 * tanV),
      })

      hud.update({
        local,
        dt: frame.dt,
        calm: ctx.reducedMotion,
        introOn: local >= 0.034 && Fc <= -0.88,
        panelOn,
        lock: lockK,
        leg,
        legT,
        near: kF,
        railOn: Fc > -0.9 && local < TL.s1 + 0.006,
        calloutOn: panelOn && local < TL.s1 && lockK >= 0,
        labelsOn: local > 0.03 && local < TL.s1 - 0.004,
        progress: clamp((F + 0.5) / COUNT),
        labels,
        theta,
      })

      // hover a world → pointer cursor (click jumps to it)
      const interactive = local > 0.05 && local < TL.s1
      const h = interactive && !frame.mobile ? pick(frame, ctx) : -1
      if (h !== hover && canvas) {
        hover = h
        canvas.style.cursor = h >= 0 ? 'pointer' : ''
      }
    },

    camera(_local, _frame, out) {
      out.position.copy(pose.pos)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.roll = pose.roll
      out.parallax = parallax
    },

    onLeave() {
      hover = -1
      if (canvas) canvas.style.cursor = ''
    },

    onPointerDown(frame, ctx) {
      const k = pick(frame, ctx)
      if (k >= 0) window.__hark?.engine.gotoChapter('services', focusCenter(k), true)
    },
  }
}
