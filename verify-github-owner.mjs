#!/usr/bin/env node
/**
 * verify-github-owner.mjs —— 识别 git remote 的 GitHub 账号归属，确认推送目标是本人账号下的仓库。
 *
 * 检查一个仓库的所有 git remote（或指定 remote），解析其 GitHub owner，并判断是否等于期望账号（默认 jie-nangong）。
 * 可被 bump-version.mjs 在推送前调用，作为“不外推非本人仓库”的护栏。
 *
 * 用法：
 *   node verify-github-owner.mjs                        # 检查两个仓库的所有 remote 归属
 *   node verify-github-owner.mjs --repo harness         # 只查 deepseek-harness
 *   node verify-github-owner.mjs --repo desktop         # 只查 dsh-desktop
 *   node verify-github-owner.mjs --repo <路径>           # 查任意仓库路径
 *   node verify-github-owner.mjs --remote fork --repo harness   # 只校验指定 remote
 *   node verify-github-owner.mjs --expect <owner>       # 自定义期望账号
 * 退出码：0=所有被校验 remote 都属于期望账号（或无可校验 remote）；1=存在不属于期望账号的 remote。
 */
import { spawnSync } from 'node:child_process'

const REPOS = {
  harness: 'C:/Users/董振华/deepseek-harness',
  desktop: 'C:/Users/董振华/Desktop/DeepSeek Harness/dsh-desktop',
}
const args = process.argv.slice(2)
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const repoArg = flag('--repo')
const remoteArg = flag('--remote')
const expect = flag('--expect') || 'jie-nangong'

function resolveRepo(r) {
  if (REPOS[r]) return REPOS[r]
  return r || null
}
function gh(url) {
  // https://github.com/OWNER/REPO(.git)  |  git@github.com:OWNER/REPO(.git)
  const m = url.match(/(?:https?:\/\/github\.com\/|git@github\.com:|github\.com:)([^/]+)\/(.+?)(?:\.git)?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}
function gitOut(cwd, ...a) {
  return spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim()
}

const targets = repoArg ?
  [resolveRepo(repoArg)].filter(Boolean) :
  Object.values(REPOS)

let anyBad = false
for (const cwd of targets) {
  console.log(`\n== 仓库: ${cwd} ==`)
  const remotes = gitOut(cwd, 'remote').split('\n').filter(Boolean)
  if (!remotes.length) { console.log('  (无 remote)'); continue }
  for (const rname of remotes) {
    const url = gitOut(cwd, 'remote', 'get-url', rname)
    const info = gh(url)
    if (!info) { console.log(`  [${rname}] 非 GitHub 地址: ${url}`); continue }
    const ok = info.owner === expect
    if (remoteArg && rname !== remoteArg) continue
    if (!ok) anyBad = true
    console.log(`  [${rname}] ${info.owner}/${info.repo}  ${ok ? '✔ 本人账号' : '✘ 非本人账号! (期望 ' + expect + ')'}`)
  }
}
process.exit(anyBad ? 1 : 0)
