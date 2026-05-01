import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import readline from 'node:readline/promises'
import chalk from 'chalk'

import { PERMISSION_ALLOWLIST, DANGEROUS_PATTERNS, compiledPatterns, sessionApproved } from './model.mjs'

/**
 * 加载永久白名单（存储模式字符串）
 * @returns {Set<string>} 白名单模式集合
 */
function loadAllowlist() {
  if(!existsSync(PERMISSION_ALLOWLIST)) {
    return new Set()
  }
  try {
    const content = readFileSync(PERMISSION_ALLOWLIST, 'utf-8')
    const patterns = JSON.parse(content)
    return new Set(patterns)
  } catch (err) {
    return new Set()
  }
}

/**
 * 保存永久白名单到磁盘
 * @param {Set<string>} allowlist - 白名单模式集合
 */
function saveAllowlist(allowlist) {
  // 确保目录存在
  if (!existsSync(process.env.HERMES_HOME)) {
    mkdirSync(process.env.HERMES_HOME, { recursive: true })
  }
  const sorted = Array.from(allowlist).sort()
  writeFileSync(PERMISSION_ALLOWLIST, JSON.stringify(sorted), 'utf-8')
}

/**
 * 检测命令是否匹配危险模式
 * @param {string} command - 要检测的命令
 * @returns {[number, string, string][]} 匹配项列表，每项为 [patternIndex, patternStr, description]
 */
export function detectDangerousCommand(command) {
  const matches = []
  for (let index = 0; index < compiledPatterns.length; index++) {
    const { pattern, description } = compiledPatterns[index]
    if (pattern.test(command)) {
      matches.push([
        index,
        DANGEROUS_PATTERNS[index].pattern.toString(),
        description
      ])
    }
  }
  return matches
}

async function askUser(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: null  // 阻止自动回显输入
  })
  // 手动显示提示文字
  process.stdout.write(prompt)
  const answer = await rl.question('')
  return answer.trim().toLowerCase()
}

// 提示用户批准危险命令
export async function approveDangerousCommand(command, matches) {
  const allowlist = loadAllowlist()
  
  // 先用两层缓存过滤：session 内已批准的 + 永久 allowlist 里的，都直接放行
  const unapproved = []
  for (const [index, patternStr, description] of matches) {
    if (sessionApproved.has(index) || allowlist.has(patternStr)) {
      continue
    }
    unapproved.push([index, patternStr, description])
  }
  if (unapproved.length === 0) {
    return true
  }

  // 危险命令询问用户
  console.log(chalk.red(`\n  *** 检测到危险命令 *** 命令：${command} \n`))
  for (const [, , description] of unapproved) {
    console.log(chalk.red(`  - 风险: ${description}`))
  }

  console.log('  选项: [o]nce 一次 / [s]ession 本次 / [a]lways 永久 / [d]eny 拒绝')
  const choice = await askUser('  批准? ')

  // once: 只放行这一次，不写任何缓存
  if (choice === 'o' || choice === 'once') {
    return true
  }
  // session: 记进内存集合，本次进程内同模式直接放行
  if (choice === 's' || choice === 'session') {
    for (const [index] of unapproved) {
      sessionApproved.add(index)
    }
    return true
  }
  // always: 写入 allowlist.json 持久化，同时也进 session 缓存
  if (choice === 'a' || choice === 'always') {
    for (const [, patternStr] of unapproved) {
      allowlist.add(patternStr)
    }
    saveAllowlist(allowlist)
    for (const [index] of unapproved) {
      sessionApproved.add(index)
    }
    return true
  }
  // 其它输入一律视作拒绝（保守原则）
  return false
}