import { skillManage } from './skill-system.mjs'

class SkillReview {
  constructor() {
    this._reviewsTriggered = 0
    this._skillsCreated = []
  }

  review(messagesSnapshot, prompt) {
    this._reviewsTriggered += 1

    const toolCalls = []
    let hasErrors = false
    let hasRetries = false

    for(const msg of messagesSnapshot) {
      const role = msg.role || msg.type
      if(role === 'ai' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push(tc.name)
        }
      }

      if(role === 'tool') {
        const content = msg.content || ''
        if (content.toLowerCase().includes('error') || content.toLowerCase().includes('failed')) {
          hasErrors = true
        }
        if (content.toLowerCase().includes('retry') || content.toLowerCase().includes('try again')) {
          hasRetries = true
        }
      }
    }

    const uniqueTools = [...new Set(toolCalls)]
    const isNontrivial = (hasErrors || hasRetries) && uniqueTools.length >= 3

    if (!isNontrivial) {
      return { action: 'skip', reason: 'Nothing to save.' }
    }

    // 根据使用的工具生成技能名称
    const skillName = `workflow-${uniqueTools.slice(0, 3).sort().join('-')}`
    const skillContent = this._generateSkillContent(messagesSnapshot, toolCalls, skillName)

    const result = skillManage({
      action: 'create',
      name: skillName,
      description: `Workflow pattern using ${uniqueTools.slice(0, 3).sort().join(', ')}`,
      body: skillContent,
    })
    this._skillsCreated.push(skillName)
    return {
      action: 'created',
      skill_name: skillName,
      result: result,
    }
  }

  _generateSkillContent(messagesSnapshot, toolCalls, skillName) {
    const unique = [...new Map(toolCalls.map(t => [t, t])).values()] // 有序去重
    const lines = [`# ${skillName}`, '', '## Steps', '']
    for (let i = 0; i < unique.length; i++) {
      lines.push(`${i + 1}. Use \`${unique[i]}\` tool`)
    }

    lines.push('', '## Pitfalls', '')

    for (const msg of messagesSnapshot) {
      const role = msg.role || msg.type
      if (role === 'tool') {
        const content = msg.content || ''
        if (content.toLowerCase().includes('error')) {
          // 提取错误的第一行
          const firstLine = content.split('\n')[0].slice(0, 100)
          lines.push(`- Watch out: ${firstLine}`)
        }
      }
    }
    return lines.join('\n')
  }
}

export const skillReview = new SkillReview()