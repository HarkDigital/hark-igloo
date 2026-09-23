import * as THREE from 'three'
import type { Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
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
 * ORBIT — the services chapter.
 *
 *  0.00–0.07  emerge from the glowing diamond of the Hark mark (the star core)
 *             and pull back to reveal the whole orrery
 *  0.07–0.13  establishing shot: 11 worlds on tilted instrument rings, intro copy
 *  0.13–0.94  each service in turn (≈0.074 each): the camera arcs around the star
 *             to the next world, which swings forward; panel, callout and rail
 *             crossfade + decode, all derived from local
 *  0.94–1.00  accelerate past the last world toward a distant hex-glinting planet
 */
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
      hud.compact = frame.width < 768

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
      const kF = clamp(Math.round(F), 0, COUNT - 1)
      const dF = F - kF
      const panelOn = local >= TL.s0 - 0.008 && local < TL.s1 + 0.008
      const holding = dF > -0.32 && (dF < 0.32 || (kF === COUNT - 1 && local < TL.s1))
      for (let k = 0; k < COUNT; k++) {
        const near = 1 - smoothstep(0.3, 0.62, Math.abs(F - k))
        labels[k] = 1 - near
      }
      const reticleVis =
        Math.min(smoothstep(-0.42, -0.2, dF), 1 - smoothstep(0.3, 0.48, dF)) *
        window01(local, TL.s0 - 0.01, TL.s1 + 0.01, 0.02)

      // ---- post + sky: energetic in/out beats, calm holds ----
      const inBeat = 1 - smoothstep(0, 0.055, local)
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
        orbitMaster: smoothstep(0.012, 0.06, local) * (1 - 0.5 * out),
        farHex: 0.16 + 0.5 * smoothstep(0.9, 1, local),
        pxWorld: (2 * tanV) / Math.max(1, frame.height),
        pxScale: (frame.height * ctx.renderer.getPixelRatio()) / (2 * tanV),
      })

      hud.update({
        local,
        F,
        dt: frame.dt,
        calm: ctx.reducedMotion,
        introOn: local >= 0.036 && local < TL.s0 - 0.008,
        panelOn,
        railOn: local >= TL.s0 - 0.012 && local < TL.s1 + 0.008,
        calloutOn: panelOn && local < TL.s1 && holding,
        labelsOn: local > 0.035 && local < TL.s1 - 0.004,
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
