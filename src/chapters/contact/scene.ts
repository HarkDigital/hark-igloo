import * as THREE from 'three'
import { NOISE, HASH } from '../../core/glsl'
import { rng } from '../../core/math'
import { logoOutlinePoints, logoPoints } from '../../logo/logo'

/*
 * Arrival scene pieces:
 *   createMark()      the Hark mark as ONE Points cloud (face + outline + halo)
 *                     plus a LineSegments "warp trail" layer sharing its motion
 *   createPlatform()  holographic pad: polar grid disc, concentric rings,
 *                     light column and rising motes
 */

/* ------------------------------------------------------------------ */
/* particle mark                                                       */
/* ------------------------------------------------------------------ */

export function markUniforms() {
  return {
    uTime: { value: 0 },
    uAssemble: { value: 1 },
    uStartZ: { value: 4 },
    uPR: { value: 1 },
    uSize: { value: 14 },
    uPointer: { value: new THREE.Vector3(99, 99, 0) },
    uPointerAmt: { value: 0 },
    uPointerR: { value: 0.16 },
    uPulse: { value: new THREE.Vector4(0, 0, 0, 99) },
    uScanY: { value: -9 },
    uBright: { value: 1 },
    uMotion: { value: 1 },
  }
}
export type MarkUniforms = ReturnType<typeof markUniforms>

/** Shared motion model: idle drift → arrival flight → pointer + pulse forces. */
const MOTION = /* glsl */ `
  uniform float uTime, uAssemble, uStartZ, uPointerAmt, uPointerR, uMotion;
  uniform vec3 uPointer;
  uniform vec4 uPulse;
  attribute vec4 aSeed;
  ${NOISE}

  float arrival(vec4 s) {
    float delay = s.z * 0.5 + s.x * 0.06;
    return clamp((uAssemble - delay) / 0.44, 0.0, 1.0);
  }

  vec3 settled(vec3 target, vec4 s) {
    float halo = step(1.5, s.w);
    float edge = step(0.5, s.w) * (1.0 - halo);
    float amp = mix(mix(0.011, 0.004, edge), 0.07, halo) * uMotion;
    vec3 q = target * 2.4 + vec3(0.0, 0.0, uTime * 0.11);
    vec3 d = vec3(snoise(q), snoise(q + vec3(17.1, 3.2, 9.4)), snoise(q + vec3(-7.3, 11.8, 2.1)));
    vec3 p = target + d * amp;
    // breathe: a slow swell travelling up the mark
    p.z += sin(uTime * 0.9 * uMotion + target.y * 4.0 + s.x * 6.2831) * 0.006 * uMotion;
    // halo motes orbit slowly
    float ha = uTime * 0.05 * uMotion * (0.5 + s.y);
    p.xz = mix(p.xz, mat2(cos(ha), -sin(ha), sin(ha), cos(ha)) * p.xz, halo);
    return p;
  }

  vec3 flight(vec3 home, vec4 s, float a) {
    float ang = s.x * 6.2831853 + s.y * 3.0;
    float rad = 0.35 + pow(s.y, 0.7) * 2.2;
    vec3 start = vec3(cos(ang) * rad, sin(ang) * rad * 0.75, uStartZ + s.z * 10.0 + s.x * 2.0);
    float ez = 1.0 - pow(1.0 - a, 3.2);
    float exy = smoothstep(0.1, 1.0, a);
    exy = exy * exy * (3.0 - 2.0 * exy);
    vec3 p;
    p.z = mix(start.z, home.z, ez);
    p.xy = mix(start.xy, home.xy, exy);
    return p;
  }

  vec3 forces(vec3 p, vec4 s) {
    vec2 d = p.xy - uPointer.xy;
    float dist = length(d);
    float f = exp(-(dist * dist) / (uPointerR * uPointerR)) * uPointerAmt;
    p.xy += (d / max(dist, 1e-4)) * f * uPointerR * 0.9;
    p.z += f * (0.08 + s.y * 0.16);
    // click shockwave
    float age = uPulse.w;
    float R = age * 1.1;
    float dd = length(p.xy - uPulse.xy);
    float rx = (dd - R) * 9.0;
    float ring = exp(-rx * rx) * exp(-age * 1.6);
    p.xy += normalize(p.xy - uPulse.xy + 1e-4) * ring * 0.06;
    p.z += ring * 0.12;
    return p;
  }
`

export function createMark(count: number, mobile: boolean, u: MarkUniforms) {
  const rand = rng(23)
  const nOutline = Math.floor(count * 0.14)
  const nHalo = Math.floor(count * 0.05)
  const nFace = count - nOutline - nHalo
  const face = logoPoints(nFace, { depth: 0.11, seed: 11 })
  const outline = logoOutlinePoints(nOutline)

  const pos = new Float32Array(count * 3)
  const seed = new Float32Array(count * 4)
  let k = 0
  for (let i = 0; i < nFace; i++, k++) {
    pos.set([face[i * 3], face[i * 3 + 1], face[i * 3 + 2]], k * 3)
    seed.set([rand(), rand(), rand(), 0], k * 4)
  }
  for (let i = 0; i < nOutline; i++, k++) {
    pos.set([outline[i * 3], outline[i * 3 + 1], (rand() - 0.5) * 0.1], k * 3)
    seed.set([rand(), rand(), rand(), 1], k * 4)
  }
  for (let i = 0; i < nHalo; i++, k++) {
    // loose dust around the mark, denser near it
    const a = rand() * Math.PI * 2
    const r = 0.25 + Math.pow(rand(), 1.6) * 0.95
    pos.set([Math.cos(a) * r, Math.sin(a) * r * 0.95, (rand() - 0.5) * 0.9], k * 3)
    seed.set([rand(), rand(), rand(), 2], k * 4)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6)

  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      uniform float uPR, uSize, uScanY, uBright;
      varying vec3 vColor;
      varying float vAlpha;
      ${MOTION}
      void main() {
        vec4 s = aSeed;
        float a = arrival(s);
        vec3 home = settled(position, s);
        vec3 p = flight(home, s, a);
        p = forces(p, s);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float depth = -mv.z;
        float halo = step(1.5, s.w);
        float edge = step(0.5, s.w) * (1.0 - halo);
        float size = uSize * (0.5 + s.z * 0.9) * mix(1.0, 1.25, edge) * mix(1.0, 0.8, halo);
        gl_PointSize = clamp(size * uPR / max(depth, 0.1), 0.0, 9.0 * uPR);
        gl_Position = projectionMatrix * mv;

        vec3 green = vec3(0.08, 1.0, 0.36);
        vec3 white = vec3(0.82, 1.0, 0.9);
        float w = smoothstep(0.82, 1.0, s.y) + edge * 0.35;
        vec3 c = mix(green, white, clamp(w, 0.0, 1.0));
        c *= 0.55 + 0.6 * s.x;
        c *= mix(1.0, 1.25, edge) * mix(1.0, 0.8, halo);
        // holographic scan band sweeping up the mark
        float sy = (position.y - uScanY) * 12.0;
        float scan = exp(-sy * sy);
        c += white * scan * 0.7 * (1.0 - halo);
        // hot while in flight
        c = mix(white * 1.6, c, smoothstep(0.55, 1.0, a));
        vColor = c * uBright;
        float near = smoothstep(0.25, 1.4, depth);
        vAlpha = step(0.0001, a) * near * mix(mix(0.2, 0.3, edge), 0.22, halo);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float soft = pow(1.0 - d * 2.0, 1.6);
        gl_FragColor = vec4(vColor * soft * vAlpha, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false

  // warp trails: a subset of particles drawn as motion streaks during arrival
  const nTrail = mobile ? 1600 : 4200
  const tPos = new Float32Array(nTrail * 2 * 3)
  const tSeed = new Float32Array(nTrail * 2 * 4)
  const tEnd = new Float32Array(nTrail * 2)
  const stride = Math.max(1, Math.floor((nFace + nOutline) / nTrail))
  for (let i = 0; i < nTrail; i++) {
    const src = Math.min(count - 1, i * stride)
    for (let e = 0; e < 2; e++) {
      const j = i * 2 + e
      tPos.set([pos[src * 3], pos[src * 3 + 1], pos[src * 3 + 2]], j * 3)
      tSeed.set([seed[src * 4], seed[src * 4 + 1], seed[src * 4 + 2], seed[src * 4 + 3]], j * 4)
      tEnd[j] = e
    }
  }
  const tGeo = new THREE.BufferGeometry()
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3))
  tGeo.setAttribute('aSeed', new THREE.BufferAttribute(tSeed, 4))
  tGeo.setAttribute('aEnd', new THREE.BufferAttribute(tEnd, 1))
  const tMat = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: /* glsl */ `
      attribute float aEnd;
      varying float vA;
      ${MOTION}
      void main() {
        vec4 s = aSeed;
        float a = arrival(s);
        float lag = 0.07 + s.y * 0.05;
        float at = max(a - lag * aEnd, 0.0);
        vec3 home = settled(position, s);
        vec3 p = flight(home, s, at);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float moving = 1.0 - smoothstep(0.7, 0.97, a);
        vA = step(0.0001, a) * moving * (1.0 - aEnd * 0.92) * smoothstep(0.2, 1.2, -mv.z);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.55, 1.0, 0.75) * vA * 0.9, 1.0); }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const trails = new THREE.LineSegments(tGeo, tMat)
  trails.frustumCulled = false

  return { points, trails, mat }
}

/* ------------------------------------------------------------------ */
/* holographic platform                                                */
/* ------------------------------------------------------------------ */

export function createPlatform(mobile: boolean) {
  const group = new THREE.Group()
  const uTime = { value: 0 }
  const uOn = { value: 1 }
  const R = 2.7

  // polar grid disc with concentric glowing rings
  const discMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uOn, uR: { value: R } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOn, uR;
      varying vec2 vP;
      float aline(float x, float w) { float d = fwidth(x); return 1.0 - smoothstep(w, w + d * 1.5, abs(x)); }
      void main() {
        float r = length(vP) / uR;
        float a = atan(vP.y, vP.x) / 6.2831853 + 0.5;
        float fade = 1.0 - smoothstep(0.35, 1.0, r);
        float grid = aline(fract(r * 16.0 + 0.5) - 0.5, 0.01) * 0.07;
        float spokes = aline(fract(a * 48.0 + 0.5) - 0.5, 0.008) * 0.05 * smoothstep(0.12, 0.3, r);
        vec3 g = vec3(0.1, 1.0, 0.42);
        vec3 col = g * (grid + spokes) * fade;
        // main rings
        col += g * aline(r - 0.33, 0.003) * 0.75;
        col += vec3(0.6, 1.0, 0.8) * aline(r - 0.345, 0.0012) * 0.45;
        col += g * aline(r - 0.52, 0.002) * 0.45 * step(0.5, fract(a * 72.0));
        col += g * aline(r - 0.7, 0.0016) * 0.3;
        col += g * aline(r - 0.9, 0.0012) * 0.16;
        // ticks around the 0.52 ring
        float tk = aline(fract(a * 120.0 + 0.5) - 0.5, 0.06) * step(0.47, r) * step(r, 0.5);
        col += g * tk * 0.25;
        // pool of light under the mark
        col += g * exp(-r * 7.0) * 0.14 + vec3(0.7, 1.0, 0.85) * exp(-r * 22.0) * 0.18;
        // slow scan pulse travelling outward
        float pr = fract(uTime * 0.08);
        float px = (r - pr) * 40.0;
        col += g * exp(-px * px) * 0.35 * (1.0 - pr);
        gl_FragColor = vec4(col * uOn, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 128), discMat)
  disc.rotation.x = -Math.PI / 2
  group.add(disc)

  // floating dashed rings just above the pad, counter-rotating
  const ringMat = (dashes: number, duty: number, bright: number) =>
    new THREE.ShaderMaterial({
      uniforms: { uOn, uDash: { value: dashes }, uDuty: { value: duty }, uBright: { value: bright } },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOn, uDash, uDuty, uBright;
        varying vec2 vP;
        void main() {
          float a = atan(vP.y, vP.x) / 6.2831853 + 0.5;
          float f = fract(a * uDash);
          float d = fwidth(a * uDash);
          float on = smoothstep(0.0, d, f) * (1.0 - smoothstep(uDuty - d, uDuty, f));
          gl_FragColor = vec4(vec3(0.15, 1.0, 0.45) * on * uBright * uOn, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  const rings: THREE.Mesh[] = []
  const specs = [
    { r0: 0.98, r1: 0.995, y: 0.05, dashes: 3, duty: 0.8, b: 0.8 },
    { r0: 1.2, r1: 1.212, y: 0.12, dashes: 64, duty: 0.55, b: 0.5 },
    { r0: 1.52, r1: 1.528, y: 0.02, dashes: 5, duty: 0.6, b: 0.4 },
  ]
  for (const sp of specs) {
    const m = new THREE.Mesh(new THREE.RingGeometry(sp.r0, sp.r1, 192, 1), ringMat(sp.dashes, sp.duty, sp.b))
    m.rotation.x = -Math.PI / 2
    m.position.y = sp.y
    rings.push(m)
    group.add(m)
  }

  // light column rising from the pad
  const H = 3.4
  const beamGeo = new THREE.CylinderGeometry(0.9, 1.05, H, 64, 1, true)
  beamGeo.translate(0, H / 2, 0)
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uOn, uH: { value: H } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying vec3 vP;
      void main() {
        vP = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOn, uH;
      varying vec3 vN; varying vec3 vW; varying vec3 vP;
      ${NOISE}
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        float facing = abs(dot(normalize(vN), V));
        float h = vP.y / uH;
        float a = atan(vP.z, vP.x);
        float streak = 0.55 + 0.45 * snoise(vec3(cos(a) * 3.0, sin(a) * 3.0, h * 2.0 - uTime * 0.25));
        float fade = pow(clamp(1.0 - h, 0.0, 1.0), 2.2) * smoothstep(0.0, 0.04, h);
        float body = pow(facing, 2.5);
        float edge = pow(1.0 - facing, 6.0) * 0.4;
        vec3 col = vec3(0.1, 1.0, 0.45) * (body * 0.16 + edge * 0.25) * streak * fade;
        gl_FragColor = vec4(col * uOn, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const beam = new THREE.Mesh(beamGeo, beamMat)
  group.add(beam)

  // rising motes
  const nM = mobile ? 180 : 420
  const rand = rng(5)
  const mp = new Float32Array(nM * 3)
  const ms = new Float32Array(nM * 4)
  for (let i = 0; i < nM; i++) {
    const a = rand() * Math.PI * 2
    const r = Math.sqrt(rand()) * 1.35
    mp.set([Math.cos(a) * r, 0, Math.sin(a) * r], i * 3)
    ms.set([rand(), rand(), rand(), rand()], i * 4)
  }
  const mGeo = new THREE.BufferGeometry()
  mGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3))
  mGeo.setAttribute('aSeed', new THREE.BufferAttribute(ms, 4))
  const moteMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uOn, uPR: { value: 1 }, uH: { value: H } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uPR, uH;
      varying float vA;
      ${HASH}
      void main() {
        float speed = 0.05 + aSeed.x * 0.09;
        float h = fract(aSeed.y + uTime * speed);
        vec3 p = position;
        p.y = h * uH * 0.85;
        p.x += sin(uTime * 0.4 + aSeed.z * 6.28) * 0.06;
        p.z += cos(uTime * 0.33 + aSeed.w * 6.28) * 0.06;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp((6.0 + aSeed.w * 10.0) * uPR / -mv.z, 0.0, 6.0 * uPR);
        vA = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.55, 1.0, h)) * (0.4 + 0.6 * aSeed.z);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOn;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float s = pow(1.0 - d * 2.0, 2.0);
        gl_FragColor = vec4(vec3(0.4, 1.0, 0.65) * s * vA * 0.9 * uOn, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const motes = new THREE.Points(mGeo, moteMat)
  motes.frustumCulled = false
  group.add(motes)

  return { group, uTime, uOn, rings, beam, motes, moteMat, disc }
}
