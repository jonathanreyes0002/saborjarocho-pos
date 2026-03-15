/**
 * reports.js — Analytics and charting for Sabor Jarocho
 * All data read live from IndexedDB.
 */

import { getOrdersByDate, getDetallesByOrder, todayStr } from './db.js';

/* =====================================================
   EXISTING STATS (used by Reportes tab)
   ===================================================== */

export async function getTodayStats(date) {
  const d         = date || todayStr();
  const orders    = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const totalVentas        = completed.reduce((sum, o) => sum + (o.subtotal || 0), 0);
  const ordenesCompletadas = completed.length;
  const ticketPromedio     = ordenesCompletadas > 0 ? totalVentas / ordenesCompletadas : 0;

  const withTime         = completed.filter(o => o.tiempo_preparacion_min != null);
  const tiempoPrepPromedio = withTime.length > 0
    ? withTime.reduce((sum, o) => sum + o.tiempo_preparacion_min, 0) / withTime.length
    : 0;

  return { totalVentas, ordenesCompletadas, ticketPromedio, tiempoPrepPromedio: Math.round(tiempoPrepPromedio) };
}

export async function getTopItems(date) {
  const d         = date || todayStr();
  const orders    = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const counts = {};
  for (const order of completed) {
    const detalles = await getDetallesByOrder(order.id_orden);
    for (const d of detalles) {
      counts[d.articulo] = (counts[d.articulo] || 0) + (d.cantidad || 1);
    }
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nombre, cantidad], i) => ({ rank: i + 1, nombre, cantidad }));
}

export async function getHourlyRevenue(date) {
  const d         = date || todayStr();
  const orders    = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const hourly = new Array(24).fill(0);
  for (const order of completed) {
    const ts   = order.hora_completada || order.hora_orden;
    const hour = ts ? new Date(ts).getHours() : null;
    if (hour !== null) hourly[hour] += order.subtotal || 0;
  }
  return hourly;
}

/* =====================================================
   METRICS — PREP TIME STATS
   ===================================================== */

/**
 * Returns { lt10, b1020, gt20, total } as counts and percentages.
 * Uses hora_enviada_cocina → hora_completada diff.
 * Only includes cobrada orders with both timestamps set.
 */
export async function getPrepTimeStats(date) {
  const d         = date || todayStr();
  const orders    = await getOrdersByDate(d);
  const completed = orders.filter(
    o => o.estado === 'cobrada' && o.hora_enviada_cocina && o.hora_completada
  );

  let lt10 = 0, b1020 = 0, gt20 = 0;
  for (const o of completed) {
    const mins = (new Date(o.hora_completada) - new Date(o.hora_enviada_cocina)) / 60000;
    if (mins < 10)       lt10++;
    else if (mins <= 20) b1020++;
    else                 gt20++;
  }
  const total = completed.length;

  return {
    lt10,   lt10Pct:   total > 0 ? Math.round((lt10  / total) * 100) : 0,
    b1020,  b1020Pct:  total > 0 ? Math.round((b1020 / total) * 100) : 0,
    gt20,   gt20Pct:   total > 0 ? Math.round((gt20  / total) * 100) : 0,
    total
  };
}

/* =====================================================
   METRICS — SALES METRICS
   ===================================================== */

/**
 * Returns sales KPIs for a given date.
 * config: { metaVentas, metaLt10, metaBtwn }
 */
export async function getSalesMetrics(date) {
  const d         = date || todayStr();
  const orders    = await getOrdersByDate(d);
  const completed = orders.filter(o => o.estado === 'cobrada');

  const totalVentas        = completed.reduce((sum, o) => sum + (o.subtotal || 0), 0);
  const ordenesCompletadas = completed.length;
  const ticketPromedio     = ordenesCompletadas > 0 ? totalVentas / ordenesCompletadas : 0;

  // Hora pico: bucket by hour, find max
  const hourBuckets = {};
  for (const o of completed) {
    const ts = o.hora_completada || o.hora_orden;
    if (!ts) continue;
    const h = new Date(ts).getHours();
    hourBuckets[h] = (hourBuckets[h] || 0) + 1;
  }
  let horaPico = null;
  if (Object.keys(hourBuckets).length > 0) {
    const peakH = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0][0];
    const h     = parseInt(peakH, 10);
    const fmt   = (hr) => hr === 0 ? '12:00 AM' : hr < 12 ? `${hr}:00 AM` : hr === 12 ? '12:00 PM' : `${hr - 12}:00 PM`;
    horaPico    = `${fmt(h)} – ${fmt(h + 1)}`;
  }

  // Proyección: extrapolate revenue to end of day
  let proyeccion = null;
  if (completed.length > 0) {
    const timestamps = completed
      .map(o => o.hora_completada || o.hora_orden)
      .filter(Boolean)
      .map(ts => new Date(ts).getTime());
    const primerTs = Math.min(...timestamps);
    const now      = Date.now();
    const elapsed  = (now - primerTs) / 3600000; // hours
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 0, 0);
    const totalHours = (endOfDay.getTime() - primerTs) / 3600000;
    if (elapsed > 0.5) {
      proyeccion = (totalVentas / elapsed) * totalHours;
    }
  }

  return { totalVentas, ordenesCompletadas, ticketPromedio, horaPico, proyeccion };
}

/* =====================================================
   METRICS — WEEKLY SUMMARY (last 7 days)
   ===================================================== */

/**
 * Returns array[7] of { dateStr, label (Lun/Mar/...), total }
 * Index 0 = 6 days ago, index 6 = today.
 */
export async function getWeeklySummary() {
  const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const result = [];
  const now    = new Date();

  for (let i = 6; i >= 0; i--) {
    const d   = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const label   = DAY_LABELS[d.getDay()];

    const orders  = await getOrdersByDate(dateStr);
    const total   = orders
      .filter(o => o.estado === 'cobrada')
      .reduce((sum, o) => sum + (o.subtotal || 0), 0);

    result.push({ dateStr, label, total });
  }
  return result;  // [oldest, ..., today]
}

/* =====================================================
   CHARTS
   ===================================================== */

export function renderHourlyChart(canvasEl, hourlyData) {
  if (!canvasEl || !hourlyData) return;

  const dpr    = window.devicePixelRatio || 1;
  const width  = canvasEl.offsetWidth || 500;
  const height = 200;

  canvasEl.width        = width * dpr;
  canvasEl.height       = height * dpr;
  canvasEl.style.width  = width + 'px';
  canvasEl.style.height = height + 'px';

  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  const primaryColor = '#1A5276';
  const textColor    = '#5D6D7E';
  const gridColor    = 'rgba(0,0,0,0.06)';

  const padLeft = 58, padRight = 12, padTop = 10, padBottom = 28;
  const chartW  = width  - padLeft - padRight;
  const chartH  = height - padTop  - padBottom;
  const maxVal  = Math.max(...hourlyData, 1);

  for (let i = 0; i <= 4; i++) {
    const y = padTop + (chartH / 4) * i;
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + chartW, y); ctx.stroke();
    const val = maxVal * (1 - i / 4);
    ctx.fillStyle = textColor; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(val >= 1000 ? `$${(val / 1000).toFixed(1)}k` : `$${Math.round(val)}`, padLeft - 4, y + 4);
  }

  const activeHours = hourlyData.map((v, h) => ({ hour: h, val: v })).filter(x => x.val > 0);
  if (activeHours.length === 0) {
    ctx.fillStyle = textColor; ctx.font = '13px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Sin ventas', padLeft + chartW / 2, padTop + chartH / 2);
    return;
  }

  const minHour    = Math.min(...activeHours.map(h => h.hour), 6);
  const maxHour    = Math.max(...activeHours.map(h => h.hour), 22);
  const hoursToShow = maxHour - minHour + 1;
  const barWidth   = Math.max(2, (chartW / hoursToShow) * 0.65);
  const stepW      = chartW / hoursToShow;

  for (let i = 0; i < hoursToShow; i++) {
    const hour = minHour + i;
    const val  = hourlyData[hour] || 0;
    const barH = (val / maxVal) * chartH;
    const x    = padLeft + i * stepW + (stepW - barWidth) / 2;
    const y    = padTop + chartH - barH;

    if (val > 0) {
      ctx.fillStyle = primaryColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barWidth, barH, [3, 3, 0, 0]);
      else               ctx.rect(x, y, barWidth, barH);
      ctx.fill();
    }

    if (hoursToShow <= 10 || i % 2 === 0) {
      ctx.fillStyle = textColor; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'center';
      const label = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`;
      ctx.fillText(label, x + barWidth / 2, padTop + chartH + 14);
    }
  }
}

/**
 * Render weekly summary as a bar chart. todayIdx = 6 (last element is today).
 */
export function renderWeeklyChart(canvasEl, weeklyData) {
  if (!canvasEl || !weeklyData || weeklyData.length === 0) return;

  const dpr    = window.devicePixelRatio || 1;
  const width  = canvasEl.offsetWidth || 500;
  const height = 180;

  canvasEl.width        = width * dpr;
  canvasEl.height       = height * dpr;
  canvasEl.style.width  = width + 'px';
  canvasEl.style.height = height + 'px';

  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  const primaryColor  = '#1A5276';
  const pastColor     = '#A9C4DA';
  const textColor     = '#5D6D7E';
  const gridColor     = 'rgba(0,0,0,0.06)';

  const padLeft = 52, padRight = 10, padTop = 16, padBottom = 30;
  const chartW  = width  - padLeft - padRight;
  const chartH  = height - padTop  - padBottom;

  const maxVal  = Math.max(...weeklyData.map(d => d.total), 1);
  const n       = weeklyData.length;
  const barW    = Math.max(4, (chartW / n) * 0.55);
  const stepW   = chartW / n;

  // Grid
  for (let i = 0; i <= 3; i++) {
    const y = padTop + (chartH / 3) * i;
    ctx.strokeStyle = gridColor; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(padLeft + chartW, y); ctx.stroke();
    const val = maxVal * (1 - i / 3);
    ctx.fillStyle = textColor; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(val >= 1000 ? `$${(val / 1000).toFixed(1)}k` : `$${Math.round(val)}`, padLeft - 4, y + 4);
  }

  // Bars
  weeklyData.forEach((day, i) => {
    const isToday = i === n - 1;
    const barH    = day.total > 0 ? Math.max(4, (day.total / maxVal) * chartH) : 0;
    const x       = padLeft + i * stepW + (stepW - barW) / 2;
    const y       = padTop + chartH - barH;

    ctx.fillStyle = isToday ? primaryColor : pastColor;
    if (barH > 0) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
      else               ctx.rect(x, y, barW, barH);
      ctx.fill();
    }

    // Day label
    ctx.fillStyle = isToday ? primaryColor : textColor;
    ctx.font      = isToday ? `bold 10px -apple-system, sans-serif` : '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(day.label, x + barW / 2, padTop + chartH + 14);

    // Value on top of bar
    if (day.total > 0) {
      ctx.fillStyle = isToday ? primaryColor : textColor;
      ctx.font      = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      const label = day.total >= 1000 ? `$${(day.total / 1000).toFixed(1)}k` : `$${Math.round(day.total)}`;
      ctx.fillText(label, x + barW / 2, y - 3);
    }
  });
}
