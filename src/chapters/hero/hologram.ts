import * as THREE from 'three'
import { logoFaceGeometry, logoOutlines, logoParts } from '../../logo/logo'
import { COLOR_GLSL, CONTOUR_EPS, MARK_DEPTH, simplifyShape } from './shared'

/*
 * The opening "signal": the Hark mark as a hologram. Thin glowing contour
 * ribbons on the front and back of the (future) solid, sparse ribs between
 * them like a CAD wireframe, a faint face fill with a dot grid that previews
 * exactly where the bricks will land, and HUD corner brackets. Additive,
 * depth-write off. All in mark space (1 unit tall).
 */

type Line = THREE.Vector2[]

function cleanClosed(line: Line): Line {
  const out = line.slice()
  if (out.length > 2 && out[0].distanceTo(out[out.length - 1]) < 1e-5) out.pop()
  return out
}

/** Build flat ribbons (XY plane, at z) for closed or open polylines. */
function ribbons(lines: { pts: Line; closed: boolean }[], zs: number[], width: number) {
  const pos: number[] = []
  const side: number[] = []
  const arc: number[] = []
  const seed: number[] = []
  const layer: number[] = []
  const index: number[] = []
  let base = 0
  let lineId = 0
  for (const z of zs) {
    for (const { pts, closed } of lines) {
      lineId++
      const n = pts.length
      if (n < 2) continue
      const count = closed ? n + 1 : n
      let s = 0
      for (let k = 0; k < count; k++) {
        const i = k % n
        const p = pts[i]
        const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]
        const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]
        if (k > 0) s += p.distanceTo(pts[(k - 1) % n])
        const tx = next.x - prev.x
        const ty = next.y - prev.y
        const tl = Math.hypot(tx, ty) || 1
        const nx = -ty / tl
        const ny = tx / tl
        for (const sd of [-1, 1]) {
          pos.push(p.x + nx * sd * width * 0.5, p.y + ny * sd * width * 0.5, z)
          side.push(sd)
          arc.push(s)
          seed.push((lineId * 0.6180339) % 1)
          layer.push(z)
        }
        if (k > 0) {
          const a = base + (k - 1) * 2
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      }
      base += count * 2
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1))
  g.setAttribute('aArc', new THREE.Float32BufferAttribute(arc, 1))
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1))
  g.setIndex(index)
  return g
}

const COMMON_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform float uOn;
uniform float uFade;
uniform float uFlicker;
uniform float uDrawY;
uniform float uMotion;
`

const RIBBON_VERT = /* glsl */ `
attribute float aSide;
attribute float aArc;
attribute float aSeed;
varying float vSide;
varying float vArc;
varying float vSeed;
varying vec3 vMark;
void main() {
  vSide = aSide;
  vArc = aArc;
  vSeed = aSeed;
  vMark = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const RIBBON_FRAG = /* glsl */ `
${COLOR_GLSL}
${COMMON_UNIFORMS}
uniform float uBright;
varying float vSide;
varying float vArc;
varying float vSeed;
varying vec3 vMark;
void main() {
  if (vMark.y > uDrawY) discard;
  float core = 1.0 - smoothstep(0.2, 1.0, abs(vSide));
  float t = uTime * uMotion;
  // comets of signal running along the contour
  float ph = fract(vArc / 0.85 - t * 0.16 + vSeed);
  float comet = pow(ph, 16.0) * 2.4 + pow(ph, 3.0) * 0.25;
  // slow scan band sweeping up the mark
  float by = fract(t * 0.18 + 0.2) * 1.8 - 0.9;
  float band = exp(-pow((vMark.y - by) * 10.0, 2.0));
  float scan = 0.82 + 0.18 * sin(vMark.y * 420.0 - t * 5.0);
  float front = vMark.z > 0.0 ? 1.0 : 0.55;
  float lead = exp(-abs(uDrawY - vMark.y) * 60.0) * (1.0 - step(0.999, uOn));
  vec3 col = mix(SIGNAL, MINT, 0.45) * (0.75 + comet + band * 0.9) * scan * front * uBright;
  col += MINT * lead * 3.0;
  float a = core * uOn * uFade * uFlicker;
  gl_FragColor = vec4(col * a, a);
}
`

const RIB_VERT = /* glsl */ `
varying vec3 vMark;
void main() {
  vMark = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const RIB_FRAG = /* glsl */ `
${COLOR_GLSL}
${COMMON_UNIFORMS}
varying vec3 vMark;
void main() {
  if (vMark.y > uDrawY) discard;
  float a = uOn * uFade * uFlicker * 0.55;
  vec3 col = MINT * 0.9;
  gl_FragColor = vec4(col * a, a);
}
`

const FACE_VERT = /* glsl */ `
varying vec3 vMark;
void main() {
  vMark = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const FACE_FRAG = /* glsl */ `
${COLOR_GLSL}
${COMMON_UNIFORMS}
uniform float uCell;
uniform float uFaceFade;
varying vec3 vMark;
void main() {
  if (vMark.y > uDrawY) discard;
  float t = uTime * uMotion;
  // dot grid on the same 45° lattice the bricks will land on
  const float R = 0.70710678;
  vec2 uv = vec2(vMark.x + vMark.y, vMark.y - vMark.x) * R / uCell;
  vec2 g = fract(uv) - 0.5;
  float dots = 1.0 - smoothstep(0.08, 0.16, length(g));
  float by = fract(t * 0.18 + 0.2) * 1.8 - 0.9;
  float band = exp(-pow((vMark.y - by) * 7.0, 2.0));
  float lines = 0.5 + 0.5 * sin(vMark.y * 300.0 - t * 3.0);
  float a = (0.035 + dots * 0.22 + band * 0.08 + lines * 0.02) * uOn * uFade * uFlicker * uFaceFade;
  vec3 col = mix(SIGNAL, MINT, 0.3) * (1.0 + band * 1.5);
  gl_FragColor = vec4(col * a, a);
}
`

export class Hologram {
  group = new THREE.Group()
  private uniforms = {
    uTime: { value: 0 },
    uOn: { value: 0 },
    uFade: { value: 1 },
    uFlicker: { value: 1 },
    uDrawY: { value: 1 },
    uMotion: { value: 1 },
  }
  private faceFade = { value: 1 }

  constructor(cell: number) {
    const shapes = [...logoParts().loopA, ...logoParts().loopB, ...logoParts().diamond]
    const outlines = logoOutlines(shapes, 220).map(l => ({ pts: cleanClosed(l), closed: true }))

    const blend = {
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }

    // contour ribbons, front + back of the extrusion
    const zf = MARK_DEPTH / 2 + 0.006
    const ribbonGeo = ribbons(outlines, [zf, -zf], 0.0042)
    const ribbonMat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: { ...this.uniforms, uBright: { value: 1.35 } },
      side: THREE.DoubleSide,
      ...blend,
    })
    const ribbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat)
    ribbonMesh.renderOrder = 2
    this.group.add(ribbonMesh)

    // HUD corner brackets framing the mark
    const B = 0.64
    const L = 0.1
    const corners: { pts: Line; closed: boolean }[] = []
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      corners.push({
        pts: [new THREE.Vector2(sx * B, sy * (B - L)), new THREE.Vector2(sx * B, sy * B), new THREE.Vector2(sx * (B - L), sy * B)],
        closed: false,
      })
    }
    const bracketMat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: { ...this.uniforms, uBright: { value: 0.55 } },
      side: THREE.DoubleSide,
      ...blend,
    })
    const brackets = new THREE.Mesh(ribbons(corners, [0], 0.004), bracketMat)
    brackets.renderOrder = 2
    this.group.add(brackets)

    // ribs between the front and back contours
    const ribPos: number[] = []
    for (const { pts } of outlines) {
      const step = Math.max(6, Math.round(pts.length / 18))
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i]
        ribPos.push(p.x, p.y, -zf, p.x, p.y, zf)
      }
    }
    const ribGeo = new THREE.BufferGeometry()
    ribGeo.setAttribute('position', new THREE.Float32BufferAttribute(ribPos, 3))
    const ribs = new THREE.LineSegments(
      ribGeo,
      new THREE.ShaderMaterial({ vertexShader: RIB_VERT, fragmentShader: RIB_FRAG, uniforms: this.uniforms, ...blend }),
    )
    ribs.renderOrder = 2
    this.group.add(ribs)

    // faint face fill
    const face = new THREE.Mesh(
      logoFaceGeometry(shapes.map(s => simplifyShape(s, CONTOUR_EPS))),
      new THREE.ShaderMaterial({
        vertexShader: FACE_VERT,
        fragmentShader: FACE_FRAG,
        uniforms: { ...this.uniforms, uCell: { value: cell }, uFaceFade: this.faceFade },
        side: THREE.DoubleSide,
        ...blend,
      }),
    )
    face.renderOrder = 1
    this.group.add(face)

    for (const o of this.group.children) o.frustumCulled = false
  }

  /**
   * @param on      0..1 power-on (loader reveal); drives the bottom→top draw-in
   * @param fade    0..1 scroll-driven visibility
   * @param flicker 0..1 instantaneous flicker multiplier
   */
  update(on: number, fade: number, flicker: number, time: number, motion: number, faceFade = 1) {
    const u = this.uniforms
    this.faceFade.value = faceFade
    u.uOn.value = Math.min(1, on * 1.4)
    u.uDrawY.value = on >= 1 ? 10 : -0.7 + on * 1.45
    u.uFade.value = fade
    u.uFlicker.value = flicker
    u.uTime.value = time
    u.uMotion.value = motion
    this.group.visible = fade > 0.002 && on > 0
  }
}
