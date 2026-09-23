import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../core/types'
import { clamp, lerp, segment, smoothstep } from '../core/math'
import { el } from '../core/dom'
import { Planet } from './Planet'
import { Sun } from './Sun'

// Dev preview for the world pieces (?only=lab-world). Owned by the World build.
//
//   0.00 – 0.34  horizon: camera skimming the limb, planet fills the bottom
//                third, sun rising behind it, city lights on the night side
//   0.34 – 0.68  full disc, three-quarter lit, with rings
//   0.68 – 1.00  hyperspace test (warp ramps 0 → 1; ≈0.3 at local 0.8)

const R = 10
const A_END = 0.34
const B_END = 0.68

const deg = THREE.MathUtils.degToRad

interface Shot {
  pos: THREE.Vector3
  target: THREE.Vector3
  fov: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let mobile = false

  // horizon planet
  const horizon = new Planet({ radius: R, cityLights: true, seed: 3, spin: 0.004, clouds: 0.4 })
  // ringed disc planet
  const ringed = new Planet({
    radius: R,
    seed: 11,
    rings: true,
    cityLights: true,
    spin: 0.012,
    clouds: 0.34,
  })
  ringed.group.rotation.set(0.1, 0, 0.36)

  // spin the horizon planet so a populated continent sits in the foreground
  {
    const n = new THREE.Vector3()
    let best = 0
    let bestScore = -1
    for (let k = 0; k < 48; k++) {
      const ang = (k / 48) * Math.PI * 2
      let score = 0
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 9; j++) {
          const phi = deg(10 + i * 4)
          const th = deg(-32 + j * 8)
          n.set(Math.sin(th) * Math.cos(phi), Math.sin(phi), Math.cos(th) * Math.cos(phi))
          n.applyAxisAngle(new THREE.Vector3(0, 1, 0), -ang)
          const s = horizon.surfaceAt(n)
          score += s.population * (0.6 + i * 0.1) + (s.land ? 0.15 : 0)
        }
      }
      if (score > bestScore) {
        bestScore = score
        best = ang
      }
    }
    horizon.spinAngle = best
  }
  const sun = new Sun()
  group.add(horizon.group, ringed.group, sun.object)

  const sunA = new THREE.Vector3()
  const sunB = new THREE.Vector3(-0.78, 0.32, 0.52).normalize()
  const shot: Shot = { pos: new THREE.Vector3(), target: new THREE.Vector3(), fov: 40 }
  const tmp = new THREE.Vector3()
  const center = new THREE.Vector3()

  let label: HTMLElement
  let title: HTMLElement

  function horizonShot(t: number, frame: Frame, out: Shot) {
    const portrait = frame.width / frame.height < 0.9
    const fov = portrait ? 60 : 38
    const D = R * 1.16
    const alpha = Math.asin(R / D)
    // limb top sits one third up from the bottom of the frame
    const beta = alpha + Math.atan(Math.tan(deg(fov / 2)) / 3)
    // slow drift along the orbit so the lights parallax
    const yaw = lerp(-0.05, 0.05, t)
    out.pos.set(Math.sin(yaw) * D, 0, Math.cos(yaw) * D)
    tmp.set(0, Math.sin(beta), -Math.cos(beta)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    out.target.copy(out.pos).addScaledVector(tmp, 20)
    out.fov = fov
    // sun just clearing the limb, a little right of centre
    const theta = alpha + deg(0.35)
    const psi = deg(portrait ? 6 : 16)
    sunA.set(Math.sin(theta) * Math.sin(psi), Math.sin(theta) * Math.cos(psi), -Math.cos(theta)).normalize()
  }

  function discShot(t: number, frame: Frame, out: Shot) {
    const portrait = frame.width / frame.height < 0.9
    const D = portrait ? 128 : 58
    const phi = lerp(-0.28, 0.28, t)
    out.pos.set(Math.sin(phi) * D, D * 0.14, Math.cos(phi) * D)
    out.target.set(portrait ? 0 : -R * 0.2, 0, 0)
    out.fov = portrait ? 52 : 34
  }

  function warpShot(_t: number, _frame: Frame, out: Shot) {
    out.pos.set(0, 0, 400)
    out.target.set(0, 30, 800)
    out.fov = 50
  }

  function computeShot(local: number, frame: Frame) {
    if (local < A_END) horizonShot(segment(local, 0, A_END), frame, shot)
    else if (local < B_END) discShot(segment(local, A_END, B_END), frame, shot)
    else warpShot(segment(local, B_END, 1), frame, shot)
  }

  return {
    id: 'lab-world',
    group,
    init(ctx) {
      mobile = ctx.mobile
      const wrap = el('div', 'lab-copy', undefined, ctx.stage)
      wrap.style.cssText =
        'position:absolute;left:var(--gutter);top:var(--safe-top);max-width:min(520px,calc(100vw - 2*var(--gutter)))'
      label = el('p', 'hud-eyebrow', 'World lab', wrap)
      title = el('h2', 'hud-h2', 'Horizon', wrap)
      void mobile
    },
    update(local, frame, ctx) {
      computeShot(local, frame)
      const inA = local < A_END
      const inB = local >= A_END && local < B_END
      horizon.group.visible = inA
      ringed.group.visible = inB
      horizon.setSunDirection(sunA)
      ringed.setSunDirection(sunB)
      if (inA) horizon.update(frame)
      if (inB) ringed.update(frame)

      // sun: rising behind the horizon planet, off-frame key light for the disc
      sun.object.visible = inA || inB
      if (inA) {
        sun.direction.copy(sunA)
        sun.update(frame, { position: shot.pos, fov: shot.fov, aspect: frame.width / frame.height }, [
          { center: center.set(0, 0, 0), radius: R },
        ])
      } else if (inB) {
        sun.direction.copy(sunB)
        ringed.group.getWorldPosition(center)
        sun.update(frame, { position: shot.pos, fov: shot.fov, aspect: frame.width / frame.height }, [{ center, radius: R }])
      }

      const warp = clamp((local - B_END - 0.02) / (1 - B_END - 0.02))
      ctx.sky.params.warp = warp
      if (warp > 0) ctx.post.params.bloomStrength = lerp(0.9, 1.05, warp)
      // punchy in/out beats at the lab's own segment cuts
      const cutA = 1 - smoothstep(0, 0.012, Math.abs(local - A_END))
      const cutB = 1 - smoothstep(0, 0.012, Math.abs(local - B_END))
      ctx.post.params.glitch = Math.max(cutA, cutB) * 0.6

      label.textContent = inA ? 'World lab · 01' : inB ? 'World lab · 02' : 'World lab · 03'
      title.textContent = inA ? 'Horizon' : inB ? 'Full disc' : `Warp ${warp.toFixed(2)}`
    },
    camera(local, frame, out: CameraPose) {
      computeShot(local, frame)
      out.position.copy(shot.pos)
      out.target.copy(shot.target)
      out.fov = shot.fov
      out.parallax = local < A_END ? 0.08 : local < B_END ? 0.6 : 0
    },
  }
}
