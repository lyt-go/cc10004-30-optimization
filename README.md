# 数据产品运营与归因分析平台

面向数据产品运营、渠道归因、用户行为分析、ROI评估、转化优化与数据应用监控的数据分析工程平台。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/features/         跨模块专题能力（如舆情联动热度归并 sentiment-link）
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── scripts/              纯逻辑引擎的独立验收脚本（不依赖浏览器）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 渠道管理 | `channel` | 渠道配置 | 渠道编号、渠道名称、渠道类型 |
| 投放活动 | `campaign` | 投放活动 | 活动编号、活动名称、关联渠道 |
| 触点追踪 | `touchpoint` | 触点记录 | 触点编号、用户标识、触点类型 |
| 归因分析 | `attribution` | 归因模型 | 模型编号、模型名称、归因算法 |
| ROI评估 | `roi` | ROI报告 | 报告编号、关联活动、投入金额 |
| 转化漏斗 | `conversion` | 转化定义 | 转化编号、转化名称、步骤序列 |
| 用户路径 | `userpath` | 路径模式 | 模式编号、路径名称、节点序列 |
| 留存分析 | `retention` | 留存方案 | 方案编号、方案名称、初始事件 |
| 事件定义 | `eventdef` | 埋点事件 | 事件编号、事件名称、事件类型 |
| 用户画像 | `profile` | 画像定义 | 画像编号、画像名称、统计维度 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、页面名称、热力类型 |
| 竞品对标 | `benchmark` | 对标方案 | 方案编号、对标对象、对比指标 |
| 数据审计 | `auditcheck` | 审计规则 | 规则编号、审计对象、校验字段 |
| 分流配置 | `abgroup` | 分流方案 | 方案编号、方案名称、分流类型 |
| 可视化配置 | `dataviz` | 图表配置 | 配置编号、图表名称、图表类型 |
| 舆情分析 | `sentiment` | 舆情方案 | 方案编号、监控主题、关键词集合 |
| 舆情联动热度归并 | `sentiment-link`（路由 `/sentiment-link`） | 去重热度/批次仲裁/权限审计 | 方案关键词、情感倾向、热度阈值、归并键 |
| 生命周期 | `lifecycle` | 生命周期模型 | 模型编号、模型名称、生命周期阶段 |
| 运营预警 | `opsalert` | 预警规则 | 预警编号、监控指标、比较方式 |

## 舆情联动 · 重叠关键词热度归并

针对多个舆情方案共享关键词、命中同一内容时热度被重复累计导致阈值误触发的问题，
`frontend/src/features/sentiment-link/` 提供一套纯函数归并引擎与去重视图：

- **归并键 = 内容标签 tag + 时间窗口 windowId**：同一标签、同一窗口只形成一份热度结果，
  每条内容对预警状态最多贡献一次，共享内容的原始热度不跨方案重复增长。
- **情感结论独立**：各方案基于去重后的同一内容集合独立判阈，情感倾向不同的方案各自保留预警状态
  （SENT-0001 负面 / SENT-0002 中性，共享「退款」关键词）。
- **关键词包含关系**：关键词先 trim、去重并按长度降序，按子串包含匹配正文；
  一条内容命中同一方案多个关键词只计一次，命中词全部留痕便于排查包含关系。
- **时间窗口与采样截止时点**：按整点小时对齐，采样截止时点取窗口右边界整点，仅纳入窗口内内容。
- **聚合批次仲裁**：两个批次同时到达时，覆盖时间范围更完整者采纳，另一批进入「待复核」而不是覆盖；
  覆盖时长相同再比较采样截止时点。
- **权限**：只有归属负责人可维护对应方案/规则；其他负责人越权、只读成员改动均被拒绝，
  通过与拒绝都写入审计日志。

引擎为无 DOM 依赖的纯函数，可用 Node 直接验收（25 项断言）：

```bash
cd frontend
./node_modules/.bin/tsc -p scripts/tsconfig.verify.json
node --experimental-loader ./scripts/verify-loader.mjs .verify-build/scripts/sentiment-link-verify.js
```

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-product-ops:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据分析与数据应用
