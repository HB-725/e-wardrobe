import { AiError, type ChatUsage, type FetchLike, type ImageEditRequest, type ImageUsage, type OpenAiClient, type VisionJsonRequest } from '../client';

/**
 * Google Gemini (generativelanguage.googleapis.com, v1beta generateContent) behind the same interface as the OpenAI
 * client. Written from the public REST reference and covered by fake-fetch tests; not yet exercised against the live
 * API (no Gemini key in development).
 *
 * - Images go in as inlineData parts; image models answer with inlineData parts (base64), asked for with
 *   responseModalities and an aspect ratio, since Gemini has no pixel-size parameter.
 * - JSON answers use responseMimeType application/json with a responseSchema, which is an OpenAPI-style subset of
 *   JSON Schema: see toGeminiSchema.
 * - quality, detail, transparency and schema names have no Gemini equivalent and are ignored.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FAST_FAIL_MS = 5000;

/** finishReason / blockReason values that mean the request or its result was refused by a safety filter. */
const REFUSED = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|OTHER_BLOCK/;

const ASPECT: Record<NonNullable<ImageEditRequest['size']>, string> = {
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
};

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

interface Part {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export function classifyGemini(status: number, body: string): AiError {
  let parsed: GeminiErrorBody = {};
  try {
    parsed = JSON.parse(body) as GeminiErrorBody;
  } catch {
    // not JSON
  }
  const msg = parsed.error?.message ?? (body.slice(0, 200) || `HTTP ${status}`);
  const code = parsed.error?.status ?? '';
  const reasons = (parsed.error?.details ?? []).map((d) => d.reason ?? '');
  if (reasons.includes('API_KEY_INVALID') || /api key not valid|API key expired/i.test(msg) || status === 401) return new AiError('auth', msg, status);
  if (/location is not supported/i.test(msg)) return new AiError('auth', msg, status);
  if (status === 404 || code === 'NOT_FOUND') return new AiError('model', msg, status);
  if (status === 403 || code === 'PERMISSION_DENIED') {
    if (/\bmodel\b/i.test(msg)) return new AiError('model', msg, status);
    return new AiError('auth', msg, status);
  }
  if (status === 429 || code === 'RESOURCE_EXHAUSTED') return new AiError(/billing|prepay|credit/i.test(msg) ? 'quota' : 'rate', msg, status);
  if (status >= 500) return new AiError('server', msg, status);
  if (/\bmodel\b[^.]*\b(not found|not supported|is not available|does not support)/i.test(msg)) return new AiError('model', msg, status);
  return new AiError('rejected', msg, status);
}

type Json = Record<string, unknown>;

/**
 * JSON Schema (as written for OpenAI strict mode) to Gemini's responseSchema: upper-case types, `nullable` instead of a
 * "null" member, no additionalProperties, and propertyOrdering so fields come back in the order they were declared.
 */
export function toGeminiSchema(schema: Json): Json {
  const out: Json = {};
  let types = schema.type;
  let nullable = false;
  if (Array.isArray(types)) {
    nullable = types.includes('null');
    types = (types as string[]).find((t) => t !== 'null');
  }
  if (typeof types === 'string') out.type = types.toUpperCase();
  if (Array.isArray(schema.enum)) {
    if (schema.enum.includes(null)) nullable = true;
    out.enum = schema.enum.filter((v) => v !== null).map(String);
    out.type = 'STRING';
  }
  if (nullable) out.nullable = true;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
  if (schema.items && typeof schema.items === 'object') out.items = toGeminiSchema(schema.items as Json);
  if (schema.properties && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, Json>;
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(props);
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  return out;
}

/** data:image/jpeg;base64,xxxx → { mimeType, data } */
function inline(dataUrl: string): Part {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new AiError('bad_response', 'image is not a base64 data URL');
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

function refusal(r: GenerateResponse): string | null {
  const block = r.promptFeedback?.blockReason;
  if (block) return `blocked: ${block}`;
  const finish = r.candidates?.[0]?.finishReason;
  if (finish && REFUSED.test(finish)) return `blocked: ${finish}`;
  return null;
}

export function createGeminiClient(opts: { apiKey: string; fetch?: FetchLike; baseUrl?: string; timeoutMs?: number }): OpenAiClient {
  const base = opts.baseUrl ?? BASE;
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 180_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!opts.apiKey) throw new AiError('no_key', 'missing api key');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const started = Date.now();
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      if (ctrl?.signal.aborted) throw new AiError('timeout', `no response in ${timeoutMs / 1000}s`);
      // Same rule as the OpenAI client: a connection dropped after a while may already have been billed.
      if (Date.now() - started > FAST_FAIL_MS) throw new AiError('timeout', `connection lost: ${e instanceof Error ? e.message : String(e)}`);
      throw new AiError('network', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw classifyGemini(res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AiError('bad_response', 'invalid JSON from API');
    }
  }

  async function generateImage(req: ImageEditRequest): Promise<{ image: string; usage: ImageUsage }> {
    const r = await call<GenerateResponse>('POST', `/models/${encodeURIComponent(req.model)}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: req.prompt }, ...req.images.map(inline)] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ASPECT[req.size ?? '1024x1536'] } },
    });
    const refused = refusal(r);
    if (refused) throw new AiError('rejected', refused);
    // Thinking image models may also return draft images marked as thoughts; only the final one counts.
    const part = (r.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.inlineData?.data).pop();
    if (!part?.inlineData?.data) throw new AiError('bad_response', 'no image returned');
    const u = r.usageMetadata ?? {};
    return { image: part.inlineData.data, usage: { textIn: u.promptTokenCount ?? 0, imageIn: 0, out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } };
  }

  return {
    async listModels() {
      const ids: string[] = [];
      let token = '';
      // A handful of pages at most; the cap only guards against a server that keeps returning a token.
      for (let page = 0; page < 10; page++) {
        const r = await call<{ models?: { name?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }>(
          'GET',
          `/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        );
        for (const m of r.models ?? []) {
          if (m.name && (m.supportedGenerationMethods ?? []).includes('generateContent')) ids.push(m.name.replace(/^models\//, ''));
        }
        if (!r.nextPageToken) break;
        token = r.nextPageToken;
      }
      return ids;
    },

    async imageEdit(req) {
      // One image per call: candidateCount is not available for image output, so candidates are separate requests.
      const results = await Promise.all(Array.from({ length: Math.max(1, req.n ?? 1) }, () => generateImage(req)));
      return {
        images: results.map((x) => x.image),
        usage: results.reduce<ImageUsage>((a, x) => ({ textIn: a.textIn + x.usage.textIn, imageIn: 0, out: a.out + x.usage.out }), { textIn: 0, imageIn: 0, out: 0 }),
      };
    },

    async visionJson<T>(req: VisionJsonRequest): Promise<{ data: T; usage: ChatUsage }> {
      const r = await call<GenerateResponse>('POST', `/models/${encodeURIComponent(req.model)}:generateContent`, {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.text }, ...req.images.map(inline)] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.schema) },
      });
      const refused = refusal(r);
      if (refused) throw new AiError('rejected', refused);
      const text = (r.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new AiError('bad_response', 'model did not return JSON');
      }
      const u = r.usageMetadata ?? {};
      return { data, usage: { in: u.promptTokenCount ?? 0, out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } };
    },
  };
}
