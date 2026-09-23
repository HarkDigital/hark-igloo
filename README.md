# Hark Orbit — concept site

A scroll-driven WebGL experience for Hark Digital Design, inspired by
[igloo.inc](https://www.igloo.inc). Instead of an igloo in the snow, the Hark
mark is built, polished and flown through space. It's an exploration of a new
direction and sits alongside the 2026 site build
([harkdigital.github.io/hark-digital-2026](https://harkdigital.github.io/hark-digital-2026/)).

**Live:** https://harkdigital.github.io/hark-igloo/

Copy, services, portfolio and testimonials come from the 2026 site
(`Clients/Hark Digital 2026 Website/site-v2/src/data`) and live in
`src/content.ts`.

## The story

| # | Chapter | What happens |
|---|---------|--------------|
| 01 | **Signal** (`hero`) | The mark as a hologram above a planet horizon → orbiting debris bricks assemble it → it resolves into polished obsidian with a glowing diamond → *Make the internet listen.* |
| 02 | **Artifacts** (`work`) | *Built to be heard.* Six featured projects sealed in glass crystals, then a ring of the nine more |
| 03 | **Orbit** (`services`) | *Eleven ways to be heard.* Emerge from the core into an orrery: 11 service worlds, each focused in turn |
| 04 | **Shield** (`shield`) | Attacks strike a planetary hex shield → *Hacked? Breathe.* → 24/7 calm |
| 05 | **Transmissions** (`voices`) | *We listen. They talk.* Client testimonials decoded from a pulsar signal |
| 06 | **Gate** (`portal`) | *How we work:* the ring gate's four keystones lock as Listen · Prototype · Build · Support, with the real stats, then warp |
| 07 | **Arrival** (`contact`) | The mark as a particle cloud over a holographic platform — *Say hello.* |

Phones held sideways get a "turn your phone upright" screen. Screen readers and
keyboard users get the whole story as linear semantic HTML (`src/core/srContent.ts`),
and the visuals follow keyboard focus.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + production build → dist/
```

Handy URL params: `?nointro` (skip loader), `?c=work&l=0.5` (jump to a chapter
at local progress), `?p=0.4` (global progress), `?only=hero` (load one chapter),
`?debug` (fps / draw calls / progress readout).

Screenshots at exact scroll positions (headless Chrome):

```bash
npx vite --config vite.shots.config.ts --port 5190 --strictPort   # no-HMR server
node scripts/shot.mjs --port=5190 --frames=hero:0.3,work:0.15 --out=shots [--mobile]
```

## How it's built

- **Vite + TypeScript + Three.js r186 + Lenis** (smooth scroll). No framework.
- `src/core/Engine.ts` — one fixed canvas; the page scroll only provides length.
  Each chapter gets a scroll range and local progress 0..1; only the active
  chapter renders, and cuts between chapters are hidden by a glitch / zoom-blur
  flash in post. Adaptive resolution keeps frame rate up on weaker GPUs.
- `src/core/post.ts` — HDR render → NaN guard → bloom → tone mapping → final
  pass (chromatic aberration, grain, vignette, cut transition).
- `src/chapters/<id>/` — each chapter is self-contained: 3D scene + its own HUD
  copy in a fixed overlay (`stage`) + scoped CSS.
- `src/world/` — the shared space backdrop (nebula, stars, warp streaks) and a
  procedural planet (baked terrain cube maps, city-light network, atmosphere).
- `src/logo/logo.ts` — the Hark mark as geometry (extrusion, point sampling,
  outlines) straight from the original SVG.
- `src/ui/` — HUD chrome (nav, sound toggle, chapter rail), loader, and a
  generative WebAudio soundtrack (off by default).
- No WebGL2? A plain HTML version of all the copy renders instead.

## Deploy

GitHub Pages via `.github/workflows/deploy.yml` (builds with
`--base=/hark-igloo/` and adds `noindex` so this concept never competes with
hark.digital in search). Run it from the Actions tab or:

```bash
gh workflow run deploy.yml --repo HarkDigital/hark-igloo --ref main
```
