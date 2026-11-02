import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { preferencesPatchSchema, preferencesSchema, type Preferences } from './schema.js';
import { reduce, type LoggedEvent, type StoryEvent, type StoryState } from './state.js';

const STALE_LOCK_MS = 15_000;
const LOCK_TIMEOUT_MS = 10_000;

export class GmaxError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export class Store {
  readonly home: string;

  constructor(home = process.env.GMAX_HOME ?? join(homedir(), '.gmax')) {
    this.home = home;
    mkdirSync(join(home, 'stories'), { recursive: true });
  }

  storyDir(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new GmaxError(`無效的 story_id：${id}`);
    return join(this.home, 'stories', id);
  }

  private eventsPath(id: string): string {
    return join(this.storyDir(id), 'events.jsonl');
  }

  exists(id: string): boolean {
    return existsSync(this.eventsPath(id));
  }

  read(id: string): LoggedEvent[] {
    if (!this.exists(id)) {
      throw new GmaxError(`找不到故事：${id}`, '請先用 gmax_story_list 查詢可用故事。');
    }
    const lines = readFileSync(this.eventsPath(id), 'utf8').split('\n').filter(Boolean);
    const events: LoggedEvent[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        // 只容忍寫到一半被中斷的最後一行，其他位置損毀必須回報
        if (i !== lines.length - 1) throw new GmaxError(`事件檔第 ${i + 1} 行損毀：${id}`);
      }
    }
    return events;
  }

  state(id: string): StoryState {
    return reduce(this.read(id));
  }

  create(id: string, event: StoryEvent): void {
    mkdirSync(this.storyDir(id), { recursive: true });
    this.withLock(id, () => this.append(id, [], [event]));
  }

  /** 在鎖內重新讀取最新狀態、驗證並寫入事件，避免多個連線互相覆寫。 */
  mutate<T>(id: string, fn: (state: StoryState, events: LoggedEvent[]) => { events: StoryEvent[]; result: (state: StoryState) => T }): T {
    if (!this.exists(id)) this.read(id);
    return this.withLock(id, () => {
      const existing = this.read(id);
      const { events, result } = fn(reduce(existing), existing);
      const all = this.append(id, existing, events);
      return result(reduce(all));
    });
  }

  private append(id: string, existing: LoggedEvent[], events: StoryEvent[]): LoggedEvent[] {
    let seq = existing.at(-1)?.seq ?? 0;
    const logged = events.map(e => ({ ...e, seq: ++seq, ts: new Date().toISOString() }) as LoggedEvent);
    if (logged.length > 0) {
      appendFileSync(this.eventsPath(id), logged.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    return [...existing, ...logged];
  }

  private withLock<T>(id: string, fn: () => T): T {
    const lock = join(this.storyDir(id), '.lock');
    const start = Date.now();
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
            rmdirSync(lock);
            continue;
          }
        } catch { continue; }
        if (Date.now() - start > LOCK_TIMEOUT_MS) throw new GmaxError(`無法取得故事鎖：${id}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      try { rmdirSync(lock); } catch { /* 已被視為過期清除 */ }
    }
  }

  listIds(): string[] {
    return readdirSync(join(this.home, 'stories'), { withFileTypes: true })
      .filter(d => d.isDirectory() && this.exists(d.name))
      .map(d => d.name);
  }

  preferences(): Preferences {
    const path = join(this.home, 'preferences.json');
    if (!existsSync(path)) return preferencesSchema.parse({});
    try {
      return preferencesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (err) {
      throw new GmaxError(`玩家預設檔損毀：${path}`, '請修正該檔或將其刪除以回到預設值。');
    }
  }

  updatePreferences(patch: unknown): Preferences {
    const parsed = preferencesPatchSchema.parse(patch);
    const next = preferencesSchema.parse({ ...this.preferences(), ...parsed });
    const path = join(this.home, 'preferences.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${path}.tmp`, path);
    return next;
  }

  writeExport(id: string, name: string, content: string): string {
    const path = join(this.storyDir(id), name);
    writeFileSync(path, content);
    return path;
  }
}
