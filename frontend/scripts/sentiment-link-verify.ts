/**
 * 舆情预警联动 · 归并引擎验收脚本（独立于业务页面，可直接用 node 运行编译产物）
 *
 * 覆盖验收点：
 *  1. SENT-0001 / SENT-0002 共享「退款」，同一条内容只累计一次热度；
 *  2. 同一内容标签 + 同一时间窗口只形成一份热度结果；
 *  3. 两个方案情感倾向不同，仍各自形成预警状态；
 *  4. 两个聚合批次同时到达，覆盖完整的批次采纳，另一批进待复核；
 *  5. 仅归属负责人可维护，越权 / 只读提交被拒绝，审计留痕。
 */
import {
  AGG_BATCH_FULL,
  AGG_BATCH_PARTIAL,
  CONTENT_ITEMS,
  CURRENT_WINDOW,
  OPERATORS,
  OPS_ALERT_RULES,
  SAMPLE_CUTOFF,
  SENTIMENT_PLANS,
} from '../src/features/sentiment-link/seed'
import {
  appendAudit,
  arbitrateBatches,
  checkMaintenancePermission,
  matchKeywords,
  normalizeKeywords,
  runMergeEngine,
  windowIdOf,
} from '../src/features/sentiment-link/engine'
import type { AuditEntry } from '../src/features/sentiment-link/types'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}
function assert(name: string, condition: boolean, detail: string): void {
  record(name, condition, detail)
}

// ---------- 基础口径：窗口对齐 / 采样截止 / 关键词包含 ----------
assert(
  '时间窗口按整点对齐',
  windowIdOf('2026-11-14T10:47:33.000Z') === '2026-11-14T10:00:00.000Z',
  `windowId=${windowIdOf('2026-11-14T10:47:33.000Z')}`,
)

assert(
  '采样截止时点为窗口右边界整点',
  SAMPLE_CUTOFF === '2026-11-14T11:00:00.000Z',
  `cutoff=${SAMPLE_CUTOFF}`,
)

assert(
  '关键词包含匹配：长词「退款难」与短词「退款」都能命中含“退款”的内容',
  matchKeywords('申请退款三天了退款难', normalizeKeywords(['退款', '退款难'])).includes('退款') &&
    matchKeywords('申请退款三天了退款难', normalizeKeywords(['退款', '退款难'])).includes('退款难'),
  `命中=${matchKeywords('申请退款三天了退款难', normalizeKeywords(['退款', '退款难'])).join('、')}`,
)

// ---------- 引擎主流程 ----------
const result = runMergeEngine(CONTENT_ITEMS, SENTIMENT_PLANS, CURRENT_WINDOW)

const hitOf = (contentId: string) => result.hits.find((hit) => hit.contentId === contentId)
const c001 = hitOf('C001')
const c002 = hitOf('C002')

assert(
  'C001 同时命中 SENT-0001 与 SENT-0002（共享“退款”）',
  !!c001 && c001.planIds.includes('SENT-0001') && c001.planIds.includes('SENT-0002'),
  `C001 命中方案=${c001 ? c001.planIds.join('、') : '未命中'}`,
)

assert(
  'C002 同时命中 SENT-0001 与 SENT-0002（共享“退款”）',
  !!c002 && c002.planIds.includes('SENT-0001') && c002.planIds.includes('SENT-0002'),
  `C002 命中方案=${c002 ? c002.planIds.join('、') : '未命中'}`,
)

// 同一内容标签 + 同一时间窗口只形成一份热度结果
const tagWindowKeys = new Set(result.mergedRecords.map((record) => record.mergeKey))
assert(
  '同一内容标签+同一时间窗口只形成一份热度结果',
  result.mergedRecords.length === tagWindowKeys.size && result.mergedRecords.length >= 1,
  `归并键=${Array.from(tagWindowKeys).join('、')}`,
)

const refundRecord = result.mergedRecords.find((record) => record.tag === '退款售后')
assert(
  '“退款售后”窗口内 3 条内容去重后仍是 3 条（每条内容只贡献一次）',
  !!refundRecord && refundRecord.contentCount === 3,
  `去重内容数=${refundRecord ? refundRecord.contentCount : '缺失'}`,
)

// 原始热度只累计一次：60 + 45 + 30 = 135，而不是按方案重复翻倍
assert(
  '共享内容原始热度只累计一次（60+45+30=135，不跨方案翻倍）',
  !!refundRecord && refundRecord.mergedHeat === 135,
  `归并热度=${refundRecord ? refundRecord.mergedHeat : '缺失'}（错误重复累计会得到 270）`,
)

// 各方案独立结论
const heat0001 = result.planHeats.find((heat) => heat.planId === 'SENT-0001')
const heat0002 = result.planHeats.find((heat) => heat.planId === 'SENT-0002')
const heat0003 = result.planHeats.find((heat) => heat.planId === 'SENT-0003')

assert(
  'SENT-0001 去重热度 135，达到阈值 120 → 负面方案已预警',
  !!heat0001 && heat0001.mergedHeat === 135 && heat0001.alertState === '已预警' && heat0001.sentiment === '负面',
  `热度=${heat0001?.mergedHeat}，状态=${heat0001?.alertState}，情感=${heat0001?.sentiment}`,
)

assert(
  'SENT-0002 共享同样 3 条内容，热度同样 135 但未达其阈值 150 → 中性方案未触发，结论独立保留',
  !!heat0002 && heat0002.mergedHeat === 135 && heat0002.alertState === '未触发' && heat0002.sentiment === '中性',
  `热度=${heat0002?.mergedHeat}，状态=${heat0002?.alertState}，情感=${heat0002?.sentiment}`,
)

assert(
  'SENT-0001 与 SENT-0002 情感倾向不同但各自保留预警结论',
  !!heat0001 && !!heat0002 && heat0001.sentiment !== heat0002.sentiment,
  `SENT-0001=${heat0001?.sentiment}/${heat0001?.alertState}；SENT-0002=${heat0002?.sentiment}/${heat0002?.alertState}`,
)

assert(
  '每个方案内同一内容只计一次（SENT-0001 命中 C001/C002/C003 共 3 条，无重复内容编号）',
  !!heat0001 && heat0001.contentCount === 3 && new Set(heat0001.contentIds).size === heat0001.contentIds.length,
  `内容编号=${heat0001?.contentIds.join('、')}`,
)

assert(
  'SENT-0002 同样命中共享的 C001/C002/C003 共 3 条，热度与 SENT-0001 相同但不重复翻倍',
  !!heat0002 && heat0002.contentCount === 3 && heat0002.mergedHeat === heat0001?.mergedHeat,
  `内容编号=${heat0002?.contentIds.join('、')}，热度=${heat0002?.mergedHeat}`,
)

assert(
  'SENT-0003 独立关键词只命中物流内容，热度 70 未达阈值 100',
  !!heat0003 && heat0003.mergedHeat === 70 && heat0003.alertState === '未触发',
  `热度=${heat0003?.mergedHeat}，内容=${heat0003?.contentIds.join('、')}`,
)

assert(
  '消除的重复贡献次数等于跨方案重复命中数（C001/C002/C003 各被 2 个方案命中，多计 3 次）',
  result.eliminatedDuplicateContributions === 3,
  `消除重复贡献=${result.eliminatedDuplicateContributions}`,
)

assert(
  '跨方案命中 7 次（含重复）去重后唯一内容为 4 条',
  result.rawContentCount === 7 && result.dedupedContentCount === 4,
  `raw=${result.rawContentCount}，deduped=${result.dedupedContentCount}`,
)

// ---------- 批次仲裁 ----------
const arbitration = arbitrateBatches(AGG_BATCH_PARTIAL, AGG_BATCH_FULL)
assert(
  '两个批次同时到达：覆盖完整的 BATCH-A 被采纳',
  arbitration.accepted.id === 'BATCH-A',
  `采纳=${arbitration.accepted.id}，覆盖时长=${arbitration.acceptedSpanMs / 3600000}h`,
)
assert(
  '覆盖不完整的 BATCH-B 进入待复核而不是覆盖',
  arbitration.pendingReview.id === 'BATCH-B' && arbitration.pendingSpanMs < arbitration.acceptedSpanMs,
  `待复核=${arbitration.pendingReview.id}，覆盖时长=${arbitration.pendingSpanMs / 3600000}h`,
)

// 反向入参顺序，结论应稳定
const arbitrationReverse = arbitrateBatches(AGG_BATCH_FULL, AGG_BATCH_PARTIAL)
assert(
  '批次仲裁结果与入参顺序无关（始终 BATCH-A 采纳）',
  arbitrationReverse.accepted.id === 'BATCH-A' && arbitrationReverse.pendingReview.id === 'BATCH-B',
  `采纳=${arbitrationReverse.accepted.id}`,
)

// ---------- 权限：只有归属负责人可维护 ----------
const ownerLin = OPERATORS.find((operator) => operator.name === '林晓')!
const ownerZhou = OPERATORS.find((operator) => operator.name === '周明')!
const readonlySun = OPERATORS.find((operator) => operator.name === '访客-孙怡')!
const plan0001 = SENTIMENT_PLANS.find((plan) => plan.id === 'SENT-0001')!
const opsa0002 = OPS_ALERT_RULES.find((rule) => rule.id === 'OPSA-0002')!

let audit: AuditEntry[] = []

const ownerAllowed = checkMaintenancePermission(ownerLin, plan0001.owner, '维护共享关键词', plan0001.id)
audit = appendAudit(audit, {
  operator: ownerLin,
  action: '维护共享关键词',
  target: plan0001.id,
  result: ownerAllowed.allowed ? '通过' : '拒绝',
  detail: ownerAllowed.message,
})
assert('归属负责人维护本方案被允许', ownerAllowed.allowed === true, ownerAllowed.message)

const crossOwner = checkMaintenancePermission(ownerZhou, plan0001.owner, '维护共享关键词', plan0001.id)
audit = appendAudit(audit, {
  operator: ownerZhou,
  action: '维护共享关键词',
  target: plan0001.id,
  result: crossOwner.allowed ? '通过' : '拒绝',
  detail: crossOwner.message,
})
assert('非归属负责人（其他 owner）越权提交被拒绝', crossOwner.allowed === false, crossOwner.message)

const readonlyDenied = checkMaintenancePermission(readonlySun, plan0001.owner, '维护共享关键词', plan0001.id)
audit = appendAudit(audit, {
  operator: readonlySun,
  action: '维护共享关键词',
  target: plan0001.id,
  result: readonlyDenied.allowed ? '通过' : '拒绝',
  detail: readonlyDenied.message,
})
assert('只读成员改动共享内容被拒绝，只能查看', readonlyDenied.allowed === false, readonlyDenied.message)

const readonlyOpsa = checkMaintenancePermission(readonlySun, opsa0002.owner, '修改接收人名单', opsa0002.id)
audit = appendAudit(audit, {
  operator: readonlySun,
  action: '修改接收人名单',
  target: opsa0002.id,
  result: readonlyOpsa.allowed ? '通过' : '拒绝',
  detail: readonlyOpsa.message,
})
assert('只读成员修改 OPSA 接收人名单被拒绝', readonlyOpsa.allowed === false, readonlyOpsa.message)

const ownerOpsa = checkMaintenancePermission(ownerZhou, opsa0002.owner, '修改接收人名单', opsa0002.id)
assert('OPSA-0002 归属负责人周明可维护接收人名单', ownerOpsa.allowed === true, ownerOpsa.message)

assert(
  '所有维护尝试（含拒绝）均有审计留痕',
  audit.length === 4 && audit.filter((entry) => entry.result === '拒绝').length === 3,
  `审计条目=${audit.length}，拒绝=${audit.filter((entry) => entry.result === '拒绝').length}`,
)

// ---------- 汇总输出 ----------
const passed = checks.filter((check) => check.pass).length
const failed = checks.length - passed
console.log('================ 舆情联动热度归并 · 引擎验收 ================')
for (const check of checks) {
  console.log(`${check.pass ? '✅' : '❌'} ${check.name}\n   ${check.detail}`)
}
console.log('------------------------------------------------------------')
console.log(`合计 ${checks.length} 项，通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  process.exitCode = 1
}
