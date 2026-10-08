const FONT_SIZE = 16;
const LINE_HEIGHT = 18;
const CHAR_ADVANCE = 9.6;

const NULL_STATE_LOGO_LINES = [
  "  ___                                   ",
  " /\\_ \\                   __             ",
  " \\//\\ \\   ______  __  __/\\_\\  _____     ",
  "   \\ \\ \\ /\\  __ \\/\\ \\/\\ \\/\\ \\/\\__  \\    ",
  "    \\_\\ \\\\ \\ \\_\\ \\ \\ \\_/ \\ \\ \\/_/  /_   ",
  "    /\\____\\ \\  __/\\ \\___/ \\ \\_\\/\\____\\  ",
  "    \\/____/\\ \\ \\/  \\/__/   \\/_/\\/____/  ",
  "            \\ \\_\\                       ",
  `             \\/_/               v${__APP_VERSION__}`,
  "                                        ",
] as const;

const NULL_STATE_LOGO_VIEWBOX_WIDTH = Math.max(...NULL_STATE_LOGO_LINES.map((line) => line.length)) * CHAR_ADVANCE;
const NULL_STATE_LOGO_VIEWBOX_HEIGHT = NULL_STATE_LOGO_LINES.length * LINE_HEIGHT;

// One <text> per non-space glyph. The glyphs are slashes, backslashes,
// underscores and the version string (no <, > or &), so nothing needs escaping.
// The version is the app package's, defined at build time (see vite.config.ts).
const GLYPHS = NULL_STATE_LOGO_LINES.map((line, row) =>
  Array.from(line)
    .map((glyph, column) => (glyph === " " ? "" : `<text x="${column * CHAR_ADVANCE}" y="${FONT_SIZE + row * LINE_HEIGHT}">${glyph}</text>`))
    .join(""),
).join("");
const NULL_STATE_LOGO_SVG = `<svg viewBox="0 0 ${NULL_STATE_LOGO_VIEWBOX_WIDTH} ${NULL_STATE_LOGO_VIEWBOX_HEIGHT}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" class="null-state-logo"><g font-family="JuliaMono, monospace" font-size="${FONT_SIZE}" font-weight="300" fill="currentColor">${GLYPHS}</g></svg>`;

export function renderNullStateLogo(container: HTMLElement) {
  container.innerHTML = NULL_STATE_LOGO_SVG;
}
