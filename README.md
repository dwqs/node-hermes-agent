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
1. `s01-agent-loop.mjs`: 实现 Agent 多轮对话
2. `s02-tool-system.mjs`: 实现 Agent 的工具系统
3. `s03-session-store.mjs`: 实现持久话存储和全文搜索
4. `s04-prompt-builder.mjs`: 实现system prompt 从多个来源分层组装，组装一次缓存复用
