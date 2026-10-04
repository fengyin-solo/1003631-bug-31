import { SEED_ROWS } from './seed'
import type { DomainDraft, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

// 存储里既有带状态的业务行，也有只有 id 的领域行（检查记录/班次/预警）。
type StoredMap = Record<string, EntryRow[]>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): StoredMap {
  const fallback = clone(SEED_ROWS) as StoredMap
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredMap
    // 老缓存里没有新增的领域集合（检查记录/班次/预警）时，用种子补齐而不是丢掉。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoredMap | null = null

export function allRows(): StoredMap {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitAll({ [key]: rows })
}

/**
 * 一次事务写多个集合：站点、记录、预警同次落库。
 * 先把草稿合并成完整快照，序列化成功后才替换缓存并写 localStorage；
 * 序列化或写入抛错时缓存保持原样，相当于失败一起退回。
 */
export function commitAll(draft: DomainDraft): void {
  const base = allRows()
  const next: Record<string, EntryRow[]> = { ...base }
  for (const [key, rows] of Object.entries(draft)) {
    next[key] = clone(rows as EntryRow[])
  }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写存储：写失败会抛错，此时内存缓存尚未替换，读侧仍看到旧值。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = JSON.parse(serialized) as Record<string, EntryRow[]>
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []) as EntryRow[]
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
