// The fixed leadership protocol wrapped around every user prompt. The leader
// owns requirements, design, decisions and acceptance; the worker that receives
// this prompt executes the dispatched work and hands back a compact summary
// only. It never rewrites the user's requirement (kept verbatim under
// 【用户需求】) and it encodes the scheduler's behavioral rules: bounded tasks,
// read-only review,
// auto profile runs fully approved bypassPermissions (2026-08-26 user
// decision: permission classifier removed — it timed out through the DeepSeek
// route and blocked already-approved work; scheduled/worker runs never consult
// a model-backed permission classifier), no unauthorized high-impact actions,
// parallelism discipline (a file set has exactly one writer).
import { resolveRouting, type Profile, type Parallelism, type TaskType } from './router.js';
import type { WorkerBackend, ReplyMode } from './backend-policy.js';

// The explicit task contract for research/analysis jobs. `deliverablePath` is
// the exact absolute path of the single primary artifact (a Markdown report),
// validated by the scheduler before the job is persisted.
export interface TaskContract {
  taskType?: TaskType;
  deliverablePath?: string;
}

// Optional execution context: which worker backend runs this prompt and in
// which reply mode.  When omitted the prompt is byte-for-byte historical.
// `backend` names the adapter for routing/policy only; the injected execution
// block always describes capabilities by behavior, never by backend name.
export interface ExecutionContext {
  backend: WorkerBackend;
  replyMode: ReplyMode;
}

export function buildPrompt(
  profile: Profile,
  userPrompt: string,
  parallelism: Parallelism,
  contract?: TaskContract,
  execution?: ExecutionContext,
): string {
  const routing = resolveRouting(profile);
  const pDir = parallelismDirective(parallelism);
  const roleLine =
    profile === 'review'
      ? '本次为只读取证任务：只读检查、分析、风险排查，禁止修改任何文件；产出仅限事实与证据（区分观察事实与推断），不替领导设计方案或下结论性建议。'
      : '本次为实现/执行任务：实现、自测、内部审查。';

  const lines = [
    '# 任务领导协议（由异步调度器注入；用户原始需求见文末【用户需求】，不得曲解）',
    '',
    roleLine,
    '1. 复述目标、边界、验收标准；不明确但不影响主方向的细节自行作合理假设。',
    '2. 先检查工作区和既有改动；保护用户未提交修改，不清理无关内容。',
    '3. ' + pDir,
    '4. 实现后执行与风险匹配的测试、静态检查和 diff 自审；失败时做针对性修复（最多两轮），避免重复测试；遇到无法解决的阻塞如实报告，不擅自扩大范围。',
    '5. 禁止未经明确授权执行：发布、推送、删除、重置、创建付费资源、外部消息发送等高影响动作。',
    '6. 最终只回传：状态、变更摘要、自测结果、剩余风险、需要用户处理的审批；禁止贴完整 diff、长日志和敏感信息。',
    '7. 本任务由路由档位执行：' + routing.label + '。auto 档位为全通过（bypassPermissions）：权限分类器已于 2026-08-26 用户决策废除（经 DeepSeek 路由持续超时、阻塞已批准操作），所有工具调用不再逐项审批。**没有沙箱**：你以当前用户身份执行命令、读写文件、访问网络。唯一生效的策略层是 deny 规则（命中即拒绝）：它由「内置基线 + 使用者白名单」取并集组成，覆盖 git push、shutdown/format、按镜像名批量杀进程、curl/wget/powershell 等网络出口、~/.ssh 与 ~/.aws 等凭据位置、env/printenv、C:/Windows 与 C:/Program Files 写保护等不可挽回动作；基线不可通过配置降低，但 deny 只是**命令前缀匹配**，改个写法或写进脚本即可绕过——不要把它当成边界。review/normal 按各自档位规则执行。',
    '   高影响动作（发布、推送、删除、重置、创建付费资源、外部消息发送等）仍须按第 5 条自行把关并向用户报告，不得利用放行静默越权。',
    '8. 状态只有满足全部验收标准才可视为成功。',
    '9. 图像和大块数据使用合适的文件或图像工具查看，不在文本回复中粘贴 base64 或无关的大块数据。',
    '10. 中间产物落盘：长任务的清单、状态、结论随做随写盘，保证任一步之后都能以最小上下文开新会话续接；不要依赖把全部历史留在对话里。',
    '11. 角色边界：你是执行层，领导负责方案、决策与验收。若任务要求"设计/规划/给出建议"而未附领导的既定方向与约束，不要自行成稿完整方案——输出事实清单、可选方向的利弊对照和"需领导拍板"的开放决策点即止；结论、建议与方案由领导亲写；不得扩大授权范围，也不得把结论性内容当作领导的决策输出。',
    '12. 按需要读取完整文件和 diff，修改后可重新读取核验；优先定位相关内容，避免无关读取和冗长输出。',
    '',
    '【路由】' + routing.label + '（profile=' + profile + '，parallelism=' + parallelism + '）',
    '',
    ...executionBlock(execution),
    '【用户需求】',
    userPrompt.trim(),
  ];

  // Research/analysis deliverable contract. Execution (or omitted taskType)
  // stays byte-for-byte identical to the historical prompt.
  if (
    (contract?.taskType === 'research' || contract?.taskType === 'analysis') &&
    typeof contract.deliverablePath === 'string' &&
    contract.deliverablePath.length > 0
  ) {
    lines.push('', ...deliverableContract(contract.deliverablePath));
  }
  return lines.join('\n');
}

// Short execution-semantics block injected before 【用户需求】 when the caller
// supplies an execution context.  The user's own text is never changed.
// Deliberately no backend name strings: the worker must describe itself by its
// ACTUAL capabilities, and the block itself never claims a capability the
// adapter does not have.
function executionBlock(execution?: ExecutionContext): string[] {
  if (!execution) return [];
  if (execution.backend === 'claude' && execution.replyMode === 'resume_session') {
    return [
      '【执行语义】本次任务续接已保存的 Claude 会话（可恢复历史上下文、实时事件与注意力审批能力齐备）。',
    ];
  }
  if (execution.backend === 'deepseek-harness' && execution.replyMode === 'fresh_turn') {
    // Harness replies are fresh bounded turns: they must never claim a
    // recoverable session (no contiguous "saved session resume" phrasing).
    return [
      '【执行语义】本次任务为新的独立轮次：不继承历史会话上下文。',
      '不得假定或声称本执行与任何先前会话存在关联或延续关系；所有必要上下文必须由本任务自身承载。',
      '本执行只支持单次有界任务与取消：没有历史会话的衔接、实时事件流或注意力审批；结果以最终文本形式返回。',
    ];
  }
  return [];
}

// Concise research/analysis deliverable contract injected into the worker's
// protocol. The worker's own Markdown report is the single primary artifact and
// is never overwritten or synthesized by the orchestrator; the leader only ever
// receives a compact status/path/hash summary.
function deliverableContract(deliverablePath: string): string[] {
  return [
    '【交付物契约】',
    '本任务为研究/分析任务，唯一主工件（primary artifact）是一份 Markdown 报告。',
    '报告必须写入以下精确绝对路径，不得改动、不得生成默认路径：',
    deliverablePath,
    '报告必须包含以下章节标题（顺序不限）：目标与范围、证据与方法、发现（事实）、未决问题与风险。默认禁止"结论与建议"章节——仅当领导在任务正文中给出候选方向并要求对比论证时，才可增加"选项利弊对照"章节，且只列利弊、不替领导拍板；区分观察事实与推断。',
    '报告内容需足够详细，能支撑 leader 的决策与验收。',
    '禁止在报告或最终答复中回传原始日志、完整 diff 或敏感信息。',
    '最终答复保持紧凑：状态 + 报告路径 + 可直接用于 SHA-256 校验的摘要。',
  ];
}

function parallelismDirective(p: Parallelism): string {
  switch (p) {
    case 'auto':
      return '按任务自适应启用多 Agent：仅当存在相互独立的工作流（如探索/实现/测试/审查）时才拆分为并行子任务；窄任务保持单 Agent；任何一组重叠文件只能有一个写入者。';
    case '1':
      return '保持单 Agent 执行，不拆并行。';
    default:
      return `最多启用 ${p} 个 Agent 并行，但仅限相互独立的工作流；任何一组重叠文件只能有一个写入者。`;
  }
}
