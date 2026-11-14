/**
 * 舆情预警联动 · 场景种子数据
 *
 * 关键场景：
 * - SENT-0001 与 SENT-0002 共享关键词「退款」，同一条内容命中两个方案，
 *   原始热度只累计一次；两个方案情感倾向不同（负面 / 中性），仍各自形成预警结论。
 * - SENT-0003 使用不重叠关键词，作为对照。
 * - OPSA-0001 / OPSA-0002 提供监控指标与接收人名单。
 */
import type { AggregationBatch, ContentItem, OpsAlertRule, Operator, SentimentPlan } from './types'

/** 采样截止时点设计：取当前时间窗口的整点作为截止（小时级窗口，见 engine.ts） */
export const SAMPLE_CUTOFF = '2026-11-14T11:00:00.000Z'
/** 当前评估时间窗口：2026-11-14 10:00–11:00（UTC 整点对齐） */
export const CURRENT_WINDOW = '2026-11-14T10:00:00.000Z'

export const SENTIMENT_PLANS: SentimentPlan[] = [
  {
    id: 'SENT-0001',
    topic: '退款纠纷负面舆情监控',
    keywords: ['退款', '退款难', '客服失联'],
    source: '微博 / 黑猫投诉 / 电商评价',
    sentiment: '负面',
    heatThreshold: 120,
    pushFrequency: '每小时',
    product: '在线商城 App',
    owner: '林晓',
  },
  {
    id: 'SENT-0002',
    topic: '退款流程体验中性监测',
    // 与 SENT-0001 共享「退款」，并同样覆盖「客服失联」，确保 C001~C003 为两方案的共享内容
    keywords: ['退款', '退货流程', '售后进度', '客服失联'],
    source: '应用商店评论 / 客服工单',
    sentiment: '中性',
    heatThreshold: 150,
    pushFrequency: '每2小时',
    product: '在线商城 App',
    owner: '林晓',
  },
  {
    id: 'SENT-0003',
    topic: '物流时效正面口碑监控',
    keywords: ['次日达', '配送快', '送货上门'],
    source: '微博 / 电商评价',
    sentiment: '正面',
    heatThreshold: 100,
    pushFrequency: '每日',
    product: '同城配送小程序',
    owner: '周明',
  },
]

export const OPS_ALERT_RULES: OpsAlertRule[] = [
  {
    id: 'OPSA-0001',
    metric: '退款工单积压量',
    compareOp: '大于',
    threshold: 200,
    duration: '连续3个周期',
    level: 'P1',
    receivers: ['林晓', '客服值班长-王岚', '运营总监-陈立'],
    owner: '林晓',
  },
  {
    id: 'OPSA-0002',
    metric: 'App 差评率',
    compareOp: '环比上升超过',
    threshold: 5,
    duration: '连续2个周期',
    level: 'P2',
    receivers: ['周明', '产品经理-赵琪'],
    owner: '周明',
  },
]

/**
 * 原始内容：C001 / C002 同时含「退款」，会被 SENT-0001 与 SENT-0002 同时命中。
 * 全部落在当前时间窗口内，且内容标签相同（退款售后），用于验证“同标签+同窗口只出一份热度”。
 */
export const CONTENT_ITEMS: ContentItem[] = [
  {
    id: 'C001',
    text: '申请退款三天了还没人处理，退款难，客服也联系不上，太离谱了',
    tag: '退款售后',
    sampledAt: '2026-11-14T10:05:00.000Z',
    rawHeat: 60,
    channel: '黑猫投诉',
  },
  {
    id: 'C002',
    text: '退款已经提交，想了解一下售后进度，退货流程走起来有点慢',
    tag: '退款售后',
    sampledAt: '2026-11-14T10:20:00.000Z',
    rawHeat: 45,
    channel: '应用商店评论',
  },
  {
    id: 'C003',
    text: '这次客服失联让我很生气，已经在平台投诉',
    tag: '退款售后',
    sampledAt: '2026-11-14T10:40:00.000Z',
    rawHeat: 30,
    channel: '微博',
  },
  {
    id: 'C004',
    text: '快递次日达，配送快，快递员还送货上门，体验很好',
    tag: '物流体验',
    sampledAt: '2026-11-14T10:50:00.000Z',
    rawHeat: 70,
    channel: '电商评价',
  },
]

/**
 * 两个同时到达的聚合批次：
 * - BATCH-A 覆盖 10:00–11:00 完整窗口（含全部 4 条内容），采样截止 11:00。
 * - BATCH-B 只覆盖 10:00–10:30 半个窗口（仅 2 条内容），采样截止 10:30。
 * 仲裁规则：覆盖时间范围更完整的 A 被采纳，B 进入待复核而不是覆盖。
 */
export const AGG_BATCH_FULL: AggregationBatch = {
  id: 'BATCH-A',
  rangeStart: '2026-11-14T10:00:00.000Z',
  rangeEnd: '2026-11-14T11:00:00.000Z',
  cutoffAt: '2026-11-14T11:00:00.000Z',
  contentIds: ['C001', 'C002', 'C003', 'C004'],
}

export const AGG_BATCH_PARTIAL: AggregationBatch = {
  id: 'BATCH-B',
  rangeStart: '2026-11-14T10:00:00.000Z',
  rangeEnd: '2026-11-14T10:30:00.000Z',
  cutoffAt: '2026-11-14T10:30:00.000Z',
  contentIds: ['C001', 'C002'],
}

/** 操作人清单：归属负责人可维护；只读成员只能查看 */
export const OPERATORS: Operator[] = [
  { name: '林晓', role: 'owner' },
  { name: '周明', role: 'owner' },
  { name: '访客-孙怡', role: 'readonly' },
]
