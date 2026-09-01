import type { AiChunk, AiRequest } from "@scriv/host-api";

/**
 * Pluggable AI behind one interface, keyed by env var.
 *
 * Contract, from the house rules:
 *   - Selection is by whichever key is present. Nothing is hardcoded, nothing is defaulted to
 *     a key baked into the source.
 *   - With no key set, `available()` is false, `stream()` yields a single error chunk, and
 *     **no network request is ever made**. `available()` itself never touches the network:
 *     it is a pure env lookup, so an offline scriv is silent on the wire, not merely failing.
 */
export interface AiProvider {
  readonly name: string;
  stream(req: AiRequest): AsyncGenerator<AiChunk, void, void>;
}

/**
 * Read as a bag of strings rather than a named shape so any env source (Bun.env, process.env,
 * a test fixture) can be passed without casting, and so an unset key is genuinely `undefined`.
 */
export type AiEnv = Readonly<Record<string, string | undefined>>;

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";
const OPENAI_DEFAULT_MODEL = "gpt-4o";

/** Returns the configured provider, or null when no key is set. */
export function selectProvider(env: AiEnv): AiProvider | null {
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) {
    return new AnthropicProvider(
      anthropic,
      env.SCRIV_AI_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL,
      env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com",
    );
  }
  const openai = env.OPENAI_API_KEY?.trim();
  if (openai) {
    return new OpenAiProvider(
      openai,
      env.SCRIV_AI_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
      env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
    );
  }
  return null;
}

export class AiService {
  private readonly provider: AiProvider | null;
  constructor(env: AiEnv) {
    this.provider = selectProvider(env);
  }

  /** Pure env lookup. No request, no DNS, nothing on the wire. */
  available(): boolean {
    return this.provider !== null;
  }

  providerName(): string {
    return this.provider?.name ?? "none";
  }

  async *stream(req: AiRequest): AsyncGenerator<AiChunk, void, void> {
    if (!this.provider) {
      yield {
        type: "error",
        message: "No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart the server.",
      };
      return;
    }
    yield* this.provider.stream(req);
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (SSE)
// ---------------------------------------------------------------------------

class AnthropicProvider implements AiProvider {
  readonly name: string;
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {
    this.name = `anthropic:${model}`;
  }

  async *stream(req: AiRequest): AsyncGenerator<AiChunk, void, void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          ...(req.system ? { system: req.system } : {}),
          stream: true,
          messages: [{ role: "user", content: req.prompt }],
        }),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", message: `anthropic request failed: ${message(err)}` };
      return;
    }

    if (!res.ok || !res.body) {
      yield { type: "error", message: `anthropic ${res.status}: ${(await safeText(res)).slice(0, 500)}` };
      return;
    }

    for await (const ev of sse(res.body)) {
      if (!ev.data || ev.data === "[DONE]") continue;
      let payload: AnthropicEvent;
      try {
        payload = JSON.parse(ev.data) as AnthropicEvent;
      } catch {
        continue;
      }
      if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta" && payload.delta.text) {
        yield { type: "text", text: payload.delta.text };
      } else if (payload.type === "error") {
        yield { type: "error", message: payload.error?.message ?? "anthropic stream error" };
        return;
      } else if (payload.type === "message_stop") {
        yield { type: "done" };
        return;
      }
    }
    yield { type: "done" };
  }
}

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (SSE)
// ---------------------------------------------------------------------------

class OpenAiProvider implements AiProvider {
  readonly name: string;
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {
    this.name = `openai:${model}`;
  }

  async *stream(req: AiRequest): AsyncGenerator<AiChunk, void, void> {
    const messages: { role: string; content: string }[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: req.prompt });

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          stream: true,
        }),
        signal: req.signal,
      });
    } catch (err) {
      yield { type: "error", message: `openai request failed: ${message(err)}` };
      return;
    }

    if (!res.ok || !res.body) {
      yield { type: "error", message: `openai ${res.status}: ${(await safeText(res)).slice(0, 500)}` };
      return;
    }

    for await (const ev of sse(res.body)) {
      if (!ev.data) continue;
      if (ev.data === "[DONE]") {
        yield { type: "done" };
        return;
      }
      let payload: OpenAiEvent;
      try {
        payload = JSON.parse(ev.data) as OpenAiEvent;
      } catch {
        continue;
      }
      if (payload.error) {
        yield { type: "error", message: payload.error.message ?? "openai stream error" };
        return;
      }
      const text = payload.choices?.[0]?.delta?.content;
      if (text) yield { type: "text", text };
    }
    yield { type: "done" };
  }
}

interface OpenAiEvent {
  choices?: { delta?: { content?: string } }[];
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// Shared SSE reader
// ---------------------------------------------------------------------------

/** Parses `text/event-stream` framing: blank-line-separated records of `field: value` lines. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // Records end at a blank line; tolerate both CRLF and LF framing.
      while ((idx = findRecordEnd(buffer)) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(\r?\n){2}/, "");
        const parsed = parseRecord(raw);
        if (parsed) yield parsed;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function findRecordEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function parseRecord(raw: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
