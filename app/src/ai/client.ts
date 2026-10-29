/**
 * Minimal OpenAI REST client. Uses JSON bodies only (images/edits accepts data URLs), so the same code runs on
 * Android, iOS, web and in Jest without multipart uploads.
 */

export type AiErrorKind =
  | 'no_key' // user has not entered a key
  | 'auth' // key rejected
  | 'quota' // account out of credit
  | 'cap' // monthly in-app spend cap reached
  | 'consent' // user has not agreed to photos being sent to OpenAI
  | 'rate' // 429 rate limit, retry later
  | 'network' // could not connect (offline); nothing was sent
  | 'timeout' // no answer in time; the request may still have been processed (and billed)
  | 'server' // 5xx
  | 'model' // model unavailable or deprecated, pick another
  | 'rejected' // request refused (safety system, bad image)
  | 'bad_response'; // response did not match the expected shape

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }

  /** Worth trying the same request again later. */
  get retryable(): boolean {
    return this.kind === 'rate' || this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'model' || this.kind === 'bad_response';
  }

  /** Cannot succeed until the user changes something (key, credit, cap). */
  get needsUser(): boolean {
    return this.kind === 'no_key' || this.kind === 'auth' || this.kind === 'quota' || this.kind === 'cap' || this.kind === 'consent';
  }
}

/** Short Chinese explanation for the UI. */
/** `interactive`: the user is waiting on screen and retries by hand, so do not promise an automatic retry. */
export function describeAiError(e: unknown, interactive = false): string {
  if (!(e instanceof AiError)) return e instanceof Error ? e.message : String(e);
  if (interactive && e.kind === 'network') return '网络连接失败，请检查网络后重试';
  if (interactive && e.kind === 'timeout') return 'AI 太久没有回应，请稍后重试';
  if (interactive && (e.kind === 'rate' || e.kind === 'server' || e.kind === 'bad_response')) return 'AI 服务暂时不可用，请稍后重试';
  switch (e.kind) {
    case 'no_key':
      return '还没有填写 API Key，去「我的」页面填写';
    case 'auth':
      return 'API Key 无效或已失效，去「我的」页面更换';
    case 'quota':
      return 'OpenAI 账户余额不足，充值后会自动继续';
    case 'cap':
      return '已达到本月 AI 花费上限，可在「我的」页面提高上限';
    case 'consent':
      return '需要你同意把照片发送给 OpenAI，才能继续生成';
    case 'rate':
      return '请求太频繁，稍后自动重试';
    case 'network':
      return '网络连接失败，联网后会自动继续';
    case 'timeout':
      return 'AI 太久没有回应，稍后自动重试';
    case 'server':
      return 'AI 服务暂时不可用，稍后自动重试';
    case 'model':
      return '当前模型不可用，正在换用其他模型';
    case 'rejected':
      return 'AI 拒绝了这张图片，换一张照片试试';
    case 'bad_response':
      return 'AI 返回的结果无法识别，稍后自动重试';
  }
}

export interface ImageUsage {
  textIn: number;
  imageIn: number;
  out: number;
}

export interface ChatUsage {
  in: number;
  out: number;
}

export interface ImageEditRequest {
  model: string;
  prompt: string;
  /** data: URLs */
  images: string[];
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  quality?: 'low' | 'medium' | 'high';
  n?: number;
  /** Transparent output needs webp (or png); catalog cut-outs use it so they sit on any background. */
  transparent?: boolean;
}

export interface VisionJsonRequest {
  model: string;
  system: string;
  text: string;
  /** data: URLs, sent in order after the text */
  images: string[];
  detail?: 'low' | 'high' | 'auto';
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface OpenAiClient {
  listModels(): Promise<string[]>;
  imageEdit(req: ImageEditRequest): Promise<{ images: string[]; usage: ImageUsage }>;
  visionJson<T>(req: VisionJsonRequest): Promise<{ data: T; usage: ChatUsage }>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface ApiErrorBody {
  error?: { message?: string; code?: string | null; type?: string };
}

export function classify(status: number, body: string): AiError {
  let parsed: ApiErrorBody = {};
  try {
    parsed = JSON.parse(body) as ApiErrorBody;
  } catch {
    // not JSON
  }
  const msg = parsed.error?.message ?? (body.slice(0, 200) || `HTTP ${status}`);
  const code = parsed.error?.code ?? '';
  if (status === 401 || status === 403) {
    // 403 is also used for "organization must be verified" on some image models; treat as model unavailable.
    if (/verif|not have access|does not have access/i.test(msg)) return new AiError('model', msg, status);
    return new AiError('auth', msg, status);
  }
  if (status === 429) return new AiError(code === 'insufficient_quota' || /quota|billing/i.test(msg) ? 'quota' : 'rate', msg, status);
  if (status >= 500) return new AiError('server', msg, status);
  // Only errors about the model itself switch models; a rejected parameter ("x not supported") must not, or every
  // later job would silently move to a pricier model.
  if (code === 'model_not_found' || status === 404 || /\bmodel\b[^.]*\b(does not exist|has been deprecated|not found|is not available)/i.test(msg)) {
    return new AiError('model', msg, status);
  }
  if (code === 'moderation_blocked' || /safety|moderation/i.test(msg)) return new AiError('rejected', msg, status);
  if (code === 'billing_hard_limit_reached') return new AiError('quota', msg, status);
  return new AiError('rejected', msg, status);
}

/** Reasoning models need an effort setting; the cheapest one keeps latency and cost close to non-reasoning models. */
export function reasoningEffort(model: string): string | null {
  if (/^gpt-5\.\d/.test(model) || /^gpt-6/.test(model)) return 'none';
  if (/^gpt-5(-|$)/.test(model)) return 'minimal';
  if (/^o\d/.test(model)) return 'low';
  return null;
}

export function createOpenAiClient(opts: {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}): OpenAiClient {
  const base = opts.baseUrl ?? 'https://api.openai.com/v1';
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 180_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!opts.apiKey) throw new AiError('no_key', 'missing api key');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      if (ctrl?.signal.aborted) throw new AiError('timeout', `no response in ${timeoutMs / 1000}s`);
      throw new AiError('network', e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw classify(res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AiError('bad_response', 'invalid JSON from API');
    }
  }

  return {
    async listModels() {
      const r = await call<{ data?: { id: string }[] }>('GET', '/models');
      return (r.data ?? []).map((m) => m.id);
    },

    async imageEdit(req) {
      const r = await call<{
        data?: { b64_json?: string }[];
        usage?: { input_tokens_details?: { image_tokens?: number; text_tokens?: number }; output_tokens?: number };
      }>('POST', '/images/edits', {
        model: req.model,
        prompt: req.prompt,
        images: req.images.map((image_url) => ({ image_url })),
        size: req.size ?? '1024x1536',
        quality: req.quality ?? 'low',
        n: req.n ?? 1,
        background: req.transparent ? 'transparent' : 'opaque',
        output_format: req.transparent ? 'webp' : 'jpeg',
        output_compression: req.transparent ? 80 : 90,
      });
      const images = (r.data ?? []).map((d) => d.b64_json).filter((x): x is string => !!x);
      if (images.length === 0) throw new AiError('bad_response', 'no image returned');
      return {
        images,
        usage: {
          textIn: r.usage?.input_tokens_details?.text_tokens ?? 0,
          imageIn: r.usage?.input_tokens_details?.image_tokens ?? 0,
          out: r.usage?.output_tokens ?? 0,
        },
      };
    },

    async visionJson<T>(req: VisionJsonRequest) {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [
          { role: 'system', content: req.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: req.text },
              ...req.images.map((url) => ({ type: 'image_url', image_url: { url, detail: req.detail ?? 'low' } })),
            ],
          },
        ],
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      };
      const effort = reasoningEffort(req.model);
      if (effort) body.reasoning_effort = effort;
      const r = await call<{
        choices?: { message?: { content?: string | null; refusal?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>('POST', '/chat/completions', body);
      const msg = r.choices?.[0]?.message;
      if (msg?.refusal) throw new AiError('rejected', msg.refusal);
      let data: T;
      try {
        data = JSON.parse(msg?.content ?? '') as T;
      } catch {
        throw new AiError('bad_response', 'model did not return JSON');
      }
      return { data, usage: { in: r.usage?.prompt_tokens ?? 0, out: r.usage?.completion_tokens ?? 0 } };
    },
  };
}

/** Where the user fixes a paused queue: the spend cap lives on the Me page, everything else on the key page. */
export function blockedRoute(kind: string | null): '/me' | '/apikey' | '/consent' {
  return kind === 'cap' ? '/me' : kind === 'consent' ? '/consent' : '/apikey';
}
