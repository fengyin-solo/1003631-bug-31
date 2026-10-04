import { allRows, commitKeys, listRows, nextId } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 检查站领域：站点（checkpoint）、通行明细（checkpoint_passage）、
// 换岗批次（checkpoint_relief）、物资（supply）四张表的联动都收口在这里，
// 页面与通用 local-service 只做展示与转发，不在这里之外改状态。
export const CHECKPOINT_KEY = 'checkpoint'
export const PASSAGE_KEY = 'checkpoint_passage'
export const RELIEF_KEY = 'checkpoint_relief'
export const SUPPLY_KEY = 'supply'

export type SiteStatus = '正常检查' | '升级检查' | '等待换岗' | '临时关闭'
export type SiteLevel = '正常检查' | '升级检查'
export type SupplyStatus = '充足' | '偏低' | '需补充' | '已过期'

export const SITE_STATUSES: SiteStatus[] = ['正常检查', '升级检查', '等待换岗', '临时关闭']

export type PassageInput = {
  检查时间?: string
  通行车辆数?: string | number
  收缴火种数?: string | number
}

export type ReliefInput = {
  接班人员?: string
  检查时间?: string
  version?: number
}

export type SupplyInput = {
  实际储备量?: string | number
}

export type StationView = EntryRow & {
  班次: string
  现场检查级别: SiteLevel
  version: number
  累计通行车辆数: number
  累计收缴火种数: number
}

export type PassageView = EntryRow & {
  站点编号: string
  检查时间: string
  班次: string
  现场检查级别: SiteLevel
  通行车辆数: number
  收缴火种数: number
}

export type ReliefView = EntryRow & {
  站点编号: string
  原检查时间: string
  完成时间: string
  班次: string
  原值守人员: string
  接班人员: string
  现场检查级别: SiteLevel
}

export type SupplyWarning = {
  id: number
  物资编号: string
  物资名称: string
  物资类别: string
  储备林场: string
  预警储备量: number
  实际储备量: number
  补充中: boolean
  status: SupplyStatus
}

/* ------------------------------ 补值口径 ------------------------------ */

// 计数口径：空值、非数字、负数一律补 0，小数四舍五入取整；火种/车辆都按件（台）计。
export function toCount(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === '') {
    return 0
  }
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return 0
  }
  return Math.max(0, Math.round(num))
}

export function dayShiftOf(date: Date): string {
  return date.getHours() >= 8 && date.getHours() < 20 ? '白班' : '夜班'
}

function pad2(num: number): string {
  return String(num).padStart(2, '0')
}

export function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// 检查时间补值：空值/无法解析补当前时刻；能解析但只有日期（yyyy-MM-dd）补当前时分，
// 班次再按时间归 08:00-20:00 白班、其余夜班。
export function resolveCheckedAt(raw?: string): { time: string; shift: string } {
  const now = new Date()
  const text = String(raw ?? '').trim()
  if (!text) {
    return { time: formatDateTime(now), shift: dayShiftOf(now) }
  }
  const full = new Date(text.replace(/-/g, '/'))
  if (Number.isNaN(full.getTime())) {
    return { time: formatDateTime(now), shift: dayShiftOf(now) }
  }
  // 只给了日期：保留原日期，时分补当前。
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    full.setHours(now.getHours(), now.getMinutes(), 0, 0)
  }
  return { time: formatDateTime(full), shift: dayShiftOf(full) }
}

// 预警阈值口径：阈值空、非数字、非正 → 视为该物资不设预警（永远充足，除非过期）。
export function thresholdOf(row: EntryRow): number | null {
  const num = Number(row['预警储备量'])
  if (!Number.isFinite(num) || num <= 0) {
    return null
  }
  return Math.round(num)
}

// 实际储量口径：空值、非数字、负数补 0（保守触发补充，宁滥勿缺）。
export function stockOf(row: EntryRow): number {
  return toCount(row['实际储备量'])
}

// 物资状态一律由储量派生，动作不再固化状态，旧值不会残留：
// 已过期 > 实际≤阈值50% 需补充 > 实际≤阈值 偏低 > 充足；无阈值则除过期外恒为充足。
export function deriveSupplyStatus(row: EntryRow): SupplyStatus {
  if (row['已过期'] === true) {
    return '已过期'
  }
  const threshold = thresholdOf(row)
  if (threshold === null) {
    return '充足'
  }
  const stock = stockOf(row)
  if (stock <= Math.floor(threshold / 2)) {
    return '需补充'
  }
  if (stock <= threshold) {
    return '偏低'
  }
  return '充足'
}

function syncSupplyRow(row: EntryRow): EntryRow {
  const status = deriveSupplyStatus(row)
  return {
    ...row,
    status,
    pending: status === '偏低' || status === '需补充',
    abnormal: status === '需补充' || status === '已过期',
    物资状态: status,
  }
}

function levelOf(station: EntryRow): SiteLevel {
  return station['现场检查级别'] === '升级检查' ? '升级检查' : '正常检查'
}

function stationFlags(status: SiteStatus): Pick<EntryRow, 'pending' | 'abnormal'> {
  return {
    pending: status === '升级检查' || status === '等待换岗',
    abnormal: false,
  }
}

/* --------------------------- 老存档迁移（幂等） --------------------------- */

const MIGRATED_FLAG = 'forest-fire:checkpoint-migrated-v2'

let migrated = false

// 老版本站点行没有版本号/现场级别，火种数还是占位文本；第一次进领域时一次性清洗。
// 迁移本身也走同一份快照 + 一次落库，不产生半成品状态。
export function migrateIfNeeded(force = false): void {
  if (migrated) {
    return
  }
  if (
    !force &&
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(MIGRATED_FLAG) === '1'
  ) {
    migrated = true
    return
  }

  const stations = listRows(CHECKPOINT_KEY)
  const passages = listRows(PASSAGE_KEY)
  const needStationMigration = stations.some(
    (row) => typeof row.version !== 'number' || row['现场检查级别'] === undefined,
  )
  const needPassageBackfill = passages.length === 0 && stations.length > 0
  const needSupplyNormalize = listRows(SUPPLY_KEY).some(
    (row) => row.status !== deriveSupplyStatus(row),
  )

  if (!needStationMigration && !needPassageBackfill && !needSupplyNormalize) {
    migrated = true
    markMigrated()
    return
  }

  commitKeys((draft) => {
    // 站点：补版本、现场级别（取运行状态或原状态里的升级态）、班次，计数快照清零。
    draft[CHECKPOINT_KEY] = (draft[CHECKPOINT_KEY] ?? []).map((row) => {
      const prior = String(row['运行状态'] ?? row.status ?? '')
      const level: SiteLevel = prior === '升级检查' ? '升级检查' : '正常检查'
      const status = (SITE_STATUSES.includes(prior as SiteStatus) ? prior : '正常检查') as SiteStatus
      const flags = stationFlags(status)
      const 值班日期 = typeof row['值班日期'] === 'string' ? row['值班日期'] : formatDate(new Date())
      return {
        ...row,
        status,
        ...flags,
        运行状态: status,
        version: typeof row.version === 'number' ? row.version : 1,
        现场检查级别: level,
        班次: typeof row['班次'] === 'string' && row['班次'] ? row['班次'] : '白班',
        值班日期,
        通行车辆数: '0',
        收缴火种数: '0',
      }
    })

    // 通行明细缺失：按站点行上的旧快照（占位文本会按补值口径补 0）生成一条历史明细，
    // 检查时间挂值班日期 09:00，历史班次按该时间兼容，不覆盖种子里已有的明细。
    if ((draft[PASSAGE_KEY] ?? []).length === 0) {
      draft[PASSAGE_KEY] = draft[CHECKPOINT_KEY].map((station, index) => ({
        id: index + 1,
        status: '有效',
        pending: false,
        abnormal: false,
        站点编号: String(station['站点编号'] ?? ''),
        检查时间: `${String(station['值班日期'] ?? formatDate(new Date()))} 09:00`,
        登记时间: formatDateTime(new Date()),
        班次: '白班',
        现场检查级别: levelOf(station),
        通行车辆数: toCount(station['通行车辆数']),
        收缴火种数: toCount(station['收缴火种数']),
      }))
    }

    draft[RELIEF_KEY] = draft[RELIEF_KEY] ?? []

    // 物资：状态全部按储量重算，清掉动作残留的旧预警值。
    draft[SUPPLY_KEY] = (draft[SUPPLY_KEY] ?? []).map((row) => {
      const normalized: EntryRow = {
        ...row,
        预警储备量:
          thresholdOf(row) === null ? row['预警储备量'] : thresholdOf(row) as number,
        实际储备量: stockOf(row),
        补充中: row['补充中'] === true,
        已过期: row['已过期'] === true || row.status === '已过期',
      }
      return syncSupplyRow(normalized)
    })
  }, [CHECKPOINT_KEY, PASSAGE_KEY, RELIEF_KEY, SUPPLY_KEY])

  migrated = true
  markMigrated()
}

function markMigrated(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MIGRATED_FLAG, '1')
  }
}

/* ------------------------------ 读模型 ------------------------------ */

function stationPassageMap(): Map<string, PassageView[]> {
  const map = new Map<string, PassageView[]>()
  for (const row of listRows(PASSAGE_KEY)) {
    if (String(row.status) !== '有效') {
      continue
    }
    const code = String(row['站点编号'] ?? '')
    const list = map.get(code) ?? []
    list.push(toPassageView(row))
    map.set(code, list)
  }
  return map
}

function toPassageView(row: EntryRow): PassageView {
  const { time, shift } = resolveCheckedAt(row['检查时间'] as string | undefined)
  return {
    ...row,
    站点编号: String(row['站点编号'] ?? ''),
    检查时间: time,
    班次: typeof row['班次'] === 'string' && row['班次'] ? row['班次'] : shift,
    现场检查级别: row['现场检查级别'] === '升级检查' ? '升级检查' : '正常检查',
    通行车辆数: toCount(row['通行车辆数']),
    收缴火种数: toCount(row['收缴火种数']),
  }
}

export function listStations(): StationView[] {
  migrateIfNeeded()
  const passages = stationPassageMap()
  return listRows(CHECKPOINT_KEY).map((row) => {
    const items = passages.get(String(row['站点编号'] ?? '')) ?? []
    return {
      ...row,
      status: String(row.status),
      班次: typeof row['班次'] === 'string' && row['班次'] ? row['班次'] : '白班',
      现场检查级别: levelOf(row),
      version: typeof row.version === 'number' ? row.version : 1,
      累计通行车辆数: items.reduce((sum, item) => sum + item.通行车辆数, 0),
      累计收缴火种数: items.reduce((sum, item) => sum + item.收缴火种数, 0),
    }
  })
}

export function findStation(id: number): StationView | undefined {
  return listStations().find((row) => Number(row.id) === id)
}

export function stationStats(): { label: string; value: number }[] {
  const stations = listStations()
  return [
    { label: '站点总数', value: stations.length },
    { label: '正常检查数', value: stations.filter((row) => row.status === '正常检查').length },
    {
      label: '升级检查数',
      value: stations.filter((row) => row.status === '升级检查' || row.status === '等待换岗').length,
    },
    // 收缴火种总数只从通行明细求和：同站点重复查看列表不会把火种数重复显示。
    {
      label: '收缴火种数',
      value: stations.reduce((sum, row) => sum + row.累计收缴火种数, 0),
    },
  ]
}

export function listPassages(stationId?: number): PassageView[] {
  migrateIfNeeded()
  let code: string | undefined
  if (stationId !== undefined) {
    const station = findStation(stationId)
    if (!station) {
      return []
    }
    code = String(station['站点编号'] ?? '')
  }
  const all: PassageView[] = []
  for (const [stationCode, items] of stationPassageMap()) {
    if (code === undefined || stationCode === code) {
      all.push(...items)
    }
  }
  return all.sort((a, b) => b.检查时间.localeCompare(a.检查时间))
}

export function listReliefs(stationId?: number): ReliefView[] {
  migrateIfNeeded()
  let code: string | undefined
  if (stationId !== undefined) {
    const station = findStation(stationId)
    if (!station) {
      return []
    }
    code = String(station['站点编号'] ?? '')
  }
  return listRows(RELIEF_KEY)
    .filter((row) => code === undefined || String(row['站点编号'] ?? '') === code)
    .map((row) => ({
      ...row,
      站点编号: String(row['站点编号'] ?? ''),
      原检查时间: String(row['原检查时间'] ?? ''),
      完成时间: String(row['完成时间'] ?? ''),
      班次: String(row['班次'] ?? ''),
      原值守人员: String(row['原值守人员'] ?? ''),
      接班人员: String(row['接班人员'] ?? ''),
      现场检查级别: levelOf(row),
    }))
    .sort((a, b) => b.完成时间.localeCompare(a.完成时间)) as ReliefView[]
}

/* ------------------------------ 物资预警 ------------------------------ */

export function listSupplyWarnings(): SupplyWarning[] {
  migrateIfNeeded()
  return listRows(SUPPLY_KEY)
    .map((row) => syncSupplyRow(row))
    .map((row) => ({
      id: Number(row.id),
      物资编号: String(row['物资编号'] ?? ''),
      物资名称: String(row['物资名称'] ?? ''),
      物资类别: String(row['物资类别'] ?? ''),
      储备林场: String(row['储备林场'] ?? ''),
      预警储备量: thresholdOf(row) ?? 0,
      实际储备量: stockOf(row),
      补充中: row['补充中'] === true,
      status: deriveSupplyStatus(row),
    }))
}

export function supplyStats(): { label: string; value: number }[] {
  const items = listSupplyWarnings()
  return [
    { label: '物资种类', value: items.length },
    { label: '需补充种类', value: items.filter((item) => item.status === '需补充').length },
    {
      label: '预警种类',
      value: items.filter((item) => item.status === '偏低' || item.status === '需补充').length,
    },
    { label: '过期种类', value: items.filter((item) => item.status === '已过期').length },
  ]
}

/* --------------------------- 站点状态机动作 --------------------------- */

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function requireStation(
  draft: Record<string, EntryRow[]>,
  id: number,
): { index: number; row: EntryRow } | ActionResult {
  const rows = draft[CHECKPOINT_KEY] ?? []
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的防火检查站`)
  }
  return { index, row: rows[index] }
}

function updateStation(draft: Record<string, EntryRow[]>, index: number, next: EntryRow): void {
  draft[CHECKPOINT_KEY][index] = next
}

// 通用入口：检查站的动作全部走这里，通用 runAction 不再直接覆盖站点状态。
export function runSiteAction(id: number, action: string): ActionResult
export function runSiteAction(
  id: number,
  action: '登记通行',
  input?: PassageInput,
): ActionResult
export function runSiteAction(
  id: number,
  action: '完成换岗',
  input?: ReliefInput,
): ActionResult
export function runSiteAction(
  id: number,
  action: '确认补充',
  input?: SupplyInput,
): ActionResult
export function runSiteAction(
  id: number,
  action: string,
  input?: PassageInput & ReliefInput & SupplyInput,
): ActionResult {
  migrateIfNeeded()

  const guard = guardSiteAction(id, action)
  if (!guard.ok) {
    return guard
  }

  try {
    let message = ''
    commitKeys((draft) => {
      const found = requireStation(draft, id)
      if ('ok' in found) {
        throw new Error(found.message)
      }
      const { index, row: station } = found

      // 完成换岗走乐观锁：页面带着读到的 version 进来，中途被别人改过就整单驳回，
      // 并发两次点击只有第一个结果落库。
      if (action === '完成换岗') {
        const expected = input?.version
        if (typeof expected === 'number' && station.version !== expected) {
          throw new Error('该站点换岗信息已被其他操作更新，请刷新后重试（本次换岗未生效）')
        }
        const result = completeRelief(draft, index, station, input ?? {})
        message = result
        return
      }

      switch (action) {
        case '升级检查':
          message = escalate(draft, index, station)
          break
        case '安排换岗':
          message = arrangeRelief(draft, index, station)
          break
        case '关闭站点':
          message = closeStation(draft, index, station)
          break
        case '恢复开放':
          message = reopenStation(draft, index, station)
          break
        case '登记通行':
          message = registerPassage(draft, station, input ?? {})
          break
        default:
          throw new Error(`防火检查站没有登记「${action}」这个动作`)
      }
    }, [CHECKPOINT_KEY, PASSAGE_KEY, RELIEF_KEY, SUPPLY_KEY])
    return { ok: true, message }
  } catch (error) {
    // 事务里任何一步失败：站点、明细、批次、预警都不会落库，整单退回。
    return fail(error instanceof Error ? error.message : '操作失败，已整单退回')
  }
}

// 前置校验：状态冲突时以现场检查为准——
// 升级检查的站点不能被「安排换岗」降回正常检查，只能挂「等待换岗」，
// 待换岗期间禁止再升级/关闭/登记通行，避免同一站点两个班次同时写数。
function guardSiteAction(id: number, action: string): ActionResult {
  const station = findStation(id)
  if (!station) {
    return fail(`没有找到编号为 ${id} 的防火检查站`)
  }
  const status = String(station.status) as SiteStatus
  const allowed: Record<string, SiteStatus[]> = {
    升级检查: ['正常检查', '临时关闭'],
    安排换岗: ['正常检查', '升级检查'],
    完成换岗: ['等待换岗'],
    关闭站点: ['正常检查', '升级检查'],
    恢复开放: ['临时关闭'],
    登记通行: ['正常检查', '升级检查'],
  }
  const accept = allowed[action]
  if (!accept) {
    return fail(`防火检查站没有登记「${action}」这个动作`)
  }
  if (!accept.includes(status)) {
    const reason: Partial<Record<SiteStatus, string>> = {
      升级检查: '站点正在升级检查，冲突时以现场检查为准，请先安排换岗交接',
      等待换岗: '站点等待换岗交接，需先完成换岗或等接班结果落库',
      临时关闭: '站点已临时关闭，请先恢复开放',
      正常检查: '站点当前为正常检查状态，无需该操作',
    }
    return fail(`当前状态「${status}」不允许「${action}」：${reason[status] ?? ''}`)
  }
  return { ok: true, message: '' }
}

function escalate(draft: Record<string, EntryRow[]>, index: number, station: EntryRow): string {
  // 现场升级：锁定现场级别，待换岗完成后新班次仍继承升级检查。
  const next: EntryRow = {
    ...station,
    status: '升级检查',
    ...stationFlags('升级检查'),
    运行状态: '升级检查',
    现场检查级别: '升级检查',
    version: Number(station.version ?? 1) + 1,
  }
  updateStation(draft, index, next)
  return '站点已升级检查，现场级别锁定为「升级检查」；换岗交接前火种与车辆照常登记'
}

function arrangeRelief(
  draft: Record<string, EntryRow[]>,
  index: number,
  station: EntryRow,
): string {
  const level = levelOf(station)
  const next: EntryRow = {
    ...station,
    status: '等待换岗',
    ...stationFlags('等待换岗'),
    运行状态: '等待换岗',
    现场检查级别: level,
    version: Number(station.version ?? 1) + 1,
  }
  updateStation(draft, index, next)
  return `已安排换岗，站点进入「等待换岗」；现场检查级别保持「${level}」，完成交接后按现场结果恢复`
}

function completeRelief(
  draft: Record<string, EntryRow[]>,
  index: number,
  station: EntryRow,
  input: ReliefInput,
): string {
  const level = levelOf(station)
  const now = new Date()
  const { time: originalCheckedAt, shift } = resolveCheckedAt(input.检查时间)
  const successor = String(input.接班人员 ?? '').trim() || '（未填报接班人员）'

  // 换岗批次只追加、不改正文：原检查时间、原班次、原现场级别原样留档，历史按原检查时间兼容。
  draft[RELIEF_KEY] = draft[RELIEF_KEY] ?? []
  draft[RELIEF_KEY].push({
    id: nextId(RELIEF_KEY),
    status: '已完成',
    pending: false,
    abnormal: false,
    站点编号: String(station['站点编号'] ?? ''),
    原检查时间: originalCheckedAt,
    完成时间: formatDateTime(now),
    班次: shift,
    原值守人员: String(station['值守人员'] ?? ''),
    接班人员: successor,
    现场检查级别: level,
  })

  // 完成换岗后状态以现场检查为准：现场仍升级就继续升级检查，不因交接动作被降级。
  const restoredStatus: SiteStatus = level === '升级检查' ? '升级检查' : '正常检查'
  updateStation(draft, index, {
    ...station,
    status: restoredStatus,
    ...stationFlags(restoredStatus),
    运行状态: restoredStatus,
    现场检查级别: level,
    值守人员: successor,
    班次: dayShiftOf(now),
    值班日期: formatDate(now),
    version: Number(station.version ?? 1) + 1,
  })
  return `换岗完成，${String(station['站点编号'] ?? '')}由「${String(station['值守人员'] ?? '')}」交接给「${successor}」，现场仍为「${level}」`
}

function closeStation(
  draft: Record<string, EntryRow[]>,
  index: number,
  station: EntryRow,
): string {
  const next: EntryRow = {
    ...station,
    status: '临时关闭',
    ...stationFlags('临时关闭'),
    运行状态: '临时关闭',
    version: Number(station.version ?? 1) + 1,
  }
  updateStation(draft, index, next)
  return '站点已临时关闭，历史通行明细保留，恢复开放后继续累计'
}

function reopenStation(
  draft: Record<string, EntryRow[]>,
  index: number,
  station: EntryRow,
): string {
  const level = levelOf(station)
  const status: SiteStatus = level === '升级检查' ? '升级检查' : '正常检查'
  const next: EntryRow = {
    ...station,
    status,
    ...stationFlags(status),
    运行状态: status,
    version: Number(station.version ?? 1) + 1,
  }
  updateStation(draft, index, next)
  return `站点已恢复开放，按现场检查结果恢复为「${status}」`
}

function registerPassage(
  draft: Record<string, EntryRow[]>,
  station: EntryRow,
  input: PassageInput,
): string {
  const { time, shift } = resolveCheckedAt(input.检查时间)
  const vehicles = toCount(input.通行车辆数)
  const fires = toCount(input.收缴火种数)
  const level = levelOf(station)
  const code = String(station['站点编号'] ?? '')

  // 唯一键：站点 + 检查时间 + 班次。同一现场重复提交只更新不新增，火种数不会重复累计。
  const rows = draft[PASSAGE_KEY] ?? []
  const existing = rows.findIndex(
    (item) =>
      String(item['站点编号'] ?? '') === code &&
      String(item['检查时间'] ?? '') === time &&
      String(item['班次'] ?? '') === shift,
  )

  if (existing >= 0) {
    const old = rows[existing]
    rows[existing] = {
      ...old,
      status: '有效',
      现场检查级别: level,
      通行车辆数: vehicles,
      收缴火种数: fires,
      登记时间: formatDateTime(new Date()),
    }
    return `通行记录已按 ${time}（${shift}）覆盖更新：车辆 ${vehicleText(vehicles)}，收缴火种 ${fires} 件（未重复计数）`
  }

  rows.push({
    id: nextId(PASSAGE_KEY),
    status: '有效',
    pending: false,
    abnormal: false,
    站点编号: code,
    检查时间: time,
    登记时间: formatDateTime(new Date()),
    班次: shift,
    现场检查级别: level,
    通行车辆数: vehicles,
    收缴火种数: fires,
  })
  draft[PASSAGE_KEY] = rows
  return `通行明细已登记：${time}（${shift}）车辆 ${vehicles} 台、收缴火种 ${fires} 件`
}

// 中文量词小工具，避免消息里「车辆 0」太生硬。
function vehicleText(count: number): string {
  return `${count} 台`
}

/* --------------------------- 物资储备联动动作 --------------------------- */

export function runSupplyAction(id: number, action: string, input?: SupplyInput): ActionResult {
  migrateIfNeeded()
  const rows = listRows(SUPPLY_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的防火物资`)
  }

  try {
    let message = ''
    commitKeys((draft) => {
      const supplyRows = draft[SUPPLY_KEY] ?? []
      const target = supplyRows.find((row) => Number(row.id) === id)
      if (!target) {
        throw new Error(`没有找到编号为 ${id} 的防火物资`)
      }

      if (action === '发起补充') {
        target['补充中'] = true
        message = '已发起补充申请，预警清单将按实际储量持续重算'
      } else if (action === '确认补充') {
        target['实际储备量'] = toCount(input?.实际储备量)
        target['补充中'] = false
        message = `补充已入库，实际储备量更新为 ${toCount(input?.实际储备量)}，预警状态按补值口径重算`
      } else if (action === '标记过期') {
        target['已过期'] = true
        message = '已标记过期，预警清单按过期优先展示'
      } else {
        throw new Error(`防火物资没有登记「${action}」这个动作`)
      }

      // 状态当场派生并同次落库：不再保留动作写死的旧状态。
      const i = supplyRows.findIndex((row) => Number(row.id) === id)
      supplyRows[i] = syncSupplyRow(target)
      draft[SUPPLY_KEY] = supplyRows
    }, [SUPPLY_KEY])
    return { ok: true, message }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '物资操作失败，已整单退回')
  }
}

/* ------------------------------- 调试辅助 ------------------------------- */

// 仅供测试/重置后重建内存标记使用。
export function resetMigrationFlag(): void {
  migrated = false
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(MIGRATED_FLAG)
  }
}

export { allRows }
