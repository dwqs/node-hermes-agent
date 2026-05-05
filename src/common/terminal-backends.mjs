import { spawn, execSync } from 'node:child_process'
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const SECRET_BLOCKLIST = new Set([
  'OPEN_AI_API_KEY',
  'SERP_API_KEY',
  'apiKey',
])

/**
 * 终端后端基类
 * 子类需实现 _runBash() 和 cleanup()
 * 其余功能（命令包装、快照恢复、CWD 跟踪、超时处理）为共享实现
 */
class BaseTerminalBackendEnv {
  constructor(cwd, timeout = 180) {
    if (new.target === BaseTerminalBackendEnv) {
      throw new Error('BaseTerminalBackendEnv 是抽象类，不能直接实例化')
    }
    this.cwd = cwd
    this.timeout = timeout
    this._sessionId = randomUUID().replace(/-/g, '').slice(0, 12)
    this._snapshotPath = `/tmp/hermes-snap-${this._sessionId}.sh`
    this._cwdFile = `/tmp/hermes-cwd-${this._sessionId}.txt`
    this._snapshotReady = false
  }

  runBash(cmdString, { timeout }) {
    throw new Error('子类必须实现 runBash()')
  }

  cleanup() {
    throw new Error('子类必须实现 cleanup()')
  }

  // 首次使用时跑一次，把 login shell 的环境变量存下来
  initSession() {
    const initCmd = `export -p > ${this._snapshotPath} 2>/dev/null; pwd -P > ${this._cwdFile}`
    const proc = this.runBash(initCmd, { timeout: 10 })
    proc.on('exit', () => {
      this._snapshotReady = true
    })
  }

  /**
   * 包装、运行、等待、更新 CWD
   * @param {string} command - 命令
   * @param {number} [timeout] - 超时时间（秒）
   * @returns {Promise<{output: string, returncode: number}>}
   */
  async execute(command, timeout = null) {
    if(!this._snapshotReady) {
      this.initSession()
    }
    const actualTimeout = (timeout || this.timeout) * 1000 // 转毫秒
    const wrapped = this._wrapCommand(command)
    const proc = this.runBash(wrapped, { timeout: actualTimeout })
    
    let stdout = ''
    let killed = false

    const timeoutId = setTimeout(() => {
      killed = true
      proc.kill()
    }, actualTimeout)

    return new Promise(resolve => {
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      proc.on('exit', (code) => {
        clearTimeout(timeoutId)
        this._updateCwd()
        if(killed) {
          resolve({ output: '(timed out)', returncode: 124 })
        } else {
          resolve({ 
            output: stdout.slice(0, 1000), 
            returncode: code || 0 
          })
        }
      })
    })
  }

  // 将裸命令包装成：恢复环境 → cd → 执行 → 保存环境 → 保存 CWD
  _wrapCommand(cmd) {
    const parts = []
    if(this._snapshotReady) {
      parts.push(`source ${this._snapshotPath} 2>/dev/null`)
    }
    const args = this.cwd.replace(/'/g, "'\\''")
    parts.push(`cd ${args} 2>/dev/null`)
    parts.push(cmd)
    // 保存执行后的环境，给下一条命令使用
    parts.push(`_exit=$?; export -p > ${this._snapshotPath} 2>/dev/null; pwd -P > ${this._cwdFile} 2>/dev/null; exit $_exit`)
    return parts.join('; ')
  }

  _updateCwd() {
    try {
      if (existsSync(this._cwdFile)) {
        const newCwd = readFileSync(this._cwdFile, 'utf-8').trim()
        if (newCwd) {
          this.cwd = newCwd
        }
      }
    } catch (err) {
      // 忽略错误
    }
  }
}

class LocalBackendEnv extends BaseTerminalBackendEnv {
  runBash(cmdString, { timeout }) {
    // 过滤掉 Hermes 的 API key
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!SECRET_BLOCKLIST.has(key)) {
        env[key] = value
      }
    }

    return spawn('bash', ['-c', cmdString], {
      stdout: 'pipe',
      stderr: 'pipe', // Node.js 不会自动合并 stderr 到 stdout，基类会处理
      env,
    })
  }

  cleanup() {
    try {
      if(existsSync(this._snapshotPath)) {
        unlinkSync(this._snapshotPath)
      }
      if(existsSync(this._cwdFile)) {
        unlinkSync(this._cwdFile)
      }
    } catch (error) {
      // FileNotFoundError 忽略
    }
  }
}

class DockerBackendEnv extends BaseTerminalBackendEnv {
  constructor(image = 'node:24', { cwd, timeout = 180 } = {}) {
    super(cwd, timeout)
    this._image = image
    this._containerId = null
  }

  _ensureContainer() {
    if(this._containerId) {
      return
    }
    const result = execSync(
      `docker run -d --name hermes-${this._sessionId} --cap-drop ALL ` +
      `--security-opt no-new-privileges --pids-limit 256 --cpus 1 --memory 512m ` +
      `--tmpfs /tmp:rw,nosuid,size=256m ${this._image} sleep infinity`,
      { encoding: 'utf-8' }
    )
    this._containerId = result.trim()
    if (!this._containerId) {
      throw new Error('Docker start failed')
    }
  }

  runBash(cmdString, { timeout }) {
    this._ensureContainer()
    return spawn('docker', ['exec', '-i', this._containerId, 'bash', '-c', cmdString], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  cleanup() {
    if (this._containerId) {
      try {
        execSync(`docker rm -f ${this._containerId}`, { stdio: 'pipe' })
      } catch (err) {
        // 忽略错误
      }
      this._containerId = null
    }
  }

  _updateCwd() {
    if(!this._containerId) {
      return
    }
    try {
      const result = execSync(
        `docker exec ${this._containerId} cat ${this._cwdFile}`,
        { encoding: 'utf-8' }
      )
      const newCwd = result.trim()
      if (newCwd) {
        this.cwd = newCwd
      }
    } catch (err) {
      // 忽略错误
    }
  }
}

class SSHBackendEnv extends BaseTerminalBackendEnv {
  constructor(host, user, keyPath = null, { cwd, timeout = 180 } = {}) {
    super(cwd, timeout)
    this._host = host
    this._user = user
    this._keyPath = keyPath

    const ctrlDir = path.join(os.tmpdir(), 'hermes-ssh')
    mkdirSync(ctrlDir, { recursive: true })
    this._controlSocket = path.join(ctrlDir, `${user}@${host}.sock`)
  }

  _sshArgs() {
    const args = [
      'ssh',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this._controlSocket}`,
      '-o', 'ControlPersist=300',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
    ]
    if (this._keyPath) {
      args.push('-i', this._keyPath)
    }
    args.push(`${this._user}@${this._host}`)
    return args
  }

  runBash(cmdString, { timeout }) {
    const args = this._sshArgs().concat(['bash', '-c', cmdString])
    return spawn('ssh', args, {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  _updateCwd() {
    try {
      const sshCmd = this._sshArgs().join(' ')
      const result = execSync(
        `${sshCmd} cat ${this._cwdFile}`,
        { encoding: 'utf-8', timeout: 5000 }
      )
      const newCwd = result.trim()
      if (newCwd) {
        this.cwd = newCwd
      }
    } catch (err) {
      // 忽略错误
    }
  }

  cleanup() {
    try {
      execSync(
        `ssh -O exit -o ControlPath=${this._controlSocket} ${this._user}@${this._host}`,
        { stdio: 'pipe' }
      )
    } catch (err) {
      // 忽略错误
    }
  }
}

export const createBackendEnv = (config) => {
  const terminal = config.terminal
  switch(terminal.backend) {
    case 'docker':
      const image = terminal.image || 'node:24'
      return new DockerBackendEnv(image, { cwd: '/workspace'} )
    case 'ssh':
      const host = terminal.host
      const user = terminal.user
      const keyPath = terminal.keyPath
      return new SSHBackendEnv(host, user, keyPath, { cwd: '~'} )
    default:
      return new LocalBackendEnv(process.cwd())
  }
}