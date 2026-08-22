#!/usr/bin/env node
/**
 * deepseek-harness 升级到上游 dsh-v0.1.1-rc.2，并把本地发布版本号设为 0.2.1。
 *
 * 幂等：可重复运行。重复运行会重打备份标签、重新 fetch、预检，且已合并过则跳过 merge。
 *
 * 用法：
 *   node upgrade-to-0.2.1.mjs                  # 只做代码层：fetch→预检→merge→冲突处置→版本号→build:lib/build:web
 *   node upgrade-to-0.2.1.mjs --restart        # 之后定向重启 3080 服务并做就绪探测
 *   node upgrade-to-0.2.1.mjs --skip-build     # 跳过构建（仅 merge+版本号）
 *
 * 说明 / 边界：
 *   - git 命令统一带本地代理参数（127.0.0.1:7897，若代理未开请先开 Clash/v2ray）。
 *   - pnpm 是 .cmd shim，统一经 `cmd /c pnpm ...` 包装。
 *   - 服务重启用「定向终止监听 3080 的单个 pid」+「重新 spawn（带 --no-open）」，绝不 taskkill /T。
 *   - 重启会中断当前承载在 3080 上的 GUI 会话；默认不重启，需主动 --restart。
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const TARGET = 'dsh-v0.1.1-rc.2'
const VERSION = '0.2.1'
const PROXY = ['-c', 'http.proxy=http://127.0.0.1:7897', '-c', 'https.proxy=http://127.0.0.1:7897']
// 我们与上游都改动过、且需「取上游完整版」的文件——上游已官方发布视觉模型并含 imagePixelBudget。
const PREFER_THEIRS = ['packages/llm/llm-deepseek/src/index.ts', 'packages/llm/llm-deepseek/README.md', 'packages/llm/llm-deepseek/README.zh.md']

const args = process.argv.slice(2)
const RESTART = args.includes('--restart')
const SKIP_BUILD = args.includes('--skip-build')

function step(name) { console.log(`\n=== ${name} ===`) }
function fail(msg) { console.error(`\n[FAIL] ${msg}`); process.exit(1) }

/** 只依赖退出码判定成败；输出实时透传，不捕获（避免 cmd /c 重定向中文路径不稳）。 */
function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...opts,
  })
  return res.status === 0
}
const git = (...a) => run('git', [...PROXY, ...a])
/** pnpm 经 cmd /c 包装。 */
const pnpm = (...a) => run('cmd', ['/c', 'pnpm', ...a])

function gitOut(...a) {
  const res = spawnSync('git', [...PROXY, ...a], { cwd: ROOT, encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : ''
}

step('0 前置检查')
if (gitOut('status', '--porcelain').length) fail('工作区有未提交改动，先提交/暂存再升级')
console.log(`目标 tag: ${TARGET}  本地版本: ${VERSION}  proxy: 127.0.0.1:7897`)

step('1 重打备份标签（幂等）')
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const tag = `pre-${VERSION}-upgrade-${ts}`
if (!git('tag', '-f', tag)) fail('打备份标签失败')
console.log(`备份标签: ${tag}`)

step('2 fetch 上游 tag（幂等）')
if (!git('fetch', 'origin', '--tags')) fail('fetch origin --tags 失败（请确认代理已开）')
console.log('fetch ok')

step('3 预检：确认上游 tag 存在 + merge-tree 冲突面')
if (!gitOut('rev-parse', '--verify', TARGET)) fail(`未找到上游 tag ${TARGET}`)
const mt = spawnSync('git', [...PROXY, 'merge-tree', '--write-tree', 'HEAD', TARGET], { cwd: ROOT, encoding: 'utf8' })
if (mt.status !== 0) {
  const conflicts = (mt.stdout || '').split('\n').filter(l => l.includes('CONFLICT')).map(l => l.split(' ').pop())
  console.log(`merge-tree 预检冲突文件(${conflicts.length}):`)
  conflicts.forEach(c => console.log(`  - ${c}`))
} else {
  console.log('merge-tree 预检：预期冲突 0 —— 上游已是 HEAD 祖先或已干净')
}

step('4 合并（幂等：已合并过则跳过）')
const alreadyAncestor = run('git', [...PROXY, 'merge-base', '--is-ancestor', TARGET, 'HEAD'])
if (alreadyAncestor) {
  console.log('HEAD 已是上游目标祖先，跳过 merge')
} else {
  // 对冲突的三个文件取上游（theirs），其余文件正常三方合并保留双方未冲突改动。
  const merged = run('git', [...PROXY, 'merge', '-X', 'theirs', TARGET])
  const unmerged = gitOut('status', '--porcelain').split('\n').filter(l => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l))
  if (unmerged.length) fail(`仍有未解决的冲突:\n${unmerged.join('\n')}`)
  if (!merged) fail('merge 失败（可能 -X theirs 未清掉全部 conflict）')
  console.log('merge 完成（3 个 llm-deepseek 文件已取上游版）')
}

step('5 版本号改为 ' + VERSION)
const pkgPath = `${ROOT}/package.json`
const pkg = readFileSync(pkgPath, 'utf8')
const next = pkg.replace(/("version"\s*:\s*")[^"]+(")/, `$1${VERSION}$2`)
if (next === pkg) fail('未找到 root package.json 的 version 字段')
writeFileSync(pkgPath, next)
console.log(`root version -> ${VERSION}`)

if (SKIP_BUILD) { step('跳过构建'); console.log('完成（--skip-build）。需在升级后手动 build:lib + build:web'); process.exit(0) }

step('6 pnpm install（幂等）')
if (!pnpm('install', '--config.confirmModulesPurge=false')) fail('pnpm install 失败')

step('7 构建 build:lib + build:web')
if (!pnpm('run', 'build:lib')) fail('pnpm run build:lib 失败')
if (!pnpm('run', 'build:web')) fail('pnpm run build:web 失败')

if (!RESTART) {
  step('已完成代码层升级（未重启服务）')
  console.log('提示：运行中的 3080 仍是旧构建，重启后才能生效。确认时机后执行 node upgrade-to-0.2.1.mjs --restart')
  process.exit(0)
}

step('8 重启 3080 服务（定向终止 + 重新 spawn，带 --no-open）')
const conn = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess'], { cwd: ROOT, encoding: 'utf8' })
const serverPid = Number(String(conn.stdout || '').trim())
if (serverPid > 0) {
  console.log(`终止旧服务 pid=${serverPid}`)
  process.kill(serverPid, 'SIGTERM')
  await new Promise(r => setTimeout(r, 2500))
} else {
  console.log('未发现 3080 监听进程（可能已停止）')
}
const binPath = `${ROOT}/apps/cli/src/bin.ts`
const child = spawn('node', ['--import', 'tsx/esm', binPath, '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open'], {
  cwd: ROOT, stdio: 'ignore', detached: true,
})
child.unref()
console.log(`已 spawn 新服务 pid=${child.pid}（--no-open，不会自动弹浏览器）`)

step('9 就绪探测（3080 + 模型目录）')
await new Promise(r => setTimeout(r, 60000))
const ready = spawnSync('powershell', ['-NoProfile', '-Command', '(Invoke-WebRequest -Uri \"http://127.0.0.1:3080/\" -UseBasicParsing -TimeoutSec 8).StatusCode'], { cwd: ROOT, encoding: 'utf8' })
console.log(`3080 根路径状态码: ${String(ready.stdout || ready.stderr).trim().slice(0, 40)}`)

step('完成')
console.log(`已升级到 ${TARGET}（本地版本 ${VERSION}）。请再做回归验证：暖橙主题、data-session-id、注入式 UI 探测、模型目录(含 vision-exp+imagePixelBudget)、repair-session-logs.mts 体检。`)
