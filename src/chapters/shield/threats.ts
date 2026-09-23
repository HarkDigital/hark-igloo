import * as THREE from 'three'
import { MAX_IMPACTS } from './hexShield'

/** Cheap deterministic hash → [0,1) for (a, b) integer pairs. */
function hash(a: number, b: number) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const _u = new THREE.Vector3()
const _l = new THREE.Vector3()
function unit(out: THREE.Vector3, r1: number, r2: number) {
  const z = r1 * 2 - 1
  const a = r2 * Math.PI * 2
  const s = Math.sqrt(1 - z * z)
  return out.set(Math.cos(a) * s, Math.sin(a) * s, z)
}

const STREAK_VERT = /* glsl */ `
attribute vec3 aHead;
attribute vec3 aTail;
attribute float aAmp;
uniform vec2 uRes;
uniform float uWidth;
varying float vS;
varying float vSide;
varying float vAmp;
void main() {
  float s = position.x;
  float side = position.y;
  vec4 ch = projectionMatrix * viewMatrix * vec4(aHead, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(aTail, 1.0);
  vec2 ph = ch.xy / max(ch.w, 1e-3) * uRes;
  vec2 pt = ct.xy / max(ct.w, 1e-3) * uRes;
  vec2 d = ph - pt;
  vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = mix(ct, ch, s);
  float w = mix(0.4, uWidth, s * s);
  c.xy += nrm * side * w * 2.0 / uRes * c.w;
  vS = s;
  vSide = side;
  vAmp = aAmp;
  gl_Position = c;
}
`

const STREAK_FRAG = /* glsl */ `
varying float vS;
varying float vSide;
varying float vAmp;
void main() {
  if (vAmp <= 0.001) discard;
  float core = exp(-vSide * vSide * 5.0);
  float along = pow(vS, 2.6);
  vec3 red = vec3(1.0, 0.05, 0.1);
  vec3 hot = vec3(1.0, 0.62, 0.38);
  vec3 col = mix(red, hot, smoothstep(0.82, 1.0, vS));
  col *= along * core * 5.5 + along * 0.25;
  gl_FragColor = vec4(col * vAmp, 1.0);
}
`

const SPARK_VERT = /* glsl */ `
#define MAX_IMPACTS ${MAX_IMPACTS}
attribute float aIdx;
attribute vec4 aRand;
uniform vec4 uImpacts[MAX_IMPACTS];
uniform float uImpactAmp[MAX_IMPACTS];
uniform float uR;
uniform float uPx;
varying float vA;
void main() {
  int i = int(aIdx + 0.5);
  vec4 im = uImpacts[i];
  float amp = uImpactAmp[i];
  float age = clamp(im.w, 0.0, 1.0);
  vec3 d = im.xyz;
  vec3 r = normalize(aRand.xyz - 0.5 + 1e-3);
  vec3 t = normalize(r - d * dot(r, d) + 1e-4);
  float e = 1.0 - pow(1.0 - age, 3.0);
  float sp = e * (0.25 + aRand.w * 1.25);
  vec3 p = d * (uR + sp * 0.5 * aRand.w) + t * sp;
  vA = amp * pow(1.0 - age, 1.8);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = vA > 0.001 ? uPx * (0.6 + 1.4 * aRand.w) * (1.0 - age * 0.6) / max(-mv.z, 0.1) : 0.0;
  gl_Position = projectionMatrix * mv;
}
`

const SPARK_FRAG = /* glsl */ `
uniform float uSealed;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = exp(-d * 18.0);
  vec3 col = mix(vec3(1.0, 0.35, 0.12), vec3(0.2, 1.0, 0.45), uSealed);
  gl_FragColor = vec4(col * a * vA * 4.0, 1.0);
}
`

interface ThreatSeed {
  offset: number
  period: number
  gate: number
  trail: number
}

/**
 * Incoming "hack attempts": red streaks that fly in and strike the shield.
 * Fully derived from (local, time): each threat cycles on its own period,
 * scroll pushes the cycle forward, and every cycle re-rolls its target.
 */
export class Threats {
  group = new THREE.Group()
  readonly impacts: THREE.Vector4[]
  readonly amps: number[]
  private streakGeo: THREE.InstancedBufferGeometry
  private head: THREE.InstancedBufferAttribute
  private tail: THREE.InstancedBufferAttribute
  private amp: THREE.InstancedBufferAttribute
  private streakMat: THREE.ShaderMaterial
  private sparkMat: THREE.ShaderMaterial
  private seeds: ThreatSeed[] = []
  private count: number

  constructor(
    count: number,
    private radius: number,
    private breach: THREE.Vector3,
    impacts: THREE.Vector4[],
    amps: number[],
    mobile: boolean,
  ) {
    this.count = Math.min(count, MAX_IMPACTS)
    this.impacts = impacts
    this.amps = amps
    for (let k = 0; k < this.count; k++) {
      this.seeds.push({
        offset: hash(k, 11),
        period: 2.1 + hash(k, 12) * 1.7,
        gate: (k + 0.5) / this.count,
        trail: 2.6 + hash(k, 13) * 2.4,
      })
    }

    // streaks: one instanced quad per threat
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3))
    g.setIndex([0, 2, 1, 1, 2, 3])
    this.head = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3)
    this.tail = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3)
    this.amp = new THREE.InstancedBufferAttribute(new Float32Array(this.count), 1)
    this.head.setUsage(THREE.DynamicDrawUsage)
    this.tail.setUsage(THREE.DynamicDrawUsage)
    this.amp.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aHead', this.head)
    g.setAttribute('aTail', this.tail)
    g.setAttribute('aAmp', this.amp)
    g.instanceCount = this.count
    this.streakGeo = g
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: 2.6 } },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const streaks = new THREE.Mesh(g, this.streakMat)
    streaks.frustumCulled = false
    streaks.renderOrder = 3
    this.group.add(streaks)

    // impact sparks
    const per = mobile ? 10 : 18
    const n = this.count * per
    const idx = new Float32Array(n)
    const rnd = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      idx[i] = Math.floor(i / per)
      for (let j = 0; j < 4; j++) rnd[i * 4 + j] = hash(i, 40 + j)
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    sg.setAttribute('aIdx', new THREE.BufferAttribute(idx, 1))
    sg.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4))
    this.sparkMat = new THREE.ShaderMaterial({
      uniforms: {
        uImpacts: { value: impacts },
        uImpactAmp: { value: amps },
        uR: { value: radius },
        uPx: { value: 60 },
        uSealed: { value: 0 },
      },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const sparks = new THREE.Points(sg, this.sparkMat)
    sparks.frustumCulled = false
    sparks.renderOrder = 4
    this.group.add(sparks)
  }

  /**
   * @param activity 0..1 how many threats are live
   * @param toCam unit vector from planet toward the camera (threats aim at the visible side)
   * @returns strongest "just hit" pulse 0..1 (for glitch / shake)
   */
  update(
    local: number,
    time: number,
    activity: number,
    sealed: number,
    toCam: THREE.Vector3,
    res: THREE.Vector2,
    pixelRatio: number,
  ) {
    this.streakMat.uniforms.uRes.value.copy(res)
    this.streakMat.uniforms.uWidth.value = 2.4 * pixelRatio
    this.sparkMat.uniforms.uPx.value = 70 * pixelRatio
    this.sparkMat.uniforms.uSealed.value = sealed
    const R = this.radius
    const FLIGHT = 0.58
    const D = 24
    let pulse = 0
    const H = this.head.array as Float32Array
    const T = this.tail.array as Float32Array
    const A = this.amp.array as Float32Array

    for (let k = 0; k < this.count; k++) {
      const s = this.seeds[k]
      const amp = Math.min(1, Math.max(0, (activity * 1.15 - s.gate) / 0.18))
      const cyc = s.offset + time / s.period + local * 5.0
      const c = Math.floor(cyc)
      const p = cyc - c

      // target on the shield for this cycle
      const d = this.impacts[k]
      if (hash(k * 7 + 1, c) < 0.42) {
        unit(_u, hash(k, c * 3 + 1), hash(k, c * 3 + 2)).multiplyScalar(0.3)
        _u.add(this.breach).normalize()
      } else {
        unit(_u, hash(k, c * 3 + 1), hash(k, c * 3 + 2)).addScaledVector(toCam, 1.25).normalize()
      }
      // approach: mostly lateral so the streak reads across the screen
      unit(_l, hash(k, c * 3 + 3), hash(k, c * 3 + 4))
      _l.addScaledVector(_u, -_l.dot(_u)).normalize()
      _l.addScaledVector(_u, 0.5)
      const over = _l.dot(toCam) - 0.15
      if (over > 0) _l.addScaledVector(toCam, -over * 1.1)
      _l.normalize()

      let hx: number, hy: number, hz: number, tl: number
      let sAmp = amp
      if (p < FLIGHT) {
        const q = p / FLIGHT
        const dist = D * (1 - q)
        hx = _u.x * R + _l.x * dist
        hy = _u.y * R + _l.y * dist
        hz = _u.z * R + _l.z * dist
        tl = s.trail * Math.min(1, q * 4 + 0.2)
        sAmp *= Math.min(1, q * 6)
        d.set(_u.x, _u.y, _u.z, 1)
        this.amps[k] = 0
      } else {
        const age = (p - FLIGHT) / (1 - FLIGHT)
        hx = _u.x * R
        hy = _u.y * R
        hz = _u.z * R
        tl = s.trail * Math.max(0, 1 - age * 10)
        sAmp *= tl > 0 ? 1 : 0
        d.set(_u.x, _u.y, _u.z, age)
        this.amps[k] = amp
        pulse = Math.max(pulse, amp * Math.exp(-age * 16))
      }
      H[k * 3] = hx
      H[k * 3 + 1] = hy
      H[k * 3 + 2] = hz
      T[k * 3] = hx + _l.x * tl
      T[k * 3 + 1] = hy + _l.y * tl
      T[k * 3 + 2] = hz + _l.z * tl
      A[k] = sAmp
    }
    for (let k = this.count; k < MAX_IMPACTS; k++) this.amps[k] = 0
    this.head.needsUpdate = true
    this.tail.needsUpdate = true
    this.amp.needsUpdate = true
    return pulse
  }
}
