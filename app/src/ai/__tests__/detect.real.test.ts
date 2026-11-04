/**
 * How well each OpenAI recognition model boxes the garments on an outfit photo. Skipped unless OPENAI_API_KEY is set;
 * costs well under $0.01. Uses the demo outfit photo, whose boxes were marked by hand.
 *   OPENAI_API_KEY=sk-... npx jest src/ai/__tests__/detect.real.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromBox2d, overlap } from '@/domain/crop';
import { callCost } from '../catalog';
import { createOpenAiClient } from '../client';
import { DETECT_SCHEMA, DETECT_SYSTEM, type DetectResult, detectText } from '../prompts';

const KEY = process.env.OPENAI_API_KEY;
const PHOTO = path.join(__dirname, '../../../scripts/web-shots/demo/tryon_front.jpg');
const TRUTH = {
  outer: { x: 0.27, y: 0.19, w: 0.45, h: 0.36 },
  bottom: { x: 0.34, y: 0.52, w: 0.3, h: 0.37 },
  shoes: { x: 0.33, y: 0.88, w: 0.32, h: 0.08 },
};

(KEY ? describe : describe.skip)('garment boxes from the real API', () => {
  jest.setTimeout(120_000);
  for (const model of ['gpt-5.4-nano', 'gpt-5.4-mini']) {
    it(`${model} boxes the jacket and the trousers`, async () => {
      const client = createOpenAiClient({ apiKey: KEY! });
      const photo = `data:image/jpeg;base64,${fs.readFileSync(PHOTO).toString('base64')}`;
      const { data, usage } = await client.visionJson<DetectResult>({
        model,
        system: DETECT_SYSTEM,
        text: detectText(false),
        images: [photo],
        detail: 'high',
        schemaName: 'detect',
        schema: DETECT_SCHEMA as unknown as Record<string, unknown>,
      });
      const found = data.garments.map((g) => ({ name: g.name, slot: g.slot, box: fromBox2d(g.box_2d) }));
      const scores = Object.fromEntries(
        Object.entries(TRUTH).map(([slot, t]) => [slot, Math.max(0, ...found.filter((g) => g.slot === slot && g.box).map((g) => overlap(g.box!, t)))]),
      );
      console.log(model, JSON.stringify({ scores, cost: callCost('openai', model, usage), found }));
      expect(scores.outer).toBeGreaterThan(0.5);
      expect(scores.bottom).toBeGreaterThan(0.5);
    });
  }
});
