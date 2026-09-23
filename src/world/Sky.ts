import * as THREE from 'three'
import type { Frame } from '../core/types'
import { NOISE, FBM } from '../core/glsl'
import { rng } from '../core/math'
import { flushBakes } from './bakeQueue'

/**
 * Always-on space backdrop, centered on the camera so it reads as infinitely
 * far away. Two draw calls:
 *
 *   1. a full-screen nebula dome. The nebula (gas, galactic band, dust lanes)
 *      is baked once into a cube map on the first frame, so per frame it's a
 *      single texture fetch + palette math — cheap on phones.
 *   2. one instanced quad batch for every star: the static starfield (size /
 *      colour / twinkle variation, a handful of bright stars with diffraction
 *      glints that bloom) plus the hyperspace streak particles that only
 *      appear when `params.warp` > 0.
 *
 * Public API (other chapters depend on it): object, params, resetParams(),
 * update(frame, camera), SKY_DEFAULTS.
 */
export interface SkyParams {
  /** 0..1 hyperspace: stars stretch into streaks along view direction */
  warp: number
  /** 0..1 nebula brightness multiplier */
  nebula: number
  /** 0..1 star brightness multiplier */
  stars: number
  /** -1..1 shifts the nebula palette (0 = brand teal/green, -1 = cold violet, 1 = warm) */
  hue: number
}

export const SKY_DEFAULTS: SkyParams = { warp: 0, nebula: 1, stars: 1, hue: 0 }

/** Direction perpendicular to the galactic band (world space). */
const BAND_NORMAL = new THREE.Vector3(0.45, 0.85, 0.22).normalize()

// ---------------------------------------------------------------- nebula bake

const BAKE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// Writes four sqrt-encoded masks the runtime shader colours:
//   r = emission gas A (teal / green), g = emission gas B (indigo / violet)
//   b = galactic band glow (unresolved starlight), a = dust lanes (absorption)
const BAKE_FRAG = /* glsl */ `
uniform vec3 uBandN;
varying vec3 vDir;
${NOISE}
${FBM}
void main() {
  vec3 d = normalize(vDir);

  // galactic band: a warped great circle with a bright core
  float b = dot(d, uBandN);
  float bw = b + 0.11 * fbm(d * 1.4 + 3.1, 3);
  float broad = exp(-(bw * bw) / (0.36 * 0.36));
  float core = exp(-(bw * bw) / (0.10 * 0.10));

  // domain warp shared by the gas layers → billowing, filamentary shapes
  vec3 q = d * 1.9;
  vec3 w = vec3(snoise(q + 1.7), snoise(q + vec3(9.2, 3.1, 0.4)), snoise(q + vec3(4.4, 7.7, 2.2)));

  float gA = fbm(q * 1.15 + w * 0.75, 6) * 0.5 + 0.5;
  float gasA = smoothstep(0.40, 0.92, gA);
  gasA *= gasA;
  gasA *= 0.18 + 1.1 * broad;

  float gB = fbm(d * 1.35 + w * 0.9 + vec3(21.0, 4.0, 9.0), 5) * 0.5 + 0.5;
  float gasB = smoothstep(0.44, 0.9, gB);
  gasB *= gasB;
  gasB *= (0.22 + 0.9 * broad) * (1.0 - 0.45 * core);

  // unresolved starlight: soft, mottled
  float mott = fbm(d * 6.0 + w * 0.25 + 7.0, 5) * 0.5 + 0.5;
  float glow = (broad * 0.28 + core * 0.72) * (0.35 + 0.9 * mott * mott);

  // dust: ridged filaments hugging the band core (a "great rift")
  float ridge = 1.0 - abs(fbm(d * 3.6 + w * 0.35 + 40.0, 5));
  float dust = smoothstep(0.62, 0.98, ridge) * (core * 0.95 + broad * 0.35);
  float clumps = smoothstep(0.05, 0.45, fbm(d * 2.4 + w * 0.4 + 60.0, 4));
  dust = max(dust, clumps * core * 0.85);

  gl_FragColor = sqrt(clamp(vec4(gasA, gasB, glow, dust), 0.0, 1.0));
}
`

// ---------------------------------------------------------------- dome

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // full-screen triangle; reconstruct the world-space view ray per vertex
  vec3 view = vec3(position.x / projectionMatrix[0][0], position.y / projectionMatrix[1][1], -1.0);
  vDir = transpose(mat3(viewMatrix)) * view;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`

const DOME_FRAG = /* glsl */ `
uniform samplerCube uNeb;
uniform float uReady;
uniform float uNebula;
uniform float uHue;
uniform float uWarp;
uniform float uTime;
varying vec3 vDir;

vec3 pick(vec3 cold, vec3 mid, vec3 warm, float h) {
  return h < 0.0 ? mix(mid, cold, -h) : mix(mid, warm, h);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 col = vec3(0.00062, 0.00085, 0.0011);

  vec3 cA = pick(vec3(0.10, 0.22, 0.95), vec3(0.00, 0.62, 0.50), vec3(0.95, 0.42, 0.10), uHue);
  vec3 cB = pick(vec3(0.42, 0.14, 1.00), vec3(0.26, 0.12, 0.85), vec3(0.85, 0.12, 0.32), uHue);
  vec3 cG = pick(vec3(0.55, 0.62, 1.00), vec3(0.62, 0.80, 0.86), vec3(1.00, 0.82, 0.62), uHue);

  if (uReady > 0.5) {
    vec4 n = textureCube(uNeb, d);
    n *= n;
    vec3 neb = cA * n.r * 0.085 + cB * n.g * 0.05 + cG * n.b * 0.026;
    // dust eats both gas and starlight
    neb *= 1.0 - 0.88 * n.a;
    col += neb * uNebula;
  }

  // hyperspace: a faint tunnel of light around the vanishing point
  if (uWarp > 0.001) {
    float f = max(dot(d, fwd), 0.0);
    float tunnel = pow(f, 18.0) * 0.06 + pow(f, 4.0) * 0.012;
    col += (cA * 0.8 + vec3(0.12)) * tunnel * uWarp * uWarp;
    // edges fall off so the streaks read against black
    col *= 1.0 - 0.35 * uWarp * (1.0 - f);
  }

  gl_FragColor = vec4(col, 1.0);
}
`

// ---------------------------------------------------------------- stars

const STAR_VERT = /* glsl */ `
attribute vec4 aA; // static: dir.xyz, kind | warp: x, y, zSeed, kind
attribute vec4 aB; // size px, brightness, twinkle, seed
attribute vec3 aC; // colour
uniform vec2 uRes;
uniform float uPx;
uniform float uTime;
uniform float uWarp;
uniform float uPhase;
uniform float uStars;
uniform float uTwinkle;
varying vec3 vCol;
varying vec2 vP;
varying float vLen;
varying float vSig;
varying float vGlint;

void main() {
  float kind = aA.w;
  float seed = aB.w;
  float bright = aB.y;
  float sig = aB.x * uPx;
  vec3 headV;
  vec3 tailV;

  if (kind < 1.5) {
    vec3 dV = mat3(viewMatrix) * aA.xyz;
    // stretch toward the vanishing point: tail direction slides to -Z
    float k = uWarp * uWarp * (0.9 + 1.8 * fract(seed * 13.7));
    headV = dV * 100.0;
    tailV = normalize(dV + vec3(0.0, 0.0, -k)) * 100.0;
    float tw = 1.0 + aB.z * uTwinkle * sin(uTime * (0.7 + 2.6 * fract(seed * 7.13)) + seed * 43.0);
    // at speed only the brighter stars survive as streaks (keeps the tunnel dark)
    float keep = mix(1.0, smoothstep(0.2, 0.9, bright), smoothstep(0.0, 0.7, uWarp));
    bright *= tw * uStars * keep * (1.0 - 0.45 * uWarp);
    // glints fade into plain streaks at warp
    vGlint = kind > 0.5 ? 1.0 - smoothstep(0.0, 0.35, uWarp) : 0.0;
  } else {
    // hyperspace particle: lives in view space, rushes toward the camera
    float f = fract(aA.z - uPhase * (0.75 + 0.5 * fract(seed * 3.3)));
    float z = -mix(1.5, 480.0, f);
    headV = vec3(aA.xy, z);
    float len = (14.0 + 110.0 * fract(seed * 5.17)) * uWarp * uWarp + 0.5;
    tailV = headV + vec3(0.0, 0.0, -len);
    float fade = smoothstep(0.0, 0.06, f) * smoothstep(1.0, 0.72, f);
    bright *= fade * smoothstep(0.08, 0.55, uWarp) * uStars;
    vGlint = 0.0;
  }

  vec4 hc = projectionMatrix * vec4(headV, 1.0);
  vec4 tc = projectionMatrix * vec4(tailV, 1.0);
  if (hc.w < 0.05 || tc.w < 0.05 || bright < 0.0015) {
    gl_Position = vec4(3.0, 3.0, 3.0, 1.0);
    return;
  }
  vec2 hs = hc.xy / hc.w * 0.5 * uRes;
  vec2 ts = tc.xy / tc.w * 0.5 * uRes;
  vec2 ax = hs - ts;
  float len = length(ax);
  vec2 dir = len > 0.001 ? ax / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // quad half-extent: gaussian tail, or the diffraction spikes for glints
  float q = kind > 0.5 && kind < 1.5 ? sig * 22.0 * vGlint + sig * 3.2 : sig * 3.2 + 1.0;
  float along = position.x * 0.5 + 0.5;
  vec2 px = mix(ts, hs, along) + dir * position.x * q + nrm * position.y * q;
  vP = vec2(along * len + position.x * q, position.y * q);
  vLen = len;
  vSig = sig;
  vCol = aC * bright;
  gl_Position = vec4(px / (0.5 * uRes), 0.0, 1.0);
}
`

const STAR_FRAG = /* glsl */ `
uniform float uPx;
varying vec3 vCol;
varying vec2 vP;
varying float vLen;
varying float vSig;
varying float vGlint;

void main() {
  float cx = clamp(vP.x, 0.0, vLen);
  vec2 d = vec2(vP.x - cx, vP.y);
  float s = max(vSig, 0.55);
  float I = exp(-dot(d, d) / (s * s));
  if (vLen > 0.75) {
    // streak: bright head, tail fading toward the vanishing point
    float a = cx / vLen;
    I *= 0.04 + 0.96 * a * a * a;
  }
  if (vGlint > 0.001) {
    vec2 g = vec2(vP.x - vLen, vP.y);
    float w = 0.55 * uPx;
    float L = vSig * 6.0;
    float sx = exp(-abs(g.y) / w) * exp(-abs(g.x) / L);
    float sy = exp(-abs(g.x) / w) * exp(-abs(g.y) / L);
    float r = length(g);
    float halo = exp(-r / (vSig * 2.2)) * 0.22 + exp(-r / (vSig * 7.0)) * 0.035;
    I += ((sx + sy) * 0.42 + halo) * vGlint;
  }
  gl_FragColor = vec4(vCol * I, 1.0);
}
`

/** Rough blackbody-ish tints (linear), weighted toward white/blue-white. */
function starColor(r: () => number, out: THREE.Color) {
  const t = r()
  if (t < 0.5) out.setRGB(0.82, 0.9, 1.0) // blue-white
  else if (t < 0.8) out.setRGB(1.0, 0.98, 0.95) // white
  else if (t < 0.93) out.setRGB(1.0, 0.86, 0.66) // pale gold
  else if (t < 0.975) out.setRGB(1.0, 0.66, 0.42) // orange
  else out.setRGB(0.62, 1.0, 0.86) // a rare teal-green, on brand
  return out
}

export class Sky {
  object = new THREE.Group()
  params: SkyParams = { ...SKY_DEFAULTS }
  private current: SkyParams = { ...SKY_DEFAULTS }
  private dome: THREE.Mesh
  private domeMat: THREE.ShaderMaterial
  private starMesh: THREE.Mesh
  private starMat: THREE.ShaderMaterial
  private starGeo: THREE.InstancedBufferGeometry
  private staticCount: number
  private totalCount: number
  private cube: THREE.WebGLCubeRenderTarget
  private renderer: THREE.WebGLRenderer | null = null
  private baked = false
  private phase = 0
  private tmpSize = new THREE.Vector2()

  constructor(private mobile: boolean) {
    // --- nebula dome
    this.cube = new THREE.WebGLCubeRenderTarget(mobile ? 512 : 1024, {
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this.cube.texture.colorSpace = THREE.NoColorSpace

    const tri = new THREE.BufferGeometry()
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uNeb: { value: this.cube.texture },
        uReady: { value: 0 },
        uNebula: { value: 1 },
        uHue: { value: 0 },
        uWarp: { value: 0 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.dome = new THREE.Mesh(tri, this.domeMat)
    this.dome.frustumCulled = false
    this.dome.renderOrder = -2
    this.dome.onBeforeRender = renderer => {
      this.renderer = renderer
    }
    this.object.add(this.dome)

    // --- stars
    const r = rng(20160419)
    const nStatic = mobile ? 7000 : 15000
    const nGlint = mobile ? 9 : 14
    const nWarp = mobile ? 420 : 900
    this.staticCount = nStatic + nGlint
    this.totalCount = nStatic + nGlint + nWarp
    const N = this.totalCount
    const A = new Float32Array(N * 4)
    const B = new Float32Array(N * 4)
    const Cc = new Float32Array(N * 3)
    const col = new THREE.Color()
    const v = new THREE.Vector3()
    const bn = BAND_NORMAL
    // a basis in the band plane, so we can scatter stars around it
    const bu = new THREE.Vector3(0, 0, 1).cross(bn).normalize()
    const bv = new THREE.Vector3().crossVectors(bn, bu)
    const gauss = () => {
      let u = 0
      for (let i = 0; i < 4; i++) u += r()
      return (u - 2) / 0.577 // ~N(0,1)
    }
    for (let i = 0; i < N; i++) {
      if (i < nStatic + nGlint) {
        const glint = i >= nStatic
        if (!glint && r() < 0.42) {
          // concentrated along the galactic band
          const th = r() * Math.PI * 2
          const lat = gauss() * 0.11
          v.copy(bu).multiplyScalar(Math.cos(th)).addScaledVector(bv, Math.sin(th)).addScaledVector(bn, lat).normalize()
        } else if (glint) {
          // bright stars placed where cameras tend to look (roughly -Z hemisphere + a few elsewhere)
          v.set(r() * 2 - 1, r() * 1.4 - 0.7, -0.4 - r() * 0.9)
          if (i % 3 === 0) v.z *= -1
          v.normalize()
        } else {
          // uniform on the sphere, from our deterministic rng
          const z = r() * 2 - 1
          const t = r() * Math.PI * 2
          const s = Math.sqrt(1 - z * z)
          v.set(Math.cos(t) * s, z, Math.sin(t) * s)
        }
        A[i * 4 + 0] = v.x
        A[i * 4 + 1] = v.y
        A[i * 4 + 2] = v.z
        A[i * 4 + 3] = glint ? 1 : 0
        let size: number
        let bright: number
        if (glint) {
          size = 1.25 + r() * 0.6
          bright = 2.2 + r() * 2.2
        } else {
          const m = Math.pow(r(), 5.2) // magnitude: mostly faint
          size = 0.58 + m * 0.9 + r() * 0.12
          bright = 0.05 + m * 1.15 + r() * 0.05
          // a few extra-bright non-glint stars
          if (r() < 0.012) {
            bright += 0.9 + r() * 0.9
            size += 0.25
          }
        }
        B[i * 4 + 0] = size
        B[i * 4 + 1] = bright
        B[i * 4 + 2] = r() < 0.45 ? 0.12 + r() * 0.3 : 0.03
        B[i * 4 + 3] = r() * 100
        starColor(r, col)
        if (glint) col.lerp(new THREE.Color(0.9, 0.97, 1.0), 0.5)
      } else {
        // hyperspace particle — a hollow cylinder around the view axis
        const ang = r() * Math.PI * 2
        const rad = 2.2 + Math.pow(r(), 0.9) * 46
        A[i * 4 + 0] = Math.cos(ang) * rad
        A[i * 4 + 1] = Math.sin(ang) * rad
        A[i * 4 + 2] = r()
        A[i * 4 + 3] = 2
        B[i * 4 + 0] = 0.62 + r() * 0.5
        B[i * 4 + 1] = 0.1 + Math.pow(r(), 3.2) * 1.9
        B[i * 4 + 2] = 0
        B[i * 4 + 3] = r() * 100
        const t = r()
        if (t < 0.62) col.setRGB(0.85, 0.94, 1.0)
        else if (t < 0.86) col.setRGB(0.25, 1.0, 0.62) // signal-green streaks
        else if (t < 0.95) col.setRGB(0.45, 0.85, 1.0)
        else col.setRGB(0.62, 0.45, 1.0)
      }
      Cc[i * 3 + 0] = col.r
      Cc[i * 3 + 1] = col.g
      Cc[i * 3 + 2] = col.b
    }

    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
    g.setIndex([0, 1, 2, 0, 2, 3])
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 4))
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 4))
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(Cc, 3))
    g.instanceCount = this.staticCount
    this.starGeo = g
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) },
        uPx: { value: 1 },
        uTime: { value: 0 },
        uWarp: { value: 0 },
        uPhase: { value: 0 },
        uStars: { value: 1 },
        uTwinkle: { value: 1 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.starMesh = new THREE.Mesh(g, this.starMat)
    this.starMesh.frustumCulled = false
    this.starMesh.renderOrder = -1
    this.starMesh.onBeforeRender = renderer => {
      renderer.getDrawingBufferSize(this.tmpSize)
      this.starMat.uniforms.uRes.value.copy(this.tmpSize)
      this.starMat.uniforms.uPx.value = renderer.getPixelRatio()
    }
    this.object.add(this.starMesh)
    this.object.renderOrder = -10
  }

  resetParams() {
    Object.assign(this.params, SKY_DEFAULTS)
  }

  /** Bake the nebula masks into the cube map (runs once, outside any render). */
  private bake(renderer: THREE.WebGLRenderer) {
    const scene = new THREE.Scene()
    const geo = new THREE.BoxGeometry(2, 2, 2)
    const mat = new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      uniforms: { uBandN: { value: BAND_NORMAL.clone() } },
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    })
    scene.add(new THREE.Mesh(geo, mat))
    const cam = new THREE.CubeCamera(0.1, 10, this.cube)
    const prevTone = renderer.toneMapping
    const prevAuto = renderer.autoClear
    renderer.toneMapping = THREE.NoToneMapping
    renderer.autoClear = true
    try {
      cam.update(renderer, scene)
      this.domeMat.uniforms.uReady.value = 1
    } catch (err) {
      console.warn('[hark] sky bake failed', err)
    } finally {
      renderer.toneMapping = prevTone
      renderer.autoClear = prevAuto
      geo.dispose()
      mat.dispose()
    }
    this.baked = true
  }

  update(frame: Frame, camera: THREE.PerspectiveCamera) {
    if (!this.baked && this.renderer) this.bake(this.renderer)
    // planet surfaces etc. bake here, outside any render, before the reveal
    if (this.renderer) flushBakes(this.renderer)

    const k = 1 - Math.exp(-4 * frame.dt)
    for (const key of Object.keys(this.params) as (keyof SkyParams)[]) {
      this.current[key] += (this.params[key] - this.current[key]) * k
    }
    const c = this.current
    const warp = Math.min(1, Math.max(0, c.warp))
    // idle motion only: the rush speed follows the (damped) warp amount
    this.phase = (this.phase + frame.dt * 1.25 * Math.pow(warp, 1.4)) % 1000

    this.object.position.copy(camera.position)

    const du = this.domeMat.uniforms
    du.uNebula.value = c.nebula
    du.uHue.value = c.hue
    du.uWarp.value = warp
    du.uTime.value = frame.time

    const su = this.starMat.uniforms
    su.uTime.value = frame.time
    su.uWarp.value = warp
    su.uPhase.value = this.phase
    su.uStars.value = c.stars
    su.uTwinkle.value = frame.reducedMotion ? 0.3 : 1
    // skip the hyperspace particles entirely when we're not warping
    this.starGeo.instanceCount = warp > 0.02 ? this.totalCount : this.staticCount
  }
}
