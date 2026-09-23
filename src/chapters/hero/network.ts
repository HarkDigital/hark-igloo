import * as THREE from 'three'
import { rng } from '../../core/math'
import { logoOutlinePoints } from '../../logo/logo'
import { COLOR_GLSL, ringMatrix } from './shared'

/*
 * A sparse constellation network receding into deep space around the mark:
 * nodes joined to their nearest neighbours by hairlines, a few of which carry
 * travelling packets of signal, plus a handful of lines that tie the network
 * to the mark's own contour. Also the faint orbital guides of the debris belt
 * (mark space, added to the mark root by the chapter).
 */

const LINE_VERT = /* glsl */ `
attribute float aT;
attribute float aSeed;
attribute float aLen;
varying float vT;
varying float vSeed;
varying float vLen;
varying float vDist;
void main() {
  vT = aT;
  vSeed = aSeed;
  vLen = aLen;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`
const LINE_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uTime;
uniform float uFade;
uniform float uMotion;
varying float vT;
varying float vSeed;
varying float vLen;
varying float vDist;
void main() {
  float fog = exp(-max(0.0, vDist - 7.0) * 0.075);
  float live = step(0.62, vSeed);
  float c = fract(uTime * uMotion * (0.05 + 0.08 * vSeed) + vSeed * 7.0);
  float pulse = exp(-pow((vT - c) * vLen * 5.0, 2.0)) * live;
  float a = (0.16 + pulse * 1.4) * fog * uFade;
  vec3 col = mix(vec3(0.7, 0.85, 0.8), SIGNAL * 1.6, 0.25 + pulse * 0.75);
  gl_FragColor = vec4(col * a, a);
}
`

const NODE_VERT = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform float uScale;
uniform float uTime;
uniform float uMotion;
varying float vSeed;
varying float vDist;
varying float vTw;
void main() {
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  vTw = 0.75 + 0.25 * sin(uTime * uMotion * (0.8 + aSeed * 2.0) + aSeed * 40.0);
  gl_PointSize = clamp(aSize * uScale / max(vDist, 0.1), 1.5, 22.0);
  gl_Position = projectionMatrix * mv;
}
`
const NODE_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uFade;
varying float vSeed;
varying float vDist;
varying float vTw;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  float core = 1.0 - smoothstep(0.18, 0.42, r);
  float ring = (1.0 - smoothstep(0.05, 0.14, abs(r - 0.78))) * step(0.8, vSeed);
  float fog = exp(-max(0.0, vDist - 7.0) * 0.07);
  float hot = step(0.72, vSeed);
  vec3 col = mix(vec3(0.85, 0.95, 0.9) * 0.9, SIGNAL * 2.2, hot);
  float a = (core + ring * 0.6) * fog * uFade * vTw;
  gl_FragColor = vec4(col * a, a);
}
`

const ORBIT_VERT = /* glsl */ `
attribute float aA;
attribute float aR;
varying float vA;
varying float vR;
void main() {
  vA = aA;
  vR = aR;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const ORBIT_FRAG = /* glsl */ `
${COLOR_GLSL}
uniform float uFade;
uniform float uPhase;
varying float vA;
varying float vR;
void main() {
  float dash = step(0.45, fract(vA * vR * 14.0));
  float d = abs(mod(vA - uPhase * (1.2 / vR) + 3.14159, 6.28318) - 3.14159);
  float sweep = exp(-d * 2.2);
  float a = (0.07 + dash * 0.08 + sweep * 0.35) * uFade;
  vec3 col = mix(vec3(0.75, 0.9, 0.85), SIGNAL * 1.4, sweep);
  gl_FragColor = vec4(col * a, a);
}
`

export class Network {
  /** world space */
  group = new THREE.Group()
  /** mark space (belt guides) */
  orbits: THREE.LineSegments
  private lineMat: THREE.ShaderMaterial
  private nodeMat: THREE.ShaderMaterial
  private orbitMat: THREE.ShaderMaterial

  /**
   * @param markToWorld transforms mark-space points to chapter space (for tie-in lines)
   */
  constructor(mobile: boolean, markToWorld: THREE.Matrix4) {
    const rand = rng(90210)
    const N = mobile ? 70 : 130
    const nodes: THREE.Vector3[] = []
    let guard = 0
    while (nodes.length < N && guard++ < 10000) {
      const p = new THREE.Vector3(
        (rand() * 2 - 1) * 10,
        -1.2 + Math.pow(rand(), 0.8) * 7.5,
        2.5 - Math.pow(rand(), 0.7) * 20,
      )
      // keep a clear pocket around the mark
      if (Math.abs(p.x) < 2.1 && Math.abs(p.y - 0.3) < 1.9 && p.z > -4.5) continue
      if (p.z > 1.5 && Math.abs(p.x) < 5) continue
      nodes.push(p)
    }

    // edges: 2 nearest neighbours, deduped
    const edges = new Set<string>()
    const pairs: [THREE.Vector3, THREE.Vector3][] = []
    for (let i = 0; i < nodes.length; i++) {
      const d = nodes
        .map((q, j) => ({ j, d: q.distanceTo(nodes[i]) }))
        .filter(o => o.j !== i && o.d < 5.2)
        .sort((a, b) => a.d - b.d)
        .slice(0, rand() < 0.35 ? 3 : 2)
      for (const { j } of d) {
        const k = i < j ? `${i}-${j}` : `${j}-${i}`
        if (edges.has(k)) continue
        edges.add(k)
        pairs.push([nodes[i], nodes[j]])
      }
    }
    // tie-ins from the mark's contour to the nearest nodes
    const outline = logoOutlinePoints(mobile ? 8 : 12)
    for (let i = 0; i < outline.length / 3; i++) {
      const a = new THREE.Vector3(outline[i * 3], outline[i * 3 + 1], 0).applyMatrix4(markToWorld)
      let best: THREE.Vector3 | null = null
      let bd = Infinity
      for (const q of nodes) {
        const d = q.distanceTo(a)
        if (d < bd && q.z < a.z + 0.5) {
          bd = d
          best = q
        }
      }
      if (best && bd < 7) pairs.push([a, best])
    }

    const pos: number[] = []
    const aT: number[] = []
    const aSeed: number[] = []
    const aLen: number[] = []
    for (const [a, b] of pairs) {
      const s = rand()
      const len = a.distanceTo(b)
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
      aT.push(0, 1)
      aSeed.push(s, s)
      aLen.push(len, len)
    }
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    lg.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1))
    lg.setAttribute('aSeed', new THREE.Float32BufferAttribute(aSeed, 1))
    lg.setAttribute('aLen', new THREE.Float32BufferAttribute(aLen, 1))
    const blend = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uMotion: { value: 1 } },
      ...blend,
    })
    const lines = new THREE.LineSegments(lg, this.lineMat)
    lines.frustumCulled = false
    this.group.add(lines)

    const np: number[] = []
    const ns: number[] = []
    const nseed: number[] = []
    for (const q of nodes) {
      const s = rand()
      np.push(q.x, q.y, q.z)
      ns.push(s > 0.72 ? 0.07 : 0.045)
      nseed.push(s)
    }
    const ng = new THREE.BufferGeometry()
    ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3))
    ng.setAttribute('aSize', new THREE.Float32BufferAttribute(ns, 1))
    ng.setAttribute('aSeed', new THREE.Float32BufferAttribute(nseed, 1))
    this.nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      uniforms: { uScale: { value: 800 }, uFade: { value: 1 }, uTime: { value: 0 }, uMotion: { value: 1 } },
      ...blend,
    })
    const pts = new THREE.Points(ng, this.nodeMat)
    pts.frustumCulled = false
    this.group.add(pts)

    // belt guides (mark space)
    const og: number[] = []
    const oa: number[] = []
    const or: number[] = []
    const m = ringMatrix()
    const v = new THREE.Vector3()
    const seg = 220
    for (const r of [0.98, 1.4, 1.9]) {
      for (let i = 0; i < seg; i++) {
        for (const k of [i, i + 1]) {
          const a = (k / seg) * Math.PI * 2
          v.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyMatrix4(m)
          og.push(v.x, v.y, v.z)
          oa.push(a)
          or.push(r)
        }
      }
    }
    const obg = new THREE.BufferGeometry()
    obg.setAttribute('position', new THREE.Float32BufferAttribute(og, 3))
    obg.setAttribute('aA', new THREE.Float32BufferAttribute(oa, 1))
    obg.setAttribute('aR', new THREE.Float32BufferAttribute(or, 1))
    this.orbitMat = new THREE.ShaderMaterial({
      vertexShader: ORBIT_VERT,
      fragmentShader: ORBIT_FRAG,
      uniforms: { uFade: { value: 1 }, uPhase: { value: 0 } },
      ...blend,
    })
    this.orbits = new THREE.LineSegments(obg, this.orbitMat)
    this.orbits.frustumCulled = false
    this.orbits.renderOrder = 1
  }

  update(fade: number, orbitFade: number, orbitPhase: number, time: number, motion: number, pointScale: number) {
    this.lineMat.uniforms.uFade.value = fade
    this.lineMat.uniforms.uTime.value = time
    this.lineMat.uniforms.uMotion.value = motion
    this.nodeMat.uniforms.uFade.value = fade
    this.nodeMat.uniforms.uTime.value = time
    this.nodeMat.uniforms.uMotion.value = motion
    this.nodeMat.uniforms.uScale.value = pointScale
    this.group.visible = fade > 0.002
    this.orbitMat.uniforms.uFade.value = orbitFade
    this.orbitMat.uniforms.uPhase.value = orbitPhase
    this.orbits.visible = orbitFade > 0.002
  }
}
