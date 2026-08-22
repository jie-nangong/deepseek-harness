#!/usr/bin/env node
/**
 * bump-version.mjs —— 版本号更新 → 提交 → 推送，一步到位。
 *
 * 支持两个仓库（按 --name 自动映射路径 / 远端 / 分支）：
 *   harness  → deepseek-harness                → fork/sync-support
 *   desktop  → dsh-desktop                     → origin/main
 *
 * 用法：
 *   node bump-version.mjs --name harness --version 0.2.2
 *   node bump-version.mjs --name desktop --version 0.1.11
 *   node bump-version.mjs --name harness --version 0.2.2 --no-push   # 只改+提交，不推送
 *
 * 约定：只更新根 package.json 的 version 字段；提交信息 chore(release): 本地版本号置为 <v>；
 *     推送带代理参数（127.0.0.1:7897）；工作区其他未跟踪/改动只提示、不纳入本次提交。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const REPOS = {
  harness: { path: 'C:/Users/董振华/deepseek-harness', remote: 'fork', branch: 'sync-support' },
  desktop: { path: 'C:/Users/董振华/Desktop/DeepSeek Harness/dsh-desktop', remote: 'origin', branch: 'main' },
}
const PROXY = ['-c', 'http.proxy=http://127.0.0.1:7897', '-c', 'https.proxy=http://127.0.0.1:7897']

const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const name = flag('--name')
const version = flag('--version')
const noPush = args.includes('--no-push')

if (!name || !version) {
  console.log('用法: node bump-version.mjs --name harness|desktop --version x.y.z [--no-push]')
  process.exit(1)
}
const repo = REPOS[name]
if (!repo) { console.log(`未知仓库名: ${name}（支持 harness / desktop）`); process.exit(1) }
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.log(`版本号格式应为 x.y.z: ${version}`); process.exit(1) }
if (!existsSync(`${repo.path}/package.json`)) { console.log(`未找到 package.json: ${repo.path}`); process.exit(1) }

function run(cmd, cArgs, opts = {}) {
  const r = spawnSync(cmd, cArgs, { cwd: repo.path, stdio: ['ignore', 'inherit', 'inherit'], ...opts })
  return r.status === 0
}
const git = (...a) => run('git', a)                       // 本地命令（无代理）
const gitPush = (...a) => run('git', [...PROXY, ...a])     // 推送（带代理）
const gitOut = (...a) => spawnSync('git', a, { cwd: repo.path, encoding: 'utf8' }).stdout.trim()

// ---- 1. 更新根 package.json 版本号 ----
const pkgPath = `${repo.path}/package.json`
const pkg = readFileSync(pkgPath, 'utf8')
const next = pkg.replace(/(["']version["']\s*:\s*["'])[^"']+(["'])/, `$1${version}$2`)
if (next === pkg) {
  console.log(`版本号已是 ${version}，无改动——跳过提交推送`)
  process.exit(0)
}
writeFileSync(pkgPath, next)
console.log(`已更新 ${repo.path} 版本号 -> ${version}`)

// 工作区其他改动提示（不纳入本次提交）
const dirty = gitOut('status', '--porcelain').split('\n').filter(l => l && !/package\.json$/.test(l.trim().replace(/^.. /, '')))
if (dirty.length) console.log(`提示: 工作区另有 ${dirty.length} 处非版本号改动（只提交 package.json）`)

// ---- 2. 提交 ----
git('add', 'package.json')
const commitMsg = `chore(release): 本地版本号置为 ${version}`
const committed = git('commit', '-m', commitMsg)
if (!committed) {
  console.log('提交失败（请检查 git 状态）')
  process.exit(1)
}
console.log(`已提交: ${commitMsg}`)

// ---- 3. 推送 ----
if (noPush) { console.log(`--no-push 已跳过推送（${repo.remote}/${repo.branch}）`); process.exit(0) }
const pushed = gitPush('push', repo.remote, repo.branch)
if (pushed) {
  console.log(`已推送: ${repo.remote}/${repo.branch} -> ${version}`)
  process.exit(0)
}
console.log(`推送失败（请确认代理 127.0.0.1:7897 已开 / 网络可达）`)
process.exit(1)
