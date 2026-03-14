/**
 * reports.js — Analytics and charting for Sabor Jarocho
 * All data read live from IndexedDB.
 */

import { getOrdersByDate, getDetallesByOrder, todayStr } from './db.js';

/**
 * Get today's summary statistics.
 * Returns { totalVentas, ordenesCompletadas, ticketPromedio, tiempoPrepPromedio }
 */
export async function getTodayStats(date) {
  const d = date || todayStr();
  const orders = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const totalVentas = completed.reduce((sum, o) => sum + (o.subtotal || 0), 0);
  const ordenesCompletadas = completed.length;
  const ticketPromedio = ordenesCompletadas > 0 ? totalVentas / ordenesCompletadas : 0;

  const withTime = completed.filter(o => o.tiempo_preparacion_min != null);
  const tiempoPrepPromedio = withTime.length > 0
    ? withTime.reduce((sum, o) => sum + o.tiempo_preparacion_min, 0) / withTime.length
    : 0;

  return {
    totalVentas,
    ordenesCompletadas,
    ticketPromedio,
    tiempoPrepPromedio: Math.round(tiempoPrepPromedio)
  };
}

/**
 * Get top 5 items sold today by quantity.
 * Returns array of { rank, nombre, cantidad }
 */
export async function getTopItems(date) {
  const d = date || todayStr();
  const orders = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const counts = {};
  for (const order of completed) {
    const detalles = await getDetallesByOrder(order.id_orden);
    for (const d of detalles) {
      const key = d.articulo;
      counts[key] = (counts[key] || 0) + (d.cantidad || 1);
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nombre, cantidad], i) => ({ rank: i + 1, nombre, cantidad }));
}

/**
 * Get hourly revenue for today.
 * Returns array[24] with revenue per hour index.
 */
export async function getHourlyRevenue(date) {
  const d = date || todayStr();
  const orders = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const hourly = new Array(24).fill(0);
  for (const order of completed) {
    if (order.hora_completada) {
      const hour = new Date(order.hora_completada).getHours();
      hourly[hour] += order.subtotal || 0;
    } else if (order.hora_orden) {
      const hour = new Date(order.hora_orden).getHours();
      hourly[hour] += order.subtotal || 0;
    }
  }
  return hourly;
}

/**
 * Render hourly revenue as a bar chart on the given canvas element.
 * Uses pure Canvas 2D API — no external libraries.
 */
export function renderHourlyChart(canvasEl, hourlyData) {
  if (!canvasEl || !hourlyData) return;

  const dpr    = window.devicePixelRatio || 1;
  const width  = canvasEl.offsetWidth || 500;
  const height = 200;

  canvasEl.width  = width * dpr;
  canvasEl.height = height * dpr;
  canvasEl.style.width  = width + 'px';
  canvasEl.style.height = height + 'px';

  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  const primaryColor = '#1A5276';
  const textColor    = '#5D6D7E';
  const gridColor    = 'rgba(0,0,0,0.06)';

  // Padding
  const padLeft   = 58;
  const padRight  = 12;
  const padTop    = 10;
  const padBottom = 28;

  const chartW = width  - padLeft - padRight;
  const chartH = height - padTop  - padBottom;

  // Filter to hours with data
  const maxVal = Math.max(...hourlyData, 1);

  // Draw grid lines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth   = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padTop + (chartH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();

    // Y-axis labels
    const val = maxVal * (1 - i / gridLines);
    ctx.fillStyle = textColor;
    ctx.font      = `${10 * dpr / dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(
      val >= 1000 ? `$${(val / 1000).toFixed(1)}k` : `$${Math.round(val)}`,
      padLeft - 4,
      y + 4
    );
  }

  // Draw bars — only for hours 6–23 (typical restaurant hours)
  const activeHours = hourlyData
    .map((v, h) => ({ hour: h, val: v }))
    .filter(({ val }) => val > 0);

  if (activeHours.length === 0) {
    ctx.fillStyle = textColor;
    ctx.font      = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sin ventas hoy', padLeft + chartW / 2, padTop + chartH / 2);
    return;
  }

  // Show hours with activity (minimum 6am–10pm range)
  let minHour = Math.min(...activeHours.map(h => h.hour), 6);
  let maxHour = Math.max(...activeHours.map(h => h.hour), 22);
  const hoursToShow = maxHour - minHour + 1;

  const barWidth = Math.max(2, (chartW / hoursToShow) * 0.65);
  const stepW    = chartW / hoursToShow;

  for (let i = 0; i < hoursToShow; i++) {
    const hour  = minHour + i;
    const val   = hourlyData[hour] || 0;
    const barH  = (val / maxVal) * chartH;
    const x     = padLeft + i * stepW + (stepW - barWidth) / 2;
    const y     = padTop + chartH - barH;

    if (val > 0) {
      ctx.fillStyle = primaryColor;
      ctx.beginPath();
      ctx.roundRect
        ? ctx.roundRect(x, y, barWidth, barH, [3, 3, 0, 0])
        : ctx.rect(x, y, barWidth, barH);
      ctx.fill();
    }

    // X-axis labels (every 2 hours or all if few)
    if (hoursToShow <= 10 || i % 2 === 0) {
      ctx.fillStyle = textColor;
      ctx.font      = '10px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const label   = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`;
      ctx.fillText(label, x + barWidth / 2, padTop + chartH + 14);
    }
  }
}
