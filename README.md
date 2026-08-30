# PolyTrack TAS

A lightweight userscript that adds tool-assisted-speedrun-style controls to [PolyTrack](https://www.kodub.com/apps/polytrack), including slow motion, pause, frame stepping, deterministic checkpoints, and replay branching.

> [!IMPORTANT]
> This is an unofficial community project and is not affiliated with or endorsed by Kodub or PolyTrack.

## Features

- Slow down PolyTrack's virtual clock for more precise inputs.
- Pause and resume simulation timing.
- Step the simulation forward in small increments while paused.
- Create a TAS checkpoint and deterministically restore the car to that exact simulation frame.
- Capture a leaderboard/ghost replay that PolyTrack has already loaded and branch from it at a checkpoint.
- Preserve per-car frame positions when rewinding so loaded ghosts stay synchronized.
- Synchronize `performance.now()` and `requestAnimationFrame()` timestamps.
- Detect and patch PolyTrack's simulation worker.
- Keep TAS control messages isolated from the game's own worker messages.
- Run entirely as a local userscript with no server component.

## Installation

1. Install a userscript manager such as Tampermonkey, Violentmonkey, or another compatible extension.
2. Open [`TAS.js`](./TAS.js) in this repository and copy its contents into a new userscript.
3. Save the userscript and make sure it is enabled.
4. Open PolyTrack at `https://app-polytrack.kodub.com/`.
5. Press **P** to show or hide the TAS controls.

## Usage

The controller is designed for precise practice and TAS-style experimentation. Use the on-page control panel to change simulation speed, pause execution, and advance the virtual clock while paused.

### Checkpoints

Start a run, open the TAS panel, and select **Set checkpoint**. The userscript records the exact physics-worker frame plus the live input history. Select **Restore checkpoint** to rebuild the car from its original creation message and deterministically replay those inputs back to the saved frame. Restores intentionally leave the TAS paused so you can inspect the state or frame-step before continuing.

The checkpoint is a deterministic replay checkpoint rather than a raw WebAssembly memory snapshot. That keeps the implementation independent of PolyTrack's internal physics heap layout.

### Branching a loaded leaderboard replay

Open/watch a leaderboard record or ghost normally in PolyTrack so the game loads its recording. The TAS panel will show that a replay is available.

1. Select **Copy loaded replay**.
2. Create or restore the checkpoint where you want to branch.
3. Select **Branch at checkpoint**.
4. Resume and drive from that frame with your own inputs.

The replay is captured from PolyTrack's existing worker message; the userscript does not automate leaderboard APIs. Branching is intended for local TAS analysis and optimization. It does not add any mechanism for submitting modified runs to official leaderboards.

Because PolyTrack can change over time, game updates may occasionally break worker detection or the checkpoint protocol. When the internal worker signature is unknown, checkpoint features fail closed while the timing controls continue to load. If that happens, please open a bug report with your browser, userscript manager, and reproduction steps.

## How it works

PolyTrack TAS patches the page's timing primitives and intercepts creation of the simulation worker. It maintains a virtual clock whose rate can be changed independently of real time and injects matching clock controls into the simulation worker. This keeps page-side animation timestamps and worker-side simulation timing aligned.

For checkpoints, the userscript records the simulation worker's exact control-frame assignments. Restore recreates the active cars from their original `CreateCar` messages and fast-forwards the physics simulation with the saved controls to each car's saved frame. Loaded replay recordings can be used as a base input stream up to a checkpoint, after which live controls form a new branch.

The implementation intentionally avoids modifying PolyTrack's source files or requiring a custom game build.

## Compatibility

The userscript currently targets:

- `https://app-polytrack.kodub.com/*`
- PolyTrack 0.6.2's current simulation-worker protocol for checkpoint/replay features
- Browsers with standard Web Worker, Blob URL, synchronous worker XHR, and userscript support

Compatibility is best-effort. Browser and PolyTrack updates can affect behavior. If the checkpoint injection signature no longer matches, the userscript reports that the checkpoint hook is unavailable instead of applying an unsafe patch.

## Development

This repository intentionally stays small: the distributable userscript is [`TAS.js`](./TAS.js). When making changes:

1. Keep the userscript metadata header valid.
2. Preserve normal-speed behavior at `1x`.
3. Test pause, resume, speed changes, and frame stepping.
4. Test checkpoint save/restore and replay branching when changing worker code.
5. Confirm the simulation worker is detected and the game still loads normally.
6. Run the repository checks before submitting a pull request.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## Reporting bugs

Please use the bug-report issue template and include:

- Browser and version
- Userscript manager and version
- PolyTrack URL/version if known
- Steps to reproduce
- Console errors, if any

## Security

If you discover a security-sensitive problem, please follow [SECURITY.md](./SECURITY.md) rather than publishing exploit details in a public issue.

## License

Licensed under the terms in [LICENSE](./LICENSE).
