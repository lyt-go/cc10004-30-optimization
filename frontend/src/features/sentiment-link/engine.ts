/**
 * 舆情预警联动 · 重叠关键词热度归并引擎（纯函数，无 DOM / React 依赖）
 *
 * 设计口径（题目要求“关键词包含关系和采样截止时点由你设计”）：
 *
 * 1. 关键词包含关系：
 *    - 先对关键词做 trim、去重、按长度降序排列；
 *    - 采用「包含匹配」：只要关键词作为子串出现在内容正文中即算命中（如「退款难」包含「退款」语义）；
 *    - 一条内容可同时命中多个方案；命中同一方案的多个关键词时只记录一次内容贡献，
 *      matchedKeywords 保留全部命中词以便排查包含关系，避免短词与长词重复计分。
 *
 * 2. 采样截止时点与时间窗口：
 *    - 固定按整点小时（UTC）对齐窗口，windowId 取内容采样时间向下取整到整点；
 *    - 采样截止时点 = 窗口右边界（下一个整点）。只有 windowStart <= sampledAt < cutoff 的内容进入本窗口；
 *    - 同一「内容标签 tag + 时间窗口 windowId」只形成一份热度结果（mergeKey）。
 *
 * 3. 热度归并：
 *    - 每条内容按 contentId 在归并键内去重，对预警状态最多贡献一次，原始热度只增长一次；
 *    - 多个方案命中同一内容时，共享内容的原始热度不重复累计；
 *    - 但各方案仍基于“去重后的内容集合”独立判定各自阈值，保留各自情感倾向与预警结论。
 */
import type {
  AggregationBatch,
  AuditEntry,
  BatchArbitration,
  ContentHit,
  ContentItem,
  MergeEngineResult,
  MergedHeatRecord,
  Operator,
  PermissionResult,
  PlanWindowHeat,
  SentimentPlan,
} from './types'

const HOUR_MS = 60 * 60 * 1000

/** 关键词归一化：去空白、去重，并按长度降序（长词/具体词优先，便于包含关系排查） */
export function normalizeKeywords(keywords: string[]): string[] {
  const cleaned = keywords.map((word) => word.trim()).filter((word) => word.length > 0)
  return Array.from(new Set(cleaned)).sort((a, b) => b.length - a.length)
}

/** 将采样时间向下取整到整点小时，返回窗口起始 ISO 字符串作为 windowId */
export function windowIdOf(sampledAt: string): string {
  const time = new Date(sampledAt).getTime()
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString()
}

/** 采样截止时点：窗口右边界（下一个整点） */
export function cutoffOfWindow(windowId: string): string {
  return new Date(new Date(windowId).getTime() + HOUR_MS).toISOString()
}

/** 包含匹配：关键词作为子串出现在正文中即命中 */
export function matchKeywords(text: string, keywords: string[]): string[] {
  return normalizeKeywords(keywords).filter((word) => text.includes(word))
}

/**
 * 计算内容命中：每条内容在当前窗口内，被哪些方案的哪些关键词命中。
 * 只保留至少命中一个方案的内容。
 */
export function collectHits(contents: ContentItem[], plans: SentimentPlan[], windowId: string): ContentHit[] {
  const cutoff = cutoffOfWindow(windowId)
  const windowStart = new Date(windowId).getTime()
  const cutoffTime = new Date(cutoff).getTime()

  return contents
    .filter((item) => {
      const time = new Date(item.sampledAt).getTime()
      return time >= windowStart && time < cutoffTime && windowIdOf(item.sampledAt) === windowId
    })
    .map((item) => {
      const matchedKeywords: Record<string, string[]> = {}
      const planIds: string[] = []
      for (const plan of plans) {
        const hits = matchKeywords(item.text, plan.keywords)
        if (hits.length > 0) {
          planIds.push(plan.id)
          matchedKeywords[plan.id] = hits
        }
      }
      return {
        contentId: item.id,
        tag: item.tag,
        planIds,
        matchedKeywords,
        windowId,
        rawHeat: item.rawHeat,
        sampledAt: item.sampledAt,
      }
    })
    .filter((hit) => hit.planIds.length > 0)
}

/**
 * 按「内容标签 + 时间窗口」归并，生成一份份热度结果。
 * 同一归并键内按 contentId 去重：每条内容只出现一次、原始热度只累计一次。
 */
export function mergeByTagAndWindow(hits: ContentHit[]): MergedHeatRecord[] {
  const groups = new Map<string, ContentHit[]>()
  for (const hit of hits) {
    const mergeKey = `${hit.tag}@${hit.windowId}`
    const list = groups.get(mergeKey) ?? []
    list.push(hit)
    groups.set(mergeKey, list)
  }

  const records: MergedHeatRecord[] = []
  for (const [mergeKey, list] of groups) {
    const seen = new Map<string, MergedHeatRecord['contents'][number]>()
    for (const hit of list) {
      const existing = seen.get(hit.contentId)
      if (existing) {
        // 同一条内容已计入：合并命中方案，但不重复累计热度
        existing.planIds = Array.from(new Set([...existing.planIds, ...hit.planIds]))
      } else {
        seen.set(hit.contentId, {
          contentId: hit.contentId,
          rawHeat: hit.rawHeat,
          planIds: [...hit.planIds],
        })
      }
    }
    const dedupedContents = Array.from(seen.values())
    records.push({
      mergeKey,
      tag: list[0].tag,
      windowId: list[0].windowId,
      contents: dedupedContents,
      mergedHeat: dedupedContents.reduce((sum, item) => sum + item.rawHeat, 0),
      contentCount: dedupedContents.length,
    })
  }
  return records.sort((a, b) => a.mergeKey.localeCompare(b.mergeKey))
}

/**
 * 各方案在窗口内的去重热度与预警结论。
 * 关键：同一条内容对某个方案的贡献最多一次；共享内容的原始热度在每个方案里也只计一次，
 * 不会因为被多个方案命中而让任何一份热度重复增长。
 */
export function evaluatePlanHeats(hits: ContentHit[], plans: SentimentPlan[]): PlanWindowHeat[] {
  return plans.map((plan) => {
    // contentId 去重：同一内容即使命中本方案多个关键词，也只贡献一次
    const byContent = new Map<string, number>()
    for (const hit of hits) {
      if (!hit.planIds.includes(plan.id)) {
        continue
      }
      if (!byContent.has(hit.contentId)) {
        byContent.set(hit.contentId, hit.rawHeat)
      }
    }
    const contentIds = Array.from(byContent.keys()).sort()
    const mergedHeat = contentIds.reduce((sum, id) => sum + (byContent.get(id) ?? 0), 0)
    const thresholdReached = mergedHeat >= plan.heatThreshold
    return {
      planId: plan.id,
      windowId: hits.length > 0 ? hits[0].windowId : '',
      contentCount: contentIds.length,
      mergedHeat,
      contentIds,
      thresholdReached,
      alertState: thresholdReached ? ('已预警' as const) : ('未触发' as const),
      sentiment: plan.sentiment,
    }
  })
}

/** 引擎入口：一次性产出视图所需的全部归并结果 */
export function runMergeEngine(
  contents: ContentItem[],
  plans: SentimentPlan[],
  windowId: string,
): MergeEngineResult {
  const hits = collectHits(contents, plans, windowId)
  const mergedRecords = mergeByTagAndWindow(hits)
  const planHeats = evaluatePlanHeats(hits, plans)

  // 跨方案命中总次数（含重复）vs 去重后唯一内容数
  const rawContentCount = hits.reduce((sum, hit) => sum + hit.planIds.length, 0)
  const dedupedContentCount = new Set(hits.map((hit) => hit.contentId)).size
  // 被消除的重复贡献：一条内容被 N 个方案命中时，其中 N-1 次属于重复贡献
  const planHitCount = hits.reduce((sum, hit) => sum + hit.planIds.length, 0)
  const eliminatedDuplicateContributions = planHitCount - dedupedContentCount

  return {
    windowId,
    cutoffAt: cutoffOfWindow(windowId),
    hits,
    mergedRecords,
    planHeats,
    rawContentCount,
    dedupedContentCount,
    eliminatedDuplicateContributions: Math.max(0, eliminatedDuplicateContributions),
  }
}

/**
 * 两个聚合批次同时到达时的仲裁：
 * 1) 覆盖时间范围更完整（rangeEnd - rangeStart 更大）的批次被采纳；
 * 2) 覆盖时长相同则采样截止时点更晚的被采纳；
 * 3) 完全相同则先到者采纳，另一批仍进待复核。
 * 落败批次进入「待复核」，不允许覆盖已采纳结果。
 */
export function arbitrateBatches(a: AggregationBatch, b: AggregationBatch): BatchArbitration {
  const spanA = new Date(a.rangeEnd).getTime() - new Date(a.rangeStart).getTime()
  const spanB = new Date(b.rangeEnd).getTime() - new Date(b.rangeStart).getTime()

  let accepted: AggregationBatch
  let pendingReview: AggregationBatch
  let reason: string

  if (spanA !== spanB) {
    accepted = spanA > spanB ? a : b
    pendingReview = spanA > spanB ? b : a
    reason = `按覆盖时间范围完整度仲裁：${accepted.id} 覆盖时长更大，予以采纳；${pendingReview.id} 覆盖不完整，转入待复核，不覆盖已采纳结果。`
  } else if (new Date(a.cutoffAt).getTime() !== new Date(b.cutoffAt).getTime()) {
    const aLater = new Date(a.cutoffAt).getTime() > new Date(b.cutoffAt).getTime()
    accepted = aLater ? a : b
    pendingReview = aLater ? b : a
    reason = `覆盖时长相同，按采样截止时点仲裁：${accepted.id} 截止更晚，予以采纳；${pendingReview.id} 转入待复核。`
  } else {
    accepted = a
    pendingReview = b
    reason = `覆盖范围与截止时点完全一致：先到的 ${a.id} 采纳，${b.id} 转入待复核等待人工确认。`
  }

  return {
    accepted,
    pendingReview,
    reason,
    acceptedSpanMs: new Date(accepted.rangeEnd).getTime() - new Date(accepted.rangeStart).getTime(),
    pendingSpanMs: new Date(pendingReview.rangeEnd).getTime() - new Date(pendingReview.rangeStart).getTime(),
  }
}

/**
 * 权限校验：只有「归属负责人」可以维护对应方案/规则。
 * - readonly 角色：只读，任何维护动作都被拒绝；
 * - owner 角色但不是目标归属负责人：越权，拒绝；
 * - 归属负责人本人：放行。
 */
export function checkMaintenancePermission(
  operator: Operator,
  owner: string,
  action: string,
  target: string,
): PermissionResult {
  if (operator.role === 'readonly') {
    return {
      allowed: false,
      message: `只读成员「${operator.name}」仅可查看，不能维护共享内容（${action} ${target} 已拒绝）。`,
    }
  }
  if (operator.name !== owner) {
    return {
      allowed: false,
      message: `越权提交被拒绝：「${operator.name}」不是 ${target} 的归属负责人（负责人为 ${owner}），无权执行「${action}」。`,
    }
  }
  return { allowed: true, message: `归属负责人「${operator.name}」校验通过，允许执行「${action}」。` }
}

/** 追加一条审计日志（纯函数，返回新数组）；无论通过还是拒绝都留痕 */
export function appendAudit(
  entries: AuditEntry[],
  params: {
    operator: Operator
    action: string
    target: string
    result: '通过' | '拒绝'
    detail: string
  },
): AuditEntry[] {
  const entry: AuditEntry = {
    id: entries.length === 0 ? 1 : entries[entries.length - 1].id + 1,
    at: new Date().toISOString(),
    operator: params.operator.name,
    role: params.operator.role,
    action: params.action,
    target: params.target,
    result: params.result,
    detail: params.detail,
  }
  return [...entries, entry]
}
