/**
 * app.js — Main controller for Sabor Jarocho PWA  v1.1
 * Routing, view rendering, event delegation, crash recovery
 */

import {
  openDB, saveOrder, updateOrder, getOrder, getOpenOrders,
  saveDetalle, getDetallesByOrder, deleteDetallesByOrder,
  getMenuItems, saveMenuItem, updateMenuItem, deleteMenuItem,
  getMenuItemById, snapshotInProgress, recoverOrders,
  generateFolio, todayStr, getOrdersByDate,
  getKitchenOrders, migratePricesV2
} from './db.js';
import { broadcast, listenSync } from './sync.js';
import {
  connectGoogle, getToken, isConnected, disconnectGoogle,
  sendTicket, backupToDrive, buildBackupCSV
} from './google.js';
import { getTodayStats, getTopItems, getHourlyRevenue, renderHourlyChart } from './reports.js';

/* =====================================================
   STATE
   ===================================================== */
let currentOrderId    = null;  // active order being captured
let currentOrderItems = [];    // in-memory line items [{item, porcion, notas}]
let adminUnlocked     = false; // PIN verified this session
let kitchenTimer      = null;  // interval for elapsed time
let checkoutData      = null;  // data for checkout overlay
let discountPct       = 0;     // current discount percentage (0, 10, or 20)

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

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch(() => {});
  }

  // Lock orientation
  if (screen.orientation && typeof screen.orientation.lock === 'function') {
    screen.orientation.lock('landscape').catch(() => {});
  }

  // Open DB
  await openDB();

  // Price migration (one-time)
  await migratePricesV2();

  // Crash recovery
  const recovered = await recoverOrders();
  if (recovered > 0) {
    showBanner('banner-recovery',
      `Se recuperaron ${recovered} órden${recovered > 1 ? 'es' : ''} de la sesión anterior.`);
  }

  // Price warning check
  await checkPriceWarning();

  // First launch modal
  if (!localStorage.getItem('sj_first_launch_done')) {
    showModal('modal-first-launch');
  }

  // Route to correct view
  route();
}

/* =====================================================
   ROUTING
   ===================================================== */
function route() {
  const params = new URLSearchParams(window.location.search);
  const view   = params.get('view');
  const mesa   = params.get('mesa');

  if (view === 'cocina') {
    renderKitchen();
  } else if (view === 'admin') {
    renderAdmin();
  } else if (mesa) {
    renderOrderCapture(parseInt(mesa, 10));
  } else {
    renderHome();
  }
}

function navigate(url) {
  window.location.assign(url);
}

/* =====================================================
   BANNERS
   ===================================================== */
async function checkPriceWarning() {
  try {
    const items = await getMenuItems({ activo: true });
    if (items.some(i => i.precio_completo === 0)) {
      showBanner('banner-price-warning', '⚠️ Hay artículos sin precio. Configúralos en Admin → Menú antes de operar.');
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
   MODAL HELPERS
   ===================================================== */
function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

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

  // Check for ticket-sent signal
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
    const snap = localStorage.getItem('sj_hold_' + o.id_orden);
    const items = snap ? JSON.parse(snap) : [];
    const itemCount = items.reduce((s, l) => s + (l.qty || 1), 0);
    const subtotal = snap ? calcSubtotalFromItems(items) : (o.subtotal || 0);
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
    const price = line.porcion === 'media' ? (line.item.precio_media || 0) : (line.item.precio_completo || 0);
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

  // Restore from snapshot first (for hold/pendiente)
  const snap = localStorage.getItem('sj_hold_' + orderId);
  if (snap && (order.estado === 'pendiente' || order.estado === 'hold')) {
    try { currentOrderItems = JSON.parse(snap); } catch { currentOrderItems = []; }
  } else {
    currentOrderItems = [];
  }

  // Update header
  const nameEl = document.getElementById('order-mesa-name');
  if (nameEl) nameEl.textContent = order.nombre_mesa;
  const badge = document.getElementById('order-status-badge');
  if (badge) {
    badge.textContent = statusLabel(order.estado);
    badge.className = 'status-badge ' + statusClass(order.estado);
  }

  // Render both panels
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

  // Group by category
  const cats = {};
  for (const item of items) {
    if (!cats[item.categoria]) cats[item.categoria] = [];
    cats[item.categoria].push(item);
  }

  const isBebida = (item) => item.categoria === 'Bebidas';

  scroll.innerHTML = Object.entries(cats).map(([cat, catItems]) => `
    <div class="menu-category">
      <div class="menu-category-title">${esc(cat)}</div>
      ${catItems.map(item => `
        <div class="menu-item-row">
          <div class="menu-item-name">${esc(item.nombre)}</div>
          <div class="menu-item-prices">
            <button class="btn-add-item btn-add-full"
              data-item-id="${item.id_articulo}"
              data-porcion="${isBebida(item) ? 'unidad' : 'completa'}">
              ${isBebida(item) ? '1 unidad' : '1 orden'} — $${(item.precio_completo || 0).toFixed(2)}
            </button>
            ${item.tiene_media && !isBebida(item) ? `
            <button class="btn-add-item btn-add-media"
              data-item-id="${item.id_articulo}"
              data-porcion="media">
              ½ orden — $${(item.precio_media || 0).toFixed(2)}
            </button>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderOrderPanel() {
  const scroll = document.getElementById('order-scroll');
  if (!scroll) return;

  if (currentOrderItems.length === 0) {
    scroll.innerHTML = '<div class="empty-state" style="padding:24px 16px;text-align:center;color:var(--text-secondary)">Toca los artículos del menú para agregar.</div>';
  } else {
    scroll.innerHTML = currentOrderItems.map((line, idx) => {
      const isUnidad = line.porcion === 'unidad';
      const isMedia  = line.porcion === 'media';
      const badgeText  = isUnidad ? '1 unidad' : (isMedia ? '½ orden' : '1 orden');
      const badgeClass = isMedia ? 'portion-media' : 'portion-completa';
      const price = isMedia ? (line.item.precio_media || 0) : (line.item.precio_completo || 0);
      const lineTotal = price * (line.qty || 1);

      return `
        <div class="order-item-block">
          <div class="order-item-row">
            <div class="order-item-left">
              <span class="portion-badge ${badgeClass}">${badgeText}</span>
              <span class="order-item-name">${esc(line.item.nombre)}</span>
            </div>
            <div class="order-item-right">
              <span class="order-item-price">$${lineTotal.toFixed(2)}</span>
              <div class="qty-controls">
                <button class="qty-btn btn-qty-dec" data-idx="${idx}">−</button>
                <span class="qty-value">${line.qty || 1}</span>
                <button class="qty-btn btn-qty-inc" data-idx="${idx}">+</button>
              </div>
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

  // Update footer summary
  const subtotal = calcSubtotal();
  const countEl = document.getElementById('order-item-count');
  const totalEl = document.getElementById('order-subtotal');
  const totalCount = currentOrderItems.reduce((s, l) => s + (l.qty || 1), 0);
  if (countEl) countEl.textContent = `${totalCount} artículo${totalCount !== 1 ? 's' : ''}`;
  if (totalEl) totalEl.textContent = `$${subtotal.toFixed(2)}`;
}

function calcSubtotal() {
  return calcSubtotalFromItems(currentOrderItems);
}

function saveOrderSnapshot(orderId) {
  if (!orderId) return;
  localStorage.setItem('sj_hold_' + orderId, JSON.stringify(currentOrderItems));
}

async function addItemToOrder(itemId, porcion) {
  const item = await getMenuItemById(itemId);
  if (!item) return;

  const existing = currentOrderItems.find(l => l.item.id_articulo === itemId && l.porcion === porcion);
  if (existing) {
    existing.qty = (existing.qty || 1) + 1;
  } else {
    currentOrderItems.push({ item, porcion, qty: 1, notas: '' });
  }

  // Update subtotal in DB
  const sub = calcSubtotal();
  await updateOrder({ id_orden: currentOrderId, subtotal: sub });

  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

async function removeItemFromOrder(idx) {
  currentOrderItems.splice(idx, 1);
  const sub = calcSubtotal();
  await updateOrder({ id_orden: currentOrderId, subtotal: sub });
  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

async function adjustQty(idx, delta) {
  const line = currentOrderItems[idx];
  if (!line) return;
  line.qty = Math.max(1, (line.qty || 1) + delta);
  const sub = calcSubtotal();
  await updateOrder({ id_orden: currentOrderId, subtotal: sub });
  saveOrderSnapshot(currentOrderId);
  renderOrderPanel();
}

/* =====================================================
   HOLD TABLE / BACK ACTION SHEET
   ===================================================== */
async function holdTable() {
  if (!currentOrderId) return;
  saveOrderSnapshot(currentOrderId);
  const sub = calcSubtotal();
  await updateOrder({ id_orden: currentOrderId, estado: 'hold', subtotal: sub });
  await snapshotInProgress();
  broadcast({ type: 'ORDER_HOLD', orderId: currentOrderId });
  navigate('./index.html');
}

function showBackActionSheet() {
  // Remove any existing sheet
  const existing = document.getElementById('sj-action-sheet-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'sj-action-sheet-overlay';
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
      await updateOrder({ id_orden: currentOrderId, estado: 'cancelada' });
      await snapshotInProgress();
      broadcast({ type: 'ORDER_CANCELLED', orderId: currentOrderId });
      navigate('./index.html');
    }, 'Cancelar mesa');
  };
  document.getElementById('as-continue').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/* =====================================================
   VIEW: CHECKOUT
   ===================================================== */
function getEffectiveTotal() {
  return calcSubtotal() * (1 - discountPct / 100);
}

function openCheckout() {
  // Reset discount
  discountPct = 0;
  document.querySelectorAll('.discount-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.pct === '0');
  });
  const reasonRow = document.getElementById('discount-reason-row');
  if (reasonRow) reasonRow.classList.add('hidden');
  const discountInput = document.getElementById('discount-reason');
  if (discountInput) discountInput.value = '';
  const discountErr = document.getElementById('discount-error');
  if (discountErr) { discountErr.textContent = ''; discountErr.classList.add('hidden'); }
  const breakdown = document.getElementById('checkout-totals-breakdown');
  if (breakdown) breakdown.classList.add('hidden');

  // Reset customer fields
  const emailEl = document.getElementById('customer-email');
  const phoneEl = document.getElementById('customer-phone');
  if (emailEl) emailEl.value = '';
  if (phoneEl) phoneEl.value = '';
  const phoneErr = document.getElementById('customer-phone-error');
  if (phoneErr) { phoneErr.textContent = ''; phoneErr.classList.add('hidden'); }

  // Populate order summary
  const listEl = document.querySelector('.checkout-items-list');
  if (listEl) {
    listEl.innerHTML = currentOrderItems.map(line => {
      const isMedia  = line.porcion === 'media';
      const isUnidad = line.porcion === 'unidad';
      const label = isUnidad ? '1 unidad' : (isMedia ? '½ ord.' : '1 ord.');
      const price = isMedia ? (line.item.precio_media || 0) : (line.item.precio_completo || 0);
      return `<div class="checkout-item-row">
        <span>${esc(line.item.nombre)} <span class="checkout-item-qty">${line.qty || 1}× ${label}</span></span>
        <span>$${(price * (line.qty || 1)).toFixed(2)}</span>
      </div>`;
    }).join('');
  }

  const subtotalAmountEl = document.getElementById('checkout-subtotal-amount');
  if (subtotalAmountEl) subtotalAmountEl.textContent = `$${calcSubtotal().toFixed(2)}`;

  // Reset cash numpad
  cashInput = '';
  updateCashDisplay();

  // Reset payment method to efectivo
  document.querySelectorAll('.payment-toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === 'efectivo');
  });
  document.querySelectorAll('.payment-section').forEach(s => {
    s.classList.toggle('hidden', s.dataset.method !== 'efectivo');
  });

  // Reset confirm button
  const confirmBtn = document.getElementById('btn-confirm-payment');
  if (confirmBtn) confirmBtn.disabled = true;

  // Update card total
  updateCardTotal();

  showModal('modal-checkout');
}

function updateDiscountBreakdown() {
  const subtotal = calcSubtotal();
  const discountAmount = subtotal * (discountPct / 100);
  const total = subtotal - discountAmount;

  const breakdown = document.getElementById('checkout-totals-breakdown');
  const labelEl   = document.getElementById('totals-discount-label');
  const subEl     = document.getElementById('totals-subtotal-val');
  const discEl    = document.getElementById('totals-discount-amount');
  const totalEl   = document.getElementById('totals-total-val');

  if (discountPct > 0) {
    if (breakdown) breakdown.classList.remove('hidden');
    if (labelEl)   labelEl.textContent = `Descuento (${discountPct}%)`;
    if (subEl)     subEl.textContent   = `$${subtotal.toFixed(2)}`;
    if (discEl)    discEl.textContent  = `-$${discountAmount.toFixed(2)}`;
    if (totalEl)   totalEl.textContent = `$${total.toFixed(2)}`;
  } else {
    if (breakdown) breakdown.classList.add('hidden');
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
  const total = getEffectiveTotal();
  const totalCents = Math.round(total * 100);
  const inputCents = parseInt(cashInput || '0', 10);

  const displayEl = document.getElementById('cash-amount-display');
  if (displayEl) displayEl.textContent = `$${(inputCents / 100).toFixed(2)}`;

  const cambioEl  = document.getElementById('cambio-display');
  const confirmBtn = document.getElementById('btn-confirm-payment');

  if (inputCents >= totalCents) {
    const cambio = (inputCents - totalCents) / 100;
    if (cambioEl) {
      cambioEl.textContent = `Cambio: $${cambio.toFixed(2)}`;
      cambioEl.className   = 'cambio-display cambio-ok';
    }
    if (confirmBtn) confirmBtn.disabled = false;
  } else {
    const faltan = (totalCents - inputCents) / 100;
    if (cambioEl) {
      cambioEl.textContent = `Faltan: $${faltan.toFixed(2)}`;
      cambioEl.className   = 'cambio-display cambio-insuf';
    }
    if (confirmBtn) confirmBtn.disabled = true;
  }
}

/* =====================================================
   CONFIRM PAYMENT (pay-first flow)
   ===================================================== */
async function confirmPayment() {
  const order = await getOrder(currentOrderId);
  if (!order) return;

  // Validate discount reason
  if (discountPct > 0) {
    const reasonEl = document.getElementById('discount-reason');
    const reason = (reasonEl ? reasonEl.value : '').trim();
    if (!reason) {
      const errEl = document.getElementById('discount-error');
      if (errEl) { errEl.textContent = 'Escribe el motivo del descuento.'; errEl.classList.remove('hidden'); }
      return;
    }
  }

  // Validate phone
  const phoneEl = document.getElementById('customer-phone');
  const phoneRaw = phoneEl ? phoneEl.value.replace(/\D/g, '') : '';
  if (phoneRaw && phoneRaw.length !== 10) {
    const errEl = document.getElementById('customer-phone-error');
    if (errEl) { errEl.textContent = 'El teléfono debe tener 10 dígitos.'; errEl.classList.remove('hidden'); }
    return;
  }

  // Collect payment info
  const activeMethodBtn = document.querySelector('.payment-toggle-btn.active');
  const method = activeMethodBtn ? activeMethodBtn.dataset.method : 'efectivo';

  const effectiveTotal = getEffectiveTotal();
  const subtotal = calcSubtotal();
  const discountAmount = subtotal * (discountPct / 100);

  let efectivoRecibido = null;
  let cambio = null;
  if (method === 'efectivo') {
    efectivoRecibido = parseInt(cashInput || '0', 10) / 100;
    cambio = efectivoRecibido - effectiveTotal;
  }

  // Collect customer info
  const emailEl = document.getElementById('customer-email');
  const clienteEmail  = (emailEl ? emailEl.value.trim() : '') || null;
  const clientePhone  = phoneRaw || null;
  const reasonEl2     = document.getElementById('discount-reason');
  const discMotivo    = discountPct > 0 ? ((reasonEl2 ? reasonEl2.value.trim() : '') || null) : null;

  const folio = generateFolio();
  const now   = new Date().toISOString();

  // Update order
  await updateOrder({
    id_orden:          currentOrderId,
    estado:            'cobrada',
    subtotal:          effectiveTotal,
    metodo_pago:       method,
    efectivo_recibido: efectivoRecibido,
    cambio:            cambio,
    hora_enviada_cocina: now,
    hora_completada:   null,
    folio:             folio,
    cliente_email:     clienteEmail,
    cliente_telefono:  clientePhone,
    descuento_pct:     discountPct,
    descuento_monto:   discountAmount,
    descuento_motivo:  discMotivo
  });

  // Save detalles
  await deleteDetallesByOrder(currentOrderId);
  for (const line of currentOrderItems) {
    await saveDetalle({
      id_orden:  currentOrderId,
      articulo:  line.item.nombre,
      porcion:   line.porcion,
      cantidad:  line.qty || 1,
      precio:    line.porcion === 'media' ? (line.item.precio_media || 0) : (line.item.precio_completo || 0),
      notas:     line.notas || ''
    });
  }

  // Clear snapshot
  localStorage.removeItem('sj_hold_' + currentOrderId);

  await snapshotInProgress();

  // Broadcast to kitchen
  broadcast({ type: 'ORDER_TO_KITCHEN', orderId: currentOrderId, nombreMesa: order.nombre_mesa });

  // Send email ticket if provided
  if (clienteEmail) {
    try {
      const detalles = currentOrderItems.map(line => ({
        articulo: line.item.nombre,
        porcion:  line.porcion,
        cantidad: line.qty || 1,
        precio:   line.porcion === 'media' ? (line.item.precio_media || 0) : (line.item.precio_completo || 0),
        notas:    line.notas || ''
      }));
      await sendTicket(clienteEmail, {
        folio,
        nombreMesa:     order.nombre_mesa,
        detalles,
        subtotal,
        discountPct,
        discountAmount,
        total:          effectiveTotal,
        metodo_pago:    method,
        efectivoRec:    efectivoRecibido,
        cambio
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
    if (msg.type === 'ORDER_TO_KITCHEN' || msg.type === 'ORDER_CANCELLED' || msg.type === 'ORDER_HOLD') {
      refreshKitchenCards();
    }
  });
}

function updateKitchenClock() {
  const el = document.getElementById('kitchen-clock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

async function refreshKitchenCards() {
  const grid = document.getElementById('kitchen-grid');
  if (!grid) return;

  const orders = await getKitchenOrders();

  if (orders.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="text-align:center;padding:40px;color:#888">Sin órdenes pendientes</div>';
    return;
  }

  // Sort by hora_enviada_cocina ascending
  orders.sort((a, b) => new Date(a.hora_enviada_cocina || 0) - new Date(b.hora_enviada_cocina || 0));

  const cards = await Promise.all(orders.map(async o => {
    const detalles = await getDetallesByOrder(o.id_orden);
    const since = o.hora_enviada_cocina ? Math.floor((Date.now() - new Date(o.hora_enviada_cocina)) / 60000) : null;
    const urgent = since !== null && since >= 15;

    const itemsHtml = detalles.map(d => {
      const isUnidad = d.porcion === 'unidad';
      const isMedia  = d.porcion === 'media';
      const portionLabel = isUnidad ? '1 unidad' : (isMedia ? '½' : '1×');
      const notasHtml = d.notas ? `<div class="kitchen-item-notes">${esc(d.notas)}</div>` : '';
      return `<div class="kitchen-item-main">
        <span class="kitchen-item-portion">${portionLabel}</span>
        <div>
          <span class="kitchen-item-name">${esc(d.articulo)}</span>
          ${d.cantidad > 1 ? `<span class="kitchen-item-qty">×${d.cantidad}</span>` : ''}
          ${notasHtml}
        </div>
      </div>`;
    }).join('');

    return `
      <div class="kitchen-card ${urgent ? 'kitchen-card-urgent' : ''}" data-order-id="${o.id_orden}">
        <div class="kitchen-card-header">
          <span class="kitchen-card-name">${esc(o.nombre_mesa)}</span>
          ${since !== null ? `<span class="kitchen-elapsed ${urgent ? 'elapsed-urgent' : ''}">${since}m</span>` : ''}
        </div>
        <div class="kitchen-card-items">${itemsHtml}</div>
        <button class="kitchen-ready-btn" data-order-id="${o.id_orden}">Orden lista ✓</button>
      </div>`;
  }));

  grid.innerHTML = cards.join('');
}

async function markOrderReady(orderId) {
  const now = new Date().toISOString();
  await updateOrder({ id_orden: orderId, hora_completada: now });
  broadcast({ type: 'ORDER_READY', orderId });
  await refreshKitchenCards();
}

/* =====================================================
   VIEW: ADMIN
   ===================================================== */
async function renderAdmin() {
  showView('view-admin');

  const pin = localStorage.getItem('sj_admin_pin');
  if (!adminUnlocked && pin) {
    showAdminPinGate();
  } else if (!pin) {
    showAdminPinSetup();
  } else {
    renderAdminContent();
  }
}

function showAdminPinGate() {
  const wrapper = document.getElementById('admin-content-wrapper');
  if (!wrapper) return;
  wrapper.innerHTML = `
    <div class="pin-gate">
      <div class="pin-gate-title">Admin</div>
      <div class="pin-gate-subtitle">Ingresa tu PIN de 4 dígitos</div>
      <div class="pin-dots">
        <span class="pin-dot" id="pd0"></span>
        <span class="pin-dot" id="pd1"></span>
        <span class="pin-dot" id="pd2"></span>
        <span class="pin-dot" id="pd3"></span>
      </div>
      <div class="pin-keypad">
        ${[1,2,3,4,5,6,7,8,9,'','0','⌫'].map(k => `
          <button class="pin-key ${k === '' ? 'pin-key-empty' : ''}" data-key="${k}">${k}</button>
        `).join('')}
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
        <input type="password" id="setup-pin1" inputmode="numeric" maxlength="4" placeholder="">
      </div>
      <div class="form-field" style="max-width:240px;margin:0 auto 12px">
        <label class="form-label">Confirmar PIN</label>
        <input type="password" id="setup-pin2" inputmode="numeric" maxlength="4" placeholder="">
      </div>
      <div id="setup-pin-error" class="pin-error hidden" style="text-align:center;margin-bottom:8px"></div>
      <button id="btn-setup-pin" class="btn-primary">Crear PIN</button>
    </div>`;

  document.getElementById('btn-setup-pin').onclick = handlePinSetup;
}

function initPinKeypad(onComplete) {
  let pinBuffer = '';
  const dots = [0,1,2,3].map(i => document.getElementById('pd' + i));

  function updateDots() {
    dots.forEach((d, i) => {
      if (d) d.classList.toggle('filled', i < pinBuffer.length);
    });
  }

  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.key;
      if (key === '⌫') {
        pinBuffer = pinBuffer.slice(0, -1);
      } else if (key !== '' && pinBuffer.length < 4) {
        pinBuffer += key;
      }
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
    if (errEl) {
      errEl.classList.remove('hidden');
      setTimeout(() => errEl.classList.add('hidden'), 2000);
    }
  }
}

async function handlePinSetup() {
  const p1 = document.getElementById('setup-pin1')?.value;
  const p2 = document.getElementById('setup-pin2')?.value;
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
  renderAdminContent();
}

async function doChangePin() {
  const current = document.getElementById('change-pin-current')?.value;
  const new1    = document.getElementById('change-pin-new1')?.value;
  const new2    = document.getElementById('change-pin-new2')?.value;
  const errEl   = document.getElementById('change-pin-error');

  const stored = localStorage.getItem('sj_admin_pin');
  if (current !== stored) {
    if (errEl) { errEl.textContent = 'PIN actual incorrecto.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (!new1 || new1.length !== 4 || !/^\d{4}$/.test(new1)) {
    if (errEl) { errEl.textContent = 'El PIN nuevo debe ser exactamente 4 dígitos.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (new1 !== new2) {
    if (errEl) { errEl.textContent = 'Los PINes nuevos no coinciden.'; errEl.classList.remove('hidden'); }
    return;
  }
  localStorage.setItem('sj_admin_pin', new1);
  localStorage.setItem('sj_pin_length', '4');
  hideModal('modal-change-pin');
  showToast('PIN actualizado correctamente.');
}

/* =====================================================
   ADMIN CONTENT
   ===================================================== */
async function renderAdminContent() {
  const wrapper = document.getElementById('admin-content-wrapper');
  if (!wrapper) return;

  wrapper.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="menu">Menú</button>
      <button class="admin-tab" data-tab="reportes">Reportes</button>
      <button class="admin-tab" data-tab="config">Configuración</button>
    </div>
    <div id="admin-tab-content" class="admin-tab-content"></div>`;

  const tabs = wrapper.querySelectorAll('.admin-tab');
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderAdminTab(tab.dataset.tab);
    };
  });

  renderAdminTab('menu');
}

async function renderAdminTab(tab) {
  const content = document.getElementById('admin-tab-content');
  if (!content) return;

  if (tab === 'menu') {
    await renderMenuAdmin(content);
  } else if (tab === 'reportes') {
    await renderReportesAdmin(content);
  } else if (tab === 'config') {
    renderConfigAdmin(content);
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
        ${items.length === 0 ? '<div class="empty-state">No hay artículos.</div>' : items.map(item => `
          <div class="menu-admin-row">
            <div class="menu-admin-info">
              <span class="menu-admin-name ${!item.activo ? 'item-inactive' : ''}">${esc(item.nombre)}</span>
              <span class="menu-admin-cat">${esc(item.categoria)}</span>
            </div>
            <div class="menu-admin-prices">
              <span>$${(item.precio_completo||0).toFixed(2)}</span>
              ${item.tiene_media ? `<span class="price-media">½ $${(item.precio_media||0).toFixed(2)}</span>` : ''}
            </div>
            <div class="menu-admin-actions">
              <button class="btn-sm btn-secondary btn-edit-item" data-id="${item.id_articulo}">Editar</button>
              <button class="btn-sm ${item.activo ? 'btn-warning' : 'btn-success'} btn-toggle-item" data-id="${item.id_articulo}" data-activo="${item.activo}">
                ${item.activo ? 'Desactivar' : 'Activar'}
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;

  document.getElementById('btn-add-menu-item').onclick = () => showMenuItemForm(null);
  container.querySelectorAll('.btn-edit-item').forEach(b => {
    b.onclick = () => showMenuItemForm(parseInt(b.dataset.id));
  });
  container.querySelectorAll('.btn-toggle-item').forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.id);
      const newActivo = b.dataset.activo === 'true' ? false : true;
      await updateMenuItem({ id_articulo: id, activo: newActivo });
      renderMenuAdmin(container);
    };
  });
}

async function showMenuItemForm(itemId) {
  const item = itemId ? await getMenuItemById(itemId) : null;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'modal-menu-item-form';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title">${item ? 'Editar artículo' : 'Nuevo artículo'}</div>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        <div class="form-field">
          <label class="form-label">Nombre</label>
          <input type="text" id="mi-nombre" value="${escAttr(item?.nombre || '')}" maxlength="80">
        </div>
        <div class="form-field">
          <label class="form-label">Categoría</label>
          <input type="text" id="mi-cat" value="${escAttr(item?.categoria || '')}" maxlength="40" list="cat-list">
          <datalist id="cat-list">
            <option value="Empanadas"><option value="Antojitos"><option value="Platillos"><option value="Bebidas">
          </datalist>
        </div>
        <div class="form-field">
          <label class="form-label">Precio completo ($)</label>
          <input type="number" id="mi-precio" value="${item?.precio_completo || 0}" min="0" step="1">
        </div>
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
        <div id="mi-error" class="pin-error hidden"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="mi-cancel">Cancelar</button>
        <button class="btn-primary" id="mi-save">Guardar</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('mi-tiene-media').onchange = e => {
    document.getElementById('mi-media-row').style.display = e.target.checked ? '' : 'none';
  };
  document.getElementById('mi-cancel').onclick = () => modal.remove();
  document.getElementById('mi-save').onclick = async () => {
    const nombre     = document.getElementById('mi-nombre').value.trim();
    const categoria  = document.getElementById('mi-cat').value.trim();
    const precio     = parseFloat(document.getElementById('mi-precio').value) || 0;
    const tieneMedia = document.getElementById('mi-tiene-media').checked;
    const precioMedia = tieneMedia ? (parseFloat(document.getElementById('mi-precio-media').value) || 0) : null;
    const errEl = document.getElementById('mi-error');
    if (!nombre || !categoria) {
      if (errEl) { errEl.textContent = 'Nombre y categoría son requeridos.'; errEl.classList.remove('hidden'); }
      return;
    }
    const data = { nombre, categoria, precio_completo: precio, tiene_media: tieneMedia, precio_media: precioMedia, activo: item ? item.activo : true };
    if (item) {
      await updateMenuItem({ ...data, id_articulo: item.id_articulo });
    } else {
      await saveMenuItem(data);
    }
    modal.remove();
    const container = document.getElementById('admin-tab-content');
    if (container) renderMenuAdmin(container);
  };
}

/* ---------- Reportes Admin ---------- */
async function renderReportesAdmin(container) {
  container.innerHTML = `
    <div class="admin-section">
      <div class="admin-section-header">
        <span class="admin-section-title">Reporte del día</span>
        <input type="date" id="report-date" value="${todayStr()}" style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:13px">
      </div>
      <div id="report-stats" class="report-stats"></div>
      <div class="admin-section-title" style="margin-top:16px">Ventas por hora</div>
      <canvas id="hourly-chart" style="width:100%;border-radius:8px;background:var(--surface-1);padding:8px"></canvas>
      <div class="admin-section-title" style="margin-top:16px">Top 5 artículos</div>
      <div id="top-items-list"></div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-secondary btn-sm" id="btn-backup-drive">Exportar a Drive</button>
      </div>
    </div>`;

  const loadReport = async (date) => {
    const stats = await getTodayStats(date);
    const hourly = await getHourlyRevenue(date);
    const topItems = await getTopItems(date);

    const statsEl = document.getElementById('report-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="report-stat-card"><div class="stat-label">Ventas</div><div class="stat-value">$${stats.totalVentas.toFixed(2)}</div></div>
        <div class="report-stat-card"><div class="stat-label">Órdenes</div><div class="stat-value">${stats.ordenesCompletadas}</div></div>
        <div class="report-stat-card"><div class="stat-label">Ticket prom.</div><div class="stat-value">$${stats.ticketPromedio.toFixed(2)}</div></div>
        <div class="report-stat-card"><div class="stat-label">T. prep. prom.</div><div class="stat-value">${stats.tiempoPrepPromedio}m</div></div>`;
    }

    const canvas = document.getElementById('hourly-chart');
    if (canvas) renderHourlyChart(canvas, hourly);

    const topEl = document.getElementById('top-items-list');
    if (topEl) {
      topEl.innerHTML = topItems.length === 0
        ? '<div class="empty-state">Sin datos</div>'
        : topItems.map(t => `<div class="top-item-row"><span>${t.rank}. ${esc(t.nombre)}</span><span>${t.cantidad} uds.</span></div>`).join('');
    }
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

/* ---------- Config Admin ---------- */
function renderConfigAdmin(container) {
  const connected = isConnected();
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
    </div>`;

  if (connected) {
    document.getElementById('btn-disconnect-google').onclick = () => {
      showConfirm('¿Desconectar Google? Se perderá el acceso a Drive y email.', async () => {
        await disconnectGoogle();
        renderConfigAdmin(container);
      });
    };
  } else {
    document.getElementById('btn-connect-google').onclick = async () => {
      try { await connectGoogle(); renderConfigAdmin(container); }
      catch (e) { showToast('Error al conectar: ' + e.message); }
    };
  }
  document.getElementById('btn-open-change-pin').onclick = () => {
    document.getElementById('change-pin-current').value = '';
    document.getElementById('change-pin-new1').value = '';
    document.getElementById('change-pin-new2').value = '';
    const errEl = document.getElementById('change-pin-error');
    if (errEl) errEl.classList.add('hidden');
    showModal('modal-change-pin');
  };
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
  const el = document.getElementById(viewId);
  if (el) el.classList.remove('hidden');

  // Update bottom nav
  const viewMap = { 'view-home': 'home', 'view-kitchen': 'cocina', 'view-admin': 'admin' };
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewMap[viewId]);
  });
}

/* =====================================================
   ESCAPE HELPERS
   ===================================================== */
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttr(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

/* =====================================================
   GLOBAL EVENT DELEGATION
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

  // ---- Banner close ----
  if (t.classList.contains('banner-close')) {
    t.closest('.banner')?.classList.add('hidden');
    return;
  }
  if (t.id === 'btn-banner-admin') {
    navigate('./index.html?view=admin');
    return;
  }

  // ---- First launch OK ----
  if (t.id === 'btn-first-launch-ok') {
    localStorage.setItem('sj_first_launch_done', '1');
    hideModal('modal-first-launch');
    return;
  }

  // ---- Nueva mesa ----
  if (t.id === 'btn-new-table') {
    document.getElementById('nueva-mesa-input').value = '';
    const errEl = document.getElementById('nueva-mesa-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    showModal('modal-nueva-mesa');
    setTimeout(() => document.getElementById('nueva-mesa-input')?.focus(), 50);
    return;
  }
  if (t.id === 'btn-nueva-mesa-cancel') {
    hideModal('modal-nueva-mesa');
    return;
  }
  if (t.id === 'btn-nueva-mesa-ok') {
    const input = document.getElementById('nueva-mesa-input');
    const name  = (input?.value || '').trim();
    if (!name) {
      if (input) input.focus();
      return;
    }
    // Duplicate name check
    const openOrders = await getOpenOrders();
    const nameLower  = name.toLowerCase();
    const exists     = openOrders.some(o => o.nombre_mesa.toLowerCase().trim() === nameLower);
    if (exists) {
      const errEl = document.getElementById('nueva-mesa-error');
      if (errEl) {
        errEl.textContent = 'Ya hay una mesa abierta con ese nombre. Usa un nombre diferente.';
        errEl.classList.remove('hidden');
      }
      if (input) input.focus();
      return;
    }
    const errEl2 = document.getElementById('nueva-mesa-error');
    if (errEl2) errEl2.classList.add('hidden');

    const id = await saveOrder({ nombre_mesa: name, estado: 'pendiente', subtotal: 0, hora_orden: new Date().toISOString() });
    await snapshotInProgress();
    broadcast({ type: 'ORDER_CREATED', orderId: id, nombreMesa: name });
    hideModal('modal-nueva-mesa');
    navigate(`./index.html?mesa=${id}`);
    return;
  }

  // ---- Table card ----
  const tableCard = t.closest('.table-card');
  if (tableCard) {
    const orderId = parseInt(tableCard.dataset.orderId);
    navigate(`./index.html?mesa=${orderId}`);
    return;
  }

  // ---- Back button (order capture) ----
  if (t.id === 'btn-back') {
    showBackActionSheet();
    return;
  }

  // ---- Hold table button ----
  if (t.id === 'btn-hold-table') {
    showConfirm('¿Poner esta mesa en espera?', () => holdTable(), 'Poner en espera');
    return;
  }

  // ---- Cancel table button ----
  if (t.id === 'btn-cancel-table') {
    showConfirm('¿Cancelar esta mesa? Se perderán todos los artículos.', async () => {
      localStorage.removeItem('sj_hold_' + currentOrderId);
      await updateOrder({ id_orden: currentOrderId, estado: 'cancelada' });
      await snapshotInProgress();
      broadcast({ type: 'ORDER_CANCELLED', orderId: currentOrderId });
      navigate('./index.html');
    }, 'Cancelar mesa');
    return;
  }

  // ---- Add item to order ----
  if (t.classList.contains('btn-add-item')) {
    const itemId = parseInt(t.dataset.itemId);
    const porcion = t.dataset.porcion || 'completa';
    await addItemToOrder(itemId, porcion);
    return;
  }

  // ---- Qty controls ----
  if (t.classList.contains('btn-qty-inc')) {
    await adjustQty(parseInt(t.dataset.idx), 1);
    return;
  }
  if (t.classList.contains('btn-qty-dec')) {
    await adjustQty(parseInt(t.dataset.idx), -1);
    return;
  }

  // ---- Remove item ----
  if (t.classList.contains('btn-remove-item')) {
    await removeItemFromOrder(parseInt(t.dataset.idx));
    return;
  }

  // ---- Cobrar orden ----
  if (t.id === 'btn-cobrar-orden') {
    if (currentOrderItems.length === 0) {
      showToast('Agrega al menos un artículo antes de cobrar.');
      return;
    }
    openCheckout();
    return;
  }

  // ---- Checkout cancel ----
  if (t.id === 'btn-checkout-cancel') {
    hideModal('modal-checkout');
    return;
  }

  // ---- Discount pills ----
  if (t.classList.contains('discount-pill')) {
    document.querySelectorAll('.discount-pill').forEach(p => p.classList.remove('active'));
    t.classList.add('active');
    discountPct = parseInt(t.dataset.pct, 10) || 0;
    const reasonRow = document.getElementById('discount-reason-row');
    if (reasonRow) reasonRow.classList.toggle('hidden', discountPct === 0);
    const discErr = document.getElementById('discount-error');
    if (discErr) discErr.classList.add('hidden');
    updateDiscountBreakdown();
    return;
  }

  // ---- Payment method toggle ----
  if (t.classList.contains('payment-toggle-btn')) {
    document.querySelectorAll('.payment-toggle-btn').forEach(b => b.classList.remove('active'));
    t.classList.add('active');
    const method = t.dataset.method;
    document.querySelectorAll('.payment-section').forEach(s => {
      s.classList.toggle('hidden', s.dataset.method !== method);
    });
    // Card: always enable confirm button
    const confirmBtn = document.getElementById('btn-confirm-payment');
    if (method === 'tarjeta' && confirmBtn) confirmBtn.disabled = false;
    if (method === 'efectivo' && confirmBtn) updateCashDisplay();
    updateCardTotal();
    return;
  }

  // ---- Quick amounts ----
  if (t.classList.contains('quick-amount-btn')) {
    cashInput = String(parseInt(t.dataset.amount, 10) * 100);
    updateCashDisplay();
    return;
  }

  // ---- Numpad ----
  if (t.classList.contains('numpad-key')) {
    const key = t.dataset.key;
    if (key === '⌫') {
      cashInput = cashInput.slice(0, -1);
    } else if (cashInput.length < 7) {
      cashInput += key;
    }
    updateCashDisplay();
    return;
  }

  // ---- Confirm payment ----
  if (t.id === 'btn-confirm-payment') {
    await confirmPayment();
    return;
  }

  // ---- Help ----
  if (t.id === 'btn-help') {
    showModal('modal-first-launch');
    return;
  }

  // ---- Kitchen ready ----
  if (t.classList.contains('kitchen-ready-btn')) {
    const orderId = parseInt(t.dataset.orderId);
    await markOrderReady(orderId);
    return;
  }

  // ---- Change PIN ----
  if (t.id === 'btn-change-pin-cancel') { hideModal('modal-change-pin'); return; }
  if (t.id === 'btn-do-change-pin')    { await doChangePin(); return; }
});

/* ---- Input event delegation ---- */
document.addEventListener('input', (e) => {
  const t = e.target;

  // Per-item notes
  if (t.classList.contains('item-notes-input')) {
    const idx = parseInt(t.dataset.lineIdx);
    if (currentOrderItems[idx] !== undefined) {
      currentOrderItems[idx].notas = t.value;
      saveOrderSnapshot(currentOrderId);
    }
    return;
  }

  // Phone auto-format
  if (t.id === 'customer-phone') {
    const formatted = formatPhone(t.value);
    t.value = formatted;
    const errEl = document.getElementById('customer-phone-error');
    if (errEl) errEl.classList.add('hidden');
    return;
  }
});

/* ---- Keydown for nueva mesa Enter ---- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'nueva-mesa-input') {
    document.getElementById('btn-nueva-mesa-ok')?.click();
  }
});

/* =====================================================
   BOOT
   ===================================================== */
document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    console.error('Sabor Jarocho init error:', err);
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;
                  justify-content:center;height:100vh;font-family:sans-serif;
                  padding:24px;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <h2 style="color:#c0392b;margin:0 0 8px">Error al iniciar</h2>
        <p>${err.message || err}</p>
      </div>`;
  });
});
