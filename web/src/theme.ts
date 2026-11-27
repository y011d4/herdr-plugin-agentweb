/** theme.ts — the Mantine theme: the app's look (style.css's colors, its 15px text) for Mantine's
 *  components, and the breakpoints Tailwind shares (app.css's @theme). theme.test.ts checks both
 *  against the CSS. Dark only: main.tsx's forceColorScheme, index.html's data-mantine-color-scheme.
 *  The root font size stays the browser's 16px (style.css sets 15px on the body, not on html), so
 *  Mantine's and Tailwind's rem sizes are their own, unscaled. */
import { Portal, colorsTuple, createTheme, rem } from '@mantine/core';

export const theme = createTheme({
  breakpoints: { xs: '36em', sm: '40em', md: '48em', lg: '64em', xl: '80em' },
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontFamilyMonospace: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
  fontSizes: { md: rem(15) },
  lineHeights: { md: '1.5' },
  colors: {
    // Mantine's dark scheme reads text from 0, dimmed 2, borders 4, inputs 6, its body (a modal's,
    // a menu's) 7: style.css's --color-text, -text-dim, -border, -surface-2, -surface; 8 is --color-bg.
    dark: ['#e2e4ea', '#c0c4d4', '#7b8099', '#5a5f72', '#2e3140', '#292c38', '#252830', '#1c1f26', '#111318', '#0b0c10'],
    accent: colorsTuple('#4f8ef7'), // --color-accent
  },
  primaryColor: 'accent',
  components: {
    // Mantine's portals (a modal, a menu's dropdown) go into #modal-root, above the app (index.html)
    Portal: Portal.extend({ defaultProps: { target: '#modal-root' } }),
  },
});

/** The PC layout's width: style.css's last block, and the sidebar (ui/App.tsx) with it; the lg
 *  breakpoint (64em). Below it, every phone, nothing changes. theme.test.ts checks all three agree. */
export const WIDE_QUERY = '(min-width: 1024px)';
