import { FBM, HASH, NOISE, ROTATE } from '../../core/glsl'
import { RING_COUNT } from './system'

/*
 * All GLSL for the Orbit chapter. Colors are linear HDR: anything above ~0.62
 * blooms, so bodies stay dark and only the accents burn.
 */

const HEAD = /* glsl */ `
const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
// NaN-safe powers: pow() of a negative base is undefined (NaN on Metal), and a
// single NaN pixel smears the whole frame black through the bloom chain
float sq(float x) { return x * x; }
float spow(float x, float y) { return pow(max(x, 0.0), y); }
`

/** Hex tiling on a sphere (lat/long mapped) — used by the security world and the distant planet. */
const HEX = /* glsl */ `
vec4 hexCoords(vec2 uv) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(uv, uv - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(uv - hC.xy * s, uv - (hC.zw + 0.5) * s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
}
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.5, 0.8660254)), p.x);
}
/** returns edge mask 0..1 (1 on hex borders); id = cell id */
float hexEdge(vec3 q, float density, out vec2 id) {
  vec2 uv = vec2(atan(q.z, q.x) / PI, asin(clamp(q.y, -1.0, 1.0)) / (PI * 0.5));
  uv *= vec2(density, density * 0.5);
  vec4 h = hexCoords(uv);
  id = h.zw;
  float d = 0.5 - hexDist(h.xy);
  float fw = min(fwidth(d), 0.2);
  return 1.0 - smoothstep(0.02, 0.02 + fw * 1.6, d);
}
`

/* ------------------------------------------------------------------ */
/* worlds                                                              */
/* ------------------------------------------------------------------ */

export const worldVert = /* glsl */ `
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vWN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

export const worldFrag =
  HEAD +
  HASH +
  NOISE +
  FBM +
  ROTATE +
  HEX +
  /* glsl */ `
uniform int uKind;
uniform float uTime;
uniform float uSeed;
uniform float uFocus;
uniform float uHeal;
uniform float uSpin;
uniform float uTilt;
uniform float uDim;
uniform vec3 uStar;
uniform vec3 uAxis;
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;

float gridLine(float v, float w) {
  float fw = min(fwidth(v), 0.5);
  float d = abs(fract(v + 0.5) - 0.5);
  return 1.0 - smoothstep(w, w + fw * 1.5, d);
}

vec3 voronoi3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g);
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = hash13(i + g + 7.1); }
    else if (d < f2) { f2 = d; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

void main() {
  vec3 n = normalize(vObj);
  vec3 q = rotY(uSpin) * (rotZ(-uTilt) * n);

  vec3 N = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 L = normalize(uStar - vWP);
  float ndl = dot(N, L);
  float nv = max(dot(N, V), 0.0);
  float fres = 1.0 - nv;
  float night = 1.0 - smoothstep(-0.28, 0.22, ndl);

  vec3 alb = vec3(0.04);
  vec3 emi = vec3(0.0);
  float spec = 0.0;
  float t = uTime;

  if (uKind == 0) {
    // SOFTWARE — circuit traces on a graphite world
    vec3 a = abs(q);
    vec2 st;
    float fid;
    if (a.x >= a.y && a.x >= a.z) { st = q.zy / a.x; fid = q.x > 0.0 ? 0.0 : 1.0; }
    else if (a.y >= a.z) { st = q.xz / a.y; fid = q.y > 0.0 ? 2.0 : 3.0; }
    else { st = q.xy / a.z; fid = q.z > 0.0 ? 4.0 : 5.0; }
    st *= 6.0;
    vec2 cell = floor(st);
    vec2 f = fract(st);
    float rowH = hash12(vec2(cell.y, fid * 13.1 + uSeed));
    float colH = hash12(vec2(cell.x + 40.0, fid * 7.7 + uSeed));
    float ty = (floor(rowH * 3.0) + 0.5) / 3.0;
    float tx = (floor(colH * 3.0) + 0.5) / 3.0;
    float onH = step(0.42, hash12(cell + fid * 31.7 + uSeed));
    float onV = step(0.62, hash12(cell * 1.37 + fid * 11.3 + 4.1));
    float fwY = min(fwidth(f.y), 0.3);
    float fwX = min(fwidth(f.x), 0.3);
    float lh = onH * (1.0 - smoothstep(0.03, 0.03 + fwY * 1.5, abs(f.y - ty)));
    float lv = onV * (1.0 - smoothstep(0.03, 0.03 + fwX * 1.5, abs(f.x - tx)));
    float trace = max(lh, lv);
    float via = step(0.66, hash12(cell + 91.0 + fid)) * (1.0 - smoothstep(0.07, 0.11, length(f - vec2(tx, ty))));
    float pulse = smoothstep(0.93, 1.0, fract((st.x + st.y) * 0.11 - t * 0.35 + rowH * 5.0));
    alb = vec3(0.028, 0.034, 0.034) + vec3(0.03, 0.05, 0.04) * trace;
    emi = SIGNAL * (trace * (0.42 + 2.4 * pulse) + via * 1.9);
    spec = 0.35;
  } else if (uKind == 1) {
    // WEB DESIGN — lat/long wireframe grid
    float lat = asin(clamp(q.y, -1.0, 1.0));
    float lon = atan(q.z, q.x);
    float polar = smoothstep(0.985, 0.9, abs(q.y));
    float g1 = max(gridLine(lat / (PI / 12.0), 0.035), gridLine(lon / (PI / 12.0), 0.035) * polar);
    float g2 = max(gridLine(lat / (PI / 48.0), 0.05), gridLine(lon / (PI / 48.0), 0.05) * polar) * 0.18;
    float nodes = (1.0 - smoothstep(0.0, 0.12, length(vec2(abs(fract(lat / (PI / 12.0) + 0.5) - 0.5), abs(fract(lon / (PI / 12.0) + 0.5) - 0.5))))) * polar;
    float scan = exp(-sq((q.y - sin(t * 0.35) * 0.9) * 10.0));
    alb = vec3(0.02, 0.03, 0.036);
    emi = SIGNAL * (g1 * (0.55 + 0.9 * scan) + g2 + nodes * 1.6) + vec3(0.6, 1.0, 0.8) * scan * 0.06;
    spec = 0.5;
  } else if (uKind == 2) {
    // ECOMMERCE — banded gold-green giant
    float warp = fbm(q * 2.1 + uSeed, 3) * 0.2;
    float y = q.y + warp;
    float b1 = 0.5 + 0.5 * sin(y * 21.0);
    float b2 = 0.5 + 0.5 * sin(y * 55.0 + 1.3 + warp * 8.0);
    alb = mix(vec3(0.045, 0.045, 0.03), vec3(0.3, 0.29, 0.17), b1 * 0.7);
    alb = mix(alb, vec3(0.13, 0.15, 0.09), b2 * 0.35);
    float storm = 1.0 - smoothstep(0.0, 0.12, length(vec2((q.y + 0.35) * 2.4, atan(q.z, q.x) - 0.6) * vec2(1.0, 0.35)));
    alb = mix(alb, vec3(0.5, 0.52, 0.28), storm * 0.6);
    emi = SIGNAL * 0.02 * b1;
  } else if (uKind == 3) {
    // SEO / GEO — a beacon that faces the viewer, pinging outward
    float ang = acos(clamp(dot(N, uAxis), -1.0, 1.0));
    alb = vec3(0.03, 0.036, 0.04) * (0.7 + 0.6 * fbm(q * 3.5 + uSeed, 3));
    float wave = fract(t * 0.3 - ang / PI * 3.0);
    float ring = spow(wave, 18.0) * smoothstep(0.06, 0.3, ang) * (1.0 - ang / PI);
    float survey = gridLine(ang * 10.0 / PI, 0.015) * smoothstep(0.1, 0.3, ang);
    float beacon = exp(-ang * ang * 160.0);
    float core = exp(-ang * ang * 30.0);
    emi = SIGNAL * (ring * 1.1 + survey * 0.07 + core * 0.25) + vec3(1.2, 2.8, 1.8) * beacon * (0.7 + 0.3 * sin(t * 4.0));
    spec = 0.25;
  } else if (uKind == 4) {
    // PAGE SPEED — icy comet nucleus
    float nn = fbm(q * 3.2 + uSeed, 4);
    alb = vec3(0.42, 0.47, 0.48) * (0.55 + 0.6 * nn);
    emi = vec3(0.3, 0.9, 0.55) * 0.12 * (0.5 + nn);
    spec = 0.4;
  } else if (uKind == 5) {
    // AI — neural filaments
    float n1 = snoise(q * 2.1 + uSeed);
    float n2 = snoise(q * 4.6 + 11.0);
    float f1 = spow(1.0 - abs(n1), 16.0);
    float f2 = spow(1.0 - abs(n2), 24.0) * 0.6;
    float pulse = 0.5 + 0.5 * sin(t * 1.5 - (n1 + q.y) * 7.0);
    vec3 vv = voronoi3(q * 4.5 + uSeed);
    float node = (1.0 - smoothstep(0.05, 0.13, vv.x)) * step(0.62, vv.z);
    alb = vec3(0.028, 0.03, 0.04);
    emi = SIGNAL * (f1 + f2) * (0.4 + 1.5 * pulse * pulse) + vec3(0.9, 2.4, 1.5) * node * (0.5 + 0.8 * pulse);
    spec = 0.3;
  } else if (uKind == 6) {
    // AERIAL — topographic survey world
    float h = fbm(q * 2.4 + uSeed, 5);
    float land = smoothstep(-0.02, 0.05, h);
    alb = mix(vec3(0.01, 0.018, 0.024), vec3(0.08, 0.09, 0.075) * (0.8 + h), land);
    float contour = gridLine(h * 15.0, 0.07) * land;
    emi = SIGNAL * contour * 0.32;
    spec = (1.0 - land) * 0.7;
  } else if (uKind == 7) {
    // HACK REMEDIATION — cracked surface, healing as you scroll
    vec3 v = voronoi3(q * 3.1 + uSeed);
    float e = v.y - v.x;
    float fw = min(fwidth(e), 0.2);
    vec3 o = normalize(vec3(0.3, 0.8, 0.5));
    float dist = length(q - o);
    float front = uHeal * 2.35;
    float healed = 1.0 - smoothstep(front - 0.22, front, dist);
    float w = mix(0.034, 0.01, healed);
    float crack = 1.0 - smoothstep(w, w + fw * 1.5, e);
    // thin the glow where cracks go sub-pixel so the far body never blooms into a blob
    crack *= clamp(w / max(fw * 1.2, 1e-4), 0.25, 1.0);
    float flick = 0.72 + 0.28 * sin(t * 9.0 + v.z * 40.0);
    vec3 hot = vec3(0.3, 1.05, 0.55) * flick;
    vec3 seamC = SIGNAL * 0.3;
    float frontGlow = exp(-sq((dist - front) * 8.0)) * step(0.002, uHeal) * step(uHeal, 0.998);
    alb = vec3(0.034, 0.036, 0.034) * (0.7 + 0.6 * fbm(q * 4.0, 3)) * (1.0 - crack * 0.8);
    emi = mix(hot, seamC, healed) * crack + SIGNAL * frontGlow * (0.05 + 1.1 * crack);
    emi += SIGNAL * 0.06 * (1.0 - healed) * step(0.7, v.z) * flick;
    spec = 0.2;
  } else if (uKind == 8) {
    // SECURITY — armored body under a hex shield
    alb = vec3(0.045, 0.05, 0.056) * (0.8 + 0.4 * fbm(q * 5.0 + uSeed, 3));
    vec2 id;
    float he = hexEdge(q, 12.0, id);
    emi = SIGNAL * he * 0.1;
    spec = 0.7;
  } else if (uKind == 9) {
    // ADA — calm pearl world with concentric waves around the view axis
    float ang = acos(clamp(dot(N, uAxis), -1.0, 1.0));
    float rings = gridLine(ang * 8.0 / PI - t * 0.1, 0.045);
    alb = vec3(0.085, 0.095, 0.1) * (0.85 + 0.3 * fbm(q * 2.5 + uSeed, 3));
    emi = SIGNAL * rings * 0.4 * smoothstep(0.08, 0.3, ang) + vec3(0.8, 1.6, 1.2) * exp(-ang * ang * 90.0) * 0.8;
    spec = 0.5;
  } else {
    // WORDPRESS — the classic moon
    vec3 v = voronoi3(q * 3.6 + uSeed);
    float rc = 0.22 + 0.2 * v.z;
    float d = v.x / rc;
    float bowl = 1.0 - smoothstep(0.65, 1.0, d);
    float rim = exp(-sq((d - 1.0) * 5.0));
    vec3 v2 = voronoi3(q * 9.0 + 3.0);
    float d2 = v2.x / (0.2 + 0.15 * v2.z);
    float bowl2 = 1.0 - smoothstep(0.6, 1.0, d2);
    float maria = smoothstep(0.02, 0.35, fbm(q * 1.4 + uSeed, 4));
    alb = vec3(0.3, 0.31, 0.3) * (1.0 - 0.5 * maria) * (1.0 - 0.3 * bowl - 0.18 * bowl2) + vec3(0.1) * rim * step(0.5, v.z);
    alb *= 0.85 + 0.3 * fbm(q * 8.0, 3);
    spec = 0.0;
  }

  // lighting from the star
  float diff = smoothstep(-0.1, 0.95, ndl);
  vec3 col = alb * vec3(1.0, 1.03, 0.99) * diff * 1.7;
  vec3 H = normalize(L + V);
  col += spec * spow(max(dot(N, H), 0.0), 48.0) * step(0.0, ndl) * vec3(0.8, 1.0, 0.9);
  col += emi * mix(0.4, 1.0, night) * (0.85 + 0.3 * uFocus);
  // lit-limb scattering and a whisper of green on the night side
  col += SIGNAL * spow(fres, 3.5) * smoothstep(-0.25, 0.6, ndl) * 0.28;
  col += alb * SIGNAL * 0.25 * night;
  col *= uDim;
  gl_FragColor = vec4(col, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* atmosphere glow (BackSide) and hex shield (FrontSide) shells        */
/* ------------------------------------------------------------------ */

export const shellVert = worldVert

export const glowFrag =
  HEAD +
  /* glsl */ `
uniform vec3 uStar;
uniform vec3 uCenter;
uniform float uStrength;
uniform float uPower;
uniform float uEdge;
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
void main() {
  vec3 N = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 L = normalize(uStar - uCenter);
  float g = spow(clamp(-dot(N, V) / uEdge, 0.0, 1.0), uPower);
  float lit = smoothstep(-0.5, 0.7, dot(N, L));
  vec3 col = mix(SIGNAL * 0.6, vec3(0.6, 1.0, 0.8), 0.25) * g * (0.14 + 1.1 * lit) * uStrength;
  gl_FragColor = vec4(col, 1.0);
}
`

export const hexShellFrag =
  HEAD +
  HASH +
  ROTATE +
  HEX +
  /* glsl */ `
uniform vec3 uStar;
uniform float uTime;
uniform float uStrength;
uniform float uDensity;
uniform float uSpin;
uniform float uTilt;
uniform float uSweep;
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
void main() {
  vec3 N = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  vec3 L = normalize(uStar - vWP);
  float fres = 1.0 - max(dot(N, V), 0.0);
  vec3 q = rotY(uSpin) * (rotZ(-uTilt) * normalize(vObj));
  vec2 id;
  float he = hexEdge(q, uDensity, id);
  float sweep = exp(-sq((q.y - uSweep) * 4.5));
  float flash = step(0.94, hash12(id + floor(uTime * 1.3))) * (0.5 + 0.5 * sin(uTime * 6.0 + id.x));
  float lit = smoothstep(-0.6, 0.6, dot(N, L));
  float a = he * (0.05 + 1.1 * spow(fres, 2.2)) * (0.45 + 0.55 * lit) + he * sweep * 0.9 + flash * 0.12 * (0.3 + fres);
  a += spow(fres, 5.0) * 0.5;
  gl_FragColor = vec4(SIGNAL * a * uStrength, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* billboard halos: radar (SEO), concentric pulses (ADA), focus reticle */
/* ------------------------------------------------------------------ */

export const haloVert = /* glsl */ `
uniform float uSize;
uniform float uR;
varying vec2 vP;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  vP = position.xy * uSize / uR;
  gl_Position = projectionMatrix * mv;
}
`

export const haloFrag =
  HEAD +
  /* glsl */ `
uniform int uMode;
uniform float uTime;
uniform float uVis;
uniform float uMax;
varying vec2 vP;

float ringAt(float r, float R, float w) {
  float fw = fwidth(r);
  return 1.0 - smoothstep(w, w + fw * 1.4, abs(r - R));
}

void main() {
  float r = length(vP);
  float ang = atan(vP.y, vP.x);
  float a01 = ang / TAU + 0.5;
  vec3 col = vec3(0.0);
  float edge = 1.0 - smoothstep(uMax * 0.8, uMax, r);
  if (uMode == 0) {
    // radar: expanding pings + rotating sweep
    float a = 0.0;
    for (int i = 0; i < 3; i++) {
      float k = fract(uTime * 0.26 + float(i) / 3.0);
      float R = 1.08 + k * 2.6;
      a += ringAt(r, R, 0.004) * (1.0 - k) * (1.0 - k) * 0.6;
      a += exp(-abs(r - R) * 14.0) * (1.0 - k) * 0.06;
    }
    float sw = mod(ang - uTime * 0.9, TAU);
    float wedge = (exp(-sw * 2.2) - exp(-TAU * 2.2)) * smoothstep(1.0, 1.25, r) * (1.0 - smoothstep(1.8, 3.2, r)) * 0.1;
    a += (ringAt(r, 2.2, 0.003) + ringAt(r, 3.3, 0.003)) * 0.1;
    col = SIGNAL * (a + wedge) * step(1.0, r);
  } else if (uMode == 1) {
    // accessibility: calm concentric pulses, evenly spaced
    float a = 0.0;
    for (int i = 0; i < 5; i++) {
      float k = fract(uTime * 0.09 + float(i) / 5.0);
      float R = 1.12 + k * 2.2;
      a += ringAt(r, R, 0.005) * sin(k * PI) * 0.7;
    }
    col = mix(SIGNAL, vec3(0.8, 1.0, 0.9), 0.35) * a * step(1.0, r);
  } else {
    // focus reticle
    float f = fract(a01 * 4.0);
    float gap = smoothstep(0.035, 0.06, min(f, 1.0 - f));
    float circle = ringAt(r, 1.42, 0.002) * gap * 0.38;
    float tickMask = 1.0 - smoothstep(0.004, 0.01, min(f, 1.0 - f));
    float ticks = tickMask * step(1.5, r) * step(r, 1.62) * 1.1;
    float arcs = step(0.72, fract(a01 * 3.0 - uTime * 0.02)) * ringAt(r, 1.58, 0.002) * 0.22;
    float fine = step(0.5, fract(a01 * 90.0)) * ringAt(r, 1.7, 0.01) * 0.08;
    col = vec3(0.85, 1.0, 0.92) * (circle + arcs + fine) + SIGNAL * ticks;
  }
  gl_FragColor = vec4(col * uVis * edge, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* the star core + corona                                              */
/* ------------------------------------------------------------------ */

export const starFrag =
  HEAD +
  NOISE +
  FBM +
  /* glsl */ `
uniform float uTime;
uniform float uHeat;
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
void main() {
  vec3 N = normalize(vWN);
  vec3 V = normalize(cameraPosition - vWP);
  float mu = clamp(dot(N, V), 0.0, 1.0);
  vec3 p = normalize(vObj);
  float g = fbm(p * 4.0 + vec3(0.0, uTime * 0.05, uTime * 0.03), 4);
  float cells = fbm(p * 11.0 - vec3(uTime * 0.07), 3);
  // plasma disc held just under the bloom threshold, blazing limb ring:
  // the dark mark in front stays a crisp silhouette
  vec3 disc = vec3(0.16, 0.5, 0.3) * (0.62 + 0.45 * g + 0.25 * cells);
  float limb = spow(1.0 - mu, 2.4);
  vec3 ring = vec3(0.9, 2.3, 1.45) * limb * (0.85 + 0.3 * g);
  vec3 col = disc + ring;
  gl_FragColor = vec4(col * uHeat, 1.0);
}
`

export const coronaVert = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  vP = position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`

export const coronaFrag =
  HEAD +
  NOISE +
  /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uR;
uniform float uStrength;
varying vec2 vP;
void main() {
  float r = length(vP);
  float x = r / uR;
  vec2 dir = vP / max(r, 1e-4);
  float xo = max(x - 1.0, 0.0);
  float inner = exp(-xo * 7.0) * 0.85;
  float mid = exp(-xo * 1.6) * 0.075;
  float wide = exp(-x * 0.45) * 0.014;
  float rays = snoise(vec3(dir * 2.6, x * 0.22 - uTime * 0.04));
  rays = spow(0.5 + 0.5 * rays, 4.0) * exp(-xo * 0.9) * 0.45;
  float I = inner + mid + wide + rays;
  // thin anamorphic streak through the core
  float streak = exp(-abs(vP.y) * 70.0 / uR) * exp(-abs(vP.x) * 0.28 / uR) * 0.32;
  I += streak;
  I *= 1.0 - smoothstep(uSize * 0.55, uSize, r);
  vec3 col = mix(vec3(0.05, 0.9, 0.32), vec3(1.1, 1.6, 1.3), clamp(exp(-xo * 3.0), 0.0, 1.0));
  gl_FragColor = vec4(col * I * uStrength, 1.0);
}
`

/* The Hark mark, billboarded in view space and floated in front of the star. */
export const markVert =
  ROTATE +
  /* glsl */ `
uniform float uScale;
uniform float uOffset;
uniform float uYaw;
uniform float uPitch;
varying vec3 vN;
varying vec3 vLocal;
void main() {
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = length(c.xyz);
  c.xyz += (-c.xyz / dist) * min(uOffset, dist * 0.8);
  mat3 R = rotY(uYaw) * rotX(uPitch);
  vec3 p = R * (position * uScale);
  vN = R * normal;
  vLocal = position;
  gl_Position = projectionMatrix * vec4(c.xyz + p, 1.0);
}
`

export const markFrag =
  HEAD +
  /* glsl */ `
uniform float uDiamond;
uniform float uHeat;
uniform float uTime;
varying vec3 vN;
varying vec3 vLocal;
void main() {
  vec3 N = normalize(vN);
  float facing = abs(N.z);
  float rim = spow(1.0 - facing, 1.6);
  vec3 col;
  if (uDiamond > 0.5) {
    float pulse = 0.9 + 0.1 * sin(uTime * 2.2);
    col = vec3(0.32, 1.55, 0.72) * uHeat * pulse + vec3(0.6, 1.4, 0.9) * rim;
  } else {
    // near-black body; bevels catch the star behind as a green rim
    col = vec3(0.004, 0.006, 0.006) + vec3(0.01, 0.02, 0.017) * (0.5 + 0.5 * N.y);
    col += SIGNAL * rim * 1.5 + vec3(0.6, 1.0, 0.85) * rim * rim * 1.2;
  }
  gl_FragColor = vec4(col, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* orbit ribbons: rings, ticks, comet tail — one draw call             */
/* ------------------------------------------------------------------ */

const RING_UNIFORMS = /* glsl */ `
uniform mat3 uBasis[${RING_COUNT}];
uniform vec3 uCenter[${RING_COUNT}];
uniform float uRadius[${RING_COUNT}];
uniform float uPlanet[${RING_COUNT}];
uniform float uFocus[${RING_COUNT}];
uniform float uGap[${RING_COUNT}];
uniform float uAlpha[${RING_COUNT}];
`

export const orbitVert =
  HEAD +
  RING_UNIFORMS +
  /* glsl */ `
attribute float aRing;
attribute float aAngle;
attribute float aRad;
attribute float aSide;
attribute float aKind;
attribute float aT;
uniform float uPxWorld;
varying float vAngle;
varying float vPx;
varying float vHalf;
varying float vT;
flat varying int vRing;
flat varying int vKind;

void main() {
  int ri = int(aRing + 0.5);
  int kind = int(aKind + 0.5);
  float ang = aAngle;
  if (kind == 2) ang += uPlanet[ri];
  vec3 radial = vec3(cos(ang), 0.0, sin(ang));
  vec3 tangent = vec3(-sin(ang), 0.0, cos(ang));
  mat3 B = uBasis[ri];
  float R = uRadius[ri];
  float rad = kind == 1 ? 1.0 + aRad / R : aRad;
  vec3 p = uCenter[ri] + B * (radial * R * rad);
  vec3 dir = B * (kind == 1 ? radial : tangent);
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
  vec3 wdir = normalize(mat3(modelMatrix) * dir);
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 side = cross(wdir, toCam / dist);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);

  float focus = uFocus[ri];
  float hw;
  if (kind == 0) hw = 0.55 + 0.35 * focus;
  else if (kind == 1) hw = 0.5;
  else hw = mix(3.4, 0.3, spow(aT, 0.6));
  float total = hw + 1.0;
  wp += side * aSide * total * uPxWorld * dist;

  vAngle = aAngle;
  vPx = aSide * total;
  vHalf = hw;
  vT = aT;
  vRing = ri;
  vKind = kind;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`

export const orbitFrag =
  HEAD +
  RING_UNIFORMS +
  /* glsl */ `
uniform float uTime;
uniform float uMaster;
varying float vAngle;
varying float vPx;
varying float vHalf;
varying float vT;
flat varying int vRing;
flat varying int vKind;

void main() {
  float aa = clamp(vHalf + 0.5 - abs(vPx), 0.0, 1.0);
  float focus = uFocus[vRing];
  float R = uRadius[vRing];
  float dA = mod(vAngle - uPlanet[vRing] + PI, TAU) - PI;
  vec3 col;
  float a;
  if (vKind == 0) {
    float arc = vAngle * R;
    float dash = step(0.42, fract(arc * 5.0));
    float near = exp(-dA * dA / 0.09);
    a = (0.028 + 0.15 * focus) + dash * (0.06 + 0.2 * focus);
    a += near * (0.16 + 0.75 * focus);
    // leading edge sweep on the focused ring
    float lead = exp(-sq((dA - 0.55) * 3.0)) * focus * 0.3;
    a += lead;
    float g = uGap[vRing];
    a *= smoothstep(g, g * 1.7, abs(dA));
    col = mix(vec3(0.82, 0.92, 0.88), SIGNAL * 1.5, clamp(focus * 0.55 + near * 0.6, 0.0, 1.0));
  } else if (vKind == 1) {
    a = 0.04 + 0.5 * focus;
    col = mix(vec3(0.8, 0.9, 0.85), SIGNAL * 1.3, focus);
  } else {
    float k = clamp(1.0 - vT, 0.0, 1.0);
    a = spow(k, 2.2) * (0.9 + 0.1 * sin(vT * 40.0 - uTime * 14.0));
    col = mix(SIGNAL * 1.2, vec3(1.3, 1.9, 1.55), k * k * k);
  }
  a *= aa * uAlpha[vRing] * uMaster;
  gl_FragColor = vec4(col, a);
}
`

/* ------------------------------------------------------------------ */
/* ecommerce ring system                                               */
/* ------------------------------------------------------------------ */

export const ringVert = /* glsl */ `
varying vec3 vWP;
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

export const ringFrag = /* glsl */ `
uniform vec3 uStar;
uniform vec3 uPlanetPos;
uniform float uPlanetR;
uniform float uInner;
uniform float uOuter;
uniform float uDim;
varying vec3 vWP;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float t = (r - uInner) / (uOuter - uInner);
  float bands = 0.55 + 0.45 * sin(t * 71.0) * sin(t * 23.0 + 1.0);
  float fine = 0.8 + 0.2 * sin(t * 260.0);
  float gap = smoothstep(0.0, 0.025, abs(t - 0.64)) * smoothstep(0.0, 0.012, abs(t - 0.3));
  float edge = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t);
  float alpha = bands * fine * gap * edge * 0.82;
  vec3 L = normalize(uStar - vWP);
  vec3 oc = vWP - uPlanetPos;
  float b = dot(oc, L);
  float c = dot(oc, oc) - uPlanetR * uPlanetR;
  float shadow = (b * b - c > 0.0 && b < 0.0) ? 0.08 : 1.0;
  vec3 col = mix(vec3(0.14, 0.14, 0.08), vec3(0.5, 0.5, 0.3), bands) * shadow * uDim;
  gl_FragColor = vec4(col, alpha);
}
`

/* ------------------------------------------------------------------ */
/* dust + solar wind points                                            */
/* ------------------------------------------------------------------ */

export const dustVert = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform float uTime;
uniform float uPxScale;
uniform float uAlpha;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.001);
  float s = aSize * uPxScale / z;
  gl_PointSize = clamp(s, 1.0, 16.0);
  float tw = 0.65 + 0.35 * sin(uTime * (0.4 + aSeed * 1.8) + aSeed * 50.0);
  vA = tw * uAlpha * min(s, 1.0) * smoothstep(0.08, 0.9, z) * (s > 16.0 ? 16.0 / s : 1.0);
}
`

export const dustFrag = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(vec3(0.72, 1.0, 0.86) * a * vA, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* the aerial world's little satellite                                 */
/* ------------------------------------------------------------------ */

export const satVert = /* glsl */ `
attribute float aEmit;
varying vec3 vWN;
varying float vEmit;
void main() {
  vWN = normalize(mat3(modelMatrix) * normal);
  vEmit = aEmit;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const satFrag =
  HEAD +
  /* glsl */ `
uniform vec3 uStarDir;
uniform float uTime;
varying vec3 vWN;
varying float vEmit;
void main() {
  vec3 N = normalize(vWN);
  float d = max(dot(N, uStarDir), 0.0);
  vec3 col = vec3(0.1, 0.12, 0.12) * (0.15 + d * 1.6) + SIGNAL * spow(d, 12.0) * 0.8;
  float blink = step(0.82, fract(uTime * 0.9));
  col = mix(col, vec3(1.5, 3.5, 2.2) * (0.3 + 1.7 * blink), vEmit);
  gl_FragColor = vec4(col, 1.0);
}
`
