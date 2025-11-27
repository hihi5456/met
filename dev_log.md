# Dev Log

## Current Status
- Build-free browser metronome using WebRTC (PeerJS) with audio-clock scheduling.
- Leader sends future bar-aligned start times; followers schedule via AudioContext with offset.
- Auto-calibration runs on leader assignment and after tempo/time-signature changes; manual calibrate remains.
- Visuals are driven from the audio clock to stay aligned with clicks.

## Known Issues / Risks
- PeerJS cloud signaling jitter: offsets can vary; ensemble-tight sync is hard without a LAN time anchor.
- Tempo/time-signature changes still require re-calibration; drift can appear at non-100 BPM.
- No dedicated time anchor; leader clock is the anchor, so path jitter affects offset accuracy.

## Next Options
- Add a tiny LAN `/now` endpoint to use as a time anchor (best for sync on same Wi‑Fi).
- Increase lead-in and sample count during calibration; enforce future start-at-bar after every change.
- Optionally swap to Tone.js Transport for simpler scheduling (still needs a reliable clock source).

## Recent Changes
- Auto-calibration added after BPM/TS changes and on leader assignment.
- Beat/bar durations recomputed on BPM/TS change; start snaps to next bar using current values.
- Audio-clock–based offset and scheduling; visuals driven via `requestAnimationFrame` on the audio clock.
