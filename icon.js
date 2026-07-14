// Draws the toolbar icon as two stacked rates: solved/hr on top, replies/hr
// below, each to one decimal, colored by whether the target is met.
// Uses OffscreenCanvas, which is available in both the service worker and pages,
// so the drawing can be verified/screenshotted outside the extension.

import { formatRate } from "./detect.js";

const BG = "#12222b"; // dark slate — bright text reads well on it at small sizes
const ON_TARGET = "#3ad07a"; // green
const BELOW = "#ffb020"; // amber

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

/**
 * Draw the icon at a given pixel size.
 * @param {number} size
 * @param {{solvedRate:number, repliesRate:number, solvedOnTarget:boolean, repliesOnTarget:boolean}} r
 * @returns {ImageData}
 */
export function drawIcon(size, r) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);
  roundRectPath(ctx, 0, 0, size, size, size * 0.2);
  ctx.fillStyle = BG;
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(size * 0.42)}px "Arial", "Liberation Sans", sans-serif`;

  ctx.fillStyle = r.solvedOnTarget ? ON_TARGET : BELOW;
  ctx.fillText(formatRate(r.solvedRate), size / 2, size * 0.3);

  ctx.fillStyle = r.repliesOnTarget ? ON_TARGET : BELOW;
  ctx.fillText(formatRate(r.repliesRate), size / 2, size * 0.72);

  return ctx.getImageData(0, 0, size, size);
}

/** ImageData for the sizes Chrome asks for, keyed by pixel size. */
export function makeIcons(rates) {
  return { 16: drawIcon(16, rates), 32: drawIcon(32, rates) };
}
