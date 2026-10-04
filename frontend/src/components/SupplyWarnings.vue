<template>
  <section class="warning-panel" :class="{ compact }">
    <header class="warning-head">
      <div>
        <h3>物资预警清单</h3>
        <p class="page-desc">
          状态由「实际储备量 vs 预警储备量」现场派生：≤阈值50% 需补充、≤阈值 偏低、过期优先；检查站与物资页同源同步。
        </p>
      </div>
      <button class="btn ghost" type="button" @click="reload">刷新预警</button>
    </header>

    <div v-if="!compact" class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th>
          <th>物资名称</th>
          <th>物资类别</th>
          <th>储备林场</th>
          <th>预警储备量</th>
          <th>实际储备量</th>
          <th>缺口</th>
          <th>补充状态</th>
          <th>预警状态</th>
          <th v-if="!compact">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.id" :class="statusClass(item.status)">
          <td>{{ item.物资编号 }}</td>
          <td>{{ item.物资名称 }}</td>
          <td>{{ item.物资类别 }}</td>
          <td>{{ item.储备林场 }}</td>
          <td>{{ item.预警储备量 }}</td>
          <td>{{ item.实际储备量 }}</td>
          <td>{{ Math.max(0, item.预警储备量 - item.实际储备量) }}</td>
          <td>{{ item.补充中 ? '补充中' : '未发起' }}</td>
          <td>
            <span class="status-tag" :class="statusClass(item.status)">{{ item.status }}</span>
          </td>
          <td v-if="!compact" class="row-actions">
            <button
              v-if="item.status !== '已过期' && !item.补充中"
              class="link"
              type="button"
              @click="requestSupply(item)"
            >
              发起补充
            </button>
            <button class="link" type="button" @click="openConfirm(item)">确认补充</button>
            <button v-if="item.status !== '已过期'" class="link" type="button" @click="markExpired(item)">
              标记过期
            </button>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td :colspan="compact ? 9 : 10" class="empty-state">暂无物资数据</td>
        </tr>
      </tbody>
    </table>

    <footer v-if="message" class="page-foot">
      <span :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="confirming" class="modal-mask" @click.self="closeConfirm">
      <div class="modal-card">
        <h3>确认补充入库 · {{ confirming.物资名称 }}</h3>
        <label class="filter-item">
          <span>入库后实际储备量</span>
          <input v-model="stockInput" placeholder="空值或非数字按 0 处理" inputmode="numeric" />
        </label>
        <p class="page-desc">预警阈值 {{ confirming.预警储备量 }}，提交后按补值口径当场重算预警状态。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeConfirm">取消</button>
          <button class="btn primary" type="button" @click="submitConfirm">入库并重算</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { DATA_COMMITTED_EVENT } from '@/data/local-store'
import {
  listSupplyWarnings,
  runSupplyAction,
  supplyStats,
} from '@/domain/checkpoint'
import type { SupplyWarning } from '@/domain/checkpoint'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const items = ref<SupplyWarning[]>([])
const stats = ref<{ label: string; value: number }[]>([])
const message = ref('')
const messageOk = ref(true)
const confirming = ref<SupplyWarning | null>(null)
const stockInput = ref('')

function statusClass(status: string): string {
  if (status === '已过期') {
    return 'st-expired'
  }
  if (status === '需补充') {
    return 'st-danger'
  }
  if (status === '偏低') {
    return 'st-warn'
  }
  return 'st-ok'
}

function showMessage(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  items.value = listSupplyWarnings()
  stats.value = supplyStats()
}

function requestSupply(item: SupplyWarning) {
  const result = runSupplyAction(item.id, '发起补充')
  showMessage(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

function openConfirm(item: SupplyWarning) {
  confirming.value = item
  stockInput.value = String(item.实际储备量)
}

function closeConfirm() {
  confirming.value = null
  stockInput.value = ''
}

function submitConfirm() {
  if (!confirming.value) {
    return
  }
  const result = runSupplyAction(confirming.value.id, '确认补充', {
    实际储备量: stockInput.value,
  })
  showMessage(result.ok, result.message)
  closeConfirm()
  if (result.ok) {
    reload()
  }
}

function markExpired(item: SupplyWarning) {
  const result = runSupplyAction(item.id, '标记过期')
  showMessage(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

function onCommitted(event: Event) {
  const detail = (event as CustomEvent<{ keys?: string[] }>).detail
  if (!detail?.keys || detail.keys.includes('supply')) {
    reload()
  }
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
.warning-panel {
  margin-top: 20px;
}
.warning-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.warning-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.status-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  font-size: 12px;
}
.st-ok .status-tag,
.status-tag.st-ok {
  background: #e6f4ea;
  color: #1e7d44;
}
.st-warn .status-tag,
.status-tag.st-warn {
  background: #fdf3d7;
  color: #9a6b08;
}
.st-danger .status-tag,
.status-tag.st-danger {
  background: #fde3df;
  color: #b43f2f;
}
.st-expired .status-tag,
.status-tag.st-expired {
  background: #ece6f7;
  color: #6a45a8;
}
tr.st-danger td {
  background: #fff7f6;
}
tr.st-expired td {
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
