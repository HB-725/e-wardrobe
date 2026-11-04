/**
 * One referee for several catalog runs: for each photo, the original and the first candidate of every run go to one
 * vision model, which scores how faithfully each candidate shows the garment (0–10). Runs that recognised a different
 * garment on the same photo (a person photo: jacket vs trousers) are left out of that photo.
 *   REAL_AI_RUNS="mini低=/dir1,1.5低=/dir2,..." REAL_AI_KEY=sk-... [REAL_AI_REFEREE=gpt-5.4-mini] REAL_AI_OUT=/path/referee.json \
 *     npx jest src/ai/__tests__/referee.real.test.ts
 * Each run dir holds the photos, out/ and the report.json written by catalog.real.test.ts. About $0.01 per photo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { curlFetch } from '@/test/realApi';
import { createOpenAiClient } from '../client';

const RUNS: { label: string; dir: string }[] = String(process.env.REAL_AI_RUNS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s: string) => ({ label: s.split('=')[0], dir: s.split('=')[1] }));
const KEY = process.env.REAL_AI_KEY;
const OUT = process.env.REAL_AI_OUT;
const MODEL = process.env.REAL_AI_REFEREE ?? 'gpt-5.4-mini';

interface Report {
  items: Record<string, { name: string; slot: string; crop: string | null; candidates: string[] }>;
}
interface Verdict {
  scores: { index: number; score: number; issue: string }[];
}

const dataUrl = (f: string) => `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(f).toString('base64')}`;

(RUNS.length && KEY && OUT ? it : it.skip)('scores every run with one referee', async () => {
  const client = createOpenAiClient({ apiKey: KEY!, fetch: curlFetch(path.dirname(OUT!)) });
  const reports = RUNS.map((r) => ({ ...r, report: JSON.parse(fs.readFileSync(path.join(r.dir, 'report.json'), 'utf8')) as Report }));
  const photos = Object.keys(reports[0].report.items);
  const result: Record<string, unknown> = {};
  for (const photo of photos) {
    type Entry = { label: string; dir: string; item: Report['items'][string] };
    const entries: Entry[] = reports.map((r) => ({ label: r.label, dir: r.dir, item: r.report.items[photo] })).filter((e) => e.item?.candidates.length);
    // The garment most runs found on this photo is the one to judge.
    const bySlot = new Map<string, number>();
    for (const e of entries) bySlot.set(e.item.slot, (bySlot.get(e.item.slot) ?? 0) + 1);
    const slot = [...bySlot.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const judged = entries.filter((e) => e.item.slot === slot);
    const name = judged[0].item.name;
    const images = [dataUrl(path.join(judged[0].dir, photo)), ...judged.map((e) => dataUrl(path.join(e.dir, 'out', e.item.candidates[0])))];
    const text = [
      `第 1 张是用户拍的原图，要看的是里面的这件：${name}（${slot}）。后面 ${judged.length} 张是不同模型生成的商品图，编号 1 到 ${judged.length}。`,
      '给每张商品图打分 0–10：10 分表示就是这一件，颜色深浅、做旧 / 水洗 / 褪色、领型、版型和长度、口袋 / 拉链 / 纽扣、印花 / logo / 文字（逐字）全都对；画成了另一件衣服给 0–2 分。',
      '不看背景、摆放方式、拍摄角度和光线。issue 写这张最大的问题，不超过 15 个字，没问题写空字符串。',
    ].join('\n');
    const r = await client.visionJson<Verdict>({
      model: MODEL,
      system: '你是服装质检员，只比较衣服本身是否同一件。',
      text,
      images,
      detail: 'high',
      schemaName: 'referee',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['scores'],
        properties: {
          scores: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['index', 'score', 'issue'], properties: { index: { type: 'integer' }, score: { type: 'number' }, issue: { type: 'string' } } },
          },
        },
      },
    });
    result[photo] = {
      name,
      slot,
      skipped: entries.filter((e) => e.item.slot !== slot).map((e) => `${e.label}: ${e.item.name} (${e.item.slot})`),
      scores: judged.map((e, i) => {
        const s = r.data.scores.find((x) => x.index === i + 1);
        return { run: e.label, file: path.join(e.dir, 'out', e.item.candidates[0]), score: s?.score ?? null, issue: s?.issue ?? '' };
      }),
      usage: r.usage,
    };
    console.log(photo, JSON.stringify((result[photo] as { scores: unknown }).scores));
  }
  fs.writeFileSync(OUT!, JSON.stringify(result, null, 2));
}, 20 * 60 * 1000);
