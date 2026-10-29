import type { Db } from './db';

/** Each entry upgrades the schema by one version; never edit a shipped migration, append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slot TEXT NOT NULL,
    subcategory TEXT,
    color_name TEXT,
    color_hex TEXT,
    seasons TEXT NOT NULL DEFAULT '[]',
    brand TEXT,
    size TEXT,
    material TEXT,
    price_cents INTEGER,
    purchased_on TEXT,
    channel TEXT,
    location TEXT,
    fit_notes TEXT,
    status TEXT NOT NULL,
    original_uri TEXT,
    catalog_uri TEXT,
    tag_uri TEXT,
    field_sources TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX items_status ON items(status);

  CREATE TABLE outfits (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    occasions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE outfit_items (
    outfit_id TEXT NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (outfit_id, item_id)
  );

  CREATE TABLE wear_logs (
    id TEXT PRIMARY KEY NOT NULL,
    date TEXT NOT NULL UNIQUE,
    outfit_id TEXT REFERENCES outfits(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    photo_uri TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE wear_log_items (
    log_id TEXT NOT NULL REFERENCES wear_logs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (log_id, item_id)
  );

  CREATE TABLE tryon_cache (
    key TEXT NOT NULL,
    view TEXT NOT NULL,
    uri TEXT NOT NULL,
    avatar_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, view)
  );

  CREATE TABLE avatar (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    front_uri TEXT,
    back_uri TEXT,
    source_uris TEXT NOT NULL DEFAULT '[]',
    height_cm REAL,
    weight_kg REAL,
    build TEXT,
    status TEXT NOT NULL DEFAULT 'none',
    error TEXT,
    updated_at TEXT
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_status ON jobs(status, next_run_at);

  CREATE TABLE usage (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export async function migrate(db: Db): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version];
    const next = version + 1;
    await db.withTransactionAsync(async () => {
      await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
}
