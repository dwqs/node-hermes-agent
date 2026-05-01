import 'dotenv/config'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import { loadMemory, renderEntries } from './memory.mjs'
import { MEMORY_FILE, USER_FILE } from './model.mjs'
import { discoverSkills } from './skill-system.mjs'

const HERMES_HOME = path.resolve(
  process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
)

function loadSoul() {
  const soulPath = path.join(HERMES_HOME, 'SOUL.md')
  if(fs.existsSync(soulPath)) {
    const soul = fs.readFileSync(soulPath, 'utf-8')
    return soul.slice(0, 20000)
  }
  return "你是一个能执行终端命令/读写文件/网络搜索的 AI 助手"
}

function findProjectContext() {
  // 优先级：本项目专属 (.hermes.md/HERMES.md) > 通用 agent 规约 (AGENTS.md/CLAUDE.md/.cursorrules)
  // 只取第一个命中；不做合并以避免噪音和歧义

  const cwd = process.cwd()
  const priorityFiles = ['.hermes.md', 'HERMES.md']
  const fallbackFiles = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']

  for (const name of priorityFiles) {
    const filePath = path.join(cwd, name)
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').slice(0, 20000)
    }
  }

  for (const name of fallbackFiles) {
    const filePath = path.join(cwd, name)
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').slice(0, 20000)
    }
  }
  
  return ''
}

export function buildSystemPrompt() {
  const parts = [loadSoul()]
  const memory = loadMemory(MEMORY_FILE)
  memory && parts.push(`# Memory\n${renderEntries(memory)}`)

  const user = loadMemory(USER_FILE)
  user && parts.push(`# User Profile\n${renderEntries(user)}`)
  
  const project = findProjectContext()
  project && parts.push(`# Project Context\n${project}`)

  // skills
  const skills = discoverSkills()
  if (skills.length > 0) {
    const lines = skills.map(skill => `- **${skill.name}**: ${skill.description}`)
    parts.push(
      '# 可用技能\n' +
      '使用 skill_view 加载完整内容。\n' +
      lines.join('\n')
    )
  }

  // 危险命令
  parts.push(`# 危险命令\n在执行危险命令(rm -rf, DROP TABLE, etc.) 之前需要经过用户同意`)

  // 当前时间 + cwd 让模型知道"此刻在哪/何时"，避免它做过时假设
  const now = new Date()
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  
  parts.push(
    `Current time: ${timeStr}\n` +
    `Working directory: ${process.cwd()}`
  )
  return parts.join('\n\n')
}