import chalk from 'chalk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { registerMcpServer } from './mcp-simulated.mjs'

async function createMCPClient(name, serverConfig) {
  let transport

  // sse 已经废弃
  if(serverConfig.url) {
    const url = new URL(serverConfig.url)
    transport = new StreamableHTTPClientTransport(url)
  } else if (serverConfig.command) {
    transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...(serverConfig.env || {}) },
    })
  } else {
    throw new Error(`MCP server "${name}": need either "url" or "command"`)
  }

  const client = new Client({ name: `hermes-${name}`, version: '1.0.0' })
  await client.connect(transport)

  console.log(chalk.green(`✅ 连接到 MCP 服务器: ${name}(sessionId: ${transport.sessionId})`))
  return { name, client, transport }
}

export async function initMcpServers(config = {}) {
  const serverConfigs = config.mcpServers || {}
  for (const [name, serverConfig] of Object.entries(serverConfigs)) {
    const { client } = await createMCPClient(name, serverConfig)

    // 包装成统一接口，复用 registerMcpServer
    const wrapper = {
      name,
      listTools: () => client.listTools().then(r => r.tools),
      callTool: (toolName, args) => client.callTool({ name: toolName, arguments: args }),
    }
    const registered = await registerMcpServer(wrapper, { tools: serverConfig.tools })
    console.log(chalk.yellow(`✅ MCP "${name}" registered:`), registered.join(', '))
  }
}