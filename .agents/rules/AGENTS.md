# bhaJami Workspace Rules

## 1. Visual & Devotional Aesthetic
Both themes MUST preserve an authentic Sathya Sai devotional vibe:
- **Prasanthi Dawn (Light):** Warm ivory & sandalwood paper (`#FDF8F0`, card `#FFFDF9`), saffron (`#C84B0F`), vermilion (`#B71C1C`), antique temple gold (`#B8860B`), deep sandal ink (`#241710`).
- **Mandir Sandhya (Dark):** Deep bronze-obsidian (`#14100E`, card `#1F1815`), warm diya amber (`#FFB300`), soft gold (`#FFD54F`), parchment ink (`#F6EDE2`) — comfortable in dim bhajan halls & Akhanda sessions.

## 2. Pitch & Musical Data Standard
- Always display pitches in **dual Pancham (`1–7`, including half-steps like `1.5`, `4.5`, `6.5`) AND Western (`C–B`) notation** (e.g., `2 Pancham / D`, `6 Pancham / A`).
- Respect Gents (`2 Pancham / D`) and Ladies (`6 Pancham / A`) reference defaults cleanly.

## 3. Data Provenance & Scraping Etiquette
- All curated lyrics/notation/glossary sourced from `sairhythms.sathyasai.org` MUST retain explicit SSSIO source attribution (`sourceUrl`).
- Polite rate limiting (`>= 1.0s` delay per uncached GET request) is mandatory. Never call or spoof `/song/signup/api`.

## 4. Firebase & Security Rules
- Active Firebase / GCP project: `saibhajanverse` (owner: `pschax@gmail.com`).
- Always delegate `firestore.rules` edits to the `firestore-rules-author` subagent.
- Always run `npx -y firebase-tools@latest ...` from the workspace root (never `/`).

## 5. Modern Web Guidance Baseline
- Use `<meta name="color-scheme" content="light dark">` + synchronous inline FOUC script and `light-dark()` with `@media (prefers-color-scheme: dark)` fallback.
- Use native `<dialog closedby="any">` with `showModal()`, `overscroll-behavior: contain` on `dialog:modal` and `dialog::backdrop`, `returnValue = ''` reset, and pointer coordinate fallback.
- Use `:is(:user-invalid, .user-invalid-fallback)` and `data-error` → `aria-describedby` syncing for form validation.
- Use `focusgroup="tablist nomemory"` + `aria-selected` border-bottom shape indicator + `hidden="until-found"` with inner panel wrappers for tabs.
- Use `container-type: inline-size` with sticky headers and stacked `@container (width < 600px)` card layout for data tables.
