import { AiError, type FetchLike } from '../client';
import { AUTOFILL_SCHEMA, FIDELITY_SCHEMA, MIRROR_SCHEMA } from '../prompts';
import { classifyGemini, createGeminiClient, toGeminiSchema } from '../providers/gemini';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { fetch, calls };
}

const IMG = 'data:image/jpeg;base64,QUJD';

describe('Gemini client', () => {
  it('sends images inline with a 2:3 aspect ratio and returns the final (non-thought) image with its usage', async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'DRAFT' }, thought: true }, { text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'FINAL' } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 1290 },
        },
      },
    ]);
    const c = createGeminiClient({ apiKey: 'g-key', fetch });
    const r = await c.imageEdit({ model: 'gemini-2.5-flash-image', prompt: 'make a catalog photo', images: [IMG, 'data:image/png;base64,REVG'], size: '1024x1536', quality: 'high' });
    expect(r).toEqual({ images: ['FINAL'], usage: { textIn: 600, imageIn: 0, out: 1290 } });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe('g-key');
    expect(calls[0].body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'make a catalog photo' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }, { inlineData: { mimeType: 'image/png', data: 'REVG' } }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } },
    });
  });

  it('makes one request per candidate and adds up the usage', async () => {
    const { fetch, calls } = fakeFetch([{ body: { candidates: [{ content: { parts: [{ inlineData: { data: 'X' } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 } } }]);
    const r = await createGeminiClient({ apiKey: 'k', fetch }).imageEdit({ model: 'm', prompt: 'p', images: [IMG], n: 2 });
    expect(calls).toHaveLength(2);
    expect(r.images).toEqual(['X', 'X']);
    expect(r.usage).toEqual({ textIn: 20, imageIn: 0, out: 200 });
  });

  it('reports safety blocks as rejected and a text-only answer as a bad response', async () => {
    const blocked = fakeFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
    await expect(createGeminiClient({ apiKey: 'k', fetch: blocked.fetch }).imageEdit({ model: 'm', prompt: 'p', images: [IMG] })).rejects.toMatchObject({ kind: 'rejected' });
    const imageSafety = fakeFetch([{ body: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] } }]);
    await expect(createGeminiClient({ apiKey: 'k', fetch: imageSafety.fetch }).imageEdit({ model: 'm', prompt: 'p', images: [IMG] })).rejects.toMatchObject({ kind: 'rejected' });
    const textOnly = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'I cannot draw that' }] }, finishReason: 'STOP' }] } }]);
    await expect(createGeminiClient({ apiKey: 'k', fetch: textOnly.fetch }).imageEdit({ model: 'm', prompt: 'p', images: [IMG] })).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('asks for JSON with a converted schema and parses the answer', async () => {
    const { fetch, calls } = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: '{"name":"夹克",' }, { text: '"slot":"outer"}' }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 10 } } }]);
    const r = await createGeminiClient({ apiKey: 'k', fetch }).visionJson<{ name: string; slot: string }>({ model: 'gemini-2.5-flash-lite', system: 'sys', text: 'describe', images: [IMG], schemaName: 'autofill', schema: AUTOFILL_SCHEMA });
    expect(r).toEqual({ data: { name: '夹克', slot: 'outer' }, usage: { in: 900, out: 50 } });
    const body = calls[0].body as { systemInstruction: unknown; generationConfig: { responseMimeType: string; responseSchema: { type: string } } };
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
  });

  it('lists generateContent models across pages without the models/ prefix', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { models: [{ name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent', 'countTokens'] }, { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' } },
      { body: { models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] } },
    ]);
    expect(await createGeminiClient({ apiKey: 'k', fetch }).listModels()).toEqual(['gemini-2.5-flash-image', 'gemini-2.5-flash-lite']);
    expect(calls[1].url).toContain('pageToken=p2');
  });

  it('classifies API errors into the app error kinds', () => {
    const err = (status: number, s: string, message: string, reason?: string) => classifyGemini(status, JSON.stringify({ error: { code: status, status: s, message, details: reason ? [{ reason }] : [] } })).kind;
    expect(err(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', 'API_KEY_INVALID')).toBe('auth');
    expect(err(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.')).toBe('auth');
    expect(err(403, 'PERMISSION_DENIED', 'Method doesn\'t allow unregistered callers')).toBe('auth');
    expect(err(404, 'NOT_FOUND', 'models/gemini-9 is not found for API version v1beta')).toBe('model');
    expect(err(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.')).toBe('quota');
    expect(err(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).')).toBe('rate');
    expect(err(503, 'UNAVAILABLE', 'The model is overloaded.')).toBe('server');
    expect(err(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.')).toBe('rejected');
    expect(classifyGemini(502, '<html>bad gateway</html>')).toBeInstanceOf(AiError);
  });

  it('treats a quick connection failure as offline and a missing key as no_key', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('Network request failed');
    };
    await expect(createGeminiClient({ apiKey: 'k', fetch: down }).listModels()).rejects.toMatchObject({ kind: 'network' });
    await expect(createGeminiClient({ apiKey: '', fetch: down }).listModels()).rejects.toMatchObject({ kind: 'no_key' });
  });
});

describe('toGeminiSchema', () => {
  it('turns strict JSON Schema into Gemini responseSchema', () => {
    expect(
      toGeminiSchema({
        type: 'object',
        additionalProperties: false,
        required: ['name', 'brand', 'slot', 'tags'],
        properties: {
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          slot: { type: 'string', enum: ['outer', 'top'] },
          fit: { enum: ['tight', 'loose', null] },
          tags: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, properties: { t: { type: 'integer' } }, required: ['t'] } },
        },
      }),
    ).toEqual({
      type: 'OBJECT',
      required: ['name', 'brand', 'slot', 'tags'],
      propertyOrdering: ['name', 'brand', 'slot', 'fit', 'tags'],
      properties: {
        name: { type: 'STRING' },
        brand: { type: 'STRING', nullable: true },
        slot: { type: 'STRING', enum: ['outer', 'top'] },
        fit: { type: 'STRING', enum: ['tight', 'loose'], nullable: true },
        tags: { type: 'ARRAY', maxItems: 3, items: { type: 'OBJECT', properties: { t: { type: 'INTEGER' } }, propertyOrdering: ['t'], required: ['t'] } },
      },
    });
  });

  it('converts every schema the app sends without leaving JSON Schema-only keys', () => {
    const banned = /"(additionalProperties|\$schema|anyOf|oneOf|const)"|"type":\[/;
    for (const sch of [AUTOFILL_SCHEMA, FIDELITY_SCHEMA, MIRROR_SCHEMA]) expect(JSON.stringify(toGeminiSchema(sch as Record<string, unknown>))).not.toMatch(banned);
  });
});
