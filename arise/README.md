# ARISE

A scroll-driven page. It opens quiet and dim, escalates through a canvas frame
sequence that scrubs with the scrollbar, and ends by handing one person an
S-rank hunter licence with their own name on it.

Standalone static site. Nothing to do with the Interchange CLI in the parent
directory — it just lives here.

```
node arise/build.mjs      # → arise/index.html, open it with file://
```

`wireframe.body.html` is the source of truth. `index.html` is generated; don't
edit it by hand.

## How the scroll-video actually works

The famous scroll sites — AirPods Pro, the Rolls-Royce configurator, every
"video scrubs as you scroll" page — are **not** driving a `<video>` element.
Setting `video.currentTime` on scroll stutters, because the browser has to seek
to a keyframe and decode forward; on iOS Safari it barely works at all. Making
it smooth means encoding every frame as a keyframe, which multiplies the file
size by roughly ten.

What they actually do is a **canvas image sequence**:

1. Export the shot as numbered JPEGs — `f_000.jpg` … `f_179.jpg`.
2. Preload them all into `Image` objects before the section is reachable.
3. Pin the section: a tall spacer (`height: 480vh`) with a
   `position: sticky; top: 0; height: 100vh` child inside it.
4. Map scroll position within the spacer to `0 → 1`, multiply by the frame
   count, and `drawImage` that frame.

```js
const i = Math.round(progress * (FRAMES - 1));
if (i !== last) { ctx.drawImage(images[i], 0, 0, w, h); last = i; }
```

That's the whole trick. Redraw only when the index changes, and do it inside
`requestAnimationFrame`, never directly in the scroll handler.

**Budget.** 180 frames at 1600px wide, quality 6, is about 90 KB each — ~16 MB
total. That's a lot for one page, so: preload the first 30 frames eagerly, the
rest in the background while the earlier scenes play; serve WebP with a JPEG
fallback (cuts it to ~9 MB); and drop to 90 frames plus a smaller width on
narrow screens.

The wireframe **draws its placeholder frames in code** — same index maths, real
quantised stepping, frame number burned into the corner — so the timing is
tunable before a single asset exists.

## Making the source frames — four routes

| Route | Cost | Wow | Notes |
| --- | --- | --- | --- |
| **A · Code-only** | free | medium-high | Aura, motes and shadow army generated in canvas/WebGL. No render pipeline, tiny payload, infinitely tweakable. This is what the wireframe does. |
| **B · Filmed + VFX** | a weekend | highest | Film him standing up, 4–6 seconds, locked-off camera, dark room, one hard light. Rotoscope in After Effects or DaVinci (free), add aura and particles. |
| **C · AI video** | ~an hour | high | One good photo → Runway / Kling / Sora → 5s clip → extract frames. Fast, some uncanny risk on faces. |
| **D · Hybrid** ← recommended | an evening | high | One real photo of him, masked out as a PNG, composited into a canvas scene where the aura, motes and shadow army are code-driven. Personal *and* tweakable, no render step. |

Route D is the recommendation: the part that has to be *him* is a photograph,
and the part that has to be *spectacular* is code you can re-tune in a second
without re-rendering anything.

### Extracting frames from a clip (routes B and C)

```sh
# 180 frames at 1600px wide
ffmpeg -i clip.mp4 -vf "fps=30,scale=1600:-1" -q:v 6 frames/f_%03d.jpg

# WebP is roughly half the size at the same quality
ffmpeg -i clip.mp4 -vf "fps=30,scale=1600:-1" -quality 78 frames/f_%03d.webp

# Cutting a photo out of its background, if you'd rather not do it by hand
rembg i him.jpg him-cutout.png
```

Keep the camera locked off and the background dark — a still background means
the frames compress far smaller, and it makes the composite forgiving.

## The ten scenes

| # | Scene | Mechanic | Length |
| --- | --- | --- | --- |
| 00 | Cold open | Fade up, deliberately low energy | 150vh |
| 01 | The system | Scroll-driven typewriter | 200vh |
| 02 | Frame scrub | Canvas image sequence — the hero | 480vh |
| 03 | Status window | Stat bars fill, hover for notes | 160vh |
| 04 | Daily quest | Real checkboxes, saved locally | 170vh |
| 05 | Gates cleared | Vertical scroll → horizontal travel | 280vh |
| 06 | Arise | Click: screen shake + shadows rise | 180vh |
| 07 | The message | All effects stop | 170vh |
| 08 | Hunter licence | 3D tilt on pointer | 180vh |
| 09 | Outro | Replay, credit, quest reset | auto |

Scene 07 is why the site exists. Everything before it is the run-up that makes
the silence land. Write that one first.

## Turning the wireframe into the real thing

1. Write scene 07.
2. Pick four photos: dim/candid (S00), portrait 3:4 (S03), the licence photo
   (S08), and the hero pose (S02).
3. Build the S02 sequence via one of the four routes above.
4. Swap the procedural `drawFrame(i)` for the decoded image array. The index
   maths does not change.
5. Fill every amber slot on the page — the wireframe counts them for you.
6. Deploy static. Any host. One URL that works on a phone.

## Accessibility and performance notes

- `prefers-reduced-motion` disables the shake and the auto-animations; the
  scroll-scrub stays, because it's driven by the user's own scrolling.
- Every quest checkbox is a real `<input>` with a label — keyboard and screen
  reader work without extra ARIA.
- `localStorage` access is wrapped in try/catch; private windows just get a
  fresh quest list.
- The canvas is sized to `devicePixelRatio` capped at 2, so it stays sharp on
  phones without quadrupling the fill cost.
