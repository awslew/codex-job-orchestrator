#!/usr/bin/env node
/**
 * tools/init.mjs — codex-job-orchestrator 环境探测 + 配置生成器
 * =============================================================================
 * 目标：把原来 9~12 步的手工改配置压成「一条命令 + 贴一段配置」。
 *
 * 设计铁律（未来的贡献者请勿破坏，这些是评审的验收线）：
 *   1. 只读探测：绝不修改、移动、删除用户任何现有文件（尤其 ~/.codex/config.toml、
 *      ~/.claude/settings.json）。所有产物写进仓库的 ./generated/，由用户自己决定怎么合并。
 *   2. 不碰凭据：探测凭据文件时只报告「存在/不存在」，绝不读内容；输出里绝不出现
 *      任何 token（用户输入的 token 只写进 generated/ 下的文件）。
 *   3. 环境变量契约按需注入：用户留空 = 该键整个不写进 config.toml（不是写空串）。
 *      空串会覆盖 CLI 自己的默认值，是安装期最常见的坑之一。
 *   4. 零第三方依赖 / 纯 Node ESM / Node >= 20 / Windows + macOS + Linux 同一份代码。
 *
 * 用法：
 *   node tools/init.mjs              # 交互式（无 TTY 时自动全默认，绝不卡死）
 *   node tools/init.mjs --yes        # 强制非交互，全部走默认值
 *   node tools/init.mjs --json       # 额外把探测结果以 JSON 打到 stdout（便于 CI）
 *   node tools/init.mjs --help
 *   DSH_INIT_FORCE_TTY=1 node tools/init.mjs   # 强制交互分支（stdin 结束即取默认），供自动化测试用
 * =============================================================================
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// §0 常量与命令行解析
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const TOOLS_DIR = path.dirname(__filename);
/** 仓库根目录：tools/ 的上一级，也是探测 dist/、写 generated/ 的位置。 */
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'generated');

const MCP_SERVER_KEY = 'claude_orchestrator';
const MIN_NODE_MAJOR = 20;

/** 只读工具免审：这五个工具只读，不产生副作用，不该每轮弹审批。 */
const READONLY_TOOLS = ['claude_code_status', 'claude_code_list', 'claude_code_health', 'claude_code_watch', 'claude_code_wait'];

const argv = process.argv.slice(2);
const SHOW_HELP = argv.includes('--help') || argv.includes('-h');
const ASSUME_YES = argv.includes('--yes') || argv.includes('-y');
const JSON_OUT = argv.includes('--json');

// 颜色：只在确实支持时开启。NO_COLOR 是事实标准；FORCE_COLOR 用于 CI；Windows 传统
// 控制台（无 WT_SESSION/TERM）默认关，避免把 ANSI 显示成乱码。
const colorEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (!process.stdout.isTTY) return false;
  if (process.platform === 'win32') {
    return Boolean(process.env.WT_SESSION || process.env.TERM || process.env.ANSICON || process.env.ConEmuANSI === 'ON');
  }
  return process.env.TERM !== 'dumb';
})();
const paint = (code) => (s) => (colorEnabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const C = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('36'),
  gray: paint('90'),
};

/** 统一输出通道。所有面向用户的文本都过这里，便于日后加 --quiet 或写日志文件。 */
const out = (line = '') => process.stdout.write(`${line}\n`);
const hr = () => out(C.gray('─'.repeat(72)));
const step = (title) => {
  out('');
  out(C.bold(C.blue(`▌ ${title}`)));
};

const OK = C.green('✅');
const WARN = C.yellow('⚠️ ');
const BAD = C.red('❌');
const INFO = C.gray('ℹ️ ');

/** 探测结果条目：既用于终端打印，也用于 --json 与 README 生成。 */
const probeLog = [];
function probe(label, status, detail) {
  probeLog.push({ label, status, detail });
  const icon = status === 'ok' ? OK : status === 'warn' ? WARN : status === 'bad' ? BAD : INFO;
  out(`  ${icon} ${label}${detail ? C.gray(` — ${detail}`) : ''}`);
}

function fatal(msg, hint) {
  out('');
  out(`${BAD} ${msg}`);
  if (hint) out(`    ${C.gray(hint)}`);
  process.exitCode = 1;
}

// -----------------------------------------------------------------------------
// §1 跨平台工具层（这一节是「一份代码三平台」的全部脏活）
// -----------------------------------------------------------------------------

/** 当前用户 home。Windows 优先 USERPROFILE，POSIX 用 HOME；都没有则返回 null。 */
function homeDir() {
  const h = process.platform === 'win32' ? process.env.USERPROFILE || process.env.HOME : process.env.HOME || process.env.USERPROFILE;
  return h && h.trim() ? h : null;
}
const HOME = homeDir();
const homePath = (...seg) => (HOME ? path.join(HOME, ...seg) : null);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Windows 上**不能**直接把 .cmd / .bat / .ps1 交给 Node spawn：调度器全程用
// argv 数组 + shell:false（src/proc.ts、src/supervisor.ts 硬编码，且**永远不要**改
// 成 shell:true —— worker 的 prompt 是任意文本，末尾作为 argv 传递，一旦走 shell
// 就是命令注入面）。Node ≥ 20.12 对 .cmd + shell:false 直接抛 EINVAL（本机 Node
// v24.16.0 实测：spawnSync('…\\npm.cmd', ['--version'], {shell:false}) → EINVAL）。
// 所以查找器只认「可 spawn 的形态」：.exe 优先，其余 PATHEXT 里 spawn 安全的扩展名
// 次之，.cmd/.bat/.ps1 与无扩展名垫片一律不作为候选。
const SPAWN_UNSAFE_EXTS = new Set(['.CMD', '.BAT', '.PS1']);

const EXEC_EXTS = process.platform === 'win32'
  ? (() => {
      const all = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
      const safe = all.filter((e) => !SPAWN_UNSAFE_EXTS.has(e.toUpperCase()));
      const exe = safe.filter((e) => e.toUpperCase() === '.EXE');
      return [...exe, ...safe.filter((e) => e.toUpperCase() !== '.EXE')];
    })()
  : [];

/** 该路径是否是一个「Node 能直接 spawn」的可执行形态。 */
function isSpawnSafeFile(p) {
  if (!p || !isFile(p)) return false;
  if (process.platform !== 'win32') return true;
  return !SPAWN_UNSAFE_EXTS.has(path.extname(p).toUpperCase());
}

/**
 * 从一个 Windows 垫片（`claude.cmd` / 无扩展名的 sh 垫片 / `claude.ps1`）里解析出
 * 它真正 exec 的目标，返回可直接 spawn 的绝对路径（.exe 优先，其次 js 入口）。
 *
 * 为什么需要：npm 全局安装的 claude 在这个目录下只有垫片（实测本机布局：
 *   claude.cmd → "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
 *   claude      → exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
 *   claude.ps1）
 * 直接把 `claude.cmd` 写进 CLAUDE_CLI_NAME，worker 每次启动都会 EINVAL —— 而
 * 用户手敲 `claude --version` 是成功的，于是表现为「命令行能跑、调度器不能跑」。
 * 解析出原生 exe 就直接用它；只有 js 入口时由调用方改成
 * `CLAUDE_CLI_PREFIX=<node.exe>` + `CLAUDE_CLI_NAME=<js 入口>` 形态。
 *
 * 只读、有界（最多读 64KB），解析不到就返回 null（调用方据此给出可执行的提示）。
 */
function resolveShimTarget(shimPath) {
  let text;
  try {
    text = fs.readFileSync(shimPath, 'utf8').slice(0, 64 * 1024);
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const expand = (raw) =>
    path.normalize(
      raw
        .replace(/%~?dp0%?/gi, dir + path.sep)
        .replace(/\$\{?basedir\}?/g, dir)
        .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => process.env[name] ?? whole)
        .replace(/\\/g, path.sep),
    );
  const candidates = [];
  const re = /["']?([^"'\s]*\.(?:exe|js|cjs|mjs))["']?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const abs = expand(m[1]);
    if (isFile(abs) && !candidates.includes(abs)) candidates.push(abs);
    if (candidates.length >= 8) break;
  }
  const exe = candidates.find((c) => path.extname(c).toLowerCase() === '.exe');
  if (exe) return { kind: 'exe', target: exe };
  const js = candidates.find((c) => /\.(?:js|cjs|mjs)$/i.test(c));
  return js ? { kind: 'js', target: js } : null;
}

/**
 * which(name) —— 跨平台可执行文件查找。只返回「Node 能直接 spawn」的绝对路径；
 * 找不到返回 null。
 *
 * Windows 细节（踩过坑，别改回去）：
 *   · npm 全局安装会在 %APPDATA%\npm 同时放 `claude`（无扩展名 sh 垫片）、
 *     `claude.cmd`、`claude.ps1`。这三者都**不能** spawn（EINVAL），无扩展名那个
 *     尤其坑：它连 PATHEXT 都不认。所以这里只按 PATHEXT 里的 spawn 安全扩展名找，
 *     `.EXE` 排最前，且不使用无扩展名兜底。
 *   · 只有垫片时返回 null —— 由 probeClaudeCli 用 resolveShimTarget 解析出真正
 *     的可执行目标，绝不把垫片路径写进配置。
 *   · PATH 里常有安装脚本留下的引号包裹（"C:\Program Files\nodejs"），要去掉。
 *   · 结果统一 path.resolve，保证写进配置的是绝对路径。
 */
function which(name) {
  const rawPath = process.env.PATH || '';
  const dirs = rawPath
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  for (const ext of EXEC_EXTS) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return path.resolve(candidate);
    }
  }
  // POSIX：无扩展名才是常态。Windows 走到这里说明只有垫片（或什么都没装），
  // 返回 null 而不是返回一个 spawn 不了的路径。
  if (process.platform === 'win32') return null;
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * locate(name, extraCandidates) —— PATH 查找 + 平台惯用安装位置兜底。
 * GUI 启动的 Codex（尤其 Codex Desktop）常常拿不到登录 shell 的 PATH，所以光靠 PATH
 * 会漏掉 nvm / Volta / fnm / Homebrew 装的 CLI。extraCandidates 用来补这些位置。
 * 顺序即优先级：PATH 永远第一，用户自己配的覆盖我们猜的。
 *
 * 只返回可 spawn 的候选；命中的第一个不可 spawn 的垫片放进 `shim`，交给调用方决定
 * 是否解析它的真实目标（见 resolveShimTarget）。
 */
function locate(name, extraCandidates = []) {
  const fromPath = which(name);
  if (fromPath) return { file: fromPath, via: 'PATH', shim: null };
  let shim = null;
  for (const cand of extraCandidates) {
    if (!cand || !isFile(cand)) continue;
    if (isSpawnSafeFile(cand)) return { file: path.resolve(cand), via: 'fallback', shim: null };
    if (!shim) shim = path.resolve(cand);
  }
  return { file: null, via: null, shim };
}

/** 针对某个 CLI name 生成平台惯用候选路径（不含 PATH）。 */
function installCandidates(name) {
  const cands = [];
  if (!HOME) return cands;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    cands.push(path.join(appData, 'npm', `${name}.cmd`), path.join(appData, 'npm', `${name}.exe`));
    cands.push(path.join(localAppData, 'Programs', name, `${name}.exe`));
    cands.push(path.join(localAppData, `${name}`, `${name}.exe`));
    cands.push(path.join(HOME, '.local', 'bin', `${name}.exe`));
    // nvm-windows / Volta 的常见落点（版本号未知，用目录枚举兜底见 resolveUnderDirs）
    cands.push(path.join(HOME, 'AppData', 'Local', 'Volta', 'bin', `${name}.exe`));
  } else {
    cands.push(path.join(HOME, '.local', 'bin', name));
    cands.push('/usr/local/bin/' + name);
    cands.push('/opt/homebrew/bin/' + name);
    cands.push(path.join(HOME, '.npm-global', 'bin', name));
    cands.push(path.join(HOME, 'bin', name));
  }
  return cands;
}

/** 在若干父目录下做一层 glob（用于 nvm 这种带版本号的路径）。失败一律返回 []。 */
function childrenMatching(parent, predicate) {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => predicate(e))
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

/** 安静执行一个命令并拿 stdout（探测用，永不抛异常）。 */
function tryExec(file, args, timeoutMs = 3000) {
  try {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false });
    if (r.error || typeof r.stdout !== 'string') return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/** 把绝对路径安全地写成 JSON 字符串字面量（Windows 反斜杠会被正确转义）。 */
const jstr = (s) => JSON.stringify(String(s));

/** 家目录缩写成 ~，只用于终端显示；写进配置的永远是绝对路径。 */
function display(p) {
  if (!p) return '(未探测到)';
  if (HOME && (p === HOME || p.startsWith(HOME + path.sep))) return '~/' + p.slice(HOME.length + 1).split(path.sep).join('/');
  return p;
}

// -----------------------------------------------------------------------------
// §2 环境探测（全部只读）
// -----------------------------------------------------------------------------

function probeNode() {
  step('① 环境探测 · Node 运行时');
  const major = Number(process.versions.node.split('.')[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  probe(
    `Node ${process.versions.node}`,
    ok ? 'ok' : 'bad',
    ok ? `满足 >= ${MIN_NODE_MAJOR}` : `本项目要求 Node >= ${MIN_NODE_MAJOR}，请升级后重跑`,
  );
  probe('node 可执行文件', 'info', process.execPath);
  probe('平台', 'info', `${process.platform} ${process.arch}`);
  return { nodeVersion: process.versions.node, nodeMajor: major, nodeOk: ok, execPath: process.execPath, platform: process.platform, arch: process.arch };
}

function probeClaudeCli() {
  const cands = installCandidates('claude');
  if (process.platform === 'win32' && HOME) {
    cands.push(...childrenMatching(path.join(HOME, 'AppData', 'Roaming', 'nvm'), (e) => e.isDirectory() && /^v\d/.test(e.name)).map((d) => path.join(d, 'claude.cmd')));
    cands.push(...childrenMatching(path.join(HOME, 'AppData', 'Local', 'fnm_multishells'), () => true).map((d) => path.join(d, 'claude.cmd')));
    // npm 垫片旁边的真实目标（原生 exe / js 入口）也算候选，垫片本身交给
    // resolveShimTarget 解析 —— 见 §1 的 which()/locate() 注释。
    cands.push(path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  } else if (HOME) {
    cands.push(...childrenMatching(path.join(HOME, '.nvm', 'versions', 'node'), (e) => e.isDirectory() && /^v\d/.test(e.name)).map((d) => path.join(d, 'bin', 'claude')));
  }
  const found = locate('claude', cands);

  let file = found.file;
  let via = found.via;
  let prefix = null;
  let shim = found.shim;
  let shimUnusable = null;
  if (!file && shim) {
    // 只有 .cmd / .ps1 / 无扩展名垫片：解析它真正 exec 的目标。
    const resolved = process.platform === 'win32' ? resolveShimTarget(shim) : null;
    if (resolved && resolved.kind === 'exe') {
      file = resolved.target;
      via = 'shim-exe';
    } else if (resolved && resolved.kind === 'js') {
      file = resolved.target;
      via = 'shim-js';
      prefix = process.execPath;
    } else {
      shimUnusable = shim;
      shim = null;
    }
  }

  let version = null;
  if (file) {
    version = prefix ? tryExec(prefix, [file, '--version']) || null : tryExec(file, ['--version']) || null;
  }

  if (file && via === 'shim-exe') {
    probe(
      'claude CLI',
      'ok',
      `${file}${version ? ` (${version.split('\n')[0]})` : ''} —— 由垫片解析出的原生可执行文件（PATH 上只有 ${path.basename(found.shim)}，Node 下无法直接 spawn）`,
    );
  } else if (file && via === 'shim-js') {
    probe(
      'claude CLI',
      'ok',
      `${file}${version ? ` (${version.split('\n')[0]})` : ''} —— 垫片只提供 js 入口，配置里会用 CLAUDE_CLI_PREFIX=<node> 的形态启动（Node 下 spawn ${path.basename(found.shim)} 会 EINVAL）`,
    );
  } else if (file) {
    probe('claude CLI', 'ok', `${file}${version ? ` (${version.split('\n')[0]})` : ''}${found.via === 'fallback' ? ' [非 PATH，来自惯用安装位置]' : ''}`);
  } else if (shimUnusable) {
    probe(
      'claude CLI',
      'bad',
      `只找到 ${shimUnusable} —— 它不能被 Node 直接 spawn（shell:false 下报 EINVAL），且解析不出它指向的可执行文件；请安装原生 claude.exe（或让它指向 bin/claude.exe）后重跑`,
    );
  } else {
    probe('claude CLI', 'warn', '未找到 —— 档 2（Claude Code worker）需要它；档 1（仅 Luna）不需要');
  }
  return { file, via, version, prefix, shim: found.shim, shimUnusable };
}

function probeCodexCli() {
  const found = locate('codex', installCandidates('codex'));
  let version = null;
  if (found.file) version = tryExec(found.file, ['--version']) || null;
  if (found.file) {
    probe('codex CLI', 'ok', `${found.file}${version ? ` (${version.split('\n')[0]})` : ''}`);
  } else {
    probe('codex CLI', 'warn', '未找到 —— 本项目是 Codex 的 MCP server，宿主 CLI 缺失时配置无意义');
  }
  return { file: found.file, via: found.via, version };
}

function probeDsh() {
  // ① PATH 上的 dsh ② npm 全局 node_modules/@deepseek-ai/dsh/lib/bin.js
  // ③ 本机 checkout 的常见布局（仅当存在时才用，绝不安装任何东西）
  const fromPath = which('dsh');
  if (fromPath) {
    probe('deepseek-harness (dsh)', 'ok', `${fromPath} [来自 PATH]`);
    return { file: fromPath, via: 'PATH', root: null };
  }
  const candidates = [];
  const npmRoot = tryExec(which('npm') || (process.platform === 'win32' ? 'npm.cmd' : 'npm'), ['root', '-g'], 8000);
  if (npmRoot && isDir(npmRoot)) candidates.push(path.join(npmRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  if (HOME) {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    } else {
      candidates.push(path.join(HOME, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    }
  }
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');

  const hit = candidates.find((c) => isFile(c));
  if (hit) {
    probe('deepseek-harness (dsh)', 'ok', `${hit} [来自 npm 全局]`);
    return { file: hit, via: 'npm-global', root: path.resolve(hit, '..', '..') };
  }
  probe('deepseek-harness (dsh)', 'warn', '未找到 —— 只有档 3（deepseek-harness worker）需要它');
  return { file: null, via: null, root: null };
}

function probeSelfBuild() {
  const distIndex = path.join(REPO_ROOT, 'dist', 'index.js');
  const launcher = path.join(REPO_ROOT, 'dist', 'orchestrator-launcher.cjs');
  const hasIndex = isFile(distIndex);
  const hasLauncher = isFile(launcher);
  if (hasIndex) {
    const entry = hasLauncher ? launcher : distIndex;
    probe('本调度器构建产物', 'ok', `${entry}${hasLauncher ? ' (per-session runtime 隔离 launcher)' : ' (直接入口)'}`);
  } else {
    probe('本调度器构建产物', 'warn', `未构建 —— 先运行 npm install && npm run build（缺 ${display(distIndex)}）`);
  }
  return { distIndex, launcher, hasIndex, hasLauncher, entry: hasIndex ? (hasLauncher ? launcher : distIndex) : distIndex };
}

/** 极简 TOML 段落探测：只回答问题「有没有这个段」「该段里 enabled 是不是 false」。 */
function inspectCodexConfig() {
  const cfg = homePath('.codex', 'config.toml');
  const res = { path: cfg, exists: false, hasServerSection: false, serverDisabled: false, enabledTrue: false };
  if (!cfg) {
    probe('~/.codex/config.toml', 'warn', '无法确定 home 目录，跳过');
    return res;
  }
  if (!isFile(cfg)) {
    probe('~/.codex/config.toml', 'warn', '不存在 —— 合并片段时会新建，属于正常情况');
    return res;
  }
  res.exists = true;
  let text = '';
  try {
    text = fs.readFileSync(cfg, 'utf8'); // 只读；config.toml 不含凭据
  } catch {
    probe('~/.codex/config.toml', 'warn', '存在但不可读（权限？），按「未配置」处理');
    return res;
  }
  const lines = text.split(/\r?\n/);
  const headerRe = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${MCP_SERVER_KEY}\\s*\\]`);
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    probe('~/.codex/config.toml', 'warn', `存在；未发现 [mcp_servers.${MCP_SERVER_KEY}] 段（需手动合并生成的片段）`);
    return res;
  }
  res.hasServerSection = true;
  // 只看该段范围内的键：下一个 [ 段头即结束。
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*enabled\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (m) {
      const v = m[1].trim().toLowerCase();
      if (v === 'false') res.serverDisabled = true;
      if (v === 'true') res.enabledTrue = true;
    }
  }
  if (res.serverDisabled) {
    probe(`[mcp_servers.${MCP_SERVER_KEY}]`, 'bad', '已存在且被设为 enabled = false —— 这是头号坑：Codex 会认为这些工具根本不存在');
  } else if (res.enabledTrue) {
    probe(`[mcp_servers.${MCP_SERVER_KEY}]`, 'ok', '已存在且 enabled = true');
  } else {
    probe(`[mcp_servers.${MCP_SERVER_KEY}]`, 'warn', '已存在但未显式写 enabled —— 建议显式 enabled = true（生成的片段已显式声明）');
  }
  return res;
}

function inspectClaudeSide() {
  const whitelist = homePath('.claude', 'worker-whitelist.json');
  const readGuard = homePath('.claude', 'cache-sentinel', 'read-guard.cjs');
  const hasWhitelist = Boolean(whitelist && isFile(whitelist));
  const hasReadGuard = Boolean(readGuard && isFile(readGuard));

  if (hasWhitelist) probe('~/.claude/worker-whitelist.json', 'ok', '存在（worker 权限白名单会被读取）');
  else probe('~/.claude/worker-whitelist.json', 'warn', '不存在 —— worker 会退回内置策略（内置 deny 基线 + 保守 allow 清单），你的策略不会生效');

  if (hasReadGuard) probe('~/.claude/cache-sentinel/read-guard.cjs', 'ok', '存在（可选 hook：大文件读入告警）');
  else probe('~/.claude/cache-sentinel/read-guard.cjs', 'info', '不存在（可选）—— 缺它只损失大文件读取告警，不影响功能');

  // 凭据只报告存在性，绝不读取内容。
  const credCandidates = [homePath('.claude', '.credentials.json'), homePath('.codex', 'auth.json')];
  const credPresent = credCandidates.filter((p) => p && isFile(p));
  probe('凭据文件（仅检查存在性）', credPresent.length ? 'ok' : 'info', credPresent.length ? `${credPresent.length} 个存在（内容未被读取、未输出）` : '未发现 —— 若用官方登录态请先完成 CLI 登录');

  return { whitelistPath: whitelist, hasWhitelist, readGuardPath: readGuard, hasReadGuard };
}

function runProbes() {
  const node = probeNode();
  const claude = probeClaudeCli();
  const codex = probeCodexCli();
  const dsh = probeDsh();
  const build = probeSelfBuild();
  step('② 现有配置探测（只读，不修改任何文件）');
  const codexCfg = inspectCodexConfig();
  const claudeSide = inspectClaudeSide();
  return { node, claude, codex, dsh, build, codexCfg, claudeSide };
}

// -----------------------------------------------------------------------------
// §3 交互式询问（无 TTY → 全部默认值，绝不等待输入）
// -----------------------------------------------------------------------------

/**
 * 用固定 fd 包一层 readline，做成「事件驱动 + FIFO 队列」的问答器。
 *
 * 为什么不用朴素的 rl.question()：Node 24 在 terminal:false 下，若输入流已经吐出多行
 * 或提前 EOF，question() 的待答回调**不会**被已缓冲的行唤醒（实测：第一问正常、第二问
 * 永远等不到、第三问直接 ERR_USE_AFTER_CLOSE）。所以这里自己收集 line/close 事件，
 * 谁能答谁答，答不到的（EOF/超时）一律回 null → 上层取默认值。
 * 这样「TTY 正常交互」「输入被重定向」「完全无输入」三种情况都不会卡死。
 *
 * 只喂固定 fd 0 的 createReadStream，不用裸 process.stdin：libuv 对已关闭 stdio 的
 * 读操作会直接断言崩溃，包一层可以保证 error 事件可捕获。
 */
function makeAsk() {
  const input = fs.createReadStream(null, { fd: 0, autoClose: false });
  const rl = readline.createInterface({ input, output: process.stdout, terminal: false });
  const lines = []; // 已到达、还没被消费的输入行
  const waiters = []; // 正在等输入行的问答（FIFO）
  let closed = false;

  const flushClose = () => {
    closed = true;
    while (waiters.length) waiters.shift().resolve(null);
  };
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w.resolve(line);
    else lines.push(line);
  });
  rl.on('close', flushClose);
  input.on('error', flushClose); // fd 0 不可读（< /dev/null、管道断裂）时静默降级为默认值

  /**
   * 提问并等一行答案。
   * 返回 null 表示「没有答案可拿」（EOF / fd 不可读）—— 上层据此取默认值，绝不抛异常。
   * 真实终端上人可能长时间不答，所以给了 5 分钟兜底，到点按默认值继续（不会永久挂住）。
   */
  const ask = (q) =>
    new Promise((resolve) => {
      // 非 TTY 不会回声，答案后面补一个换行，避免下一次提示挤在同一行。
      const echoNewline = () => {
        if (!process.stdin.isTTY) process.stdout.write('\n');
      };
      process.stdout.write(q);
      if (lines.length) {
        const line = lines.shift();
        echoNewline();
        return resolve(line);
      }
      if (closed) return resolve(null);
      let settled = false;
      const waiter = {
        resolve: (v) => {
          if (settled) return;
          settled = true;
          echoNewline();
          resolve(v);
        },
      };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, 300000);
      if (typeof timer.unref === 'function') timer.unref();
    });

  return {
    ask,
    close: () => {
      try {
        rl.close();
      } catch {
        /* 已经关了 */
      }
      try {
        input.destroy();
      } catch {
        /* 无所谓 */
      }
    },
  };
}

async function askYesNo(ask, question, defaultYes, interactive) {
  if (!interactive) {
    out(`  ${C.gray('?')} ${question} → ${C.bold(defaultYes ? '是' : '否')} ${C.gray('(非交互模式，取默认)')}`);
    return defaultYes;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await ask(`${C.blue('?')} ${question} ${C.gray(defaultYes ? '[Y/n]' : '[y/N]')} `);
    if (raw === null) {
      out(C.gray('  (输入流已结束，取默认值)'));
      return defaultYes;
    }
    const v = raw.trim().toLowerCase();
    if (v === '') return defaultYes;
    if (['y', 'yes', '是', '1'].includes(v)) return true;
    if (['n', 'no', '否', '0'].includes(v)) return false;
    out(C.yellow('  请输入 y 或 n。'));
  }
  return defaultYes;
}

async function askText(ask, question, dflt, interactive, hint) {
  if (!interactive) {
    out(`  ${C.gray('?')} ${question} → ${C.bold(dflt ? dflt : '(留空)')} ${C.gray('(非交互模式，取默认)')}`);
    return dflt;
  }
  if (hint) out(C.gray(`    ${hint}`));
  const raw = await ask(`${C.blue('?')} ${question} ${dflt ? C.gray(`[默认: ${dflt}]`) : C.gray('[回车留空]')} `);
  if (raw === null) return dflt;
  const v = raw.trim();
  return v === '' ? dflt : v;
}

/** 询问第三方端点。留空是推荐路径，所以提示里必须讲清「留空 = 什么都不注入」。 */
async function askSecret(ask, question, interactive, hint) {
  if (!interactive) {
    out(`  ${C.gray('?')} ${question} → ${C.bold('(留空)')} ${C.gray('(非交互模式，取默认)')}`);
    return '';
  }
  if (hint) out(C.gray(`    ${hint}`));
  const raw = await ask(`${C.blue('?')} ${question} ${C.gray('[回车留空]')} `);
  if (raw === null) return '';
  return raw.trim();
}

async function askConfig(probes) {
  /** 交互过程中暂存的模型映射答案（避免把一堆局部变量穿过多层调用）。 */
  let customModelsAnswers = null;
  step('③ 交互式配置（无 TTY 时自动全默认；留空的变量一律不注入）');
  // 交互判据：显式 --yes 时强制非交互；否则要求 stdin+stdout 都是 TTY。
  // DSH_INIT_FORCE_TTY=1 是给贡献者/CI 用的逃生口：强制走进交互分支（stdin 结束即取默认），
  // 这样「无 TTY 不卡死」和「交互问卷正确」两条路径都能被自动测试覆盖。
  const isTty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const forceTty = ['1', 'true', 'on', 'yes'].includes(String(process.env.DSH_INIT_FORCE_TTY || '').trim().toLowerCase());
  const interactive = !ASSUME_YES && (isTty || forceTty);
  if (!interactive) {
    out(C.gray(`  ${INFO} 当前${ASSUME_YES ? '（--yes）' : '（非交互终端）'}：全部使用默认值，不需要任何输入，不会卡住。`));
  } else if (!isTty) {
    out(C.gray(`  ${INFO} DSH_INIT_FORCE_TTY 已开启：强制交互分支（输入流结束时会自动取默认值，不会卡住）。`));
  }

  const { ask, close } = interactive ? makeAsk() : { ask: null, close: () => {} };
  try {
    // —— 档位选择 ——
    out('');
    out(C.bold('  安装档位（决定后面问什么）：'));
    out(`    ${C.green('1')}) 仅 Luna（Codex 原生 worker）—— ${C.bold('不需要本调度器')}，零外部依赖，新手推荐`);
    out(`    2) + Claude Code worker —— 需要本调度器 + claude CLI + 可选第三方端点`);
    out(`    3) + deepseek-harness worker —— 在档 2 基础上再加 @deepseek-ai/dsh`);
    const dfltTier = probes.claude.file ? (probes.dsh.file ? 2 : 2) : 1;
    let tier = dfltTier;
    if (interactive) {
      const raw = await ask(`${C.blue('?')} 选择档位 ${C.gray(`[1/2/3，默认 ${dfltTier}]`)} `);
      const v = raw === null ? '' : String(raw).trim();
      if (v === '1' || v === '2' || v === '3') tier = Number(v);
      else if (v.toLowerCase() === 'luna' || v.toLowerCase() === 'none') tier = 1;
    } else {
      out(`  ${C.gray('?')} 选择档位 → ${C.bold(String(dfltTier))} ${C.gray('(非交互模式，按探测结果取默认)')}`);
    }
    out(`  ${INFO} 已选：${C.bold(`档 ${tier}`)}`);

    // —— 1. 是否使用 Claude Code worker ——
    const useClaude = tier === 1 ? false : await askYesNo(ask, '使用 Claude Code worker？（需要本机已装 claude CLI）', true, interactive);

    // —— 2. Anthropic 兼容端点 ——
    let baseUrl = '';
    let authToken = '';
    if (useClaude) {
      out('');
      out(C.gray('  关于端点（重要，别猜）：'));
      out(C.gray('    · 留空 = 不注入任何 ANTHROPIC_* 环境变量，claude CLI 用你自己的官方登录态。'));
      out(C.gray('    · 只有当你用第三方代理 / 自建网关时才填（填你自建网关的 URL）。'));
      out(C.gray('    · 本机默认端口上已跑 Anthropic 兼容代理时，可填 local 走回环地址。'));
      out(C.gray('    · 填了 base URL 就必须同时有对应的 token，否则 worker 会 401。'));
      baseUrl = await askText(ask, 'Anthropic 兼容端点 base URL', '', interactive, '示例：http://127.0.0.1:8080 —— 不知道填什么就回车留空（推荐）');
      if (baseUrl) {
        authToken = await askSecret(ask, '对应的 auth token', interactive, '仅写入 generated/（该目录已加 .gitignore），不会回显也不会进任何日志');
        if (!authToken) {
          out(C.yellow('    ⚠️  已填 base URL 但未填 token：worker 很可能 401。要不用官方登录态（两个都留空），要不把 token 补上。'));
        }
      } else {
        out(C.gray('    （base URL 留空 → 跳过 token 与模型映射提问，本次不注入任何端点变量）'));
      }

      // —— 3. 模型映射 ——
      if (baseUrl) {
        const customModels = await askYesNo(ask, '自定义模型映射（把 haiku/sonnet/opus 映射到网关上的模型名）？', false, interactive);
        if (customModels) {
          customModelsAnswers = {
            haiku: await askText(ask, '  模型映射 haiku', '', interactive),
            sonnet: await askText(ask, '  模型映射 sonnet', '', interactive),
            opus: await askText(ask, '  模型映射 opus', '', interactive),
          };
        }
      } else {
        out(`  ${C.gray('?')} 自定义模型映射 → ${C.bold('否')} ${C.gray('(留空 = 不注入，让 Claude CLI 用自己的默认模型)')}`);
      }
    }

    // —— 4. deepseek-harness ——
    let useDsh = false;
    let dshRoot = probes.dsh.root || '';
    let dshRunner = probes.dsh.file || '';
    if (tier === 3) {
      useDsh = await askYesNo(ask, '启用 deepseek-harness worker？（需要 npm 包 @deepseek-ai/dsh）', true, interactive);
      if (useDsh) {
        if (dshRoot) {
          dshRoot = await askText(ask, '  DEEPSEEK_HARNESS_ROOT（运行时目录）', dshRoot, interactive);
        } else {
          dshRoot = await askText(ask, '  DEEPSEEK_HARNESS_ROOT（运行时目录）', '', interactive, '本机未自动探测到 dsh，请填 harness 根目录；不知道就留空，稍后手动补');
        }
        dshRunner = await askText(ask, '  DEEPSEEK_HARNESS_RUNNER（runner 入口，可留空）', dshRunner, interactive, '留空则用 harness 默认入口（<root>/apps/cli/lib/bin.js）');
      }
    } else {
      out(`  ${C.gray('?')} 启用 deepseek-harness worker → ${C.bold('否')} ${C.gray(`(非档 3；本机探测：${probes.dsh.file ? '已安装' : '未安装'})`)}`);
    }

    // —— 5. 白名单路径（留空 = 用默认位置，最省事）——
    out('');
    const whitelistPath = await askText(
      ask,
      'worker 白名单文件绝对路径',
      '',
      interactive,
      '留空 = 用默认位置 ~/.claude/worker-whitelist.json（生成的 generated/worker-whitelist.json 拷到那里即可）；设了 ORCHESTRATOR_WHITELIST_PATH 才写进配置',
    );

    return { tier, useClaude, baseUrl, authToken, customModels: customModelsAnswers, useDsh, dshRoot, dshRunner, whitelistPath };
  } finally {
    close();
  }
}

// -----------------------------------------------------------------------------
// §4 产物生成
// -----------------------------------------------------------------------------

/**
 * TOML 字符串转义。
 * Windows 路径用 TOML 的「字面字符串」（单引号）最稳：字面串不做任何转义处理，
 * C:\Users\x\dist\index.js 原样保留，不会被 \U 之类的转义序列污染。
 * 只有路径含单引号或换行时才退回基本字符串（双引号 + 反斜杠/引号转义）。
 * 这是 Windows 上首次运行报 "expected a string" 或路径变成乱码的根因，别改。
 */
function tomlString(value) {
  const s = String(value);
  if (!s.includes("'") && !s.includes('\n') && !s.includes('\r')) return `'${s}'`;
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function buildTomlSnippet(cfg, probes) {
  const L = [];
  const entry = probes.build.entry;
  const useLauncher = probes.build.hasLauncher && path.basename(entry) === 'orchestrator-launcher.cjs';
  const node = probes.node.execPath;

  L.push('# ============================================================================');
  L.push('# codex-job-orchestrator — MCP server 配置片段');
  L.push(`# 由 tools/init.mjs 生成于 ${new Date().toISOString()}`);
  L.push('# 用法：把本文件内容整体追加到 ~/.codex/config.toml 末尾（或合并进已有的同名段），');
  L.push('#      然后重启 Codex / 重载 MCP。脚本不会替你改任何现有配置。');
  L.push('#');
  if (cfg.authToken) {
    L.push('# ⚠️ 本文件包含你输入的凭据（ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN）。');
    L.push('#    不要提交到版本库、不要贴到 issue/聊天里；generated/.gitignore 已设为忽略本目录。');
    L.push('#');
  }
  L.push('# 【头号坑】enabled = true 必须显式写。');
  L.push('#   若这段配置里 enabled = false（或从别处继承了 false），Codex 不会报错，');
  L.push('#   而是让 claude_code_* 这些工具「根本不存在」——排查半天找不到原因就是这个。');
  L.push('# ============================================================================');
  L.push('');
  L.push(`[mcp_servers.${MCP_SERVER_KEY}]`);
  L.push('# 必须为 true：false = 工具在 Codex 里完全不存在（静默失败）');
  L.push('enabled = true');
  L.push(`command = ${tomlString(node)}`);
  if (useLauncher) {
    L.push(`args = [${tomlString(entry)}]`);
    L.push('');
    L.push('# launcher 会按「父进程 PID」给每个 Codex 会话分配独立 runtime 目录，');
    L.push('# 避免多个会话共用一个 runtime/ 导致重复实例误报（duplicate_instance_suspected）。');
  } else {
    L.push(`args = [${tomlString(entry)}]`);
    L.push('');
    L.push('# 提示：构建后 dist/orchestrator-launcher.cjs 存在时优先用它（多会话 runtime 隔离）。');
  }
  L.push('');
  L.push('# 启动超时：首次启动要加载 SDK 与恢复历史 job，给足 120 秒，避免 Codex 过早判定失败。');
  L.push('startup_timeout_sec = 120');
  L.push('# 工具超时必须是 14400 秒（4 小时）。claude_code_watch 的最大挂起时长就是 4 小时，');
  L.push('# 小于这个值会被宿主提前掐断 —— 长任务看起来「莫名失败」多半是这里配小了。');
  L.push('tool_timeout_sec = 14400');

  // —— env 段：只写显式有值的变量 ——
  const envLines = [];
  const envNotes = [];

  if (cfg.baseUrl) envLines.push(['ORCHESTRATOR_ANTHROPIC_BASE_URL', cfg.baseUrl, '（你提供的第三方/自建兼容端点）']);
  else envNotes.push('#   ORCHESTRATOR_ANTHROPIC_BASE_URL    —— 未设置：不注入端点，claude CLI 用你自己的官方登录态');

  if (cfg.authToken) envLines.push(['ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN', cfg.authToken, '（含凭据，勿外传）']);
  else envNotes.push('#   ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN  —— 未设置：不注入 token');

  const models = cfg.customModels || {};
  const modelKeys = [
    ['ORCHESTRATOR_MODEL_HAIKU', 'haiku'],
    ['ORCHESTRATOR_MODEL_SONNET', 'sonnet'],
    ['ORCHESTRATOR_MODEL_OPUS', 'opus'],
  ];
  const setModels = [];
  for (const [key, field] of modelKeys) {
    const v = (models[field] || '').trim();
    if (v) {
      envLines.push([key, v, '（自定义模型映射）']);
      setModels.push(key);
    }
  }
  if (setModels.length === 0) {
    envNotes.push('#   ORCHESTRATOR_MODEL_HAIKU/SONNET/OPUS —— 未设置：不注入，Claude CLI 用默认模型');
  }

  if (cfg.whitelistPath) envLines.push(['ORCHESTRATOR_WHITELIST_PATH', cfg.whitelistPath, '（你指定的白名单绝对路径）']);
  else envNotes.push(`#   ORCHESTRATOR_WHITELIST_PATH        —— 未设置：调度器按默认位置读 ${display(probes.claudeSide.whitelistPath)}`);

  envLines.push(['ORCHESTRATOR_RUNTIME', path.join(REPO_ROOT, 'runtime'), '（运行时目录：jobs/logs/reports/registry）']);
  envLines.push([
    'CLAUDE_CLI_NAME',
    probes.claude.file || 'claude',
    probes.claude.via === 'shim-js'
      ? '（npm 垫片只提供 js 入口：这里写 cli.js，配合下面的 CLAUDE_CLI_PREFIX 用 node 启动）'
      : '（claude 可执行文件绝对路径）',
  ]);
  if (probes.claude.prefix) {
    envLines.push([
      'CLAUDE_CLI_PREFIX',
      probes.claude.prefix,
      '（Node 可执行文件：worker 实际以 `node <CLAUDE_CLI_NAME>` 启动。npm 全局安装的 claude 只有 .cmd/.ps1/无扩展名垫片，Node 在 shell:false 下 spawn 它们必然 EINVAL，所以必须用这个形态；有原生 claude.exe 时不需要它）',
    ]);
  }
  if (probes.claude.shimUnusable) {
    envNotes.push(
      `#   CLAUDE_CLI_NAME                    —— 只探测到 ${path.basename(probes.claude.shimUnusable)} 垫片：不可 spawn 且解析不出目标，档 2 现在跑不起来；安装原生 claude.exe 后重跑本脚本`,
    );
  }

  if (cfg.useDsh) {
    if (cfg.dshRoot) envLines.push(['DEEPSEEK_HARNESS_ROOT', cfg.dshRoot, '（harness 根目录）']);
    if (cfg.dshRunner) envLines.push(['DEEPSEEK_HARNESS_RUNNER', cfg.dshRunner, '（runner 入口，可留空）']);
  } else {
    envNotes.push('#   DEEPSEEK_HARNESS_ROOT / _RUNNER    —— 未启用档 3，不写入');
  }
  envNotes.push('#   ORCHESTRATOR_READ_GUARD_HOOK       —— 需要禁用 read-guard hook 时手工加，值设为 off');

  L.push('');
  L.push(`[mcp_servers.${MCP_SERVER_KEY}.env]`);
  L.push('# 只用「显式提供了值」的变量：留空的一律不写。');
  L.push('# 写空串会覆盖 CLI 自己的默认值，等于把用户官方登录态顶掉 —— 这是安装期第二大坑。');
  L.push('# 未被写入的变量（当前走默认行为）：');
  for (const n of envNotes) L.push(n);
  if (envLines.length) {
    L.push('');
    for (const [k, v, note] of envLines) L.push(`${k} = ${tomlString(v)}${note ? `  # ${note}` : ''}`);
  }

  // —— 只读工具免审 ——
  L.push('');
  L.push('# ----------------------------------------------------------------------------');
  L.push('# 只读工具免审（approval_mode = "auto"）：不产生任何副作用，不该每轮弹审批。');
  L.push('# claude_code_start / reply / cancel 是写操作，刻意不在这里放行。');
  L.push('# ----------------------------------------------------------------------------');
  for (const t of READONLY_TOOLS) {
    L.push(`[mcp_servers.${MCP_SERVER_KEY}.tools.${t}]`);
    L.push('approval_mode = "auto"');
  }
  L.push('');
  return L.join('\n');
}

/** 通用只读 + 开发命令白名单（不含任何个人私有 MCP server / 私有服务名）。 */
function buildWhitelist() {
  const allow = [
    // —— 只读文件与检索 ——
    'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch',
    // —— 写入（仅限工作区；系统目录由 deny 兜底）——
    'Write', 'Edit', 'MultiEdit',
    // —— 常用只读 shell ——
    'Bash(ls *)', 'Bash(ls)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
    'Bash(find *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(sed -n *)', 'Bash(awk *)',
    'Bash(diff *)', 'Bash(tree *)', 'Bash(file *)', 'Bash(stat *)', 'Bash(du *)', 'Bash(df *)',
    'Bash(pwd)', 'Bash(echo *)', 'Bash(date *)', 'Bash(which *)',
    'Bash(sort *)', 'Bash(uniq *)', 'Bash(cut *)', 'Bash(tr *)', 'Bash(xargs *)', 'Bash(basename *)',
    'Bash(dirname *)', 'Bash(realpath *)', 'Bash(sha256sum *)', 'Bash(shasum *)', 'Bash(cksum *)',
    // —— git 只读（push / reset --hard 等写操作刻意不在 allow）——
    'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git branch*)',
    'Bash(git rev-parse *)', 'Bash(git ls-files*)', 'Bash(git blame*)', 'Bash(git stash list*)',
    'Bash(git remote -v)', 'Bash(git config --get *)', 'Bash(git add *)', 'Bash(git commit *)',
    'Bash(git checkout *)', 'Bash(git switch *)', 'Bash(git restore *)', 'Bash(git merge *)',
    'Bash(git tag*)', 'Bash(git fetch*)',
    // —— 包管理与构建 ——
    'Bash(npm ci*)', 'Bash(npm install*)', 'Bash(npm i *)', 'Bash(npm run *)', 'Bash(npm test*)',
    'Bash(npm ls*)', 'Bash(npm view *)', 'Bash(npm outdated*)', 'Bash(npx --no-install *)',
    'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(bun *)', 'Bash(tsc*)', 'Bash(eslint *)', 'Bash(prettier *)',
    'Bash(vitest*)', 'Bash(jest*)', 'Bash(mocha*)', 'Bash(node --test *)', 'Bash(node --check *)',
    'Bash(node -e *)', 'Bash(python3 -m pytest*)', 'Bash(pytest*)', 'Bash(cargo build*)',
    'Bash(cargo test*)', 'Bash(go build *)', 'Bash(go test *)', 'Bash(make *)', 'Bash(cmake *)',
    // —— 目录与临时目录操作（限定前缀，避免裸 rm 通配）——
    'Bash(mkdir *)', 'Bash(mkdir -p *)', 'Bash(touch *)', 'Bash(cp *)', 'Bash(mv *)',
    'Bash(rm ./node_modules/*)', 'Bash(rm -rf ./node_modules)', 'Bash(rm -rf dist)', 'Bash(rm build/*)',
    'Bash(npx tsc*)',
  ];

  const deny = [
    // —— 版本库外发（不可逆、影响共享状态）——
    'Bash(git push)', 'Bash(git push *)',
    'Bash(git reset --hard*)', 'Bash(git clean -fdx*)',
    // —— 关机 / 格式化 / 注册表 / 递归删除根 ——
    'Bash(shutdown *)', 'Bash(format *)', 'Bash(reg delete *)', 'Bash(rm -rf /*)',
    // —— 其它高危破坏性命令（deny 是唯一生效的策略层：默认档位 bypassPermissions
    //    不逐项审批，命令前缀匹配的 deny 就是硬闸）——
    'Bash(mkfs*)', 'Bash(dd if=*)', 'Bash(fdisk*)', 'Bash(diskpart*)', 'Bash(del /f /s /q C:\\*)',
    'Bash(rm -rf ~*)', 'Bash(rm -rf $HOME*)', 'Bash(:(){ :|:& };:)',
    // —— 环境变量整体导出：会整段打印环境变量（含 worker 自己的 token），日志落盘 ——
    'Bash(env)', 'Bash(env *)', 'Bash(printenv)', 'Bash(printenv *)',
    // —— Windows 系统目录写保护 ——
    'Write(C:/Windows/**)', 'Edit(C:/Windows/**)', 'MultiEdit(C:/Windows/**)',
    'Write(C:/Program Files/**)', 'Edit(C:/Program Files/**)', 'MultiEdit(C:/Program Files/**)',
    'Write(C:/Program Files (x86)/**)', 'Edit(C:/Program Files (x86)/**)', 'MultiEdit(C:/Program Files (x86)/**)',
    'Write(C:/ProgramData/**)', 'Edit(C:/ProgramData/**)', 'MultiEdit(C:/ProgramData/**)',
    'Write(C:/Users/Public/**)', 'Edit(C:/Users/Public/**)', 'MultiEdit(C:/Users/Public/**)',
  ];
  // 去重（顺序保持稳定，便于评审时 diff 增量）。
  const cleanedDeny = [...new Set(deny)];

  // 跨平台：POSIX 系统目录同样保护（Windows 用户无副作用）。
  const posixDeny = [
    'Write(/etc/**)', 'Edit(/etc/**)', 'MultiEdit(/etc/**)',
    'Write(/usr/**)', 'Edit(/usr/**)', 'MultiEdit(/usr/**)',
    'Write(/bin/**)', 'Edit(/bin/**)', 'MultiEdit(/bin/**)',
    'Write(/System/**)', 'Edit(/System/**)', 'MultiEdit(/System/**)',
    'Bash(rm -rf /etc*)', 'Bash(rm -rf /usr*)', 'Bash(sudo rm -rf *)',
  ];

  return {
    defaultMode: 'bypassPermissions',
    permissions: {
      allow: [...new Set(allow)],
      deny: [...cleanedDeny, ...posixDeny],
    },
  };
}

function buildReadme(cfg, probes, outputs) {
  const L = [];
  const tierName = cfg.tier === 1 ? '档 1 · 仅 Luna（Codex 原生 worker）' : cfg.tier === 2 ? '档 2 · + Claude Code worker' : '档 3 · + deepseek-harness worker';
  L.push('# 下一步（由 tools/init.mjs 生成）');
  L.push('');
  L.push(`生成时间：${new Date().toISOString()}`);
  L.push(`安装档位：**${tierName}**`);
  L.push(`仓库根目录：\`${REPO_ROOT}\``);
  L.push('');
  L.push('> 本目录（`generated/`）里的文件都是**建议产物**，脚本没有改动你任何现有配置。');
  L.push('> `generated/.gitignore` 已设为忽略本目录全部内容（片段里可能含你输入的 token）。');
  L.push('');
  L.push('## 一、探测结果');
  L.push('');
  L.push('| 项目 | 结果 | 说明 |');
  L.push('|---|---|---|');
  const mark = (s) => (s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : s === 'bad' ? '❌' : 'ℹ️');
  // 纵深防御：README 是最可能被用户直接贴出去的一份（排查问题时最爱贴它），
  // 所以这里显式把用户输入的 token 冲掉，不留任何「靠用户自己注意」的口子。
  const scrub = (s) => {
    let t = String(s || '');
    if (cfg.authToken) t = t.split(cfg.authToken).join('<已隐去>');
    return t;
  };
  for (const p of probeLog) {
    L.push(`| ${scrub(p.label).replace(/\|/g, '\\|')} | ${mark(p.status)} | ${scrub(p.detail).replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## 二、生成的文件');
  L.push('');
  for (const f of outputs) {
    L.push(`- \`${f.rel}\` — ${f.desc}`);
  }
  L.push('');
  L.push('## 三、后续 3 步');
  L.push('');

  if (cfg.tier === 1) {
    L.push('档 1 **不需要本调度器**：你只用 Codex 原生 Luna worker。');
    L.push('');
    L.push('1. **不要**把 `codex-config.snippet.toml` 贴进 `~/.codex/config.toml`（档 1 用不上 MCP server）。');
    L.push('2. 确认 Codex 侧的 Luna 配置：`~/.codex/agents/luna_worker.toml` 存在，且 `~/.codex/config.toml` 有 `[agents]` 段引用它。');
    L.push('3. 重启 Codex，然后让 Codex 列一次可用工具，确认 Luna worker 已就绪。');
    L.push('');
    L.push('想升级到档 2：装好 `claude` CLI 后重跑 `node tools/init.mjs`，选档 2。');
  } else {
    L.push('### 1. 合并 MCP 配置到 `~/.codex/config.toml`');
    L.push('');
    L.push('先备份（脚本不替你改，改由你自己来）：');
    L.push('');
    L.push('```bash');
    if (process.platform === 'win32') L.push('copy "%USERPROFILE%\\.codex\\config.toml" "%USERPROFILE%\\.codex\\config.toml.bak"');
    else L.push('cp ~/.codex/config.toml ~/.codex/config.toml.bak');
    L.push('```');
    L.push('');
    L.push('然后把 `generated/codex-config.snippet.toml` 的**全部内容**追加到 `~/.codex/config.toml` 末尾。');
    L.push('');
    L.push('> ⚠️ 若已有 `[mcp_servers.claude_orchestrator]` 段：**删掉旧段再贴新的**，不要留两份；');
    L.push('> 并确认新段里是 `enabled = true`（`false` 会让工具在 Codex 里根本不存在，且不报错）。');
    if (probes.codexCfg.serverDisabled) {
      L.push('>');
      L.push('> 🔴 **探测发现你当前的配置里就是 `enabled = false`** —— 这正是「工具根本不存在」的原因，务必先改成 true。');
    }
    L.push('');
    L.push('### 2. 安装权限白名单（可选但强烈建议）');
    L.push('');
    if (cfg.whitelistPath) {
      L.push(`你指定了白名单路径：\`${cfg.whitelistPath}\`。把 \`generated/worker-whitelist.json\` 放到该路径即可。`);
    } else {
      L.push('把 `generated/worker-whitelist.json` 拷到默认位置（调度器按这个路径读）：');
      L.push('');
      L.push('```bash');
      const target = probes.claudeSide.whitelistPath || '~/.claude/worker-whitelist.json';
      if (process.platform === 'win32') {
        L.push(`mkdir "%USERPROFILE%\\.claude" 2>nul`);
        L.push(`copy generated\\worker-whitelist.json "${target}"`);
      } else {
        L.push('mkdir -p ~/.claude');
        L.push(`cp generated/worker-whitelist.json "${target}"`);
      }
      L.push('```');
      L.push('');
      L.push('缺这个文件时不会「裸奔」，但也**不会**用你的策略：worker 退回内置基线（内置 deny 清单 + 保守的 allow 清单），');
      L.push('`claude_code_start` 的返回里会带 `warnings` 说明退回原因，job 的 `runtime/logs/<jobId>.stderr.log` 里也有同一行提示。');
      L.push('');
      L.push('> 上面这份 `generated/worker-whitelist.json` 的 `deny` 只是**子集**：调度器会把代码内置基线（`src/config.ts` 的');
      L.push('> `DEFAULT_WORKER_DENY`）**自动并集**进你要用的规则里 —— 配置能加严、不能降级。基线补了几条会写在 `warnings` 里；');
      L.push('> 想彻底消掉那条提示，就把基线里缺的条目抄进你的文件（也可以不管，效果一样）。');
    }
    L.push('');
    L.push('### 3. 重启 Codex 并验证');
    L.push('');
    L.push('1. 重启 Codex（或重载 `claude_orchestrator` MCP）——新增的 MCP 工具只有重启后才被发现。');
    L.push('2. 在 Codex 里调用 **`claude_code_health`**（无参数，只读）。');
    L.push('3. 期望看到：`diagnostic = healthy/current`、`reloadRequired = false`、');
    L.push('   `loaded.buildFingerprint == disk.buildFingerprint`，且 tools 列表里包含 `watch`。');
    L.push('');
    L.push('```');
    L.push('# 备查：构建产物与入口');
    L.push(`node   : ${probes.node.execPath}`);
    L.push(`entry  : ${probes.build.entry}${probes.build.hasIndex ? '' : '   <-- 尚未构建，先 npm run build'}`);
    L.push(`claude : ${probes.claude.file || '(未探测到)'}`);
    L.push(`codex  : ${probes.codex.file || '(未探测到)'}`);
    if (cfg.useDsh) L.push(`dsh    : ${probes.dsh.file || '(未探测到)'}`);
    L.push('```');
  }

  L.push('');
  L.push('## 四、环境变量契约（写进 `[mcp_servers.claude_orchestrator.env]` 的键）');
  L.push('');
  L.push('| 变量 | 留空/未设置时的行为 |');
  L.push('|---|---|');
  L.push('| `ORCHESTRATOR_ANTHROPIC_BASE_URL` | 不注入端点，claude CLI 用你自己的官方登录态 |');
  L.push('| `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN` | 不注入 token（**含凭据，勿外传**） |');
  L.push('| `ORCHESTRATOR_MODEL_HAIKU` / `_SONNET` / `_OPUS` | 不注入，Claude CLI 用默认模型 |');
  L.push('| `ORCHESTRATOR_WHITELIST_PATH` | 按默认位置读 `~/.claude/worker-whitelist.json` |');
  L.push('| `ORCHESTRATOR_READ_GUARD_HOOK` | 设为 `off` 可禁用 read-guard hook |');
  L.push('| `ORCHESTRATOR_RUNTIME` | 运行时目录（jobs/logs/reports/registry） |');
  L.push('| `DEEPSEEK_HARNESS_ROOT` / `DEEPSEEK_HARNESS_RUNNER` | 未启用档 3 时不写入 |');
  L.push('| `CLAUDE_CLI_NAME` | claude 可执行文件绝对路径。**只接受 Node 能直接 spawn 的形态**（`.exe` 或原生可执行文件）：npm 全局安装的 `claude.cmd` / `claude.ps1` / 无扩展名垫片在 `shell:false` 下会报 `EINVAL`（Node ≥ 20.12），所以本脚本会自动解析垫片指向的 `bin/claude.exe`，或退成 `node + cli.js` 形态 |');
  L.push('| `CLAUDE_CLI_PREFIX` | 只在上面那种「垫片只有 js 入口」时才写入：值为 node 可执行文件，worker 实际以 `node <CLAUDE_CLI_NAME>` 启动 |');
  L.push('');
  L.push('**只写有值的变量**：写空串会覆盖 CLI 自己的默认值，等于顶掉用户的官方登录态。');
  L.push('');
  L.push('## 五、安全须知');
  L.push('');
  L.push('- 脚本全程只读探测，**没有修改你任何现有文件**；所有产物都在本目录。');
  L.push('- 探测凭据时只报告「存在/不存在」，从不读取内容；终端输出里不会出现任何 token。');
  L.push('- 本文件（README）不写任何 token：即使你填过，也会被替换成 `<已隐去>`。');
  L.push('- `generated/` 已加 `.gitignore`（内容为 `*`）—— 因为 `codex-config.snippet.toml` 可能含你输入的 token。');
  L.push('- `generated/` 下的产物一律以 `0600`（仅当前用户可读写）落盘；Windows 上该权限位无实际意义，但也不会造成副作用。');
  L.push('- `tool_timeout_sec = 14400` 不能改小：`claude_code_watch` 最长挂起 4 小时，配小会被宿主提前掐断。');
  L.push('');
  L.push('## 六、三条安装档位（速查）');
  L.push('');
  L.push('| 档位 | 需要什么 | 外部依赖 |');
  L.push('|---|---|---|');
  L.push('| 档 1 仅 Luna | 只要 Codex 自身的 `~/.codex/agents/luna_worker.toml` + `config.toml [agents]` | **零**，不需要本调度器，新手推荐 |');
  L.push('| 档 2 + Claude Code | 本调度器 + `claude` CLI（可选第三方端点） | Anthropic 兼容端点可选 |');
  L.push('| 档 3 + deepseek-harness | 档 2 再加 npm 包 `@deepseek-ai/dsh` | 本地 headless harness |');
  L.push('');
  return L.join('\n');
}

function writeGenerated(cfg, probes) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const written = [];
  // 相对路径统一用正斜杠：更贴近 README / 文档里书写的 `generated/xxx`，
  // 也让 Windows 生成的说明文档在 mac/Linux 上读起来一致。
  const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

  // 落盘权限（F4）：本目录里的文件含用户凭据（codex-config.snippet.toml 里的
  // ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN）。默认 umask 022 会写成 0644，同一台
  // 多用户机器上的其他账号可直接读走。统一 0o600（owner-only）：创建时给
  // mode，已存在的旧文件再 chmod 一次（重复运行 init 时顺带修好旧权限）。
  // Windows 上 mode/chmod 除只读位外无意义，写入 0o600 无害。
  const chmodOwnerOnly = (p) => {
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* best effort: 权限不是本脚本的成败判据 */
    }
  };
  const writeOwnerOnly = (p, content) => {
    fs.writeFileSync(p, content, { encoding: 'utf8', mode: 0o600 });
    chmodOwnerOnly(p);
  };

  const tomlPath = path.join(GENERATED_DIR, 'codex-config.snippet.toml');
  writeOwnerOnly(tomlPath, buildTomlSnippet(cfg, probes));
  written.push({ path: tomlPath, rel: rel(tomlPath), desc: '可整体追加到 ~/.codex/config.toml 的 MCP 片段（含 enabled = true 与 14400s 工具超时）' });

  const wlPath = path.join(GENERATED_DIR, 'worker-whitelist.json');
  const whitelist = buildWhitelist();
  writeOwnerOnly(wlPath, `${JSON.stringify(whitelist, null, 2)}\n`);
  written.push({ path: wlPath, rel: rel(wlPath), desc: `worker 权限白名单（allow ${whitelist.permissions.allow.length} 条 / deny ${whitelist.permissions.deny.length} 条，通用项，无私有服务名）` });

  const giPath = path.join(GENERATED_DIR, '.gitignore');
  writeOwnerOnly(giPath, '*\n');
  written.push({ path: giPath, rel: rel(giPath), desc: '忽略本目录全部内容（片段可能含凭据）' });

  const readmePath = path.join(GENERATED_DIR, 'README-下一步.md');
  const readme = buildReadme(cfg, probes, written.filter((w) => !w.rel.endsWith('.gitignore')));
  writeOwnerOnly(readmePath, readme);
  written.push({ path: readmePath, rel: rel(readmePath), desc: '探测结果 + 后续 3 步 + 验证命令' });

  return written;
}

// -----------------------------------------------------------------------------
// §5 主流程
// -----------------------------------------------------------------------------

function printHelp() {
  out(`${C.bold('tools/init.mjs')} — codex-job-orchestrator 环境探测 + 配置生成器`);
  out('');
  out('用法：');
  out('  node tools/init.mjs           交互式（无 TTY 时全部取默认值，不会卡住）');
  out('  node tools/init.mjs --yes     非交互，全部默认');
  out('  node tools/init.mjs --json    结束后额外把探测摘要以 JSON 打到 stdout');
  out('  node tools/init.mjs --help    显示本帮助');
  out('');
  out(`环境变量：${C.bold('DSH_INIT_FORCE_TTY=1')} 强制走进交互问卷（stdin 结束即取默认，不会卡住）。`);
  out('安全：只读探测，不修改任何现有配置；产物全部写入 ./generated/。');
  out('');
}

async function main() {
  if (SHOW_HELP) {
    printHelp();
    return;
  }

  out('');
  out(C.bold(C.green('codex-job-orchestrator · 环境探测与配置生成器')));
  out(C.gray(`仓库根目录：${REPO_ROOT}`));

  const probes = runProbes();

  if (!probes.node.nodeOk) {
    fatal(`Node 版本过低：当前 ${probes.node.nodeVersion}，需要 >= ${MIN_NODE_MAJOR}。`, '升级 Node 后重跑：https://nodejs.org/');
    return;
  }

  const cfg = await askConfig(probes);
  const written = writeGenerated(cfg, probes);

  step('④ 生成产物（全部在 ./generated/，未写入你的 home 目录）');
  for (const f of written) probe(f.rel, 'ok', f.desc);
  if (cfg.authToken) {
    out('');
    out(C.yellow(`  ⚠️  ${display(path.join(GENERATED_DIR, 'codex-config.snippet.toml'))} 含你输入的凭据，切勿提交到版本库或贴到公开渠道。`));
  }

  // —— 结尾：下一步做什么 ——
  step('⑤ 下一步做什么');
  const steps = [];
  if (cfg.tier === 1) {
    steps.push('档 1（仅 Luna）不需要本调度器：打开 generated/README-下一步.md，按里面 3 步确认 Codex 自身的 Luna 配置即可。');
    steps.push('想用 Claude Code worker：装好 claude CLI 后重跑 node tools/init.mjs，选档 2。');
  } else {
    const bak = process.platform === 'win32' ? 'copy "%USERPROFILE%\\.codex\\config.toml" "%USERPROFILE%\\.codex\\config.toml.bak"' : 'cp ~/.codex/config.toml ~/.codex/config.toml.bak';
    steps.push(`备份 Codex 配置：${bak}`);
    if (!probes.build.hasIndex) steps.push('构建本调度器：npm install && npm run build（当前 dist/ 还没生成）');
    steps.push('把 generated/codex-config.snippet.toml 的全部内容追加到 ~/.codex/config.toml（已有同名段就替换，确保 enabled = true）。');
    if (probes.codexCfg.serverDisabled) steps.push(`🔴 重点：你当前的 [mcp_servers.${MCP_SERVER_KEY}] 是 enabled = false —— 这正是「工具不存在」的原因，必须改成 true。`);
    if (!cfg.whitelistPath) {
      const target = probes.claudeSide.whitelistPath || '~/.claude/worker-whitelist.json';
      steps.push(`把 generated/worker-whitelist.json 拷到 ${display(target)}（缺它时 worker 退回内置基线策略，你在文件里写的策略不会生效；内置基线会与文件里的 deny 取并集）。`);
    } else {
      steps.push(`把 generated/worker-whitelist.json 放到 ${cfg.whitelistPath}。`);
    }
    steps.push('重启 Codex（或重载 claude_orchestrator MCP）—— 新工具只有重启后才被发现。');
    steps.push('在 Codex 里调用 claude_code_health 验证：期望 diagnostic = healthy/current、reloadRequired = false、tools 含 watch。');
  }
  steps.push('完整说明见 generated/README-下一步.md。');
  steps.forEach((s, i) => out(`  ${C.bold(`${i + 1}.`)} ${s}`));

  hr();
  if (cfg.tier === 1) {
    out(`${OK} 完成。档 1 不需要本调度器，未必要合并任何 MCP 配置。`);
  } else {
    out(`${OK} 完成。合并配置 + 重启 Codex 后，用 ${C.bold('claude_code_health')} 做第一次验证。`);
  }

  if (JSON_OUT) {
    out('');
    out(JSON.stringify({ probeLog, config: { ...cfg, authToken: cfg.authToken ? '<redacted>' : '' }, outputs: written.map((w) => w.rel), repoRoot: REPO_ROOT }, null, 2));
  }
}

main().catch((err) => {
  fatal(`初始化脚本异常退出：${err && err.message ? err.message : String(err)}`, '这是脚本自身的 bug；请带上完整输出提 issue（注意先检查输出里没有你的 token）。');
});
