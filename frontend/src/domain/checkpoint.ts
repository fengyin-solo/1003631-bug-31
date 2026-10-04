import { allRows, commitAll } from '@/data/local-store'
import type { DomainDraft, DomainRow, EntryRow } from '@/data/types'

// 检查站领域：站点状态以「现场检查记录」为唯一权威源，
// 站点行 / 班次 / 物资预警都是在一个事务里派生出的投影。

export const STATION_NORMAL = '正常检查'
export const STATION_CLOSED = '临时关闭'
export const STATION_UPGRADED = '升级检查'
export const STATION_WAITING = '等待换岗'

export type StationStatus =
  | typeof STATION_NORMAL
  | typeof STATION_CLOSED
  | typeof STATION_UPGRADED
  | typeof STATION_WAITING

export type DomainResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

export type InspectionInput = {
  stationId: number
  现场状态: StationStatus
  检查时间?: string
  检查项目?: string
  通行车辆数?: number | string
  收缴火种数?: number | string
  /** 乐观锁：页面读到的站点版本，提交时不一致即拒绝。 */
  expectedVersion?: number
}

export type ShiftInput = {
  stationId: number
  expectedVersion?: number
  排班日期?: string
  值勤时段?: string
  接班人员?: string
}

export type WarningLevel = '充足' | '偏低' | '需补充' | '已过期'

export type InspectionRow = DomainRow
export type ShiftRow = DomainRow
export type WarningRow = DomainRow

type Draft = {
  checkpoint: EntryRow[]
  checkpointInspection: DomainRow[]
  checkpointShift: DomainRow[]
  supply: EntryRow[]
  supplyWarning: DomainRow[]
}

const COLLECTIONS = [
  'checkpoint',
  'checkpointInspection',
  'checkpointShift',
  'supply',
  'supplyWarning',
] as const

// 待处理：除「正常检查」外都属于需要后续动作的状态。
const PENDING_STATUSES = new Set<StationStatus>([
  STATION_CLOSED,
  STATION_UPGRADED,
  STATION_WAITING,
])

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 当前时间，统一成 YYYY-MM-DD HH:mm。 */
function nowText(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function nextId(rows: DomainRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 一个站点的有效现场检查，按检查时间倒序；时间相同取记录 ID 更大者。 */
export function inspectionsOfStation(
  inspections: DomainRow[],
  stationId: number,
): InspectionRow[] {
  return inspections
    .filter((row) => Number(row.stationId) === stationId)
    .sort((a, b) => {
      const ta = String(a.inspectionAt ?? '')
      const tb = String(b.inspectionAt ?? '')
      if (ta !== tb) {
        return tb < ta ? -1 : 1
      }
      return Number(b.id) - Number(a.id)
    })
}

function latestInspection(
  inspections: DomainRow[],
  stationId: number,
): InspectionRow | undefined {
  return inspectionsOfStation(inspections, stationId)[0]
}

/**
 * 冲突仲裁：站点状态由最新一条有效现场检查与管理态共同决定。
 * - 最新现场结论是「升级检查」→ 永远以现场为准，压过一切管理态；
 * - 最新现场结论是「正常检查」→ 只负责解除「升级检查」；
 *   在途的「等待换岗 / 临时关闭」是显式管理动作，不被正常检查打断，
 *   分别由完成交接 / 重新开放结束。
 */
function resolveStatus(station: EntryRow, inspections: DomainRow[]): StationStatus {
  const latest = latestInspection(inspections, Number(station.id))
  const current = String(station.status) as StationStatus
  if (latest && String(latest.现场状态) === STATION_UPGRADED) {
    return STATION_UPGRADED
  }
  if (current === STATION_WAITING || current === STATION_CLOSED) {
    return current
  }
  return STATION_NORMAL
}

/** 重算单站点投影：状态、待处理、火种/车辆投影、（调用方负责 version）。 */
function projectStation(
  station: EntryRow,
  inspections: DomainRow[],
): EntryRow {
  const status = resolveStatus(station, inspections)
  const latest = latestInspection(inspections, Number(station.id))
  return {
    ...station,
    status,
    pending: PENDING_STATUSES.has(status),
    abnormal: status === STATION_CLOSED,
    收缴火种数: latest ? num(latest.收缴火种数) : 0,
    通行车辆数: latest ? num(latest.通行车辆数) : 0,
  }
}

/**
 * 物资预警重算口径（顺序判定，先命中先返回）：
 * 1. 人工标记「已过期」优先于数量；
 * 2. 实际<=0 或 实际<=预警×50% → 需补充；
 * 3. 实际<=预警 → 偏低；其余充足。
 * 数量无法解析按 0 处理。升级检查站点同林场的未达标物资打「关注」。
 */
function rebuildWarnings(
  supplies: EntryRow[],
  stations: EntryRow[],
  inspections: DomainRow[],
): DomainRow[] {
  const upgradedForests = new Set(
    stations
      .filter((station) => resolveStatus(station, inspections) === STATION_UPGRADED)
      .map((station) => String(station.所属林场 ?? '未归属林场')),
  )

  return supplies.map((item) => {
    const threshold = num(item.预警储备量)
    const actual = num(item.实际储备量)
    let level: WarningLevel
    if (String(item.物资状态) === '已过期') {
      level = '已过期'
    } else if (actual <= 0 || actual <= threshold * 0.5) {
      level = '需补充'
    } else if (actual <= threshold) {
      level = '偏低'
    } else {
      level = '充足'
    }
    const forest = String(item.储备林场 ?? '')
    const warning = level !== '充足'
    return {
      id: Number(item.id),
      supplyId: Number(item.id),
      物资编号: String(item.物资编号 ?? ''),
      物资名称: String(item.物资名称 ?? ''),
      储备林场: forest,
      预警储备量: threshold,
      实际储备量: actual,
      级别: level,
      关注: warning && upgradedForests.has(forest),
    }
  })
}

let initialized = false

/**
 * 首次进入时迁移旧数据（按形状探测，幂等）：
 * - 站点补 version / 所属林场；
 * - 无现场检查记录的旧站点，按存量字段补一条基线检查，让权威源成立；
 * - 重建物资预警，清掉残留旧值。
 */
function ensureDomain(): void {
  if (initialized) {
    return
  }
  const rows = allRows()
  const stations = (rows.checkpoint ?? []) as EntryRow[]
  const inspections = ((rows.checkpointInspection ?? []) as DomainRow[]).map((r) => ({
    ...r,
  }))
  const supplies = (rows.supply ?? []) as EntryRow[]
  const warningsSeed = (rows.supplyWarning ?? []) as DomainRow[]

  let touched = false
  const migrated = stations.map((station) => {
    let next = { ...station }
    if (typeof next.version !== 'number') {
      next.version = 0
      touched = true
    }
    if (!next.所属林场) {
      next.所属林场 = '未归属林场'
      touched = true
    }
    if (!latestInspection(inspections, Number(next.id))) {
      inspections.push({
        id: nextId(inspections),
        inspectionAt: `${String(next.值班日期 ?? '').slice(0, 10) || '1970-01-01'} 00:00`,
        stationId: Number(next.id),
        站点编号: String(next.站点编号 ?? ''),
        站点位置: String(next.站点位置 ?? ''),
        所属林场: String(next.所属林场 ?? '未归属林场'),
        值守人员: String(next.值守人员 ?? ''),
        检查项目: String(next.检查项目 ?? '常规检查') || '常规检查',
        通行车辆数: num(next.通行车辆数),
        收缴火种数: num(next.收缴火种数),
        现场状态:
          next.status === STATION_UPGRADED ? STATION_UPGRADED : STATION_NORMAL,
        baseline: true,
      })
      touched = true
    }
    next = projectStation(next, inspections)
    return next
  })

  const warnings = rebuildWarnings(supplies, migrated, inspections)
  const stale =
    warningsSeed.length !== warnings.length ||
    warnings.some(
      (w, i) =>
        String(w.级别) !== String(warningsSeed[i]?.级别) ||
        Boolean(w.关注) !== Boolean(warningsSeed[i]?.关注),
    )

  if (touched || stale) {
    const draft: DomainDraft = {
      checkpoint: migrated,
      checkpointInspection: inspections,
      supplyWarning: warnings,
    }
    if (!(rows.checkpointShift ?? []).length) {
      draft.checkpointShift = []
    }
    commitAll(draft)
  }
  initialized = true
}

function openDraft(): Draft {
  ensureDomain()
  const rows = allRows()
  return {
    checkpoint: (rows.checkpoint ?? []).map((r) => ({ ...r })),
    checkpointInspection: ((rows.checkpointInspection ?? []) as DomainRow[]).map(
      (r) => ({ ...r }),
    ),
    checkpointShift: ((rows.checkpointShift ?? []) as DomainRow[]).map((r) => ({
      ...r,
    })),
    supply: (rows.supply ?? []).map((r) => ({ ...r })),
    supplyWarning: ((rows.supplyWarning ?? []) as DomainRow[]).map((r) => ({
      ...r,
    })),
  }
}

/** 统一收尾：重算全部站点投影 + 预警，一次事务提交（站点、记录、预警同次落库）。 */
function commit(draft: Draft): void {
  draft.checkpoint = draft.checkpoint.map((station) =>
    projectStation(station, draft.checkpointInspection),
  )
  draft.supplyWarning = rebuildWarnings(
    draft.supply,
    draft.checkpoint,
    draft.checkpointInspection,
  )
  commitAll({
    checkpoint: draft.checkpoint,
    checkpointInspection: draft.checkpointInspection,
    checkpointShift: draft.checkpointShift,
    supply: draft.supply,
    supplyWarning: draft.supplyWarning,
  })
}

function findStation(draft: Draft, stationId: number): EntryRow | undefined {
  return draft.checkpoint.find((row) => Number(row.id) === stationId)
}

function checkVersion(station: EntryRow, expected?: number): boolean {
  return expected === undefined || Number(station.version ?? 0) === Number(expected)
}

function bumpVersion(station: EntryRow): void {
  station.version = Number(station.version ?? 0) + 1
}

// ---------- 读模型 ----------

export type StationView = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  version?: number
  /** 现场火种数（=最新检查记录），列表与统计只用这一个值，杜绝重复计数。 */
  fireCount: number
  vehicleCount: number
  lastCheckedAt: string
  openShift?: ShiftRow
  [field: string]: string | number | boolean | ShiftRow | undefined
}

export function listStations(): StationView[] {
  ensureDomain()
  const rows = allRows()
  const stations = (rows.checkpoint ?? []) as EntryRow[]
  const inspections = (rows.checkpointInspection ?? []) as DomainRow[]
  const shifts = (rows.checkpointShift ?? []) as DomainRow[]
  return stations.map((station) => {
    const latest = latestInspection(inspections, Number(station.id))
    const openShift = shifts.find(
      (shift) =>
        Number(shift.stationId) === Number(station.id) &&
        String(shift.状态) !== '已交接',
    )
    return {
      ...station,
      fireCount: latest ? num(latest.收缴火种数) : 0,
      vehicleCount: latest ? num(latest.通行车辆数) : 0,
      lastCheckedAt: latest ? String(latest.inspectionAt ?? '') : '',
      openShift,
    }
  })
}

export function stationStats(): {
  total: number
  normal: number
  fireCount: number
  waiting: number
} {
  const stations = listStations()
  return {
    total: stations.length,
    normal: stations.filter((s) => s.status === STATION_NORMAL).length,
    // 每个站点只取最新一条检查记录的火种数，不累计历史，避免重复。
    fireCount: stations.reduce((sum, s) => sum + s.fireCount, 0),
    waiting: stations.filter((s) => s.status === STATION_WAITING).length,
  }
}

/** 通行详情：现场检查记录（含历史），按检查时间倒序。 */
export function listPassageDetails(stationId?: number): InspectionRow[] {
  ensureDomain()
  const rows = allRows()
  const all = ((rows.checkpointInspection ?? []) as DomainRow[]).slice()
  const filtered =
    stationId === undefined
      ? all
      : all.filter((r) => Number(r.stationId) === stationId)
  return filtered.sort((a, b) => {
    const ta = String(a.inspectionAt ?? '')
    const tb = String(b.inspectionAt ?? '')
    if (ta !== tb) {
      return tb < ta ? -1 : 1
    }
    return Number(b.id) - Number(a.id)
  })
}

/** 历史班次：按原检查时间回放，不随后续站点状态改写。 */
export function listShifts(stationId?: number): ShiftRow[] {
  ensureDomain()
  const rows = allRows()
  const all = ((rows.checkpointShift ?? []) as DomainRow[]).slice()
  return all
    .filter((r) => stationId === undefined || Number(r.stationId) === stationId)
    .sort((a, b) => {
      const ta = String(a.sourceCheckedAt ?? '')
      const tb = String(b.sourceCheckedAt ?? '')
      return tb < ta ? -1 : ta === tb ? 0 : 1
    })
}

export function listSupplyWarnings(): WarningRow[] {
  ensureDomain()
  const rows = allRows()
  return ((rows.supplyWarning ?? []) as DomainRow[]).slice()
}

// ---------- 写动作（全部带守卫 + 乐观锁 + 事务） ----------

/**
 * 现场检查（升级检查 / 现场复查）。
 * 冲突时以现场检查为准：直接追加一条更晚的检查记录，站点投影随之改判，
 * 旧检查记录保留为历史。
 */
export function submitInspection(input: InspectionInput): DomainResult {
  const draft = openDraft()
  const station = findStation(draft, input.stationId)
  if (!station) {
    return { ok: false, message: `没有找到编号为 ${input.stationId} 的站点` }
  }
  if (!checkVersion(station, input.expectedVersion)) {
    return { ok: false, message: '站点数据已被他人更新，请刷新后重试（本次检查未提交）' }
  }
  if (station.status === STATION_WAITING) {
    return { ok: false, message: '站点正在等待换岗交接，请先完成交接再上报现场检查' }
  }
  const scene =
    input.现场状态 === STATION_UPGRADED ? STATION_UPGRADED : STATION_NORMAL
  const inspectionAt = input.检查时间?.trim() || nowText()

  draft.checkpointInspection.push({
    id: nextId(draft.checkpointInspection),
    inspectionAt,
    stationId: Number(station.id),
    站点编号: String(station.站点编号 ?? ''),
    站点位置: String(station.站点位置 ?? ''),
    所属林场: String(station.所属林场 ?? '未归属林场'),
    值守人员: String(station.值守人员 ?? ''),
    检查项目: input.检查项目?.trim() || '常规检查',
    通行车辆数: num(input.通行车辆数),
    收缴火种数: num(input.收缴火种数),
    现场状态: scene,
    baseline: false,
  })
  bumpVersion(station)
  commit(draft)

  const overwritten = station.status === STATION_UPGRADED && scene === STATION_NORMAL
  return {
    ok: true,
    message: `${station.站点编号} 现场检查已登记（${inspectionAt}），状态以本次现场检查为准${
      overwritten ? '，已覆盖此前的升级检查结论' : ''
    }`,
  }
}

/** 安排换岗：仅「正常检查」可进入；升级检查/关闭/待换岗一律拒绝。并发只接受一个结果。 */
export function arrangeShift(input: ShiftInput): DomainResult {
  const draft = openDraft()
  const station = findStation(draft, input.stationId)
  if (!station) {
    return { ok: false, message: `没有找到编号为 ${input.stationId} 的站点` }
  }
  if (!checkVersion(station, input.expectedVersion)) {
    return { ok: false, message: '换岗冲突：该站点已被其他人操作，本次换岗未被接受' }
  }
  if (station.status === STATION_UPGRADED) {
    return { ok: false, message: '站点处于升级检查，按现场检查口径暂不允许安排换岗' }
  }
  if (station.status === STATION_CLOSED) {
    return { ok: false, message: '站点已临时关闭，不能安排换岗，请先重新开放' }
  }
  if (station.status === STATION_WAITING) {
    return { ok: false, message: '该站点已有待交接换岗，并发换岗只接受一个结果' }
  }

  const latest = latestInspection(draft.checkpointInspection, Number(station.id))
  const sourceCheckedAt = latest
    ? String(latest.inspectionAt ?? '')
    : `${String(station.值班日期 ?? '').slice(0, 10) || '1970-01-01'} 00:00`

  draft.checkpointShift.push({
    id: nextId(draft.checkpointShift),
    stationId: Number(station.id),
    站点编号: String(station.站点编号 ?? ''),
    排班日期: input.排班日期?.trim() || sourceCheckedAt.slice(0, 10),
    值勤时段: input.值勤时段?.trim() || '待排',
    交班人员: String(station.值守人员 ?? ''),
    接班人员: input.接班人员?.trim() || '待指派',
    状态: STATION_WAITING,
    // 历史班次兼容：冻结安排换岗那一刻的原检查时间与站点状态。
    sourceCheckedAt,
    sourceStationStatus: STATION_NORMAL,
    snapshot: false,
  })
  station.status = STATION_WAITING
  bumpVersion(station)
  commit(draft)
  return {
    ok: true,
    message: `${station.站点编号} 已安排换岗，原检查时间 ${sourceCheckedAt}，等待接班交接`,
  }
}

/** 完成交接：等待换岗 → 正常检查。 */
export function completeHandover(
  stationId: number,
  expectedVersion?: number,
): DomainResult {
  return simpleTransition(
    stationId,
    expectedVersion,
    new Set([STATION_WAITING]),
    STATION_NORMAL,
    (draft, station) => {
      const open = draft.checkpointShift
        .filter(
          (shift) =>
            Number(shift.stationId) === Number(station.id) &&
            String(shift.状态) !== '已交接',
        )
        .sort(
          (a, b) => Number(b.id) - Number(a.id),
        )[0]
      if (open) {
        open.状态 = '已交接'
        open.交接时间 = nowText()
      }
    },
    '换岗交接已完成，站点恢复正常检查',
    '该站点当前不在等待换岗，不能完成交接',
  )
}

/** 关闭站点：仅正常检查可关闭（升级检查以现场为准，不能被关闭动作盖过）。 */
export function closeStation(
  stationId: number,
  expectedVersion?: number,
): DomainResult {
  return simpleTransition(
    stationId,
    expectedVersion,
    new Set([STATION_NORMAL]),
    STATION_CLOSED,
    undefined,
    '站点已临时关闭',
    '只有正常检查的站点可以关闭',
  )
}

/** 重新开放：临时关闭 → 正常检查。 */
export function reopenStation(
  stationId: number,
  expectedVersion?: number,
): DomainResult {
  return simpleTransition(
    stationId,
    expectedVersion,
    new Set([STATION_CLOSED]),
    STATION_NORMAL,
    undefined,
    '站点已重新开放，恢复正常检查',
    '只有临时关闭的站点可以重新开放',
  )
}

/** 解除升级：以一条「正常检查」现场记录解除，保证权威源仍是现场检查。 */
export function releaseUpgrade(
  stationId: number,
  expectedVersion?: number,
): DomainResult {
  const draft = openDraft()
  const station = findStation(draft, stationId)
  if (!station) {
    return { ok: false, message: `没有找到编号为 ${stationId} 的站点` }
  }
  if (!checkVersion(station, expectedVersion)) {
    return { ok: false, message: '站点数据已被他人更新，请刷新后重试' }
  }
  if (station.status !== STATION_UPGRADED) {
    return { ok: false, message: '只有升级检查的站点需要解除升级' }
  }
  const latest = latestInspection(draft.checkpointInspection, stationId)
  draft.checkpointInspection.push({
    id: nextId(draft.checkpointInspection),
    inspectionAt: nowText(),
    stationId,
    站点编号: String(station.站点编号 ?? ''),
    站点位置: String(station.站点位置 ?? ''),
    所属林场: String(station.所属林场 ?? '未归属林场'),
    值守人员: String(station.值守人员 ?? ''),
    检查项目: latest ? String(latest.检查项目 ?? '常规检查') : '常规检查',
    通行车辆数: latest ? num(latest.通行车辆数) : 0,
    收缴火种数: latest ? num(latest.收缴火种数) : 0,
    现场状态: STATION_NORMAL,
    baseline: false,
  })
  bumpVersion(station)
  commit(draft)
  return { ok: true, message: `${station.站点编号} 已按现场复查解除升级，恢复正常检查` }
}

function simpleTransition(
  stationId: number,
  expectedVersion: number | undefined,
  allowed: Set<StationStatus>,
  target: StationStatus,
  sideEffect: ((draft: Draft, station: EntryRow) => void) | undefined,
  okMessage: string,
  rejectMessage: string,
): DomainResult {
  const draft = openDraft()
  const station = findStation(draft, stationId)
  if (!station) {
    return { ok: false, message: `没有找到编号为 ${stationId} 的站点` }
  }
  if (!checkVersion(station, expectedVersion)) {
    return { ok: false, message: '站点数据已被他人更新，请刷新后重试' }
  }
  if (!allowed.has(station.status as StationStatus)) {
    return { ok: false, message: rejectMessage }
  }
  sideEffect?.(draft, station)
  station.status = target
  bumpVersion(station)
  commit(draft)
  return { ok: true, message: `${station.站点编号 ?? ''} ${okMessage}`.trim() }
}

/** 供「物资储备」等其他模块在自身写入后调用：同事务重算预警，保证两模块读到同一份清单。 */
export function recalcAndCommit(): void {
  const draft = openDraft()
  commit(draft)
}

function cloneRows<T>(rows: T[]): T[] {
  return JSON.parse(JSON.stringify(rows)) as T[]
}

/**
 * 物资模块写入：物资行与预警投影在同一事务里提交（一次 localStorage 写入），
 * 站点、物资、预警要么一起新要么一起旧。
 */
export function replaceSupply(rows: EntryRow[]): void {
  const draft = openDraft()
  draft.supply = cloneRows(rows)
  commit(draft)
}

/** 物资模块重置：物资回到种子，预警按种子即时重算，同事务落库。 */
export function resetSupply(seedRows: EntryRow[]): void {
  replaceSupply(cloneRows(seedRows))
}

export { COLLECTIONS as CHECKPOINT_COLLECTIONS }
