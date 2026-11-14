# Meepo Console -- Agent Guidelines

Applies to `apps/meepo-console`; the repository-wide rules in the root `AGENTS.md` also apply.

- **Layout**: `meepo-console/src` is `app/` (shell, router, space context), `features/<section>/` (one folder per sidebar section), `ui/` (design-system primitives), `api/` (typed client, `endpoints.ts`, shared query cache), `lib/` (pure helpers), and `styles/` (tokens first). Add no runtime dependencies; talk to the server only through `api/endpoints.ts`; keep user-facing text in product vocabulary (Conversations, Tickets, Workers) and keep pure logic in `lib/` or colocated `*.test.ts`-covered modules.

## Visual consistency (keep the look from drifting)

The Console is a deliberately dependency-free design system. There is no Tailwind, component library, or icon package: every look comes from `styles/tokens.css` and the primitives in `ui/`. The product-level principles (quiet surfaces, one accent, state conveyed by label plus dot, designed empty/loading/error states, light and dark themes, accessibility) are owned by `specs/features/console.md` section 5; read it before adding or restyling a page.

- **Reuse before adding**: compose pages from `ui/` primitives (`Button`, `Badge`, `Field`/`Input`/`Select`/`Segmented`, `Modal`/`useConfirm`, `Popover`, `Toast`, `Icon`, `Markdown`, and the page scaffolding in `Misc.tsx`: `Page`, `PageHeader`, `EmptyState`, `ErrorState`, `ListSkeleton`). If a screen needs a pattern twice, extract a primitive into `ui/` instead of copying markup; a new primitive ships with its CSS in `styles/ui.css` and works in both themes.
- **Tokens only**: colors, radii, shadows, fonts, and the focus ring come from the CSS variables in `styles/tokens.css`. Do not write literal hex or `rgb()` values in components or feature CSS (white text on solid accent/danger fills and the brand mark gradient are the only existing literals; do not add more); if a role is missing, add a token to both the light and the `data-theme='dark'` block. Color carries state only (`ok`, `warn`, `danger`, `info`); the single accent is for primary actions and selection.
- **Style layering**: `tokens.css` → `base.css` (elements) → `ui.css` (primitives) → `shell.css` (app chrome) → `features.css` (page-specific layout). Feature CSS arranges primitives; it does not restyle them. Reuse existing list/row/card classes (`card`, `admin-list`, `admin-row`, `view`) before inventing parallel ones.
- **Language and tone**: sentence-case labels in product vocabulary, plain language first, raw ids only as secondary copyable text. A page without a designed empty, loading (skeleton), and error state is unfinished.
- **Never introduce** a runtime dependency, a CSS framework, an icon font or SVG package, a second theme mechanism, or emoji used as icons. Add icons to `ui/Icon.tsx`.
- **Verify visually**: after UI changes, run the console in both themes at a narrow and a wide viewport and check keyboard focus, `Escape` on dialogs, and `prefers-reduced-motion`; there is no component test suite, so the primitives and tokens are the safety net.
