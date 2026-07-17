# Contributing

Thank you for helping improve Unfinished Business.

## Before opening a change

1. Search existing issues and pull requests.
2. Open an issue first for behavior changes, new integrations, or changes to the queue's durability and authorization rules.
3. Keep pull requests focused and explain the user-visible outcome, risk, and verification.

Never include real task stores, access tokens, authentication files, personal contact information, private project paths, or screenshots containing proprietary work. Use synthetic fixtures.

## Local checks

Use Node.js 22 or newer:

```powershell
npm test
npm run check
```

The production runtime intentionally has no npm dependencies and no frontend build step. Prefer Node's built-in APIs for runtime and tests. Media tooling is isolated in `requirements-media.txt` and is not installed by the app.

When changing the README animation:

```powershell
python -m pip install -r requirements-media.txt
python scripts/render_readme_animation.py
npm run check
```

Commit the renderer and the regenerated assets together. Animation must remain understandable in its static poster frame and when motion is disabled.

## Pull request checklist

- Tests cover the changed contract.
- `npm test` and `npm run check` pass.
- New files contain no secrets, personal information, absolute home paths, or real runtime data.
- UI changes are keyboard-usable and respect `prefers-reduced-motion`.
- Documentation describes migration or compatibility impact.
- The change does not add telemetry, a CDN dependency, or a network listener beyond loopback without explicit project discussion.

All contributions are licensed under the repository's MIT License.
