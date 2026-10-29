/** Minimal OpenAI REST client: just the three calls the app makes, with errors classified for retry. */

export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

export interface ImageInput {
  uri: string;
  name: string;
  type: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Image-generation calls report image input tokens separately. */
  imageInputTokens?: number;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function messageFor(status: number, apiMessage: string | null): string {
  if (status === 401) return 'API Key 无效，请到「我的」重新填写';
  if (status === 403) return 'API Key 没有权限使用这个模型';
  if (status === 429) return apiMessage?.includes('quota') ? 'OpenAI 账户余额不足' : '请求太频繁，稍后自动重试';
  if (status >= 500) return 'OpenAI 服务暂时不可用，稍后自动重试';
  return apiMessage ?? `请求失败（${status}）`;
}

export class OpenAIClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new OpenAIError(aborted ? '请求超时，稍后自动重试' : '网络连接失败，稍后自动重试', null, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const apiMessage: string | null = body?.error?.message ?? null;
      const code: string | null = body?.error?.code ?? null;
      const insufficientQuota = code === 'insufficient_quota';
      const retryable = (res.status === 429 && !insufficientQuota) || res.status >= 500;
      throw new OpenAIError(
        insufficientQuota ? 'OpenAI 账户余额不足' : messageFor(res.status, apiMessage),
        res.status,
        retryable,
        code,
      );
    }
    return body as T;
  }

  async listModels(): Promise<string[]> {
    const body = await this.request<{ data: { id: string }[] }>('/models', { method: 'GET' });
    return (body?.data ?? []).map((m) => m.id);
  }

  /** Chat completion constrained to a JSON schema; returns the parsed object. */
  async chatJson<T>(args: {
    model: string;
    system: string;
    content: ContentPart[];
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ data: T; usage: TokenUsage }> {
    const isReasoning = /^(gpt-5|o\d)/.test(args.model);
    const body: Record<string, unknown> = {
      model: args.model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: args.schemaName, strict: true, schema: args.schema },
      },
      max_completion_tokens: args.maxTokens ?? (isReasoning ? 4000 : 1200),
    };
    if (isReasoning) body.reasoning_effort = 'low';
    const res = await this.request<any>('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const choice = res?.choices?.[0];
    const raw: string | undefined = choice?.message?.content;
    if (choice?.message?.refusal) throw new OpenAIError('AI 拒绝处理这张图片', null, false, 'refusal');
    if (!raw) throw new OpenAIError('AI 没有返回结果', null, true);
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      throw new OpenAIError('AI 返回的格式不正确', null, true);
    }
    return {
      data,
      usage: { inputTokens: res?.usage?.prompt_tokens ?? 0, outputTokens: res?.usage?.completion_tokens ?? 0 },
    };
  }

  /** images/edits with one or more reference images; returns base64 of the single output image. */
  async editImage(args: {
    model: string;
    prompt: string;
    images: ImageInput[];
    size: '1024x1024' | '1024x1536' | '1536x1024';
    quality: 'low' | 'medium' | 'high';
    outputFormat?: 'png' | 'jpeg' | 'webp';
    /** Not every image model accepts this; callers only pass it when the model supports it. */
    inputFidelity?: 'low' | 'high';
  }): Promise<{ b64: string; usage: TokenUsage }> {
    if (args.images.length === 0) throw new OpenAIError('缺少参考图片', null, false);
    const form = new FormData();
    if (args.inputFidelity) form.append('input_fidelity', args.inputFidelity);
    form.append('model', args.model);
    form.append('prompt', args.prompt);
    form.append('size', args.size);
    form.append('quality', args.quality);
    form.append('n', '1');
    form.append('output_format', args.outputFormat ?? 'jpeg');
    for (const img of args.images) {
      // React Native's FormData accepts { uri, name, type } file descriptors.
      form.append('image[]', img as unknown as Blob);
    }
    const res = await this.request<any>('/images/edits', { method: 'POST', body: form });
    const b64: string | undefined = res?.data?.[0]?.b64_json;
    if (!b64) throw new OpenAIError('AI 没有返回图片', null, true);
    const u = res?.usage;
    return {
      b64,
      usage: {
        inputTokens: u?.input_tokens_details?.text_tokens ?? u?.input_tokens ?? 0,
        imageInputTokens: u?.input_tokens_details?.image_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
      },
    };
  }
}
