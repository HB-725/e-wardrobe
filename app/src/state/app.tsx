import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Animated, AppState, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createOpenAiClient, type OpenAiClient } from '@/ai/client';
import { cleanOrphanImages } from './actions';
import { setAiBlocked } from '@/ai/config';
import type { AiDeps } from '@/ai/engine';
import type { ImageStore } from '@/ai/imageStore';
import { JobRunner } from '@/ai/runner';
import type { Db } from '@/db/db';
import { wakeWaitingJobs } from '@/db/jobs';
import type { Selection } from '@/domain/outfit';
import { openAppDb } from '@/platform/db';
import { nativeImages } from '@/platform/images';
import { getApiKey } from '@/platform/secrets';
import { C, R } from '@/ui/theme';

interface AppValue {
  db: Db;
  images: ImageStore;
  ai: AiDeps;
  runner: JobRunner;
  /** Bumped on every write so screens reload their queries. */
  version: number;
  refresh(): void;
  toast(message: string): void;
  /** Garments currently on the avatar in the fitting room; shared so other pages can "去试穿". */
  fitting: Selection;
  setFitting(sel: Selection): void;
  /** Re-read the API key after the user changes it. */
  reloadKey(): Promise<void>;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/**
 * Screens that load the same thing (loadSnapshot is used by every tab) share one load per data version, so a write
 * costs one reload rather than one per mounted screen.
 */
const sharedLoads = new WeakMap<object, { db: Db; version: number; at: number; promise: Promise<unknown> }>();
/** Only loads started together are shared, in case some write ever forgets to bump the version. */
const SHARE_MS = 1500;
function shared<T>(load: (db: Db) => Promise<T>, db: Db, version: number): Promise<T> {
  const hit = sharedLoads.get(load);
  if (hit && hit.db === db && hit.version === version && Date.now() - hit.at < SHARE_MS) return hit.promise as Promise<T>;
  const promise = load(db);
  sharedLoads.set(load, { db, version, at: Date.now(), promise });
  // A failed load must not stay cached.
  promise.catch(() => sharedLoads.delete(load));
  return promise;
}

/**
 * Loads data with `load(db)` and reloads whenever anything is written (app version bump) or `deps` change.
 * Returns undefined until the first load finishes.
 */
export function useData<T>(load: (db: Db) => Promise<T>, deps: unknown[] = []): T | undefined {
  const { db, version } = useApp();
  const [data, setData] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (deps.length === 0 ? shared(load, db, version) : load(db))
      .then((d) => alive && setData(d))
      .catch((e) => console.warn('load failed', e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, version, ...deps]);
  return data;
}

function Toast({ message }: { message: string | null }) {
  const insets = useSafeAreaInsets();
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, { toValue: message ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [message, opacity]);
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 20, right: 20, bottom: 100 + insets.bottom, alignItems: 'center', opacity }}>
      {message ? (
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: C.ink, borderRadius: R.pill, paddingHorizontal: 18, paddingVertical: 10, maxWidth: 360 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{message}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

/** A keystore problem must not stop the app from opening; it then simply behaves as if no key was saved. */
async function readKey(): Promise<string | null> {
  try {
    return await getApiKey();
  } catch (e) {
    console.warn('secure store unavailable', e);
    return null;
  }
}

interface Core {
  db: Db;
  ai: AiDeps;
  runner: JobRunner;
  reloadKey(): Promise<void>;
}

/** Opens the database and wires the AI engine; the API key is read from secure storage and cached here. */
async function createCore(onChange: () => void): Promise<Core> {
  const db = await openAppDb();
  const holder: { key: string | null; client: { key: string; client: OpenAiClient } | null } = { key: await readKey(), client: null };
  const ai: AiDeps = {
    db,
    images: nativeImages,
    async getClient() {
      const key = holder.key;
      if (!key) return null;
      if (holder.client?.key !== key) holder.client = { key, client: createOpenAiClient({ apiKey: key }) };
      return holder.client.client;
    },
  };
  // A batch import finishes a job every few seconds; coalesce the queue's updates into one refresh.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const queueChanged = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      onChange();
    }, 400);
  };
  const runner = new JobRunner(ai, { onChange: queueChanged });
  return {
    db,
    ai,
    runner,
    async reloadKey() {
      holder.key = await readKey();
      // Whatever paused the queue may be fixed now; the runner sets it again if not.
      await setAiBlocked(db, null);
      runner.kick();
      onChange();
    },
  };
}

export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [core, setCore] = useState<Core | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [toastMsg, setToastMsg] = useState<{ text: string; at: number } | null>(null);
  const [fitting, setFitting] = useState<Selection>({});

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((text: string) => setToastMsg({ text, at: Date.now() }), []);
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 2600);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    createCore(refresh)
      .then(setCore)
      .catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!core) return;
    void core.runner.start();
    // Housekeeping once per launch, after the queue has re-queued interrupted work.
    void cleanOrphanImages({ db: core.db, images: nativeImages, runner: core.runner }).catch((e) => console.warn('cleanup failed', e));
    // Resume the queue when the app comes back to the foreground (network may be back).
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      void wakeWaitingJobs(core.db)
        .catch(() => undefined)
        .then(() => core.runner.kick());
      refresh(); // the date may have changed while in the background
    });
    // Also roll over at midnight while the app stays open.
    let day = new Date().toDateString();
    const tick = setInterval(() => {
      const now = new Date().toDateString();
      if (now !== day) {
        day = now;
        refresh();
      }
    }, 60_000);
    return () => {
      sub.remove();
      clearInterval(tick);
      core.runner.stop();
    };
  }, [core, refresh]);

  const value = useMemo<AppValue | null>(
    () =>
      core && {
        db: core.db,
        images: nativeImages,
        ai: core.ai,
        runner: core.runner,
        version,
        refresh,
        toast,
        fitting,
        setFitting,
        reloadKey: core.reloadKey,
      },
    [core, version, refresh, toast, fitting],
  );

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Text style={{ fontSize: 15, color: C.danger }}>数据库打开失败：{error}</Text>
      </View>
    );
  }
  if (!value) return <>{fallback}</>;
  return (
    <Ctx.Provider value={value}>
      {children}
      <Toast message={toastMsg?.text ?? null} />
    </Ctx.Provider>
  );
}
