---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Discovery**: Use the `design-md` skill to search [designmd.ai](https://designmd.ai/) for reference aesthetics (e.g., "minimal SaaS", "dark fintech"). Showcase options to the user before committing to a BOLD direction.
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## Forbidden AI Tells (anti-slop)

> Adapted from taste-skill (MIT © Leonxlnx, <https://github.com/Leonxlnx/taste-skill>; core rules + `gpt-tasteskill` and `image-to-code-skill` sub-skills). These are **mechanical FAIL conditions**, not aesthetic judgment calls — if any appears, the work is not done.

- **Em-dash (—) in visible UI copy: 0 allowed** (non-negotiable). Use commas, periods, or restructure the sentence.
- No "hero version labels" (v2.0, Beta badges) unless functionally required.
- No section-number eyebrows ("01 — Features", "Step 02").
- No purple/violet gradients on white or dark, and no center-aligned dark hero as the default reflex.
- No reflexive 3-equal-column feature-card grid as the go-to layout.
- No fake avatars, fake dashboards, fake logos, or invented "precise" metrics (e.g. "10,432 users", "99.98%") faked to look real.
- No generic glassmorphism as a default surface treatment.
- Accent color: **1 dominant accent, saturation < 80%** — don't scatter many bright hues.
- Corner-radius: pick **one** scale and lock it (don't mix 4/8/16/24px at random).
- Anti-center bias: default to intentional asymmetry; **max 2 consecutive** alternating (zigzag) sections.
- Bento / grid layouts: no empty filler cells.
- Contrast: meet **WCAG AA** (text 4.5:1, large text/UI 3:1).
- Fonts: never Inter / Roboto / Arial / system as the *deliberate* choice.
- Hero H1: **2-3 lines max** — 4+ lines is a fail. Use a wide container and fluid font sizing, not a shrunk headline.
- No "cards inside cards inside cards": avoid nested-wrapper compartmentalization; prefer open composition with intentional spacing.
- No decorative pills, fake system badges, or pseudo-technical micro-labels unless functionally required; cut filler CTA verbs ("Unleash", "Transform", "Empower") used as generic copy padding.

## Pre-Flight Check (pass/fail)

> Condensed from taste-skill's Pre-Flight matrix. Run this before declaring frontend work done. **One fail = not done.**

- [ ] 0 em-dashes in all visible copy.
- [ ] Design direction stated in one line before coding ("Reading this as: [page type] for [audience], tone [x]").
- [ ] Distinctive display + body font pairing (no generic/system fonts).
- [ ] 1 dominant accent (saturation < 80%), colors driven by CSS variables.
- [ ] One locked corner-radius scale.
- [ ] Layout is not the default center-hero + 3-card reflex.
- [ ] No fake data / avatars / metrics presented as real.
- [ ] WCAG AA contrast on text and interactive elements.
- [ ] Motion is intentional (a page-load stagger or purposeful micro-interactions), not scattered.
- [ ] Responsive: no horizontal body scroll at mobile widths.
- [ ] Hero H1 fits within 2-3 lines.
- [ ] No nested-box (card-in-card-in-card) compartmentalization.

**Scope / stack note**: taste-skill assumes Next.js + Tailwind v4 + Motion. Our work also includes static sites and blogs (e.g. lweb02, LowyOpinion), so apply the **stack-independent** rules above (anti-tells, accessibility, copy audit, layout discipline) and skip framework-specific mandates that don't fit the target. Dashboards, data tables, and multi-step forms are out of scope for this skill — reach for purpose-built libraries there.

## ⚡ Optimization Integration
When using this skill for critical tasks, please run it within a /native-trace context to capture performance data for self-improvement via /aioptimize.

