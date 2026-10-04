// 领域逻辑验证：用内存 localStorage 模拟浏览器，esbuild 已把 @ 别名打进单文件。
import assert from 'node:assert/strict'

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => store.delete(k),
  },
}

const domain = await import('../.test-build/checkpoint.mjs')

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ✓', name)
}

// 初始：迁移/种子加载后，预警旧值已被纠正（SUPP-0001 需补充→充足；SUPP-0004 充足→已过期）
const warnings0 = domain.listSupplyWarnings()
const w1 = warnings0.find((w) => w.物资编号 === 'SUPP-0001')
const w4 = warnings0.find((w) => w.物资编号 === 'SUPP-0004')
const w3 = warnings0.find((w) => w.物资编号 === 'SUPP-0003')

check('预警不残留旧值：SUPP-0001 重算为充足', () => {
  assert.equal(w1.级别, '充足')
})
check('过期优先于数量：SUPP-0004 数量充足仍判已过期', () => {
  assert.equal(w4.级别, '已过期')
})
check('实际<=预警50%：SUPP-0003 判需补充', () => {
  assert.equal(w3.级别, '需补充')
})

// 升级检查站点（id=2，云湖林场）的同林场需补充物资应被打「关注」
check('升级站点同林场未达标物资打关注（云湖林场 SUPP-0003）', () => {
  assert.equal(w3.关注, true)
  assert.equal(w1.关注, false)
})

// 火种去重：站点1最新检查(10:05)火种=1，旧检查(08:10)=3；统计只取最新 → 站点1算1
const stats = domain.stationStats()
check('收缴火种数只取各站点最新检查（站点1=1 站点2=5 站点3=0，合计6）', () => {
  assert.equal(stats.fireCount, 6)
})

// 站点2处于升级检查，安排换岗必须被拒绝（旧站点仍能换岗的 bug）
const stations = domain.listStations()
const s2 = stations.find((s) => Number(s.id) === 2)
check('升级检查后安排换岗被拒绝', () => {
  assert.equal(s2.status, '升级检查')
  const r = domain.arrangeShift({ stationId: 2, expectedVersion: Number(s2.version) })
  assert.equal(r.ok, false)
  assert.match(r.message, /升级检查/)
})

// 站点1正常检查，安排换岗成功，状态进入等待换岗，班次冻结原检查时间
let s1 = domain.listStations().find((s) => Number(s.id) === 1)
check('正常检查可安排换岗并冻结原检查时间', () => {
  const r = domain.arrangeShift({
    stationId: 1,
    expectedVersion: Number(s1.version),
    接班人员: '钱有力',
  })
  assert.equal(r.ok, true, r.message)
})
s1 = domain.listStations().find((s) => Number(s.id) === 1)
check('换岗后站点为等待换岗', () => assert.equal(s1.status, '等待换岗'))

// 并发/重复换岗：第二次（用旧版本号）必须失败；用新版本号但状态为等待换岗也失败
check('并发换岗只接受一个结果：旧版本号被乐观锁拒绝', () => {
  const r = domain.arrangeShift({ stationId: 1, expectedVersion: Number(s1.version) - 1 })
  assert.equal(r.ok, false)
  assert.match(r.message, /冲突|已被/)
})
check('同站重复换岗被「等待换岗」守卫拒绝', () => {
  const r = domain.arrangeShift({ stationId: 1, expectedVersion: Number(s1.version) })
  assert.equal(r.ok, false)
})

// 历史班次按原检查时间兼容：班次记录的 sourceCheckedAt 是 10:05 那次
const shifts = domain.listShifts().filter((x) => Number(x.stationId) === 1)
check('班次冻结原检查时间(2026-10-04 10:05)与当时状态(正常检查)', () => {
  const open = shifts.find((x) => x.状态 === '等待换岗')
  assert.equal(open.sourceCheckedAt, '2026-10-04 10:05')
  assert.equal(open.sourceStationStatus, '正常检查')
})

// 完成交接 → 正常检查
check('完成交接后恢复正常检查', () => {
  const r = domain.completeHandover(1, Number(s1.version))
  assert.equal(r.ok, true, r.message)
  const now = domain.listStations().find((s) => Number(s.id) === 1)
  assert.equal(now.status, '正常检查')
})

// 现场复查正常可覆盖升级检查（站点2），且产生新检查记录、旧记录保留
const before = domain.listPassageDetails(2).length
check('现场复查正常覆盖升级结论，旧记录保留', () => {
  const s2v = Number(domain.listStations().find((s) => Number(s.id) === 2).version)
  const r = domain.submitInspection({
    stationId: 2,
    expectedVersion: s2v,
    现场状态: '正常检查',
    检查时间: '2026-10-04 11:00',
    收缴火种数: 2,
  })
  assert.equal(r.ok, true, r.message)
  const now = domain.listStations().find((s) => Number(s.id) === 2)
  assert.equal(now.status, '正常检查')
  assert.equal(domain.listPassageDetails(2).length, before + 1)
  // 关注应随升级解除而取消
  const w3now = domain.listSupplyWarnings().find((w) => w.物资编号 === 'SUPP-0003')
  assert.equal(w3now.关注, false)
})

// 乐观锁：用过期版本提交检查被拒绝，数据不变
check('过期版本提交现场检查被拒绝（乐观锁）', () => {
  const cur = domain.listStations().find((s) => Number(s.id) === 1)
  const r = domain.submitInspection({
    stationId: 1,
    expectedVersion: Number(cur.version) - 1,
    现场状态: '升级检查',
  })
  assert.equal(r.ok, false)
  const after = domain.listStations().find((s) => Number(s.id) === 1)
  assert.equal(after.status, '正常检查')
})

// 事务回滚：commitAll 序列化失败时缓存不变（用一个循环引用构造）
// 通过监听 localStorage.setItem 抛错模拟「失败一起退回」。
check('落库失败一起退回：站点/记录/预警均不变', () => {
  const snap = store.get('forest-fire-patrol:entries')
  const orig = globalThis.window.localStorage.setItem
  globalThis.window.localStorage.setItem = () => {
    throw new Error('disk full (simulated)')
  }
  let threw = false
  try {
    domain.submitInspection({ stationId: 1, 现场状态: '升级检查' })
  } catch {
    threw = true
  }
  globalThis.window.localStorage.setItem = orig
  assert.equal(threw, true)
  // 内存与存储都回到失败前
  assert.equal(store.get('forest-fire-patrol:entries'), snap)
  const cur = domain.listStations().find((s) => Number(s.id) === 1)
  assert.equal(cur.status, '正常检查')
})

console.log(`\n全部 ${passed} 项领域验证通过`)
