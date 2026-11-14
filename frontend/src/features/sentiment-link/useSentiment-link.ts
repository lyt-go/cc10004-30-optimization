import { useMemo, useState } from 'react'

import {
  AGG_BATCH_FULL,
  AGG_BATCH_PARTIAL,
  CONTENT_ITEMS,
  CURRENT_WINDOW,
  OPERATORS,
  OPS_ALERT_RULES,
  SENTIMENT_PLANS,
} from './seed'
import { appendAudit, arbitrateBatches, checkMaintenancePermission, runMergeEngine } from './engine'
import type {
  AggregationBatch,
  AuditEntry,
  BatchArbitration,
  Operator,
  OpsAlertRule,
  PermissionResult,
  SentimentPlan,
} from './types'

/** 视图层状态：可维护的方案/规则副本、当前操作人、批次仲裁结果与审计日志 */
export function useSentimentLink() {
  const [plans, setPlans] = useState<SentimentPlan[]>(() => SENTIMENT_PLANS.map((plan) => ({ ...plan, keywords: [...plan.keywords] })))
  const [rules, setRules] = useState<OpsAlertRule[]>(() => OPS_ALERT_RULES.map((rule) => ({ ...rule, receivers: [...rule.receivers] })))
  const [operator, setOperator] = useState<Operator>(OPERATORS[0])
  const [arbitration, setArbitration] = useState<BatchArbitration | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)

  // 方案或关键词被维护后，归并结果实时重算（内容与窗口不变）
  const engineResult = useMemo(() => runMergeEngine(CONTENT_ITEMS, plans, CURRENT_WINDOW), [plans])

  /** 模拟两个聚合批次同时到达，执行覆盖完整度仲裁 */
  function simulateConcurrentBatches(): BatchArbitration {
    const result = arbitrateBatches(AGG_BATCH_PARTIAL, AGG_BATCH_FULL)
    setArbitration(result)
    setAudit((prev) =>
      appendAudit(prev, {
        operator,
        action: '聚合批次仲裁',
        target: `${result.accepted.id} / ${result.pendingReview.id}`,
        result: '通过',
        detail: result.reason,
      }),
    )
    return result
  }

  /** 统一的维护入口：先过权限，再落库；拒绝也写审计 */
  function maintain(
    action: string,
    target: string,
    owner: string,
    applyChange: () => void,
  ): PermissionResult {
    const permission = checkMaintenancePermission(operator, owner, action, target)
    setAudit((prev) =>
      appendAudit(prev, {
        operator,
        action,
        target,
        result: permission.allowed ? '通过' : '拒绝',
        detail: permission.message,
      }),
    )
    if (!permission.allowed) {
      setFeedback({ ok: false, message: permission.message })
      return permission
    }
    applyChange()
    setFeedback({ ok: true, message: permission.message })
    return permission
  }

  function updatePlanKeywords(planId: string, keywords: string[]): PermissionResult {
    const plan = plans.find((item) => item.id === planId)
    if (!plan) {
      return { allowed: false, message: `未找到方案 ${planId}` }
    }
    return maintain('维护共享关键词', planId, plan.owner, () => {
      setPlans((prev) => prev.map((item) => (item.id === planId ? { ...item, keywords } : item)))
    })
  }

  function updatePlanThreshold(planId: string, threshold: number): PermissionResult {
    const plan = plans.find((item) => item.id === planId)
    if (!plan) {
      return { allowed: false, message: `未找到方案 ${planId}` }
    }
    return maintain('调整热度阈值', planId, plan.owner, () => {
      setPlans((prev) => prev.map((item) => (item.id === planId ? { ...item, heatThreshold: threshold } : item)))
    })
  }

  function updateRuleReceivers(ruleId: string, receivers: string[]): PermissionResult {
    const rule = rules.find((item) => item.id === ruleId)
    if (!rule) {
      return { allowed: false, message: `未找到规则 ${ruleId}` }
    }
    return maintain('修改接收人名单', ruleId, rule.owner, () => {
      setRules((prev) => prev.map((item) => (item.id === ruleId ? { ...item, receivers } : item)))
    })
  }

  return {
    plans,
    rules,
    operator,
    setOperator,
    operators: OPERATORS,
    engineResult,
    arbitration,
    simulateConcurrentBatches,
    batches: { full: AGG_BATCH_FULL, partial: AGG_BATCH_PARTIAL } satisfies Record<string, AggregationBatch>,
    audit,
    feedback,
    setFeedback,
    updatePlanKeywords,
    updatePlanThreshold,
    updateRuleReceivers,
  }
}
