import { useMemo, useState } from 'react'

import { useSentimentLink } from './useSentiment-link'
import type { Operator, OpsAlertRule, SentimentPlan } from './types'
import './sentiment-link.css'

type EditTarget =
  | { kind: 'planKeywords'; plan: SentimentPlan }
  | { kind: 'planThreshold'; plan: SentimentPlan }
  | { kind: 'ruleReceivers'; rule: OpsAlertRule }
  | null

const SENTIMENT_CLASS: Record<string, string> = {
  负面: 'badge danger',
  中性: 'badge neutral',
  正面: 'badge positive',
}

function formatHour(iso: string): string {
  return iso.replace('T', ' ').replace('.000Z', ' UTC')
}

export default function SentimentLinkView() {
  const link = useSentimentLink()
  const {
    plans,
    rules,
    operator,
    setOperator,
    operators,
    engineResult,
    arbitration,
    simulateConcurrentBatches,
    batches,
    audit,
    feedback,
    setFeedback,
    updatePlanKeywords,
    updatePlanThreshold,
    updateRuleReceivers,
  } = link

  const [editTarget, setEditTarget] = useState<EditTarget>(null)
  const [draftText, setDraftText] = useState('')
  const [draftNumber, setDraftNumber] = useState(0)

  // 出现在两个及以上方案中的关键词即「共享关键词」，视图中高亮
  const sharedKeywords = useMemo(() => {
    const counter = new Map<string, number>()
    for (const plan of plans) {
      for (const keyword of plan.keywords) {
        counter.set(keyword, (counter.get(keyword) ?? 0) + 1)
      }
    }
    return new Set(Array.from(counter.entries()).filter(([, count]) => count >= 2).map(([word]) => word))
  }, [plans])

  const heatByPlan = new Map(engineResult.planHeats.map((heat) => [heat.planId, heat]))
  const isReadonly = operator.role === 'readonly'

  function openEdit(target: NonNullable<EditTarget>): void {
    setFeedback(null)
    setEditTarget(target)
    if (target.kind === 'planKeywords') {
      setDraftText(target.plan.keywords.join('、'))
    } else if (target.kind === 'planThreshold') {
      setDraftNumber(target.plan.heatThreshold)
    } else {
      setDraftText(target.rule.receivers.join('、'))
    }
  }

  function submitEdit(): void {
    if (!editTarget) {
      return
    }
    if (editTarget.kind === 'planKeywords') {
      const keywords = draftText.split(/[、,，\s]+/).map((word) => word.trim()).filter(Boolean)
      const result = updatePlanKeywords(editTarget.plan.id, keywords)
      if (result.allowed) {
        setEditTarget(null)
      }
    } else if (editTarget.kind === 'planThreshold') {
      const result = updatePlanThreshold(editTarget.plan.id, draftNumber)
      if (result.allowed) {
        setEditTarget(null)
      }
    } else {
      const receivers = draftText.split(/[、,，\s]+/).map((word) => word.trim()).filter(Boolean)
      const result = updateRuleReceivers(editTarget.rule.id, receivers)
      if (result.allowed) {
        setEditTarget(null)
      }
    }
  }

  return (
    <section className="page sentiment-link" data-module="sentiment-link">
      <header className="page-head">
        <div>
          <h2>舆情预警联动 · 重叠关键词热度归并</h2>
          <p className="page-desc">
            同一内容标签与同一时间窗口只形成一份热度结果，每条内容对预警状态最多贡献一次；
            共享内容原始热度不重复增长，各方案仍保留各自情感倾向与预警结论。
          </p>
        </div>
      </header>

      {/* 口径说明 */}
      <article className="panel rule-panel">
        <h3>归并口径（关键词包含关系与采样截止时点）</h3>
        <ul>
          <li>
            <strong>关键词包含关系：</strong>关键词先去空白、去重并按长度降序，按「子串包含」匹配正文；
            一条内容被多个方案命中时，<em>原始热度只累计一次</em>，命中方案各自独立判阈。
          </li>
          <li>
            <strong>时间窗口与采样截止时点：</strong>按整点小时对齐，窗口
            <code>{formatHour(engineResult.windowId)}</code>，采样截止时点
            <code>{formatHour(engineResult.cutoffAt)}</code>（窗口右边界整点），仅纳入窗口内采样内容。
          </li>
          <li>
            <strong>归并键：</strong>
            <code>内容标签 tag + 时间窗口 windowId</code>，同键只产出一份热度结果。
          </li>
          <li>
            <strong>批次仲裁：</strong>两个聚合批次同时到达时，覆盖时间范围更完整者采纳，另一批进入
            <em>待复核</em>而不是覆盖；覆盖时长相同再比采样截止时点。
          </li>
        </ul>
      </article>

      {/* 操作人切换 + 权限说明 */}
      <article className="panel operator-panel">
        <div className="operator-switch">
          <span className="panel-label">当前操作人</span>
          {operators.map((item: Operator) => (
            <button
              key={item.name}
              type="button"
              className={`chip-btn ${operator.name === item.name ? 'active' : ''}`}
              onClick={() => {
                setOperator(item)
                setFeedback(null)
              }}
            >
              {item.name}
              <span className={`role-tag ${item.role}`}>{item.role === 'owner' ? '负责人' : '只读'}</span>
            </button>
          ))}
        </div>
        <p className="permission-hint">
          仅「归属负责人」可维护对应共享内容；只读成员只能查看。越权或只读的提交会被拒绝并写入审计日志。
        </p>
      </article>

      {/* 去重成效统计 */}
      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">跨方案命中总次数（含重复风险）</span>
          <strong className="stat-value">{engineResult.rawContentCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">去重后唯一内容数</span>
          <strong className="stat-value">{engineResult.dedupedContentCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">消除的重复热度贡献</span>
          <strong className="stat-value highlight">{engineResult.eliminatedDuplicateContributions}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">归并键（标签+窗口）热度结果份数</span>
          <strong className="stat-value">{engineResult.mergedRecords.length}</strong>
        </article>
      </div>

      {/* 聚合批次仲裁 */}
      <article className="panel">
        <div className="panel-head">
          <h3>聚合批次仲裁（两批同时到达）</h3>
          <button className="btn primary" type="button" onClick={simulateConcurrentBatches}>
            模拟两个批次同时到达
          </button>
        </div>
        <div className="batch-grid">
          {[batches.full, batches.partial].map((batch) => {
            const isAccepted = arbitration?.accepted.id === batch.id
            const isPending = arbitration?.pendingReview.id === batch.id
            return (
              <article
                key={batch.id}
                className={`batch-card ${isAccepted ? 'accepted' : ''} ${isPending ? 'pending' : ''}`}
              >
                <header>
                  <strong>{batch.id}</strong>
                  {isAccepted && <span className="badge positive">已采纳（可覆盖）</span>}
                  {isPending && <span className="badge warning">待复核（禁止覆盖）</span>}
                  {!arbitration && <span className="badge neutral">待仲裁</span>}
                </header>
                <dl>
                  <div>
                    <dt>覆盖范围</dt>
                    <dd>
                      {formatHour(batch.rangeStart)} ~ {formatHour(batch.rangeEnd)}
                    </dd>
                  </div>
                  <div>
                    <dt>采样截止时点</dt>
                    <dd>{formatHour(batch.cutoffAt)}</dd>
                  </div>
                  <div>
                    <dt>覆盖时长</dt>
                    <dd>{(new Date(batch.rangeEnd).getTime() - new Date(batch.rangeStart).getTime()) / 3600000} 小时</dd>
                  </div>
                  <div>
                    <dt>携带内容</dt>
                    <dd>{batch.contentIds.join('、')}（{batch.contentIds.length} 条）</dd>
                  </div>
                </dl>
              </article>
            )
          })}
        </div>
        {arbitration && <p className="arbitration-reason">⚖️ {arbitration.reason}</p>}
      </article>

      {/* 舆情方案去重视图 */}
      <article className="panel">
        <h3>舆情方案去重视图（SENT）</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>方案编号</th>
                <th>关键词集合</th>
                <th>情感倾向</th>
                <th>热度阈值</th>
                <th>窗口去重热度</th>
                <th>预警状态</th>
                <th>关联产品</th>
                <th>归属负责人</th>
                <th>维护操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const heat = heatByPlan.get(plan.id)
                return (
                  <tr key={plan.id}>
                    <td>
                      <strong>{plan.id}</strong>
                      <span className="sub-text">{plan.topic}</span>
                    </td>
                    <td>
                      <div className="keyword-chips">
                        {plan.keywords.map((keyword) => (
                          <span
                            key={keyword}
                            className={`keyword-chip ${sharedKeywords.has(keyword) ? 'shared' : ''}`}
                            title={sharedKeywords.has(keyword) ? '共享关键词：多方案命中同一内容时热度只计一次' : ''}
                          >
                            {keyword}
                            {sharedKeywords.has(keyword) && <em>共享</em>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={SENTIMENT_CLASS[plan.sentiment]}>{plan.sentiment}</span>
                    </td>
                    <td>{plan.heatThreshold}</td>
                    <td>
                      <strong>{heat?.mergedHeat ?? 0}</strong>
                      <span className="sub-text">{heat?.contentCount ?? 0} 条去重内容</span>
                    </td>
                    <td>
                      <span className={`badge ${heat?.alertState === '已预警' ? 'danger' : 'neutral'}`}>
                        {heat?.alertState ?? '—'}
                      </span>
                    </td>
                    <td>{plan.product}</td>
                    <td>{plan.owner}</td>
                    <td className="row-actions">
                      <button
                        className="link"
                        type="button"
                        disabled={isReadonly}
                        title={isReadonly ? '只读成员仅可查看，不能维护共享内容' : undefined}
                        onClick={() => openEdit({ kind: 'planKeywords', plan })}
                      >
                        维护关键词
                      </button>
                      <button
                        className="link"
                        type="button"
                        disabled={isReadonly}
                        title={isReadonly ? '只读成员仅可查看，不能维护共享内容' : undefined}
                        onClick={() => openEdit({ kind: 'planThreshold', plan })}
                      >
                        调整阈值
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="sub-text">
          SENT-0001（负面）与 SENT-0002（中性）共享「退款」，命中同一内容时各自独立判阈、保留各自预警结论，但共享内容原始热度不重复增长。
        </p>
      </article>

      {/* 归并后的一份份热度结果 */}
      <article className="panel">
        <h3>归并热度结果（同一内容标签 + 同一时间窗口只出一份）</h3>
        <div className="merge-grid">
          {engineResult.mergedRecords.map((record) => (
            <article key={record.mergeKey} className="merge-card">
              <header>
                <strong>{record.mergeKey}</strong>
                <span className="badge neutral">去重内容 {record.contentCount} 条</span>
              </header>
              <table className="data-table inner-table">
                <thead>
                  <tr>
                    <th>内容编号</th>
                    <th>原始热度（仅计一次）</th>
                    <th>命中方案</th>
                  </tr>
                </thead>
                <tbody>
                  {record.contents.map((content) => (
                    <tr key={content.contentId}>
                      <td>{content.contentId}</td>
                      <td>{content.rawHeat}</td>
                      <td>{content.planIds.join('、')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <footer className="merge-total">
                归并热度（不跨方案翻倍）：<strong>{record.mergedHeat}</strong>
              </footer>
            </article>
          ))}
        </div>
      </article>

      {/* 原始内容命中明细：证明只累计一次 */}
      <article className="panel">
        <h3>原始内容命中明细（每条内容对预警状态最多贡献一次）</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>内容编号</th>
                <th>内容标签</th>
                <th>采样时间</th>
                <th>原始热度</th>
                <th>命中方案 / 关键词</th>
              </tr>
            </thead>
            <tbody>
              {engineResult.hits.map((hit) => (
                <tr key={hit.contentId}>
                  <td>{hit.contentId}</td>
                  <td>{hit.tag}</td>
                  <td>{formatHour(hit.sampledAt)}</td>
                  <td>{hit.rawHeat}</td>
                  <td>
                    <ul className="hit-list">
                      {hit.planIds.map((planId) => (
                        <li key={planId}>
                          <strong>{planId}</strong>：{hit.matchedKeywords[planId].join('、')}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* 运营预警规则 */}
      <article className="panel">
        <h3>运营预警规则（OPSA）监控指标与接收人名单</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>预警编号</th>
                <th>监控指标</th>
                <th>比较方式</th>
                <th>阈值</th>
                <th>持续周期</th>
                <th>级别</th>
                <th>接收人名单</th>
                <th>归属负责人</th>
                <th>维护操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <strong>{rule.id}</strong>
                  </td>
                  <td>{rule.metric}</td>
                  <td>{rule.compareOp}</td>
                  <td>{rule.threshold}</td>
                  <td>{rule.duration}</td>
                  <td>
                    <span className="badge warning">{rule.level}</span>
                  </td>
                  <td>
                    <div className="receiver-chips">
                      {rule.receivers.map((receiver) => (
                        <span key={receiver} className="keyword-chip receiver">
                          {receiver}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{rule.owner}</td>
                  <td className="row-actions">
                    <button
                      className="link"
                      type="button"
                      disabled={isReadonly}
                      title={isReadonly ? '只读成员仅可查看，不能维护共享内容' : undefined}
                      onClick={() => openEdit({ kind: 'ruleReceivers', rule })}
                    >
                      修改接收人
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* 审计日志 */}
      <article className="panel">
        <h3>权限审计日志（通过与拒绝均留痕）</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>时间</th>
                <th>操作人</th>
                <th>角色</th>
                <th>动作</th>
                <th>对象</th>
                <th>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {audit.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={8}>
                    暂无审计记录，切换操作人后尝试维护共享内容或触发批次仲裁
                  </td>
                </tr>
              )}
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.id}</td>
                  <td>{formatHour(entry.at)}</td>
                  <td>{entry.operator}</td>
                  <td>
                    <span className={`role-tag ${entry.role}`}>{entry.role === 'owner' ? '负责人' : '只读'}</span>
                  </td>
                  <td>{entry.action}</td>
                  <td>{entry.target}</td>
                  <td>
                    <span className={`badge ${entry.result === '通过' ? 'positive' : 'danger'}`}>{entry.result}</span>
                  </td>
                  <td className="audit-detail">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* 反馈条 */}
      {feedback && (
        <div className={`feedback-bar ${feedback.ok ? 'ok' : 'deny'}`} role="status">
          <span>{feedback.ok ? '✅' : '⛔'} {feedback.message}</span>
          <button className="link" type="button" onClick={() => setFeedback(null)}>
            关闭
          </button>
        </div>
      )}

      {/* 维护弹窗 */}
      {editTarget && (
        <div className="modal-mask" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>
              {editTarget.kind === 'ruleReceivers'
                ? `修改接收人名单 · ${editTarget.rule.id}`
                : `${editTarget.kind === 'planKeywords' ? '维护共享关键词' : '调整热度阈值'} · ${editTarget.plan.id}`}
            </h3>
            <p className="sub-text">
              归属负责人：
              {editTarget.kind === 'ruleReceivers' ? editTarget.rule.owner : editTarget.plan.owner}；当前操作人：
              {operator.name}（{operator.role === 'owner' ? '负责人' : '只读'}）
            </p>
            {editTarget.kind === 'planThreshold' ? (
              <label className="modal-field">
                <span>热度阈值</span>
                <input
                  type="number"
                  value={draftNumber}
                  onChange={(event) => setDraftNumber(Number(event.target.value))}
                />
              </label>
            ) : (
              <label className="modal-field">
                <span>{editTarget.kind === 'ruleReceivers' ? '接收人名单（顿号/逗号分隔）' : '关键词集合（顿号/逗号分隔）'}</span>
                <textarea rows={4} value={draftText} onChange={(event) => setDraftText(event.target.value)} />
              </label>
            )}
            {feedback && !feedback.ok && <p className="error-text modal-error">⛔ {feedback.message}</p>}
            <footer className="modal-actions">
              <button className="btn primary" type="button" onClick={submitEdit}>
                提交维护
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  setEditTarget(null)
                  setFeedback(null)
                }}
              >
                取消
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}
