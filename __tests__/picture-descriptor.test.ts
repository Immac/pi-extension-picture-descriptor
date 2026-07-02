import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock pi-coding-agent for all tests (error-path tests throw before using it)
// ---------------------------------------------------------------------------

const { deferPrompt, resolveDeferredPrompt, shouldDeferPrompt } = vi.hoisted(() => {
  let shouldDefer = false;
  let resolvePrompt: (() => void) | null = null;
  return {
    shouldDeferPrompt: (v: boolean) => { shouldDefer = v; },
    deferPrompt: () => {
      if (shouldDefer) {
        return new Promise<void>((r) => { resolvePrompt = r; });
      }
      return Promise.resolve();
    },
    resolveDeferredPrompt: () => { resolvePrompt?.(); },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => {
  const session = {
    subscribe: vi.fn((cb: (event: any) => void) => {
      cb({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "A beautiful landscape with mountains." },
      });
      return () => {};
    }),
    prompt: vi.fn(() => deferPrompt()),
    abort: vi.fn(),
    dispose: vi.fn(),
    sessionId: "test-session",
    isStreaming: false,
    agent: {} as any,
    model: undefined,
    thinkingLevel: "off" as const,
    messages: [],
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    cycleModel: vi.fn(),
    cycleThinkingLevel: vi.fn(),
    navigateTree: vi.fn(),
    compact: vi.fn(),
    abortCompaction: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    sessionFile: undefined,
  };

  return {
    createAgentSession: vi.fn().mockResolvedValue({ session }),
    SessionManager: {
      inMemory: vi.fn(() => ({})),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock — vitest hoists mock calls)
// ---------------------------------------------------------------------------

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import {
  getMimeType,
  tryParseStructured,
  buildPrompts,
  describeImage,
  checkVisionModel,
  TIERS,
  FOCUS_MODES,
} from "../src/picture-descriptor.js";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// TIERS
// ---------------------------------------------------------------------------

describe("TIERS", () => {
  it("has five tiers with provider and model", () => {
    expect(TIERS.local).toEqual({ provider: "llamaswap", model: "gemma4" });
    expect(TIERS["remote-free"]).toEqual({
      provider: "github-copilot",
      model: "gpt-5-mini",
    });
    expect(TIERS["remote-cheap"]).toEqual({
      provider: "opencode-go",
      model: "mimo-v2.5",
    });
    expect(TIERS["remote-ux"]).toEqual({
      provider: "opencode-go",
      model: "kimi-k2.5",
    });
    expect(TIERS["remote-general"]).toEqual({
      provider: "opencode-go",
      model: "qwen3.6-plus",
    });
  });
});

// ---------------------------------------------------------------------------
// FOCUS_MODES
// ---------------------------------------------------------------------------

describe("FOCUS_MODES", () => {
  it("has four focus modes", () => {
    expect(FOCUS_MODES).toEqual(["general", "ui-ux", "diff", "state"]);
  });
});

// ---------------------------------------------------------------------------
// getMimeType
// ---------------------------------------------------------------------------

describe("getMimeType", () => {
  it("returns image/jpeg for .jpg", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
  });

  it("returns image/jpeg for .jpeg", () => {
    expect(getMimeType("photo.jpeg")).toBe("image/jpeg");
  });

  it("returns image/png for .png", () => {
    expect(getMimeType("screenshot.png")).toBe("image/png");
  });

  it("returns image/webp for .webp", () => {
    expect(getMimeType("image.webp")).toBe("image/webp");
  });

  it("returns image/gif for .gif", () => {
    expect(getMimeType("animation.gif")).toBe("image/gif");
  });

  it("defaults to image/jpeg for unknown extensions", () => {
    expect(getMimeType("file.bmp")).toBe("image/jpeg");
    expect(getMimeType("file.tiff")).toBe("image/jpeg");
    expect(getMimeType("file")).toBe("image/jpeg");
  });

  it("is case-insensitive", () => {
    expect(getMimeType("photo.PNG")).toBe("image/png");
    expect(getMimeType("photo.JPG")).toBe("image/jpeg");
    expect(getMimeType("photo.WebP")).toBe("image/webp");
  });
});

// ---------------------------------------------------------------------------
// tryParseStructured
// ---------------------------------------------------------------------------

describe("tryParseStructured", () => {
  it("parses valid JSON with objects and texts", () => {
    const input = JSON.stringify({
      objects: [{ name: "person", depth: "foreground" }],
      texts: [{ content: "HELLO", confidence: 0.95 }],
    });

    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "person", depth: "foreground" }]);
    expect(result!.texts).toEqual([{ content: "HELLO", confidence: 0.95 }]);
  });

  it("returns empty arrays when fields are missing", () => {
    const result = tryParseStructured(JSON.stringify({}));
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([]);
    expect(result!.texts).toEqual([]);
  });

  it("extracts JSON from a markdown code block with json tag", () => {
    const input =
      'Here is what I see:\n```json\n{"objects":[{"name":"cat"}],"texts":[]}\n```';
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "cat" }]);
    expect(result!.texts).toEqual([]);
  });

  it("extracts JSON from fenced code without language tag", () => {
    const input =
      '```\n{"objects":[{"name":"dog"}],"texts":[{"content":"WOOF"}]}\n```';
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "dog" }]);
    expect(result!.texts).toEqual([{ content: "WOOF" }]);
  });

  it("extracts JSON from bare braces as last resort", () => {
    const input =
      'The image contains {"objects":[{"name":"car"}],"texts":[]} and that\'s it.';
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "car" }]);
  });

  it("returns null for plain text", () => {
    expect(tryParseStructured("This is a plain text description.")).toBeNull();
    expect(tryParseStructured("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(tryParseStructured("{this is not json}")).toBeNull();
  });

  it("handles objects with extra fields gracefully", () => {
    const input = JSON.stringify({
      objects: [{ name: "tree", extra: "ignored" }],
      texts: [{ content: "text", extra_field: true }],
    });
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "tree", extra: "ignored" }]);
    expect(result!.texts).toEqual([{ content: "text", extra_field: true }]);
  });

  it("handles empty objects/texts arrays", () => {
    const input = JSON.stringify({ objects: [], texts: [] });
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([]);
    expect(result!.texts).toEqual([]);
  });

  it("passes through elements, layout, and issues from ui-ux structured output", () => {
    const input = JSON.stringify({
      elements: [
        { type: "button", name: "Submit", position: "bottom", state: "enabled" },
      ],
      layout: { structure: "single-column", spacing: "balanced", alignment: "center" },
      issues: [
        { severity: "minor", type: "contrast", description: "Low contrast" },
      ],
      texts: [{ content: "Hello", location: "header" }],
    });

    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.elements).toHaveLength(1);
    expect(result!.elements![0]).toMatchObject({ type: "button", name: "Submit" });
    expect(result!.layout).toMatchObject({ structure: "single-column" });
    expect(result!.issues).toHaveLength(1);
    expect(result!.issues![0]).toMatchObject({ severity: "minor", type: "contrast" });
    expect(result!.texts).toHaveLength(1);
    expect(result!.texts[0]).toMatchObject({ content: "Hello" });
  });

  it("defaults to empty objects/texts when ui-ux fields are absent", () => {
    const input = JSON.stringify({ elements: [], layout: {}, texts: [] });
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([]);
    expect(result!.texts).toEqual([]);
    expect(result!.elements).toEqual([]);
    expect(result!.layout).toEqual({});
    // issues should not be present
    expect(result!.issues).toBeUndefined();
  });

  it("still extracts objects+texts from markdown code block", () => {
    const input = 'Response:\n```json\n{"objects":[{"name":"cat"}],"texts":[]}\n```';
    const result = tryParseStructured(input);
    expect(result).not.toBeNull();
    expect(result!.objects).toEqual([{ name: "cat" }]);
  });
});

// ---------------------------------------------------------------------------
// buildPrompts
// ---------------------------------------------------------------------------

describe("buildPrompts", () => {
  describe("natural format", () => {
    it("returns system prompt and user prompt", () => {
      const { systemPrompt, userPrompt } = buildPrompts("natural");
      expect(systemPrompt).toContain("expert image analyst");
      expect(systemPrompt).toContain("Describe the image in detail");
      expect(userPrompt).toContain("Describe this image in detail");
    });

    it("includes language instruction when provided", () => {
      const { systemPrompt, userPrompt } = buildPrompts("natural", "French");
      expect(systemPrompt).toContain("Use French for the output");
      expect(userPrompt).toContain("Use French for the output");
    });

    it("includes hint when provided", () => {
      const { systemPrompt } = buildPrompts(
        "natural",
        undefined,
        "screenshot of a web app",
      );
      expect(systemPrompt).toContain("Context hint: screenshot of a web app");
    });

    it("includes both language and hint", () => {
      const { systemPrompt } = buildPrompts("natural", "Spanish", "UI design");
      expect(systemPrompt).toContain("Use Spanish for the output");
      expect(systemPrompt).toContain("Context hint: UI design");
    });

    it("instructs no JSON formatting", () => {
      const { systemPrompt } = buildPrompts("natural");
      expect(systemPrompt).toContain("no JSON formatting");
    });

    it("default general focus matches natural default", () => {
      const { systemPrompt } = buildPrompts("natural", undefined, undefined, "general");
      expect(systemPrompt).toContain("expert image analyst");
      expect(systemPrompt).toContain("Describe the image in detail");
    });
  });

  describe("ui-ux focus (natural)", () => {
    it("uses UX/UI engineer persona", () => {
      const { systemPrompt, userPrompt } = buildPrompts("natural", undefined, undefined, "ui-ux");
      expect(systemPrompt).toContain("UX/UI engineer");
      expect(systemPrompt).toContain("Layout structure");
      expect(systemPrompt).toContain("Spacing & alignment");
      expect(systemPrompt).toContain("Text & readability");
      expect(systemPrompt).toContain("Usability issues");
      expect(userPrompt).toContain("screenshot as a UI/UX engineer");
    });

    it("includes language and hint context", () => {
      const { systemPrompt } = buildPrompts("natural", "Spanish", "game UI", "ui-ux");
      expect(systemPrompt).toContain("Use Spanish for the output");
      expect(systemPrompt).toContain("Context hint: game UI");
      expect(systemPrompt).toContain("UX/UI engineer");
    });
  });

  describe("diff focus (natural)", () => {
    it("analyzes visual diffs", () => {
      const { systemPrompt, userPrompt } = buildPrompts("natural", undefined, undefined, "diff");
      expect(systemPrompt).toContain("visual diff image");
      expect(systemPrompt).toContain("Changed regions");
      expect(systemPrompt).toContain("State transitions");
      expect(userPrompt).toContain("What changed between the two screenshots");
    });
  });

  describe("state focus (natural)", () => {
    it("detects application state", () => {
      const { systemPrompt, userPrompt } = buildPrompts("natural", undefined, undefined, "state");
      expect(systemPrompt).toContain("Application state");
      expect(systemPrompt).toContain("UI readiness");
      expect(systemPrompt).toContain("Navigation context");
      expect(userPrompt).toContain("What state is the application in");
    });
  });

  describe("structured format", () => {
    it("returns prompts asking for JSON", () => {
      const { systemPrompt, userPrompt } = buildPrompts("structured");
      expect(systemPrompt).toContain("Return ONLY valid JSON");
      expect(systemPrompt).toContain("objects");
      expect(systemPrompt).toContain("texts");
    });

    it("includes the JSON schema with objects and texts", () => {
      const { systemPrompt } = buildPrompts("structured");
      expect(systemPrompt).toContain('"objects"');
      expect(systemPrompt).toContain('"texts"');
    });

    it("uses UI-ux schema when combined with ui-ux focus", () => {
      const { systemPrompt } = buildPrompts("structured", undefined, undefined, "ui-ux");
      expect(systemPrompt).toContain('"elements"');
      expect(systemPrompt).toContain('"layout"');
      expect(systemPrompt).toContain('"issues"');
      expect(systemPrompt).toContain('"texts"');
      // Should NOT contain the default objects schema
      expect(systemPrompt).not.toContain('"depth": "foreground|middle|background"');
    });

    it("uses default objects schema for non-ui-ux focus", () => {
      const { systemPrompt } = buildPrompts("structured", undefined, undefined, "diff");
      expect(systemPrompt).toContain('"objects"');
      expect(systemPrompt).toContain('"texts"');
    });

    it("includes language and hint", () => {
      const { systemPrompt } = buildPrompts(
        "structured",
        "German",
        "document scan",
      );
      expect(systemPrompt).toContain("Use German for the output");
      expect(systemPrompt).toContain("Context hint: document scan");
    });
  });
});

// ---------------------------------------------------------------------------
// checkVisionModel
// ---------------------------------------------------------------------------

describe("checkVisionModel", () => {
  it("returns null for non-vision model", () => {
    const model = { provider: "ollama", id: "codellama", input: ["text"] };
    expect(checkVisionModel(model, undefined)).toBeNull();
  });

  it("returns skip result for vision model", () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5", input: ["text", "image"] };
    const result = checkVisionModel(model, undefined);
    expect(result).not.toBeNull();
    expect(result!.skip).toBe(true);
    expect(result!.details.reason).toBe("calling model has vision");
    expect(result!.content[0].text).toContain("claude-sonnet-4-5");
  });

  it("returns null when force=true even for vision model", () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5", input: ["text", "image"] };
    expect(checkVisionModel(model, true)).toBeNull();
  });

  it("returns null for undefined model", () => {
    expect(checkVisionModel(undefined, undefined)).toBeNull();
  });

  it("returns null for model without input field", () => {
    const model = { provider: "ollama", id: "llama3" };
    expect(checkVisionModel(model, undefined)).toBeNull();
  });

  it("uses fallback name when provider or id missing", () => {
    const model = { input: ["text", "image"] };
    const result = checkVisionModel(model, undefined);
    expect(result!.content[0].text).toContain("your current model");
  });
});

// ---------------------------------------------------------------------------
// describeImage — error path (model not found)
// ---------------------------------------------------------------------------

describe("describeImage (error path)", () => {
  const mockEncoded = { mediaType: "image/jpeg", data: "fake-base64" };

  it("throws when model is not found in registry", async () => {
    const modelRegistry = {
      find: (_p: string, _m: string) => undefined,
    };

    await expect(
      describeImage(
        mockEncoded,
        "unknown-provider",
        "unknown-model",
        "system",
        "user",
        modelRegistry,
      ),
    ).rejects.toThrow(/not found in pi's model registry/);
  });

  it("throws with helpful error mentioning available tiers", async () => {
    const modelRegistry = {
      find: (_p: string, _m: string) => undefined,
    };

    await expect(
      describeImage(
        mockEncoded,
        "x",
        "y",
        "system",
        "user",
        modelRegistry,
      ),
    ).rejects.toThrow(/llamaswap/);
    await expect(
      describeImage(mockEncoded, "x", "y", "system", "user", modelRegistry),
    ).rejects.toThrow(/github-copilot/);
    await expect(
      describeImage(mockEncoded, "x", "y", "system", "user", modelRegistry),
    ).rejects.toThrow(/opencode-go/);
  });

  it("throws when modelRegistry is undefined", async () => {
    await expect(
      describeImage(
        mockEncoded,
        "any-provider",
        "any-model",
        "system",
        "user",
        undefined,
      ),
    ).rejects.toThrow(/not found in pi's model registry/);
  });
});

// ---------------------------------------------------------------------------
// describeImage — happy path (model found, sub-agent session called)
// ---------------------------------------------------------------------------

describe("describeImage (happy path)", () => {
  const mockEncoded = { mediaType: "image/jpeg", data: "fake-base64" };
  const mockModel = { id: "gemma4", provider: "llamaswap" } as unknown as Model<any>;

  it("returns description when model is found", async () => {
    const modelRegistry = {
      find: (_p: string, _m: string) => mockModel,
    };

    const result = await describeImage(
      mockEncoded,
      "llamaswap",
      "gemma4",
      "system prompt",
      "user prompt",
      modelRegistry,
    );

    expect(result).toBe("A beautiful landscape with mountains.");
  });

  it("propagates abort signal to sub-agent session", async () => {
    shouldDeferPrompt(true);

    const modelRegistry = {
      find: (_p: string, _m: string) => mockModel,
    };

    const abortController = new AbortController();

    const promise = describeImage(
      mockEncoded,
      "llamaswap",
      "gemma4",
      "system prompt",
      "user prompt",
      modelRegistry,
      abortController.signal,
    );

    // Wait for createAgentSession to resolve (microtask), so the
    // abort listener is registered and prompt is pending
    await new Promise((r) => setTimeout(r, 0));

    // Fire abort while session.prompt is still pending
    abortController.abort();

    // Now let prompt resolve
    resolveDeferredPrompt();
    await promise;

    // session.abort() was called by the onAbort listener
    const result = await vi
      .mocked(createAgentSession)
      .mock.results[0]?.value;
    expect(result?.session?.abort).toHaveBeenCalled();
  });
});
