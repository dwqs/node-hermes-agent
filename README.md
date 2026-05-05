# node-hermes-agent
基于[Learn Hermes Agent](https://github.com/longyunfeigu/learn-hermes-agent)的 node 版本实现

## 本地运行
```
git clone git@github.com:dwqs/node-hermes-agent.git

cd node-hermes-agent

pnpm i

cp .env.example .env
```

在 `.env` 文件配置 API Key 之后:

```
node src/s01-agent-loop.mjs
```

### 脚本功能
1. `s01-agent-loop`: 实现 Agent 多轮对话
2. `s02-tool-system`: 实现 Agent 的工具系统
3. `s03-session-store`: 实现持久话存储和全文搜索
4. `s04-prompt-builder`: 实现system prompt 从多个来源分层组装，组装一次缓存复用
5. `s05-context-compression`: 上下文压缩
6. `s06-error-recovery`: 错误恢复机制
7. `s07-memory-system`: 记忆管理
8. `s08-skill-system`: 技能管理
9. `s09-permission-system`: 模拟权限管理
10. `s10-subagent-delegation`: Sub Agent 实现
11. `s11-configuration-system`: 测试配置系统
12. `s12-gateway-architecture`: 网关架构实现
13. `s13-platform-adapters`: 模拟多平台适配
14. `s14-terminal-backends`: 终端执行环境抽象
15. `s15-scheduled-tasks`: 定时任务机制
