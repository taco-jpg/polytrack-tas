# Contributing to PolyTrack TAS

Thanks for helping improve PolyTrack TAS.

## Before you start

For substantial behavioral changes, consider opening an issue first so the intended behavior can be discussed before implementation.

## Development workflow

1. Fork or branch from the latest `main`.
2. Make a focused change.
3. Test the userscript against the current PolyTrack web app.
4. Run the repository checks.
5. Open a pull request describing what changed and how it was tested.

## Testing checklist

Before submitting a behavioral change, verify that:

- PolyTrack loads normally with the userscript enabled.
- `1x` speed behaves like normal gameplay.
- Slow-motion speed changes take effect without obvious clock jumps.
- Pause and resume work repeatedly.
- Frame stepping works while paused.
- The TAS panel can be shown and hidden.
- The simulation worker is detected where expected.
- The browser console has no new unexpected errors.

## Code style

- Keep the project dependency-free unless a dependency provides a clear maintenance benefit.
- Prefer small, readable functions and descriptive names.
- Avoid unrelated formatting or refactoring in focused bug-fix pull requests.
- Preserve comments that explain timing, worker, or browser-compatibility behavior.
- Update the userscript version when publishing a user-facing release.

## Pull requests

A good pull request should explain the problem, the approach taken, user-visible changes, and how the change was tested. Screenshots are welcome for UI changes.

By contributing, you agree that your contribution may be distributed under the repository's license.
