import * as THREE from 'three'

/*
 * The transmission: a luminous oscilloscope line threaded through space
 * along a cubic Bézier from the pulsar to just past the camera. Drawn as
 * screen-space ribbons (constant pixel width, HDR core) — one bright main
 * trace plus faint phase-shifted "persistence" ghosts — and a stream of data
 * motes flowing toward the viewer. Everything is evaluated in the vertex
 * shader from uniforms, so it is fully driven by (local, time).
 */

const PATH = /* glsl */ `
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec3 uP3;
uniform float uTime;
uniform float uExtent;
uniform float uAmp;
uniform float uPacket;
uniform float uPacketAmp;
uniform float uVoice;
float gauss(float x) { return exp(-x * x); }
vec3 bez(float t) {
  float it = 1.0 - t;
  return it * it * it * uP0 + 3.0 * it * it * t * uP1 + 3.0 * it * t * t * uP2 + t * t * t * uP3;
}
vec3 bezD(float t) {
  float it = 1.0 - t;
  return 3.0 * it * it * (uP1 - uP0) + 6.0 * it * t * (uP2 - uP1) + 3.0 * t * t * (uP3 - uP2);
}
void frameAt(float u, out vec3 T, out vec3 N, out vec3 B) {
  T = normalize(bezD(u) + 1e-5);
  vec3 up = abs(T.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  N = normalize(up - T * dot(up, T));
  B = cross(T, N);
}
`

const RIBBON_VERT = /* glsl */ `
#define SEG __SEG__
${PATH}
uniform vec2 uRes;
uniform float uPx;
attribute float aS;
attribute float aSide;
attribute vec4 aLine; // phase, plane angle, amp scale, brightness
varying float vSide;
varying float vS;
varying float vBright;
varying float vPk;

float carrier(float u, float ph) {
  float k = 128.0;
  float w = sin(u * k - uTime * 2.6 + ph) * 0.7 + sin(u * k * 2.31 + uTime * 1.4 + ph * 1.7) * 0.12;
  // syllable-like bursts rolling toward the viewer while a voice is "speaking"
  float env = smoothstep(0.1, 0.9, 0.5 + 0.5 * sin(u * 31.0 - uTime * 3.1 + ph) * sin(u * 9.0 - uTime * 1.3));
  w += sin(u * k * 3.7 - uTime * 7.0 + ph) * 0.42 * uVoice * env;
  return w;
}

vec3 pos(float s, out float pk) {
  float u = s * uExtent;
  vec3 T, N, B;
  frameAt(u, T, N, B);
  float ca = cos(aLine.y), sa = sin(aLine.y);
  vec3 dir = N * ca + B * sa;
  float grow = mix(1.6, 0.42, smoothstep(0.25, 1.0, u)) * smoothstep(0.0, 0.08, u);
  pk = gauss((u - uPacket) / 0.03) * uPacketAmp;
  float y = carrier(u, aLine.x) * uAmp * grow * aLine.z;
  // the packet: a tight, bright burst of carrier riding down the line
  y += sin(u * 420.0 - uTime * 16.0 + aLine.x) * pk * grow * 0.55 * aLine.z;
  return bez(u) + dir * y;
}

void main() {
  float ds = 1.0 / float(SEG);
  float pk, pk2;
  vec3 P = pos(aS, pk);
  vec3 A = pos(min(aS + ds, 1.0), pk2);
  vec3 Z = pos(max(aS - ds, 0.0), pk2);
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 cP = vp * vec4(P, 1.0);
  vec4 cA = vp * vec4(A, 1.0);
  vec4 cZ = vp * vec4(Z, 1.0);
  vec2 sA = cA.xy / max(cA.w, 0.05) * uRes;
  vec2 sZ = cZ.xy / max(cZ.w, 0.05) * uRes;
  vec2 d = sA - sZ;
  vec2 dir = length(d) > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = uPx * (1.0 + pk * 0.6);
  cP.xy += nrm * aSide * w * 2.0 / uRes * max(cP.w, 0.05);
  vSide = aSide;
  vS = aS;
  vBright = aLine.w;
  vPk = pk;
  gl_Position = cP;
}
`

const RIBBON_FRAG = /* glsl */ `
uniform float uGlow;
varying float vSide;
varying float vS;
varying float vBright;
varying float vPk;
void main() {
  float core = exp(-vSide * vSide * 16.0);
  float halo = exp(-abs(vSide) * 3.4) * 0.16;
  float ends = smoothstep(0.0, 0.05, vS) * (1.0 - smoothstep(0.94, 1.0, vS));
  vec3 green = vec3(0.08, 1.0, 0.42);
  vec3 hot = vec3(0.8, 1.0, 0.88);
  float pk = clamp(vPk, 0.0, 1.0);
  vec3 col = mix(green, hot, pk * core) * (core * (1.5 + pk * 2.2) + halo) * vBright * ends * uGlow;
  gl_FragColor = vec4(col, 1.0);
}
`

const MOTE_VERT = /* glsl */ `
${PATH}
uniform float uPx;
uniform float uFlow;
attribute vec4 aRand;
varying float vA;
void main() {
  float u = fract(aRand.x + uTime * 0.018 + uFlow) * uExtent;
  vec3 T, N, B;
  frameAt(u, T, N, B);
  float spread = mix(9.0, 1.6, smoothstep(0.0, 1.0, u));
  float a = aRand.y * 6.28318;
  float r = sqrt(aRand.z) * spread;
  vec3 p = bez(u) + (N * cos(a) + B * sin(a)) * r;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float z = max(-mv.z, 0.5);
  vA = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.85, 1.0, u / max(uExtent, 1e-3))) * (0.35 + 0.65 * aRand.w);
  gl_PointSize = clamp(uPx * (0.6 + aRand.w) / z, 1.0, 7.0 * uPx / 60.0);
  gl_Position = projectionMatrix * mv;
}
`

const MOTE_FRAG = /* glsl */ `
uniform float uGlow;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float a = exp(-d * 16.0);
  gl_FragColor = vec4(vec3(0.55, 1.0, 0.75) * a * vA * 1.3 * uGlow, 1.0);
}
`

export class Waveform {
  group = new THREE.Group()
  /** shared path/wave uniforms (ribbon + motes) */
  u = {
    uP0: { value: new THREE.Vector3() },
    uP1: { value: new THREE.Vector3() },
    uP2: { value: new THREE.Vector3() },
    uP3: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uExtent: { value: 1 },
    uAmp: { value: 0.5 },
    uPacket: { value: -1 },
    uPacketAmp: { value: 0 },
    uVoice: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uPx: { value: 5 },
    uGlow: { value: 1 },
  }
  private moteU = { uPx: { value: 60 }, uFlow: { value: 0 } }

  constructor(mobile: boolean) {
    const SEG = mobile ? 900 : 1500
    // strip: SEG+1 pairs of vertices
    const aS = new Float32Array((SEG + 1) * 2)
    const aSide = new Float32Array((SEG + 1) * 2)
    const idx: number[] = []
    for (let i = 0; i <= SEG; i++) {
      aS[i * 2] = aS[i * 2 + 1] = i / SEG
      aSide[i * 2] = -1
      aSide[i * 2 + 1] = 1
      if (i < SEG) {
        const a = i * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 2 * 3), 3))
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 1))
    g.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
    g.setIndex(idx)
    // main trace + persistence ghosts: phase, plane angle, amp scale, brightness
    const lines = mobile
      ? [
          [0, 0, 1, 1],
          [1.9, 0.55, 0.85, 0.22],
        ]
      : [
          [0, 0, 1, 1],
          [1.9, 0.55, 0.85, 0.2],
          [3.7, -0.5, 1.12, 0.14],
          [5.1, 1.2, 0.7, 0.1],
        ]
    g.setAttribute('aLine', new THREE.InstancedBufferAttribute(new Float32Array(lines.flat()), 4))
    g.instanceCount = lines.length

    const ribbon = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.u,
        vertexShader: RIBBON_VERT.replace('__SEG__', String(SEG)),
        fragmentShader: RIBBON_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    ribbon.frustumCulled = false
    ribbon.renderOrder = 4
    this.group.add(ribbon)

    // motes
    const n = mobile ? 320 : 700
    const rnd = new Float32Array(n * 4)
    let seed = 1337
    const r = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    for (let i = 0; i < n * 4; i++) rnd[i] = r()
    const mg = new THREE.BufferGeometry()
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    mg.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4))
    const motes = new THREE.Points(
      mg,
      new THREE.ShaderMaterial({
        uniforms: { ...this.u, ...this.moteU },
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    motes.frustumCulled = false
    motes.renderOrder = 3
    this.group.add(motes)
  }

  setPath(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3) {
    this.u.uP0.value.copy(p0)
    this.u.uP1.value.copy(p1)
    this.u.uP2.value.copy(p2)
    this.u.uP3.value.copy(p3)
  }

  setView(res: THREE.Vector2, pixelRatio: number, flow: number) {
    this.u.uRes.value.copy(res)
    this.u.uPx.value = 5.2 * pixelRatio
    this.moteU.uPx.value = 70 * pixelRatio
    this.moteU.uFlow.value = flow
  }
}
