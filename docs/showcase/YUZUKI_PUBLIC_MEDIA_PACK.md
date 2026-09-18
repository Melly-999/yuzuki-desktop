# Yuzuki Public Visual Media Pack

**Version:** 1.0  
**Date:** 2026-09-18  
**Repository:** https://github.com/Melly-999/yuzuki-desktop  
**HEAD:** ef0992c22745a2276f24bdd3a81aca996b89f46a  
**Distribution:** Source only — no Windows binary published

---

## Executive Summary

This document defines the visual-media direction and repository-safe asset plan for the public Yuzuki GitHub project. The goal is to strengthen the repository's visual presentation for recruiters, clients, developers, portfolio visitors, and future social/launch material — **without redesigning the product** or fabricating functionality.

**Visual identity keywords:** calm, premium, local-first, technical, private, intentional  
**Reference influences:** Vesper (calm dark workspace), Penumbra (editorial restraint), Vexon (selective cinematic product reveal)  
**Do NOT emulate:** Generic neon AI SaaS landing pages

---

## 1. Source Asset Inventory & Privacy Validation

All source assets are synthetic public fixtures with verified provenance.

| Asset | Path | Dimensions | Bytes | SHA-256 | Provenance | Privacy Status |
|-------|------|------------|-------|---------|------------|----------------|
| Desktop Workspace | `docs/showcase/screenshots/yuzuki-v11-public/01-home-desktop-1440.png` | 1440×900 | 31,254 | `a0889d7632fd6867708ecb32f652c82ce6ad7e0a591115577513bf10789bc048` | Synthetic fixture, fixture mode, no runtime | ✅ SAFE |
| Knowledge Constellation | `docs/showcase/screenshots/yuzuki-v11-public/02-knowledge-constellation-1440.png` | 1440×900 | 66,413 | `2aadf219fa4689588a372c960ef8f56cc0c5716bef5efb402b9bb684f3905ea4` | Synthetic fixture, prototype label visible | ✅ SAFE |

**Privacy Validation:** PASS  
- ✅ No real SessionDB content
- ✅ No real conversations
- ✅ No private Hermes profile names
- ✅ No real personal state
- ✅ No local usernames/paths
- ✅ No credentials
- ✅ No fake assistant conversations
- ✅ Knowledge Constellation explicitly labeled `PROTOTYPE / FIXTURE DATA` in-app

---

## 2. Primary Screenshot Decision

**PRIMARY_SCREENSHOT:** `docs/showcase/screenshots/yuzuki-v11-public/01-home-desktop-1440.png`  
**PRIMARY_SCREENSHOT_VERDICT:** KEEP

**Rationale:**
- Shows the core product: desktop workspace with local runtime status, navigation, and chat entry point
- Clean, uncluttered composition at 1440×900
- Synthetic fixture provenance is documented and verifiable
- Represents the verified `PRIVATE` mode workspace truthfully
- No fabricated chat content or routing UI that would require staging

**README Placement:** Current placement (after "Screenshots" section, before "Knowledge Constellation") is appropriate. No changes needed.

---

## 3. Knowledge Constellation Media Treatment

**ASSET:** `docs/showcase/screenshots/yuzuki-v11-public/02-knowledge-constellation-1440.png`  
**STATUS:** APPROVED (with restrictions)

**Restrictions:**
- Must always be presented with `PROTOTYPE / FIXTURE DATA` context
- Must not be used to imply production knowledge memory or persistent memory writes
- In social cards: crop to graph area, avoid implying full feature completeness
- In video: include visible "PROTOTYPE / FIXTURE DATA" badge overlay or lower-third

**README Placement:** Current placement is appropriate. No changes needed.

---

## 4. GitHub Social Preview Specification (1280×640)

### Composition Requirements

| Element | Specification |
|---------|---------------|
| **Canvas** | 1280×640 px (2:1 aspect), GitHub social preview standard |
| **Safe Zone** | Center 1024×512 (critical content must fit here) |
| **Background** | Dark workspace tone (#0F0F12 or similar deep charcoal) |
| **Logo/Wordmark** | "Yuzuki" — top-left or centered, adequate breathing room |
| **Positioning Line** | Single line, ≤8 words, e.g., "Local-first AI desktop. Private by default." |
| **UI Crop** | Center-crop of 01-home-desktop-1440.png focusing on runtime status + navigation + chat entry (approx 800×500 source region) |
| **Privacy Cue** | Subtle "127.0.0.1" or "PRIVATE" badge near crop — no fake status indicators |
| **Typography** | System font stack or Inter; headline 32–40px, subline 18–20px |
| **Contrast** | All text ≥4.5:1 against background |
| **File Output** | `docs/showcase/media/social-preview-1280x640.png` |

### What to Avoid
- ❌ Tiny text (<16px at 1280 width)
- ❌ Feature lists or bullet points
- ❌ Screenshots scaled too small to read
- ❌ Fake chat messages or assistant replies
- ❌ Routing mode selector (requires fabricated conversation state)
- ❌ Star/download metrics or badges

---

## 5. README Hero Media

**Current State:** Uses full 1440×900 screenshots inline — renders large on desktop, acceptable on mobile.

**Recommendation:** Keep current implementation. The synthetic screenshots are already appropriately sized for GitHub README rendering (GitHub constrains image width to container).

**Optional Enhancement:** If a tighter crop is desired for hero, create a 1280×720 center-crop of `01-home-desktop-1440.png` focusing on the workspace chrome + chat entry, saved as `docs/showcase/media/readme-hero-1280x720.png`. Update README to reference this derivative with explicit alt text noting it's a cropped view of the synthetic fixture.

---

## 6. Social Card Copy Options

### Option A (Product-focused)
> **Headline:** Local-first AI desktop  
> **Support:** Runs entirely on your machine. PRIVATE mode fails closed — no cloud fallback.

### Option B (Privacy-focused)
> **Headline:** Private by default  
> **Support:** Windows desktop AI with fail-closed local routing. No cloud provider contacted.

### Option C (Technical-focused)
> **Headline:** Desktop AI with fail-closed PRIVATE mode  
> **Support:** Tauri + Hermes Agent. Local model, loopback only. Source verified.

**Constraints Met:**
- ✅ Headline ≤8 words
- ✅ Supporting copy ≤15 words
- ✅ No exaggerated claims
- ✅ No autonomous execution claims
- ✅ Truthful to source-only distribution status

---

## 7. HyperFrames Teaser Storyboard (8–10 seconds)

**Tooling Status:** HyperFrames not currently in repository. Specification only.

| Time | Scene | Visual | Audio/Copy | Motion Notes |
|------|-------|--------|------------|--------------|
| 0.0–1.5s | Reveal | Dark screen → Yuzuki wordmark fade-in (scale 0.95→1.0, ease-out) | Subtle ambient tone | Slow, deliberate entrance |
| 1.5–3.5s | Desktop Workspace | Crossfade to 01-home-desktop crop (runtime status, nav, chat) | "Local runtime. Local model." (VO or text) | Ken Burns slow zoom (1.0→1.03) |
| 3.5–5.5s | PRIVATE Signal | Highlight "PRIVATE" badge + "127.0.0.1" indicator with subtle pulse | "Fail-closed. No cloud fallback." | Pulse on badge, text reveal |
| 5.5–7.0s | Knowledge Constellation | Crossfade to 02-knowledge-constellation crop (graph + inspector) | "Prototype knowledge graph" | Slow pan across nodes |
| 7.0–9.0s | Architecture Statement | Dark background, typography lockup: "LOCAL-FIRST / NO CLOUD FALLBACK" | Silent or low hum | Typewriter or line-by-line reveal |
| 9.0–10.0s | Identity Lockup | Yuzuki wordmark + "Source: github.com/Melly-999/yuzuki-desktop" | — | Fade to lockup, hold |

**Total Duration:** 10 seconds  
**Motion Principles:** Vesper calm — no flashy transitions, spatial continuity, reduced-motion safe (all transforms opacity/scale only)

---

## 8. Full Promo Concept (25–40 seconds) — Specification Only

| Segment | Duration | Content |
|---------|----------|---------|
| 1. Product Reveal | 3s | Wordmark + "Windows desktop AI companion" |
| 2. Workspace Tour | 6s | Desktop workspace pan — status, nav, chat, session list |
| 3. PRIVATE Mode Deep Dive | 6s | Profile validation flow diagram → fail-closed guarantee |
| 4. Routing Architecture | 5s | 7-mode table → PRIVATE highlighted → Hermes authority |
| 5. Knowledge Constellation | 5s | Graph interaction (prototype badge visible) |
| 6. Hermes Relationship | 4s | Architecture diagram — Yuzuki shell ↔ Hermes runtime |
| 7. Validation Evidence | 4s | Test counts (210 server, 63 frontend, 7 boundary) + CI badge |
| 8. Closing Identity | 3s | Wordmark + GitHub URL + "MIT License" |

**Production Notes:** Requires HyperFrames or equivalent motion tooling. Do not attempt without proper tooling.

---

## 9. Asset Matrix

| Channel | Aspect Ratio | Asset Source | Crop Strategy | Copy Density | Motion/Static |
|---------|--------------|--------------|---------------|--------------|---------------|
| GitHub README | 16:9 (displayed) | 01-home-desktop-1440.png | Full-frame | Low (alt text only) | Static |
| GitHub Social Preview | 2:1 (1280×640) | 01-home-desktop-1440.png | Center crop (runtime + nav + chat) | Medium (headline + subline) | Static |
| Portfolio Case Study | 16:9 or 4:3 | Both screenshots | Full-frame + detail crops | High (contextual captions) | Static |
| LinkedIn Post | 1.91:1 (1200×628) | 01-home-desktop-1440.png | Center crop | Medium (headline + 1 line) | Static |
| X/Twitter Card | 2:1 (1200×600) | 01-home-desktop-1440.png | Center crop | Low (headline only) | Static |
| Discord Embed | 2:1 | 01-home-desktop-1440.png | Center crop | Low | Static |
| Short Teaser Video | 16:9 (1920×1080) | Both + typography | Per storyboard | Minimal (key phrases only) | Motion (10s) |
| Full Promo Video | 16:9 | Both + diagrams | Per concept | Medium | Motion (25–40s) |

---

## 10. Derivative Asset Specifications (If Created)

| Derivative | Source | Transform | Output Path | Dimensions | Purpose |
|------------|--------|-----------|-------------|------------|---------|
| Social Preview | 01-home-desktop-1440.png | Center crop 800×500 → place on 1280×640 dark bg + wordmark + positioning line | `docs/showcase/media/social-preview-1280x640.png` | 1280×640 | GitHub social preview |
| README Hero (tight) | 01-home-desktop-1440.png | Center crop 1280×720 | `docs/showcase/media/readme-hero-1280x720.png` | 1280×720 | Optional tighter README hero |
| LinkedIn Card | 01-home-desktop-1440.png | Center crop → 1200×628 + wordmark | `docs/showcase/media/linkedin-1200x628.png` | 1200×628 | LinkedIn sharing |
| Twitter Card | 01-home-desktop-1440.png | Center crop → 1200×600 + wordmark | `docs/showcase/media/twitter-1200x600.png` | 1200×600 | X/Twitter sharing |

**Recording Requirements for Each Derivative:**
- Source asset path + SHA-256
- Crop coordinates (x, y, width, height)
- Transform operations (resize, overlay, text)
- Output SHA-256
- Tool used (ImageMagick, sharp, manual, etc.)

---

## 11. Privacy Validation Checklist (Per Asset)

Every asset published or referenced must pass:

- [ ] **Synthetic fixture provenance documented** → See `docs/showcase/screenshots/yuzuki-v11-public/README.md`
- [ ] **No real user state** → Confirmed by fixture mode design
- [ ] **No private identifiers** → Profile name "yuzuki-local" is generic compiled fallback
- [ ] **No real conversations** → Fixture mode short-circuits before runtime
- [ ] **No credentials/paths** → Verified by capture manifest
- [ ] **Prototype features labeled** → Knowledge Constellation shows `PROTOTYPE / FIXTURE DATA`
- [ ] **No fabricated chat content** → Fixture mode does not fake chat turns
- [ ] **Source-only status visible** → README states "Public distribution status: source only"

**Overall Privacy Status:** PASS

---

## 12. README Changes

**Decision:** NO CHANGES REQUIRED

**Rationale:**
- Current screenshot placement is appropriate
- Existing alt text is accurate ("Synthetic Yuzuki desktop workspace...")
- Provenance link to capture manifest is present
- Source-only status is clearly stated
- Knowledge Constellation is correctly labeled as prototype

---

## 13. Validation Results

| Check | Status |
|-------|--------|
| All referenced assets exist | ✅ PASS |
| All image paths valid | ✅ PASS |
| No real/private content in any asset | ✅ PASS |
| No broken Markdown links | ✅ PASS |
| HEAD/branch/remote parity | ✅ PASS (ef0992c) |
| Git diff --check | ✅ PASS (no changes to tracked files) |
| Source asset SHA-256 matches manifest | ✅ PASS |

---

## 14. Files Changed

| File | Change Type |
|------|-------------|
| `docs/showcase/YUZUKI_PUBLIC_MEDIA_PACK.md` | NEW (specification document) |
| `docs/showcase/media/` | NEW (directory for future derivative assets) |

**No derivative image assets created in this commit** — specification only. Derivatives can be produced in a follow-up task with appropriate design tooling.

---

## 15. Commit & Push Plan

**COMMIT_MESSAGE:** `docs(yuzuki): define public visual media pack`

**FILES_TO_COMMIT:**
- `docs/showcase/YUZUKI_PUBLIC_MEDIA_PACK.md`
- `docs/showcase/media/.gitkeep` (empty directory marker)

**COMMITS_CREATED:** 1  
**PUSH:** YES (after validation)  
**FORCE_PUSH:** NO  
**TAG:** NO  
**RELEASE:** NO  
**BINARY:** NO

---

## 16. Next Steps

**Immediate:**
1. Commit specification document
2. Push to main
3. Verify GitHub social preview renders correctly (requires manual upload of 1280×640 asset to repo settings)

**Future Tasks:**
- **YUZUKI-HYPERFRAMES-TEASER-001** — Create 10s teaser video when HyperFrames tooling is available
- **PORTFOLIO-YUZUKI-INTEGRATION-001** — Integrate media pack assets into portfolio case study
- **SOCIAL-ASSET-PRODUCTION-001** — Generate derivative social card assets (LinkedIn, X/Twitter) using design tooling

---

## Appendix: Color & Typography Reference (for Derivative Production)

| Token | Value | Usage |
|-------|-------|-------|
| Background Primary | `#0F0F12` | Social preview bg, video bg |
| Surface | `#1A1A2E` | Card overlays |
| Text Primary | `#FFFFFF` | Headlines |
| Text Secondary | `#A0A0B0` | Sublines, body |
| Accent Primary | `#3B82F6` | PRIVATE badge, links |
| Accent Muted | `#1E3A5F` | Subtle indicators |
| Border | `#2A2A3E` | Dividers |
| Font Family | `Inter, system-ui, -apple-system, sans-serif` | All text |
| Font Weight Headline | 600 | Headlines |
| Font Weight Body | 400 | Body copy |

---

*This specification is derived from existing public-safe assets only. No product functionality was fabricated, staged, or misrepresented.*