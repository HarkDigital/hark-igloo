// GLSL for the procedural planet (src/world/Planet.ts).
// Everything lighting-related is computed in world space from modelMatrix,
// so planets can be positioned / tilted / uniformly scaled freely.
import { NOISE, FBM, HASH } from '../core/glsl'

export const PLANET_COMMON = /* glsl */ `
#define PI 3.14159265359
uniform mat4 modelMatrix;   // (fragment stage) three sets it for the vertex stage; same program uniform
uniform vec3 uSun;          // world-space direction light comes FROM (normalized)
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uR;           // body radius (object units)
uniform float uRa;          // atmosphere outer radius (object units)
uniform vec3 uAtm;          // atmosphere colour (linear)
uniform float uTime;
uniform float uRings;       // 0 / 1
uniform float uRingIn;      // ring inner radius, in planet radii
uniform float uRingOut;
uniform float uRingSeed;

const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);

float rhash(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float rnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(rhash(i + uRingSeed), rhash(i + 1.0 + uRingSeed), f);
}

// ring optical density at normalized radius u (0 = inner edge, 1 = outer).
// fw = screen-space width of u, used to fade bands narrower than a pixel.
float ringDensity(float u, float fw) {
  if (u <= 0.0 || u >= 1.0) return 0.0;
  float d = smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.94, u);
  d *= mix(0.22, 1.0, smoothstep(0.16, 0.3, u));          // faint inner "C ring"
  d *= mix(1.0, 0.68, smoothstep(0.67, 0.71, u));          // dimmer outer "A ring"
  d *= 1.0 - 0.94 * (1.0 - smoothstep(0.0, 0.024, abs(u - 0.645))); // main division
  d *= 1.0 - 0.85 * (1.0 - smoothstep(0.0, 0.005, abs(u - 0.885))); // thin gap
  float b = 0.0;
  float a = 0.5;
  float f = 31.0;
  float tot = 0.0;
  for (int i = 0; i < 4; i++) {
    float keep = 1.0 - smoothstep(0.2, 0.8, fw * f);
    b += a * mix(0.5, rnoise(u * f + float(i) * 17.0), keep);
    tot += a;
    f *= 2.63;
    a *= 0.62;
  }
  b /= tot;
  d *= 0.18 + 1.25 * b * b * 1.6;
  return clamp(d, 0.0, 1.0);
}

// ray / sphere at origin: returns (tNear, tFar); tNear > tFar on a miss
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
`

// ------------------------------------------------------------------ body

// Static, low-frequency surface fields. They are baked once per planet into a
// cube map in object space (Planet.bakeSurface), so the per-pixel shader only
// evaluates the fine octaves live. The body shader keeps a live fallback
// (BAKED = 0) for GPUs where the bake fails.
//
//   terrainBase: the domain-warped continents, octaves 0..3 (+ the 3-octave
//                'low' field used for relief / ice)
//   cloudBase:   the domain-warped cloud deck, octaves 0..2
const SURFACE_FUNCS = /* glsl */ `
float terrainBase(vec3 p, out float low) {
  vec3 q = p * 1.3 + uSeed;
  vec3 w = vec3(
    snoise(q * 0.8 + vec3(11.3, 0.0, 0.0)),
    snoise(q * 0.8 + vec3(-7.1, 3.3, 5.9)),
    snoise(q * 0.8 + vec3(2.7, -9.4, 1.3))
  );
  q += w * 0.45;
  vec3 x = q * 1.4;
  float a = 0.5;
  float s = 0.0;
  low = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * snoise(x);
    if (i == 2) low = s;
    x = x * 2.03 + vec3(1.7, 9.2, 3.4);
    a *= 0.5;
  }
  return s;
}

float cloudBase(vec3 cp) {
  vec3 cq = cp * vec3(2.2, 3.3, 2.2) + uSeed.zxy * 1.7;
  vec3 cw = vec3(snoise(cq * 0.45), snoise(cq * 0.45 + vec3(19.1, 0.0, 4.2)), 0.0);
  return fbm(cq + cw * 0.95, 3);
}
`

export const SURFACE_BAKE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// rgba = (terrain base, terrain low, ridge noise, cloud base), all * 0.5 + 0.5
export const SURFACE_BAKE_FRAG = /* glsl */ `
uniform vec3 uSeed;
varying vec3 vDir;
${NOISE}
${FBM}
${SURFACE_FUNCS}
void main() {
  vec3 p = normalize(vDir);
  float low;
  float h = terrainBase(p, low);
  float n8 = snoise(p * 8.0 + uSeed.zxy);
  float cb = cloudBase(p);
  gl_FragColor = clamp(vec4(h, low, n8, cb) * 0.5 + 0.5, 0.0, 1.0);
}
`

export const BODY_VERT = /* glsl */ `
varying vec3 vObj;
void main() {
  vObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const BODY_FRAG = /* glsl */ `
${PLANET_COMMON}
uniform vec3 uSeed;
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uOcean;       // terrain threshold for sea level
uniform float uPopT;        // population threshold
uniform float uClouds;      // coverage 0..1
uniform float uCloudRot;
uniform float uLights;      // city light intensity (0 = off)
uniform float uRelief;
uniform float uIce;
#if BAKED
uniform samplerCube uSurf;
#endif
varying vec3 vObj;

${NOISE}
${FBM}
${HASH}
${SURFACE_FUNCS}

const vec3 OCT_STEP = vec3(1.7, 9.2, 3.4);

// fine terrain octaves 4..TERRAIN_OCT-1, evaluated live. Octaves finer than
// ~half a pixel are dropped (they'd only alias) — px is the pixel footprint
// on the unit sphere.
float terrainDetail(vec3 p, float px) {
  vec3 x = (p * 1.3 + uSeed) * 1.4;
  float a = 0.5;
  float f = 1.82;
  float s = 0.0;
  for (int i = 0; i < TERRAIN_OCT; i++) {
    if (i >= 4) {
      float lod = 1.0 - smoothstep(0.3, 0.6, px * f);
      if (lod <= 0.0) break;
      s += a * snoise(x) * lod;
    }
    x = x * 2.03 + OCT_STEP;
    a *= 0.5;
    f *= 2.03;
  }
  return s;
}

// fine cloud octaves 3..CLOUD_OCT-1 (fbm units)
float cloudDetail(vec3 x, float px) {
  float a = 0.5;
  float f = 3.3;
  float s = 0.0;
  for (int i = 0; i < CLOUD_OCT; i++) {
    if (i >= 3) {
      float lod = 1.0 - smoothstep(0.3, 0.6, px * f);
      if (lod <= 0.0) break;
      s += a * snoise(x) * lod;
    }
    x = x * 2.03 + OCT_STEP;
    a *= 0.5;
    f *= 2.03;
  }
  return s;
}

// City network: cellular points on the local tangent plane. Returns
// x = distance to the nearest node, y = distance to the segment joining the
// two nearest nodes (reads as links between cities), z = nearest node's hash.
vec3 cityNet(vec3 x, vec3 n) {
  vec3 ip = floor(x);
  vec3 fp = fract(x);
  float d1 = 64.0;
  float d2 = 64.0;
  vec3 p1 = vec3(0.0);
  vec3 p2 = vec3(0.0);
  float h1 = 0.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 o = hash33(ip + g + uSeed * 0.37);
    vec3 r = g + 0.15 + o * 0.7 - fp;
    r -= n * dot(r, n);
    float d = dot(r, r);
    if (d < d1) {
      d2 = d1; p2 = p1;
      d1 = d; p1 = r; h1 = o.x;
    } else if (d < d2) {
      d2 = d; p2 = r;
    }
  }
  vec3 ab = p2 - p1;
  float t = clamp(dot(-p1, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return vec3(sqrt(d1), length(p1 + ab * t), h1);
}

void main() {
  vec3 p = normalize(vObj);
  vec3 C = modelMatrix[3].xyz;
  float S = length(modelMatrix[0].xyz);
  float Rw = uR * S;
  vec3 N = normalize(mat3(modelMatrix) * p);
  vec3 P = C + N * Rw;
  vec3 V = normalize(cameraPosition - P);
  vec3 L = uSun;
  float ndl = dot(N, L);
  float ndv = max(dot(N, V), 0.0);
  // pixel footprint on the unit sphere (drives all detail LOD)
  float px = length(fwidth(p));

  // cloud deck coordinates (own slow drift around the axis)
  float cs = sin(uCloudRot);
  float cc = cos(uCloudRot);
  vec3 cp = vec3(cc * p.x - cs * p.z, p.y, cs * p.x + cc * p.z);

  // ---- static surface fields
#if BAKED
  vec4 sf = textureCube(uSurf, p) * 2.0 - 1.0;
  float cb = textureCube(uSurf, cp).w * 2.0 - 1.0;
#else
  vec4 sf;
  sf.x = terrainBase(p, sf.y);
  sf.z = snoise(p * 8.0 + uSeed.zxy);
  float cb = uClouds > 0.0 ? cloudBase(cp) : -1.0;
#endif
  float hLow = sf.y;

  // ---- terrain
  float h = sf.x;
  // fine octaves only where they can matter (not in the deep ocean)
  if (h > uOcean - 0.2) h += terrainDetail(p, px);
  // antialiased coastline: widen the threshold to the pixel footprint
  float hw = max(0.008, fwidth(h) * 0.9);
  float land = smoothstep(uOcean - hw, uOcean + hw, h);
  float elev = max(h - uOcean, 0.0);
  float det = 0.0;
  if (land > 0.0 && px * 34.0 < 0.6) det = snoise(p * 34.0 + uSeed.yzx) * (1.0 - smoothstep(0.3, 0.6, px * 34.0));
  float ridge = 1.0 - abs(sf.z);
  ridge *= ridge;
  float lat = abs(p.y);
  float iceArg = lat + (hLow - uOcean) * 0.12 + det * 0.006;
  float ice = 0.0;
  if (uIce > 0.0 && iceArg > 0.76) {
    float iceN = snoise(p * 7.0 + uSeed.yxz * 1.3);
    ice = uIce * smoothstep(0.8, 0.9, iceArg + iceN * 0.035);
  }

  // relief from smooth fields only (no pixel-scale blockiness); derivatives
  // taken in uniform control flow
  float landLow = smoothstep(uOcean - 0.05, uOcean + 0.12, hLow);
  float height = landLow * (max(hLow - uOcean, 0.0) * 1.4 + ridge * 0.1);
  // screen-space bump breaks down at grazing angles: fade it toward the limb
  float reliefK = uRelief * smoothstep(0.08, 0.4, ndv);
  float hgt = height * reliefK * Rw * 0.05;
  vec3 sx = dFdx(P);
  vec3 sy = dFdy(P);
  vec2 dh = vec2(dFdx(hgt), dFdy(hgt));
  vec3 Nb = N;
  if (reliefK > 0.001) {
    vec3 r1 = cross(sy, N);
    vec3 r2 = cross(N, sx);
    float dt = dot(sx, r1);
    vec3 grad = sign(dt) * (dh.x * r1 + dh.y * r2);
    Nb = normalize(abs(dt) * N - grad);
  }

  // ---- albedo
  vec3 deep = vec3(0.0011, 0.0034, 0.0052);
  vec3 shallow = vec3(0.0035, 0.0135, 0.017);
  vec3 ocean = mix(deep, shallow, smoothstep(uOcean - 0.13, uOcean, h));
  float tint = clamp(elev * 3.2 + det * 0.18 + 0.1, 0.0, 1.0);
  vec3 ground = mix(uColA, uColB, tint);
  ground *= 0.82 + 0.3 * ridge;
  ground = mix(ground, uColB * 1.7 + 0.01, ridge * smoothstep(0.12, 0.35, elev) * 0.55);
  vec3 alb = mix(ocean, ground, land);
  alb = mix(alb, vec3(0.2, 0.225, 0.24), ice);

  // ---- clouds: baked deck + live fine octaves (slowly evolving)
  float cloud = 0.0;
  float thr = 1.0 - uClouds;
  float cn0 = cb * 0.5 + 0.5;
  float cwid = max(0.0, fwidth(cn0));
  // the live octaves add at most ~0.05: skip clear sky entirely
  if (uClouds > 0.0 && cn0 > thr - 0.13 - cwid) {
    vec3 cq = cp * vec3(2.2, 3.3, 2.2) + uSeed.zxy * 1.7;
    vec3 cqt = cq + vec3(0.0, uTime * 0.004, 0.0);
    float cn = cn0 + 0.5 * cloudDetail(cqt, px);
    cloud = smoothstep(thr - 0.06 - cwid, thr + 0.34 + cwid, cn);
    cloud = cloud * cloud * (3.0 - 2.0 * cloud);
    // wispy erosion at the edges (thick cores don't need it)
    float edge = 1.0 - smoothstep(thr + 0.12, thr + 0.4, cn);
    if (edge > 0.0 && cloud > 0.0) {
      float ero = snoise(cqt * 5.5 + cb * 1.6) * 0.5 + 0.5;
      cloud *= mix(1.0, smoothstep(0.15, 0.75, ero), edge);
    }
  }

  // ---- cloud shadows: the baked deck, sampled a little toward the sun
  float cloudSh = 1.0;
#if BAKED
  if (uClouds > 0.0 && ndl > -0.05) {
    vec3 Lo = transpose(mat3(modelMatrix)) * L;           // world → object (rotation only matters)
    vec3 Lc = normalize(vec3(cc * Lo.x - cs * Lo.z, Lo.y, cs * Lo.x + cc * Lo.z));
    vec3 Lt = Lc - cp * dot(Lc, cp);                     // tangent toward the sun
    float sb = textureLod(uSurf, normalize(cp + Lt * 0.03), 1.5).w;
    float sd = smoothstep(thr - 0.02, thr + 0.3, sb);
    cloudSh = 1.0 - 0.6 * sd * (1.0 - cloud);
  }
#endif

  // ---- ring shadow on the surface
  float ringSh = 1.0;
  if (uRings > 0.5) {
    vec3 Nr = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    float dn = dot(L, Nr);
    if (abs(dn) > 1e-4) {
      float t = dot(C - P, Nr) / dn;
      if (t > 0.0) {
        float rr = length(P + L * t - C) / Rw;
        ringSh = 1.0 - 0.82 * ringDensity((rr - uRingIn) / (uRingOut - uRingIn), 0.003);
      }
    }
  }

  // ---- sunlight
  float term = smoothstep(-0.04, 0.14, ndl);
  // light skimming the terminator passes through a lot of air → tinted
  vec3 sunc = uSunColor * mix(uAtm * 0.4 + vec3(0.45), vec3(1.0), smoothstep(0.0, 0.16, ndl));
  float sunVis = term * ringSh * uSunIntensity;
  float lam = max(dot(Nb, L), 0.0);
  vec3 col = alb * sunc * lam * sunVis * cloudSh;

  // ocean glint (hot, blooms)
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float spec = pow(nh, 900.0) * 3.2 + pow(nh, 110.0) * 0.07 + pow(nh, 14.0) * 0.008;
  col += sunc * spec * (0.45 + fres) * (1.0 - land) * (1.0 - ice) * (1.0 - cloud) * sunVis * cloudSh;

  // clouds on top
  float cl = smoothstep(-0.06, 0.3, ndl) * (0.3 + 0.7 * max(ndl, 0.0));
  vec3 cloudCol = vec3(0.2, 0.215, 0.225) * sunc * cl * ringSh * uSunIntensity;
  col = mix(col, cloudCol, cloud * 0.92);

  // faint sky fill so the night side isn't a void
  col += alb * (uAtm * 0.006 + 0.0025) * (1.0 - term * 0.5);

  // ---- night side: signal-green city lights along a network
  float night = smoothstep(0.1, -0.14, ndl);
  if (uLights > 0.0 && night > 0.001 && land > 0.001) {
    float pop = snoise(p * 4.5 + uSeed.yxz) * 0.5 + 0.5;
    pop = smoothstep(uPopT, uPopT + 0.3, pop);
    float coast = 1.0 - smoothstep(0.0, 0.05, h - uOcean);
    pop = clamp(pop + coast * 0.35 * smoothstep(uPopT - 0.15, uPopT + 0.1, pop), 0.0, 1.0);
    pop *= land * (1.0 - ice);
    if (pop > 0.002) {
      // population texture: districts inside the big regions
      float dist = snoise(p * 13.0 + uSeed.xzy) * 0.5 + 0.5;
      pop *= 0.35 + 0.65 * smoothstep(0.3, 0.75, dist);
      // network: nodes (cities) + thin links between neighbouring nodes
      float fq = 30.0;
      vec3 net = cityNet(p * fq, p);
      float cpx = px * fq;                          // pixel size in cell units
      float w = max(0.022, cpx * 0.9);              // line half-width, >= ~1px
      float link = smoothstep(w, 0.0, net.y) * (0.022 / w) * (1.0 - smoothstep(0.25, 0.7, cpx));
      link *= step(0.25, net.z);                    // not every node is wired
      float nodeR = max(0.07, cpx * 1.2);
      float node = smoothstep(nodeR, 0.0, net.x) * sqrt(0.07 / nodeR) * step(0.25, net.z);
      float halo = exp(-net.x * 7.0) * 0.12 * step(0.25, net.z);
      // towns: dense small points, fade to their average below a pixel
      vec3 g = p * 260.0;
      vec3 cell = floor(g);
      vec3 fc = fract(g) - 0.5 - (hash33(cell + uSeed) - 0.5) * 0.6;
      float town = step(0.55, hash13(cell * 1.7 + uSeed)) * smoothstep(0.28, 0.0, length(fc));
      town = mix(town, 0.015, smoothstep(0.002, 0.005, px));
      town *= 0.35 + 0.65 * exp(-net.x * 3.0);       // suburbs hug the nodes
#if NET_LEVELS > 1
      // a finer level of local links around the hubs (skipped once it's
      // below a pixel, where it would fade out anyway)
      float fq2 = 92.0;
      float cpx2 = px * fq2;
      if (cpx2 < 1.0) {
        vec3 net2 = cityNet(p * fq2 + 17.0, p);
        float w2 = max(0.03, cpx2 * 0.9);
        float link2 = smoothstep(w2, 0.0, net2.y) * (0.03 / w2) * step(0.4, net2.z) * (1.0 - smoothstep(0.25, 0.7, cpx2));
        float nodeR2 = max(0.08, cpx2 * 1.2);
        float node2 = smoothstep(nodeR2, 0.0, net2.x) * (0.08 / nodeR2) * step(0.3, net2.z) * (1.0 - smoothstep(0.4, 1.0, cpx2));
        float near2 = exp(-net.x * 2.2);
        link += link2 * 0.55 * near2;
        node += node2 * 0.45 * near2;
      }
#endif
      float li = pop * (link * 0.75 + node * 2.2 + halo + town * 0.6) + pop * pop * 0.012;
      vec3 lc = mix(SIGNAL, vec3(0.7, 1.0, 0.82), smoothstep(0.55, 1.0, pop) * 0.55);
      col += lc * li * night * uLights * (1.0 - cloud * 0.8) * 1.5;
      // clouds catch the city glow from below
      col += SIGNAL * cloud * pop * night * uLights * 0.05;
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`

// ------------------------------------------------------------------ atmosphere

export const ATMO_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

export const ATMO_FRAG = /* glsl */ `
${PLANET_COMMON}
uniform float uAtmStrength;
uniform float uMie;
uniform float uFalloff;
varying vec3 vWorld;

void main() {
  vec3 C = modelMatrix[3].xyz;
  float S = length(modelMatrix[0].xyz);
  float R = uR * S;
  float Ra = uRa * S;
  float T = Ra - R;
  vec3 ro = cameraPosition - C;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 ta = raySphere(ro, rd, Ra);
  if (ta.x > ta.y || ta.y < 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tp = raySphere(ro, rd, R);
  if (tp.x < tp.y && tp.x > 0.0) t1 = min(t1, tp.x);
  if (t1 <= t0) discard;

  vec3 L = uSun;
  float ds = (t1 - t0) / float(ATMO_STEPS);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float od = 0.0;
  float sum = 0.0;
  float sumLow = 0.0;
  float sumTw = 0.0;
  for (int i = 0; i < ATMO_STEPS; i++) {
    float t = t0 + ds * (float(i) + jit);
    vec3 p = ro + rd * t;
    float r = length(p);
    float h = clamp((r - R) / T, 0.0, 1.0);
    float d = exp(-h / uFalloff) * smoothstep(1.0, 0.75, h);
    float w = d * ds / T;
    // sunlight blocked by the planet (cylindrical shadow, soft edge)
    float mu = dot(p, L);
    float perp = length(p - L * mu);
    float lit = mu > 0.0 ? 1.0 : smoothstep(R * 0.992, R + T * 0.7, perp);
    float sunH = mu / r;
    float tr = exp(-od * 0.25);
    float e = w * lit * tr;
    sum += e;
    sumLow += e * d;
    sumTw += e * (1.0 - smoothstep(-0.05, 0.3, sunH));
    od += w;
  }
  float cv = dot(rd, L);
  float ray = 0.75 * (1.0 + cv * cv);
  // two-lobe forward scattering: a tight hot core + a wide soft skirt
  float g1 = 0.9;
  float g2 = 0.6;
  float mie = 0.02 * (1.0 - g1 * g1) / (4.0 * PI * pow(1.0 + g1 * g1 - 2.0 * g1 * cv, 1.5))
            + 0.05 * (1.0 - g2 * g2) / (4.0 * PI * pow(1.0 + g2 * g2 - 2.0 * g2 * cv, 1.5));

  vec3 atm = uAtm;
  vec3 deep = atm * atm * 1.1;                        // twilight: deeper, more saturated
  vec3 bright = mix(atm, vec3(0.8, 1.0, 0.95), 0.45); // dense low layer: whiter
  // quadratic term concentrates the light on the limb; the thin face haze
  // is kept paler so the disc doesn't read as tinted glass
  vec3 haze = mix(atm, vec3(0.55, 0.8, 0.85), 0.45);
  vec3 col = haze * sum * 0.01 + atm * sum * sum * 0.13;
  col *= ray;
  col += bright * sumLow * sumLow * 0.05;
  col = mix(col, deep * (sum * 0.06 + sum * sum * 0.14), clamp(sumTw / max(sum, 1e-4), 0.0, 1.0) * 0.6);
  col *= uAtmStrength;
  col += uSunColor * mix(atm, vec3(1.0), 0.55) * sum * mie * uMie;
  float alpha = 1.0 - exp(-od * 0.3 * min(uAtmStrength, 1.5));
  gl_FragColor = vec4(col, alpha);
}
`

// ------------------------------------------------------------------ rings

export const RING_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec2 vLocal;
void main() {
  vLocal = position.xz;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

export const RING_FRAG = /* glsl */ `
${PLANET_COMMON}
uniform vec3 uRingColor;
uniform float uRingOpacity;
varying vec3 vWorld;
varying vec2 vLocal;

void main() {
  float rr = length(vLocal) / uR;
  float u = (rr - uRingIn) / (uRingOut - uRingIn);
  float fw = fwidth(u);
  float dens = ringDensity(u, fw);
  if (dens < 0.002) discard;

  vec3 C = modelMatrix[3].xyz;
  float S = length(modelMatrix[0].xyz);
  float R = uR * S;
  vec3 L = uSun;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Nr = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));

  // planet shadow
  vec3 p = vWorld - C;
  float mu = dot(p, L);
  float sh = mu > 0.0 ? 1.0 : smoothstep(R * 0.985, R * 1.02, length(p - L * mu));

  float nl = dot(Nr, L);
  float nv = dot(Nr, V);
  // lit face vs. seen from the unlit side (light diffusing through)
  float sameSide = step(0.0, nl * nv);
  float lit = abs(nl) * mix(0.45 * (1.0 - dens * 0.6), 1.0, sameSide);
  lit = 0.12 + 0.88 * lit;
  // forward scattering when looking toward the sun through the rings
  float fwd = pow(max(dot(-V, L), 0.0), 6.0) * 0.9;

  // banded colour variation
  float band = rnoise(u * 23.0 + 5.0);
  vec3 col = uRingColor * mix(0.72, 1.12, band) * mix(0.8, 1.0, smoothstep(0.2, 0.6, u));
  col *= (lit + fwd) * sh * uSunIntensity * 0.24;
  // a faint hint of the atmosphere colour near the inner edge
  col += uAtm * 0.012 * (1.0 - smoothstep(0.0, 0.25, u)) * sh;

  float a = dens * uRingOpacity;
  gl_FragColor = vec4(col * a, a);
}
`

// ------------------------------------------------------------------ network arcs

export const ARC_VERT = /* glsl */ `
attribute float aT;
attribute vec2 aArc; // seed, arc angle (radians)
uniform vec3 uSun;
varying float vT;
varying float vSeed;
varying float vLen;
varying float vNight;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 C = modelMatrix[3].xyz;
  vec3 n = normalize(w.xyz - C);
  vNight = smoothstep(0.12, -0.16, dot(n, uSun));
  // hide links seen edge-on at the limb (they'd double the horizon line)
  vNight *= smoothstep(0.08, 0.35, dot(n, normalize(cameraPosition - w.xyz)));
  vT = aT;
  vSeed = aArc.x;
  vLen = aArc.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

export const ARC_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLights;
uniform float uDay;
uniform float uPulse;
varying float vT;
varying float vSeed;
varying float vLen;
varying float vNight;
const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);
void main() {
  float vis = mix(uDay, 1.0, vNight);
  float ends = smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.95, vT);
  // data packets: constant angular speed, trail behind the head
  float speed = (0.05 + 0.06 * fract(vSeed * 3.7)) * uPulse;
  float head = fract(uTime * speed / max(vLen, 0.15) + vSeed);
  float d = vT - head;
  float span = 0.09 / max(vLen, 0.2);
  float pk = d < 0.0 ? exp(d / span) : exp(-d * 300.0);
  pk *= step(0.35, fract(vSeed * 7.3)); // not every link is busy
  float I = 0.075 * ends + pk * 2.4 * ends;
  gl_FragColor = vec4(SIGNAL * I * vis * uLights, 1.0);
}
`

export const NODE_VERT = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform vec3 uSun;
uniform float uResY;
uniform float uPx;
uniform float uNodeScale;
varying float vNight;
varying float vSeed;
varying float vHub;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 C = modelMatrix[3].xyz;
  float S = length(modelMatrix[0].xyz);
  vec3 n = normalize(w.xyz - C);
  vNight = smoothstep(0.12, -0.16, dot(n, uSun));
  vNight *= smoothstep(0.05, 0.3, dot(n, normalize(cameraPosition - w.xyz)));
  vSeed = aSeed;
  vHub = step(0.8, aSize);
  vec4 mv = viewMatrix * w;
  float px = aSize * uNodeScale * S * projectionMatrix[1][1] * uResY * 0.5 / max(-mv.z, 1e-3);
  gl_PointSize = clamp(px, 2.5 * uPx, 30.0 * uPx);
  gl_Position = projectionMatrix * mv;
}
`

export const NODE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLights;
uniform float uDay;
uniform float uPulse;
varying float vNight;
varying float vSeed;
varying float vHub;
const vec3 SIGNAL = vec3(0.0, 1.0, 0.235);
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float core = smoothstep(0.34, 0.0, r);
  float halo = exp(-r * 5.0) * 0.35;
  float ph = fract(uTime * 0.35 * uPulse + vSeed);
  float ring = vHub * smoothstep(0.1, 0.0, abs(r - mix(0.25, 0.95, ph))) * (1.0 - ph) * 0.9;
  float I = core * (1.4 + vHub * 1.2) + halo + ring;
  vec3 col = mix(SIGNAL, vec3(0.75, 1.0, 0.85), core * 0.6);
  gl_FragColor = vec4(col * I * mix(uDay, 1.0, vNight) * uLights, 1.0);
}
`
