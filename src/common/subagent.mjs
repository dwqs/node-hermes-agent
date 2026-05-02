import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import chalk from 'chalk'

import { SUB_AGENT_BLOCKED_TOOLS, model, SUB_AGENT_MAX_ITERATIONS } from './model.mjs'

export function buildSubAgent(goal, context, toolDefinitions) {
  const tools = toolDefinitions.filter(tool => !SUB_AGENT_BLOCKED_TOOLS.includes(tool.name))
  const prompt = `
    You are a sub-agent.
    Complete the assigned task and report results.\n.
    Do NOT delegate further.
    Do NOT modify memory or skills.\n\n.
    # Task\n${goal}\n\n
    # Context\n${context}\n\n
  `
  return {
    tools,
    messages: [new SystemMessage(prompt), new HumanMessage(goal)],
  }
}

export async function runSubAgent(subAgentEnv) {
  const tools = subAgentEnv.tools
  const messages = [...subAgentEnv.messages]
  const modelWithTools = model.bindTools(tools)

  for (let i = 0; i < SUB_AGENT_MAX_ITERATIONS; i++) {
    const roundLabel = `第 ${i + 1} 轮`
    console.log(chalk.yellow(`子 Agent ⏳ ${roundLabel} - 正在等待 AI 思考...`));

    const response = await modelWithTools.invoke(messages)
    messages.push(response)

    if (!response.tool_calls || response.tool_calls.length === 0) {
      console.log(`\n子 Agent ✨ AI 回复:\n${response.content}\n`);
      return response.content || '子 Agent 返回空';
    }

    console.log(chalk.bgBlue(`子 Agent 🔍 工具调用: ${response.tool_calls.map(t => t.name).join(', ')}`))
    for (const toolCall of response.tool_calls) {
      console.log(chalk.green(`子 Agent 🔍 工具调用: ${toolCall.name} - 参数: ${JSON.stringify(toolCall.args)}`));
      const foundTool = tools.find(t => t.name === toolCall.name)
      if (!foundTool) {
        continue
      }

      // 阻止 sub agent 调用不该出现的工具
      if(SUB_AGENT_BLOCKED_TOOLS.includes(foundTool.name)) {
        console.log(chalk.red(`子 Agent 🔍 工具调用: ${toolCall.name} 被阻止`))
        messages.push(new ToolMessage({ content: `工具 ${toolCall.name} 在子 Agent 中不可用`, tool_call_id: toolCall.id }))
        continue
      }
      const toolResult = await foundTool.invoke(toolCall.args);
      messages.push(new ToolMessage({ content: toolResult, tool_call_id: toolCall.id }))
    }
  }

  console.log(chalk.red('⚠️  子 Agent 达到最大迭代次数'));
  return messages[messages.length - 1].content
}