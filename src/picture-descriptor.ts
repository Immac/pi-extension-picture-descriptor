/**
 * Picture Descriptor
 *
 * Describes images using AI via pi sub-agent sessions. All providers and
 * models go through the same path — `createAgentSession` with a resolved
 * model from pi's model registry.
 *
 * Three tiers:
 *   local        llamaswap/gemma4           (free, local, no API key)
 *   remote-free  github-copilot/gpt-5-mini  (free remote tier)
 *   remote-paid  opencode-go/qwen3.5-plus   (paid remote tier)
 *
 * Two output formats:
 *   "natural"    — narrative text description
 *   "structured" — JSON with objects[] and texts[]
 *
 * Four focus modes:
 *   "general"  — default: describe the image thoroughly
 *   "ui-ux"    — analyze as a UI/UX screenshot (layout, elements, readability)
 *   "diff"     — analyze a visual diff image (what changed between states)
 *   "state"    — detect application state from a screenshot
 *
 * Abort signal propagation: if the calling agent cancels the tool call,
 * the sub-agent session is aborted via session.abort() to avoid orphan
 * sessions.
 */

import Type from "typebox";
import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export const TIERS = {
  "local":       { provider: "llamaswap",     model: "gemma4" },
  "remote-free": { provider: "github-copilot", model: "gpt-5-mini" },
  "remote-paid": { provider: "opencode-go",   model: "qwen3.5-plus" },
} as const satisfies Record<string, { provider: string; model: string }>;

const DEFAULT_TIER = "local";
const DEFAULT_FORMAT = "natural";
const DEFAULT_FOCUS = "general";

// Default max dimension for resizing (pixels on the longest side).
// 1024 keeps images at ~1 MP or less — good balance for vision model quality
// vs bandwidth/speed. Set to 0 to disable resizing.
const DEFAULT_MAX_SIZE = 1024;

// ---------------------------------------------------------------------------
// Focus modes
// ---------------------------------------------------------------------------

/**
 * Focus modes tailor the default prompts for specific analysis tasks.
 * Use "general" for open-ended description, "ui-ux" for screenshot/UI
 * analysis, "diff" for before/after comparison images, and "state" for
 * detecting what state an application is in.
 */
export const FOCUS_MODES = ["general", "ui-ux", "diff", "state"] as const;
export type FocusMode = (typeof FOCUS_MODES)[number];

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/** Map a file extension to its MIME type. Defaults to image/jpeg. */
export function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() || "jpg";
  switch (ext) {
    case "png":  return "image/png";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    default:     return "image/jpeg";
  }
}

/**
 * Read an image file from disk, optionally resize it, and encode as base64.
 *
 * @param path - Path to the image file.
 * @param maxSize - Max pixel dimension on the longest side (0 = no resize, default 1280).
 *                  For UI screenshots this saves bandwidth and speeds up the vision call.
 */
export async function encodeImage(
  path: string,
  maxSize?: number,
): Promise<{ mediaType: string; data: string }> {
  const mediaType = getMimeType(path);
  const ext = path.toLowerCase().split(".").pop() || "jpg";

  if (maxSize && maxSize > 0) {
    try {
      const sharp = await import("sharp");
      const image = sharp.default(path);
      const metadata = await image.metadata();

      if (metadata.width && metadata.height) {
        const longest = Math.max(metadata.width, metadata.height);
        if (longest > maxSize) {
          // Resize keeping aspect ratio, longest side = maxSize
          const resized = await image
            .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
            .toFormat(ext === "png" ? "png" : "jpeg", { quality: 85 })
            .toBuffer();
          return {
            mediaType,
            data: resized.toString("base64"),
          };
        }
      }
    } catch {
      // sharp not available or resize failed — fall through to original
    }
  }

  const buffer = await readFile(path);
  return {
    mediaType,
    data: buffer.toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// JSON extraction for structured mode
// ---------------------------------------------------------------------------

/**
 * Result of structured parsing. Contains any top-level array/object fields
 * found in the parsed JSON. Default fields include objects[] and texts[],
 * but with focus="ui-ux" the LLM may also output elements[], layout{}, and issues[].
 */
export interface StructuredResult {
  objects: unknown[];
  texts: unknown[];
  elements?: unknown[];
  layout?: Record<string, unknown>;
  issues?: unknown[];
  [key: string]: unknown;
}

/**
 * Attempt to parse a string as structured JSON.
 * Tries direct JSON.parse first, then falls back to extracting from
 * markdown code blocks or top-level braces.
 * Returns null if all attempts fail.
 *
 * Extracts ALL top-level fields — not just objects[] and texts[].
 * This lets structured+ui-ux mode pass through elements[], layout{}, and issues[].
 */
export function tryParseStructured(
  content: string,
): StructuredResult | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      return normalizeStructured(parsed);
    }
  } catch {
    // not valid JSON — fall through to extraction attempt
  }

  // Try extracting from markdown code block or any top-level {…}
  const jsonMatch =
    content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ??
    content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
      if (parsed && typeof parsed === "object") {
        return normalizeStructured(parsed);
      }
    } catch {
      // extracted text wasn't valid JSON either
    }
  }

  return null;
}

/**
 * Normalize a parsed JSON object into StructuredResult.
 * Preserves all top-level keys, ensuring array fields default to [].
 */
function normalizeStructured(parsed: Record<string, unknown>): StructuredResult {
  const result: StructuredResult = {
    objects: Array.isArray(parsed.objects) ? parsed.objects : [],
    texts: Array.isArray(parsed.texts) ? parsed.texts : [],
  };

  // Pass through elements, layout, issues when present (ui-ux structured mode)
  if (Array.isArray(parsed.elements)) result.elements = parsed.elements;
  if (parsed.layout && typeof parsed.layout === "object") result.layout = parsed.layout as Record<string, unknown>;
  if (Array.isArray(parsed.issues)) result.issues = parsed.issues;

  return result;
}

// ---------------------------------------------------------------------------
// Sub-agent session — shared by all providers
// ---------------------------------------------------------------------------

async function describeViaSubAgent(
  model: Model<any>,
  encoded: { mediaType: string; data: string },
  fullPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    model,
    tools: [],
  });

  // Abort the sub-agent session if the calling agent cancels
  const onAbort = () => session.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let description = "";
  const unsubscribe = session.subscribe((event: any) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      description += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(fullPrompt, {
      images: [
        {
          type: "image",
          data: encoded.data,
          mimeType: encoded.mediaType,
        },
      ],
    });

    return description.trim() || "(no description returned)";
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    session.dispose();
  }
}

// ---------------------------------------------------------------------------
// Dispatch — single path through model registry
// ---------------------------------------------------------------------------

export async function describeImage(
  encoded: { mediaType: string; data: string },
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  modelRegistry: { find: (p: string, m: string) => Model<any> | undefined } | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const visionModel = modelRegistry?.find(provider, modelId);

  if (!visionModel) {
    const knownTiers = Object.entries(TIERS)
      .map(([t, c]) => `  "${t}": ${c.provider}/${c.model}`)
      .join("\n");

    throw new Error(
      `Model "${provider}/${modelId}" not found in pi's model registry.\n\n` +
        `Make sure the provider is configured in ~/.pi/agent/models.json.\n` +
        `For example, for the local tier:\n` +
        `  {\n` +
        `    "providers": {\n` +
        `      "llamaswap": {\n` +
        `        "baseUrl": "http://127.0.0.1:8080/v1",\n` +
        `        "api": "openai-completions",\n` +
        `        "models": [{ "id": "gemma4", "input": ["text","image"] }]\n` +
        `      }\n` +
        `    }\n` +
        `  }\n\n` +
        `Available tiers:\n${knownTiers}`
    );
  }

  return describeViaSubAgent(visionModel, encoded, `${systemPrompt}\n\n${userPrompt}`, signal);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildPrompts(
  format: string,
  language?: string,
  hint?: string,
  focus?: FocusMode,
): { systemPrompt: string; userPrompt: string } {
  const langInst = language?.trim()
    ? `\nUse ${language.trim()} for the output.`
    : "";

  const hintInst = hint?.trim()
    ? `\nContext hint: ${hint.trim()}`
    : "";

  // Structured format: always outputs JSON regardless of focus
  if (format === "structured") {
    let objectsPrompt = `Return ONLY valid JSON in this exact format (no additional text, no markdown formatting):
{
  "objects": [
    {"name": "object name", "depth": "foreground|middle|background"}
  ],
  "texts": [
    {"content": "text content", "confidence": 0.95}
  ]
}`;

    if (focus === "ui-ux") {
      objectsPrompt = `Return ONLY valid JSON in this exact format (no additional text, no markdown formatting):
{
  "elements": [
    {"type": "button|label|input|image|nav|card|icon|other",
     "name": "element name or text content",
     "position": "top|bottom|left|right|center",
     "state": "enabled|disabled|selected|hidden|error"}
  ],
  "layout": {
    "structure": "single-column|multi-column|grid|flex|overlay|modal",
    "spacing": "tight|balanced|spacious",
    "alignment": "left|center|right|inconsistent"
  },
  "issues": [
    {"severity": "critical|major|minor",
     "type": "overflow|alignment|contrast|spacing|clipping|missing-label|other",
     "description": "description of the issue"}
  ],
  "texts": [
    {"content": "text content", "location": "where it appears"}
  ]
}`;
    }

    return {
      systemPrompt:
        `You are an expert image analyst. Analyze the given image and list all visible objects and text.

${objectsPrompt}

Be thorough — capture everything visible.${langInst}${hintInst}`,
      userPrompt:
        `Analyze this image and return structured data.${langInst}${hintInst}`,
    };
  }

  // Focus-specific natural-language prompts
  if (focus === "ui-ux") {
    return {
      systemPrompt:
        `You are a senior UX/UI engineer analyzing a screenshot of an application interface. Focus on what a developer needs to know to fix or improve the UI.

Describe in detail:
- **Layout structure**: how elements are arranged (columns, cards, header, nav, content area)
- **UI elements**: buttons, labels, inputs, icons, cards, menus — their placement and apparent state
- **Spacing & alignment**: is spacing consistent? Are elements aligned properly? Any overlapping?
- **Text & readability**: font sizes, contrast, text overflow, truncated text, hard-to-read labels
- **Colors & styling**: color harmony, contrast issues, inconsistent styling
- **State indicators**: what state is the UI in? (loaded, empty, error, loading, success)
- **Usability issues**: missing labels, confusing layout, unclear calls-to-action, poor touch targets

Be specific — mention what looks good too. Use technical language a frontend developer would find useful. Respond in plain paragraphs.${langInst}${hintInst}`,
      userPrompt:
        `Analyze this screenshot as a UI/UX engineer. What do you see? Focus on layout, elements, spacing, readability, and usability issues.${langInst}${hintInst}`,
    };
  }

  if (focus === "diff") {
    return {
      systemPrompt:
        `You are analyzing a visual diff image showing changes between two screenshots. The diff highlights changed pixels in red/pink overlay. Your job is to describe what changed and what stayed the same.

Focus on:
- **Changed regions**: which areas of the screen have red/pink pixels?
- **Content changes**: text that appeared, disappeared, or changed (new messages, updated values, state transitions)
- **Layout changes**: elements that moved, resized, appeared, or disappeared
- **State transitions**: did the application state change? (loading → loaded, empty → populated, modal open/closed)
- **Unchanged areas**: what stayed the same? (navigation, headers, chrome — to confirm no unintended changes)
- **Magnitude**: was the change small (one element) or large (whole layout shift)?

Be precise about what changed and where. Only mention changes that are actually visible in the diff overlay. Respond in plain paragraphs.${langInst}${hintInst}`,
      userPrompt:
        `Analyze this visual diff image. What changed between the two screenshots? Describe each changed region and what the change means.${langInst}${hintInst}`,
    };
  }

  if (focus === "state") {
    return {
      systemPrompt:
        `You are analyzing a screenshot of an application to determine its current state. Focus on what state the application or page is in right now.

Describe:
- **Application state**: what is the app/page showing? (initial/empty state, loaded state with content, error/offline state, loading state, modal/dialog open)
- **Key indicators**: any visible status messages, progress indicators, error messages, empty states, data displays
- **UI readiness**: are interactive elements enabled or disabled? Are placeholders or actual content visible?
- **Navigation context**: where in the app is this? (dashboard, settings, profile, specific view)
- **Notable absences**: what you'd expect to see but don't (missing data, missing controls)

Be concise and state-focused — describe what state the app is in, not every visual detail. Respond in plain paragraphs.${langInst}${hintInst}`,
      userPrompt:
        `Analyze this screenshot. What state is the application in? Describe the current state, what's being displayed, and any notable status indicators.${langInst}${hintInst}`,
    };
  }

  // Default general mode
  return {
    systemPrompt:
      `You are an expert image analyst. Describe the image in detail: identify all visible objects, people, animals, text, colors, patterns, spatial arrangement, and any notable features. Be thorough, precise, and structured — list what you see from most prominent to least prominent.

Respond in plain paragraphs — no JSON formatting, no markdown code blocks. Just a natural description.${langInst}${hintInst}`,
    userPrompt: `Describe this image in detail.${langInst}${hintInst}`,
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "picture-describe",
    label: "Picture Descriptor",
    description:
      `Analyze images, screenshots, and visual diffs using a vision-capable pi sub-agent. ` +
      `Four focus modes: general (default), ui-ux, diff, state. ` +
      `Three tiers: local (llamaswap/gemma4), remote-free (github-copilot/gpt-5-mini), ` +
      `remote-paid (opencode-go/qwen3.5-plus). ` +
      `Two formats: "natural" (narrative text) or "structured" (JSON elements/issues).`,

    promptSnippet:
      "Analyze images, screenshots, UI/UX mockups, and visual diffs using a vision-capable pi sub-agent — local gemma4 by default. Use focus='ui-ux' for screenshot debugging, focus='diff' for before/after comparison, focus='state' for app state detection.",

    promptGuidelines: [
      "Use picture-describe when you need to analyze or describe an image — especially for screenshot-based debugging.",
      "All providers go through pi's model registry — configure providers in ~/.pi/agent/models.json.",
      "Tiers: local (llamaswap/gemma4), remote-free (github-copilot/gpt-5-mini), remote-paid (opencode-go/qwen3.5-plus).",
      "Use format='structured' for JSON output, focus='ui-ux' for UI element and issue detection.",
      "Use the 'focus' parameter for built-in prompt presets: focus='ui-ux' (screenshot/UI analysis), focus='diff' (visual diff analysis), focus='state' (app state detection), focus='general' (default, generic description).",
      "The 'request' parameter overrides the default prompt entirely — use for customized analysis needs beyond the focus presets.",
      "The 'hint' parameter provides lightweight context (e.g., 'game UI screenshot', 'settings panel') — use when focus is enough but needs scene context.",
      "For full debug workflow: gui_capture → picture-describe(focus='ui-ux') → fix code → gui_capture → gui_diff → picture-describe(focus='diff').",
      "gemma4 (local tier) is acceptable for layout and element detection but may struggle with precise pixel coordinates or very small fonts — use remote-free or remote-paid for higher fidelity OCR.",
      "Images are auto-resized to 1024px (~1MP) on the longest side by default. Use max_size=0 to send full original resolution, or max_size=N for a custom limit.",
    ],

    parameters: Type.Object({
      images: Type.Union(
        [
          Type.String({ description: "Path to image file" }),
          Type.Array(Type.String(), {
            description: "List of image file paths for batch processing",
          }),
        ],
        { description: "Image file path(s) to describe" },
      ),

      format: Type.Optional(
        Type.String({
          description:
            'Output format: "natural" (narrative text) or "structured" (JSON with objects/texts by default; with focus="ui-ux" additionally includes elements/layout/issues). Default: "natural".',
        }),
      ),

      focus: Type.Optional(
        Type.Union(
          FOCUS_MODES.map((m) => Type.Literal(m)),
          {
            description:
              'Analysis focus: "general" (default, thorough description), "ui-ux" (screenshot/UI analysis — layout, elements, spacing, issues), "diff" (visual diff — describe what changed), "state" (app state detection). '
              + 'Overrides default prompts with built-in expert prompts for each mode.',
          },
        ),
      ),

      tier: Type.Optional(
        Type.String({
          description:
            'Model tier: "local" (llamaswap/gemma4), "remote-free" (github-copilot/gpt-5-mini), "remote-paid" (opencode-go/qwen3.5-plus). Default: "local".',
        }),
      ),

      provider: Type.Optional(
        Type.String({
          description:
            'Explicit provider override (e.g., "llamaswap", "github-copilot"). Overrides tier.',
        }),
      ),

      model: Type.Optional(
        Type.String({
          description:
            'Explicit model override (e.g., "gemma4", "gpt-5-mini"). Overrides tier.',
        }),
      ),

      request: Type.Optional(
        Type.String({
          description:
            "Custom prompt for describing the image. Overrides both the default prompts and the focus mode entirely. Use when you need fully custom analysis instructions.",
        }),
      ),

      Language: Type.Optional(
        Type.String({
          description:
            "Optional — output language for the description (e.g., 'French', 'Spanish').",
        }),
      ),

      hint: Type.Optional(
        Type.String({
          description:
            "Optional lightweight context to guide the description, such as scene category or focus area. Use for context like 'game UI screenshot', 'settings panel', 'diff of before/after'. The focus mode handles what to look for; hint provides what scene.",
        }),
      ),

      max_size: Type.Optional(
        Type.Integer({
          description:
            "Max pixel dimension on the longest side (default: 1024). Images larger than this are resized before sending, saving bandwidth and speeding up analysis. ~1MP default is good for screenshots. Set to 0 for full original resolution, or set higher for detail-heavy images.",
          minimum: 0,
          maximum: 8192,
        }),
      ),

      concurrency: Type.Optional(
        Type.Integer({
          description: "Batch processing concurrency (default: 3).",
          minimum: 1,
          maximum: 10,
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        images: string | string[];
        format?: string;
        focus?: string;
        tier?: string;
        provider?: string;
        model?: string;
        request?: string;
        Language?: string;
        hint?: string;
        max_size?: number;
        concurrency?: number;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<{}>) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      // --- Normalise inputs ---
      const imagePaths =
        typeof params.images === "string" ? [params.images] : params.images;

      if (!imagePaths || imagePaths.length === 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "No images provided" }) },
          ],
          details: {},
        };
      }

      const tier = (params.tier ?? DEFAULT_TIER) as keyof typeof TIERS;
      const tierConfig = TIERS[tier] ?? TIERS[DEFAULT_TIER];
      const provider = params.provider?.trim() || tierConfig.provider;
      const modelId = params.model?.trim() || tierConfig.model;
      const format = params.format?.trim() || DEFAULT_FORMAT;
      const focus = (params.focus ?? DEFAULT_FOCUS) as FocusMode;
      const request = params.request?.trim();
      const language = params.Language?.trim();
      const hint = params.hint?.trim();
      const maxSize = params.max_size !== undefined ? params.max_size : DEFAULT_MAX_SIZE;
      const concurrency = params.concurrency ?? 3;

      const config = Object.fromEntries(
        Object.entries({ tier, provider, model: modelId, format, focus, max_size: maxSize, language, hint })
          .filter(([_, v]) => v !== undefined && v !== null && v !== ""),
      );

      // --- Build prompts ---
      const { systemPrompt, userPrompt } = request
        ? {
            systemPrompt:
              `You are an expert image analyst. Analyze the given image and respond to the user's request.\n\n${request}`,
            userPrompt: request,
          }
        : buildPrompts(format, language, hint, focus);

      if (onUpdate) {
        const sizeInfo = maxSize > 0 ? `, max_size=${maxSize}` : ", full resolution";
        onUpdate({
          content: [
            {
              type: "text",
              text: `Describing ${imagePaths.length} image(s) using ${provider}/${modelId} (${format} format, ${focus} focus${sizeInfo})…`,
            },
          ],
          details: {},
        });
      }

      // --- Process ---
      try {
        const results: Array<{
          path: string;
          description: string;
          error?: string;
        }> = [];

        for (let i = 0; i < imagePaths.length; i += concurrency) {
          const batchPaths = imagePaths.slice(i, i + concurrency);

          const batchResults = await Promise.all(
            batchPaths.map(async (path) => {
              try {
                const enc = await encodeImage(path, maxSize);
                const description = await describeImage(
                  enc,
                  provider,
                  modelId,
                  systemPrompt,
                  userPrompt,
                  ctx.modelRegistry,
                  signal,
                );
                return { path, description };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                ctx.ui.notify(`Error describing ${path}: ${message}`, "error");
                return { path, description: "", error: message };
              }
            }),
          );

          results.push(...batchResults);
        }

        // --- Return ---
        if (format === "structured") {
          const structured = results.map((r) => {
            if (r.error) return { path: r.path, error: r.error };
            const parsed = tryParseStructured(r.description);
            if (parsed) {
              // Include all top-level fields: objects, texts, elements, layout, issues, etc.
              return {
                path: r.path,
                objects: parsed.objects,
                texts: parsed.texts,
                ...(parsed.elements ? { elements: parsed.elements } : {}),
                ...(parsed.layout ? { layout: parsed.layout } : {}),
                ...(parsed.issues ? { issues: parsed.issues } : {}),
              };
            }
            return { path: r.path, raw: r.description };
          });

          return {
            content: [
              { type: "text", text: JSON.stringify(structured, null, 2) },
            ],
            details: { config },
          };
        }

        const natural = results
          .map((r) => {
            const header = `## ${r.path}`;
            const body = r.error ? `_Error:_ ${r.error}` : r.description;
            return `${header}\n\n${body}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: natural }],
          details: { config },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Picture descriptor error: ${message}`, "error");
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
