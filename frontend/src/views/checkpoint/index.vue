<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">
          站点状态以现场检查为准：升级检查的站点安排换岗只进入「等待换岗」，完成交接后仍按现场结果恢复；火种与车辆数只从通行明细聚合。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <nav class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- 站点列表 -->
    <div v-show="activeTab === 'stations'">
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
            <th v-for="column in stationColumns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>现场级别</th>
            <th>数据版本</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in stationColumns" :key="column">{{ display(row, column) }}</td>
            <td>
              <span class="status-tag" :class="statusClass(String(row.status))">{{ row.status }}</span>
            </td>
            <td>{{ row.现场检查级别 }}</td>
            <td>v{{ row.version }}</td>
            <td class="row-actions">
              <button
                v-for="action in availableActions(String(row.status))"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="stationColumns.length + 4" class="empty-state">暂无防火检查站数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 通行详情 -->
    <div v-show="activeTab === 'passage'">
      <form class="filter-bar" @submit.prevent="reloadPassages">
        <label class="filter-item">
          <span>站点</span>
          <select v-model="passageStationId" @change="reloadPassages">
            <option value="">全部站点</option>
            <option v-for="station in stations" :key="station.id" :value="station.id">
              {{ station['站点编号'] }} · {{ station['站点位置'] }}
            </option>
          </select>
        </label>
        <button class="btn" type="button" @click="reloadPassages">刷新明细</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>站点编号</th>
            <th>检查时间</th>
            <th>班次</th>
            <th>现场检查级别</th>
            <th>通行车辆数</th>
            <th>收缴火种数</th>
            <th>登记时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in passages" :key="item.id">
            <td>{{ item.站点编号 }}</td>
            <td>{{ item.检查时间 }}</td>
            <td>{{ item.班次 }}</td>
            <td>{{ item.现场检查级别 }}</td>
            <td>{{ item.通行车辆数 }}</td>
            <td>{{ item.收缴火种数 }}</td>
            <td>{{ item.登记时间 }}</td>
          </tr>
          <tr v-if="!passages.length">
            <td colspan="7" class="empty-state">暂无通行明细，可在站点列表「登记通行」</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="4">合计（明细去重后）</td>
            <td>{{ passageTotals.vehicles }}</td>
            <td>{{ passageTotals.fires }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- 换岗记录 -->
    <div v-show="activeTab === 'relief'">
      <table class="data-table">
        <thead>
          <tr>
            <th>站点编号</th>
            <th>原检查时间</th>
            <th>原班次</th>
            <th>原值守人员</th>
            <th>接班人员</th>
            <th>交接时现场级别</th>
            <th>完成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reliefs" :key="item.id">
            <td>{{ item.站点编号 }}</td>
            <td>{{ item.原检查时间 }}</td>
            <td>{{ item.班次 }}</td>
            <td>{{ item.原值守人员 }}</td>
            <td>{{ item.接班人员 }}</td>
            <td>{{ item.现场检查级别 }}</td>
            <td>{{ item.完成时间 }}</td>
          </tr>
          <tr v-if="!reliefs.length">
            <td colspan="7" class="empty-state">暂无换岗记录</td>
          </tr>
        </tbody>
      </table>
      <p class="page-desc">
        历史班次只追加不改写：每条记录保留原检查时间、原班次与当时的现场级别，升级检查与旧班次冲突时按原检查时间兼容。
      </p>
    </div>

    <!-- 物资预警（与物资储备模块同源同口径） -->
    <div v-show="activeTab === 'warning'">
      <SupplyWarnings />
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 个防火检查站</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记通行弹窗 -->
    <div v-if="passageForm" class="modal-mask" @click.self="closeForms">
      <div class="modal-card">
        <h3>登记通行 · {{ passageForm.code }}</h3>
        <p class="page-desc">当前现场级别：{{ passageForm.level }}。同一「检查时间 + 班次」重复提交会覆盖而非累加。</p>
        <label class="filter-item">
          <span>检查时间</span>
          <input v-model="passageForm.time" placeholder="留空补当前时刻；只填日期补当前时分" />
        </label>
        <label class="filter-item">
          <span>通行车辆数</span>
          <input v-model="passageForm.vehicles" placeholder="空值、非数字、负数补 0" inputmode="numeric" />
        </label>
        <label class="filter-item">
          <span>收缴火种数</span>
          <input v-model="passageForm.fires" placeholder="空值、非数字、负数补 0" inputmode="numeric" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeForms">取消</button>
          <button class="btn primary" type="button" @click="submitPassage">提交明细</button>
        </div>
      </div>
    </div>

    <!-- 完成换岗弹窗：携带版本号做乐观锁 -->
    <div v-if="reliefForm" class="modal-mask" @click.self="closeForms">
      <div class="modal-card">
        <h3>完成换岗 · {{ reliefForm.code }}</h3>
        <p class="page-desc">
          待换岗期间现场级别为「{{ reliefForm.level }}」，完成后以现场检查为准；并发交接仅接受一个结果（当前版本 v{{ reliefForm.version }}）。
        </p>
        <label class="filter-item">
          <span>原检查时间</span>
          <input v-model="reliefForm.checkedAt" placeholder="留空补当前时刻，作为历史班次留档" />
        </label>
        <label class="filter-item">
          <span>接班人员</span>
          <input v-model="reliefForm.successor" placeholder="留空记为未填报" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeForms">取消</button>
          <button class="btn primary" type="button" @click="submitRelief">确认完成换岗</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { DATA_COMMITTED_EVENT } from '@/data/local-store'
import {
  listPassages,
  listReliefs,
  listStations,
  runSiteAction,
  stationStats,
  type PassageView,
  type ReliefView,
  type StationView,
} from '@/domain/checkpoint'

const meta = moduleMeta('checkpoint')
const stationColumns = [
  '站点编号',
  '站点位置',
  '值守人员',
  '检查项目',
  '班次',
  '累计通行车辆数',
  '累计收缴火种数',
  '值班日期',
]
const filterFields = ['站点编号', '站点位置', '值守人员']
const tabs = [
  { key: 'stations', label: '站点列表' },
  { key: 'passage', label: '通行详情' },
  { key: 'relief', label: '换岗记录' },
  { key: 'warning', label: '物资预警' },
] as const
type TabKey = (typeof tabs)[number]['key']

// 状态机：每个状态下页面只给出允许的动作，是否最终可执行仍由领域服务二次裁决。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  正常检查: ['升级检查', '安排换岗', '登记通行', '关闭站点'],
  升级检查: ['安排换岗', '登记通行', '关闭站点'],
  等待换岗: ['完成换岗'],
  临时关闭: ['恢复开放'],
}

const activeTab = ref<TabKey>('stations')
const stations = ref<StationView[]>([])
const rows = ref<StationView[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const stats = ref<{ label: string; value: number }[]>([])

const passages = ref<PassageView[]>([])
const reliefs = ref<ReliefView[]>([])
const passageStationId = ref<string>('')

const passageForm = ref<{
  id: number
  code: string
  level: string
  time: string
  vehicles: string
  fires: string
} | null>(null)

const reliefForm = ref<{
  id: number
  code: string
  level: string
  version: number
  checkedAt: string
  successor: string
} | null>(null)

const statusSummary = computed(() =>
  ['正常检查', '升级检查', '等待换岗', '临时关闭'].map((status) => ({
    status,
    count: stations.value.filter((row) => String(row.status) === status).length,
  })),
)

const passageTotals = computed(() => ({
  vehicles: passages.value.reduce((sum, item) => sum + item.通行车辆数, 0),
  fires: passages.value.reduce((sum, item) => sum + item.收缴火种数, 0),
}))

function display(row: StationView, column: string): string | number {
  if (column === '累计通行车辆数') {
    return row.累计通行车辆数
  }
  if (column === '累计收缴火种数') {
    return row.累计收缴火种数
  }
  return String(row[column] ?? '—')
}

function availableActions(status: string): string[] {
  return ACTIONS_BY_STATUS[status] ?? []
}

function statusClass(status: string): string {
  if (status === '升级检查') {
    return 'st-danger'
  }
  if (status === '等待换岗') {
    return 'st-warn'
  }
  if (status === '临时关闭') {
    return 'st-expired'
  }
  return 'st-ok'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function availableStation(id: number): StationView | undefined {
  return stations.value.find((row) => Number(row.id) === id)
}

function runAction(action: string, row: StationView) {
  errorMessage.value = ''
  if (action === '登记通行') {
    passageForm.value = {
      id: Number(row.id),
      code: String(row['站点编号']),
      level: row.现场检查级别,
      time: '',
      vehicles: '',
      fires: '',
    }
    return
  }
  if (action === '完成换岗') {
    reliefForm.value = {
      id: Number(row.id),
      code: String(row['站点编号']),
      level: row.现场检查级别,
      version: row.version,
      checkedAt: '',
      successor: '',
    }
    return
  }
  // 升级检查/安排换岗/关闭站点/恢复开放走通用入口，但由领域状态机裁决。
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reloadAll()
}

function submitPassage() {
  if (!passageForm.value) {
    return
  }
  const form = passageForm.value
  const result = runSiteAction(form.id, '登记通行', {
    检查时间: form.time,
    通行车辆数: form.vehicles,
    收缴火种数: form.fires,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  closeForms()
  reloadAll()
}

function submitRelief() {
  if (!reliefForm.value) {
    return
  }
  const form = reliefForm.value
  const result = runSiteAction(form.id, '完成换岗', {
    检查时间: form.checkedAt,
    接班人员: form.successor,
    version: form.version,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    // 版本被并发推进：刷新页面持有的版本，让用户拿新版本再提交。
    reloadAll()
    return
  }
  errorMessage.value = ''
  closeForms()
  activeTab.value = 'relief'
  reloadAll()
}

function closeForms() {
  passageForm.value = null
  reliefForm.value = null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as StationView[]
    total.value = payload.total
    stations.value = listStations()
    stats.value = stationStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

function reloadPassages() {
  const id = passageStationId.value === '' ? undefined : Number(passageStationId.value)
  passages.value = listPassages(id)
}

function reloadReliefs() {
  reliefs.value = listReliefs()
}

function reloadAll() {
  reload()
  reloadPassages()
  reloadReliefs()
}

function onCommitted() {
  // 物资页或本页事务落库后，所有标签页数据同口径刷新。
  reloadAll()
}

onMounted(() => {
  reloadAll()
  window.addEventListener(DATA_COMMITTED_EVENT, onCommitted)
})

onBeforeUnmount(() => {
  window.removeEventListener(DATA_COMMITTED_EVENT, onCommitted)
})
</script>

<style scoped>
.tab-bar {
  display: flex;
  gap: 8px;
  margin: 8px 0 14px;
  border-bottom: 1px solid #e5e7eb;
}
.tab-btn {
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: #475569;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  font-size: 14px;
}
.tab-btn.active {
  color: #1d4ed8;
  border-bottom-color: #1d4ed8;
  font-weight: 600;
}
.status-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
}
.status-tag.st-ok {
  background: #e6f4ea;
  color: #1e7d44;
}
.status-tag.st-warn {
  background: #fdf3d7;
  color: #9a6b08;
}
.status-tag.st-danger {
  background: #fde3df;
  color: #b43f2f;
}
.status-tag.st-expired {
  background: #ece6f7;
  color: #6a45a8;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal-card {
  width: 440px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.modal-card h3 {
  margin: 0 0 10px;
  font-size: 16px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
