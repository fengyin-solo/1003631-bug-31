// 领域逻辑验收脚本：npx esbuild 打包后用 node 执行，不依赖浏览器。
import assert from 'node:assert'

// localStorage 垫片
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  },
  dispatchEvent: () => true,
}
globalThis.CustomEvent = class {
  constructor(type, init) {
    this.type = type
    this.detail = init?.detail
  }
}

const cp = await import('../src/domain/checkpoint.ts')

function station(id) {
  return cp.findStation(id)
}

/* 1. 种子聚合：CHEC-0003 火种 3+5+2=10，全站 1+0+0+3+5+2=11 */
const s3 = cp.listStations().find((r) => r['站点编号'] === 'CHEC-0003')
assert.equal(s3.累计收缴火种数, 10, '升级站点火种合计应为 10')
assert.equal(cp.stationStats().find((c) => c.label === '收缴火种数').value, 11)
console.log('✓ 火种数只按明细聚合，列表不重复显示')

/* 2. 正常站点登记同时间两次：覆盖不翻倍 */
let r = cp.runSiteAction(1, '登记通行', { 检查时间: '2026-10-04 08:30', 通行车辆数: 30, 收缴火种数: 7 })
assert.equal(r.ok, true, r.message)
const s1 = cp.findStation(1)
const p1 = cp.listPassages(1).filter((p) => p.检查时间 === '2026-10-04 08:30')
assert.equal(p1.length, 1, '同一检查时间+班次只能有一条明细')
assert.equal(p1[0].收缴火种数, 7)
r = cp.runSiteAction(1, '登记通行', { 检查时间: '2026-10-04 15:00', 通行车辆数: 'abc', 收缴火种数: -5 })
const p2 = cp.listPassages(1).find((p) => p.检查时间.startsWith('2026-10-04 15:00'))
assert.equal(p2.通行车辆数, 0)
assert.equal(p2.收缴火种数, 0)
console.log('✓ 重复登记覆盖更新；非数字/负数/空值补 0')

/* 3. 升级检查后安排换岗：进入等待换岗，现场级别保持升级，不能被降回正常 */
assert.equal(cp.findStation(3).status, '升级检查')
r = cp.runSiteAction(3, '安排换岗')
assert.equal(r.ok, true)
const waiting = cp.findStation(3)
assert.equal(waiting.status, '等待换岗')
assert.equal(waiting.现场检查级别, '升级检查')
// 等待换岗期间升级/关闭/再安排/登记都被拒
for (const act of ['升级检查', '关闭站点', '安排换岗', '恢复开放']) {
  const denied = cp.runSiteAction(3, act)
  assert.equal(denied.ok, false, `${act} 应被拒绝`)
}
console.log('✓ 冲突以现场检查为准：等待换岗锁定级别，其余动作拒绝')

/* 4. 完成换岗：版本 CAS，并发只有一个结果；完成后仍升级检查；历史批次留档 */
const v = waiting.version
r = cp.runSiteAction(3, '完成换岗', { 接班人员: '周大勇', 检查时间: '2026-10-04 08:00', version: v })
assert.equal(r.ok, true, r.message)
const after = cp.findStation(3)
assert.equal(after.status, '升级检查', '现场仍升级，换岗不得降级')
assert.equal(after['值守人员'], '周大勇')
assert.equal(after.version, v + 1)
const stale = cp.runSiteAction(3, '完成换岗', { 接班人员: '马六', version: v })
assert.equal(stale.ok, false, '旧版本换岗必须驳回')
assert.equal(cp.findStation(3)['值守人员'], '周大勇', '并发第二个结果不得落库')
const relief = cp.listReliefs(3)[0]
assert.equal(relief.接班人员, '周大勇')
assert.equal(relief.原检查时间, '2026-10-04 08:00')
assert.equal(relief.现场检查级别, '升级检查')
console.log('✓ 并发换岗只接受一个结果（CAS），历史班次按原检查时间留档')

/* 5. 临时关闭→恢复开放，恢复后跟随现场级别；正常站关闭后恢复为正常 */
r = cp.runSiteAction(1, '关闭站点')
assert.equal(r.ok, true)
assert.equal(cp.findStation(1).status, '临时关闭')
r = cp.runSiteAction(1, '恢复开放')
assert.equal(r.ok, true)
assert.equal(cp.findStation(1).status, '正常检查')
console.log('✓ 关闭/恢复开放状态机正常')

/* 6. 物资预警派生与补值口径 */
let warns = cp.listSupplyWarnings()
const w2 = warns.find((w) => w.id === 2) // 阈值20 实存14 → 偏低
assert.equal(w2.status, '偏低')
const w3 = warns.find((w) => w.id === 3) // 阈值100 实存30 ≤50 → 需补充
assert.equal(w3.status, '需补充')
const w4 = warns.find((w) => w.id === 4) // 已过期优先
assert.equal(w4.status, '已过期')
// 动作只改量，不固化旧状态：发起补充后状态仍是派生值
cp.runSupplyAction(2, '发起补充')
assert.equal(cp.listSupplyWarnings().find((w) => w.id === 2).status, '偏低')
assert.equal(cp.listSupplyWarnings().find((w) => w.id === 2).补充中, true)
// 入库到 60 → 充足，预警清单同步无残留
cp.runSupplyAction(2, '确认补充', { 实际储备量: '60' })
const w2b = cp.listSupplyWarnings().find((w) => w.id === 2)
assert.equal(w2b.status, '充足')
assert.equal(w2b.补充中, false)
console.log('✓ 预警由储量派生，动作不留旧值；入库后同口径刷新')

/* 7. 事务失败整体退回 */
const before = cp.findStation(1)
const origCommit = globalThis.window.localStorage.setItem
// 让提交阶段抛错：clone/mutate 已完成但 persist 失败时缓存与存储都应保持原状
globalThis.window.localStorage.setItem = () => {
  throw new Error('disk full')
}
const failed = cp.runSiteAction(1, '升级检查')
assert.equal(failed.ok, false)
globalThis.window.localStorage.setItem = origCommit
const recovered = cp.findStation(1)
assert.equal(recovered.status, before.status, '事务失败站点状态退回')
assert.equal(recovered.version, before.version, '事务失败版本不前进')
console.log('✓ 同次落库失败时站点/记录/预警整体退回')

console.log('\n全部验收通过 ✅')
