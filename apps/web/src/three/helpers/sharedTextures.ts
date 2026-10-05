import { CanvasTexture } from "three";

// A white sprite alpha map drawn at twice the device pixel ratio so it stays
// crisp at any point size; `draw` paints onto a cleared size x size canvas.
function spriteTexture(baseSize: number, draw: (context: CanvasRenderingContext2D, size: number) => void) {
  const deviceRatio = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const size = baseSize * deviceRatio * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create sprite texture context");
  }

  context.clearRect(0, 0, size, size);
  draw(context, size);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export const SHARED_CIRCLE_TEXTURE = spriteTexture(32, (context, size) => {
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(size / 2, size / 2, size * 0.44, 0, Math.PI * 2);
  context.fill();
});

export const SHARED_RING_TEXTURE = spriteTexture(32, (context, size) => {
  context.strokeStyle = "#ffffff";
  context.lineWidth = size * 0.11;
  context.beginPath();
  context.arc(size / 2, size / 2, size * 0.34, 0, Math.PI * 2);
  context.stroke();
});

export const SHARED_SQUARE_TEXTURE = spriteTexture(32, (context, size) => {
  context.fillStyle = "#ffffff";
  const inset = size * 0.06;
  context.fillRect(inset, inset, size - inset * 2, size - inset * 2);
});

export const SHARED_STAR_TEXTURE = spriteTexture(48, (context, size) => {
  const outerRadius = size * 0.38;
  const innerRadius = outerRadius * 0.47;
  const center = size / 2;

  context.fillStyle = "#ffffff";
  context.beginPath();
  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  context.closePath();
  context.fill();
});
