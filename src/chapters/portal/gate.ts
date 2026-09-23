import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { HASH, NOISE, FBM } from '../../core/glsl'
import { logoParts } from '../../logo/logo'

/*
 * Geometry + materials for the Gate: a heavy segmented ring (instanced arc
 * blocks with glowing seams), two gimbal rings that align, Hark-diamond
 * keystones, the plasma core with crackling arcs, the event horizon disc and
 * the streak fields used for the in/out beats.
 */

export const GATE = {
  N: 36,
  R0: 2.52,
  R1: 3.3,
  /** half-gap between segments, radians */
  GAP: 0.0062,
  /** radius of the horizon disc (inside the dial ring) */
  HORIZON: 2.2,
}

export const SIGNAL = new THREE.Color(0.12, 1.0, 0.36)

/* ------------------------------------------------------------------ */
/* shared uniforms                                                     */
/* ------------------------------------------------------------------ */

export function makeShared() {
  return {
    uTime: { value: 0 },
    uCorePos: { value: new THREE.Vector3() },
    uCorePower: { value: 0 },
    uKeyDir: { value: new THREE.Vector3(-0.55, 0.75, 0.55).normalize() },
  }
}
export type Shared = ReturnType<typeof makeShared>

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Beveled annular sector between radii r0..r1, angles -h..h, spanning z0..z1. */
function sector(r0: number, r1: number, h: number, z0: number, z1: number, bevel = 0.016, curve = 14) {
  const bs = bevel
  const a0 = -h + bs / r1
  const a1 = h - bs / r1
  const s = new THREE.Shape()
  s.moveTo(Math.cos(a0) * (r1 - bs), Math.sin(a0) * (r1 - bs))
  s.absarc(0, 0, r1 - bs, a0, a1, false)
  s.lineTo(Math.cos(a1) * (r0 + bs), Math.sin(a1) * (r0 + bs))
  s.absarc(0, 0, r0 + bs, a1, a0, true)
  s.closePath()
  const depth = Math.max(0.001, z1 - z0 - bevel * 2)
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bs,
    bevelSegments: 2,
    curveSegments: curve,
    steps: 1,
  })
  g.translate(0, 0, z0 + bevel)
  g.deleteAttribute('uv')
  return g
}

/** One ring segment: stepped profile (body + outer lip + inner lip + back lip). */
function segmentGeometry() {
  const h = Math.PI / GATE.N - GATE.GAP
  const parts = [
    sector(2.56, 3.26, h, -0.26, 0.24, 0.02),
    sector(3.0, 3.3, h - 0.002, 0.2, 0.34, 0.016),
    sector(GATE.R0, 2.68, h - 0.002, 0.18, 0.38, 0.016),
    sector(3.04, 3.28, h - 0.004, -0.36, -0.2, 0.016),
    sector(2.54, 2.64, h - 0.004, -0.34, -0.2, 0.014),
  ]
  const g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return g
}

/** Annulus (full ring) with teeth on the inner edge: the dial. */
function dialGeometry() {
  const outer = new THREE.Shape()
  outer.absarc(0, 0, 2.44, 0, Math.PI * 2, false)
  const hole = new THREE.Path()
  hole.absarc(0, 0, 2.27, 0, Math.PI * 2, true)
  outer.holes.push(hole)
  const band = new THREE.ExtrudeGeometry(outer, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 160,
  })
  band.translate(0, 0, -0.074)
  band.deleteAttribute('uv')
  const parts: THREE.BufferGeometry[] = [band]
  const TEETH = 90
  for (let i = 0; i < TEETH; i++) {
    const long = i % 6 === 0
    const mid = i % 2 === 0
    const len = long ? 0.17 : mid ? 0.09 : 0.05
    const box = new THREE.BoxGeometry(long ? 0.045 : 0.026, len, long ? 0.1 : 0.07).toNonIndexed()
    box.deleteAttribute('uv')
    box.translate(0, 2.28 - len / 2, 0)
    box.rotateZ((i / TEETH) * Math.PI * 2)
    parts.push(box)
  }
  const g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return g
}

/** The Hark center diamond, extruded, normalized to 1 unit wide. */
function diamondGeometry() {
  const shapes = logoParts().diamond
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.02,
    bevelSegments: 3,
    curveSegments: 4,
  })
  g.computeBoundingBox()
  const b = g.boundingBox!
  const c = b.getCenter(new THREE.Vector3())
  g.translate(-c.x, -c.y, -c.z)
  const w = Math.max(b.max.x - b.min.x, b.max.y - b.min.y)
  g.scale(1 / w, 1 / w, 1 / w)
  g.deleteAttribute('uv')
  g.computeVertexNormals()
  return g
}

/* ------------------------------------------------------------------ */
/* metal material                                                       */
/* ------------------------------------------------------------------ */

const METAL_VERT = /* glsl */ `
  #ifdef HAS_INST
  attribute vec4 aInst;
  #endif
  varying vec3 vObj;
  varying vec3 vObjN;
  varying vec3 vW;
  varying vec3 vN;
  varying vec4 vInst;
  void main() {
    vObj = position;
    vObjN = normal;
    #ifdef HAS_INST
    vInst = aInst;
    #else
    vInst = vec4(0.0, 1.0, 0.0, 0.0);
    #endif
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
    #endif
    vec4 w = m * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(m) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

function metalFrag(emissive: string) {
  return /* glsl */ `
  uniform float uTime;
  uniform vec3 uCorePos;
  uniform float uCorePower;
  uniform vec3 uKeyDir;
  uniform float uGlow;
  uniform float uRim;
  uniform float uHalf;
  uniform float uFlashAll;
  varying vec3 vObj;
  varying vec3 vObjN;
  varying vec3 vW;
  varying vec3 vN;
  varying vec4 vInst;
  ${HASH}
  ${emissive}
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    float nv = max(dot(N, V), 0.0);
    float r = length(vObj.xy);
    float a = atan(vObj.y, vObj.x);
    float micro = hash12(floor(vec2(r * 220.0, a * 30.0)));
    float streak = hash12(floor(vec2(r * 900.0, 1.0)));
    vec3 albedo = vec3(0.052, 0.058, 0.066) * (0.82 + 0.22 * micro + 0.12 * streak);

    vec3 L = normalize(uKeyDir);
    float nl = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    vec3 col = albedo * (0.05 + nl * 1.0);
    col += vec3(0.72, 0.82, 0.95) * (pow(nh, 80.0) * 0.9 + pow(nh, 14.0) * 0.05) * (0.25 + nl) * (0.7 + 0.6 * streak);
    vec3 L2 = normalize(vec3(0.7, -0.45, 0.35));
    col += albedo * max(dot(N, L2), 0.0) * 0.22;

    vec3 toC = uCorePos - vW;
    float dc = length(toC);
    vec3 Lc = toC / max(dc, 1e-3);
    float att = uCorePower / (1.0 + 0.1 * dc * dc);
    float ncl = max(dot(N, Lc), 0.0);
    vec3 Hc = normalize(Lc + V);
    col += albedo * ncl * att * vec3(0.35, 1.0, 0.55) * 2.4;
    col += vec3(0.45, 1.0, 0.65) * pow(max(dot(N, Hc), 0.0), 60.0) * ncl * att * 0.7;

    // fake environment: dark studio gradient + a green glow from the core direction
    vec3 R = reflect(-V, N);
    float env = smoothstep(-0.2, 0.9, R.y) * 0.035 + pow(max(dot(R, L), 0.0), 6.0) * 0.05;
    col += vec3(0.6, 0.7, 0.8) * env * (0.6 + 0.4 * streak);
    col += vec3(0.2, 1.0, 0.5) * pow(max(dot(R, Lc), 0.0), 8.0) * att * 0.12;
    float fr = pow(1.0 - nv, 5.0);
    col += vec3(0.2, 0.9, 0.5) * fr * uRim;

    col += vec3(0.12, 1.0, 0.36) * emissive(vObj, vObjN, vInst) * uGlow;
    gl_FragColor = vec4(col, 1.0);
  }
`
}

const SEGMENT_EMISSIVE = /* glsl */ `
  float emissive(vec3 o, vec3 on, vec4 inst) {
    float r = length(o.xy);
    float ang = atan(o.y, o.x);
    float edge = (uHalf - abs(ang)) * r;
    float lock = inst.y;
    float flash = inst.z;
    float lamp = inst.w;
    float front = smoothstep(0.6, 0.9, on.z);
    float seam = (1.0 - smoothstep(0.006, 0.018, edge)) * front;
    vec2 rad = o.xy / max(r, 1e-4);
    float tang = abs(dot(on.xy, vec2(-rad.y, rad.x)));
    float cap = smoothstep(0.75, 0.95, tang);
    float groove = (1.0 - smoothstep(0.004, 0.011, abs(r - 2.84))) * front * step(o.z, 0.26);
    float groove2 = (1.0 - smoothstep(0.003, 0.008, abs(r - 2.6))) * front * step(0.3, o.z);
    float lampR = step(0.3, o.z) * front
      * (1.0 - smoothstep(0.08, 0.095, abs(ang) * r))
      * (1.0 - smoothstep(0.05, 0.065, abs(r - 3.15)));
    float e = (seam * 0.38 + cap * 0.45 + groove * 0.95 + groove2 * 0.5) * lock * (1.0 + flash * 4.0);
    e += front * flash * 0.1;
    e += lampR * lamp * (0.08 + lock * (1.3 + flash * 4.0) + uFlashAll * 1.2);
    return e;
  }
`

const DIAL_EMISSIVE = /* glsl */ `
  float emissive(vec3 o, vec3 on, vec4 inst) {
    float r = length(o.xy);
    float tip = 1.0 - smoothstep(2.12, 2.14, r);
    float front = smoothstep(0.6, 0.9, on.z);
    float band = (1.0 - smoothstep(0.004, 0.011, abs(r - 2.36))) * front;
    return tip * 1.1 + band * 0.55;
  }
`

const DIAMOND_EMISSIVE = /* glsl */ `
  float emissive(vec3 o, vec3 on, vec4 inst) {
    float side = 1.0 - smoothstep(0.8, 0.97, abs(on.z));
    float face = smoothstep(0.95, 1.0, on.z);
    return (side * 1.5 + face * 0.3) * (0.12 + inst.y * (1.0 + inst.z * 3.0));
  }
`

function metalMaterial(shared: Shared, emissive: string, opts: { instanced?: boolean; half?: number } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uGlow: { value: 1 },
      uRim: { value: 0.12 },
      uHalf: { value: opts.half ?? 0 },
      uFlashAll: { value: 0 },
    },
    defines: opts.instanced ? { HAS_INST: '' } : {},
    vertexShader: METAL_VERT,
    fragmentShader: metalFrag(emissive),
  })
}

/* ------------------------------------------------------------------ */
/* ring                                                                */
/* ------------------------------------------------------------------ */

export function createRing(shared: Shared) {
  const N = GATE.N
  const geo = segmentGeometry()
  const inst = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4)
  inst.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aInst', inst)
  const mat = metalMaterial(shared, SEGMENT_EMISSIVE, { instanced: true, half: Math.PI / N - GATE.GAP })
  const mesh = new THREE.InstancedMesh(geo, mat, N)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false

  // Hark diamonds as keystones at N / E / S / W
  const dGeo = diamondGeometry()
  const dInst = new THREE.InstancedBufferAttribute(new Float32Array(4 * 4), 4)
  dInst.setUsage(THREE.DynamicDrawUsage)
  dGeo.setAttribute('aInst', dInst)
  const dMat = metalMaterial(shared, DIAMOND_EMISSIVE, { instanced: true })
  const diamonds = new THREE.InstancedMesh(dGeo, dMat, 4)
  diamonds.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  diamonds.frustumCulled = false

  // light leaking through the gaps: an annulus behind the segments, masked per segment
  const leakMat = new THREE.ShaderMaterial({
    uniforms: { uLocks: { value: new Float32Array(N) }, uGlow: { value: 1 }, uTime: shared.uTime },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      #define N ${N}
      uniform float uLocks[N];
      uniform float uGlow;
      varying vec2 vP;
      void main() {
        float a = atan(vP.y, vP.x);
        float f = a / 6.2831853 * float(N);
        if (f < 0.0) f += float(N);
        // the gap between segment k and k+1 lies at k + 0.5
        float fi = floor(f);
        int ga = int(mod(fi, float(N)));
        int gb = int(mod(fi + 1.0, float(N)));
        float gapPos = abs(fract(f) - 0.5);
        float lk = min(uLocks[ga], uLocks[gb]);
        float r = length(vP);
        float radial = smoothstep(2.56, 2.72, r) * (1.0 - smoothstep(3.1, 3.26, r));
        float g = exp(-gapPos * 40.0) * lk * radial;
        gl_FragColor = vec4(vec3(0.15, 1.0, 0.42) * g * 1.3 * uGlow, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const leak = new THREE.Mesh(new THREE.RingGeometry(2.56, 3.26, 360, 1), leakMat)
  leak.position.z = -0.12

  return { mesh, inst, mat, diamonds, dInst, dMat, leak, leakMat }
}

export function createDial(shared: Shared) {
  const mat = metalMaterial(shared, DIAL_EMISSIVE)
  mat.uniforms.uRim.value = 0.08
  const mesh = new THREE.Mesh(dialGeometry(), mat)
  return { mesh, mat }
}

/** Flat graduated ring (HUD-like ticks), additive. */
export function createTicks(r0: number, r1: number, count = 180, major = 36) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uGlow: { value: 1 }, uR0: { value: r0 }, uR1: { value: r1 } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uGlow, uR0, uR1;
      varying vec2 vP;
      float band(float x, float w) { float d = fwidth(x); return 1.0 - smoothstep(w - d, w + d, x); }
      void main() {
        float a = atan(vP.y, vP.x) / 6.2831853 + 0.5;
        float r = (length(vP) - uR0) / (uR1 - uR0);
        float fm = abs(fract(a * ${count.toFixed(1)}) - 0.5);
        float fM = abs(fract(a * ${major.toFixed(1)}) - 0.5);
        float minor = (1.0 - band(fm, 0.44)) * step(r, 0.42);
        float maj = (1.0 - band(fM, 0.488)) * step(r, 0.8);
        float line = 1.0 - smoothstep(0.0, 0.07 + fwidth(r), abs(r - 0.93));
        float gap = step(0.02, abs(fract(a * 4.0 + 0.125) - 0.5));
        float v = max(max(minor * 0.55, maj), line * 0.9 * gap);
        gl_FragColor = vec4(vec3(0.2, 1.0, 0.5) * v * uGlow, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 256, 1), mat)
  return { mesh, mat }
}

/* ------------------------------------------------------------------ */
/* core                                                                */
/* ------------------------------------------------------------------ */

export function createCore(shared: Shared, mobile: boolean) {
  const oct = mobile ? 3 : 5
  const group = new THREE.Group()

  const sphereMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uIntensity: { value: 1 }, uHeat: { value: 0 } },
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
      uniform float uTime, uIntensity, uHeat;
      varying vec3 vN; varying vec3 vW; varying vec3 vP;
      ${NOISE}
      ${FBM}
      void main() {
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float nv = clamp(dot(N, V), 0.0, 1.0);
        vec3 p = normalize(vP);
        float t = uTime;
        float n1 = fbm(p * 1.8 + vec3(0.0, t * 0.22, t * 0.08), ${oct});
        float n2 = fbm(p * 4.2 + vec3(n1 * 1.6) - vec3(t * 0.35, 0.0, t * 0.18), ${oct});
        float veins = pow(1.0 - abs(n2), 7.0);
        float body = 0.5 + 0.5 * n1;
        vec3 deep = vec3(0.0, 0.16, 0.06);
        vec3 mid = vec3(0.08, 1.0, 0.4);
        vec3 hot = vec3(0.8, 1.0, 0.9);
        vec3 col = mix(deep, mid, smoothstep(0.3, 1.0, body)) * 0.55;
        col += mix(mid, hot, 0.55) * veins * (1.3 + uHeat * 0.8);
        float rim = pow(1.0 - nv, 2.4);
        col += mix(mid, hot, 0.3) * rim * 1.3;
        col += hot * pow(nv, 8.0) * 0.25 * (0.6 + uHeat);
        gl_FragColor = vec4(col * uIntensity, 1.0);
      }
    `,
  })
  const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1, mobile ? 12 : 24), sphereMat)
  group.add(sphere)

  // corona billboard
  const coronaMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uSize: { value: 2.5 }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      uniform float uSize;
      varying vec2 vUv;
      void main() {
        vUv = position.xy;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uIntensity;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        float r = length(vUv);
        float a = atan(vUv.y, vUv.x);
        float rays = snoise(vec3(cos(a) * 2.5, sin(a) * 2.5, uTime * 0.25)) * 0.5 + 0.5;
        rays = pow(rays, 2.0);
        float g = exp(-r * 11.0) * 1.1 + pow(max(1.0 - r, 0.0), 5.0) * (0.06 + rays * 0.32);
        g *= smoothstep(1.0, 0.75, r);
        gl_FragColor = vec4(vec3(0.3, 1.0, 0.55) * g * uIntensity, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), coronaMat)
  corona.frustumCulled = false
  corona.renderOrder = 2
  group.add(corona)

  // anamorphic streak
  const flareMat = new THREE.ShaderMaterial({
    uniforms: { uW: { value: 9 }, uH: { value: 0.35 }, uIntensity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uW, uH;
      varying vec2 vUv;
      void main() {
        vUv = position.xy;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * vec2(uW, uH);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float x = abs(vUv.x);
        float y = vUv.y;
        float g = exp(-y * y * 60.0) * pow(1.0 - x, 3.0) + exp(-y * y * 400.0) * pow(1.0 - x, 8.0) * 2.0;
        gl_FragColor = vec4(vec3(0.55, 1.0, 0.75) * g * uIntensity, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  })
  const flare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), flareMat)
  flare.frustumCulled = false
  flare.renderOrder = 5
  group.add(flare)

  // crackling arcs around the core
  const ARCS = mobile ? 14 : 26
  const PTS = 14
  const aArc: number[] = []
  const aT: number[] = []
  for (let i = 0; i < ARCS; i++) {
    for (let j = 0; j < PTS - 1; j++) {
      aArc.push(i, i)
      aT.push(j / (PTS - 1), (j + 1) / (PTS - 1))
    }
  }
  const arcGeo = new THREE.BufferGeometry()
  arcGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aArc.length * 3), 3))
  arcGeo.setAttribute('aArc', new THREE.Float32BufferAttribute(aArc, 1))
  arcGeo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1))
  const arcMat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uR: { value: 1 }, uIntensity: { value: 1 }, uReach: { value: 0.6 } },
    vertexShader: /* glsl */ `
      attribute float aArc;
      attribute float aT;
      uniform float uTime, uR, uReach;
      varying float vA;
      ${HASH}
      void main() {
        float rate = 5.0 + hash12(vec2(aArc, 3.1)) * 9.0;
        float cyc = floor(uTime * rate + hash12(vec2(aArc, 7.7)) * 10.0);
        vec3 s0 = hash33(vec3(aArc, cyc, 1.0)) * 2.0 - 1.0;
        vec3 s1 = hash33(vec3(aArc, cyc, 5.0)) * 2.0 - 1.0;
        vec3 d0 = normalize(s0 + 1e-3);
        vec3 d1 = normalize(d0 + s1 * 0.95);
        vec3 dir = normalize(mix(d0, d1, aT));
        float bulge = sin(aT * 3.14159);
        float reach = uReach * (0.3 + hash12(vec2(aArc, cyc)) * 0.9);
        vec3 j = (hash33(vec3(aArc * 13.0, floor(aT * 13.0 + 0.5), cyc)) - 0.5) * 0.35 * bulge;
        vec3 pos = dir * uR * (1.0 + bulge * reach) + j * uR;
        float life = hash12(vec2(aArc, cyc + 0.5));
        vA = step(0.35, life) * (0.6 + 0.4 * sin(uTime * 40.0 + aArc)) * (0.35 + 0.65 * bulge);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.7, 1.0, 0.82) * vA * uIntensity * 1.7, 1.0); }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const arcs = new THREE.LineSegments(arcGeo, arcMat)
  arcs.frustumCulled = false
  group.add(arcs)

  return { group, sphere, sphereMat, corona, coronaMat, flare, flareMat, arcs, arcMat }
}

/** Arcs that jump from the core to each segment as it locks. */
export function createLockArcs(shared: Shared) {
  const N = GATE.N
  const PTS = 18
  const aArc: number[] = []
  const aT: number[] = []
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < PTS - 1; j++) {
      aArc.push(i, i)
      aT.push(j / (PTS - 1), (j + 1) / (PTS - 1))
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aArc.length * 3), 3))
  geo.setAttribute('aArc', new THREE.Float32BufferAttribute(aArc, 1))
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uFlash: { value: new Float32Array(N) },
      uR0: { value: 0.6 },
      uR1: { value: GATE.R0 },
    },
    vertexShader: /* glsl */ `
      #define N ${N}
      attribute float aArc;
      attribute float aT;
      uniform float uTime, uR0, uR1;
      uniform float uFlash[N];
      varying float vA;
      ${HASH}
      void main() {
        int i = int(aArc + 0.5);
        float f = uFlash[i];
        float th = aArc / float(N) * 6.2831853;
        vec2 dir = vec2(cos(th), sin(th));
        vec2 perp = vec2(-dir.y, dir.x);
        float cyc = floor(uTime * 22.0);
        float k = floor(aT * 17.0 + 0.5);
        float j = (hash12(vec2(aArc * 7.0 + k, cyc)) - 0.5) * 0.34 * sin(aT * 3.14159);
        float z = (hash12(vec2(aArc * 3.0 + k, cyc + 9.0)) - 0.5) * 0.2 * sin(aT * 3.14159);
        vec2 p = dir * mix(uR0, uR1, aT) + perp * j;
        vA = f * (0.4 + 0.6 * step(0.3, hash12(vec2(aArc, cyc))));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, z, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.7, 1.0, 0.82) * vA * 2.0, 1.0); }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false
  return { lines, mat }
}

/* ------------------------------------------------------------------ */
/* event horizon                                                        */
/* ------------------------------------------------------------------ */

export function createHorizon(shared: Shared, mobile: boolean) {
  const oct = mobile ? 3 : 4
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uOpen: { value: 0 },
      uStable: { value: 0 },
      uIntensity: { value: 1 },
      uRush: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpen, uStable, uIntensity, uRush;
      varying vec2 vP;
      ${NOISE}
      ${FBM}
      void main() {
        vec2 p = vP;
        float r = length(p);
        float a = atan(p.y, p.x);
        float t = uTime;
        // slow vortex: rotate faster toward the throat
        float sw = a + (1.0 - r) * 2.2 + t * 0.1 + uRush * 3.0;
        vec2 q = vec2(cos(sw), sin(sw)) * r;
        float n = fbm(vec3(q * 1.6, t * 0.16), ${oct});
        float rr = r + n * 0.05;
        float front = uOpen * 1.08;
        float alpha = 1.0 - smoothstep(front - 0.05, front, rr);
        if (alpha <= 0.001) discard;
        float c = fbm(vec3(q * 2.4 + n * 0.8, t * 0.22), ${oct});
        float fil = pow(1.0 - abs(c), 11.0);
        float c2 = fbm(vec3(q * 5.5 - n, t * 0.35 + 4.0), 2);
        float fil2 = pow(1.0 - abs(c2), 16.0);
        float rip = sin(rr * 30.0 - t * 2.6 - uRush * 40.0 + n * 4.0);
        float ripple = pow(0.5 + 0.5 * rip, 12.0);
        float body = smoothstep(0.04, 0.95, r);
        vec3 col = vec3(0.0, 0.012, 0.009);
        col += vec3(0.0, 0.06, 0.032) * body * (0.6 + 0.6 * n);
        col += vec3(0.1, 1.0, 0.42) * fil * (0.06 + 0.42 * body) * (0.6 + 0.4 * smoothstep(0.3, 0.9, r));
        col += vec3(0.5, 1.0, 0.75) * fil2 * 0.2 * body;
        col += vec3(0.2, 1.0, 0.55) * ripple * 0.12 * body;
        col *= mix(0.35, 1.0, smoothstep(0.08, 0.5, r));
        // rim meets the dial
        col += vec3(0.3, 1.0, 0.6) * smoothstep(0.86, 1.0, r) * 0.42;
        // a pinpoint at the bottom of the throat; it swells as we dive in
        col += vec3(0.8, 1.0, 0.9) * (exp(-r * 26.0) * 0.9 + exp(-r * 3.5) * uRush * 0.7);
        // bright expanding wavefront while it opens
        float wf = exp(-abs(rr - front) * 30.0) * (1.0 - uStable);
        col += vec3(0.75, 1.0, 0.88) * wf * 1.5;
        col *= uIntensity;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 128), mat)
  mesh.renderOrder = 1
  return { mesh, mat }
}

/* ------------------------------------------------------------------ */
/* streak fields                                                        */
/* ------------------------------------------------------------------ */

/** Energy lines collapsing inward into the core at the start. */
export function createCollapse(count: number, seed: () => number) {
  const s = new Float32Array(count * 2 * 4)
  const end = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const ang = seed() * Math.PI * 2
    const r0 = 1.5 + Math.pow(seed(), 0.7) * 16
    const len = 0.6 + seed() * 4.5
    const z = (seed() - 0.5) * 6
    for (let k = 0; k < 2; k++) {
      s.set([ang, r0, len, z], (i * 2 + k) * 4)
      end[i * 2 + k] = k
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 2 * 3), 3))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(s, 4))
  geo.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uC: { value: 0 }, uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute float aEnd;
      uniform float uC;
      varying float vA;
      void main() {
        float sp = 0.75 + fract(aSeed.x * 7.13) * 0.6;
        float c = clamp(uC * sp, 0.0, 1.0);
        float head = aSeed.y * pow(1.0 - c, 2.2);
        float len = aSeed.z * (0.4 + 1.6 * c) * (1.0 - c);
        float r = head + len * aEnd;
        vec3 pos = vec3(cos(aSeed.x) * r, sin(aSeed.x) * r, aSeed.w * (1.0 - c));
        vA = (1.0 - aEnd) * (1.0 - smoothstep(0.82, 1.0, c)) * (0.4 + 0.6 * c);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.55, 1.0, 0.72) * vA * uIntensity * 1.5, 1.0); }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false
  return { lines, mat }
}

/** Streaks rushing past the camera during the jump. */
export function createRush(count: number, seed: () => number) {
  const s = new Float32Array(count * 2 * 4)
  const end = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const ang = seed() * Math.PI * 2
    const r = 3.8 + Math.pow(seed(), 0.6) * 10
    const z0 = seed()
    const len = 2 + seed() * 7
    for (let k = 0; k < 2; k++) {
      s.set([ang, r, z0, len], (i * 2 + k) * 4)
      end[i * 2 + k] = k
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 2 * 3), 3))
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(s, 4))
  geo.setAttribute('aEnd', new THREE.Float32BufferAttribute(end, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTravel: { value: 0 }, uIntensity: { value: 0 }, uCamZ: { value: 10 } },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      attribute float aEnd;
      uniform float uTravel, uCamZ;
      varying float vA;
      void main() {
        float span = 90.0;
        float z = uCamZ + 6.0 - fract(aSeed.z + uTravel * (0.6 + fract(aSeed.x * 3.7) * 0.8)) * span;
        z -= aSeed.w * aEnd * (1.0 + uTravel * 0.0);
        vec3 pos = vec3(cos(aSeed.x) * aSeed.y, sin(aSeed.x) * aSeed.y, z);
        float nearFade = smoothstep(uCamZ + 6.0, uCamZ - 4.0, z);
        float farFade = 1.0 - smoothstep(uCamZ - 50.0, uCamZ - 80.0, z);
        vA = (1.0 - aEnd * 0.9) * nearFade * farFade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.6, 1.0, 0.78) * vA * uIntensity * 1.8, 1.0); }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false
  return { lines, mat }
}
