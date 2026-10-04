// 用 esbuild 的 JS API 把领域代码（含 @ 别名）打成单文件，供 Node 直接跑断言。
// 不走 vite/rollup，避免与平台原生二进制相关的构建依赖影响逻辑验证。
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outfile = resolve(root, '.test-build/checkpoint.mjs')

mkdirSync(dirname(outfile), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/domain/checkpoint.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@': resolve(root, 'src') },
  outfile,
})
console.log('领域代码已打包到 .test-build/checkpoint.mjs')
