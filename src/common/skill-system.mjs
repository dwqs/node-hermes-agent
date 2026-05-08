import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { SKILL_DIR } from './model.mjs'

/**
 * 解析 SKILL.md 前置元数据（--- 分隔的 key: value）和正文
 * 格式参考 Hugo/Jekyll：文件开头 "---" 包含一段 YAML-ish key:value；再 "---" 之后是正文
 * @param {string} text - 要解析的文本
 * @returns {[Object, string]} 元数据对象和正文
 */
export function parseSkillFormatter(text) {
  if (!text.startsWith('---')) {
    return [{}, text]
  }

  const parts = text.split('---')
  if (parts.length < 3) {
    return [{}, text]
  }

  const metadata = {}
  const frontmatterLines = parts[1].trim().split('\n')
  for (const line of frontmatterLines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      metadata[key] = value
    }
  }
  return [metadata, parts[2].trim()]
}

export function loadSkill(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

}

export function discoverSkills() {
  // 只读 frontmatter，不读 body —— body 通过 tool 调用
  const skills = []
  if(!existsSync(SKILL_DIR)) {
    return skills
  }

  const entries = readdirSync(SKILL_DIR, { withFileTypes: true })
  const skillDirs = entries
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  
  for (const dir of skillDirs) {
    const skillFile = path.join(SKILL_DIR, dir.name, 'SKILL.md')
    
    if (!existsSync(skillFile)) {
      continue
    }
    const content = readFileSync(skillFile, 'utf-8')
    const [metadata, _] = parseSkillFormatter(content)
    
    skills.push({
      name: metadata.name || dir.name,
      description: metadata.description || '(no description)',
      path: skillFile,
    })
  }
  return skills
}

export function skillView(name) {
  const skillFile = path.join(SKILL_DIR, name, 'SKILL.md')
  if(!existsSync(skillFile)) {
    return `技能 ${name} 不存在`
  }
  const content = readFileSync(skillFile, 'utf-8')
  const [metadata, body] = parseSkillFormatter(content)
  return `=== ${metadata.name}\n(${metadata.description}) ===\n\n${body}`
}

/**
 * 管理技能：创建 / 编辑 / 删除
 * @param {Object} args - 参数对象
 * @param {string} args.action - 操作类型：create/edit/delete
 * @param {string} args.name - 技能名称
 * @param {string} args.description - 技能描述
 * @param {string} args.body - 技能正文
 * @returns {string} 操作结果消息
 */
export function skillManage(args) {
  const action = args.action || ''
  const name = args.name || ''
  const description = args.description || ''
  const body = args.body || ''

  if (!name) {
    return '（错误：需要提供 name）'
  }

  const skillDir = path.join(SKILL_DIR, name)
  const skillFile = path.join(skillDir, 'SKILL.md')

  if(action === 'create') {
    if(existsSync(skillFile)) {
      return `（错误：技能 ${name} 已存在）`
    }
    mkdirSync(skillDir, { recursive: true })
    const content = loadSkill(
      name,
      description || '（无描述）',
      body || ''
    )
    writeFileSync(skillFile, content, 'utf-8')
    return `已创建技能 '${name}' 于 ${skillFile}`
  }

  // edit 和 delete 需要文件存在
  if(!existsSync(skillFile)) {
    return `（错误：技能 ${name} 不存在）`
  }
  
  if(action === 'edit') {
    const fileContent = readFileSync(skillFile, 'utf-8')
    const [metadata, oldBody] = parseSkillFormatter(fileContent)
    const newDescription = description || metadata.description || ''
    const newBody = body || oldBody

    const newContent = loadSkill(
      name,
      newDescription,
      newBody
    )
    writeFileSync(skillFile, newContent, 'utf-8')
    return `技能 ${name} 已更新`
  }
  
  if(action === 'delete') {
    rmSync(skillFile)
    return `技能 ${name} 删除成功`
  }

  return `（错误：未知操作 '${action}'。请使用 create/edit/delete）`
}
