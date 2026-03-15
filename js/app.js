/**
 * app.js — Main controller for Sabor Jarocho PWA  v1.2
 */

import {
  openDB, saveOrder, updateOrder, getOrder, getOpenOrders,
  saveDetalle, getDetallesByOrder, deleteDetallesByOrder,
  getMenuItems, saveMenuItem, updateMenuItem, deleteMenuItem,
  getMenuItemById, snapshotInProgress, recoverOrders,
  generateFolio, todayStr, getOrdersByDate,
  getKitchenOrders, migratePricesV2, dedupMenuItems, isPieceCategory
} from './db.js';
import { broadcast, listenSync } from './sync.js';
import {
  connectGoogle, getToken, isConnected, disconnectGoogle,
  sendTicket, backupToDrive, buildBackupCSV
} from './google.js';
import {
  getTodayStats, getTopItems, getHourlyRevenue, renderHourlyChart,
  getPrepTimeStats, getSalesMetrics, getWeeklySummary, renderWeeklyChart
} from './reports.js';

/* =====================================================
   STATE
   ===================================================== */
let currentOrderId    = null;
let currentOrderItems = [];
let adminUnlocked     = false;
let kitchenTimer      = null;
let discountPct       = 0;
let historialTimer    = null;
let metricasTimer     = null;

const pieceQty = {};   // { [id_articulo]: number } — qty selector in menu panel

/* =====================================================
   CONFIG HELPERS
   ===================================================== */
function getSJConfig() {
  try { return JSON.parse(localStorage.getItem('sj_config') || '{}'); } catch { return {}; }
}
function saveSJConfig(updates) {
  const cfg = getSJConfig();
  localStorage.setItem('sj_config', JSON.stringify({ ...cfg, ...updates }));
}
function getCfg(key, def) {
  const v = getSJConfig()[key];
  return (v !== undefined && v !== null && v !== '') ? v : def;
}

/* =====================================================
   INIT
   ===================================================== */
async function init() {
  // PIN migration — enforce exactly 4 digits
  const pinMeta = localStorage.getItem('sj_pin_length');
  if (!pinMeta || pinMeta !== '4') {
    localStorage.removeItem('sj_admin_pin');
    localStorage.setItem('sj_pin_length', '4');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch(() => {});
  }

  if (screen.orientation && typeof screen.orientation.lock === 'function') {
    screen.orientation.lock('landscape').catch(() => {});
  }

  await openDB();

  await migratePricesV2();

  // One-time deduplication
  if (!localStorage.getItem('sj_dedup_done')) {
    await dedupMenuItems();
    localStorage.setItem('sj_dedup_done', 'true');
  }

  const recovered = await recoverOrders();
  if (recovered > 0) {
    showBanner('banner-recovery',
      `Se recuperaron ${recovered} órden${recovered > 1 ? 'es' : ''} de la sesión anterior.`);
  }

  await checkPriceWarning();

  if (!localStorage.getItem('sj_first_launch_done')) {
    showModal('modal-first-launch');
  }

  route();
}

/* =====================================================
   ROUTING
   ===================================================== */
function route() {
  const params = new URLSearchParams(window.location.search);
  const view   = params.get('view');
  const mesa   = params.get('mesa');

  if      (view === 'cocina') renderKitchen();
  else if (view === 'admin')  renderAdmin();
  else if (mesa)              renderOrderCapture(parseInt(mesa, 10));
  else                        renderHome();
}

function navigate(url) { window.location.assign(url); }

/* =====================================================
   BANNERS
   ===================================================== */
async function checkPriceWarning() {
  try {
    const items = await getMenuItems({ activo: true });
    if (items.some(i => i.precio_completo === 0)) {
      showBanner('banner-price-warning',
        '⚠️ Hay artículos sin precio. Configúralos en Admin → Menú antes de operar.');
    }
  } catch {}
}

function showBanner(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const textEl = el.querySelector('.banner-text');
  if (textEl) textEl.textContent = text;
  el.classList.remove('hidden');
}

/* =====================================================
   MODAL / TOAST HELPERS
   ===================================================== */
function showModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id)?.classList.add('hidden'); }

function showConfirm(message, onConfirm, dangerLabel = 'Confirmar') {
  const modal = document.getElementById('modal-confirm');
  if (!modal) return;
  modal.querySelector('.confirm-message').textContent = message;
  const okBtn = modal.querySelector('.btn-confirm-ok');
  okBtn.textContent = dangerLabel;
  okBtn.onclick = () => { hideModal('modal-confirm'); onConfirm(); };
  modal.querySelector('.btn-confirm-cancel').onclick = () => hideModal('modal-confirm');
  showModal('modal-confirm');
}

function showToast(message, duration = 3000) {
  let toast = document.getElementById('sj-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sj-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999;pointer-events:none;transition:opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

/* =====================================================
   VIEW: HOME
   ===================================================== */
async function renderHome() {
  showView('view-home');

  const sentEmail = localStorage.getItem('sj_ticket_just_sent');
  if (sentEmail) {
    localStorage.removeItem('sj_ticket_just_sent');
    showToast(`Ticket enviado a ${sentEmail}`);
  }

  const grid = document.getElementById('tables-grid');
  if (!grid) return;

  const orders = await getOpenOrders();
  if (orders.length === 0) {
    grid.innerHTML = '<div class="empty-state">No hay mesas abiertas.<br>Toca <strong>+ Nueva mesa</strong> para comenzar.</div>';
    return;
  }

  grid.innerHTML = orders.map(o => {
    const snap      = localStorage.getItem('sj_hold_' + o.id_orden);
    const items     = snap ? JSON.parse(snap) : [];
    const itemCount = items.reduce((s, l) => s + (l.qty || 1), 0);
    const subtotal  = snap ? calcSubtotalFromItems(items) : (o.subtotal || 0);
    return `
      <div class="table-card status-${o.estado}" data-order-id="${o.id_orden}">
        <div class="table-card-name">${esc(o.nombre_mesa)}</div>
        <div class="table-card-status">${statusLabel(o.estado)}</div>
        <div class="table-card-info">${itemCount} artículo${itemCount !== 1 ? 's' : ''} · $${subtotal.toFixed(2)}</div>
      </div>`;
  }).join('');
}

function calcSubtotalFromItems(items) {
  return items.reduce((sum, line) => {
    const price = line.porcion === 'media'
      ? (line.item.precio_media  || 0)
      : (line.item.precio_completo || 0);
    return sum + price * (line.qty || 1);
  }, 0);
}

/* =====================================================
   VIEW: ORDER CAPTURE
   ===================================================== */
async function renderOrderCapture(orderId) {
  showView('view-order');
  currentOrderId = orderId;

  const order = await getOrder(orderId);
  if (!order) { navigate('./index.html'); return; }

  const snap = localStorage.getItem('sj_hold_' + orderId);
  if (snap && (order.estado === 'pendiente' || order.estado === 'hold')) {
    try { currentOrderItems = JSON.parse(snap); } catch { currentOrderItems = []; }
  } else {
    currentOrderItems = [];
  }

  const nameEl = document.getElementById('order-mesa-name');
  if (nameEl) nameEl.textContent = order.nombre_mesa;
  const badge = document.getElementById('order-status-badge');
  if (badge) {
    badge.textContent = statusLabel(order.estado);
    badge.className   = 'status-badge ' + statusClass(order.estado);
  }

  await renderMenuPanel();
  renderOrderPanel();
}

async function renderMenuPanel() {
  const scroll = document.getElementById('menu-scroll');
  if (!scroll) return;

  const items = await getMenuItems({ activo: true });
  if (items.length === 0) {
    scroll.innerHTML = '<div class="empty-state">No hay artículos en el menú.<br>Agrégalos en Admin → Menú.</div>';
    return;
  }

  const cats = {};
  for (const item of items) {
    if (!cats[item.categoria]) cats[item.categoria] = [];
    cats[item.categoria].push(item);
  }

  scroll.innerHTML = Object.entries(cats).map(([cat, catItems]) => {
    const ispiece = isPieceCategory(cat);
    const isBebida = cat === 'Bebidas';

    const itemsHtml = catItems.map(item => {
      const id    = item.id_articulo;
      const price = item.precio_completo || 0;

      if (ispiece) {
        const qty = pieceQty[id] || 1;
        return `
          <div class="piece-row">
            <div>
              <div class="piece-item-name">${esc(item.nombre)}</div>
              <div class="piece-item-price">$${price.toFixed(2)} / pz</div>
            </div>
            <div class="piece-controls">
              <button class="btn-piece-dec" data-item-id="${id}">−</button>
              <span class="piece-count" id="pc-${id}">${qty}</span>
              <button class="btn-piece-inc" data-item-id="${id}">+</button>
              <button class="btn-add-pieces" data-item-id="${id}">Agregar ${qty} pz</button>
            </div>
          </div>`;
      }

      const porcion = isBebida ? 'unidad' : 'completa';
      const label   = isBebida ? '1 unidad' : '1 orden';
      return `
        <div class="menu-item-row">
          <div class="menu-item-name">${esc(item.nombre)}</div>
          <div class="menu-item-prices">
            <button class="btn-add-item btn-add-full"
              data-item-id="${id}" data-porcion="${porcion}">
              ${label} — $${price.toFixed(2)}
            </button>
            ${item.tiene_media && !isBebida ? `
            <button class="btn-add-item btn-add-media"
              data-item-id="${id}" data-porcion="media">
              ½ orden — $${(item.precio_media || 0).toFixed(2)}
            </button>` : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="menu-category">
        <div class="menu-category-title">${esc(cat)}</div>
        ${itemsHtml}
      </div>`;
  }).join('');
}

function updatePieceRow(itemId) {
  const qty     = pieceQty[itemId] || 1;
  const countEl = document.getElementById('pc-' + itemId);
  if (countEl) countEl.textContent = qty;
  const addBtn = document.querySelector(`.btn-add-pieces[data-item-id="${itemId}"]`);
  if (addBtn) addBtn.textContent = `Agregar ${qty} pz`;
}

function renderOrderPanel() {
  const scroll = document.getElementById('order-scroll');
  if (!scroll) return;

  if (currentOrderItems.length === 0) {
    scroll.innerHTML = '<div class="empty-state" style="padding:24px 16px;text-align:center;color:var(--text-secondary)">Toca los artículos del menú para agregar.</div>';
  } else {
    scroll.innerHTML = currentOrderItems.map((line, idx) => {
      const isUnidad  = line.porcion === 'unidad';
      const isMedia   = line.porcion === 'media';
      const isPiece   = line.isPiece;
      const qty       = line.qty || 1;
      const price     = isMedia ? (line.item.precio_media || 0) : (line.item.precio_completo || 0);
      const lineTotal = price * qty;

      let badgeText  = isUnidad ? '1 unidad' : (isMedia ? '½ orden' : '1 orden');
      let badgeClass = isMedia ? 'portion-media' : 'portion-completa';
      if (isPiece) { badgeText = `${qty} pz`; badgeClass = 'piezas-badge'; }

      return `
        <div class="order-item-block">
          <div class="order-item-row">
            <div class="order-item-left">
              <span class="portion-badge ${badgeClass}">${badgeText}</span>
              <span class="order-item-name">${esc(line.item.nombre)}</span>
            </div>
            <div class="order-item-right">
              <span class="order-item-price">$${lineTotal.toFixed(2)}</span>
              ${!isPiece ? `
              <div class="qty-controls">
                <button class="qty-btn btn-qty-dec" data-idx="${idx}">−</button>
                <span class="qty-value">${qty}</span>
                <button class="qty-btn btn-qty-inc" data-idx="${idx}">+</button>
              </div>` : ''}
              <button class="btn-remove-item" data-idx="${idx}" aria-label="Quitar">×</button>
            </div>
          </div>
          <input type="text" class="item-notes-input" data-line-idx="${idx}"
            value="${escAttr(line.notas || '')}"
            placeholder="Notas: sin cebolla, sin salsa..."
            maxlength="100">
        </div>`;
    }).join('');
  }

  const subtotal    = calcSubtotal();
  const totalCount  = currentOrderItems.reduce((s, l) => s + (l.qty || 1), 0);
  const countEl     = document.getElementById('order-item-count');
  const totalEl     = document.getElementById('order-subtotal');
  if (countEl) countEl.textContent = `${totalCount} artículo${totalCount !== 1 ? 's' : ''}`;
  if (totalEl) totalEl.textContent = `$${subtotal.toFixed(2)}`;
}

function calcSubtotal() { return calcSubtotalFromItems(currentOrderItems); }

function saveOrderSnapshot(orderId) {
  if (!orderId) return;
  localStorage.setItem('sj_hold_' + orderId, JSON.stringify(currentOrderItems));
}

async function addItemToOrder(itemId, porcion, qty = 1) {
  const item = await getMenuItemById(itemId);
  if (!item) return;

  const piece = isPieceCategory(item.categoria);

  if (piece) {
    const existing = currentOrderItems.find(l => l.item.id_articulo === itemId);
    if (existing) {
      existing.qty = (existing.qty || 1) + qty;
    } else {
      currentOrderItems.push({ item, porcion: 'completa', qty, notas: '', isPiece: true });
    }
  } else {
    const existing = currentOrderItems.find(l => l.item.id_articulo === itemId && l.porcion === porcion);
    if (existing) {
      existing.qty = (existing.qty || 1) + 1;
    } else {
      currentOrderItems.push({ item, porcion, qty: 1, notas: '', isPiece: false });
    }
  }

  await updateOrder(currentOrderId, { subtotal: calcSubtotal() });
  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

async function removeItemFromOrder(idx) {
  currentOrderItems.splice(idx, 1);
  await updateOrder(currentOrderId, { subtotal: calcSubtotal() });
  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

async function adjustQty(idx, delta) {
  const line = currentOrderItems[idx];
  if (!line) return;
  line.qty = Math.max(1, (line.qty || 1) + delta);
  await updateOrder(currentOrderId, { subtotal: calcSubtotal() });
  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

/* =====================================================
   HOLD TABLE / BACK ACTION SHEET
   ===================================================== */
async function holdTable() {
  if (!currentOrderId) return;
  saveOrderSnapshot(currentOrderId);
  await updateOrder(currentOrderId, { estado: 'hold', subtotal: calcSubtotal() });
  await snapshotInProgress();
  broadcast({ type: 'ORDER_HOLD', orderId: currentOrderId });
  navigate('./index.html');
}

function showBackActionSheet() {
  const existing = document.getElementById('sj-action-sheet-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'sj-action-sheet-overlay';
  overlay.className = 'action-sheet-overlay';
  overlay.innerHTML = `
    <div class="action-sheet">
      <button class="action-sheet-btn" id="as-hold">Poner en espera</button>
      <button class="action-sheet-btn action-sheet-btn-danger" id="as-cancel">Cancelar mesa</button>
      <button class="action-sheet-btn action-sheet-btn-secondary" id="as-continue">Seguir capturando</button>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('as-hold').onclick = () => { overlay.remove(); holdTable(); };
  document.getElementById('as-cancel').onclick = () => {
    overlay.remove();
    showConfirm('¿Cancelar esta mesa? Se perderán todos los artículos.', async () => {
      localStorage.removeItem('sj_hold_' + currentOrderId);
      await updateOrder(currentOrderId, { estado: 'cancelada' });
      await snapshotInProgress();
      broadcast({ type: 'ORDER_CANCELLED', orderId: currentOrderId });
      navigate('./index.html');
    }, 'Cancelar mesa');
  };
  document.getElementById('as-continue').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/* =====================================================
   CHECKOUT
   ===================================================== */
function getEffectiveTotal() { return calcSubtotal() * (1 - discountPct / 100); }

function openCheckout() {
  discountPct = 0;
  document.querySelectorAll('.discount-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.pct === '0');
  });
  document.getElementById('discount-reason-row')?.classList.add('hidden');
  const dr = document.getElementById('discount-reason');
  if (dr) dr.value = '';
  document.getElementById('discount-error')?.classList.add('hidden');
  document.getElementById('checkout-totals-breakdown')?.classList.add('hidden');

  const emailEl = document.getElementById('customer-email');
  const phoneEl = document.getElementById('customer-phone');
  if (emailEl) emailEl.value = '';
  if (phoneEl) phoneEl.value = '';
  document.getElementById('customer-phone-error')?.classList.add('hidden');

  const listEl = document.querySelector('.checkout-items-list');
  if (listEl) {
    listEl.innerHTML = currentOrderItems.map(line => {
      const isMedia  = line.porcion === 'media';
      const isUnidad = line.porcion === 'unidad';
      const isPiece  = line.isPiece;
      const label    = isPiece ? `${line.qty || 1} pz` : (isUnidad ? '1 unidad' : (isMedia ? '½ ord.' : '1 ord.'));
      const price    = isMedia ? (line.item.precio_media || 0) : (line.item.precio_completo || 0);
      return `<div class="checkout-item-row">
        <span>${esc(line.item.nombre)} <span class="checkout-item-qty">${label}</span></span>
        <span>$${(price * (line.qty || 1)).toFixed(2)}</span>
      </div>`;
    }).join('');
  }

  const subEl = document.getElementById('checkout-subtotal-amount');
  if (subEl) subEl.textContent = `$${calcSubtotal().toFixed(2)}`;

  cashInput = '';
  updateCashDisplay();

  document.querySelectorAll('.payment-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === 'efectivo');
  });
  document.querySelectorAll('.payment-section').forEach(s => {
    s.classList.toggle('hidden', s.dataset.method !== 'efectivo');
  });

  const confirmBtn = document.getElementById('btn-confirm-payment');
  if (confirmBtn) confirmBtn.disabled = true;
  updateCardTotal();
  showModal('modal-checkout');
}

function updateDiscountBreakdown() {
  const subtotal       = calcSubtotal();
  const discountAmount = subtotal * (discountPct / 100);
  const total          = subtotal - discountAmount;
  const breakdown      = document.getElementById('checkout-totals-breakdown');
  if (discountPct > 0) {
    breakdown?.classList.remove('hidden');
    const lbl = document.getElementById('totals-discount-label');
    const sub = document.getElementById('totals-subtotal-val');
    const dis = document.getElementById('totals-discount-amount');
    const tot = document.getElementById('totals-total-val');
    if (lbl) lbl.textContent = `Descuento (${discountPct}%)`;
    if (sub) sub.textContent = `$${subtotal.toFixed(2)}`;
    if (dis) dis.textContent = `-$${discountAmount.toFixed(2)}`;
    if (tot) tot.textContent = `$${total.toFixed(2)}`;
  } else {
    breakdown?.classList.add('hidden');
  }
  updateCashDisplay();
  updateCardTotal();
}

function updateCardTotal() {
  const el = document.getElementById('card-total-amount');
  if (el) el.textContent = `$${getEffectiveTotal().toFixed(2)}`;
}

/* =====================================================
   CASH NUMPAD
   ===================================================== */
let cashInput = '';

function updateCashDisplay() {
  const total      = getEffectiveTotal();
  const totalCents = Math.round(total * 100);
  const inputCents = parseInt(cashInput || '0', 10);
  const displayEl  = document.getElementById('cash-amount-display');
  if (displayEl) displayEl.textContent = `$${(inputCents / 100).toFixed(2)}`;
  const cambioEl   = document.getElementById('cambio-display');
  const confirmBtn = document.getElementById('btn-confirm-payment');
  if (inputCents >= totalCents) {
    const cambio = (inputCents - totalCents) / 100;
    if (cambioEl) { cambioEl.textContent = `Cambio: $${cambio.toFixed(2)}`; cambioEl.className = 'cambio-display cambio-ok'; }
    if (confirmBtn) confirmBtn.disabled = false;
  } else {
    const faltan = (totalCents - inputCents) / 100;
    if (cambioEl) { cambioEl.textContent = `Faltan: $${faltan.toFixed(2)}`; cambioEl.className = 'cambio-display cambio-insuf'; }
    if (confirmBtn) confirmBtn.disabled = true;
  }
}

/* =====================================================
   CONFIRM PAYMENT (pay-first flow)
   ===================================================== */
async function confirmPayment() {
  const order = await getOrder(currentOrderId);
  if (!order) return;

  if (discountPct > 0) {
    const reasonEl = document.getElementById('discount-reason');
    const reason   = (reasonEl ? reasonEl.value : '').trim();
    if (!reason) {
      const errEl = document.getElementById('discount-error');
      if (errEl) { errEl.textContent = 'Escribe el motivo del descuento.'; errEl.classList.remove('hidden'); }
      return;
    }
  }

  const phoneEl  = document.getElementById('customer-phone');
  const phoneRaw = phoneEl ? phoneEl.value.replace(/\D/g, '') : '';
  if (phoneRaw && phoneRaw.length !== 10) {
    const errEl = document.getElementById('customer-phone-error');
    if (errEl) { errEl.textContent = 'El teléfono debe tener 10 dígitos.'; errEl.classList.remove('hidden'); }
    return;
  }

  const activeMethodBtn  = document.querySelector('.payment-toggle-btn.active');
  const method           = activeMethodBtn ? activeMethodBtn.dataset.method : 'efectivo';
  const effectiveTotal   = getEffectiveTotal();
  const subtotal         = calcSubtotal();
  const discountAmount   = subtotal * (discountPct / 100);
  let   efectivoRecibido = null;
  let   cambio           = null;
  if (method === 'efectivo') {
    efectivoRecibido = parseInt(cashInput || '0', 10) / 100;
    cambio           = efectivoRecibido - effectiveTotal;
  }

  const emailEl    = document.getElementById('customer-email');
  const clienteEmail = (emailEl ? emailEl.value.trim() : '') || null;
  const clientePhone = phoneRaw || null;
  const reasonEl2  = document.getElementById('discount-reason');
  const discMotivo = discountPct > 0 ? ((reasonEl2 ? reasonEl2.value.trim() : '') || null) : null;
  const folio      = generateFolio();
  const now        = new Date().toISOString();

  await updateOrder(currentOrderId, {
    estado:              'cobrada',
    subtotal:            effectiveTotal,
    metodo_pago:         method,
    efectivo_recibido:   efectivoRecibido,
    cambio,
    hora_enviada_cocina: now,
    hora_completada:     null,
    folio,
    cliente_email:       clienteEmail,
    cliente_telefono:    clientePhone,
    descuento_pct:       discountPct,
    descuento_monto:     discountAmount,
    descuento_motivo:    discMotivo,
  });

  await deleteDetallesByOrder(currentOrderId);
  for (const line of currentOrderItems) {
    const linePrice = line.porcion === 'media'
      ? (line.item.precio_media    || 0)
      : (line.item.precio_completo || 0);
    await saveDetalle({
      id_orden:        currentOrderId,
      categoria:       line.item.categoria || '',
      articulo:        line.item.nombre,
      porcion:         line.porcion,
      cantidad:        line.qty || 1,
      precio_unitario: linePrice,
      subtotal_linea:  linePrice * (line.qty || 1),
      notas:           line.notas || '',
    });
  }

  localStorage.removeItem('sj_hold_' + currentOrderId);
  await snapshotInProgress();
  broadcast({ type: 'ORDER_TO_KITCHEN', orderId: currentOrderId, nombreMesa: order.nombre_mesa });

  if (clienteEmail) {
    try {
      const detalles = currentOrderItems.map(line => ({
        articulo: line.item.nombre,
        porcion:  line.porcion,
        cantidad: line.qty || 1,
        precio:   line.porcion === 'media' ? (line.item.precio_media || 0) : (line.item.precio_completo || 0),
        notas:    line.notas || '',
      }));
      await sendTicket(clienteEmail, {
        folio, nombreMesa: order.nombre_mesa, detalles,
        subtotal, discountPct, discountAmount,
        total: effectiveTotal, metodo_pago: method,
        efectivoRec: efectivoRecibido, cambio,
      });
      localStorage.setItem('sj_ticket_just_sent', clienteEmail);
    } catch {}
  }

  hideModal('modal-checkout');
  navigate('./index.html');
}

/* =====================================================
   PHONE AUTO-FORMAT
   ===================================================== */
function formatPhone(value) {
  const digits = value.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0,3)}-${digits.slice(3)}`;
  return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
}

/* =====================================================
   VIEW: KITCHEN KDS
   ===================================================== */
async function renderKitchen() {
  showView('view-kitchen');
  updateKitchenClock();
  if (kitchenTimer) clearInterval(kitchenTimer);
  kitchenTimer = setInterval(updateKitchenClock, 30000);
  await refreshKitchenCards();
  listenSync(msg => {
    if (['ORDER_TO_KITCHEN','ORDER_CANCELLED','ORDER_HOLD'].includes(msg.type)) refreshKitchenCards();
  });
}

function updateKitchenClock() {
  const el = document.getElementById('kitchen-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

async function refreshKitchenCards() {
  const grid = document.getElementById('kitchen-grid');
  if (!grid) return;
  const orders = await getKitchenOrders();
  if (orders.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="text-align:center;padding:40px;color:#888">Sin órdenes pendientes</div>';
    return;
  }
  orders.sort((a, b) => new Date(a.hora_enviada_cocina || 0) - new Date(b.hora_enviada_cocina || 0));

  const cards = await Promise.all(orders.map(async o => {
    const detalles = await getDetallesByOrder(o.id_orden);
    const since    = o.hora_enviada_cocina
      ? Math.floor((Date.now() - new Date(o.hora_enviada_cocina)) / 60000) : null;
    const urgent   = since !== null && since >= 15;
    const timeClass = since === null ? '' : since < 10 ? 'time-green' : since < 20 ? 'time-amber' : 'time-red';

    const itemsHtml = detalles.map(d => {
      const isPiece = d.cantidad > 1 || isPieceCategory(d.categoria || '');
      const portionLabel = d.porcion === 'unidad' ? '1 unidad'
        : d.porcion === 'media'   ? '½'
        : isPiece                 ? `${d.cantidad} pz`
        : '1×';
      const notasHtml = d.notas
        ? `<div class="kitchen-item-notes">${esc(d.notas)}</div>` : '';
      return `<div class="kitchen-item-main">
        <span class="kitchen-item-portion">${portionLabel}</span>
        <div>
          <span class="kitchen-item-name">${esc(d.articulo)}</span>
          ${notasHtml}
        </div>
      </div>`;
    }).join('');

    return `
      <div class="kitchen-card ${urgent ? 'kitchen-card-urgent' : ''}" data-order-id="${o.id_orden}">
        <div class="kitchen-card-header">
          <span class="kitchen-card-name">${esc(o.nombre_mesa)}</span>
          ${o.folio ? `<span class="kitchen-folio">${esc(o.folio)}</span>` : ''}
          ${since !== null ? `<span class="kitchen-elapsed ${timeClass}">${since}m</span>` : ''}
        </div>
        <div class="kitchen-card-items">${itemsHtml}</div>
        <div class="kitchen-card-footer">
          <button class="kitchen-ready-btn" data-order-id="${o.id_orden}">Orden lista ✓</button>
        </div>
      </div>`;
  }));

  grid.innerHTML = cards.join('');
}

async function markOrderReady(orderId) {
  await updateOrder(orderId, { hora_completada: new Date().toISOString() });
  broadcast({ type: 'ORDER_READY', orderId });
  await refreshKitchenCards();
}

/* =====================================================
   VIEW: ADMIN
   ===================================================== */
async function renderAdmin() {
  showView('view-admin');
  const pin = localStorage.getItem('sj_admin_pin');
  if (!adminUnlocked && pin) showAdminPinGate();
  else if (!pin)              showAdminPinSetup();
  else                        await renderAdminContent();
}

function showAdminPinGate() {
  const wrapper = document.getElementById('admin-content-wrapper');
  if (!wrapper) return;
  wrapper.innerHTML = `
    <div class="pin-gate">
      <div class="pin-gate-title">Admin</div>
      <div class="pin-gate-subtitle">Ingresa tu PIN de 4 dígitos</div>
      <div class="pin-dots">
        ${[0,1,2,3].map(i => `<span class="pin-dot" id="pd${i}"></span>`).join('')}
      </div>
      <div class="pin-keypad">
        ${[1,2,3,4,5,6,7,8,9,'','0','⌫'].map(k =>
          `<button class="pin-key ${k === '' ? 'pin-key-empty' : ''}" data-key="${k}">${k}</button>`
        ).join('')}
      </div>
      <div id="pin-error" class="pin-error hidden">PIN incorrecto</div>
    </div>`;
  initPinKeypad(verifyPin);
}

function showAdminPinSetup() {
  const wrapper = document.getElementById('admin-content-wrapper');
  if (!wrapper) return;
  wrapper.innerHTML = `
    <div class="pin-gate">
      <div class="pin-gate-title">Configurar PIN</div>
      <div class="pin-gate-subtitle">Crea un PIN de 4 dígitos para proteger Admin</div>
      <div class="form-field" style="max-width:240px;margin:0 auto 12px">
        <label class="form-label">PIN nuevo (4 dígitos)</label>
        <input type="password" id="setup-pin1" inputmode="numeric" maxlength="4">
      </div>
      <div class="form-field" style="max-width:240px;margin:0 auto 12px">
        <label class="form-label">Confirmar PIN</label>
        <input type="password" id="setup-pin2" inputmode="numeric" maxlength="4">
      </div>
      <div id="setup-pin-error" class="pin-error hidden" style="text-align:center;margin-bottom:8px"></div>
      <button id="btn-setup-pin" class="btn-primary">Crear PIN</button>
    </div>`;
  document.getElementById('btn-setup-pin').onclick = handlePinSetup;
}

function initPinKeypad(onComplete) {
  let pinBuffer = '';
  const dots = [0,1,2,3].map(i => document.getElementById('pd' + i));
  function updateDots() { dots.forEach((d, i) => { if (d) d.classList.toggle('filled', i < pinBuffer.length); }); }
  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.key;
      if (key === '⌫') { pinBuffer = pinBuffer.slice(0, -1); }
      else if (key !== '' && pinBuffer.length < 4) { pinBuffer += key; }
      updateDots();
      if (pinBuffer.length === 4) {
        onComplete(pinBuffer);
        pinBuffer = '';
        setTimeout(updateDots, 300);
      }
    };
  });
}

function verifyPin(pin) {
  const stored = localStorage.getItem('sj_admin_pin');
  if (pin === stored) {
    adminUnlocked = true;
    renderAdminContent();
  } else {
    const errEl = document.getElementById('pin-error');
    if (errEl) { errEl.classList.remove('hidden'); setTimeout(() => errEl.classList.add('hidden'), 2000); }
  }
}

async function handlePinSetup() {
  const p1    = document.getElementById('setup-pin1')?.value;
  const p2    = document.getElementById('setup-pin2')?.value;
  const errEl = document.getElementById('setup-pin-error');
  if (!p1 || p1.length !== 4 || !/^\d{4}$/.test(p1)) {
    if (errEl) { errEl.textContent = 'El PIN debe ser exactamente 4 dígitos.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (p1 !== p2) {
    if (errEl) { errEl.textContent = 'Los PINes no coinciden.'; errEl.classList.remove('hidden'); }
    return;
  }
  localStorage.setItem('sj_admin_pin', p1);
  localStorage.setItem('sj_pin_length', '4');
  adminUnlocked = true;
  await renderAdminContent();
}

async function doChangePin() {
  const current = document.getElementById('change-pin-current')?.value;
  const new1    = document.getElementById('change-pin-new1')?.value;
  const new2    = document.getElementById('change-pin-new2')?.value;
  const errEl   = document.getElementById('change-pin-error');
  const stored  = localStorage.getItem('sj_admin_pin');
  if (current !== stored) {
    if (errEl) { errEl.textContent = 'PIN actual incorrecto.'; errEl.classList.remove('hidden'); } return;
  }
  if (!new1 || new1.length !== 4 || !/^\d{4}$/.test(new1)) {
    if (errEl) { errEl.textContent = 'El PIN nuevo debe ser exactamente 4 dígitos.'; errEl.classList.remove('hidden'); } return;
  }
  if (new1 !== new2) {
    if (errEl) { errEl.textContent = 'Los PINes nuevos no coinciden.'; errEl.classList.remove('hidden'); } return;
  }
  localStorage.setItem('sj_admin_pin', new1);
  localStorage.setItem('sj_pin_length', '4');
  hideModal('modal-change-pin');
  showToast('PIN actualizado correctamente.');
}

/* =====================================================
   ADMIN CONTENT — 5 TABS
   ===================================================== */
async function renderAdminContent() {
  const wrapper = document.getElementById('admin-content-wrapper');
  if (!wrapper) return;

  wrapper.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="menu">Menú</button>
      <button class="admin-tab" data-tab="reportes">Reportes</button>
      <button class="admin-tab" data-tab="config">Config</button>
      <button class="admin-tab" data-tab="historial">Historial</button>
      <button class="admin-tab" data-tab="metricas">Métricas</button>
    </div>
    <div id="admin-tab-content" class="admin-tab-content active"></div>`;

  // Clear any running timers from previous tab
  function clearAdminTimers() {
    if (historialTimer) { clearInterval(historialTimer); historialTimer = null; }
    if (metricasTimer)  { clearInterval(metricasTimer);  metricasTimer  = null; }
  }

  const tabs = wrapper.querySelectorAll('.admin-tab');
  tabs.forEach(tab => {
    tab.onclick = async () => {
      clearAdminTimers();
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      await renderAdminTab(tab.dataset.tab);
    };
  });

  await renderAdminTab('menu');
}

async function renderAdminTab(tab) {
  const content = document.getElementById('admin-tab-content');
  if (!content) return;
  try {
    if      (tab === 'menu')      await renderMenuAdmin(content);
    else if (tab === 'reportes')  await renderReportesAdmin(content);
    else if (tab === 'config')    renderConfigAdmin(content);
    else if (tab === 'historial') await renderHistorialTab(content);
    else if (tab === 'metricas')  await renderMetricasTab(content);
  } catch (err) {
    content.innerHTML = `<div style="padding:24px;color:var(--danger-text)">Error: ${esc(err.message)}</div>`;
  }
}

/* ---------- Menu Admin ---------- */
async function renderMenuAdmin(container) {
  const items = await getMenuItems({});
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-header">
        <span class="admin-section-title">Artículos del menú</span>
        <button class="btn-primary btn-sm" id="btn-add-menu-item">+ Agregar</button>
      </div>
      <div class="menu-admin-list">
        ${items.length === 0 ? '<div class="empty-state">No hay artículos.</div>' : items.map(item => {
          const piece = isPieceCategory(item.categoria);
          return `
          <div class="menu-admin-row">
            <div class="menu-admin-info">
              <span class="menu-admin-name ${!item.activo ? 'item-inactive' : ''}">${esc(item.nombre)}</span>
              <span class="menu-admin-cat">${esc(item.categoria)}${piece ? ' <em style="font-size:11px;color:var(--text-secondary)">(por pz)</em>' : ''}</span>
            </div>
            <div class="menu-admin-prices">
              <span>$${(item.precio_completo||0).toFixed(2)}${piece ? '/pz' : ''}</span>
              ${item.tiene_media ? `<span class="price-media">½ $${(item.precio_media||0).toFixed(2)}</span>` : ''}
            </div>
            <div class="menu-admin-actions">
              <button class="btn-sm btn-secondary btn-edit-item" data-id="${item.id_articulo}">Editar</button>
              <button class="btn-sm ${item.activo ? 'btn-warning' : 'btn-success'} btn-toggle-item"
                data-id="${item.id_articulo}" data-activo="${item.activo}">
                ${item.activo ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  document.getElementById('btn-add-menu-item').onclick = () => showMenuItemForm(null);
  container.querySelectorAll('.btn-edit-item').forEach(b => {
    b.onclick = () => showMenuItemForm(parseInt(b.dataset.id));
  });
  container.querySelectorAll('.btn-toggle-item').forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.id);
      await updateMenuItem(id, { activo: b.dataset.activo === 'true' ? false : true });
      renderMenuAdmin(container);
    };
  });
}

async function showMenuItemForm(itemId) {
  const item    = itemId ? await getMenuItemById(itemId) : null;
  const catVal  = item?.categoria || '';
  const isPiece = isPieceCategory(catVal);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id        = 'modal-menu-item-form';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header"><div class="modal-title">${item ? 'Editar artículo' : 'Nuevo artículo'}</div></div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        <div class="form-field">
          <label class="form-label">Nombre</label>
          <input type="text" id="mi-nombre" value="${escAttr(item?.nombre || '')}" maxlength="80">
        </div>
        <div class="form-field">
          <label class="form-label">Categoría</label>
          <input type="text" id="mi-cat" value="${escAttr(catVal)}" maxlength="40" list="cat-list">
          <datalist id="cat-list">
            <option value="Empanadas"><option value="Chiles rellenos"><option value="Tostadas">
            <option value="Garnachas"><option value="Picaditas"><option value="Platillos"><option value="Bebidas">
          </datalist>
        </div>
        <div id="mi-piece-badge" class="piece-category-badge" style="${isPiece ? '' : 'display:none'}">Categoría: venta por pieza</div>
        <div class="form-field">
          <label class="form-label" id="mi-precio-label">${isPiece ? 'Precio por pieza ($)' : 'Precio completo ($)'}</label>
          <input type="number" id="mi-precio" value="${item?.precio_completo || 0}" min="0" step="1">
        </div>
        <div id="mi-tiene-media-row" style="${isPiece ? 'display:none' : ''}">
          <div class="form-row" style="gap:8px;align-items:center">
            <label style="display:flex;align-items:center;gap:6px;font-size:14px">
              <input type="checkbox" id="mi-tiene-media" ${item?.tiene_media ? 'checked' : ''}>
              Tiene ½ orden
            </label>
          </div>
          <div class="form-field" id="mi-media-row" style="${item?.tiene_media ? '' : 'display:none'}">
            <label class="form-label">Precio ½ orden ($)</label>
            <input type="number" id="mi-precio-media" value="${item?.precio_media || 0}" min="0" step="1">
          </div>
        </div>
        <div id="mi-error" class="pin-error hidden"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="mi-cancel">Cancelar</button>
        <button class="btn-primary" id="mi-save">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  function updateFormForCat(cat) {
    const p = isPieceCategory(cat);
    document.getElementById('mi-piece-badge').style.display    = p ? '' : 'none';
    document.getElementById('mi-precio-label').textContent     = p ? 'Precio por pieza ($)' : 'Precio completo ($)';
    document.getElementById('mi-tiene-media-row').style.display = p ? 'none' : '';
  }
  document.getElementById('mi-cat').addEventListener('input', e => updateFormForCat(e.target.value));
  document.getElementById('mi-tiene-media').onchange = e => {
    document.getElementById('mi-media-row').style.display = e.target.checked ? '' : 'none';
  };
  document.getElementById('mi-cancel').onclick = () => modal.remove();
  document.getElementById('mi-save').onclick = async () => {
    const nombre     = document.getElementById('mi-nombre').value.trim();
    const categoria  = document.getElementById('mi-cat').value.trim();
    const precio     = parseFloat(document.getElementById('mi-precio').value) || 0;
    const tieneMedia = !isPieceCategory(categoria) && document.getElementById('mi-tiene-media').checked;
    const precioMedia = tieneMedia ? (parseFloat(document.getElementById('mi-precio-media').value) || 0) : null;
    const errEl = document.getElementById('mi-error');
    if (!nombre || !categoria) {
      if (errEl) { errEl.textContent = 'Nombre y categoría son requeridos.'; errEl.classList.remove('hidden'); }
      return;
    }
    const data = { nombre, categoria, precio_completo: precio, tiene_media: tieneMedia, precio_media: precioMedia, activo: item ? item.activo : true };
    if (item) await updateMenuItem(item.id_articulo, { ...data });
    else      await saveMenuItem(data);
    modal.remove();
    const ct = document.getElementById('admin-tab-content');
    if (ct) await renderMenuAdmin(ct);
  };
}

/* ---------- Reportes Tab ---------- */
async function renderReportesAdmin(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-header">
        <span class="admin-section-title">Reporte del día</span>
        <input type="date" id="report-date" value="${todayStr()}" style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:13px">
      </div>
      <div id="report-stats" class="report-stats"></div>
      <div class="admin-section-title" style="margin-top:16px">Ventas por hora</div>
      <canvas id="hourly-chart" style="width:100%;border-radius:8px;background:var(--surface-2);padding:8px"></canvas>
      <div class="admin-section-title" style="margin-top:16px">Top 5 artículos</div>
      <div id="top-items-list"></div>
      <div style="margin-top:16px">
        <button class="btn-secondary btn-sm" id="btn-backup-drive">Exportar a Drive</button>
      </div>
    </div>`;

  const loadReport = async (date) => {
    const [stats, hourly, topItems] = await Promise.all([
      getTodayStats(date), getHourlyRevenue(date), getTopItems(date)
    ]);
    const statsEl = document.getElementById('report-stats');
    if (statsEl) statsEl.innerHTML = `
      <div class="report-stat-card"><div class="stat-label">Ventas</div><div class="stat-value">$${stats.totalVentas.toFixed(2)}</div></div>
      <div class="report-stat-card"><div class="stat-label">Órdenes</div><div class="stat-value">${stats.ordenesCompletadas}</div></div>
      <div class="report-stat-card"><div class="stat-label">Ticket prom.</div><div class="stat-value">$${stats.ticketPromedio.toFixed(2)}</div></div>
      <div class="report-stat-card"><div class="stat-label">T. prep. prom.</div><div class="stat-value">${stats.tiempoPrepPromedio}m</div></div>`;
    const canvas = document.getElementById('hourly-chart');
    if (canvas) renderHourlyChart(canvas, hourly);
    const topEl = document.getElementById('top-items-list');
    if (topEl) topEl.innerHTML = topItems.length === 0
      ? '<div class="empty-state">Sin datos</div>'
      : topItems.map(t => `<div class="top-item-row"><span>${t.rank}. ${esc(t.nombre)}</span><span>${t.cantidad} uds.</span></div>`).join('');
  };

  await loadReport(todayStr());
  document.getElementById('report-date').onchange = e => loadReport(e.target.value);
  document.getElementById('btn-backup-drive').onclick = async () => {
    try {
      if (!isConnected()) { showToast('Conecta Google primero en Configuración.'); return; }
      await backupToDrive(await buildBackupCSV());
      showToast('Backup exportado a Drive.');
    } catch (e) { showToast('Error al exportar: ' + e.message); }
  };
}

/* ---------- Config Tab ---------- */
function renderConfigAdmin(container) {
  const connected = isConnected();
  const cfg       = getSJConfig();
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-title">Google</div>
      <div class="config-row">
        <span>${connected ? '✅ Conectado' : '⬜ No conectado'}</span>
        ${connected
          ? '<button class="btn-danger btn-sm" id="btn-disconnect-google">Desconectar</button>'
          : '<button class="btn-primary btn-sm" id="btn-connect-google">Conectar Google</button>'}
      </div>
    </div>
    <div class="admin-section" style="margin-top:16px">
      <div class="admin-section-title">Seguridad</div>
      <div class="config-row">
        <span>PIN de administrador</span>
        <button class="btn-secondary btn-sm" id="btn-open-change-pin">Cambiar PIN</button>
      </div>
    </div>
    <div class="admin-section config-targets-section" style="margin-top:16px">
      <div class="admin-section-title">Objetivos de desempeño</div>
      <div class="config-targets-grid">
        <div class="config-target-field">
          <label class="config-target-label">Meta de ventas diaria (MXN)</label>
          <input type="number" class="config-target-input" id="cfg-meta-ventas" value="${cfg.metaVentas ?? 3000}" min="0" step="100">
        </div>
        <div class="config-target-field">
          <label class="config-target-label">Meta tiempo &lt;10 min (%)</label>
          <input type="number" class="config-target-input" id="cfg-meta-lt10" value="${cfg.metaLt10 ?? 95}" min="0" max="100" step="1">
        </div>
        <div class="config-target-field">
          <label class="config-target-label">Meta tiempo 10-20 min (%)</label>
          <input type="number" class="config-target-input" id="cfg-meta-btwn" value="${cfg.metaBtwn ?? 5}" min="0" max="100" step="1">
        </div>
      </div>
      <button class="btn-primary btn-sm" id="btn-save-targets" style="margin-top:12px">Guardar objetivos</button>
    </div>`;

  if (connected) {
    document.getElementById('btn-disconnect-google').onclick = () => {
      showConfirm('¿Desconectar Google?', async () => { await disconnectGoogle(); renderConfigAdmin(container); });
    };
  } else {
    document.getElementById('btn-connect-google').onclick = async () => {
      try { await connectGoogle(); renderConfigAdmin(container); }
      catch (e) { showToast('Error al conectar: ' + e.message); }
    };
  }
  document.getElementById('btn-open-change-pin').onclick = () => {
    document.getElementById('change-pin-current').value = '';
    document.getElementById('change-pin-new1').value    = '';
    document.getElementById('change-pin-new2').value    = '';
    document.getElementById('change-pin-error')?.classList.add('hidden');
    showModal('modal-change-pin');
  };
  document.getElementById('btn-save-targets').onclick = () => {
    saveSJConfig({
      metaVentas: parseFloat(document.getElementById('cfg-meta-ventas').value) || 3000,
      metaLt10:   parseFloat(document.getElementById('cfg-meta-lt10').value)  || 95,
      metaBtwn:   parseFloat(document.getElementById('cfg-meta-btwn').value)  || 5,
    });
    showToast('Objetivos guardados.');
  };
}

/* ---------- Historial Tab ---------- */
async function renderHistorialTab(container) {
  const orders = await getOrdersByDate(todayStr());
  orders.sort((a, b) => new Date(b.hora_orden || 0) - new Date(a.hora_orden || 0));

  const withDetails = await Promise.all(orders.map(async o => {
    const detalles   = await getDetallesByOrder(o.id_orden);
    const itemCount  = detalles.reduce((s, d) => s + (d.cantidad || 1), 0);
    const prepMinutes = o.hora_enviada_cocina && o.hora_completada
      ? ((new Date(o.hora_completada) - new Date(o.hora_enviada_cocina)) / 60000).toFixed(1)
      : null;
    return { ...o, itemCount, prepMinutes };
  }));

  const cobradas = withDetails.filter(o => o.estado === 'cobrada');
  const totalRev = cobradas.reduce((s, o) => s + (o.subtotal || 0), 0);
  const withPrep = cobradas.filter(o => o.prepMinutes !== null);
  const avgPrep  = withPrep.length > 0
    ? (withPrep.reduce((s, o) => s + parseFloat(o.prepMinutes), 0) / withPrep.length).toFixed(1)
    : '—';

  function estadoCell(o) {
    if (o.estado === 'cancelada') return `<span class="estado-cancelada">✗ Cancelada</span>`;
    if (o.estado === 'cobrada' && o.hora_completada) return `<span class="estado-lista">✓ Lista</span>`;
    if (o.estado === 'cobrada') return `<span class="estado-cobrada">✓ Cobrada</span>`;
    return `<span class="estado-pendiente">En curso</span>`;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }

  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-header">
        <span class="admin-section-title">Historial de hoy <span class="history-refresh" id="historial-ts"></span></span>
      </div>
      ${withDetails.length === 0 ? '<div class="empty-state">Sin órdenes hoy</div>' : `
      <div class="history-wrap">
        <table class="history-table">
          <thead>
            <tr>
              <th>Folio</th><th>Mesa</th><th>Hora</th><th>Artículos</th>
              <th>Total</th><th>Desc.</th><th>Pago</th><th>Estado</th><th>Prep.</th>
            </tr>
          </thead>
          <tbody>
            ${withDetails.map(o => `
              <tr>
                <td>${esc(o.folio || '—')}</td>
                <td>${esc(o.nombre_mesa)}</td>
                <td>${fmtTime(o.hora_orden)}</td>
                <td style="text-align:center">${o.itemCount}</td>
                <td>$${(o.subtotal || 0).toFixed(2)}</td>
                <td>${o.descuento_pct > 0 ? o.descuento_pct + '%' : '—'}</td>
                <td>${o.metodo_pago === 'tarjeta' ? 'Tarjeta' : o.metodo_pago === 'efectivo' ? 'Efectivo' : '—'}</td>
                <td>${estadoCell(o)}</td>
                <td>${o.prepMinutes !== null ? o.prepMinutes + 'm' : '—'}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="history-summary">
              <td colspan="3"><strong>${cobradas.length} cobradas</strong></td>
              <td></td>
              <td><strong>$${totalRev.toFixed(2)}</strong></td>
              <td></td><td></td><td></td>
              <td>⌀ ${avgPrep}${avgPrep !== '—' ? 'm' : ''}</td>
            </tr>
          </tfoot>
        </table>
      </div>`}
    </div>`;

  const tsEl = document.getElementById('historial-ts');
  if (tsEl) tsEl.textContent = `· ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`;

  if (historialTimer) clearInterval(historialTimer);
  historialTimer = setInterval(() => {
    const ct = document.getElementById('admin-tab-content');
    if (ct && document.querySelector('.admin-tab.active')?.dataset.tab === 'historial') {
      renderHistorialTab(ct);
    } else {
      clearInterval(historialTimer); historialTimer = null;
    }
  }, 30000);
}

/* ---------- Métricas Tab ---------- */
async function renderMetricasTab(container) {
  const cfg  = getSJConfig();
  const meta  = { ventas: cfg.metaVentas ?? 3000, lt10: cfg.metaLt10 ?? 95, btwn: cfg.metaBtwn ?? 5 };

  const [prepStats, salesMetrics, weekly] = await Promise.all([
    getPrepTimeStats(),
    getSalesMetrics(),
    getWeeklySummary()
  ]);

  function progressBar(pct, target, type) {
    const isGood = type === 'gt20' ? pct === 0 : pct >= target;
    const cls    = isGood ? 'progress-bar-green' : (pct >= target * 0.6 ? 'progress-bar-amber' : 'progress-bar-red');
    const w      = Math.min(100, pct);
    return `<div class="progress-bar-bg"><div class="progress-bar-fill ${cls}" style="width:${w}%"></div></div>`;
  }

  const salesPct  = meta.ventas > 0 ? (salesMetrics.totalVentas / meta.ventas) * 100 : 0;
  const salesCls  = salesPct >= 100 ? 'progress-bar-green' : salesPct >= 60 ? 'progress-bar-amber' : 'progress-bar-red';
  const salesLblColor = salesPct >= 100 ? 'var(--success-text)' : salesPct >= 60 ? '#e67e22' : 'var(--danger-text)';

  container.innerHTML = `
    <div class="metricas-section">
      <div class="metricas-title">Tiempo de preparación — hoy (${prepStats.total} órdenes)</div>
      <div class="progress-row">
        <div class="progress-label">&lt; 10 min</div>
        ${progressBar(prepStats.lt10Pct, meta.lt10, 'lt10')}
        <div class="progress-pct">${prepStats.lt10Pct}%</div>
        <div class="progress-target">meta ${meta.lt10}%</div>
      </div>
      <div class="progress-row">
        <div class="progress-label">10–20 min</div>
        ${progressBar(prepStats.b1020Pct, meta.btwn, 'btwn')}
        <div class="progress-pct">${prepStats.b1020Pct}%</div>
        <div class="progress-target">meta ${meta.btwn}%</div>
      </div>
      <div class="progress-row">
        <div class="progress-label">&gt; 20 min</div>
        ${progressBar(prepStats.gt20Pct, 0, 'gt20')}
        <div class="progress-pct" style="color:${prepStats.gt20Pct > 0 ? 'var(--danger-text)' : 'var(--success-text)'}">${prepStats.gt20Pct}%</div>
        <div class="progress-target">meta 0%</div>
      </div>
    </div>

    <div class="metricas-section">
      <div class="metricas-title">Ventas — hoy</div>
      <div class="metric-tiles">
        <div class="metric-tile primary-tile">
          <div class="metric-tile-label">Ventas actuales</div>
          <div class="metric-tile-value">$${salesMetrics.totalVentas.toFixed(0)}</div>
          <div class="metric-tile-sub">meta $${meta.ventas.toLocaleString()}</div>
        </div>
        <div class="metric-tile">
          <div class="metric-tile-label">Órdenes cobradas</div>
          <div class="metric-tile-value">${salesMetrics.ordenesCompletadas}</div>
        </div>
        <div class="metric-tile">
          <div class="metric-tile-label">Ticket promedio</div>
          <div class="metric-tile-value">$${salesMetrics.ticketPromedio.toFixed(0)}</div>
        </div>
        <div class="metric-tile">
          <div class="metric-tile-label">Hora pico</div>
          <div class="metric-tile-value" style="font-size:13px;margin-top:8px">${salesMetrics.horaPico || '—'}</div>
        </div>
        <div class="metric-tile">
          <div class="metric-tile-label">Proyección al cierre</div>
          <div class="metric-tile-value">$${salesMetrics.proyeccion ? salesMetrics.proyeccion.toFixed(0) : '—'}</div>
        </div>
        <div class="metric-tile">
          <div class="metric-tile-label">Progreso meta</div>
          <div class="metric-tile-value" style="color:${salesLblColor}">${salesPct.toFixed(0)}%</div>
        </div>
      </div>
      <div class="sales-progress-wrap">
        <div class="sales-progress-bg">
          <div class="sales-progress-fill ${salesCls}" style="width:${Math.min(100, salesPct).toFixed(1)}%">
            ${salesPct >= 15 ? `<span class="sales-progress-label">${salesPct.toFixed(0)}%</span>` : ''}
          </div>
        </div>
      </div>
    </div>

    <div class="metricas-section">
      <div class="metricas-title">Resumen semanal (últimos 7 días)</div>
      <div class="weekly-chart-wrap">
        <canvas id="weekly-chart" style="width:100%"></canvas>
      </div>
    </div>`;

  const weeklyCanvas = document.getElementById('weekly-chart');
  if (weeklyCanvas) renderWeeklyChart(weeklyCanvas, weekly);

  if (metricasTimer) clearInterval(metricasTimer);
  metricasTimer = setInterval(() => {
    const ct = document.getElementById('admin-tab-content');
    if (ct && document.querySelector('.admin-tab.active')?.dataset.tab === 'metricas') {
      renderMetricasTab(ct);
    } else {
      clearInterval(metricasTimer); metricasTimer = null;
    }
  }, 60000);
}

/* =====================================================
   STATUS HELPERS
   ===================================================== */
function statusLabel(estado) {
  switch (estado) {
    case 'pendiente': return 'Capturando';
    case 'hold':      return 'En espera';
    case 'cobrada':   return 'Cobrada';
    case 'cancelada': return 'Cancelada';
    default:          return estado || '';
  }
}
function statusClass(estado) {
  switch (estado) {
    case 'pendiente': return 'status-pendiente';
    case 'hold':      return 'status-hold';
    case 'cobrada':   return 'status-cobrada';
    case 'cancelada': return 'status-cancelada';
    default:          return '';
  }
}

/* =====================================================
   VIEW SWITCHING
   ===================================================== */
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId)?.classList.remove('hidden');
  const viewMap = { 'view-home': 'home', 'view-kitchen': 'cocina', 'view-admin': 'admin' };
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewMap[viewId]);
  });
}

/* =====================================================
   ESCAPE HELPERS
   ===================================================== */
function esc(str)     { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(str) { return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

/* =====================================================
   GLOBAL CLICK DELEGATION
   ===================================================== */
document.addEventListener('click', async (e) => {
  const t = e.target;

  // ---- Bottom nav ----
  if (t.closest('.nav-item')) {
    const view = t.closest('.nav-item').dataset.view;
    if (view === 'home')   navigate('./index.html');
    if (view === 'cocina') navigate('./index.html?view=cocina');
    if (view === 'admin')  navigate('./index.html?view=admin');
    return;
  }

  // ---- Banners ----
  if (t.classList.contains('banner-close')) { t.closest('.banner')?.classList.add('hidden'); return; }
  if (t.id === 'btn-banner-admin') { navigate('./index.html?view=admin'); return; }

  // ---- First launch ----
  if (t.id === 'btn-first-launch-ok') { localStorage.setItem('sj_first_launch_done', '1'); hideModal('modal-first-launch'); return; }

  // ---- Nueva mesa ----
  if (t.id === 'btn-new-table') {
    document.getElementById('nueva-mesa-input').value = '';
    const errEl = document.getElementById('nueva-mesa-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    showModal('modal-nueva-mesa');
    setTimeout(() => document.getElementById('nueva-mesa-input')?.focus(), 50);
    return;
  }
  if (t.id === 'btn-nueva-mesa-cancel') { hideModal('modal-nueva-mesa'); return; }
  if (t.id === 'btn-nueva-mesa-ok') {
    const input = document.getElementById('nueva-mesa-input');
    const name  = (input?.value || '').trim();
    if (!name) { input?.focus(); return; }
    const openOrders = await getOpenOrders();
    const exists     = openOrders.some(o => o.nombre_mesa.toLowerCase().trim() === name.toLowerCase());
    if (exists) {
      const errEl = document.getElementById('nueva-mesa-error');
      if (errEl) { errEl.textContent = 'Ya hay una mesa abierta con ese nombre.'; errEl.classList.remove('hidden'); }
      input?.focus(); return;
    }
    document.getElementById('nueva-mesa-error')?.classList.add('hidden');
    const id = await saveOrder({ nombre_mesa: name, estado: 'pendiente', subtotal: 0, hora_orden: new Date().toISOString() });
    await snapshotInProgress();
    broadcast({ type: 'ORDER_CREATED', orderId: id, nombreMesa: name });
    hideModal('modal-nueva-mesa');
    navigate(`./index.html?mesa=${id}`);
    return;
  }

  // ---- Table card ----
  const tableCard = t.closest('.table-card');
  if (tableCard) { navigate(`./index.html?mesa=${tableCard.dataset.orderId}`); return; }

  // ---- Order capture back ----
  if (t.id === 'btn-back') { showBackActionSheet(); return; }

  // ---- Hold table ----
  if (t.id === 'btn-hold-table') { showConfirm('¿Poner esta mesa en espera?', holdTable, 'En espera'); return; }

  // ---- Cancel table ----
  if (t.id === 'btn-cancel-table') {
    showConfirm('¿Cancelar esta mesa?', async () => {
      localStorage.removeItem('sj_hold_' + currentOrderId);
      await updateOrder(currentOrderId, { estado: 'cancelada' });
      await snapshotInProgress();
      broadcast({ type: 'ORDER_CANCELLED', orderId: currentOrderId });
      navigate('./index.html');
    }, 'Cancelar mesa');
    return;
  }

  // ---- Menu: regular add ----
  if (t.classList.contains('btn-add-item')) {
    await addItemToOrder(parseInt(t.dataset.itemId), t.dataset.porcion || 'completa');
    return;
  }

  // ---- Menu: piece qty dec/inc ----
  if (t.classList.contains('btn-piece-dec')) {
    const id = parseInt(t.dataset.itemId);
    pieceQty[id] = Math.max(1, (pieceQty[id] || 1) - 1);
    updatePieceRow(id); return;
  }
  if (t.classList.contains('btn-piece-inc')) {
    const id = parseInt(t.dataset.itemId);
    pieceQty[id] = Math.min(20, (pieceQty[id] || 1) + 1);
    updatePieceRow(id); return;
  }
  if (t.classList.contains('btn-add-pieces')) {
    const id  = parseInt(t.dataset.itemId);
    const qty = pieceQty[id] || 1;
    await addItemToOrder(id, 'completa', qty);
    pieceQty[id] = 1;
    updatePieceRow(id); return;
  }

  // ---- Order qty controls ----
  if (t.classList.contains('btn-qty-inc')) { await adjustQty(parseInt(t.dataset.idx),  1); return; }
  if (t.classList.contains('btn-qty-dec')) { await adjustQty(parseInt(t.dataset.idx), -1); return; }
  if (t.classList.contains('btn-remove-item')) { await removeItemFromOrder(parseInt(t.dataset.idx)); return; }

  // ---- Cobrar orden ----
  if (t.id === 'btn-cobrar-orden') {
    if (currentOrderItems.length === 0) { showToast('Agrega al menos un artículo antes de cobrar.'); return; }
    openCheckout(); return;
  }

  // ---- Checkout cancel ----
  if (t.id === 'btn-checkout-cancel') { hideModal('modal-checkout'); return; }

  // ---- Discount pills ----
  if (t.classList.contains('discount-pill')) {
    document.querySelectorAll('.discount-pill').forEach(p => p.classList.remove('active'));
    t.classList.add('active');
    discountPct = parseInt(t.dataset.pct, 10) || 0;
    document.getElementById('discount-reason-row')?.classList.toggle('hidden', discountPct === 0);
    document.getElementById('discount-error')?.classList.add('hidden');
    updateDiscountBreakdown(); return;
  }

  // ---- Payment method toggle ----
  if (t.classList.contains('payment-toggle-btn')) {
    document.querySelectorAll('.payment-toggle-btn').forEach(b => b.classList.remove('active'));
    t.classList.add('active');
    const method = t.dataset.method;
    document.querySelectorAll('.payment-section').forEach(s => s.classList.toggle('hidden', s.dataset.method !== method));
    const confirmBtn = document.getElementById('btn-confirm-payment');
    if (method === 'tarjeta' && confirmBtn) confirmBtn.disabled = false;
    if (method === 'efectivo') updateCashDisplay();
    updateCardTotal(); return;
  }

  // ---- Quick amounts ----
  if (t.classList.contains('quick-amount-btn')) { cashInput = String(parseInt(t.dataset.amount, 10) * 100); updateCashDisplay(); return; }

  // ---- Numpad ----
  if (t.classList.contains('numpad-key')) {
    const key = t.dataset.key;
    if (key === '⌫') { cashInput = cashInput.slice(0, -1); }
    else if (cashInput.length < 7) { cashInput += key; }
    updateCashDisplay(); return;
  }

  // ---- Confirm payment ----
  if (t.id === 'btn-confirm-payment') { await confirmPayment(); return; }

  // ---- Help ----
  if (t.id === 'btn-help') { showModal('modal-first-launch'); return; }

  // ---- Kitchen ready ----
  if (t.classList.contains('kitchen-ready-btn')) { await markOrderReady(parseInt(t.dataset.orderId)); return; }

  // ---- Change PIN ----
  if (t.id === 'btn-change-pin-cancel') { hideModal('modal-change-pin'); return; }
  if (t.id === 'btn-do-change-pin')     { await doChangePin(); return; }
});

/* ---- Input delegation ---- */
document.addEventListener('input', e => {
  const t = e.target;
  if (t.classList.contains('item-notes-input')) {
    const idx = parseInt(t.dataset.lineIdx);
    if (currentOrderItems[idx] !== undefined) {
      currentOrderItems[idx].notas = t.value;
      saveOrderSnapshot(currentOrderId);
    }
    return;
  }
  if (t.id === 'customer-phone') {
    t.value = formatPhone(t.value);
    document.getElementById('customer-phone-error')?.classList.add('hidden');
    return;
  }
});

/* ---- Enter key for nueva mesa ---- */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'nueva-mesa-input') {
    document.getElementById('btn-nueva-mesa-ok')?.click();
  }
});

/* =====================================================
   BOOT
   ===================================================== */
init();
