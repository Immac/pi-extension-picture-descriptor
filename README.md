# Picture Descriptor 🖼️

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org)
[![Pi Extension](https://img.shields.io/badge/pi-extension-orange)](https://github.com/earendil-works/pi-coding-agent)
![License](https://img.shields.io/badge/license-MIT-green)

Analyze images, screenshots, UI/UX mockups, and visual diffs using AI via **pi sub-agent sessions** (`createAgentSession`).
Every provider and model goes through the same path — resolved through pi's model registry,
no hardcoded API calls.

Includes **four focus modes** for different analysis tasks:

| Mode | Use Case |
|------|----------|
| `general` | Default — open-ended image description |
| `ui-ux` | Screenshot/UI analysis — layout, elements, spacing, readability, issues |
| `diff` | Visual diff analysis — what changed between two states |
| `state` | App state detection — what state is the application in? |

---

> **Note:** This extension absorbed `describe-this-picture` (archived 2026-05-15).
> Use `picture-describe` for all image description needs — it has all the features
> (focus modes, tiered model selection, structured JSON output, batch processing, abort support).

## 🔧 Tool: `picture-describe`

| Parameter     | Type                    | Default        | Description |
|---------------|-------------------------|----------------|-------------|
| `images`      | `string \| string[]`    | —              | Image file path(s) to describe |
| `format`      | `string` (optional)     | `"natural"`    | Output format: `"natural"` (narrative) or `"structured"` (JSON) |
| `focus`       | `string` (optional)     | `"general"`    | Analysis focus: `"general"`, `"ui-ux"`, `"diff"`, `"state"` |
| `tier`        | `string` (optional)     | `"local"`      | Model tier — see below |
| `provider`    | `string` (optional)     | *from tier*    | Explicit provider override |
| `model`       | `string` (optional)     | *from tier*    | Explicit model override |
| `request`     | `string` (optional)     | *default*      | Custom description prompt (overrides focus entirely) |
| `Language`    | `string` (optional)     | —              | Output language (e.g. `"French"`, `"Spanish"`) |
| `hint`        | `string` (optional)     | —              | Lightweight context (e.g. `"game UI screenshot"`, `"settings panel"`) |
| `max_size`    | `number` (optional)     | `1024`         | Max pixel dimension on longest side (~1MP default). Images larger than this are resized before sending. `0` = original resolution |
| `concurrency` | `number` (optional)     | `3`            | Batch processing concurrency |
| `force`       | `boolean` (optional)    | `false`        | Force picture-describe even if the current model supports vision. Use to delegate to a different vision model. |

### Model Tiers

| Tier            | Provider         | Model            | Access |
|-----------------|------------------|------------------|--------|
| `local` *(default)* | `llamaswap`   | `gemma4`         | Free, local, no API key |
| `remote-free`   | `github-copilot` | `gpt-5-mini`     | GitHub Copilot free tier |
| `remote-cheap`  | `opencode-go`    | `mimo-v2.5`      | Generous rate limit, experimental edge |
| `remote-ux`     | `opencode-go`    | `kimi-k2.5`      | Best for UI/UX screenshot analysis |
| `remote-general`| `opencode-go`    | `qwen3.6-plus`   | Best all-around quality |

Override: `provider="github-copilot" model="gpt-5-mini"`.

> **⚠️ Vision Model Check:** picture-describe automatically detects if your current model supports vision (has `input: ["text", "image"]`). If it does, the tool returns a warning suggesting you paste the image directly instead. Use `force=true` to bypass this check.

### Focus Modes

#### `focus="general"` (default)
Generic image description: objects, people, animals, text, colors, patterns, spatial arrangement.

```
picture-describe images="/photo.jpg"
```

#### `focus="ui-ux"`
UI/UX engineer persona — analyzes as a screenshot. Reports on:
- Layout structure (columns, cards, header, nav)
- UI elements (buttons, labels, inputs, icons, state)
- Spacing & alignment (consistency, overlap, alignment)
- Text & readability (contrast, overflow, truncation)
- Colors & styling (harmony, inconsistency)
- State indicators (loaded, empty, error, loading)
- Usability issues (missing labels, poor touch targets)

```
picture-describe images="/screenshot.png" focus="ui-ux"
picture-describe images="/screenshot.png" focus="ui-ux" hint="game character cards"
```

#### `focus="diff"`
For visual diff images (gui_diff output) — describes what changed between two screenshots:
- Changed regions (red/pink overlay areas)
- Content changes (text that appeared/disappeared)
- Layout changes (elements that moved or resized)
- State transitions (loading → loaded, modal open/closed)
- Unchanged areas (to confirm no side effects)

```
gui_diff before="before.png" after="after.png"
picture-describe images="./diff.png" focus="diff"
```

#### `focus="state"`
Application state detection — concise, state-focused analysis:
- Application state (empty, loaded, error, loading, modal open)
- Key indicators (status messages, progress, errors)
- UI readiness (enabled/disabled controls)
- Navigation context (dashboard, settings, specific view)
- Notable absences (missing data or controls)

```
picture-describe images="/screenshot.png" focus="state"
```

### Combined modes

```
# Structured JSON output with UI/UX analysis
picture-describe images="/screenshot.png" format="structured" focus="ui-ux"

# Diff with custom language
picture-describe images="/diff.png" focus="diff" Language="Spanish"

# Remote tier for higher-fidelity UI analysis
picture-describe images="/screenshot.png" focus="ui-ux" tier="remote-free"
```

### Output Formats

**`format="natural"`** (default) — narrative paragraphs:

```
## /path/to/screenshot.jpg

The UI shows a character card layout with three cards arranged in a row...
```

**`format="structured"`** — JSON with elements, layout, issues, texts:

```json
[
  {
    "path": "/path/to/screenshot.jpg",
    "elements": [
      { "type": "button", "name": "Submit", "position": "bottom-right", "state": "enabled" }
    ],
    "layout": {
      "structure": "single-column",
      "spacing": "balanced",
      "alignment": "center"
    },
    "issues": [
      { "severity": "minor", "type": "contrast", "description": "Low contrast on secondary text" }
    ],
    "texts": [
      { "content": "Welcome", "location": "header" }
    ]
  }
]
```

(When focus is not `"ui-ux"`, structured mode outputs the original `objects`/`texts` schema.)

---

## 🚀 Quick Start

```bash
# Describe a single image (local gemma4)
picture-describe images="/path/to/photo.jpg"

# Analyze a screenshot for UI/UX issues
picture-describe images="/screenshot.png" focus="ui-ux"

# Analyze a visual diff (gui_diff output)
picture-describe images="/diff.png" focus="diff"

# Detect application state
picture-describe images="/screenshot.png" focus="state"

# Use a remote tier for better OCR on small UI text
picture-describe images="/screenshot.png" focus="ui-ux" tier="remote-free"

# Structured JSON output with UI analysis
picture-describe images="/screenshot.png" format="structured" focus="ui-ux"

# Force picture-describe even when using a vision model
picture-describe images="/screenshot.png" force=true tier="remote-ux"

# Batch process with hint
picture-describe images=["/img1.png", "/img2.png"] hint="settings screenshots"

# Custom language
picture-describe images="/photo.jpg" Language="Spanish"

# Full debug workflow
gui_capture path=".debugging/before.jpg"
picture-describe images=".debugging/before.jpg" focus="ui-ux"
# ... fix code ...
gui_capture path=".debugging/after.jpg"
gui_diff before=".debugging/before.jpg" after=".debugging/after.jpg"

# Full resolution for detail-sensitive images (disable auto-resize)
picture-describe images="/screenshot.png" focus="ui-ux" max_size=0

# Custom max size for very large images
picture-describe images="/poster.png" focus="general" max_size=2048
picture-describe images=".debugging/diff.png" focus="diff"
```

---

## 🧠 Architecture

All providers go through the same path — pi's model registry → sub-agent session:

```
Your agent (any model)
  │  picture-describe images="./screenshot.png" focus="ui-ux"
  ▼
Extension tool
  │  1. reads image(s), encodes to base64
  │  2. resolves provider/model via pi's model registry
  │     (tier → provider+model, or explicit params)
  │  3. picks prompt preset based on focus mode
  │  4. creates in-memory pi sub-agent session
  │     → createAgentSession({ model, tools: [], ... })
  │  5. sends image + prompt to vision model via session.prompt()
  │  6. returns description (natural text or structured JSON)
  ▼
Your agent receives the result inline
```

To swap modes, pass a different `focus`. To swap models, change `tier` or pass `provider`/`model` explicitly.
No hardcoded API calls — it always uses pi's model registry and sub-agent sessions.

---

## 📦 Installation

```bash
# Using extension_creator (preferred)
extension_creator mode=install path=./picture-descriptor

# After install, reload pi
/reload
```

---

## 🛠 Development

```bash
cd picture-descriptor
npm install
npm run validate    # TypeScript check
npm test           # Run tests (41 tests)
npm run test:watch # Watch mode
```

### File structure

```
picture-descriptor/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── __tests__/
│   └── picture-descriptor.test.ts    # 38 tests
└── src/
    ├── index.ts                       # Re-export
    └── picture-descriptor.ts          # Extension entry point
```

---

## ⚠️ Notes

- **All providers must be configured in pi's model registry.** Add custom providers
  to `~/.pi/agent/models.json`. The `local` tier expects `llamaswap` with `gemma4`
  and vision capability (`"input": ["text","image"]`).
- **Remote tiers** require the provider to be configured in pi's `auth.json`
  (and optionally `models.json`).
- **Vision model check:** picture-describe automatically detects if the calling model
  supports vision (via `ctx.model.input.includes("image")`). If it does, the tool
  returns a warning suggesting you paste the image directly. Use `force=true` to
  bypass this check when you explicitly want to delegate to a different vision model.
- The sub-agent session is ephemeral — created in-memory and disposed after
  the description is collected.
- For `format="structured"`, the tool attempts to parse the LLM response as JSON.
  If parsing fails, the raw text is returned under a `"raw"` field.
- **Images are auto-resized** to 1024px on the longest side (~1MP) by default
  using `sharp`. This keeps bandwidth low and speeds up vision model calls.
  Set `max_size=0` to disable resizing and send full original resolution,
  or `max_size=N` for a custom limit.
- **gemma4 (local tier)** is acceptable for layout and element detection but may
  struggle with precise pixel coordinates or very small fonts — use `remote-free`
  or `remote-ux`/`remote-general` for higher fidelity OCR.

---

## License

MIT
