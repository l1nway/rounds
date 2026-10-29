# Open bugs and questions

Known bugs and open questions that are not being worked on right now. Each entry: what is seen or missing, what is known, where the details live, and what closes it. A closed entry is removed; its outcome goes to the folder README it belongs to.

## Note start cut off

- Seen (owner, 2026-10-27): job `8K9cD2dNs7` (4K HEVC 60 fps, follow + loudness, sent by `sendVideoNote`) arrived as a round, but its beginning felt cut off. Cause not investigated.
- Next: the owner retests by hand. Then compare the requested trim start in the job's `request` with the render log line `clip=`, the first frame of `note.mp4` and the audio start (loudness levelling can fade in).

## Rolling shutter

- Open (owner, 2026-10-28): the owner sees no rolling-shutter wobble ("jello") in their clips, so no correction is planned for now.
- Known: on the 384² test clip there was no usable rolling-shutter signature (measurements and the plan in `backend/rounds/README.md`, Stabilization: homography mixtures in `motion.params` first, MeshFlow only if they fail).
- Closes when: a high-resolution phone clip with visible wobble shows up; then check the correlations described there.

## Tracking on the free tier

- Missing: users without Modal (the Oracle free tier, CPU only) get no object tracking. Their crop is the centre or a fixed crop centred on the selection, so the circle does not follow a moving object.
- Known: candidates for a free CPU tracker are listed in `backend/rounds/README.md`, Tiers (OpenCV CSRT / KCF, YOLO nano + ByteTrack, MobileSAM / NanoSAM in ONNX, MediaPipe, motion centroid). None is measured on the Oracle VM yet.
- Closes when: a tracker is picked by a speed and quality test on the VM and the camera path (`camera.solve`, CPU already) consumes its track.

## Stabilization and deblur on the free tier

- Open: the stabilization work (2026-10-28) targets Modal. The motion analysis, the camera path and our own edge fill run on CPU, and the problem-frame detection for heavy deblur is planned as light CPU analysis (owner OK). ProPainter and DSTNet+ need a GPU.
- To decide (owner): whether the free tier offers stabilization with our edge fill only and classical deblur only, and whether the Oracle VM is fast enough for that (not measured).

## Browser version: unverified paths

- Open (2026-10-28, the editor in the browser): only the local render was run end to end (headless Edge, software AV1, hardware hint stripped). Not run: the sign-in in an iframe against the real Telegram, a local render on a real browser with its own encoders (software AV1 speed, Firefox's codecs), the server path (upload, ingest, render from the browser), sending a local round to the chat (`POST /api/notes`) and the Mini App on a device after the editor moved into a shared chunk.
- Known: details and what each depends on are in `miniapp/src/features/account/README.md` (Frame login: Telegram may refuse framing, then the sign-in goes back to a redirect), `features/local/README.md` (Local encoders, Local size, Local server) and `features/web/README.md` (Web shell: signing in resets the draft).
- Also unverified (2026-10-28): the pro promote (background upload to Modal, job swap with the draft kept), the Oracle-first render for an allowed user (`?via=oracle` in the router, a second upload), HDR detection (`hasHighDynamicRange()` on a real iPhone HLG clip) and the Retry buttons. Nothing of this ran against a real server; the router change is not deployed (paste `router/worker.js` in the dashboard).
- Also open: the Oracle VM's `.env` must carry the same `ALLOWED_USER_IDS` as Modal's, or an allowed user signs in as `free`; an older stored session has no tier (reads `free`) until the user signs in again.
- Closes when: the owner opens the deployed page, signs in (anonymous, a normal user and an allowed one), renders a round locally with a GPU encoder, one through the server path, and sends one to the chat.
