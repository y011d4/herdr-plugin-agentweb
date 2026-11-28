// The docs at https://yoicks.y011d4.com/docs/: VitePress, English (en/) and Japanese (ja/),
// every page in both. The build also assembles the rest of the Pages site in site/dist (buildEnd): site/static/
// as is (the landing at /, later /vrt/ and /demo/), the 404 page at the site's root, and one sitemap.xml for all
// of it.
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress'

const SITE = 'https://yoicks.y011d4.com/'
const REPO = 'https://github.com/y011d4/herdr-yoicks'
const DOCS = fileURLToPath(new URL('..', import.meta.url)) // site/docs
const LANGS = ['en', 'ja'] as const
type Lang = (typeof LANGS)[number]

// The language menu and the hreflang links send a reader to the same page in the other language, so each page
// must exist in both: a page in one only fails the build.
const pagesOf = (lang: Lang) =>
  (readdirSync(join(DOCS, lang), { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).sort()
const PAGES = pagesOf('en')
const missing = [...PAGES.filter((f) => !pagesOf('ja').includes(f)).map((f) => `ja/${f}`),
  ...pagesOf('ja').filter((f) => !PAGES.includes(f)).map((f) => `en/${f}`)]
if (missing.length) throw new Error(`every docs page needs both languages; missing: ${missing.join(', ')}`)

/** A page's public URL; `page` is its path inside a language's dir ('guide/install.md', 'index.md'). */
const url = (lang: Lang, page: string) =>
  `${SITE}docs/${lang}/${page.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`
/** A page in each language, and the English one for a reader whose language is neither. */
const alternates = (page: string): Array<[string, string]> =>
  [...LANGS.map((l): [string, string] => [l, url(l, page)]), ['x-default', url('en', page)]]

// The landing (/) is one page in both languages (static/index.html), so it has no alternates of its own.
const sitemap = () => {
  const entry = (loc: string, links: Array<[string, string]>) =>
    `<url><loc>${loc}</loc>${links.map(([l, href]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${href}"/>`).join('')}</url>`
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    [entry(SITE, []), ...LANGS.flatMap((l) => PAGES.map((p) => entry(url(l, p), alternates(p))))].join('\n') + '\n</urlset>\n'
}

// The sidebar, both languages from one list: [path, English title, Japanese title].
const GROUPS: Array<{ en: string; ja: string; items: Array<[string, string, string]> }> = [
  { en: 'Guide', ja: 'ガイド', items: [
    ['', 'What is yoicks', 'yoicks とは'],
    ['guide/install', 'Install', 'インストール'],
    ['guide/start', 'Start and connect', '起動と接続'],
    ['guide/phone', 'Exposing the bridge to your phone', 'スマホへの公開'],
    ['guide/app', 'Using the app', 'アプリの使い方'],
    ['guide/orchestrators', 'Orchestrators', 'orchestrator'],
    ['guide/headless', 'Headless orchestrators', 'ヘッドレスの orchestrator'],
  ] },
  { en: 'Reference', ja: 'リファレンス', items: [
    ['reference/config', 'Configuration', '設定 (config)'],
    ['reference/cli', 'The yoicks commands', 'yoicks のコマンド'],
    ['reference/api', 'API (for scripting)', 'API (スクリプト用)'],
    ['reference/security', 'Security model', 'セキュリティモデル'],
    ['reference/troubleshooting', 'Compatibility and troubleshooting', '対応状況と困ったとき'],
  ] },
  { en: 'Development', ja: '開発', items: [['development', 'Development and releasing', '開発とリリース']] },
]
const sidebar = (l: Lang): DefaultTheme.SidebarItem[] =>
  GROUPS.map((g) => ({ text: g[l], items: g.items.map(([p, en, ja]) => ({ text: l === 'en' ? en : ja, link: `/${l}/${p}` })) }))
const nav = (l: Lang): DefaultTheme.NavItem[] => [
  { text: GROUPS[0][l], link: `/${l}/`, activeMatch: `^/${l}/(guide/.*)?$` },
  { text: GROUPS[1][l], link: `/${l}/reference/config`, activeMatch: `^/${l}/reference/` },
  { text: GROUPS[2][l], link: `/${l}/development` },
]
// A line break inside Japanese text shows as a space between two characters (「スマホから モニタリング」): drop
// the ones with Japanese on both sides, or after 、 and 。 (no space follows them). Elsewhere next to Latin text it
// stays the space the line would have had.
const JA = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}、。（）「」]/u
type Token = { type: string; content: string; children: Token[] | null }
/** The character next to a line break (step -1: before it, 1: after), across the tags of a link or **bold**. */
const charBeside = (c: Token[], i: number, step: 1 | -1) => {
  let j = i + step
  while (/_(open|close)$/.test(c[j]?.type ?? '')) j += step
  const t = c[j]
  return t?.type === 'text' ? (step < 0 ? t.content.at(-1) : t.content[0]) ?? '' : ''
}

const editLink = (text: string) => ({ pattern: `${REPO}/edit/main/site/docs/:path`, text })
const license = (text: string) => ({ message: text.replace('%', `<a href="${REPO}/blob/main/LICENSE">`).replace('%', '</a>') })

export default defineConfig({
  base: '/docs/',
  outDir: '../dist/docs',
  cleanUrls: true,
  lang: 'en',
  title: 'yoicks',
  description: 'Hand the work to one orchestrator: it runs many coding agents in herdr at once.',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }]],
  markdown: {
    config(md) {
      md.core.ruler.push('ja_breaks', (state: { tokens: Token[] }) => {
        for (const { children: c } of state.tokens) {
          c?.forEach((t, i) => {
            const before = charBeside(c, i, -1)
            if (t.type === 'softbreak' && (/[、。]/.test(before) || (JA.test(before) && JA.test(charBeside(c, i, 1))))) {
              t.type = 'text'
              t.content = ''
            }
          })
        }
      })
    },
  },
  themeConfig: {
    logo: { light: '/lockup-light.svg', dark: '/lockup.svg', alt: 'yoicks' },
    siteTitle: false, // the lockup is the name
    socialLinks: [{ icon: 'github', link: REPO }],
    notFound: { link: SITE, linkText: 'Go to the yoicks home' },
    search: {
      provider: 'local',
      options: {
        locales: {
          ja: {
            translations: {
              button: { buttonText: '検索', buttonAriaLabel: '検索' },
              modal: {
                displayDetails: '詳しく表示', resetButtonTitle: '検索語を消す', backButtonTitle: '検索を閉じる',
                noResultsText: '見つかりませんでした',
                footer: { selectText: '開く', navigateText: '移動', closeText: '閉じる' },
              },
            },
          },
        },
      },
    },
  },
  locales: {
    en: {
      label: 'English', lang: 'en', link: '/en/',
      themeConfig: {
        nav: nav('en'), sidebar: sidebar('en'),
        editLink: editLink('Edit this page on GitHub'),
        footer: license('Released under the %MIT License%.'),
        notFound: { link: '/en/', linkText: 'Back to the docs' },
      },
    },
    ja: {
      label: '日本語', lang: 'ja', link: '/ja/',
      description: 'orchestrator に仕事を渡すと、herdr のコーディングエージェントを同時にいくつも動かします。',
      themeConfig: {
        nav: nav('ja'), sidebar: sidebar('ja'),
        editLink: editLink('GitHub でこのページを編集する'),
        footer: license('%MIT ライセンス%で公開しています。'),
        outline: { label: 'このページの内容' },
        docFooter: { prev: '前のページ', next: '次のページ' },
        darkModeSwitchLabel: '表示モード',
        lightModeSwitchTitle: 'ライトモードにする',
        darkModeSwitchTitle: 'ダークモードにする',
        sidebarMenuLabel: 'メニュー',
        returnToTopLabel: 'ページの先頭へ',
        langMenuLabel: '言語を切り替える',
        skipToContentLabel: '本文へ移動',
        notFound: {
          title: 'ページが見つかりません',
          quote: 'URL が変わったか、ページが無くなったようです。',
          link: '/ja/', linkLabel: 'ドキュメントのトップへ', linkText: 'ドキュメントのトップへ',
        },
      },
    },
  },
  // each page names its own URL and the same page's in the other language
  transformPageData(pageData) {
    const [lang, ...rest] = pageData.relativePath.split('/')
    if (!(LANGS as readonly string[]).includes(lang)) return
    const page = rest.join('/')
    const head: HeadConfig[] = (pageData.frontmatter.head ??= [])
    head.push(['link', { rel: 'canonical', href: url(lang as Lang, page) }])
    for (const [l, href] of alternates(page)) head.push(['link', { rel: 'alternate', hreflang: l, href }])
  },
  buildEnd(siteConfig) {
    const site = dirname(siteConfig.outDir) // site/dist
    cpSync(join(DOCS, '../static'), site, { recursive: true })
    cpSync(join(siteConfig.outDir, '404.html'), join(site, '404.html')) // Pages serves the root's for any missing path
    writeFileSync(join(site, 'sitemap.xml'), sitemap())
  },
})
