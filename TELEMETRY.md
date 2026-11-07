# Telemetry and compute routing

The briefing for an agent that must explain a bug, a crash or a slow run from the field, or retune where work runs. Read it first. It says where the data is, how to read it safely, what each event means, which code decides where work runs, and which number from the data moves which threshold. The details live in the folder READMEs it links; this file is the map and the method.

## Status

- Built 2026-11-07, commit `c7541cb`. Until that commit is on `origin/main` and the VM has pulled it, there is no `/data/telemetry.db` (observed 2026-11-07: the VM was at `950e6ac` with no such file). An empty answer then means "not deployed", not "no users".
- No routing code reads telemetry yet. Every threshold below is a guess or a measurement on the owner's phones, waiting for field data. Retuning one is a code change plus the owner's OK (`CLAUDE.md`, Owner decisions).

## Where it lives

- The client: `miniapp/src/services/telemetry.js` (queue, beats, black box; `miniapp/src/services/README.md`, Telemetry and the entries after it). Both the Mini App and the browser version report.
- The server: `backend/rounds/telemetry.py`, mounted only on the Oracle free server; the Worker sends `/api/telemetry` to Oracle for every caller, so it never costs Modal credits (`backend/rounds/README.md`, Telemetry).
- The data: SQLite `/data/telemetry.db` on the Oracle VM, one table `events(at, install, session, build, t, kind, data)`, kept 90 days.
  - `at`: server time in seconds.
  - `t`: the device clock in ms. Order events inside a session by `t`, never by `at`: a batch arrives seconds later.
  - `data`: JSON, read with `json_extract(data, '$.field')`.
  - `install`: a random id per device (its `localStorage`). `session`: one page load. `build`: the commit of the client.

## Access

Read-only SSH queries need no approval each time (owner 2026-11-07). Never write to the DB, restart a service or change the VM without asking. The VM has no `sqlite3` CLI; query through the system Python, opened read-only:

```sh
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 ubuntu@92.5.21.217 python3 - <<'EOF'
import sqlite3
db = sqlite3.connect('file:/data/telemetry.db?mode=ro', uri=True)
for row in db.execute("select kind, count(*) from events group by kind"): print(row)
EOF
```

On the owner's Windows machine run it from Git Bash (the Bash tool). A query that contains backticks goes into a scratchpad file passed as `python3 - < file`, not into the heredoc (`core.md`, Workflow). Copy query results into the reply or the scratchpad, never into the repo, and never paste a raw UA list into a README: it is device data.

## Privacy rules

Never stored and never to be added: the Telegram user id, the IP, the job id, file names, frames, selections (`backend/rounds/README.md`, Telemetry privacy). A job id would link a device to a person through the jobs table. So there is no join from telemetry to a job: a bug report from the owner is matched by time, platform and build, not by id.

## Events

The client is the source of truth for the shapes (`grep -rn "report('" miniapp/src`).

| Kind | When | What `data` holds |
|---|---|---|
| `open` | every page load | `app`: `miniapp` or `web` |
| `previous` | page load after a page that sent events | the last 40 events of that page (black box), with its session and build |
| `device` | 3 s after load | platform, Telegram version, UA, cores, `memory` (Chromium only), screen and DPR, touch, isolation, `gpu` (adapter, limits, features), `bench` (`first`, `matmul`, `gflops`), `cached` |
| `conditions` | 3 s after load | `fps` (rAF rate), `spin`, `best`, `ratio`, `hidden`, `load` |
| `device.fail` | the sampler threw | the error |
| `model.load` | a model group loads | `group`, `names`, `asked` (WebGPU wanted), `gpu` (obtained), `reason` (why refused), `cache` |
| `model.calls` | 2 s after the last model call | per `group.type.backend` key: `n`, total `ms`, `max`, `first`, and `error` on `.failed` keys |
| `model.fail` | the model worker died | `message`, `touched` |
| `crash` | load after a page that died during model work | `backend` (`gpu` or `wasm`), `load` at that moment, `app` |
| `beat` | every 3 s while work runs, 4 s after | `work`: the open labels |
| `error`, `rejection` | uncaught | message, stack, `at` |
| `hidden`, `visible`, `pagehide` | page lifecycle | nothing |

## Reading it: recipes

- **One device over time:** `where install = ? order by at, t`. Its `device` rows show what it is, its `conditions` rows how it felt each open.
- **A death during work:** a session whose last event is a `beat`, with no `hidden` or `pagehide` after it. Confirm with the next session's `previous` (same install) ending the same way, and its `crash` event.
- **Which phone class dies where:** group `crash` by the install's `device` signature (`$.gpu.adapter`, `$.gpu.limits.maxBufferSize`, `$.bench.gflops`, `$.screen`) and by `load`. Only `load = 'normal'` crashes count against a device class (owner: never flag a class from one hot, cold or low-charge phone).
- **Speed of a stage on a class:** `model.calls` keys, for example `light.step.wasm` (VitTrack) or `lift.segment.gpu`, `ms / n` and `max`, split by the same signature and by `conditions.load`.
- **Is a slow run the device or its state:** compare the session's `conditions.ratio` and `fps`. A ratio near 2 is a capped CPU (heat, cold, low charge); `fps` near 30 is Low Power Mode (`web-platforms.md`, Video, WebCodecs and WebGPU on iOS).

## Traps when reading

- A page measured while hidden (`conditions.hidden`) has throttled timers: ignore its numbers.
- iOS stops timers in the background. Beats that stop after a `hidden` are a swipe away, not a death.
- Unknown whether Telegram fires `pagehide` when the Mini App is closed: until it is seen in the data, a closed app can look like a death. Check the next session's `previous`.
- WebContent killed by Jetsam leaves no event of its own; only the black box and the stopped beats show it. The GPU-process kill (about 300 MB on iPhones) looks different: `device-lost` reason `destroyed`, a blank frame, a 0 × 0 `<video>`, and the page lives on (`BUGS.md`, iPhone reload on tracking).
- Safari reports every iPhone as `architecture: 'apple'`, a frozen UA and no memory. Tell iPhones apart by `gpu.limits` (they follow the iOS version), `bench.gflops`, `screen` and `cores`, never by the UA.
- The `device` signature is cached per build and Telegram version: `cached: true` repeats an older measurement.
- The SE2 is an outlier in WebGPU memory, not a typical phone: its deaths in SAM 2.1 tracking were never explained (`BUGS.md`, iPhone reload on tracking).

## How work is routed today

The owner's order for every stage that can run in several places: WebGPU on the device, Oracle CPU, the device CPU, Modal last; Modal only when nothing else can run the stage or it is faster by minutes, not by about 30 s (`CLAUDE.md`, Owner decisions, Routing priority).

| Decision | Code | What decides it | Doc |
|---|---|---|---|
| WebGPU or WASM for the device models this open | `deviceOf()` in `miniapp/src/features/local/models.js` | `conditions().load` on touch devices: `weak` at `ratio` > 1.5 or `fps` < 50, `bad` at `ratio` > 2.5; plus the per-video crash flag | `miniapp/src/features/local/README.md`, Device load, Crash route |
| SAM 2.1 or VitTrack on the device | `fast()` in `models.js` | the fastest WebGPU lift ≤ `FAST_LIFT` 800 ms | same README, Speed gate |
| Device lift and follow, or the server | `attachLocal` in `local/attach.js` | `localOff()` (a WASM crash in normal conditions), the tier, the speed gate on `pro` | same README, Local attach |
| Device render or server render | `needsServer`, `routeOf` in `local/plan.js` | options, codec, HDR source, `STAGES` | same README, Local plan, Stage routing |
| Track sent with Render | `sendRender` in `miniapp/src/features/job/use-job.js` | at most 60 s of VitTrack after Render | `miniapp/src/features/job/README.md`, Miniapp track |
| What the server tracks | `devicetrack.hit` in `backend/rounds/devicetrack.py` | the device's span; VitTrack for the rest, the whole range without a usable track | `backend/rounds/README.md`, Device track |
| Modal or Oracle | the Worker, `router/worker.js` | `ALLOWED_USER_IDS` | `router/README.md` |

## Which number tunes which threshold

- `LOAD` in `local/device.js` (`weak` 1.5, `bad` 2.5, `fps` 50): from `crash` with `load` against `conditions.ratio` of the crashed sessions. Raise a threshold if normal-ratio sessions crash as often as weak ones; lower it if crashes cluster just under it.
- `FAST_LIFT` in `models.js`: from `model.calls` `lift.segment.gpu` (`ms / n`) per class against `track.step.gpu` on the same class.
- The per-video crash flag and the planned class-wide flags: from `crash` per class with `load = 'normal'` across installs. Class-wide flags are not built: they need a server-side count and a client read (`miniapp/src/features/local/README.md`, Crash route).
- The device / Oracle / Modal time model ("clearly faster"): from `model.calls` on devices plus the Oracle render log times; not coded yet (Stage routing).
- `WAIT` 60 s in `use-job.js`: from how much of a range phones track in a minute (`light.step` time × steps).

## Describing a bug for the next agent

When a field bug is found, record it in `BUGS.md` (or the folder README once explained) with:
- what the user saw, the platform, the Telegram version and the build;
- the time window, and the `install` and `session` ids if found (they are random ids, safe to write down);
- the event sequence that shows it (kinds and `t`, trimmed), and whether `conditions.load` was `normal`;
- what is observed and what is reasoned, and what would close it (`core.md`, Communication).

Phone-side evidence that telemetry cannot give (a JetsamEvent file, a screen recording) is asked from the owner: `web-platforms.md`, Verification limits, Phone crash forensics.
