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
