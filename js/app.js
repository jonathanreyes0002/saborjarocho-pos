/**
 * app.js — Main controller for Sabor Jarocho PWA
 * Routing, view rendering, event delegation, crash recovery
 */

import {
  openDB, saveOrder, updateOrder, getOrder, getOpenOrders,
  saveDetalle, getDetallesByOrder, deleteDetallesByOrder,
  getMenuItems, saveMenuItem, updateMenuItem, deleteMenuItem,
  getMenuItemById, snapshotInProgress, recoverOrders,
  generateFolio, todayStr, getOrdersByDate
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
let currentOrderId  = null;  // active order being captured
let currentOrderItems = [];  // in-memory line items [{item, porcion}]
let adminUnlocked   = false; // PIN verified this session
let kitchenTimer    = null;  // interval for elapsed time
let checkoutData    = null;  // data for checkout overlay

/* =====================================================
   INIT
   ===================================================== */
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch(() => {});
  }

  // Lock orientation
  try { screen.orientation?.lock('landscape'); } catch(_) {}

  // Open DB
  await openDB();

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

function showConfirm(message, onConfirm) {
  const modal = document.getElementById('modal-confirm');
  const msgEl = modal.querySelector('.confirm-message');
  const okBtn = modal.querySelector('.btn-confirm-ok');
  if (msgEl) msgEl.textContent = message;
  const newOk = okBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOk, okBtn);
  newOk.addEventListener('click', () => {
    hideModal('modal-confirm');
    onConfirm();
  });
  showModal('modal-confirm');
}

/* =====================================================
   SHOW / HIDE VIEWS
   ===================================================== */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

/* =====================================================
   FORMAT HELPERS
   ===================================================== */
function fmtMXN(n) {
  return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (diff < 1)  return 'Abierta hace un momento';
  if (diff === 1) return 'Abierta hace 1 min';
  return `Abierta hace ${diff} min`;
}

function elapsedMin(isoStr) {
  if (!isoStr) return 0;
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
}

function statusLabel(estado) {
  switch (estado) {
    case 'pendiente':  return 'Capturando';
    case 'en_cocina':  return 'En cocina';
    case 'lista':      return 'Lista para cobrar';
    default:           return estado;
  }
}

function statusClass(estado) {
  switch (estado) {
    case 'pendiente': return 'status-pendiente';
    case 'en_cocina': return 'status-en_cocina';
    case 'lista':     return 'status-lista';
    default:          return 'status-pendiente';
  }
}

/* =====================================================
   HOME VIEW
   ===================================================== */
async function renderHome() {
  showView('view-home');
  updateNavActive('home');
  await refreshTableCards();

  listenSync(async (msg) => {
    await refreshTableCards();
  });
}

async function refreshTableCards() {
  const grid = document.getElementById('tables-grid');
  if (!grid) return;

  const orders = await getOpenOrders();
  if (orders.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:span 2">
        <div class="empty-state-icon">🍽️</div>
        <div class="empty-state-text">Sin mesas abiertas</div>
        <div class="empty-state-sub">Toca "+ Nueva mesa" para comenzar</div>
      </div>`;
    return;
  }

  // Collect detalles for each order to show item count
  const cards = await Promise.all(orders.map(async (order) => {
    const detalles = await getDetallesByOrder(order.id_orden);
    const itemCount = detalles.reduce((s, d) => s + (d.cantidad || 1), 0);
    return { order, detalles, itemCount };
  }));

  grid.innerHTML = cards.map(({ order, itemCount }) => `
    <div class="table-card" data-order-id="${order.id_orden}">
      <div class="table-card-header">
        <div class="table-card-name">${escHtml(order.nombre_mesa)}</div>
        <span class="status-badge ${statusClass(order.estado)}">${statusLabel(order.estado)}</span>
      </div>
      <div class="table-card-meta">${timeAgo(order.hora_orden)}</div>
      <div class="table-card-footer">
        <span>${itemCount} artículo${itemCount !== 1 ? 's' : ''}</span>
        <span class="table-card-total">${fmtMXN(order.subtotal)}</span>
      </div>
    </div>
  `).join('');
}

/* =====================================================
   ORDER CAPTURE VIEW
   ===================================================== */
async function renderOrderCapture(orderId) {
  currentOrderId    = orderId;
  currentOrderItems = [];

  const order = await getOrder(orderId);
  if (!order) { navigate('./index.html'); return; }

  // Restore items if order already had detalles
  const existingDetalles = await getDetallesByOrder(orderId);
  currentOrderItems = existingDetalles.map(d => ({
    id_detalle:     d.id_detalle,
    item: {
      id_articulo:     null,
      nombre:          d.articulo,
      categoria:       d.categoria,
      precio_completo: d.porcion === 'completa' ? d.precio_unitario : d.precio_unitario * 2,
      precio_media:    d.porcion === 'media'    ? d.precio_unitario : null,
      tiene_media:     d.porcion === 'media'
    },
    porcion: d.porcion
  }));

  showView('view-order');

  // Render header info
  document.getElementById('order-mesa-name').textContent  = order.nombre_mesa;
  const badge = document.getElementById('order-status-badge');
  badge.textContent  = statusLabel(order.estado);
  badge.className    = `status-badge ${statusClass(order.estado)}`;

  // Render menu
  await renderMenuPanel();
  renderOrderPanel(order);

  // BroadcastChannel listener — update status if kitchen marks ready
  listenSync(async (msg) => {
    if (msg.type === 'ORDER_READY' && msg.orderId === currentOrderId) {
      const updated = await getOrder(currentOrderId);
      if (updated) updateOrderHeader(updated);
    }
  });
}

function updateOrderHeader(order) {
  const badge = document.getElementById('order-status-badge');
  if (badge) {
    badge.textContent = statusLabel(order.estado);
    badge.className   = `status-badge ${statusClass(order.estado)}`;
  }
  const cobrarBtn = document.getElementById('btn-cobrar');
  if (cobrarBtn) {
    cobrarBtn.classList.toggle('hidden', order.estado !== 'lista');
  }
  const sendBtn = document.getElementById('btn-send-kitchen');
  if (sendBtn) {
    if (order.estado === 'en_cocina') {
      sendBtn.textContent = 'Orden enviada ✓';
      sendBtn.disabled    = true;
    } else if (order.estado === 'lista') {
      sendBtn.textContent = 'Enviar a cocina';
      sendBtn.disabled    = false;
    }
  }
}

async function renderMenuPanel() {
  const menuScroll = document.getElementById('menu-scroll');
  if (!menuScroll) return;

  const items = await getMenuItems();
  if (items.length === 0) {
    menuScroll.innerHTML = '<div class="order-empty">Sin artículos en el menú</div>';
    return;
  }

  // Group by category
  const byCategory = {};
  items.forEach(item => {
    if (!byCategory[item.categoria]) byCategory[item.categoria] = [];
    byCategory[item.categoria].push(item);
  });

  menuScroll.innerHTML = Object.entries(byCategory).map(([cat, catItems]) => `
    <div class="menu-category">
      <div class="menu-category-header">${escHtml(cat)}</div>
      ${catItems.map(item => {
        const disabled = item.precio_completo === 0;
        const halfBtn  = item.tiene_media
          ? `<button class="btn-add-half btn-add-item-half" data-id="${item.id_articulo}" ${disabled ? 'disabled' : ''}>½</button>`
          : '';
        const priceStr = item.precio_completo > 0
          ? fmtMXN(item.precio_completo)
          : '<span style="color:var(--danger-text);font-size:12px;">Sin precio</span>';
        return `
          <div class="menu-item-row ${disabled ? 'disabled' : ''}">
            <div class="menu-item-info">
              <div class="menu-item-name">${escHtml(item.nombre)}</div>
              <div class="menu-item-price">${priceStr}${item.tiene_media && item.precio_media > 0 ? ` · ½ ${fmtMXN(item.precio_media)}` : ''}</div>
            </div>
            <div class="menu-item-btns">
              ${halfBtn}
              <button class="btn-add-item btn-add-item-full" data-id="${item.id_articulo}" ${disabled ? 'disabled' : ''}>1 orden</button>
            </div>
          </div>`;
      }).join('')}
    </div>
  `).join('');
}

function renderOrderPanel(order) {
  const orderScroll  = document.getElementById('order-scroll');
  const summaryCount = document.getElementById('order-item-count');
  const summaryTotal = document.getElementById('order-subtotal');
  const cobrarBtn    = document.getElementById('btn-cobrar');
  const sendBtn      = document.getElementById('btn-send-kitchen');

  if (!orderScroll) return;

  if (currentOrderItems.length === 0) {
    orderScroll.innerHTML = '<div class="order-empty">Sin artículos — agrega del menú</div>';
  } else {
    orderScroll.innerHTML = currentOrderItems.map((line, idx) => {
      const precio = line.porcion === 'media'
        ? (line.item.precio_media || 0)
        : (line.item.precio_completo || 0);
      return `
        <div class="order-item-row" data-line="${idx}">
          <div class="order-item-info">
            <div class="order-item-name">${escHtml(line.item.nombre)}</div>
            <span class="portion-badge ${line.porcion === 'media' ? 'portion-media' : 'portion-completa'}">
              ${line.porcion === 'media' ? '½ orden' : '1 orden'}
            </span>
          </div>
          <div class="order-item-price">${fmtMXN(precio)}</div>
          <button class="btn-remove-item" data-remove="${idx}">×</button>
        </div>`;
    }).join('');
  }

  const subtotal = calcSubtotal();
  const count    = currentOrderItems.length;
  if (summaryCount) summaryCount.textContent = `${count} artículo${count !== 1 ? 's' : ''}`;
  if (summaryTotal) summaryTotal.textContent = fmtMXN(subtotal);

  if (cobrarBtn) cobrarBtn.classList.toggle('hidden', order.estado !== 'lista');

  if (sendBtn) {
    if (order.estado === 'en_cocina') {
      sendBtn.textContent = 'Orden enviada ✓';
      sendBtn.disabled    = true;
    } else {
      sendBtn.textContent = 'Enviar a cocina';
      sendBtn.disabled    = false;
    }
  }
}

function calcSubtotal() {
  return currentOrderItems.reduce((sum, line) => {
    const precio = line.porcion === 'media'
      ? (line.item.precio_media || 0)
      : (line.item.precio_completo || 0);
    return sum + precio;
  }, 0);
}

async function addItemToOrder(itemId, porcion) {
  const item = await getMenuItemById(itemId);
  if (!item) return;

  currentOrderItems.push({ item, porcion });

  const subtotal = calcSubtotal();
  await updateOrder(currentOrderId, { subtotal });
  await snapshotInProgress();

  const order = await getOrder(currentOrderId);
  renderOrderPanel(order);
}

async function removeItemFromOrder(idx) {
  currentOrderItems.splice(idx, 1);
  const subtotal = calcSubtotal();
  await updateOrder(currentOrderId, { subtotal });
  await snapshotInProgress();

  const order = await getOrder(currentOrderId);
  renderOrderPanel(order);
}

async function sendToKitchen() {
  if (currentOrderItems.length === 0) {
    alert('Agrega al menos un artículo antes de enviar a cocina.');
    return;
  }

  const folio    = generateFolio();
  const subtotal = calcSubtotal();
  const now      = new Date().toISOString();

  // Save detalles (replace any existing)
  await deleteDetallesByOrder(currentOrderId);
  for (const line of currentOrderItems) {
    const precio = line.porcion === 'media'
      ? (line.item.precio_media || 0)
      : (line.item.precio_completo || 0);
    await saveDetalle({
      id_orden:        currentOrderId,
      categoria:       line.item.categoria,
      articulo:        line.item.nombre,
      porcion:         line.porcion,
      cantidad:        1,
      precio_unitario: precio,
      subtotal_linea:  precio
    });
  }

  await updateOrder(currentOrderId, {
    estado:              'en_cocina',
    hora_enviada_cocina: now,
    folio,
    subtotal
  });

  await snapshotInProgress();
  broadcast({ type: 'ORDER_TO_KITCHEN', orderId: currentOrderId, nombreMesa: (await getOrder(currentOrderId)).nombre_mesa });

  const order = await getOrder(currentOrderId);
  updateOrderHeader(order);

  const sendBtn = document.getElementById('btn-send-kitchen');
  if (sendBtn) {
    sendBtn.textContent = 'Orden enviada ✓';
    sendBtn.disabled    = true;
  }
}

async function cancelTable() {
  showConfirm('¿Cancelar esta mesa? Se perderán los artículos.', async () => {
    await updateOrder(currentOrderId, { estado: 'cancelada' });
    await snapshotInProgress();
    broadcast({ type: 'ORDER_CANCELLED', orderId: currentOrderId });
    navigate('./index.html');
  });
}

/* =====================================================
   CHECKOUT OVERLAY
   ===================================================== */
async function openCheckout() {
  const order    = await getOrder(currentOrderId);
  const detalles = await getDetallesByOrder(currentOrderId);
  checkoutData   = { order, detalles };

  const overlay = document.getElementById('modal-checkout');

  // Build order summary
  const summaryEl = overlay.querySelector('.checkout-items-list');
  if (summaryEl) {
    summaryEl.innerHTML = detalles.map(d => `
      <div class="checkout-item-row">
        <span>${escHtml(d.articulo)} <small style="color:var(--text-secondary)">${d.porcion === 'media' ? '½' : '1x'}</small></span>
        <span>${fmtMXN(d.subtotal_linea)}</span>
      </div>`).join('');
  }

  const totalEl = overlay.querySelector('.checkout-total-amount');
  if (totalEl) totalEl.textContent = fmtMXN(order.subtotal);

  // Reset payment state
  showPaymentMethod('efectivo');
  resetNumpad();

  showModal('modal-checkout');
}

function showPaymentMethod(method) {
  const overlay = document.getElementById('modal-checkout');
  overlay.querySelectorAll('.payment-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });
  overlay.querySelectorAll('.payment-section').forEach(sec => {
    sec.classList.toggle('hidden', sec.dataset.method !== method);
  });

  const confirmBtn = document.getElementById('btn-confirm-payment');
  if (confirmBtn) {
    confirmBtn.disabled = method === 'efectivo';
  }
}

let receivedCents = 0;

function resetNumpad() {
  receivedCents = 0;
  updateCashDisplay();
}

function updateCashDisplay() {
  const order      = checkoutData?.order;
  const totalCents = Math.round((order?.subtotal || 0) * 100);
  const received   = receivedCents;

  const amountEl = document.getElementById('cash-amount-display');
  if (amountEl) amountEl.textContent = fmtMXN(received / 100);

  const cambioEl  = document.getElementById('cambio-display');
  const confirmBtn = document.getElementById('btn-confirm-payment');

  if (received >= totalCents) {
    const cambio = (received - totalCents) / 100;
    if (cambioEl) {
      cambioEl.className   = 'cambio-display cambio-ok';
      cambioEl.textContent = `Cambio: ${fmtMXN(cambio)}`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
  } else {
    const falta = (totalCents - received) / 100;
    if (cambioEl) {
      cambioEl.className   = 'cambio-display cambio-insuf';
      cambioEl.textContent = `Faltan: ${fmtMXN(falta)}`;
    }
    if (confirmBtn) confirmBtn.disabled = true;
  }
}

function numpadPress(key) {
  const totalCents = Math.round((checkoutData?.order?.subtotal || 0) * 100);

  if (key === '⌫') {
    receivedCents = Math.floor(receivedCents / 10);
  } else if (key === '00') {
    receivedCents = receivedCents * 100;
  } else {
    receivedCents = receivedCents * 10 + parseInt(key, 10);
  }

  // Cap at a reasonable maximum (99999.99)
  if (receivedCents > 9999999) receivedCents = 9999999;

  updateCashDisplay();
}

function quickAmount(amount) {
  receivedCents = amount * 100;
  updateCashDisplay();
}

async function confirmPayment() {
  const order = checkoutData?.order;
  if (!order) return;

  const activeMethod = document.querySelector('.payment-toggle-btn.active')?.dataset.method || 'efectivo';
  const totalCents   = Math.round((order.subtotal || 0) * 100);
  const now          = new Date().toISOString();

  let updateData = {
    estado:          'cobrada',
    metodo_pago:     activeMethod,
    hora_completada: now
  };

  if (activeMethod === 'efectivo') {
    updateData.efectivo_recibido = receivedCents / 100;
    updateData.cambio            = (receivedCents - totalCents) / 100;
  }

  await updateOrder(currentOrderId, updateData);
  await snapshotInProgress();
  broadcast({ type: 'ORDER_PAID', orderId: currentOrderId });

  // Show success screen
  showSuccessScreen(updateData);
}

function showSuccessScreen(updateData) {
  const overlay = document.getElementById('modal-checkout');
  const body    = overlay.querySelector('.modal-body');

  const cambioHtml = updateData.metodo_pago === 'efectivo' && updateData.cambio > 0
    ? `<div class="success-cambio">Cambio: <strong>${fmtMXN(updateData.cambio)}</strong></div>`
    : '';

  body.innerHTML = `
    <div class="success-screen">
      <div class="success-icon">✅</div>
      <div class="success-title">¡Pago completado!</div>
      ${cambioHtml}
      <div id="email-section" style="width:100%;max-width:360px;display:flex;flex-direction:column;gap:10px;align-items:center">
        <button id="btn-show-email" class="btn-secondary" style="width:100%">Enviar ticket por email</button>
        <div id="email-input-row" class="email-input-row hidden">
          <input type="email" id="ticket-email-input" placeholder="correo@ejemplo.com">
          <button id="btn-send-ticket" class="btn-primary" style="min-width:80px;padding:0 12px;font-size:14px;">Enviar</button>
        </div>
        <div id="email-status" class="email-status hidden"></div>
      </div>
      <button id="btn-nueva-orden" class="btn-primary" style="width:100%;max-width:360px">Nueva orden</button>
    </div>`;

  // Bind events
  document.getElementById('btn-show-email').addEventListener('click', () => {
    document.getElementById('email-input-row').classList.toggle('hidden');
  });

  document.getElementById('btn-send-ticket').addEventListener('click', async () => {
    const email = document.getElementById('ticket-email-input').value.trim();
    if (!isValidEmail(email)) {
      setEmailStatus('Correo inválido', false);
      return;
    }
    const order    = await getOrder(currentOrderId);
    const detalles = await getDetallesByOrder(currentOrderId);
    const config   = getConfig();

    setEmailStatus('Enviando…', null);
    const result = await sendTicket(email, order, detalles, config);
    if (result.success) {
      await updateOrder(currentOrderId, { ticket_enviado: true, ticket_email: email });
      setEmailStatus('Ticket enviado ✓', true);
    } else {
      setEmailStatus('Sin conexión — ticket no enviado', false);
    }
  });

  document.getElementById('btn-nueva-orden').addEventListener('click', () => {
    hideModal('modal-checkout');
    navigate('./index.html');
  });

  // Update footer buttons
  const footer = overlay.querySelector('.modal-footer');
  if (footer) footer.innerHTML = '';
}

function setEmailStatus(msg, ok) {
  const el = document.getElementById('email-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = `email-status ${ok === true ? 'ok' : ok === false ? 'error' : ''}`;
  el.classList.remove('hidden');
}

/* =====================================================
   KITCHEN VIEW
   ===================================================== */
async function renderKitchen() {
  showView('view-kitchen');
  updateNavActive('cocina');
  updateKitchenClock();
  await refreshKitchenCards();

  // Update clock every minute
  setInterval(updateKitchenClock, 60000);

  // Update elapsed times every 30s
  kitchenTimer = setInterval(refreshKitchenCardTimes, 30000);

  listenSync(async (msg) => {
    if (['ORDER_TO_KITCHEN', 'ORDER_CANCELLED', 'ORDER_PAID'].includes(msg.type)) {
      await refreshKitchenCards();
    }
  });
}

function updateKitchenClock() {
  const el = document.getElementById('kitchen-clock');
  if (el) {
    el.textContent = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
}

async function refreshKitchenCards() {
  const grid = document.getElementById('kitchen-grid');
  if (!grid) return;

  const orders = await getOpenOrders();
  const enCocina = orders
    .filter(o => o.estado === 'en_cocina')
    .sort((a, b) => new Date(a.hora_enviada_cocina) - new Date(b.hora_enviada_cocina));

  if (enCocina.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:span 2">
        <div class="empty-state-icon">✅</div>
        <div class="empty-state-text">Sin órdenes pendientes</div>
      </div>`;
    return;
  }

  const cards = await Promise.all(enCocina.map(async order => {
    const detalles = await getDetallesByOrder(order.id_orden);
    return { order, detalles };
  }));

  grid.innerHTML = cards.map(({ order, detalles }) => {
    const elapsed = elapsedMin(order.hora_enviada_cocina);
    const timeClass = elapsed < 10 ? 'time-green' : elapsed < 20 ? 'time-amber' : 'time-red';
    const urgent    = elapsed >= 20;

    const itemRows = detalles.map(d => `
      <div class="kitchen-item-row">
        <span class="kitchen-item-name">${escHtml(d.articulo)}</span>
        <span class="kitchen-item-portion">${d.porcion === 'media' ? '½' : '1x'}</span>
        <span class="kitchen-item-qty">${d.cantidad}</span>
      </div>`).join('');

    return `
      <div class="kitchen-card ${urgent ? 'urgent' : ''}" data-order-id="${order.id_orden}">
        <div class="kitchen-card-header">
          <span class="kitchen-table-name">${escHtml(order.nombre_mesa)}</span>
          <span class="kitchen-folio">${order.folio || ''}</span>
          <span class="kitchen-time-badge ${timeClass}" data-sent="${order.hora_enviada_cocina}">${elapsed} min</span>
        </div>
        <div class="kitchen-items">${itemRows || '<div style="color:var(--text-secondary);font-size:13px;padding:8px 0">Sin artículos</div>'}</div>
        <div class="kitchen-card-footer">
          <button class="btn-order-ready" data-order-id="${order.id_orden}">Orden lista ✓</button>
        </div>
      </div>`;
  }).join('');
}

function refreshKitchenCardTimes() {
  document.querySelectorAll('.kitchen-time-badge[data-sent]').forEach(badge => {
    const elapsed   = elapsedMin(badge.dataset.sent);
    badge.textContent = `${elapsed} min`;
    badge.className   = `kitchen-time-badge ${elapsed < 10 ? 'time-green' : elapsed < 20 ? 'time-amber' : 'time-red'}`;
    const card = badge.closest('.kitchen-card');
    if (card) card.classList.toggle('urgent', elapsed >= 20);
  });
}

async function markOrderReady(orderId) {
  const order = await getOrder(orderId);
  if (!order) return;

  const now   = new Date().toISOString();
  const prep  = order.hora_enviada_cocina
    ? (Date.now() - new Date(order.hora_enviada_cocina).getTime()) / 60000
    : null;

  await updateOrder(orderId, {
    estado:                 'lista',
    hora_completada:        now,
    tiempo_preparacion_min: prep
  });

  await snapshotInProgress();
  broadcast({ type: 'ORDER_READY', orderId, nombreMesa: order.nombre_mesa });

  // Animate card out
  const card = document.querySelector(`.kitchen-card[data-order-id="${orderId}"]`);
  if (card) {
    card.classList.add('exiting');
    setTimeout(() => card.remove(), 300);
  }
}

/* =====================================================
   ADMIN VIEW
   ===================================================== */
async function renderAdmin() {
  showView('view-admin');
  updateNavActive('admin');

  if (!adminUnlocked) {
    showAdminPinGate();
  } else {
    showAdminContent();
  }
}

function showAdminPinGate() {
  const container = document.getElementById('admin-content-wrapper');
  if (!container) return;

  const storedPin = localStorage.getItem('sj_admin_pin');
  const isFirstTime = !storedPin;

  container.innerHTML = `
    <div class="pin-gate">
      <div class="pin-title">${isFirstTime ? 'Configura tu PIN de administrador' : 'Acceso Admin'}</div>
      ${isFirstTime ? `
        <div style="font-size:14px;color:var(--text-secondary);text-align:center;">Cambia el PIN por defecto (1234) para proteger el panel.</div>
        <div class="form-field" style="width:100%;max-width:280px">
          <label class="form-label">PIN anterior</label>
          <input type="password" id="pin-old" inputmode="numeric" maxlength="6" value="1234" placeholder="1234">
        </div>
        <div class="form-field" style="width:100%;max-width:280px">
          <label class="form-label">PIN nuevo (4-6 dígitos)</label>
          <input type="password" id="pin-new1" inputmode="numeric" maxlength="6" placeholder="">
        </div>
        <div class="form-field" style="width:100%;max-width:280px">
          <label class="form-label">Confirmar PIN nuevo</label>
          <input type="password" id="pin-new2" inputmode="numeric" maxlength="6" placeholder="">
        </div>
        <div id="pin-error" class="pin-error hidden"></div>
        <button id="btn-setup-pin" class="btn-primary" style="width:100%;max-width:280px">Guardar PIN</button>
      ` : `
        <div class="pin-dots" id="pin-dots">
          <div class="pin-dot"></div>
          <div class="pin-dot"></div>
          <div class="pin-dot"></div>
          <div class="pin-dot"></div>
        </div>
        <div class="pin-keypad" id="pin-keypad">
          ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-key" data-key="${n}">${n}</button>`).join('')}
          <button class="pin-key pin-empty"></button>
          <button class="pin-key" data-key="0">0</button>
          <button class="pin-key pin-backspace" data-key="⌫">⌫</button>
        </div>
        <div id="pin-error" class="pin-error hidden"></div>
        <div id="pin-lockout" class="pin-lockout hidden"></div>
      `}
    </div>`;

  if (isFirstTime) {
    document.getElementById('btn-setup-pin').addEventListener('click', handlePinSetup);
  } else {
    initPinKeypad();
  }
}

let pinAttempts   = 0;
let pinLockoutEnd = 0;
let pinBuffer     = '';

function initPinKeypad() {
  pinBuffer   = '';
  pinAttempts = pinAttempts || 0;

  const keypad = document.getElementById('pin-keypad');
  if (!keypad) return;

  keypad.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (!key) return;

    if (Date.now() < pinLockoutEnd) return;

    if (key === '⌫') {
      pinBuffer = pinBuffer.slice(0, -1);
    } else if (pinBuffer.length < 6) {
      pinBuffer += key;
    }

    updatePinDots(pinBuffer.length);

    if (pinBuffer.length >= 4) {
      setTimeout(() => verifyPin(pinBuffer), 100);
    }
  });
}

function updatePinDots(count) {
  document.querySelectorAll('.pin-dot').forEach((dot, i) => {
    dot.classList.toggle('filled', i < count);
  });
}

async function verifyPin(entered) {
  const stored = localStorage.getItem('sj_admin_pin');
  const hash   = await hashPin(entered);

  if (hash === stored) {
    pinAttempts = 0;
    pinBuffer   = '';
    adminUnlocked = true;
    showAdminContent();
  } else {
    pinAttempts++;
    pinBuffer = '';
    updatePinDots(0);

    if (pinAttempts >= 3) {
      pinLockoutEnd = Date.now() + 30000;
      startLockoutCountdown();
    } else {
      const errEl = document.getElementById('pin-error');
      if (errEl) {
        errEl.textContent = `PIN incorrecto. ${3 - pinAttempts} intento${3 - pinAttempts !== 1 ? 's' : ''} restante${3 - pinAttempts !== 1 ? 's' : ''}.`;
        errEl.classList.remove('hidden');
      }
    }
  }
}

function startLockoutCountdown() {
  const lockEl = document.getElementById('pin-lockout');
  if (!lockEl) return;

  const errEl = document.getElementById('pin-error');
  if (errEl) errEl.classList.add('hidden');

  lockEl.classList.remove('hidden');

  const tick = () => {
    const remaining = Math.ceil((pinLockoutEnd - Date.now()) / 1000);
    if (remaining <= 0) {
      lockEl.classList.add('hidden');
      pinAttempts = 0;
      return;
    }
    lockEl.textContent = `Demasiados intentos. Espera ${remaining}s`;
    setTimeout(tick, 1000);
  };
  tick();
}

async function handlePinSetup() {
  const oldPin  = document.getElementById('pin-old').value.trim();
  const newPin1 = document.getElementById('pin-new1').value.trim();
  const newPin2 = document.getElementById('pin-new2').value.trim();
  const errEl   = document.getElementById('pin-error');

  const showErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  };

  // Validate old PIN (default 1234)
  const storedHash = localStorage.getItem('sj_admin_pin');
  const defaultHash = await hashPin('1234');
  if (storedHash && storedHash !== defaultHash) {
    const oldHash = await hashPin(oldPin);
    if (oldHash !== storedHash) { showErr('PIN anterior incorrecto.'); return; }
  }

  if (newPin1.length < 4) { showErr('El PIN nuevo debe tener al menos 4 dígitos.'); return; }
  if (!/^\d+$/.test(newPin1)) { showErr('El PIN solo puede contener dígitos.'); return; }
  if (newPin1 !== newPin2)  { showErr('Los PINs nuevos no coinciden.'); return; }

  const hash = await hashPin(newPin1);
  localStorage.setItem('sj_admin_pin', hash);
  adminUnlocked = true;
  showAdminContent();
}

async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function showAdminContent() {
  const container = document.getElementById('admin-content-wrapper');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="menu">Menú</button>
      <button class="admin-tab" data-tab="config">Configuración</button>
      <button class="admin-tab" data-tab="reportes">Reportes</button>
    </div>
    <div id="tab-menu"     class="admin-tab-content active"></div>
    <div id="tab-config"   class="admin-tab-content"></div>
    <div id="tab-reportes" class="admin-tab-content"></div>`;

  container.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabId = `tab-${btn.dataset.tab}`;
      document.getElementById(tabId)?.classList.add('active');
      if (btn.dataset.tab === 'menu')     renderMenuTab();
      if (btn.dataset.tab === 'config')   renderConfigTab();
      if (btn.dataset.tab === 'reportes') renderReportesTab();
    });
  });

  renderMenuTab();
}

/* ---- MENU TAB ---- */
async function renderMenuTab() {
  const tab = document.getElementById('tab-menu');
  if (!tab) return;

  const items = await getMenuItems();

  // Group by category
  const byCategory = {};
  items.forEach(item => {
    if (!byCategory[item.categoria]) byCategory[item.categoria] = [];
    byCategory[item.categoria].push(item);
  });

  let html = '';
  for (const [cat, catItems] of Object.entries(byCategory)) {
    html += `
      <div class="menu-section" data-category="${escAttr(cat)}">
        <div class="menu-section-header">
          <span class="menu-section-title">${escHtml(cat)}</span>
          <span class="menu-section-count">${catItems.length} artículo${catItems.length !== 1 ? 's' : ''}</span>
          <label class="toggle-switch" title="Desactivar categoría">
            <input type="checkbox" class="cat-toggle" data-category="${escAttr(cat)}" ${catItems.every(i => i.activo) ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        ${catItems.map((item, idx) => `
          <div class="menu-item-admin-row" data-item-id="${item.id_articulo}">
            <div class="btn-reorder-group" style="display:flex;flex-direction:column;gap:2px">
              <button class="btn-reorder btn-move-up" data-id="${item.id_articulo}" data-cat="${escAttr(cat)}" ${idx === 0 ? 'disabled style="opacity:0.3"' : ''}>▲</button>
              <button class="btn-reorder btn-move-down" data-id="${item.id_articulo}" data-cat="${escAttr(cat)}" ${idx === catItems.length - 1 ? 'disabled style="opacity:0.3"' : ''}>▼</button>
            </div>
            <div class="menu-admin-info">
              <div class="menu-admin-name">${escHtml(item.nombre)}</div>
              <div class="menu-admin-prices">
                Completa: ${item.precio_completo > 0 ? fmtMXN(item.precio_completo) : '<span style="color:var(--danger-text)">Sin precio</span>'}
                ${item.tiene_media ? ` · ½: ${item.precio_media > 0 ? fmtMXN(item.precio_media) : '<span style="color:var(--danger-text)">Sin precio</span>'}` : ''}
              </div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" class="item-active-toggle" data-id="${item.id_articulo}" ${item.activo ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="btn-icon btn-edit" data-id="${item.id_articulo}">Editar</button>
            <button class="btn-icon btn-delete" data-id="${item.id_articulo}">Eliminar</button>
          </div>
          <div id="edit-form-${item.id_articulo}" class="edit-form hidden"></div>
        `).join('')}
      </div>`;
  }

  html += `<button class="btn-add-category" id="btn-add-category">+ Agregar categoría</button>`;
  tab.innerHTML = html;

  // Bind events
  tab.addEventListener('change', handleMenuTabChange);
  tab.addEventListener('click',  handleMenuTabClick);
}

async function handleMenuTabChange(e) {
  const target = e.target;

  if (target.classList.contains('item-active-toggle')) {
    const id = parseInt(target.dataset.id, 10);
    await updateMenuItem(id, { activo: target.checked });
    broadcast({ type: 'MENU_UPDATED' });
    await checkPriceWarning();
  }

  if (target.classList.contains('cat-toggle')) {
    const cat   = target.dataset.category;
    const items = await getMenuItems({ categoria: cat });
    for (const item of items) {
      await updateMenuItem(item.id_articulo, { activo: target.checked });
    }
    broadcast({ type: 'MENU_UPDATED' });
  }
}

async function handleMenuTabClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.classList.contains('btn-edit')) {
    const id = parseInt(btn.dataset.id, 10);
    toggleEditForm(id);
    return;
  }

  if (btn.classList.contains('btn-delete')) {
    const id   = parseInt(btn.dataset.id, 10);
    const item = await getMenuItemById(id);
    showConfirm(`¿Eliminar "${item?.nombre}"? Esta acción no se puede deshacer.`, async () => {
      await deleteMenuItem(id);
      broadcast({ type: 'MENU_UPDATED' });
      await renderMenuTab();
    });
    return;
  }

  if (btn.classList.contains('btn-move-up') || btn.classList.contains('btn-move-down')) {
    const id  = parseInt(btn.dataset.id, 10);
    const cat = btn.dataset.cat;
    await reorderItem(id, cat, btn.classList.contains('btn-move-up') ? -1 : 1);
    await renderMenuTab();
    return;
  }

  if (btn.id === 'btn-add-category') {
    const name = prompt('Nombre de la nueva categoría:');
    if (name?.trim()) {
      await saveMenuItem({
        categoria:       name.trim(),
        nombre:          'Nuevo artículo',
        precio_completo: 0,
        tiene_media:     false,
        activo:          true,
        orden_display:   1
      });
      broadcast({ type: 'MENU_UPDATED' });
      await renderMenuTab();
    }
    return;
  }
}

async function toggleEditForm(id) {
  const formEl = document.getElementById(`edit-form-${id}`);
  if (!formEl) return;

  if (!formEl.classList.contains('hidden')) {
    formEl.classList.add('hidden');
    return;
  }

  const item       = await getMenuItemById(id);
  const allItems   = await getMenuItems();
  const categories = [...new Set(allItems.map(i => i.categoria))];

  formEl.innerHTML = `
    <div class="form-row">
      <div class="form-field">
        <label class="form-label">Nombre</label>
        <input type="text" id="ef-nombre-${id}" value="${escAttr(item.nombre)}">
      </div>
      <div class="form-field">
        <label class="form-label">Categoría</label>
        <select id="ef-cat-${id}">
          ${categories.map(c => `<option value="${escAttr(c)}" ${c === item.categoria ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-field">
        <label class="form-label">Precio orden completa (MXN)</label>
        <input type="number" id="ef-precio-${id}" value="${item.precio_completo}" min="0" step="0.5">
      </div>
      <div class="form-field">
        <div class="toggle-row">
          <span class="toggle-label">¿Tiene media orden?</span>
          <label class="toggle-switch">
            <input type="checkbox" id="ef-tiene-media-${id}" ${item.tiene_media ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>
    <div class="form-row" id="ef-media-row-${id}" ${item.tiene_media ? '' : 'style="display:none"'}>
      <div class="form-field">
        <label class="form-label">Precio media orden (MXN)</label>
        <input type="number" id="ef-precio-media-${id}" value="${item.precio_media || ''}" min="0" step="0.5">
      </div>
      <div class="form-field">
        <div class="toggle-row">
          <span class="toggle-label">Activo</span>
          <label class="toggle-switch">
            <input type="checkbox" id="ef-activo-${id}" ${item.activo ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-cancel-form" id="ef-cancel-${id}">Cancelar</button>
      <button class="btn-save" id="ef-save-${id}">Guardar</button>
    </div>`;

  formEl.classList.remove('hidden');

  // Toggle media price visibility
  const tieneMediaChk = document.getElementById(`ef-tiene-media-${id}`);
  tieneMediaChk.addEventListener('change', () => {
    document.getElementById(`ef-media-row-${id}`).style.display = tieneMediaChk.checked ? '' : 'none';
  });

  document.getElementById(`ef-cancel-${id}`).addEventListener('click', () => {
    formEl.classList.add('hidden');
  });

  document.getElementById(`ef-save-${id}`).addEventListener('click', async () => {
    const nombre      = document.getElementById(`ef-nombre-${id}`).value.trim();
    const categoria   = document.getElementById(`ef-cat-${id}`).value;
    const precio      = parseFloat(document.getElementById(`ef-precio-${id}`).value) || 0;
    const tieneMedia  = document.getElementById(`ef-tiene-media-${id}`).checked;
    const precioMedia = tieneMedia ? (parseFloat(document.getElementById(`ef-precio-media-${id}`).value) || 0) : null;
    const activo      = document.getElementById(`ef-activo-${id}`).checked;

    await updateMenuItem(id, { nombre, categoria, precio_completo: precio, tiene_media: tieneMedia, precio_media: precioMedia, activo });
    broadcast({ type: 'MENU_UPDATED' });
    await checkPriceWarning();
    await renderMenuTab();
  });
}

async function reorderItem(itemId, cat, direction) {
  const items = await getMenuItems({ categoria: cat });
  const idx   = items.findIndex(i => i.id_articulo === itemId);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= items.length) return;

  const a = items[idx];
  const b = items[swapIdx];
  await updateMenuItem(a.id_articulo, { orden_display: b.orden_display });
  await updateMenuItem(b.id_articulo, { orden_display: a.orden_display });
}

/* ---- CONFIG TAB ---- */
async function renderConfigTab() {
  const tab = document.getElementById('tab-config');
  if (!tab) return;

  const config   = getConfig();
  const connected = await isConnected();

  tab.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">Información del negocio</div>
      <div class="form-field">
        <label class="form-label">Nombre del negocio</label>
        <input type="text" id="cfg-nombre" value="${escAttr(config.nombre || 'Sabor Jarocho')}">
      </div>
      <div class="form-field">
        <label class="form-label">Dirección</label>
        <input type="text" id="cfg-direccion" value="${escAttr(config.direccion || 'Av. P. de la Victoria 2118, Partido Senecú, 32459')}">
      </div>
      <div class="form-field">
        <label class="form-label">Mensaje de cierre en ticket</label>
        <input type="text" id="cfg-cierre" value="${escAttr(config.cierre || 'Gracias por su visita. ¡Vuelva pronto!')}">
      </div>
      <div class="form-field">
        <label class="form-label">Hora de respaldo automático</label>
        <input type="time" id="cfg-backup-time" value="${escAttr(config.backupTime || '02:00')}">
      </div>
      <button id="btn-save-config" class="btn-primary">Guardar configuración</button>
    </div>

    <div class="config-section">
      <div class="config-section-title">Cuenta Google</div>
      <div class="google-status">
        <span class="status-dot ${connected ? 'connected' : 'disconnected'}"></span>
        <span id="google-status-text">${connected ? 'Conectado' : 'No conectado'}</span>
      </div>
      <p class="config-note">Se usa para enviar tickets por Gmail y respaldar ventas en Google Drive.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="btn-connect-google" class="btn-secondary" ${connected ? 'style="display:none"' : ''}>Conectar cuenta Google</button>
        <button id="btn-disconnect-google" class="btn-danger" ${connected ? '' : 'style="display:none"'}>Desconectar</button>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">PIN de administrador</div>
      <button id="btn-change-pin" class="btn-secondary">Cambiar PIN</button>
    </div>

    <div class="config-section">
      <div class="config-section-title">Respaldo en Google Drive</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
        Último respaldo: <strong>${localStorage.getItem('sj_last_backup') || 'Nunca'}</strong>
      </div>
      <button id="btn-backup-now" class="btn-secondary">Respaldar ahora</button>
      <div id="backup-status" class="hidden" style="margin-top:8px;font-size:14px"></div>
    </div>`;

  document.getElementById('btn-save-config').addEventListener('click', () => {
    const cfg = {
      nombre:     document.getElementById('cfg-nombre').value.trim(),
      direccion:  document.getElementById('cfg-direccion').value.trim(),
      cierre:     document.getElementById('cfg-cierre').value.trim(),
      backupTime: document.getElementById('cfg-backup-time').value
    };
    localStorage.setItem('sj_config', JSON.stringify(cfg));
    showToast('Configuración guardada');
  });

  document.getElementById('btn-connect-google').addEventListener('click', async () => {
    try {
      await connectGoogle();
      document.getElementById('google-status-text').textContent = 'Conectado';
      document.querySelector('.status-dot').className = 'status-dot connected';
      document.getElementById('btn-connect-google').style.display    = 'none';
      document.getElementById('btn-disconnect-google').style.display = '';
    } catch (e) {
      alert('Error al conectar Google: ' + e.message);
    }
  });

  document.getElementById('btn-disconnect-google').addEventListener('click', () => {
    disconnectGoogle();
    document.getElementById('google-status-text').textContent = 'No conectado';
    document.querySelector('.status-dot').className = 'status-dot disconnected';
    document.getElementById('btn-connect-google').style.display    = '';
    document.getElementById('btn-disconnect-google').style.display = 'none';
  });

  document.getElementById('btn-change-pin').addEventListener('click', () => {
    showChangePinModal();
  });

  document.getElementById('btn-backup-now').addEventListener('click', async () => {
    const statusEl = document.getElementById('backup-status');
    statusEl.textContent = 'Creando respaldo…';
    statusEl.className   = '';
    statusEl.classList.remove('hidden');

    try {
      const today  = todayStr();
      const orders = await getOrdersByDate(today);
      const detallesMap = {};
      for (const o of orders) {
        detallesMap[o.id_orden] = await getDetallesByOrder(o.id_orden);
      }
      const csv    = buildBackupCSV(orders, detallesMap);
      const result = await backupToDrive(csv);

      if (result.success) {
        const now = new Date().toLocaleString('es-MX');
        localStorage.setItem('sj_last_backup', now);
        statusEl.textContent = '✓ Respaldo completado';
        statusEl.style.color = 'var(--success-text)';
      } else {
        statusEl.textContent = 'Error: ' + result.error;
        statusEl.style.color = 'var(--danger-text)';
      }
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.style.color  = 'var(--danger-text)';
    }
  });
}

function showChangePinModal() {
  const modal = document.getElementById('modal-change-pin');
  if (!modal) return;
  modal.querySelector('input').value = '';
  document.getElementById('change-pin-new1').value = '';
  document.getElementById('change-pin-new2').value = '';
  document.getElementById('change-pin-error').classList.add('hidden');
  showModal('modal-change-pin');
}

/* ---- REPORTES TAB ---- */
async function renderReportesTab() {
  const tab = document.getElementById('tab-reportes');
  if (!tab) return;

  const stats    = await getTodayStats();
  const topItems = await getTopItems();
  const hourly   = await getHourlyRevenue();

  tab.innerHTML = `
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-label">Total ventas hoy</div>
        <div class="stat-value">${fmtMXN(stats.totalVentas)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Órdenes completadas</div>
        <div class="stat-value">${stats.ordenesCompletadas}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Ticket promedio</div>
        <div class="stat-value">${fmtMXN(stats.ticketPromedio)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tiempo prep. prom.</div>
        <div class="stat-value">${stats.tiempoPrepPromedio} min</div>
      </div>
    </div>

    <div class="reports-section">
      <div class="reports-section-title">Top 5 artículos (hoy)</div>
      ${topItems.length === 0
        ? '<div style="color:var(--text-secondary);font-size:14px">Sin ventas hoy</div>'
        : topItems.map(item => `
          <div class="top-item-row">
            <span class="top-item-rank">${item.rank}</span>
            <span class="top-item-name">${escHtml(item.nombre)}</span>
            <span class="top-item-qty">${item.cantidad}</span>
          </div>`).join('')
      }
    </div>

    <div class="reports-section">
      <div class="reports-section-title">Ventas por hora (hoy)</div>
      <div class="chart-container">
        <canvas id="hourly-chart"></canvas>
      </div>
    </div>`;

  // Render chart after DOM update
  requestAnimationFrame(() => {
    const canvas = document.getElementById('hourly-chart');
    if (canvas) renderHourlyChart(canvas, hourly);
  });
}

/* =====================================================
   CONFIG HELPERS
   ===================================================== */
function getConfig() {
  try {
    return JSON.parse(localStorage.getItem('sj_config') || '{}');
  } catch {
    return {};
  }
}

/* =====================================================
   NAV HELPERS
   ===================================================== */
function updateNavActive(view) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });
}

/* =====================================================
   TOAST (simple feedback)
   ===================================================== */
function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:#1C2833;color:#fff;padding:10px 20px;border-radius:20px;
    font-size:14px;font-weight:600;z-index:9999;
    animation:fadeInOut 2.5s ease forwards;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

/* =====================================================
   UTILITY
   ===================================================== */
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* =====================================================
   EVENT DELEGATION — GLOBAL
   ===================================================== */
document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]') || e.target;

  // Banner close
  if (target.classList.contains('banner-close')) {
    target.closest('.banner')?.classList.add('hidden');
    return;
  }

  // Banner "Ir a Admin" button
  if (target.id === 'btn-banner-admin') {
    navigate('./index.html?view=admin');
    return;
  }

  // First launch modal dismiss
  if (target.id === 'btn-first-launch-ok') {
    localStorage.setItem('sj_first_launch_done', 'true');
    hideModal('modal-first-launch');
    return;
  }

  // Help button (re-open first launch modal)
  if (target.id === 'btn-help') {
    showModal('modal-first-launch');
    return;
  }

  // Confirm modal cancel
  if (target.classList.contains('btn-confirm-cancel')) {
    hideModal('modal-confirm');
    return;
  }

  // Nueva mesa button
  if (target.id === 'btn-new-table') {
    showModal('modal-nueva-mesa');
    setTimeout(() => document.getElementById('nueva-mesa-input')?.focus(), 50);
    return;
  }

  // Nueva mesa confirm
  if (target.id === 'btn-nueva-mesa-ok') {
    const input = document.getElementById('nueva-mesa-input');
    const name  = input?.value.trim();
    if (!name) { input?.focus(); return; }
    const orderId = await saveOrder({ nombre_mesa: name, estado: 'pendiente' });
    await snapshotInProgress();
    broadcast({ type: 'ORDER_CREATED', orderId, nombreMesa: name });
    hideModal('modal-nueva-mesa');
    navigate(`./index.html?mesa=${orderId}`);
    return;
  }

  // Nueva mesa cancel
  if (target.id === 'btn-nueva-mesa-cancel') {
    hideModal('modal-nueva-mesa');
    return;
  }

  // Table card tap
  if (target.closest('.table-card')) {
    const card    = target.closest('.table-card');
    const orderId = card.dataset.orderId;
    if (orderId) navigate(`./index.html?mesa=${orderId}`);
    return;
  }

  // Back button
  if (target.id === 'btn-back' || target.closest('#btn-back')) {
    navigate('./index.html');
    return;
  }

  // Cancel mesa
  if (target.id === 'btn-cancel-table') {
    await cancelTable();
    return;
  }

  // Add item full
  if (target.classList.contains('btn-add-item-full')) {
    const id = parseInt(target.dataset.id, 10);
    await addItemToOrder(id, 'completa');
    return;
  }

  // Add item half
  if (target.classList.contains('btn-add-item-half')) {
    const id = parseInt(target.dataset.id, 10);
    await addItemToOrder(id, 'media');
    return;
  }

  // Remove item from order
  if (target.closest('.btn-remove-item')) {
    const btn = target.closest('.btn-remove-item');
    const idx = parseInt(btn.dataset.remove, 10);
    await removeItemFromOrder(idx);
    return;
  }

  // Send to kitchen
  if (target.id === 'btn-send-kitchen') {
    await sendToKitchen();
    return;
  }

  // Cobrar
  if (target.id === 'btn-cobrar') {
    await openCheckout();
    return;
  }

  // Kitchen — order ready
  if (target.classList.contains('btn-order-ready')) {
    const orderId = parseInt(target.dataset.orderId, 10);
    await markOrderReady(orderId);
    return;
  }

  // Bottom nav
  if (target.closest('.nav-item')) {
    const nav  = target.closest('.nav-item');
    const view = nav.dataset.view;
    if (view === 'home')   navigate('./index.html');
    if (view === 'cocina') navigate('./index.html?view=cocina');
    if (view === 'admin')  navigate('./index.html?view=admin');
    return;
  }

  // Checkout — payment toggle
  if (target.classList.contains('payment-toggle-btn')) {
    showPaymentMethod(target.dataset.method);
    return;
  }

  // Checkout — quick amounts
  if (target.classList.contains('quick-amount-btn')) {
    quickAmount(parseInt(target.dataset.amount, 10));
    return;
  }

  // Checkout — numpad
  if (target.classList.contains('numpad-key')) {
    numpadPress(target.dataset.key);
    return;
  }

  // Checkout — confirm payment
  if (target.id === 'btn-confirm-payment') {
    await confirmPayment();
    return;
  }

  // Checkout — close (cancel checkout)
  if (target.id === 'btn-checkout-cancel') {
    hideModal('modal-checkout');
    return;
  }

  // Change PIN
  if (target.id === 'btn-do-change-pin') {
    await doChangePin();
    return;
  }

  if (target.id === 'btn-change-pin-cancel') {
    hideModal('modal-change-pin');
    return;
  }
});

// Nueva mesa — enter key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const input = document.getElementById('nueva-mesa-input');
    if (document.activeElement === input) {
      document.getElementById('btn-nueva-mesa-ok')?.click();
    }
  }
});

async function doChangePin() {
  const current = document.getElementById('change-pin-current').value.trim();
  const new1    = document.getElementById('change-pin-new1').value.trim();
  const new2    = document.getElementById('change-pin-new2').value.trim();
  const errEl   = document.getElementById('change-pin-error');

  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden'); };

  const storedHash  = localStorage.getItem('sj_admin_pin');
  const currentHash = await hashPin(current);
  if (currentHash !== storedHash) { showErr('PIN actual incorrecto.'); return; }
  if (new1.length < 4)  { showErr('El nuevo PIN debe tener al menos 4 dígitos.'); return; }
  if (!/^\d+$/.test(new1)) { showErr('Solo se permiten dígitos.'); return; }
  if (new1 !== new2)  { showErr('Los PINs no coinciden.'); return; }

  const newHash = await hashPin(new1);
  localStorage.setItem('sj_admin_pin', newHash);
  hideModal('modal-change-pin');
  showToast('PIN actualizado');
}

/* =====================================================
   KICK OFF
   ===================================================== */
// Add toast keyframe
const styleEl = document.createElement('style');
styleEl.textContent = `
  @keyframes fadeInOut {
    0%   { opacity:0; transform:translate(-50%,10px); }
    15%  { opacity:1; transform:translate(-50%,0); }
    80%  { opacity:1; }
    100% { opacity:0; transform:translate(-50%,-5px); }
  }
`;
document.head.appendChild(styleEl);

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    console.error('Sabor Jarocho init error:', err);
    document.body.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;
                  justify-content:center;height:100vh;font-family:sans-serif;
                  padding:24px;text-align:center;color:#555;">
        <div style="font-size:48px;margin-bottom:16px">⚠️</div>
        <h2 style="color:#c0392b;margin:0 0 8px">Error al iniciar la app</h2>
        <p style="margin:0 0 4px">${err.message || err}</p>
        <p style="font-size:13px;color:#888;margin-top:16px">
          Abre la consola del navegador para más detalles.</p>
      </div>`;
  });
});
