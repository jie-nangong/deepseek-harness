#!/usr/bin/env node
/**
 * bump-version.mjs —— 版本号更新 → 提交 → 推送，一步到位。
 *
 * 支持两个仓库（按 --name 自动映射路径 / 远端 / 分支）：
 *   harness  → deepseek-harness                → fork/sync-support
 *   desktop  → dsh-desktop                     → origin/main
 *
 * 用法（在对应仓库目录内运行可省略 --name，自动识别）：
 *   node bump-version.mjs --version 0.2.2                  # 自动识别当前仓库并推送
 *   node bump-version.mjs --name desktop --version 0.1.11  # 显式指定
 *   node bump-version.mjs --version 0.2.2 --no-push        # 只改+提交，不推送
 *   node bump-version.mjs --name desktop --version 0.1.11 --no-package  # desktop 更新但不打包
 *
 * 默认：target 为 desktop 时，推送完成后自动 npm run dist 打包（生成 dist\DSH-Desktop-Setup-<v>.exe），
 *       并自动把旧版安装包归档到 dist\旧版本；用 --no-package 可跳过打包。harness 无安装包，不打包。
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

/** 允许推送的 GitHub 账号（本人账号）。推送前校验目标远端归属，非本人账号一律拒绝，防止误推上游/他人仓库。 */
const OWNER = 'jie-nangong'
function ghOwner(url) {
  const m = url.match(/(?:https?:\/\/github\.com\/|git@github\.com:|github\.com:)([^/]+)\//)
  return m ? m[1] : null
}

const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
let name = flag('--name')
const version = flag('--version')
const noPush = args.includes('--no-push')
const noPackage = args.includes('--no-package')

// 未显式指定 --name 时，按当前工作目录自动识别所属仓库（自动选对应远端/分支）。
if (!name) {
  const cwd = process.cwd().toLowerCase()
  if (cwd.includes('deepseek-harness')) name = 'harness'
  else if (cwd.includes('dsh-desktop')) name = 'desktop'
}

if (!name || !version) {
  console.log('用法: node bump-version.mjs [--name harness|desktop] --version x.y.z [--no-push]')
  console.log('  未给 --name 时，按当前所在仓库目录自动识别并推送对应远端。')
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

// ---- 3. 推送（先护栏：确认目标远端属于本人账号） ----
if (noPush) { console.log(`--no-push 已跳过推送（${repo.remote}/${repo.branch}）`); process.exit(0) }
const remoteUrl = gitOut('remote', 'get-url', repo.remote)
const remoteOwner = ghOwner(remoteUrl)
if (remoteOwner !== OWNER) {
  console.log(`拒绝推送：远端 ${repo.remote} 归属账号 "${remoteOwner}"，非本人账号 "${OWNER}"（${remoteUrl}）`)
  process.exit(1)
}
console.log(`远端护栏通过: ${repo.remote} -> ${remoteOwner}（本人账号）`)
const pushed = gitPush('push', repo.remote, repo.branch)
if (pushed) {
  console.log(`已推送: ${repo.remote}/${repo.branch} -> ${version}`)
  // 默认打包（desktop 才有安装包；--no-package 跳过）
  if (name === 'desktop' && !noPackage) {
    console.log(`\n=== 默认打包 ${name} 安装包（--no-package 可跳过）===`)
    const pkgOut = run('cmd', ['/c', 'npm', 'run', 'dist'])
    if (pkgOut) {
      console.log(`已打包安装包: dist\\DSH-Desktop-Setup-${version}.exe`)
      // 打包后自动归档旧版安装包到 dist\旧版本
      const arch = run('node', [`${repo.path}/archive-installers.mjs`])
      console.log(arch ? '旧版安装包已归档到 dist\\旧版本' : '归档未执行（可后跑 archive-installers.mjs）')
      process.exit(0)
    }
    console.log('打包失败，请检查 npm run dist 日志')
    process.exit(1)
  }
  process.exit(0)
}
console.log(`推送失败（请确认代理 127.0.0.1:7897 已开 / 网络可达）`)
process.exit(1)
