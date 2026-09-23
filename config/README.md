# config/ — worker 侧 MCP 配置

本目录只放 **worker 侧 MCP 配置**相关文件。调度器自己作为 MCP server 运行，
而它拉起的每个 worker（Claude Code CLI）可以用 `--mcp-config` 再挂载一组自己的 MCP server。
这个文件就是那组 server 的清单。

| 文件 | 是否入库 | 说明 |
| --- | --- | --- |
| `hermetic-mcp.example.json` | ✅ 入库 | **中性示例**，只示范结构，可直接复制改名后使用 |
| `hermetic-mcp.json` | ❌ 见 `.gitignore` | 使用者本机的真实配置，含私有 server 名与个人绝对路径，**永远不要提交** |

## 这句话很重要：不创建它，就不会注入 `--mcp-config`

`config/hermetic-mcp.json` 是**可选**文件。

- **没有这个文件**（默认状态）：调度器在拉起 worker 时**完全不注入** `--mcp-config`，
  worker 使用自己默认的 MCP 配置。这是最省心的默认行为。
- **有这个文件**：调度器会把它作为 `--mcp-config <路径>` 传给 worker，并配合
  `--strict-mcp-config`，使该 worker 只加载这份清单里的 server —— 也就是"密闭"语义：
  本机全局装的其他 MCP server 不会泄漏进 worker 会话。

## 想用的话怎么用

1. 复制示例并改名：

   ```bash
   cp config/hermetic-mcp.example.json config/hermetic-mcp.json
   ```

2. 打开 `config/hermetic-mcp.json`，把里的占位符换成你自己的服务器与路径：
   - `<ABSOLUTE_PATH_TO_ALLOWED_DIR>` → 你允许 worker 通过 filesystem server 访问的目录绝对路径
   - `your-http-server` → 换成你自己的 server 名；不需要就整个删掉
   - `<MCP_SERVER_URL>` / `<YOUR_TOKEN>` → 你自己的地址与凭据
3. 不用的示例条目直接删掉，只留你真的需要的 server。
4. `config/hermetic-mcp.json` 已被 `.gitignore` 排除，所以私有 server 名、个人路径和凭据都不会入库。

## 它由哪个环境变量指向

调度器按下面的顺序解析配置路径：

1. **环境变量 `ORCHESTRATOR_HERMETIC_MCP`**（优先级最高）：如果它被设置为一个**存在的**文件路径，
   就用那个文件。可以指向仓库外的任意位置，例如：

   ```toml
   [mcp_servers.claude_orchestrator.env]
   ORCHESTRATOR_HERMETIC_MCP = '<ABSOLUTE_PATH_TO_YOUR_MCP_CONFIG_JSON>'
   ```

2. 否则回退到默认位置 `config/hermetic-mcp.json`（相对本仓库根目录）。
3. 两者都不存在 → 报告为"无配置"，**跳过 `--mcp-config` 注入**，worker 用自身默认 MCP 配置。

## 关于示例里的两个条目

- `filesystem`：官方参考 server（`@modelcontextprotocol/server-filesystem`），
  用 `npx` 现拉现跑，最通用的 stdio 例子，用来展示 `command` + `args` 结构。
- `your-http-server`：占位条目，用来展示 `url` / `headers` 的写法（远端 MCP server）。
  它不是任何真实服务，请替换或删除。

两个条目都只写占位符，不含任何真实路径、服务名或凭据。各字段的确切 schema 以你所用的
Claude Code 版本官方文档为准。
