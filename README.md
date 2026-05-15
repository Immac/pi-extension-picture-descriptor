# Picture Descriptor 🖼️

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org)
[![Pi Extension](https://img.shields.io/badge/pi-extension-orange)](https://github.com/earendil-works/pi-coding-agent)
![License](https://img.shields.io/badge/license-MIT-green)

Describes images using AI via **pi sub-agent sessions** (`createAgentSession`).
Every provider and model goes through the same path — resolved through pi's model registry,
no hardcoded API calls.

---

> **Note:** This extension absorbed `describe-this-picture` (archived 2026-05-15).
> Use `picture-describe` for all image description needs — it has all the features
> (tiered model selection, structured JSON output, batch processing, abort support).

## 🔧 Tool: `picture-describe`

| Parameter     | Type                    | Default        | Description |
|---------------|-------------------------|----------------|-------------|
| `images`      | `string \| string[]`    | —              | Image file path(s) to describe |
| `format`      | `string` (optional)     | `"natural"`    | Output format: `"natural"` (narrative) or `"structured"` (JSON) |
| `tier`        | `string` (optional)     | `"local"`      | Model tier — see below |
| `provider`    | `string` (optional)     | *from tier*    | Explicit provider override |
| `model`       | `string` (optional)     | *from tier*    | Explicit model override |
| `request`     | `string` (optional)     | *default*      | Custom description prompt |
| `Language`    | `string` (optional)     | —              | Output language (e.g. `"French"`, `"Spanish"`) |
| `hint`        | `string` (optional)     | —              | Extra context to guide the description |
| `concurrency` | `number` (optional)     | `3`            | Batch processing concurrency |

### Model Tiers

| Tier            | Provider         | Model            | Access |
|-----------------|------------------|------------------|--------|
| `local` *(default)* | `llamaswap`   | `gemma4`         | Free, local, no API key |
| `remote-free`   | `github-copilot` | `gpt-5-mini`     | GitHub Copilot free tier |
| `remote-paid`   | `opencode-go`    | `qwen3.5-plus`   | OpenCode paid tier |

Override: `provider="github-copilot" model="gpt-5-mini"`.

### Output Formats

**`format="natural"`** (default) — narrative paragraphs:

```
## /path/to/photo.jpg

The image shows a sunny beach scene. In the foreground there's a...
```

**`format="structured"`** — JSON with objects and texts:

```json
[
  {
    "path": "/path/to/photo.jpg",
    "objects": [
      { "name": "person", "depth": "foreground" },
      { "name": "car", "depth": "middle" }
    ],
    "texts": [
      { "content": "STOP", "confidence": 0.95 }
    ]
  }
]
```

---

## 🚀 Quick Start

```bash
# Describe a single image (local gemma4)
picture-describe images="/path/to/photo.jpg"

# Use a remote tier
picture-describe images="/path/to/photo.jpg" tier="remote-free"

# Structured JSON output
picture-describe images="/sign.jpg" format="structured"

# Batch process with hint
picture-describe images=["/img1.jpg", "/img2.jpg"] hint="screenshots of a web app"

# Custom language
picture-describe images="/photo.jpg" Language="Spanish"
```

---

## 🧠 Architecture

All providers go through the same path — pi's model registry → sub-agent session:

```
Your agent (any model)
  │  picture-describe images="./photo.png"
  ▼
Extension tool
  │  1. reads image(s), encodes to base64
  │  2. resolves provider/model via pi's model registry
  │     (tier → provider+model, or explicit params)
  │  3. creates in-memory pi sub-agent session
  │     → createAgentSession({ model, tools: [], ... })
  │  4. sends image + prompt to vision model via session.prompt()
  │  5. returns description (natural text or structured JSON)
  ▼
Your agent receives the result inline
```

To swap models, just change the `tier` or pass `provider`/`model` explicitly.
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
npm test           # Run tests
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
│   └── picture-descriptor.test.ts    # 30 tests
└── src/
    └── picture-descriptor.ts         # Extension entry point
```

---

## ⚠️ Notes

- **All providers must be configured in pi's model registry.** Add custom providers
  to `~/.pi/agent/models.json`. The `local` tier expects `llamaswap` with `gemma4`
  and vision capability (`"input": ["text","image"]`).
- **Remote tiers** require the provider to be configured in pi's `auth.json`
  (and optionally `models.json`).
- If the requested model isn't found in the registry, the tool prints a
  helpful error with a sample config and the available tiers.
- The sub-agent session is ephemeral — created in-memory and disposed after
  the description is collected.
- For `format="structured"`, the tool attempts to parse the LLM response as JSON.
  If parsing fails, the raw text is returned under a `"raw"` field.

---

## License

MIT
