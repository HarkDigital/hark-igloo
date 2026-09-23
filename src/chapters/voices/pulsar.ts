import * as THREE from 'three'

/*
 * A pulsar: a pin-point white-hot core with a green halo + diffraction
 * spikes, two faint lighthouse beams along a tilted magnetic axis, dipole
 * field lines with current flowing through them, and a shock ring used for
 * the chapter's out-beat.
 */

const BILLBOARD_VERT = /* glsl */ `
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`

const GLOW_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uPulse;
uniform float uRot;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float core = exp(-d * d * 2200.0) * 60.0;
  float inner = exp(-d * d * 180.0) * 2.4;
  float halo = exp(-d * 9.0) * 0.5 + exp(-d * 3.4) * 0.07;
  float c = cos(uRot), s = sin(uRot);
  vec2 q = mat2(c, -s, s, c) * p;
  float spikes = exp(-abs(q.x) * 340.0) * exp(-abs(q.y) * 4.5) + exp(-abs(q.y) * 340.0) * exp(-abs(q.x) * 4.5);
  vec2 q2 = mat2(0.7071, -0.7071, 0.7071, 0.7071) * q;
  spikes += (exp(-abs(q2.x) * 420.0) * exp(-abs(q2.y) * 9.0) + exp(-abs(q2.y) * 420.0) * exp(-abs(q2.x) * 9.0)) * 0.35;
  vec3 col = vec3(1.0) * (core + inner) + vec3(0.25, 1.0, 0.55) * (halo + spikes * 1.3);
  col *= uIntensity * (1.0 + uPulse);
  col *= smoothstep(1.0, 0.8, d);
  gl_FragColor = vec4(col, 1.0);
}
`

const RING_FRAG = /* glsl */ `
float gauss(float x) { return exp(-x * x); }
uniform float uIntensity;
uniform float uT;
varying vec2 vUv;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float r = 0.86;
  float ring = gauss((d - r) / 0.008) * 3.2 + gauss((d - r) / 0.035) * 0.22;
  float inner = gauss((d - r * 0.72) / 0.004) * 1.2 * (1.0 - uT);
  float tick = step(0.5, fract(atan(vUv.y - 0.5, vUv.x - 0.5) / 6.28318 * 96.0)) * gauss((d - r * 1.08) / 0.006) * 1.2;
  vec3 col = mix(vec3(0.2, 1.0, 0.5), vec3(0.9, 1.0, 0.95), 0.35) * (ring + inner + tick);
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const BEAM_FRAG = /* glsl */ `
uniform vec3 uCamPos;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 V = normalize(uCamPos - vW);
  float facing = abs(dot(normalize(vN), V));
  float body = pow(clamp(facing, 0.0, 1.0), 2.4);
  // clamp before pow: interpolation can overshoot 1.0 by an ulp and pow() of a
  // negative is NaN, which the bloom chain smears across the whole frame
  float along = clamp(vUv.y, 0.0, 1.0);
  float fall = pow(1.0 - along, 1.8) * smoothstep(0.0, 0.02, along);
  float stri = 0.7 + 0.3 * sin(vUv.x * 6.28318 * 7.0 + along * 30.0 - uTime * 1.5);
  vec3 col = vec3(0.3, 1.0, 0.62) * body * fall * stri * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}
`

const FIELD_VERT = /* glsl */ `
attribute float aT;
attribute float aPhase;
varying float vT;
varying float vPhase;
void main() {
  vT = aT;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FIELD_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
varying float vT;
varying float vPhase;
void main() {
  float flow = pow(fract(vT * 2.0 - uTime * 0.22 + vPhase), 14.0);
  float edge = smoothstep(0.0, 0.12, vT) * smoothstep(1.0, 0.88, vT);
  vec3 col = vec3(0.1, 1.0, 0.45) * (0.07 + flow * 1.1) * edge * uIntensity;
  gl_FragColor = vec4(col, 1.0);
}
`

const additive = {
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
} as const

export class Pulsar {
  group = new THREE.Group()
  private rotor = new THREE.Group()
  private glowMat: THREE.ShaderMaterial
  private ringMat: THREE.ShaderMaterial
  private beamMat: THREE.ShaderMaterial
  private fieldMat: THREE.ShaderMaterial
  private ring: THREE.Mesh
  private beams = new THREE.Group()

  constructor(mobile: boolean) {
    const quad = new THREE.PlaneGeometry(2, 2)

    // spin axis tilted toward the viewer so the beams sweep across the sky
    const spin = new THREE.Group()
    spin.rotation.set(0.72, 0, -0.5)
    this.group.add(spin)
    spin.add(this.rotor)
    const mag = new THREE.Group()
    mag.rotation.z = 0.44
    this.rotor.add(mag)

    // beams
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uCamPos: { value: new THREE.Vector3() }, uIntensity: { value: 0.3 }, uTime: { value: 0 } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      side: THREE.DoubleSide,
      ...additive,
    })
    const L = 120
    const cone = new THREE.CylinderGeometry(6, 0.2, L, 32, 1, true)
    cone.translate(0, L / 2, 0)
    const b1 = new THREE.Mesh(cone, this.beamMat)
    const b2 = new THREE.Mesh(cone, this.beamMat)
    b2.rotation.x = Math.PI
    b1.frustumCulled = b2.frustumCulled = false
    this.beams.add(b1, b2)
    mag.add(this.beams)

    // dipole field lines r = L sin²θ
    const shells = mobile ? [3.2, 6.5] : [2.6, 4.8, 8.2]
    const az = mobile ? 8 : 12
    const segs = 72
    const pos: number[] = []
    const ts: number[] = []
    const ph: number[] = []
    for (const Ls of shells) {
      for (let a = 0; a < az; a++) {
        const phi = (a / az) * Math.PI * 2 + Ls
        const phase = (a * 0.37 + Ls * 0.11) % 1
        let prev: number[] | null = null
        for (let i = 0; i <= segs; i++) {
          const t = i / segs
          const th = 0.2 + t * (Math.PI - 0.4)
          const r = Ls * Math.sin(th) * Math.sin(th)
          const p = [r * Math.sin(th) * Math.cos(phi), r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)]
          if (prev) {
            pos.push(...prev, ...p)
            ts.push((i - 1) / segs, t)
            ph.push(phase, phase)
          }
          prev = p
        }
      }
    }
    const fg = new THREE.BufferGeometry()
    fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    fg.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1))
    fg.setAttribute('aPhase', new THREE.Float32BufferAttribute(ph, 1))
    this.fieldMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 } },
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      ...additive,
    })
    const field = new THREE.LineSegments(fg, this.fieldMat)
    field.frustumCulled = false
    mag.add(field)

    // core glow (billboard)
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 20 }, uIntensity: { value: 1 }, uPulse: { value: 0 }, uRot: { value: 0.2 } },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: GLOW_FRAG,
      ...additive,
    })
    const glow = new THREE.Mesh(quad, this.glowMat)
    glow.frustumCulled = false
    glow.renderOrder = 5
    this.group.add(glow)

    // shock ring (out-beat)
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1 }, uIntensity: { value: 0 }, uT: { value: 0 } },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: RING_FRAG,
      ...additive,
    })
    this.ring = new THREE.Mesh(quad, this.ringMat)
    this.ring.frustumCulled = false
    this.ring.renderOrder = 6
    this.group.add(this.ring)
  }

  update(o: {
    time: number
    angle: number
    pulse: number
    intensity: number
    /** core billboard size in world units */
    size: number
    beam: number
    ring: number
    camPos: THREE.Vector3
  }) {
    this.rotor.rotation.y = o.angle
    this.beamMat.uniforms.uCamPos.value.copy(o.camPos)
    this.beamMat.uniforms.uIntensity.value = o.beam
    this.beamMat.uniforms.uTime.value = o.time
    this.fieldMat.uniforms.uTime.value = o.time
    this.fieldMat.uniforms.uIntensity.value = o.intensity
    this.glowMat.uniforms.uIntensity.value = o.intensity
    this.glowMat.uniforms.uPulse.value = o.pulse
    this.glowMat.uniforms.uSize.value = o.size
    this.glowMat.uniforms.uRot.value = 0.18 + o.time * 0.01
    const r = o.ring
    this.ring.visible = r > 0.001
    this.ringMat.uniforms.uSize.value = 2 + Math.pow(r, 1.6) * 90
    this.ringMat.uniforms.uIntensity.value = Math.sin(Math.min(1, r * 1.1) * Math.PI) * 0.9 + r * 0.25
    this.ringMat.uniforms.uT.value = r
  }
}
