import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 跨集合事务提交后广播一次，挂着的页面（如另一模块的物资预警清单）跟着刷新。
export const DATA_COMMITTED_EVENT = 'forest-fire:data-committed'

export type CommitDraft = Record<string, EntryRow[]>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 存档已存在时，缺失的集合（如老版本没有通行明细）一律视为空，
    // 不能用新种子顶上——否则老用户会看到示例明细；历史补值由 domain 迁移负责。
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function persist(next: Record<string, EntryRow[]>): void {
  // 先尝试落盘，写入抛错时内存缓存保持旧值（调用方的事务随之整体失败）；
  // 只有持久化成功才切换缓存，杜绝「存储失败、页面却已变更」的半成品。
  let serialized = ''
  if (typeof window !== 'undefined' && window.localStorage) {
    serialized = JSON.stringify(next)
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

function notify(touchedKeys: string[]): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(DATA_COMMITTED_EVENT, { detail: { keys: touchedKeys } }))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitKeys((draft) => {
    draft[key] = rows
  }, [key])
}

// 跨集合事务：在同一份克隆快照上依次改站点、记录、预警，
// 任一步抛错就整份丢弃（缓存与 localStorage 都不动），全部成功才一次落库。
export function commitKeys(
  mutate: (draft: CommitDraft) => void,
  touchedKeys: string[] = [],
): void {
  const draft = clone(allRows())
  mutate(draft)
  persist(draft)
  notify(touchedKeys)
}

export function nextId(key: string): number {
  const rows = listRows(key)
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
