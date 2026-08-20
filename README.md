# PolyTrack TAS

A lightweight userscript that adds tool-assisted-speedrun-style timing controls to [PolyTrack](https://www.kodub.com/apps/polytrack), including slow motion, pause, and frame stepping.

> [!IMPORTANT]
> This is an unofficial community project and is not affiliated with or endorsed by Kodub or PolyTrack.

## Features

- Slow down PolyTrack's virtual clock for more precise inputs.
- Pause and resume simulation timing.
- Step the simulation forward in small increments while paused.
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

Because PolyTrack can change over time, game updates may occasionally break worker detection or timing hooks. If that happens, please open a bug report with your browser, userscript manager, and reproduction steps.

## How it works

PolyTrack TAS patches the page's timing primitives and intercepts creation of the simulation worker. It maintains a virtual clock whose rate can be changed independently of real time and injects matching clock controls into the simulation worker. This keeps page-side animation timestamps and worker-side simulation timing aligned.

The implementation intentionally avoids modifying PolyTrack's source files or requiring a custom game build.

## Compatibility

The userscript currently targets:

- `https://app-polytrack.kodub.com/*`
- Browsers with standard Web Worker, Blob URL, and userscript support

Compatibility is best-effort. Browser and PolyTrack updates can affect behavior.

## Development

This repository intentionally stays small: the distributable userscript is [`TAS.js`](./TAS.js). When making changes:

1. Keep the userscript metadata header valid.
2. Preserve normal-speed behavior at `1x`.
3. Test pause, resume, speed changes, and frame stepping.
4. Confirm the simulation worker is detected and the game still loads normally.
5. Run the repository checks before submitting a pull request.

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
