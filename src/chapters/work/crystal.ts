import * as THREE from 'three'
import { ConvexHull, type HalfEdge } from 'three/addons/math/ConvexHull.js'
import { rng } from '../../core/math'
import { BRAND_GLSL, HASH, NOISE, ROTATE } from '../../core/glsl'

/*
 * Artifacts — crystal geometry + materials.
 *
 * Every crystal is a procedural convex hull with per-vertex barycentrics and
 * a per-triangle "real edge" mask, so the shaders can draw crisp facet edges
 * (skipping the diagonals inside coplanar faces) in the same draw call.
 *
 * The featured crystals fake refraction analytically: each fragment refracts
 * the view ray through its facet normal (per colour channel for dispersion)
 * and intersects it with the screenshot panel sealed at z = 0 in object
 * space. The flat "table" facet in front of the panel keeps the site
 * legible; the angled facets around it scatter displaced, mirrored copies.
 */

const TAU = Math.PI * 2
const V3 = THREE.Vector3

// ---------------------------------------------------------------- geometry

export interface Hull {
  geometry: THREE.BufferGeometry
  /** facet count after merging coplanar triangles */
  facets: number
  /** unique hull vertices (object space) */
  points: THREE.Vector3[]
}

export function buildHull(points: THREE.Vector3[]): Hull {
  const hull = new ConvexHull().setFromPoints(points)
  const pos: number[] = []
  const nor: number[] = []
  const bary: number[] = []
  const edge: number[] = []
  const uniq = new Map<string, THREE.Vector3>()
  let hidden = 0
  const real = (e: HalfEdge) => (e.twin && e.face.normal.dot(e.twin.face.normal) > 0.9995 ? 0 : 1)
  const B = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]
  for (const f of hull.faces) {
    const e0 = f.edge
    const e1 = e0.next
    const e2 = e1.next
    const vs = [e0.head().point, e1.head().point, e2.head().point]
    // edge opposite vertex k: v0 ↔ e2 (v1→v2), v1 ↔ e0 (v2→v0), v2 ↔ e1 (v0→v1)
    const m = [real(e2), real(e0), real(e1)]
    hidden += 3 - m[0] - m[1] - m[2]
    for (let k = 0; k < 3; k++) {
      const v = vs[k]
      pos.push(v.x, v.y, v.z)
      nor.push(f.normal.x, f.normal.y, f.normal.z)
      bary.push(B[k][0], B[k][1], B[k][2])
      edge.push(m[0], m[1], m[2])
      uniq.set(`${v.x.toFixed(4)}|${v.y.toFixed(4)}|${v.z.toFixed(4)}`, v)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('aBary', new THREE.Float32BufferAttribute(bary, 3))
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 3))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return {
    geometry: g,
    facets: Math.round(hull.faces.length - hidden / 2),
    points: [...uniq.values()].map(v => v.clone()),
  }
}

/**
 * A gem-cut shard enclosing a panel of half-size (hx, hy) at z = 0: flat
 * octagonal tables front and back, a wider jittered girdle with two long
 * tips, crown/pavilion facets between, and a spike top and bottom.
 */
export function crystalPoints(seed: number, hx: number, hy: number, depth: number): THREE.Vector3[] {
  const r = rng(seed)
  const pts: THREE.Vector3[] = []
  const A = hx + 0.13
  const B = hy + 0.13
  for (const z of [depth, -depth]) {
    const c = 0.2 + r() * 0.08
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]) {
      pts.push(new V3(sx * (A + r() * 0.06), sy * (B - c + r() * 0.05), z))
      pts.push(new V3(sx * (A - c + r() * 0.05), sy * (B + r() * 0.06), z))
    }
  }
  // girdle
  const GA = A + 0.32 + r() * 0.22
  const GB = B + 0.2 + r() * 0.16
  const n = 22
  for (let i = 0; i < n; i++) {
    const a = ((i + r() * 0.7) / n) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const k = 2.4
    const s = 0.94 + r() * 0.12
    pts.push(
      new V3(
        Math.sign(ca) * Math.pow(Math.abs(ca), 2 / k) * GA * s,
        Math.sign(sa) * Math.pow(Math.abs(sa), 2 / k) * GB * s,
        (r() - 0.5) * depth * 0.55,
      ),
    )
  }
  // long tips
  const tipY = (r() - 0.5) * GB * 0.9
  pts.push(new V3(GA + 0.55 + r() * 0.55, tipY, (r() - 0.5) * 0.15))
  pts.push(new V3(-(GA + 0.45 + r() * 0.6), -tipY * 0.6 + (r() - 0.5) * 0.3, (r() - 0.5) * 0.15))
  // spikes
  pts.push(new V3((r() - 0.3) * GA * 0.9, GB + 0.3 + r() * 0.35, (r() - 0.5) * 0.2))
  pts.push(new V3((r() - 0.7) * GA * 0.8, -(GB + 0.18 + r() * 0.3), (r() - 0.5) * 0.2))
  // secondary tips so the silhouette reads as a fractured shard, not a gem
  pts.push(new V3(GA + 0.2 + r() * 0.3, tipY + GB * (0.35 + r() * 0.25), (r() - 0.5) * 0.3))
  pts.push(new V3(-(GA + 0.15 + r() * 0.35), -GB * (0.3 + r() * 0.35), (r() - 0.5) * 0.3))
  // crown + pavilion
  for (let i = 0; i < 30; i++) {
    const a = r() * TAU
    const t = 0.35 + r() * 0.45
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const x = Math.sign(ca) * Math.pow(Math.abs(ca), 0.7) * (A + (GA - A) * t)
    const y = Math.sign(sa) * Math.pow(Math.abs(sa), 0.7) * (B + (GB - B) * t)
    const z = (i % 2 ? 1 : -1) * depth * (0.95 - t * 0.55 + (r() - 0.5) * 0.1)
    pts.push(new V3(x, y, z))
  }
  // a gentle shear so no two crystals share a silhouette
  const sh = (r() - 0.5) * 0.18
  for (const p of pts) p.x += p.y * sh
  return pts
}

/** Small elongated shard for the drifting debris field. */
export function shardPoints(seed: number): THREE.Vector3[] {
  const r = rng(seed)
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < 16; i++) {
    const v = new V3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
    pts.push(new V3(v.x * 0.5, v.y * 0.78, v.z * 0.4))
  }
  pts.push(new V3(0.08, 1.05, 0.02), new V3(-0.1, -0.9, 0.05))
  return pts
}

// ---------------------------------------------------------------- shared GLSL

/** Procedural studio environment for facet glints (world-space direction). */
const ENV = /* glsl */ `
vec3 envMap(vec3 d) {
  vec3 c = vec3(0.0012, 0.0026, 0.0038);
  float k1 = max(dot(d, normalize(vec3(-0.55, 0.62, 0.55))), 0.0);
  c += vec3(1.0, 0.97, 0.93) * (pow(k1, 70.0) * 7.0 + pow(k1, 9.0) * 0.16);
  float k2 = max(dot(d, normalize(vec3(0.82, -0.08, -0.56))), 0.0);
  c += SIGNAL * (pow(k2, 18.0) * 2.6 + pow(k2, 4.0) * 0.08);
  float k3 = max(dot(d, normalize(vec3(0.3, 0.94, -0.18))), 0.0);
  c += vec3(0.6, 0.82, 1.0) * pow(k3, 28.0) * 1.6;
  float k4 = max(dot(d, normalize(vec3(-0.2, -0.5, 0.84))), 0.0);
  c += vec3(0.5, 0.9, 0.8) * pow(k4, 30.0) * 0.8;
  c += vec3(0.03, 0.1, 0.09) * exp(-abs(d.y + 0.05) * 9.0) * 0.5;
  return c;
}
`

/** Pixel distance to the nearest real facet edge. */
const EDGES = /* glsl */ `
float edgeDist(vec3 bary, vec3 mask) {
  vec3 w = fwidth(bary);
  vec3 px = bary / max(w, vec3(1e-5));
  px = mix(vec3(1e4), px, step(0.5, mask));
  return min(px.x, min(px.y, px.z));
}
`

const HULL_VERT = /* glsl */ `
attribute vec3 aBary;
attribute vec3 aEdge;
varying vec3 vObjPos;
varying vec3 vObjN;
varying vec3 vBary;
varying vec3 vEdge;
void main() {
  vObjPos = position;
  vObjN = normal;
  vBary = aBary;
  vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// ---------------------------------------------------------------- featured crystal

export interface CrystalUniforms {
  [k: string]: THREE.IUniform
  uMap: THREE.IUniform<THREE.Texture>
  /** 0 = no screenshot yet (dark glass, powered but no signal), 1 = the site shows */
  uReady: THREE.IUniform<number>
  uPanel: THREE.IUniform<THREE.Vector2>
  uCamObj: THREE.IUniform<THREE.Vector3>
  uRot: THREE.IUniform<THREE.Matrix3>
  uActive: THREE.IUniform<number>
  uTime: THREE.IUniform<number>
  uFade: THREE.IUniform<number>
  uGlow: THREE.IUniform<number>
  uEdge: THREE.IUniform<number>
  uSeed: THREE.IUniform<number>
}

const CRYSTAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uReady;
uniform vec2 uPanel;
uniform vec3 uCamObj;
uniform mat3 uRot;
uniform float uActive;
uniform float uTime;
uniform float uFade;
uniform float uGlow;
uniform float uEdge;
uniform float uSeed;
varying vec3 vObjPos;
varying vec3 vObjN;
varying vec3 vBary;
varying vec3 vEdge;

${BRAND_GLSL}
#ifdef HQ
${NOISE}
#endif
${ENV}
${EDGES}

vec3 panelShade(vec2 uv, vec2 dx, vec2 dy, float back) {
  // a gentle negative LOD bias (the anisotropic filter keeps it clean) so the
  // sealed site reads crisp instead of one mip too soft
  vec3 tex = textureGrad(uMap, uv, dx * 0.7, dy * 0.7).rgb * uReady;
  // until the screenshot streams in: a faint carrier grid on dark glass
  vec2 gq = abs(fract(uv * vec2(16.0, 10.0)) - 0.5);
  float grid = smoothstep(0.47, 0.5, max(gq.x, gq.y));
  tex += SIGNAL * grid * 0.05 * (1.0 - uReady);
  float lum = dot(tex, vec3(0.2126, 0.7152, 0.0722));
  vec3 dormant = vec3(lum) * vec3(0.5, 1.0, 0.8) * 0.12 + SIGNAL * 0.004;
  // soft shoulder: white page areas sit under the bloom threshold, so the
  // screenshot glows like a display instead of blowing out
  vec3 live = tex * mix(0.62, 0.46, smoothstep(0.5, 1.0, lum));
  float y = 1.0 - uv.y;
  float sweep = mix(-0.1, 1.1, uActive);
  float on = 1.0 - smoothstep(sweep - 0.05, sweep, y);
  vec3 c = mix(dormant, live, on);
  float band = exp(-abs(y - sweep) * 70.0) * (1.0 - abs(uActive * 2.0 - 1.0));
  c += SIGNAL * band * 1.6;
  c *= 0.97 + 0.03 * sin(uv.y * 620.0 - uTime * 3.0);
  vec2 e = min(uv, 1.0 - uv) * uPanel * 2.0;
  float d = min(e.x, e.y);
  c += mix(vec3(0.75, 1.0, 0.9), SIGNAL, 0.5) * exp(-d * 120.0) * (0.3 + 0.75 * uActive);
  c = mix(c, c * vec3(0.25, 0.5, 0.45), back);
  return c * uGlow;
}

vec3 transmit(vec3 V, vec3 N, float eta, out float hit) {
  vec3 R = refract(V, N, eta);
  float rz = R.z;
  float t = -vObjPos.z / (abs(rz) < 1e-4 ? -1e-4 : rz);
  vec3 H = vObjPos + R * max(t, 0.0);
  vec2 uv = H.xy / (2.0 * uPanel) + 0.5;
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  float ed = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  hit = clamp(ed / max(fwidth(ed), 1e-4) + 0.5, 0.0, 1.0) * step(0.0, t);
  vec3 p = panelShade(clamp(uv, 0.0, 1.0), dx, dy, step(0.0, rz));
  // internal reflections: mirrored ghosts of the panel beyond its edges
  vec2 m = 1.0 - abs(mod(uv, 2.0) - 1.0);
  vec3 gt = textureGrad(uMap, m, dx * 2.0, dy * 2.0).rgb * uReady;
  float gl = dot(gt, vec3(0.2126, 0.7152, 0.0722));
  float od = length(max(abs(uv - 0.5) - 0.5, 0.0));
  vec3 ghost = mix(vec3(gl) * vec3(0.5, 1.0, 0.85), gt, 0.4) * 0.2 * exp(-od * 1.8) * (0.3 + 0.7 * uActive) * uGlow;
  vec3 inner = vec3(0.005, 0.014, 0.017) + ghost;
  return mix(inner, p, hit);
}

void main() {
  vec3 N = normalize(vObjN);
  vec3 V = normalize(vObjPos - uCamObj);
  float cosT = clamp(dot(-V, N), 0.0, 1.0);
  float F = 0.035 + 0.965 * pow(1.0 - cosT, 5.0);
  float table = smoothstep(0.97, 0.995, abs(N.z));

#ifdef HQ
  float fr = snoise(vObjPos * 1.7 + uSeed * 7.0) * 0.35 + snoise(vObjPos * 6.5 - uSeed) * 0.16 + 0.5;
#else
  float fr = 0.5 + 0.3 * sin(dot(vObjPos, vec3(3.1, 4.7, 2.3)) + uSeed * 5.0);
#endif
  float frost = smoothstep(0.45, 0.92, fr) * (1.0 - table * 0.9);

  float hit;
  vec3 trans;
#ifdef HQ
  float h0;
  float h2;
  trans.r = transmit(V, N, 1.0 / 1.42, h0).r;
  trans.g = transmit(V, N, 1.0 / 1.46, hit).g;
  trans.b = transmit(V, N, 1.0 / 1.51, h2).b;
#else
  trans = transmit(V, N, 1.0 / 1.46, hit);
#endif

#ifdef HQ
  // internal veils sampled along the refracted ray: parallax depth inside the ice
  vec3 Rg = refract(V, N, 1.0 / 1.46);
  float v1 = snoise((vObjPos + Rg * 0.28) * vec3(1.1, 1.6, 1.1) + uSeed * 3.0);
  float v2 = snoise((vObjPos + Rg * 0.7) * 2.3 - uSeed);
  float veil = smoothstep(0.15, 0.95, v1) * 0.65 + smoothstep(0.35, 1.0, v2) * 0.35;
  trans += vec3(0.32, 0.55, 0.56) * veil * 0.08 * (1.0 - hit * 0.8) * (0.5 + 0.5 * uGlow);
#endif

  vec3 Rw = normalize(uRot * reflect(V, N));
  vec3 refl = envMap(Rw);
  vec3 irid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + cosT * 1.4 + fr * 0.6 + uSeed * 0.13));
  refl *= mix(vec3(1.0), 0.35 + irid * 1.3, 0.45);

  vec3 col = trans * (1.0 - F) * (1.0 - frost * 0.6) + refl * F;
  col += vec3(0.5, 0.68, 0.72) * frost * (0.018 + F * 0.16);
  // soft ice body toward the silhouette
  col += vec3(0.1, 0.22, 0.22) * pow(1.0 - cosT, 2.5) * 0.18 * uGlow;

  float dm = edgeDist(vBary, vEdge);
  float line = 1.0 - smoothstep(0.3, 1.25, dm);
  float glow = exp(-dm * 0.3);
  float glint = min(dot(refl, vec3(0.3, 0.6, 0.1)), 2.5);
  vec3 ec = mix(vec3(0.8, 1.0, 0.94), SIGNAL, 0.22);
  col += ec * (line * (0.22 + 0.75 * F + glint * 0.55) + glow * 0.035) * uEdge;

  float alpha = clamp(mix(0.5, 1.0, max(hit, F)) + line * 0.35 + frost * 0.14, 0.0, 1.0);
  gl_FragColor = vec4(col * uFade, alpha * uFade);
}
`

const CRYSTAL_BACK_FRAG = /* glsl */ `
uniform vec3 uCamObj;
uniform mat3 uRot;
uniform float uFade;
uniform float uEdge;
uniform float uGlow;
varying vec3 vObjPos;
varying vec3 vObjN;
varying vec3 vBary;
varying vec3 vEdge;
${BRAND_GLSL}
${ENV}
${EDGES}
void main() {
  vec3 N = normalize(vObjN);
  vec3 V = normalize(vObjPos - uCamObj);
  vec3 Rw = normalize(uRot * reflect(V, -N));
  vec3 col = envMap(Rw) * 0.1 + vec3(0.003, 0.009, 0.011);
  float dm = edgeDist(vBary, vEdge);
  float line = 1.0 - smoothstep(0.3, 1.2, dm);
  col += mix(vec3(0.7, 1.0, 0.9), SIGNAL, 0.4) * (line * 0.26 + exp(-dm * 0.35) * 0.025) * uEdge * (0.6 + 0.4 * uGlow);
  float alpha = clamp(0.24 + line * 0.4, 0.0, 1.0);
  gl_FragColor = vec4(col * uFade, alpha * uFade);
}
`

export interface Crystal {
  group: THREE.Group
  front: THREE.Mesh
  back: THREE.Mesh
  uniforms: CrystalUniforms
  hull: Hull
}

const _inv = new THREE.Matrix4()

export function createCrystal(hull: Hull, map: THREE.Texture, panelHalf: THREE.Vector2, seed: number, hq: boolean): Crystal {
  const uniforms: CrystalUniforms = {
    uMap: { value: map },
    uReady: { value: 0 },
    uPanel: { value: panelHalf.clone() },
    uCamObj: { value: new THREE.Vector3() },
    uRot: { value: new THREE.Matrix3() },
    uActive: { value: 0 },
    uTime: { value: 0 },
    uFade: { value: 1 },
    uGlow: { value: 1 },
    uEdge: { value: 1 },
    uSeed: { value: seed % 17 },
  }
  const defines: Record<string, string> = hq ? { HQ: '' } : {}
  const front = new THREE.Mesh(
    hull.geometry,
    new THREE.ShaderMaterial({
      uniforms,
      defines,
      vertexShader: HULL_VERT,
      fragmentShader: CRYSTAL_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
    }),
  )
  const back = new THREE.Mesh(
    hull.geometry,
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: HULL_VERT,
      fragmentShader: CRYSTAL_BACK_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
    }),
  )
  back.renderOrder = 1
  front.renderOrder = 2
  const sync = (mesh: THREE.Object3D, cam: THREE.Camera) => {
    _inv.copy(mesh.matrixWorld).invert()
    uniforms.uCamObj.value.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv)
    uniforms.uRot.value.setFromMatrix4(mesh.matrixWorld)
  }
  front.onBeforeRender = (_r, _s, cam) => sync(front, cam)
  back.onBeforeRender = (_r, _s, cam) => sync(back, cam)
  const group = new THREE.Group()
  group.add(back, front)
  return { group, front, back, uniforms, hull }
}

// ---------------------------------------------------------------- debris field

const SHARD_VERT = /* glsl */ `
attribute vec3 aBary;
attribute vec3 aEdge;
attribute vec4 aSpin;
attribute float aRand;
uniform float uTime;
uniform vec3 uSing;
uniform float uPull;
varying vec3 vN;
varying vec3 vW;
varying vec3 vBary;
varying vec3 vEdge;
varying float vRand;
${ROTATE}
void main() {
  float a = uTime * aSpin.w + aRand * 6.2831;
  vec3 p = rotateAxis(position, aSpin.xyz, a);
  vec3 n = rotateAxis(normal, aSpin.xyz, a);
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  float pull = uPull * (0.55 + 0.45 * aRand);
  w.xyz = mix(w.xyz, uSing, pull);
  vN = wn;
  vW = w.xyz;
  vBary = aBary;
  vEdge = aEdge;
  vRand = aRand;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const SHARD_FRAG = /* glsl */ `
uniform float uFade;
varying vec3 vN;
varying vec3 vW;
varying vec3 vBary;
varying vec3 vEdge;
varying float vRand;
${BRAND_GLSL}
${HASH}
${ENV}
${EDGES}
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vW - cameraPosition);
  float cosT = clamp(dot(-V, N), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - cosT, 4.0);
  vec3 refl = envMap(reflect(V, N));
  vec3 body = vec3(0.004, 0.01, 0.012) + vec3(0.03, 0.075, 0.08) * pow(cosT, 3.0) * (0.2 + vRand * 0.8);
  vec3 col = body * (1.0 - F) + refl * (F * 0.65 + 0.05);
  float dm = edgeDist(vBary, vEdge);
  float line = 1.0 - smoothstep(0.3, 1.2, dm);
  float glint = min(dot(refl, vec3(0.3, 0.6, 0.1)), 2.0);
  col += mix(vec3(0.75, 1.0, 0.92), SIGNAL, 0.3) * line * (0.08 + 0.3 * F + glint * 0.5);
  float dist = length(vW - cameraPosition);
  col *= exp(-max(dist - 8.0, 0.0) * 0.04) * uFade;
  float near = smoothstep(0.7, 2.4, dist);
  if (hash12(gl_FragCoord.xy) > near) discard;
  gl_FragColor = vec4(col, 1.0);
}
`

export interface Field {
  mesh: THREE.InstancedMesh
  uniforms: { uTime: THREE.IUniform<number>; uSing: THREE.IUniform<THREE.Vector3>; uPull: THREE.IUniform<number>; uFade: THREE.IUniform<number> }
}

/**
 * One InstancedMesh of drifting shards. `accept(p)` lets the caller keep the
 * camera path and the hero crystals clear.
 */
export function createShardField(
  count: number,
  bounds: THREE.Box3,
  accept: (p: THREE.Vector3, size: number) => boolean,
  seed = 11,
): Field {
  const hull = buildHull(shardPoints(seed))
  const uniforms = {
    uTime: { value: 0 },
    uSing: { value: new THREE.Vector3() },
    uPull: { value: 0 },
    uFade: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG })
  const mesh = new THREE.InstancedMesh(hull.geometry, mat, count)
  const r = rng(seed * 7 + 3)
  const spin = new Float32Array(count * 4)
  const rand = new Float32Array(count)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const size = bounds.getSize(new THREE.Vector3())
  let placed = 0
  let guard = 0
  while (placed < count && guard++ < count * 40) {
    // bias toward the middle of the volume so the frame stays populated
    const bx = (r() + r() + r()) / 3
    const by = (r() + r()) / 2
    p.set(bounds.min.x + bx * size.x, bounds.min.y + by * size.y, bounds.min.z + r() * size.z)
    const sc = 0.1 + Math.pow(r(), 3.4) * 0.85
    if (!accept(p, sc)) continue
    s.set(sc * (0.7 + r() * 0.5), sc * (0.8 + r() * 0.6), sc * (0.7 + r() * 0.5))
    e.set(r() * TAU, r() * TAU, r() * TAU)
    q.setFromEuler(e)
    m.compose(p, q, s)
    mesh.setMatrixAt(placed, m)
    const ax = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize()
    spin.set([ax.x, ax.y, ax.z, (0.04 + r() * 0.22) * (r() < 0.5 ? -1 : 1)], placed * 4)
    rand[placed] = r()
    placed++
  }
  mesh.count = placed
  mesh.geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spin, 4))
  mesh.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1))
  mesh.frustumCulled = false
  mesh.instanceMatrix.needsUpdate = true
  return { mesh, uniforms }
}

// ---------------------------------------------------------------- dust

export interface Dust {
  points: THREE.Points
  uniforms: {
    uTime: THREE.IUniform<number>
    uScale: THREE.IUniform<number>
    uPull: THREE.IUniform<number>
    uSing: THREE.IUniform<THREE.Vector3>
    uFade: THREE.IUniform<number>
  }
}

export function createDust(count: number, bounds: THREE.Box3, seed = 5): Dust {
  const r = rng(seed)
  const pos = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const rand = new Float32Array(count)
  const b = bounds.getSize(new THREE.Vector3())
  for (let i = 0; i < count; i++) {
    pos[i * 3] = bounds.min.x + r() * b.x
    pos[i * 3 + 1] = bounds.min.y + r() * b.y
    pos[i * 3 + 2] = bounds.min.z + r() * b.z
    size[i] = 0.6 + Math.pow(r(), 2.5) * 2.4
    rand[i] = r()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1))
  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 30 },
    uPull: { value: 0 },
    uSing: { value: new THREE.Vector3() },
    uFade: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aRand;
      uniform float uTime;
      uniform float uScale;
      uniform float uPull;
      uniform vec3 uSing;
      uniform float uFade;
      varying float vA;
      void main() {
        vec3 p = position + vec3(sin(uTime * 0.07 + aRand * 31.0), cos(uTime * 0.05 + aRand * 17.0), sin(uTime * 0.06 + aRand * 7.0)) * 0.3;
        p = mix(p, uSing, uPull * (0.4 + 0.6 * aRand));
        vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
        float d = -mv.z;
        gl_PointSize = clamp(aSize * uScale / max(d, 0.1), 1.0, 9.0);
        float tw = 0.55 + 0.45 * sin(uTime * (0.8 + aRand * 2.0) + aRand * 50.0);
        vA = smoothstep(70.0, 14.0, d) * smoothstep(0.3, 1.6, d) * tw * uFade;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, r);
        a *= a;
        gl_FragColor = vec4(vec3(0.72, 1.0, 0.9) * 1.1, a * vA);
      }
    `,
  })
  const points = new THREE.Points(g, mat)
  points.frustumCulled = false
  points.renderOrder = 3
  return { points, uniforms }
}

// ---------------------------------------------------------------- singularity flare

export interface Flare {
  mesh: THREE.Mesh
  uniforms: { uSize: THREE.IUniform<number>; uIntensity: THREE.IUniform<number>; uAspect: THREE.IUniform<number> }
}

export function createFlare(): Flare {
  const uniforms = { uSize: { value: 1 }, uIntensity: { value: 0 }, uAspect: { value: 1 } }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uSize;
        varying vec2 vP;
        void main() {
          vP = position.xy;
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * uSize * vec2(3.0, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        varying vec2 vP;
        ${BRAND_GLSL}
        void main() {
          vec2 p = vP * vec2(3.0, 1.0);
          float r = length(p);
          float core = exp(-r * r * 60.0) * 6.0;
          float halo = exp(-r * 5.0) * 0.45;
          float streak = exp(-abs(p.y) * 70.0) * exp(-abs(p.x) * 1.1) * 1.6;
          vec3 c = vec3(0.85, 1.0, 0.94) * core + SIGNAL * halo + vec3(0.6, 1.0, 0.85) * streak;
          gl_FragColor = vec4(c * uIntensity, 1.0);
        }
      `,
    }),
  )
  mesh.frustumCulled = false
  mesh.renderOrder = 10
  return { mesh, uniforms }
}

// ---------------------------------------------------------------- orbit rings

export interface Orbit {
  object: THREE.LineSegments
  uniforms: { uFade: THREE.IUniform<number>; uTime: THREE.IUniform<number> }
}

/** Concentric orbit hairlines + a tick ring, lying in the XZ plane. */
export function createOrbit(radius: number): Orbit {
  const pos: number[] = []
  const tt: number[] = []
  const kind: number[] = []
  const seg = 256
  const ring = (rad: number, k: number) => {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * TAU
      const a1 = ((i + 1) / seg) * TAU
      pos.push(Math.cos(a0) * rad, 0, Math.sin(a0) * rad, Math.cos(a1) * rad, 0, Math.sin(a1) * rad)
      tt.push(i / seg, (i + 1) / seg)
      kind.push(k, k)
    }
  }
  ring(radius, 0)
  ring(radius * 1.32, 1)
  // tick marks on the outer ring
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU
    const r0 = radius * 1.32
    const r1 = r0 + (i % 6 === 0 ? 0.45 : 0.18)
    pos.push(Math.cos(a) * r0, 0, Math.sin(a) * r0, Math.cos(a) * r1, 0, Math.sin(a) * r1)
    tt.push(i / 72, i / 72)
    kind.push(2, 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1))
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
  const uniforms = { uFade: { value: 0 }, uTime: { value: 0 } }
  const object = new THREE.LineSegments(
    g,
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aT;
        attribute float aKind;
        varying float vT;
        varying float vK;
        varying float vDepth;
        void main() {
          vT = aT;
          vK = aKind;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFade;
        uniform float uTime;
        varying float vT;
        varying float vK;
        varying float vDepth;
        ${BRAND_GLSL}
        void main() {
          float a;
          vec3 c;
          if (vK < 0.5) {
            // main orbit: a bright comet sweep travelling around it
            float sweep = fract(vT - uTime * 0.035);
            a = 0.2 + pow(sweep, 10.0) * 1.4;
            c = mix(vec3(0.75, 1.0, 0.9), SIGNAL, 0.5);
          } else if (vK < 1.5) {
            a = step(0.5, fract(vT * 180.0)) * 0.12;
            c = vec3(0.8, 1.0, 0.92);
          } else {
            a = 0.3;
            c = vec3(0.8, 1.0, 0.92);
          }
          gl_FragColor = vec4(c, a * uFade);
        }
      `,
    }),
  )
  object.renderOrder = 4
  return { object, uniforms }
}
