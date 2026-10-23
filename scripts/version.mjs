import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 版本单一来源：package.json 的 version。iOS 侧只认 Xcode 构建变量：
//   Info.plist      → $(MARKETING_VERSION) / $(CURRENT_PROJECT_VERSION)
//   project.pbxproj → MARKETING_VERSION / CURRENT_PROJECT_VERSION
// 构建号常量 23：CURRENT_PROJECT_VERSION 的最低值 / 缺失时的提示值；
// --bump-build 在 pbxproj 现有构建号上 +1，并写回 Debug / Release 两处配置。
const BUILD_NUMBER = 23
const root = resolve(import.meta.dirname, '..')
const paths = {
  pkg: resolve(root, 'package.json'),
  plist: resolve(root, 'ios/DSHPocket/Info.plist'),
  pbx: resolve(root, 'ios/DSHPocket.xcodeproj/project.pbxproj'),
  capabilities: resolve(root, 'src/capabilities.json')
}
const flags = new Set(process.argv.slice(2))
const known = new Set(['--write', '--check', '--bump-build'])
const unknown = [...flags].filter((flag) => !known.has(flag))
if (unknown.length) { console.error(`未知参数：${unknown.join(' ')}`); process.exit(2) }
const checkOnly = flags.has('--check')
const bumpBuild = flags.has('--bump-build')
if (checkOnly && bumpBuild) { console.error('--check 只校验，不能与 --bump-build 同时使用'); process.exit(2) }
const read = (path) => readFileSync(path, 'utf8')
const errors = []
const fail = (message) => errors.push(message)

const version = JSON.parse(read(paths.pkg)).version
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail(`package.json 的 version 不是 x.y.z 格式：${version}`)

const plist = read(paths.plist)
if (!/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(plist)) fail('Info.plist 的 CFBundleShortVersionString 必须使用 $(MARKETING_VERSION)')
if (!/<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/.test(plist)) fail('Info.plist 的 CFBundleVersion 必须使用 $(CURRENT_PROJECT_VERSION)')

let pbx = read(paths.pbx)
const buildNumbers = () => [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((match) => Number(match[1]))
if (bumpBuild) {
  const current = buildNumbers()
  if (current.length === 0) { console.error(`✗ project.pbxproj 缺少 CURRENT_PROJECT_VERSION（应设为 ${BUILD_NUMBER}）`); process.exit(1) }
  if (new Set(current).size > 1) { console.error('✗ Debug / Release 的 CURRENT_PROJECT_VERSION 不一致，请先手动对齐'); process.exit(1) }
  const next = Math.max(...current) + 1
  pbx = pbx.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${next};`)
  writeFileSync(paths.pbx, pbx)
  console.log(`构建号 ${Math.max(...current)} → ${next}`)
}

const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((match) => match[1].trim())
if (marketing.length === 0) fail('project.pbxproj 缺少 MARKETING_VERSION')
else if (marketing.some((value) => value !== version)) fail(`project.pbxproj 的 MARKETING_VERSION（${[...new Set(marketing)].join(', ')}）与 package.json 的 ${version} 不一致`)

const builds = buildNumbers()
if (builds.length === 0) fail(`project.pbxproj 缺少 CURRENT_PROJECT_VERSION（应设为 ${BUILD_NUMBER}）`)
else if (new Set(builds).size > 1) fail(`project.pbxproj 的 Debug / Release CURRENT_PROJECT_VERSION 不一致：${builds.join(', ')}`)
else if (Math.max(...builds) < BUILD_NUMBER) fail(`CURRENT_PROJECT_VERSION 必须 >= ${BUILD_NUMBER}，当前为 ${Math.max(...builds)}`)

const capabilities = JSON.parse(read(paths.capabilities))
if (checkOnly) {
  if (capabilities.version !== version) fail(`src/capabilities.json 的 version（${capabilities.version}）与 package.json 的 ${version} 不一致，请运行 node scripts/version.mjs 同步`)
} else if (capabilities.version !== version) {
  capabilities.version = version
  writeFileSync(paths.capabilities, `${JSON.stringify(capabilities)}\n`)
  console.log(`src/capabilities.json version → ${version}`)
}

if (errors.length) {
  for (const message of errors) console.error(`✗ ${message}`)
  console.error('版本校验失败：package.json 是唯一版本来源，请修正后再试。')
  process.exit(1)
}
const build = builds.length ? Math.max(...builds) : BUILD_NUMBER
console.log(`✓ 版本一致：${version}（build ${build}）${checkOnly ? ' [check]' : ''}`)
