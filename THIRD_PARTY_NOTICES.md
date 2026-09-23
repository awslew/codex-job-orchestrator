# 第三方组件与许可声明 / Third-Party Notices

本文件说明 `codex-job-orchestrator`（仓库名与 npm 包名同名）所涉及的所有第三方组件：
哪些随本仓库分发、各自是什么许可、以及你在再分发本仓库时需要履行的义务。

- 本仓库**自身代码**以 **MIT** 许可发布，全文见根目录 [`LICENSE`](./LICENSE)。
- 本文件覆盖两类东西：① 随本仓库安装的第三方 npm 组件；② 虽然**不在本仓库分发**、
  但属于运行前置条件的**外部程序**（单列在第三节，这一节最容易被误解，请务必读完）。

> **生成方式与边界**：依赖清单**以本仓库 `package.json` 的直接依赖声明为准人工整理**，
> 版本号取自其中的精确值/范围约束。**没有对 `node_modules` 做传递依赖闭包的全量机器扫描**，
> 因此本文件**不是完整 SBOM**。若你需要合规级清单，请自行在安装后运行
> `npm ls --all --json` 或 `npx license-checker --production`，并以其输出为准。

---

## 一、运行时依赖（随本仓库一起被安装、并在运行时加载）

| 包名 | 版本约束 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.30.0` | MIT | MCP 协议的服务端实现：stdio 传输、工具注册与入参 schema、请求/响应编解码。调度器对外暴露的 MCP 入口全靠它。 |
| `zod` | `3.25.4` | MIT | 工具入参的运行时校验与 TypeScript 类型推导（MCP SDK 自身也依赖它）。 |

两者都是宽松许可：随本仓库分发时只需保留其版权声明与许可全文，没有 copyleft 传染性，
也不要求公开你的修改。

## 二、开发依赖（仅本机开发/构建时需要，运行时**不加载**）

| 包名 | 版本约束 | 许可 | 用途 |
| --- | --- | --- | --- |
| `typescript` | `~5.9.3` | **Apache-2.0** | 把 `src/`、`test/` 编译到 `dist/`、`dist-test/`（`tsc -p tsconfig*.json`）。 |
| `@types/node` | `^24.0.0` | MIT | Node 标准库（`node:fs`、`node:child_process`、`node:test` 等）的类型声明，编译期用完即弃。 |

这两项都写在 `devDependencies` 里：不会被运行时代码 `import`，也不会随 `npm publish` 安装到使用者机器上。
其中 `typescript` 是本仓库唯一的 Apache-2.0 组件，相关义务见第五节。

## 三、外部程序前置条件（**不在本仓库分发**）

本项目是一个**调度器**：它自己不含任何模型、也不含任何 worker 运行时，而是在运行时通过
`child_process` 唤起外部 CLI 来完成实际工作。因此下面这些程序是**使用前置条件**，不是本仓库的依赖：

| 外部程序 | 分发方 | 许可状态 | 本项目如何处理 |
| --- | --- | --- | --- |
| **Claude Code CLI**（npm `@anthropic-ai/claude-code`） | Anthropic | **专有软件（proprietary）**：其 package 的 `license` 字段为 `SEE LICENSE IN README.md`，适用商业使用条款，**不是**开源许可 | **本仓库不分发、不镜像、不内嵌其二进制或源码**，也不对其做任何形式的再分发或再许可。请自行通过官方渠道安装并接受其条款。 |
| **Codex CLI**（npm `@openai/codex`） | OpenAI | Apache-2.0 | 本仓库同样**不分发**其二进制，要求用户自行安装。Apache-2.0 本身允许再分发，但把 CLI 打进仓库只会带来版本漂移和体积问题，故明确不做。 |
| **DeepSeek Harness**（npm `@deepseek-ai/dsh`） | DeepSeek 官方 | MIT | 见第四节。 |

**关于 Claude Code CLI 的特别声明**：`@anthropic-ai/claude-code` 是**专有软件**，
其许可条款与本仓库的 MIT 许可**没有任何关系**，本仓库的 MIT 许可**不覆盖也不改变**它。
当你用本项目拉起 Claude Code worker 时，你是在本机上调用**你自己合法安装的那一份**程序，
其许可、配额与商业条款由你与 Anthropic 之间的约定决定。本仓库不包含、不缓存、不转发该程序的
任何二进制、源码或凭据。

安装示例（仅作参考，实际请以各官方文档为准）：

```bash
npm install -g @anthropic-ai/claude-code   # 专有软件，安装前请先阅读并接受其条款
npm install -g @openai/codex               # Apache-2.0
```

## 四、DeepSeek Harness（第三方官方开源项目，本仓库仅通过进程调用依赖）

- 项目名：**DeepSeek Harness**（deepseek-harness）
- 源码仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 发布包：npm `@deepseek-ai/dsh`
- 许可：**MIT**，版权归 **© 2026 DeepSeek** 及其贡献者所有

本项目把 deepseek-harness 作为三类 worker 后端之一：调度器在运行时以**子进程**方式调用它提供的
runner（通过 `DEEPSEEK_HARNESS_ROOT` / `DEEPSEEK_HARNESS_RUNNER` 指向本机安装位置），
双方只通过命令行参数与标准输入输出交互。

**本仓库不复制、不内嵌、不改写 deepseek-harness 的任何源码或资源**，也没有把它写进 `package.json`
作为依赖。因此：它的版权与许可声明应随其自身安装保留；本仓库的 MIT 许可不覆盖它的代码，
它的 MIT 许可也不覆盖本仓库的代码。要使用该后端请自行安装：

```bash
npm install -g @deepseek-ai/dsh
```

## 五、再分发本仓库时：Apache-2.0 依赖（`typescript`，仅 dev）的 NOTICE 义务怎么处理

本仓库自身是 MIT，**直接运行期依赖只有两个、且都是 MIT**，所以最常见的再分发场景（fork、
重新发一版、镜像到内网）**不产生 copyleft 义务**。唯一需要判断的是开发依赖里的 Apache-2.0 组件
`typescript`：

- **默认结论（只再分发本仓库的源码或构建产物）**：`typescript` 位于 `devDependencies`，
  只在 `npm run build` / `npm test` 时被本机执行，**不会被打进产物**，也不会随 `npm publish`
  装到使用者机器上。因此**不触发** Apache-2.0 第 4(d) 条关于 NOTICE 的传递义务，
  你无需为此额外附带 Apache 许可全文（本仓库根目录的 MIT `LICENSE` 保持原样即可）。
- **需要你自己补齐义务的情形**：
  1. 你把 `typescript` **本身**（它的代码、产物或 tarball）一起分发出去——例如把编译器内嵌进
     自己的 CLI、把它塞进离线安装包、或 vendor 进仓库。此时你分发的是 Apache-2.0 软件，必须
     随附 Apache-2.0 许可全文，并保留上游 `NOTICE` 文件内容（若上游提供）。
  2. 你**修改了 `typescript` 自身源码**后再分发——除许可全文与 NOTICE 外，还需按第 4(b) 条
     显著标注你做过修改。
  3. 你把 `node_modules/` 整目录提交或打包——这等于把所有 MIT 与 Apache-2.0 组件一并分发，
     请自行补齐相应许可文件。（正常流程不会发生：本仓库 `.gitignore` 默认排除 `node_modules/`。）
- **MIT 侧**（`@modelcontextprotocol/sdk`、`zod`、`@types/node`）只要求「保留版权声明与许可全文」：
  保留本仓库的 `LICENSE`，并在分发 `node_modules` 时保留各包自带的 `LICENSE` 即可。

## 六、署名与维护说明

- 本仓库作者 / 许可方：**awslew**（GitHub），即 `LICENSE` 中所声明的 MIT 版权持有者。
- 本文件为**人工整理**：依赖清单以 `package.json` 的声明为准，**传递依赖闭包未做全量机器扫描**；
  表中版本号为 `package.json` 里的精确值或范围约束，最终实际安装版本以锁文件为准。
- 后续新增依赖时请同步更新第一节表格；若引入 Apache-2.0 / BSD / MPL / GPL 等组件，
  请补充对应小节并说明再分发义务。

---

## English Declaration

The statement below summarizes the licensing situation of this repository for non-Chinese readers.
The Chinese sections above are normative; this English section is a faithful summary.

- **This repository's own code** is licensed under the **MIT License**
  (see `LICENSE`, `Copyright (c) 2026 awslew`).
- **Runtime dependencies** (installed and loaded at runtime; both MIT):
  `@modelcontextprotocol/sdk@1.30.0`, `zod@3.25.4`.
- **Development dependencies** (build/test only, never loaded at runtime, not shipped):
  `typescript@~5.9.3` (**Apache-2.0**), `@types/node@^24.0.0` (MIT).
- **External program prerequisites — NOT distributed by this repository.**
  This project is only an orchestrator; it spawns external CLIs via `child_process` and ships none of them.
  - **Claude Code CLI** (`@anthropic-ai/claude-code`) is **proprietary software**. Its package
    declares `SEE LICENSE IN README.md` and is governed by commercial terms. This repository does
    **not** distribute, mirror, bundle, embed, or relicense it in any form. You must install it
    yourself from the official channel and accept its terms. The MIT license of this repository does
    not cover, modify, or grant any rights to that program.
  - **Codex CLI** (`@openai/codex`, Apache-2.0) is likewise **not** redistributed here; install it yourself.
  - **DeepSeek Harness** (`@deepseek-ai/dsh`) is a third-party official open-source project
    (<https://github.com/deepseek-ai/deepseek-harness>, MIT, Copyright (c) 2026 DeepSeek and
    contributors). This repository **depends on it through process invocation only** — no source code
    of that project is copied, embedded, or vendored here.
- **Redistribution note.** `typescript` is the only Apache-2.0 component and it is a **development
  dependency** that is never bundled into or shipped with this project. Therefore redistributing this
  repository's source or build output does **not** trigger the Apache-2.0 section 4(d) NOTICE
  propagation obligation. If you redistribute `typescript` itself (or a bundled `node_modules/`), you
  must include the Apache-2.0 license text and preserve any upstream `NOTICE` file; if you modify its
  source, you must also state that you changed the files (section 4(b)).
- **Scope of this document.** This list was compiled by hand from the direct dependency declarations
  in `package.json`; **the full transitive dependency closure has not been machine-scanned**, so this
  document is not a complete SBOM. Verify with `npm ls --all` or `npx license-checker --production`
  if you need a compliance-grade inventory.
