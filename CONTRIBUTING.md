# Contributing

Use Node.js 22/24 and pnpm 11.9.0. Install with `pnpm install --frozen-lockfile`, then run `pnpm typecheck`, `pnpm test`, and `pnpm demo`.

Work in the root `src/` project; `archive/` is historical reference material. Add regression cases for meaningful workflow changes. Tests and demos use fictional data and must not depend on personal credentials.

The public README, capability inventory, setup guides, and figures are English. Runtime strings and original review checklists remain in their deployment language. Do not describe English documentation mockups as English runtime support.

Regenerate documentation evidence with `pnpm demo` and figures with `python scripts/render-scenes.py` (Python, Pillow, and an English UI font required). The renderer reads `docs/demo/portfolio.json`, an English documentation view over the offline scenarios. Retain simulation labels and all important behavioral boundaries.

Do not add unsupported business-impact metrics, live-integration claims, or role capabilities. Keep changes to reference criteria distinct from changes to presentation.
