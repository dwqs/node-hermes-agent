# node-hermes-agent
基于[Learn Hermes Agent](https://github.com/longyunfeigu/learn-hermes-agent)的 node 版本实现

## 本地运行
```
git clone git@github.com:dwqs/node-hermes-agent.git

cd node-hermes-agent

pnpm i
```

在根目录下创建 `.env` 文件：

```
OPEN_AI_API_KEY=your api key
MODEL_BASE_URL=base url
AI_MODEL_NAME=model name
MAX_ITERATIONS=30
DB_PATH=state.db
HERMES_HOME=./.hermes
```

### 脚本功能
1. `s01-agent-loop`: 实现 Agent 多轮对话
2. `s02-tool-system`: 实现 Agent 的工具系统
3. `s03-session-store.mjs`: 实现持久话存储和全文搜索
4. `s04-prompt-builder`: 实现system prompt 从多个来源分层组装，组装一次缓存复用