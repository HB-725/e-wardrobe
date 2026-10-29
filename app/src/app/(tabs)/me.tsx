import { Image } from 'expo-image';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { getAiSettings, getModelChoice, type QualityLevel, saveAiSettings, savePrefs } from '@/ai/config';
import { formatUsd } from '@/ai/models';
import type { Db } from '@/db/db';
import { createItem, listItems } from '@/db/items';
import { getSetting, monthSpend } from '@/db/misc';
import { listOutfits } from '@/db/outfits';
import { listLogs } from '@/db/wear';
import { buildWorkbook, isDuplicate, parseWorkbook } from '@/domain/excel';
import { toDateKey } from '@/domain/stats';
import { pickSpreadsheet, shareBase64File, XLSX_MIME } from '@/platform/files';
import { setApiKey } from '@/platform/secrets';
import { userSources, wipeEverything } from '@/state/actions';
import { BackupError, createBackup, readBackupInfo, restoreBackup } from '@/state/backup';
import { BACKUP_SUPPORTED, pickBackupFile, pickNewBackupFile } from '@/platform/backupStorage';
import { ArchiveError } from '@/state/archive';
import { useApp, useData } from '@/state/app';
import { loadSnapshot } from '@/state/snapshot';
import { confirmAsync, notify } from '@/ui/dialogs';
import { Btn, Chip, Loading, PageHeader, ProgressBar, Row, Screen, SectionTitle, Sheet, Switch, T, Tap } from '@/ui/kit';
import { C, PAD } from '@/ui/theme';
import { Silhouette } from '@/ui/visuals';

const CAPS = [1, 3, 5, 10, 20, 0];
const QUALITY: { id: QualityLevel; label: string; sub: string }[] = [
  { id: 'economy', label: '省钱', sub: '全部用低画质，最便宜' },
  { id: 'standard', label: '标准', sub: '商品图低画质，形象和上身效果中画质' },
  { id: 'high', label: '高清', sub: '画质最好，费用约为标准的 3–4 倍' },
];
const IDLE = [14, 30, 60, 90, 180];

async function loadMe(db: Db) {
  const [settings, spend, models, last4] = await Promise.all([getAiSettings(db), monthSpend(db), getModelChoice(db), getSetting(db, 'ai.keyLast4')]);
  return { settings, spend, models, last4 };
}

type SheetKind = 'cap' | 'quality' | 'idle' | 'name' | null;

export default function MePage() {
  const app = useApp();
  const s = useData(loadSnapshot);
  const me = useData(loadMe);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState('');

  if (!s || !me) return <Loading />;
  const { settings, spend } = me;
  const a = s.avatar;
  const body = a.heightCm || a.weightKg;
  const fitCount = s.items.filter((i) => i.fitNotes).length;
  const kinds = spend.byKind;
  const cell = (keys: string[]) => keys.reduce((acc, k) => ({ usd: acc.usd + (kinds[k]?.usd ?? 0), count: acc.count + (kinds[k]?.count ?? 0) }), { usd: 0, count: 0 });
  const catalog = cell(['catalog']);
  const tryon = cell(['tryon', 'avatar']);
  const other = cell(['photo', 'mirror', 'other', 'autofill']);

  const exportExcel = async () => {
    setBusy('export');
    try {
      const [items, outfits, logs] = await Promise.all([listItems(app.db), listOutfits(app.db), listLogs(app.db)]);
      const b64 = buildWorkbook(items, outfits, logs, new Date());
      await shareBase64File(`衣橱-${toDateKey(new Date())}.xlsx`, b64, XLSX_MIME);
    } catch (e) {
      notify('导出失败', String(e));
    } finally {
      setBusy(null);
    }
  };

  const importExcel = async () => {
    const file = await pickSpreadsheet();
    if (!file) return;
    setBusy('import');
    try {
      const r = parseWorkbook(file.base64);
      const existing = await listItems(app.db);
      let added = 0;
      let dup = 0;
      for (const it of r.items) {
        if (isDuplicate(existing, it)) {
          dup += 1;
          continue;
        }
        const { archived, ...fields } = it;
        await createItem(app.db, { ...fields, status: archived ? 'archived' : 'active', fieldSources: userSources(fields) });
        added += 1;
      }
      app.refresh();
      const lines = [`新增 ${added} 件`];
      if (dup) lines.push(`${dup} 件已存在，跳过`);
      if (r.skipped.length) lines.push(`${r.skipped.length} 行无法识别：${r.skipped.slice(0, 3).map((x) => `第 ${x.row} 行${x.reason}`).join('；')}`);
      lines.push('导入的衣服没有照片，可以在单品详情里补拍。');
      notify('导入完成', lines.join('\n'));
    } catch (e) {
      notify('导入失败', `无法读取这个文件：${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const backup = async () => {
    let target: Awaited<ReturnType<typeof pickNewBackupFile>>;
    try {
      target = await pickNewBackupFile(app.images);
    } catch (e) {
      notify('无法在这里创建备份', `换一个文件夹试试。${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!target) return;
    setBusy('backup');
    // Running AI jobs replace and delete pictures; pause them so the backup is consistent.
    app.runner.hold();
    try {
      await app.runner.idle();
      const r = await createBackup(app.db, target.storage, (d, t) => setProgress(`${d}/${t}`));
      await target.verify();
      notify(
        '备份完成',
        `已把 ${r.items} 件衣服、${r.images} 张图片和全部穿搭、记录保存为「${target.name}」。\n\n备份里有全身照、身材数据和镜子照片（不含 API Key），请放在只有你能访问的地方。换手机时在新手机上选「从备份恢复」。`,
      );
    } catch (e) {
      target.discard();
      notify('备份失败', e instanceof Error ? e.message : String(e));
    } finally {
      app.runner.release();
      setBusy(null);
      setProgress('');
    }
  };

  const restore = async () => {
    let storage: Awaited<ReturnType<typeof pickBackupFile>>;
    try {
      storage = await pickBackupFile(app.images);
    } catch (e) {
      notify('无法打开这个文件', String(e));
      return;
    }
    if (!storage) return;
    try {
      const info = await readBackupInfo(storage);
      const d = new Date(info.createdAt);
      const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (!(await confirmAsync('从备份恢复', `备份时间 ${when}，共 ${info.items} 件衣服、${info.outfits} 套穿搭。手机上现有的数据会被替换。`, '恢复'))) {
        await storage.close();
        return;
      }
    } catch (e) {
      notify('无法恢复', e instanceof BackupError || e instanceof ArchiveError ? e.message : String(e));
      await storage.close();
      return;
    }
    setBusy('restore');
    app.runner.hold();
    try {
      await app.runner.idle();
      const r = await restoreBackup(app.db, app.images, storage, (d, t) => setProgress(`${d}/${t}`));
      app.setFitting({});
      notify('恢复完成', `已恢复 ${r.items} 件衣服和 ${r.images} 张图片。`);
    } catch (e) {
      notify('恢复失败', `手机上的数据没有改动。${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await storage.close();
      app.runner.release();
      setBusy(null);
      setProgress('');
      app.refresh();
    }
  };

  const wipe = async () => {
    if (!(await confirmAsync('永久删除全部数据', '衣服、照片、穿搭、穿着记录、个人形象和 API Key 都会从这台手机上删除，无法恢复。'))) return;
    if (!(await confirmAsync('再确认一次', '真的要删除吗？建议先做一次「完整备份」。', '永久删除'))) return;
    // A job still running would write the avatar / images back after the wipe, so let it finish first.
    setBusy('wipe');
    app.runner.hold();
    try {
      await app.runner.idle();
      await wipeEverything(app);
      await setApiKey(null);
      app.setFitting({});
      app.toast('已删除全部数据');
      router.navigate('/');
    } catch (e) {
      notify('删除没有完成', String(e));
    } finally {
      app.runner.release();
      await app.reloadKey();
      setBusy(null);
    }
  };

  return (
    <Screen>
      <PageHeader eyebrow="PROFILE" title="我的" />
      <View style={{ marginTop: 18, marginHorizontal: PAD, flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        <View style={{ width: 96, height: 132, backgroundColor: C.card, padding: a.frontUri ? 0 : 18 }}>
          {a.frontUri ? <Image source={{ uri: a.frontUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" contentPosition="top" /> : <Silhouette />}
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <Tap
            onPress={() => {
              setName(s.prefs.nickname);
              setSheet('name');
            }}
          >
            <T style={{ fontSize: 18, fontWeight: '700' }}>{s.prefs.nickname || '点击设置昵称'}</T>
          </Tap>
          <T v="caption" style={{ color: a.status === 'failed' ? C.danger : C.sub }}>
            {a.status === 'ready' ? '个人形象已建立 · 正面和背面' : a.status === 'processing' ? '形象生成中…' : a.status === 'failed' ? `形象生成失败：${a.error ?? ''}` : '还没有建立个人形象'}
          </T>
          <Btn label={a.status === 'none' ? '建立形象' : a.status === 'failed' ? '重新建立' : '更新形象'} kind="outline" height={36} style={{ alignSelf: 'flex-start' }} onPress={() => router.push('/avatar')} />
        </View>
      </View>

      <View style={{ marginTop: 24, marginHorizontal: PAD }}>
        <SectionTitle>身材数据</SectionTitle>
        <Row label="身高 · 体重 · 体型" value={body ? '已填写 · 仅自己可见' : '未填写'} onPress={() => router.push('/avatar?step=2')} />
        <Row label="合身笔记" value={fitCount ? `已记录 ${fitCount} 件` : '拍镜子照片时自动记录'} last />
      </View>

      <View style={{ marginTop: 24, marginHorizontal: PAD }}>
        <SectionTitle style={{ marginBottom: 10 }}>AI 服务</SectionTitle>
        <View style={{ padding: 16, backgroundColor: C.card, gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T>本月花费（估算）</T>
            <T style={{ fontSize: 22, fontWeight: '700' }}>
              {formatUsd(spend.totalUsd)} <T style={{ fontSize: 12, color: C.sub, fontWeight: '400' }}>/ {settings.capUsd ? `上限 $${settings.capUsd}` : '不限'}</T>
            </T>
          </View>
          {settings.capUsd ? <ProgressBar value={spend.totalUsd / settings.capUsd} /> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { v: catalog, l: `商品图 ${catalog.count} 次` },
              { v: tryon, l: `形象与上身 ${tryon.count} 次` },
              { v: other, l: `大片与识别 ${other.count} 次` },
            ].map((x) => (
              <View key={x.l} style={{ flex: 1, gap: 2 }}>
                <T style={{ fontSize: 13, fontWeight: '700' }}>{formatUsd(x.v.usd)}</T>
                <T style={{ fontSize: 11, color: C.sub }}>{x.l}</T>
              </View>
            ))}
          </View>
        </View>
        <Row label="我的 API Key" value={me.last4 ? `已绑定 · ••••${me.last4}` : '未填写 · 点击填写'} onPress={() => router.push('/apikey')} />
        <Row label="每月花费上限" value={settings.capUsd ? `$${settings.capUsd}` : '不限'} onPress={() => setSheet('cap')} />
        <Row label="画质" value={QUALITY.find((q) => q.id === settings.quality)?.label} onPress={() => setSheet('quality')} />
        <Row label="使用的模型" value={me.models.image ? `${me.models.image} · ${me.models.vision ?? '—'}` : '填写 Key 后自动选择'} last />
      </View>

      <View style={{ marginTop: 24, marginHorizontal: PAD }}>
        <SectionTitle>偏好</SectionTitle>
        <Row
          label="镜子照片自动记一次穿着"
          sub="识别到的单品穿着次数 +1"
          value={
            <Switch
              label="镜子照片自动记一次穿着"
              value={s.prefs.mirrorAutoLog}
              onChange={async (v) => {
                await savePrefs(app.db, { mirrorAutoLog: v });
                app.refresh();
              }}
            />
          }
        />
        <Row label="闲置提醒" value={`超过 ${s.prefs.idleDays} 天未穿`} onPress={() => setSheet('idle')} last />
      </View>

      <View style={{ marginTop: 24, marginHorizontal: PAD }}>
        <SectionTitle>数据</SectionTitle>
        <Row label={busy === 'export' ? '正在导出…' : '导出衣橱到 Excel'} value=".xlsx" onPress={busy ? undefined : exportExcel} />
        <Row label={busy === 'import' ? '正在导入…' : '从 Excel 导入'} value="按导出文件的列名" onPress={busy ? undefined : importExcel} last={!BACKUP_SUPPORTED} />
        {BACKUP_SUPPORTED ? (
          <>
            <Row label={busy === 'backup' ? `正在备份… ${progress}` : '完整备份（含照片）'} sub="生成一个备份文件，存到手机或网盘，换手机时恢复" onPress={busy ? undefined : backup} />
            <Row label={busy === 'restore' ? `正在恢复… ${progress}` : '从备份恢复'} sub="选择之前的 .wardrobe 备份文件" onPress={busy ? undefined : restore} last />
          </>
        ) : null}
      </View>

      <View style={{ marginTop: 24, marginHorizontal: PAD }}>
        <SectionTitle>隐私</SectionTitle>
        <Row label="照片与身材数据" value="只保存在这台手机上" />
        <Row label="发送给 AI 的内容" value="仅在生成时发送给 OpenAI" />
        <Row label="用于模型训练" value="OpenAI 默认不用 API 数据训练" />
        <Row label={busy === 'wipe' ? '正在删除…' : '永久删除我的全部数据'} danger onPress={busy ? undefined : wipe} last />
      </View>
      <T v="caption" style={{ textAlign: 'center', marginTop: 20 }}>
        衣橱 v{Constants.expoConfig?.version ?? '—'}
      </T>

      <Sheet visible={sheet === 'cap'} onClose={() => setSheet(null)} title="每月花费上限">
        <T v="small" style={{ color: C.sub }}>
          达到上限后，新的 AI 任务会暂停，已有的衣服和穿搭不受影响。按 OpenAI 的价格估算，实际以账单为准。
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CAPS.map((c) => (
            <Chip
              key={c}
              label={c ? `$${c}` : '不限'}
              on={settings.capUsd === c}
              onPress={async () => {
                await saveAiSettings(app.db, { capUsd: c });
                setSheet(null);
                await app.reloadKey();
              }}
            />
          ))}
        </View>
      </Sheet>
      <Sheet visible={sheet === 'quality'} onClose={() => setSheet(null)} title="画质">
        <View>
          {QUALITY.map((q) => (
            <Row
              key={q.id}
              label={q.label}
              sub={q.sub}
              value={settings.quality === q.id ? '✓' : ''}
              onPress={async () => {
                await saveAiSettings(app.db, { quality: q.id });
                setSheet(null);
                app.refresh();
              }}
            />
          ))}
        </View>
      </Sheet>
      <Sheet visible={sheet === 'idle'} onClose={() => setSheet(null)} title="多久没穿算闲置">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {IDLE.map((d) => (
            <Chip
              key={d}
              label={`${d} 天`}
              on={s.prefs.idleDays === d}
              onPress={async () => {
                await savePrefs(app.db, { idleDays: d });
                setSheet(null);
                app.refresh();
              }}
            />
          ))}
        </View>
      </Sheet>
      <Sheet visible={sheet === 'name'} onClose={() => setSheet(null)} title="昵称">
        <TextInput
          value={name}
          onChangeText={setName}
          autoFocus
          maxLength={16}
          placeholder="你的昵称"
          placeholderTextColor={C.faint}
          style={{ height: 46, paddingHorizontal: 12, borderWidth: 1, borderColor: C.muted, fontSize: 15, color: C.ink }}
        />
        <Btn
          label="保存"
          onPress={async () => {
            await savePrefs(app.db, { nickname: name.trim() });
            setSheet(null);
            app.refresh();
          }}
        />
      </Sheet>
    </Screen>
  );
}
