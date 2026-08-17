const SVG_NS = "http://www.w3.org/2000/svg";

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
  "             \\/_/               v1.2.0",
  "                                        ",
] as const;

const NULL_STATE_LOGO_VIEWBOX_WIDTH =
  Math.max(...NULL_STATE_LOGO_LINES.map((line) => line.length)) * CHAR_ADVANCE;
const NULL_STATE_LOGO_VIEWBOX_HEIGHT =
  NULL_STATE_LOGO_LINES.length * LINE_HEIGHT;

export function renderNullStateLogo(container: HTMLElement) {
  container.replaceChildren();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute(
    "viewBox",
    `0 0 ${NULL_STATE_LOGO_VIEWBOX_WIDTH} ${NULL_STATE_LOGO_VIEWBOX_HEIGHT}`,
  );
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("null-state-logo");

  const glyphLayer = document.createElementNS(SVG_NS, "g");
  glyphLayer.setAttribute("font-family", "JuliaMono, monospace");
  glyphLayer.setAttribute("font-size", String(FONT_SIZE));
  glyphLayer.setAttribute("font-weight", "300");
  glyphLayer.setAttribute("fill", "currentColor");

  NULL_STATE_LOGO_LINES.forEach((line, index) => {
    for (let column = 0; column < line.length; column++) {
      const glyph = line[column]!;
      if (glyph === " ") continue;
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(column * CHAR_ADVANCE));
      text.setAttribute("y", String(FONT_SIZE + index * LINE_HEIGHT));
      text.textContent = glyph;
      glyphLayer.appendChild(text);
    }
  });

  svg.appendChild(glyphLayer);
  container.appendChild(svg);
}
