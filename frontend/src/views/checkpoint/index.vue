<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">站点状态以现场检查为唯一权威源：升级检查后锁定换岗，通行详情按检查时间回放，物资预警同事务重算。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in liveStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>最近检查</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.lastCheckedAt || '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row.status)"
              :key="action.key"
              class="link"
              type="button"
              :disabled="busyId === row.id"
              @click="onAction(action.key, row)"
            >
              {{ action.label }}
            </button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火检查站数据</td>
        </tr>
      </tbody>
    </table>

    <!-- 升级检查 / 现场复查：补值口径弹窗，提交结果以现场检查为准 -->
    <div v-if="form.open" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3>{{ form.title }} · {{ form.code }}</h3>
        <p class="page-desc">未填写项按补值口径处理：时间取当前、火种/车辆缺省 0、检查项目缺省「常规检查」。</p>

        <template v-if="form.kind === 'inspection'">
          <label class="filter-item">
            <span>现场结论</span>
            <select v-model="inspection.scene">
              <option value="升级检查">升级检查（锁定换岗）</option>
              <option value="正常检查">现场复查正常（覆盖升级结论）</option>
            </select>
          </label>
          <label class="filter-item">
            <span>检查时间（留空取当前）</span>
            <input v-model="inspection.at" type="datetime-local" />
          </label>
          <label class="filter-item">
            <span>检查项目</span>
            <input v-model="inspection.project" placeholder="常规检查" />
          </label>
          <label class="filter-item">
            <span>通行车辆数</span>
            <input v-model="inspection.vehicles" type="number" min="0" />
          </label>
          <label class="filter-item">
            <span>收缴火种数</span>
            <input v-model="inspection.fires" type="number" min="0" />
          </label>
        </template>

        <template v-else>
          <p class="page-desc">
            班次将冻结当前站点的<strong>原检查时间（{{ form.sourceCheckedAt }}）</strong>与状态快照，历史班次不随后续变化改写。
          </p>
          <label class="filter-item">
            <span>接班人员（缺省：待指派）</span>
            <input v-model="shift.reliever" placeholder="待指派" />
          </label>
          <label class="filter-item">
            <span>值勤时段（缺省：待排）</span>
            <input v-model="shift.period" placeholder="如 夜班 20:00-次日08:00" />
          </label>
        </template>

        <footer class="modal-foot">
          <button class="btn" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : '确认提交' }}
          </button>
        </footer>
      </form>
    </div>

    <h3 class="section-title">通行详情（现场检查记录，按检查时间倒序）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>检查时间</th><th>站点编号</th><th>值守人员</th><th>检查项目</th>
          <th>通行车辆数</th><th>收缴火种数</th><th>现场结论</th><th>来源</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in passages" :key="String(item.id)">
          <td>{{ item.inspectionAt }}</td>
          <td>{{ item.站点编号 }}</td>
          <td>{{ item.值守人员 }}</td>
          <td>{{ item.检查项目 }}</td>
          <td>{{ item.通行车辆数 }}</td>
          <td>{{ item.收缴火种数 }}</td>
          <td>{{ item.现场状态 }}</td>
          <td>{{ item.baseline ? '基线补值' : '现场上报' }}</td>
        </tr>
        <tr v-if="!passages.length">
          <td colspan="8" class="empty-state">暂无现场检查记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">历史班次（按原检查时间兼容）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>原检查时间</th><th>站点编号</th><th>排班日期</th><th>值勤时段</th>
          <th>交班人员</th><th>接班人员</th><th>班次状态</th><th>当时站点状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in shifts" :key="String(item.id)">
          <td>{{ item.sourceCheckedAt }}</td>
          <td>{{ item.站点编号 }}</td>
          <td>{{ item.排班日期 }}</td>
          <td>{{ item.值勤时段 }}</td>
          <td>{{ item.交班人员 }}</td>
          <td>{{ item.接班人员 }}</td>
          <td>{{ item.状态 }}</td>
          <td>{{ item.sourceStationStatus }}</td>
        </tr>
        <tr v-if="!shifts.length">
          <td colspan="8" class="empty-state">暂无班次记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">物资预警清单（与「物资储备」模块同一份投影）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th><th>物资名称</th><th>储备林场</th>
          <th>预警储备量</th><th>实际储备量</th><th>预警级别</th><th>升级站点关注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in warnings" :key="String(item.id)" :class="{ 'row-warn': item.关注 }">
          <td>{{ item.物资编号 }}</td>
          <td>{{ item.物资名称 }}</td>
          <td>{{ item.储备林场 }}</td>
          <td>{{ item.预警储备量 }}</td>
          <td>{{ item.实际储备量 }}</td>
          <td>{{ levelTag(item.级别) }}</td>
          <td>{{ item.关注 ? '★ 关注' : '—' }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 个站点；火种数只取各站点最新现场检查，不累计历史</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  arrangeShift,
  closeStation,
  completeHandover,
  listPassageDetails,
  listShifts,
  listStations,
  listSupplyWarnings,
  reopenStation,
  releaseUpgrade,
  stationStats,
  submitInspection,
  type DomainResult,
  type InspectionRow,
  type ShiftRow,
  type StationView,
  type WarningRow,
} from '@/domain/checkpoint'

const meta = moduleMeta('checkpoint')
// 收缴火种数/通行车辆数改由现场检查记录投影，不再作为站点主数据列重复展示。
const columns = ['站点编号', '站点位置', '所属林场', '值守人员', '检查项目', '值班日期', '运行状态']
const statuses = ['正常检查', '升级检查', '临时关闭', '等待换岗']

const rows = ref<StationView[]>([])
const passages = ref<InspectionRow[]>([])
const shifts = ref<ShiftRow[]>([])
const warnings = ref<WarningRow[]>([])
const errorMessage = ref('')
const okMessage = ref('')
const busyId = ref<number | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ['站点编号', '站点位置', '值守人员']
const submitting = ref(false)

const liveStats = computed(() => {
  const s = stationStats()
  return [
    { label: '站点总数', value: s.total },
    { label: '正常检查数', value: s.normal },
    { label: '等待换岗数', value: s.waiting },
    { label: '收缴火种数（最新检查口径）', value: s.fireCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, v]) => v.trim() !== '')
  if (!pairs.length) {
    return rows.value
  }
  return rows.value.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
})

function display(row: StationView, column: string): string | number {
  if (column === '收缴火种数') {
    return row.fireCount
  }
  return String(row[column] ?? '—')
}

type ActionKey =
  | 'inspect-upgrade'
  | 'inspect-normal'
  | 'close'
  | 'arrange'
  | 'complete'
  | 'reopen'
  | 'release'

const ACTION_MAP: Record<ActionKey, { label: string }> = {
  'inspect-upgrade': { label: '升级检查' },
  'inspect-normal': { label: '现场复查' },
  close: { label: '关闭站点' },
  arrange: { label: '安排换岗' },
  complete: { label: '完成交接' },
  reopen: { label: '重新开放' },
  release: { label: '解除升级' },
}

// 按当前状态给出动作；升级检查下不给出「安排换岗」，从入口杜绝旧站点换岗。
function availableActions(status: string): { key: ActionKey; label: string }[] {
  const keys: ActionKey[] =
    status === '正常检查'
      ? ['inspect-upgrade', 'close', 'arrange']
      : status === '升级检查'
        ? ['inspect-normal', 'release']
        : status === '临时关闭'
          ? ['reopen', 'inspect-upgrade']
          : ['complete']
  return keys.map((key) => ({ key, label: ACTION_MAP[key].label }))
}

// 补值弹窗
const form = reactive({
  open: false,
  kind: 'inspection' as 'inspection' | 'shift',
  title: '',
  stationId: 0,
  code: '',
  version: 0,
  sourceCheckedAt: '',
})
const inspection = reactive({
  scene: '升级检查' as '升级检查' | '正常检查',
  at: '',
  project: '',
  vehicles: '',
  fires: '',
})
const shift = reactive({ reliever: '', period: '' })

function openInspection(row: StationView, scene: '升级检查' | '正常检查') {
  Object.assign(form, {
    open: true,
    kind: 'inspection',
    title: scene === '升级检查' ? '升级检查' : '现场复查',
    stationId: Number(row.id),
    code: String(row.站点编号),
    version: Number(row.version ?? 0),
  })
  Object.assign(inspection, {
    scene,
    at: '',
    project: '',
    vehicles: row.vehicleCount,
    fires: row.fireCount,
  })
}

function openShift(row: StationView) {
  Object.assign(form, {
    open: true,
    kind: 'shift',
    title: '安排换岗',
    stationId: Number(row.id),
    code: String(row.站点编号),
    version: Number(row.version ?? 0),
    sourceCheckedAt: row.lastCheckedAt,
  })
  Object.assign(shift, { reliever: '', period: '' })
}

function closeForm() {
  form.open = false
}

function fromLocalInput(): string {
  return inspection.at ? inspection.at.replace('T', ' ') : ''
}

async function submitForm() {
  submitting.value = true
  let result: DomainResult
  if (form.kind === 'inspection') {
    result = submitInspection({
      stationId: form.stationId,
      expectedVersion: form.version,
      现场状态: inspection.scene,
      检查时间: fromLocalInput(),
      检查项目: inspection.project,
      通行车辆数: inspection.vehicles === '' ? 0 : Number(inspection.vehicles),
      收缴火种数: inspection.fires === '' ? 0 : Number(inspection.fires),
    })
  } else {
    result = arrangeShift({
      stationId: form.stationId,
      expectedVersion: form.version,
      接班人员: shift.reliever,
      值勤时段: shift.period,
      排班日期: form.sourceCheckedAt.slice(0, 10),
    })
  }
  // 模拟真实提交的微任务间隙：连续双击/并发只会有一个结果落库。
  await Promise.resolve()
  submitting.value = false
  form.open = false
  handleResult(result)
}

function onAction(key: ActionKey, row: StationView) {
  if (key === 'inspect-upgrade') {
    openInspection(row, '升级检查')
    return
  }
  if (key === 'inspect-normal') {
    openInspection(row, '正常检查')
    return
  }
  if (key === 'arrange') {
    openShift(row)
    return
  }
  busyId.value = Number(row.id)
  const version = Number(row.version ?? 0)
  const result =
    key === 'close'
      ? closeStation(Number(row.id), version)
      : key === 'complete'
        ? completeHandover(Number(row.id), version)
        : key === 'reopen'
          ? reopenStation(Number(row.id), version)
          : releaseUpgrade(Number(row.id), version)
  busyId.value = null
  handleResult(result)
}

function handleResult(result: DomainResult) {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
  reload()
}

function levelTag(level: unknown): string {
  return String(level)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  rows.value = listStations()
  passages.value = listPassageDetails()
  shifts.value = listShifts()
  warnings.value = listSupplyWarnings()
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  margin: 22px 0 8px;
  font-size: 15px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.modal-card h3 {
  margin: 0;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.row-warn {
  background: #fff7ed;
}
.ok-text {
  color: #15803d;
}
.link:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
</style>
