// Run by `npm run build` after VitePress: every link inside the built site (site/dist, served at the
// domain's root) reaches a file, and one with a #hash reaches an id on that page. VitePress fails on a link to a
// missing page but not on a missing anchor, nor on the landing's links (site/static).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

const root = process.argv[2] ?? 'dist'
const BASE = '/'
const isFile = (p) => { try { return statSync(join(root, p)).isFile() } catch { return false } }
// as GitHub Pages resolves a path: the file, <path>.html, <path>/index.html
const resolve = (p) => [p, `${p}.html`, posix.join(p, 'index.html')].find(isFile)
const ids = new Map()
const idsOf = (f) => ids.get(f) ?? ids.set(f, new Set([...readFileSync(join(root, f), 'utf8').matchAll(/\sid="([^"]+)"/g)]
  .map((m) => m[1]))).get(f)

let links = 0
const broken = []
for (const page of readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.html') && !f.endsWith('404.html'))) {
  for (const [, href] of readFileSync(join(root, page), 'utf8').matchAll(/<a\s[^>]*?href="([^"]+)"/g)) {
    if (/^[a-z]+:/.test(href)) continue // https:, mailto:
    links++
    const [path, hash] = href.split('#')
    const abs = path === '' ? BASE + page : path.startsWith('/') ? path : posix.join(BASE, posix.dirname(page), path)
    const target = abs.startsWith(BASE) ? (path === '' ? page : resolve(abs.slice(BASE.length).split('?')[0] || '.')) : undefined
    if (!target) broken.push(`${page}: ${href} (no such page)`)
    else if (hash && !idsOf(target).has(decodeURIComponent(hash))) broken.push(`${page}: ${href} (no such anchor)`)
  }
}
if (broken.length) {
  console.error(`broken links:\n  ${broken.join('\n  ')}`)
  process.exit(1)
}
console.log(`links: ${links} inside the site, all reach their page and anchor`)
