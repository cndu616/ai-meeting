import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import fs from 'node:fs';
import * as schema from './schema';

export type DB = ReturnType<typeof createDrizzle>;

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

function applyMigrations(db: DB) {
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
}

// 全局单例：Next dev 热重载时避免重复打开连接
const g = globalThis as unknown as { __meetingDb?: DB };

export function getDb(): DB {
  if (g.__meetingDb) return g.__meetingDb;
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const sqlite = new Database(path.join(process.cwd(), 'data', 'meetings.db'));
  const db = createDrizzle(sqlite);
  applyMigrations(db);
  g.__meetingDb = db;
  return db;
}

// 测试专用：独立内存库
export function createTestDb(): DB {
  const sqlite = new Database(':memory:');
  const db = createDrizzle(sqlite);
  applyMigrations(db);
  return db;
}
