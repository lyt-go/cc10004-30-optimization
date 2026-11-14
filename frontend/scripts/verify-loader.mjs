/**
 * 仅用于验收脚本的 ESM 解析钩子：让 Node 能解析 TypeScript 编译产物里
 * 「无扩展名」的相对导入（业务源码沿用项目既有的 extensionless 风格，不为此改动）。
 */
import { existsSync } from 'node:fs'

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExt = /\.[a-zA-Z0-9]+$/.test(specifier)
  if (isRelative && !hasExt) {
    const candidate = new URL(`${specifier}.js`, context.parentURL)
    if (existsSync(candidate)) {
      return nextResolve(candidate.href, context)
    }
  }
  return nextResolve(specifier, context)
}
