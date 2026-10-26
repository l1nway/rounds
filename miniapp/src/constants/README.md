# constants

Values read by two features. `look.js`: the HDR look's constants and the stage event names, read by `features/editor/draft.js` (the HDR slider's zones) and by the lazy preview in `features/viewer/` (`look-glsl.js`, `look.jsx`, `lift.jsx`).

A file of its own on purpose: two features read it (core, Files and structure), and the editor's entry chunk must not import anything from the preview modules, or the whole WebGL chunk would land in the entry (`features/viewer/README.md`, Look preview).

## Look mirror

`LOOK` is the frontend copy of the backend constants of the HDR look; **change it together with** the backend files it mirrors:

- `backend/rounds/look.py`: `HONEST` (zones), `GRID`, `RADIUS`, `EPS`, `SPREAD`, `FLOOR`, `CLIP` (maps), `PIVOT`, `LIFT`, `DARK`, `KNEE`, `WHITE`, `TARGET`, `SOFT`, `DETAIL` (curve), `SHOULDER`, `TAU`.
- `backend/rounds/color.py`: `GAMMA`, `HDR_PEAK`, `SDR_WHITE`, the PQ constants `M1, M2, C1, C2, C3` (`PQ`, in that order).
- `backend/rounds/media.py`: `MOBIUS` and `PROXY_PEAK`, the `tonemap=mobius:param:peak` of the HDR proxy (Proxy tonemap there).

`split(look)` is `look.split`: `[t, r]`, the honest strength (0..1 over 0..`HONEST`) and the AI repair strength (0..1 over `HONEST`..1). Every value was compared with the backend files by reading them on 2026-10-26 (`look.py` was still untracked then, written by the backend session the same day). The shaders take each value as a `#define` generated from this object, so nothing is retyped in GLSL (`features/viewer/README.md`, Look shaders).

## Stage events

`STAGE_EVENTS` names the two DOM events dispatched on `.viewer-stage` between the Lift copy and the look preview: `ask` (Lift wants the current graded frame) and `paint` (the preview answers with the source in `detail`). The contract is in `features/viewer/README.md`, Lift source.
