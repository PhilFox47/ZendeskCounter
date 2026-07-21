// Draws the toolbar icon as two stacked rates: solved/hr on top, replies/hr
// below, each to one decimal, in a progress color (see detect.progressColor).
// Uses OffscreenCanvas, which is available in both the service worker and pages,
// so the drawing can be verified/screenshotted outside the extension.

import { formatIconRate } from "./detect.js";

const BG = "#12222b"; // dark slate — bright text reads well on it at small sizes

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Pick the largest bold font (starting from startPx) whose text fits within
// maxWidth, so short values like "6.5" render big while "10.0" won't clip.
function fitFont(ctx, text, maxWidth, startPx) {
  let px = startPx;
  const font = (p) => `bold ${p}px "Arial", "Liberation Sans", sans-serif`;
  ctx.font = font(px);
  const w = ctx.measureText(text).width;
  if (w > maxWidth) px = Math.max(6, Math.floor((px * maxWidth) / w));
  ctx.font = font(px);
  return px;
}

/**
 * Draw the icon at a given pixel size.
 * @param {number} size
 * @param {{solvedRate:number, repliesRate:number, solvedColor:string, repliesColor:string}} r
 * @returns {ImageData}
 */
export function drawIcon(size, r) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);
  roundRectPath(ctx, 0, 0, size, size, size * 0.16);
  ctx.fillStyle = BG;
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const maxWidth = size * 0.9;
  const startPx = Math.round(size * 0.56); // ~18px at 32 — much larger than before
  const solvedText = formatIconRate(r.solvedRate);
  const repliesText = formatIconRate(r.repliesRate);

  fitFont(ctx, solvedText, maxWidth, startPx);
  ctx.fillStyle = r.solvedColor;
  ctx.fillText(solvedText, size / 2, size * 0.29);

  fitFont(ctx, repliesText, maxWidth, startPx);
  ctx.fillStyle = r.repliesColor;
  ctx.fillText(repliesText, size / 2, size * 0.71);

  return ctx.getImageData(0, 0, size, size);
}

/** ImageData for the sizes Chrome asks for, keyed by pixel size. */
export function makeIcons(rates) {
  return { 16: drawIcon(16, rates), 32: drawIcon(32, rates) };
}
