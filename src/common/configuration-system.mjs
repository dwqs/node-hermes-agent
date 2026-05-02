import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const DEFAULT_CONFIG = {
  model: '',
  baseUrl: '',
  apiKey: "",
  fallback: {
    model: '',
    baseUrl: '',
    apiKey: "",
  },
  limits: {
    maxIterations: 30,
    maxChildIterations: 15,
    maxRetries: 3,
    maxContinuations: 3,
  },
  compression: {
    threshold: 50000,
    protectFirst: 3,
    keepRecentToolResults: 3,
    tailTokenBudget: 20000,
  },
  memory: {
    memoryCharLimit: 2200,
    userCharLimit: 1375,
  },
  dbPath: 'state.db',
}

let config = null

function deepMerge(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ) {
      result[key] = deepMerge(result[key], value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * 递归解析配置值中的 ${VAR} 环境变量引用
 * 允许在配置中写 apiKey: ${OPENAI_API_KEY}，避免把 secrets 提交进配置
 */
function expandEnvVars(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (match, varName) => {
      return process.env[varName] ?? match
    })
  }

  if (Array.isArray(value)) {
    return value.map(item => expandEnvVars(item))
  }

  if (typeof value === 'object' && value !== null) {
    const result = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = expandEnvVars(val)
    }
    return result
  }

  return value
}

// 读取 .env 文件并设置为环境变量
export function loadEnv(envPath) {
  if (!envPath) {
    envPath = path.join(process.env.HERMES_HOME || '', '.env')
  }
  if (!existsSync(envPath)) {
    return
  }
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) {
      continue
    }
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    // 去除首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // 真实环境变量优先，.env 只做缺省值
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

export function loadYamlConfig(configPath) {
  if(config) {
    return config
  }

  if (!configPath) {
    configPath = path.join(process.env.HERMES_HOME || '', 'config.yaml')
  }
  // 文件不存在直接返回默认值（仍要跑 env 展开，默认值里可能也用了 ${VAR}）
  if (!existsSync(configPath)) {
    return expandEnvVars({ ...DEFAULT_CONFIG })
  }
  let userConfig = {}
  try {
    const rawText = readFileSync(configPath, 'utf-8')
    userConfig = yaml.load(rawText) || {}
  } catch (err) {
    // YAML 解析异常就退回默认值；不让坏配置阻塞启动
    userConfig = {}
  }
  const merged = deepMerge(DEFAULT_CONFIG, userConfig)
  config = expandEnvVars(merged)
  return config
}

// 保存配置到 config.yaml，设置 0600 文件权限
export function saveYamlConfig(configPath, config) {
  if (!configPath) {
    configPath = path.join(process.env.HERMES_HOME || '', 'config.yaml')
  }
  const dir = path.dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const text = yaml.dump(config, {
    flowLevel: -1,
    forceQuotes: false,
  })
  writeFileSync(configPath, text, 'utf-8')
  // 0600：配置里可能含 api_key，只允许本人读写
  chmodSync(configPath, 0o600)
}