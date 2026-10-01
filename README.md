# game-3d starter (three.js + Rapier)

A complete, small 3D game — **Sky Cores**: run, jump and dash across floating islands to collect
every energy core before the clock runs out, avoiding patrol drones. It exists to be *changed*:
the engine layer is fixed scaffolding, the game layer is the part you rewrite.

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # typecheck + production build + bundle budget
pnpm test     # unit tests (rules, save, i18n, level)
pnpm smoke    # after build: headless browser playthrough + screenshots in shots/
```

## Layout

| Path | Role | Change it? |
| --- | --- | --- |
| `src/engine/loop.ts` | Fixed 60 Hz simulation + interpolated rendering | Rarely |
| `src/engine/input.ts` | Keyboard/mouse, gamepad, touch → one action state | Add actions here |
| `src/engine/physics.ts` | Rapier world, collider helpers, render interpolation | Rarely |
| `src/engine/renderer.ts` | WebGL renderer, quality presets, bloom | Rarely |
| `src/engine/audio.ts` | Music/SFX buses, synthesized SFX, `load()` for files | Add sounds |
| `src/engine/save.ts` | Versioned localStorage save + leaderboard | Add fields + parsing |
| `src/engine/i18n.ts` | en / zh-CN, browser detection, saved choice wins | Rarely |
| `src/engine/assets.ts` | Cached GLTF/texture loading with progress | Use it for models |
| `src/game/config.ts` | **All tuning numbers** | Yes |
| `src/game/rules.ts` | Pure score/lives/clock/win rules (unit tested) | Yes |
| `src/game/world.ts` | Level layout, sky, lights, islands, stones, lifts | Yes |
| `src/game/player.ts` | Character controller + game feel + procedural model | Yes |
| `src/game/*.ts` | Camera, cores, drones, particles, scene orchestration | Yes |
| `src/ui/`, `src/styles/main.css` | HTML/CSS title, HUD, pause, settings, results | Yes |
| `src/i18n/*.json` | All player-facing text (both files, same keys) | Yes |

## Rules for changes

- **Simulation in `step()`, visuals in `render()`/`animate()`.** Gameplay state only changes in
  fixed steps; read presses there with `input.consume(action)`, never `pressed()`.
- **Rules stay pure.** Scoring, win/lose and progression go in `rules.ts` with tests; scene code
  reports events and reads state.
- **Every visible string is an i18n key** in both `en.json` and `zh-CN.json` (a test enforces
  matching keys and placeholders). Chinese glyphs come from the subset font in `public/fonts/`;
  if you add new Chinese text, check it renders (missing glyphs fall back to system fonts).
- **UI is HTML/CSS**, not canvas. Keep the game look: display font, outlined text, hard offset
  shadows, skewed buttons, notched panels. Menus must stay keyboard/gamepad navigable
  (`data-nav` on focusable controls).
- **Colliders come from the helpers** in `physics.ts` with the same sizes as the meshes.
- Keep `npm run build` within budget (`scripts/check-size.mjs`) and `npm run smoke` green.

## Controls

Keyboard/mouse: WASD move, mouse look (click to capture), Space jump (hold = higher), Shift
sprint, F or left click dash, Esc pause. Gamepad: left stick, right stick, A jump, X/RB dash,
LB sprint, Start pause. Touch: left-side stick, right-side drag to look, JUMP / DASH buttons.

## Credits

Fonts: Sora, Figtree, Noto Sans SC — SIL Open Font License 1.1 (see `public/fonts/*-OFL.txt`).
Libraries: three.js (MIT), Rapier (Apache-2.0).
