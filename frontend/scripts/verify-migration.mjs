// 老存档迁移验收：先灌入 v1 格式数据，再首次进入领域。
import assert from 'node:assert'

const mem = new Map()
mem.set(
  'forest-fire-patrol:entries',
  JSON.stringify({
    checkpoint: [
      {
        id: 1,
        status: '升级检查',
        pending: false,
        abnormal: false,
        站点编号: 'CHEC-0001',
        站点位置: '老站点',
        值守人员: '老张',
        检查项目: '火种查验',
        通行车辆数: '防火检查站样例1',
        收缴火种数: '防火检查站样例1',
        值班日期: '2026-09-10',
        运行状态: '升级检查',
      },
    ],
    supply: [
      {
        id: 1,
        status: '偏低', // 与储量矛盾：阈值20、实存80 应为充足
        pending: true,
        abnormal: true,
        物资编号: 'SUPP-0001',
        物资名称: '老物资',
        物资类别: '机具',
        规格型号: '-',
        储备林场: '老林场',
        预警储备量: 20,
        实际储备量: 80,
        物资状态: '偏低',
      },
      {
        id: 2,
        status: '充足', // 阈值缺省（占位文本）→ 不设预警 → 充足
        pending: false,
        abnormal: false,
        物资编号: 'SUPP-0002',
        物资名称: '无阈值物资',
        物资类别: '杂项',
        规格型号: '-',
        储备林场: '老林场',
        预警储备量: '物资储备样例2',
        实际储备量: '物资储备样例2',
        物资状态: '充足',
      },
    ],
  }),
)

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

// 首次读取触发迁移
const station = cp.findStation(1)
assert.equal(station.status, '升级检查')
assert.equal(station.现场检查级别, '升级检查')
assert.equal(station.version, 1, '老站点补版本号 1')
assert.equal(station.班次, '白班', '班次按原检查时间（09:00）补白班')

// 占位文本火种/车辆按补值口径生成一条历史明细（0），不编造数字
const passages = cp.listPassages(1)
assert.equal(passages.length, 1)
assert.equal(passages[0].检查时间, '2026-09-10 09:00')
assert.equal(passages[0].收缴火种数, 0)
assert.equal(passages[0].通行车辆数, 0)
assert.equal(station.累计收缴火种数, 0)

// 物资矛盾状态被派生值纠正
const warns = cp.listSupplyWarnings()
assert.equal(warns.find((w) => w.id === 1).status, '充足', '实存 80 > 阈值 20，旧「偏低」必须纠正')
assert.equal(warns.find((w) => w.id === 2).status, '充足', '阈值非法视为不预警，实存取 0')

// 迁移幂等：再次调用不产生重复明细
cp.migrateIfNeeded()
assert.equal(cp.listPassages(1).length, 1)

// 迁移后新登记仍正常
const r = cp.runSiteAction(1, '安排换岗')
assert.equal(r.ok, true, r.message)
assert.equal(cp.findStation(1).status, '等待换岗')
assert.equal(cp.findStation(1).现场检查级别, '升级检查')

console.log('✓ 老存档一次性迁移、补值口径正确、迁移幂等')
console.log('迁移验收通过 ✅')
