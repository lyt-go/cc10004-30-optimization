/**
 * 舆情预警联动 · 重叠关键词热度归并 领域类型
 * 纯数据结构，不依赖 React / 浏览器，方便用 Node 脚本直接验证引擎。
 */

/** 情感倾向 */
export type Sentiment = '负面' | '中性' | '正面'

/** 时间窗口粒度：本方案固定按整点小时对齐 */
export type WindowGranularity = 'hour'

/** 舆情方案（对应 sentiment 模块的 SENT-xxxx） */
export interface SentimentPlan {
  /** 方案编号，如 SENT-0001 */
  id: string
  /** 监控主题 */
  topic: string
  /** 关键词集合（原始录入，引擎会做去空白/去重归一化） */
  keywords: string[]
  /** 数据来源 */
  source: string
  /** 情感倾向：不同方案即使命中同一内容，也各自保留结论 */
  sentiment: Sentiment
  /** 热度阈值：去重后热度达到该值即形成预警状态 */
  heatThreshold: number
  /** 推送频率 */
  pushFrequency: string
  /** 关联产品 */
  product: string
  /** 归属负责人：只有该负责人可以维护本方案 */
  owner: string
}

/** 运营预警规则（对应 opsalert 模块的 OPSA-xxxx） */
export interface OpsAlertRule {
  /** 预警编号，如 OPSA-0001 */
  id: string
  /** 监控指标 */
  metric: string
  /** 比较方式 */
  compareOp: string
  /** 阈值数值 */
  threshold: number
  /** 持续周期 */
  duration: string
  /** 预警级别 */
  level: string
  /** 接收人名单 */
  receivers: string[]
  /** 归属负责人 */
  owner: string
}

/** 原始舆情内容（一条采样到的帖子/评论/资讯） */
export interface ContentItem {
  /** 内容唯一标识，去重的核心键之一 */
  id: string
  /** 内容正文，关键词在其上做包含匹配 */
  text: string
  /** 内容标签：同一内容标签参与归并键 */
  tag: string
  /** 采样时间（ISO 字符串） */
  sampledAt: string
  /** 该条内容自身的原始热度（互动量加权分） */
  rawHeat: number
  /** 来源渠道 */
  channel: string
}

/** 归一化后的命中信息：某条内容被哪些方案命中、由哪个关键词命中 */
export interface ContentHit {
  contentId: string
  tag: string
  /** 命中的方案编号列表（一条内容可被多个方案命中） */
  planIds: string[]
  /** 命中关键词，按方案归集，便于排查包含关系 */
  matchedKeywords: Record<string, string[]>
  /** 落入的时间窗口标识，如 2026-11-14T10:00 */
  windowId: string
  rawHeat: number
  sampledAt: string
}

/** 单个方案在某个时间窗口的去重热度结果 */
export interface PlanWindowHeat {
  planId: string
  windowId: string
  /** 去重后参与计数的内容条数（同一内容只贡献一次） */
  contentCount: number
  /** 去重后累计热度（共享内容的原始热度只增长一次） */
  mergedHeat: number
  /** 参与归并的内容编号，去重后的集合 */
  contentIds: string[]
  /** 是否达到本方案热度阈值 */
  thresholdReached: boolean
  /** 预警状态：不同方案各自形成结论 */
  alertState: '未触发' | '已预警'
  /** 形成结论时采用的情感倾向 */
  sentiment: Sentiment
}

/** 归并后的热度键：同一内容标签 + 同一时间窗口只形成一份热度结果 */
export interface MergedHeatRecord {
  /** 归并键 = 内容标签 + 窗口标识 */
  mergeKey: string
  tag: string
  windowId: string
  /** 该归并键下去重后的内容（每条内容对预警状态最多贡献一次） */
  contents: Array<{
    contentId: string
    rawHeat: number
    planIds: string[]
  }>
  /** 一份热度结果：原始热度只累计一次 */
  mergedHeat: number
  contentCount: number
}

/** 聚合批次：一次采样聚合上报 */
export interface AggregationBatch {
  id: string
  /** 覆盖时间范围起（含，ISO） */
  rangeStart: string
  /** 覆盖时间范围止（不含，ISO） */
  rangeEnd: string
  /** 采样截止时点（ISO），同覆盖完整度时再比它 */
  cutoffAt: string
  /** 批次携带的内容编号 */
  contentIds: string[]
}

/** 批次仲裁结果 */
export interface BatchArbitration {
  /** 被采纳、可用于覆盖的批次 */
  accepted: AggregationBatch
  /** 进入待复核、不允许覆盖的批次 */
  pendingReview: AggregationBatch
  /** 判定理由 */
  reason: string
  /** 采纳批次的覆盖时长（毫秒） */
  acceptedSpanMs: number
  pendingSpanMs: number
}

/** 归并引擎的完整输出，供视图直接渲染 */
export interface MergeEngineResult {
  windowId: string
  /** 采样截止时点（引擎设计口径） */
  cutoffAt: string
  hits: ContentHit[]
  mergedRecords: MergedHeatRecord[]
  planHeats: PlanWindowHeat[]
  /** 跨方案命中总次数（一条内容被 N 个方案命中计 N 次，含重复累计风险），对照去重后的内容数 */
  rawContentCount: number
  dedupedContentCount: number
  /** 若存在重复累计风险，记录被消除的重复贡献次数 */
  eliminatedDuplicateContributions: number
}

/** 角色权限等级 */
export type Role = 'owner' | 'readonly'

/** 当前操作人上下文 */
export interface Operator {
  name: string
  role: Role
}

/** 权限校验结果 */
export interface PermissionResult {
  allowed: boolean
  message: string
}

/** 审计日志条目（越权拒绝也要留痕） */
export interface AuditEntry {
  id: number
  at: string
  operator: string
  role: Role
  action: string
  target: string
  result: '通过' | '拒绝'
  detail: string
}
