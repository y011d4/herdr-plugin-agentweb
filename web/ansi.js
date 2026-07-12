/**
 * ansi.js — ANSI SGR escape sequence renderer
 *
 * Pure ES module, no browser globals at import time (safe for node --check and
 * future node unit tests).
 *
 * Exported function: ansiToHtml(str) → safe HTML string
 *
 * Supported SGR codes:
 *   0        reset
 *   1        bold
 *   2        dim
 *   3        italic
 *   4        underline
 *   7        inverse (swap fg/bg)
 *   30-37    fg standard (dark)
 *   39       fg default
 *   40-47    bg standard (dark)
 *   49       bg default
 *   90-97    fg bright
 *   100-107  bg bright
 *   38;5;n   fg 256-color xterm palette
 *   48;5;n   bg 256-color xterm palette
 *   38;2;r;g;b  fg truecolor
 *   48;2;r;g;b  bg truecolor
 *
 * All other CSI/OSC/control sequences are stripped.
 */

// Standard 16-color palette (index 0-15)
// Indices 0-7: standard; 8-15: bright/high-intensity
const ANSI_PALETTE_16 = [
  '#000000', '#aa0000', '#00aa00', '#aa5500',
  '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
  '#555555', '#ff5555', '#55ff55', '#ffff55',
  '#5555ff', '#ff55ff', '#55ffff', '#ffffff',
];

/**
 * Compute the color string for an xterm-256 palette index.
 * 0-15: standard 16 colors
 * 16-231: 6x6x6 color cube
 * 232-255: grayscale ramp
 */
function xterm256Color(n) {
  if (n < 16) return ANSI_PALETTE_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  const idx = n - 16;
  const b = idx % 6;
  const g = Math.floor(idx / 6) % 6;
  const r = Math.floor(idx / 36);
  const toHex = (c) => (c === 0 ? '00' : (55 + c * 40).toString(16).padStart(2, '0'));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Named fg colors for the 16-color set (class names used in CSS)
// We use inline styles throughout for simplicity and correctness with 256/truecolor.
function fgColor(idx) {
  return ANSI_PALETTE_16[idx] ?? null;
}
function bgColor(idx) {
  return ANSI_PALETTE_16[idx] ?? null;
}

const DEFAULT_FG = null;
const DEFAULT_BG = null;

/**
 * HTML-escape text content (must be called on raw text, not on spans).
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build inline style + class string for a span from current SGR state.
 */
function buildSpanStyle(state) {
  const parts = [];
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    // swap; use defaults when null
    const tmpFg = fg ?? '#aaaaaa';
    fg = bg ?? '#000000';
    bg = tmpFg;
  }
  if (fg !== null) parts.push(`color:${fg}`);
  if (bg !== null) parts.push(`background:${bg}`);
  if (state.bold) parts.push('font-weight:bold');
  if (state.dim) parts.push('opacity:0.6');
  if (state.italic) parts.push('font-style:italic');
  if (state.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

function makeState() {
  return { fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function resetState(s) {
  s.fg = DEFAULT_FG;
  s.bg = DEFAULT_BG;
  s.bold = false;
  s.dim = false;
  s.italic = false;
  s.underline = false;
  s.inverse = false;
}

/**
 * Apply a list of numeric SGR params to the current state object.
 * Handles compound sequences like 38;5;n and 38;2;r;g;b.
 */
function applySgr(params, state) {
  let i = 0;
  while (i < params.length) {
    const p = params[i];
    if (p === 0 || p === undefined) {
      resetState(state);
    } else if (p === 1) {
      state.bold = true;
    } else if (p === 2) {
      state.dim = true;
    } else if (p === 3) {
      state.italic = true;
    } else if (p === 4) {
      state.underline = true;
    } else if (p === 7) {
      state.inverse = true;
    } else if (p === 22) {
      state.bold = false;
      state.dim = false;
    } else if (p === 23) {
      state.italic = false;
    } else if (p === 24) {
      state.underline = false;
    } else if (p === 27) {
      state.inverse = false;
    } else if (p >= 30 && p <= 37) {
      state.fg = fgColor(p - 30);
    } else if (p === 38) {
      const mode = params[i + 1];
      if (mode === 5) {
        state.fg = xterm256Color(params[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        const r = params[i + 2] ?? 0;
        const g = params[i + 3] ?? 0;
        const b = params[i + 4] ?? 0;
        state.fg = `rgb(${r},${g},${b})`;
        i += 4;
      }
    } else if (p === 39) {
      state.fg = DEFAULT_FG;
    } else if (p >= 40 && p <= 47) {
      state.bg = bgColor(p - 40);
    } else if (p === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        state.bg = xterm256Color(params[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        const r = params[i + 2] ?? 0;
        const g = params[i + 3] ?? 0;
        const b = params[i + 4] ?? 0;
        state.bg = `rgb(${r},${g},${b})`;
        i += 4;
      }
    } else if (p === 49) {
      state.bg = DEFAULT_BG;
    } else if (p >= 90 && p <= 97) {
      state.fg = fgColor(p - 90 + 8);
    } else if (p >= 100 && p <= 107) {
      state.bg = bgColor(p - 100 + 8);
    }
    i++;
  }
}

/**
 * Returns true if the SGR state has any active styling.
 */
function isStyled(state) {
  return (
    state.fg !== null ||
    state.bg !== null ||
    state.bold ||
    state.dim ||
    state.italic ||
    state.underline ||
    state.inverse
  );
}

/**
 * Convert an ANSI-escaped string to an HTML string.
 * Text nodes are HTML-escaped. ANSI SGR sequences produce <span style="..."> wrappers.
 * All other control sequences (cursor movement, OSC, etc.) are stripped silently.
 *
 * @param {string} str - Input string potentially containing ANSI escape sequences
 * @returns {string} HTML string safe for innerHTML assignment
 */
export function ansiToHtml(str) {
  // Matches:
  //   ESC [ <params> <final>   — CSI sequence
  //   ESC ] <text> (BEL | ST) — OSC sequence
  //   ESC <char>               — other two-character ESC sequences
  //   raw control chars we want to strip (except \n, \r which become literal)
  const ESC = '\x1b';

  let html = '';
  const state = makeState();
  let i = 0;

  // We track whether we have an open span
  let spanOpen = false;

  const flushSpan = () => {
    if (spanOpen) {
      html += '</span>';
      spanOpen = false;
    }
  };

  const ensureSpan = () => {
    if (!spanOpen && isStyled(state)) {
      const style = buildSpanStyle(state);
      html += style ? `<span style="${style}">` : '<span>';
      spanOpen = true;
    }
  };

  while (i < str.length) {
    const ch = str[i];

    if (ch === ESC) {
      const next = str[i + 1];
      if (next === '[') {
        // CSI sequence: ESC [ <param bytes> <intermediate bytes> <final byte>
        // param bytes: 0x30-0x3f, intermediate: 0x20-0x2f, final: 0x40-0x7e
        let j = i + 2;
        // collect param + intermediate bytes
        while (j < str.length && str.charCodeAt(j) >= 0x20 && str.charCodeAt(j) <= 0x3f) j++;
        // final byte
        const finalByte = str[j];
        const seqInner = str.slice(i + 2, j);
        if (finalByte === 'm') {
          // SGR — parse and apply
          flushSpan();
          const paramStr = seqInner;
          const params = paramStr === '' ? [0] : paramStr.split(';').map((s) => (s === '' ? 0 : parseInt(s, 10)));
          applySgr(params, state);
        }
        // Skip the whole sequence (including final byte if present)
        i = finalByte !== undefined ? j + 1 : j;
      } else if (next === ']') {
        // OSC sequence: ESC ] ... BEL or ESC \
        let j = i + 2;
        while (j < str.length) {
          if (str[j] === '\x07') { j++; break; }
          if (str[j] === ESC && str[j + 1] === '\\') { j += 2; break; }
          j++;
        }
        i = j;
      } else if (next !== undefined) {
        // Other two-char ESC sequences — strip both
        i += 2;
      } else {
        // Lone ESC at end — skip
        i++;
      }
    } else if (ch === '\r') {
      // carriage return — skip (terminals handle this by overwriting; we just drop it)
      i++;
    } else if (ch === '\n') {
      flushSpan();
      html += '\n';
      i++;
    } else if (ch.charCodeAt(0) < 0x20 && ch !== '\t') {
      // other control characters — strip
      i++;
    } else {
      // Regular text character
      ensureSpan();
      html += escapeHtml(ch);
      i++;
    }
  }

  flushSpan();
  return html;
}
