<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">
          物资状态不手工固化，一律按「实际储备量 vs 预警储备量」现场派生：≤阈值50% 需补充、≤阈值 偏低、过期优先；动作只改量/标记，预警当场重算。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火物资</button>
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
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
          <th>补充申请</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="rowClass(String(row.status))">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span class="status-tag" :class="rowClass(String(row.status))">{{ row.status }}</span>
          </td>
          <td>{{ row['补充中'] === true ? '补充中' : '未发起' }}</td>
          <td class="row-actions">
            <button
              v-if="String(row.status) !== '已过期' && row['补充中'] !== true"
              class="link"
              type="button"
              @click="runAction('发起补充', row)"
            >
              发起补充
            </button>
            <button class="link" type="button" @click="openConfirm(row)">确认补充</button>
            <button
              v-if="String(row.status) !== '已过期'"
              class="link"
              type="button"
              @click="runAction('标记过期', row)"
            >
              标记过期
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无物资储备数据，可先登记防火物资</td>
        </tr>
      </tbody>
    </table>

    <SupplyWarnings compact />

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="confirmRow" class="modal-mask" @click.self="closeConfirm">
      <div class="modal-card">
        <h3>确认补充入库 · {{ confirmRow['物资名称'] }}</h3>
        <label class="filter-item">
          <span>入库后实际储备量</span>
          <input v-model="stockInput" placeholder="空值、非数字、负数按 0 处理" inputmode="numeric" />
        </label>
        <p class="page-desc">
          预警阈值 {{ confirmRow['预警储备量'] }}；提交后站点、记录与预警同口径落库，预警状态立即重算。
        </p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeConfirm">取消</button>
          <button class="btn primary" type="button" @click="submitConfirm">入库并重算</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import SupplyWarnings from '@/components/SupplyWarnings.vue'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { runSupplyAction } from '@/domain/checkpoint'
import { DATA_COMMITTED_EVENT } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('supply')
const columns = ["物资编号", "物资名称", "物资类别", "规格型号", "储备林场", "预警储备量", "实际储备量", "物资状态"]
const statuses = ["充足", "偏低", "需补充", "已过期"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const confirmRow = ref<EntryRow | null>(null)
const stockInput = ref('')

// 统计卡不再写死 0：每次落库事件触发 reload 后按派生状态实时统计。
const stats = computed(() => {
  const warningCount = rows.value.filter(
    (row) => row.status === '偏低' || row.status === '需补充',
  ).length
  return [
    { label: '物资种类', value: rows.value.length },
    { label: '需补充种类', value: rows.value.filter((row) => row.status === '需补充').length },
    { label: '预警种类', value: warningCount },
    { label: '过期种类', value: rows.value.filter((row) => row.status === '已过期').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowClass(status: string): string {
  if (status === '需补充') {
    return 'st-danger'
  }
  if (status === '偏低') {
    return 'st-warn'
  }
  if (status === '已过期') {
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
  errorMessage.value = '防火物资登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openConfirm(row: EntryRow) {
  confirmRow.value = row
  stockInput.value = String(row['实际储备量'] ?? '0')
}

function closeConfirm() {
  confirmRow.value = null
  stockInput.value = ''
}

function submitConfirm() {
  if (!confirmRow.value) {
    return
  }
  const result = runSupplyAction(Number(confirmRow.value.id), '确认补充', {
    实际储备量: stockInput.value,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  closeConfirm()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物资储备列表读取失败'
  }
}

function onCommitted() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener(DATA_COMMITTED_EVENT, onCommitted)
})

onBeforeUnmount(() => {
  window.removeEventListener(DATA_COMMITTED_EVENT, onCommitted)
})
</script>

<style scoped>
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
tr.st-danger {
  background: #fff7f6;
}
tr.st-expired {
  background: #faf8fd;
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
  width: 420px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.modal-card h3 {
  margin: 0 0 14px;
  font-size: 16px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
