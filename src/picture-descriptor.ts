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

/** Read an image file from disk and encode it as base64. */
export async function encodeImage(path: string): Promise<{ mediaType: string; data: string }> {
  const buffer = await readFile(path);
  return {
    mediaType: getMimeType(path),
    data: buffer.toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// JSON extraction for structured mode
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a string as structured JSON with objects[] and texts[].
 * Tries direct JSON.parse first, then falls back to extracting from
 * markdown code blocks or top-level braces.
 * Returns null if all attempts fail.
 */
export function tryParseStructured(
  content: string,
): { objects: unknown[]; texts: unknown[] } | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      return {
        objects: Array.isArray(parsed.objects) ? parsed.objects : [],
        texts: Array.isArray(parsed.texts) ? parsed.texts : [],
      };
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
        return {
          objects: Array.isArray(parsed.objects) ? parsed.objects : [],
          texts: Array.isArray(parsed.texts) ? parsed.texts : [],
        };
      }
    } catch {
      // extracted text wasn't valid JSON either
    }
  }

  return null;
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

  try {
    let description = "";
    session.subscribe((event: any) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        description += event.assistantMessageEvent.delta;
      }
    });

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
): { systemPrompt: string; userPrompt: string } {
  const langInst = language?.trim()
    ? `\nUse ${language.trim()} for the output.`
    : "";

  const hintInst = hint?.trim()
    ? `\nContext hint: ${hint.trim()}`
    : "";

  if (format === "structured") {
    return {
      systemPrompt:
        `You are an expert image analyst. Analyze the given image and list all visible objects and text.

Return ONLY valid JSON in this exact format (no additional text, no markdown formatting):
{
  "objects": [
    {"name": "object name", "depth": "foreground|middle|background"}
  ],
  "texts": [
    {"content": "text content", "confidence": 0.95}
  ]
}

Be thorough — list ALL visible objects and text. You may include estimated depth (foreground/middle/background) and OCR confidence.${langInst}${hintInst}`,
      userPrompt:
        `List all visible objects and text in this image as JSON. Be thorough.${langInst}${hintInst}`,
    };
  }

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
      `Describes images using AI via pi sub-agent sessions. ` +
      `Three tiers: local (llamaswap/gemma4), remote-free (github-copilot/gpt-5-mini), ` +
      `remote-paid (opencode-go/qwen3.5-plus). ` +
      `Two formats: "natural" (narrative text) or "structured" (JSON with objects[] and texts[]).`,

    promptSnippet:
      "Spawns a vision-capable pi sub-agent to describe images — local gemma4 by default.",

    promptGuidelines: [
      "Use picture-describe when you need to analyze or describe an image.",
      "All providers go through pi's model registry — configure providers in ~/.pi/agent/models.json.",
      "Tiers: local (llamaswap/gemma4), remote-free (github-copilot/gpt-5-mini), remote-paid (opencode-go/qwen3.5-plus).",
      "Use format='structured' for JSON output with objects[] and texts[].",
      "The 'request' parameter customizes the description prompt — omit for a thorough default.",
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
            'Output format: "natural" (narrative text) or "structured" (JSON with objects/texts). Default: "natural".',
        }),
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
            "Custom prompt for describing the image. Overrides the default description prompt.",
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
            "Optional extra context to guide the description, such as scene category or focus area.",
        }),
      ),

      concurrency: Type.Optional(
        Type.Number({
          description: "Batch processing concurrency (default: 3).",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        images: string | string[];
        format?: string;
        tier?: string;
        provider?: string;
        model?: string;
        request?: string;
        Language?: string;
        hint?: string;
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
      const request = params.request?.trim();
      const language = params.Language?.trim();
      const hint = params.hint?.trim();
      const concurrency = params.concurrency ?? 3;

      const config = Object.fromEntries(
        Object.entries({ tier, provider, model: modelId, format, language, hint })
          .filter(([_, v]) => v !== undefined && v !== null && v !== ""),
      );

      // --- Build prompts ---
      const { systemPrompt, userPrompt } = request
        ? {
            systemPrompt:
              `You are an expert image analyst. Analyze the given image and respond to the user's request.\n\n${request}`,
            userPrompt: request,
          }
        : buildPrompts(format, language, hint);

      if (onUpdate) {
        onUpdate({
          content: [
            {
              type: "text",
              text: `Describing ${imagePaths.length} image(s) using ${provider}/${modelId} (${format} format)…`,
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
                const enc = await encodeImage(path);
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
              return { path: r.path, objects: parsed.objects, texts: parsed.texts };
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
