/**
 * db.js — IndexedDB persistence layer for Sabor Jarocho
 * Database: "saborjarocho_db" v2
 * Stores: ordenes, detalle_orden, menu_articulos
 */

const DB_NAME    = 'saborjarocho_db';
const DB_VERSION = 2;

let _db = null;

/* =====================================================
   PIECE-BASED CATEGORIES
   ===================================================== */
export const PIECE_CATEGORIES = ['Empanadas', 'Chiles rellenos', 'Garnachas', 'Picaditas', 'Tostadas'];

export function isPieceCategory(categoria) {
  return PIECE_CATEGORIES.includes(categoria);
}

/**
 * Open (or create) the IndexedDB database.
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db         = event.target.result;
      const tx         = event.target.transaction;
      const oldVersion = event.oldVersion;

      /* ── Version 1: create stores ── */
      if (oldVersion < 1) {
        const ordenesStore = db.createObjectStore('ordenes', {
          keyPath: 'id_orden', autoIncrement: true
        });
        ordenesStore.createIndex('fecha',       'fecha',       { unique: false });
        ordenesStore.createIndex('estado',      'estado',      { unique: false });
        ordenesStore.createIndex('nombre_mesa', 'nombre_mesa', { unique: false });

        const detalleStore = db.createObjectStore('detalle_orden', {
          keyPath: 'id_detalle', autoIncrement: true
        });
        detalleStore.createIndex('id_orden', 'id_orden', { unique: false });

        const menuStore = db.createObjectStore('menu_articulos', {
          keyPath: 'id_articulo', autoIncrement: true
        });
        menuStore.createIndex('categoria',     'categoria',     { unique: false });
        menuStore.createIndex('activo',        'activo',        { unique: false });
        menuStore.createIndex('orden_display', 'orden_display', { unique: false });
      }

      /* ── Version 2: add new fields to existing records via cursors ── */
      if (oldVersion >= 1 && oldVersion < 2) {
        tx.objectStore('detalle_orden').openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const rec = cursor.value;
            if (rec.notas === undefined) { rec.notas = ''; cursor.update(rec); }
            cursor.continue();
          }
        };

        tx.objectStore('ordenes').openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const rec = cursor.value;
            let changed = false;
            if (rec.cliente_email    === undefined) { rec.cliente_email    = null; changed = true; }
            if (rec.cliente_telefono === undefined) { rec.cliente_telefono = null; changed = true; }
            if (rec.descuento_pct    === undefined) { rec.descuento_pct    = 0;    changed = true; }
            if (rec.descuento_monto  === undefined) { rec.descuento_monto  = 0;    changed = true; }
            if (rec.descuento_motivo === undefined) { rec.descuento_motivo = null; changed = true; }
            if (changed) cursor.update(rec);
            cursor.continue();
          }
        };
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      seedMenuIfEmpty(_db).then(() => resolve(_db));
    };

    req.onerror = (event) => reject(event.target.error);
  });
}

/* =====================================================
   MENU SEEDING (count-guarded — never seeds twice)
   ===================================================== */
const SEED_DATA = [
  { categoria: 'Empanadas',       nombre: 'Queso',             tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 1 },
  { categoria: 'Empanadas',       nombre: 'Pollo',             tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 2 },
  { categoria: 'Empanadas',       nombre: 'Carne molida',      tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 3 },
  { categoria: 'Chiles rellenos', nombre: 'Pollo',             tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 1 },
  { categoria: 'Chiles rellenos', nombre: 'Carne molida',      tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 2 },
  { categoria: 'Tostadas',        nombre: 'Deshebrada',        tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 1 },
  { categoria: 'Tostadas',        nombre: 'Pollo',             tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 2 },
  { categoria: 'Tostadas',        nombre: 'Carne molida',      tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 3 },
  { categoria: 'Garnachas',       nombre: 'Deshebrada',        tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 1 },
  { categoria: 'Picaditas',       nombre: 'Salsa',             tiene_media: false, precio_completo: 30,  precio_media: null, orden_display: 1 },
  { categoria: 'Picaditas',       nombre: 'Frijoles',          tiene_media: false, precio_completo: 30,  precio_media: null, orden_display: 2 },
  { categoria: 'Picaditas',       nombre: 'Pollo',             tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 3 },
  { categoria: 'Picaditas',       nombre: 'Carne molida',      tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 4 },
  { categoria: 'Picaditas',       nombre: 'Deshebrada',        tiene_media: false, precio_completo: 40,  precio_media: null, orden_display: 5 },
  { categoria: 'Platillos',       nombre: 'Plátanos rellenos', tiene_media: false, precio_completo: 160, precio_media: null, orden_display: 1 },
  { categoria: 'Platillos',       nombre: 'Plátanos fritos',   tiene_media: false, precio_completo: 160, precio_media: null, orden_display: 2 },
  { categoria: 'Platillos',       nombre: 'Papas preparadas',  tiene_media: false, precio_completo: 60,  precio_media: null, orden_display: 3 },
  { categoria: 'Platillos',       nombre: 'Tacos dorados',     tiene_media: false, precio_completo: 160, precio_media: null, orden_display: 4 },
  { categoria: 'Platillos',       nombre: 'Huevos preparados', tiene_media: false, precio_completo: 100, precio_media: null, orden_display: 5 },
  { categoria: 'Bebidas',         nombre: 'Refresco',          tiene_media: false, precio_completo: 30,  precio_media: null, orden_display: 1 },
  { categoria: 'Bebidas',         nombre: 'Agua fresca',       tiene_media: false, precio_completo: 30,  precio_media: null, orden_display: 2 },
  { categoria: 'Bebidas',         nombre: 'Agua natural',      tiene_media: false, precio_completo: 30,  precio_media: null, orden_display: 3 },
];

function seedMenuIfEmpty(db) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readwrite');
    const store = tx.objectStore('menu_articulos');

    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > 0) {
        localStorage.setItem('sj_seeded', 'true');
        resolve();
        return;
      }
      const now = new Date().toISOString();
      SEED_DATA.forEach(item => {
        store.add({
          categoria:          item.categoria,
          nombre:             item.nombre,
          precio_completo:    item.precio_completo,
          precio_media:       item.precio_media,
          tiene_media:        item.tiene_media,
          activo:             true,
          orden_display:      item.orden_display,
          fecha_modificacion: now,
        });
      });
      tx.oncomplete = () => { localStorage.setItem('sj_seeded', 'true'); resolve(); };
      tx.onerror    = (e) => reject(e.target.error);
    };
    countReq.onerror = (e) => reject(e.target.error);
  });
}

/**
 * One-time price migration v2: fixes items with precio_completo = 0.
 */
export async function migratePricesV2() {
  if (localStorage.getItem('sj_prices_seeded_v2') === 'true') return;

  const items      = await getMenuItems();
  const zeroPriced = items.filter(i => i.precio_completo === 0);
  if (zeroPriced.length === 0) {
    localStorage.setItem('sj_prices_seeded_v2', 'true');
    return;
  }

  for (const item of zeroPriced) {
    if (item.categoria === 'Bebidas') {
      await updateMenuItem(item.id_articulo, { precio_completo: 30, precio_media: null, tiene_media: false });
    } else {
      await updateMenuItem(item.id_articulo, { precio_completo: 160, tiene_media: false, precio_media: null });
    }
  }

  localStorage.setItem('sj_prices_seeded_v2', 'true');
}

/**
 * One-time price migration v3: applies correct per-item prices from spec.
 * Migration key: sj_prices_seeded_v3
 */
export async function migratePricesV3() {
  if (localStorage.getItem('sj_prices_seeded_v3') === 'true') return;

  const PRICE_MAP = {
    'Empanadas|Queso':              { precio_completo: 40,  precio_media: null },
    'Empanadas|Pollo':              { precio_completo: 40,  precio_media: null },
    'Empanadas|Carne molida':       { precio_completo: 40,  precio_media: null },
    'Chiles rellenos|Pollo':        { precio_completo: 40,  precio_media: null },
    'Chiles rellenos|Carne molida': { precio_completo: 40,  precio_media: null },
    'Tostadas|Deshebrada':          { precio_completo: 40,  precio_media: null },
    'Tostadas|Pollo':               { precio_completo: 40,  precio_media: null },
    'Tostadas|Carne molida':        { precio_completo: 40,  precio_media: null },
    'Garnachas|Deshebrada':         { precio_completo: 40,  precio_media: null },
    'Picaditas|Salsa':              { precio_completo: 30,  precio_media: null },
    'Picaditas|Frijoles':           { precio_completo: 30,  precio_media: null },
    'Picaditas|Pollo':              { precio_completo: 40,  precio_media: null },
    'Picaditas|Carne molida':       { precio_completo: 40,  precio_media: null },
    'Picaditas|Deshebrada':         { precio_completo: 40,  precio_media: null },
    'Platillos|Plátanos rellenos':  { precio_completo: 160, precio_media: null },
    'Platillos|Plátanos fritos':    { precio_completo: 160, precio_media: null },
    'Platillos|Papas preparadas':   { precio_completo: 60,  precio_media: null },
    'Platillos|Tacos dorados':      { precio_completo: 160, precio_media: null },
    'Platillos|Huevos preparados':  { precio_completo: 100, precio_media: null },
    'Bebidas|Refresco':             { precio_completo: 30,  precio_media: null },
    'Bebidas|Agua fresca':          { precio_completo: 30,  precio_media: null },
    'Bebidas|Agua natural':         { precio_completo: 30,  precio_media: null },
  };

  const items = await getMenuItems({});
  for (const item of items) {
    const key = `${item.categoria}|${item.nombre}`;
    if (PRICE_MAP[key]) {
      await updateMenuItem(item.id_articulo, PRICE_MAP[key]);
    }
  }
  localStorage.setItem('sj_prices_seeded_v3', 'true');
}

/**
 * One-time deduplication: removes duplicate menu items (same categoria+nombre).
 * Keeps the record with the highest id_articulo (most recently inserted).
 * Protected by localStorage key 'sj_dedup_done'.
 */
export async function dedupMenuItems() {
  const all    = await getMenuItems({});
  const groups = {};
  for (const item of all) {
    const key = `${item.categoria}|${item.nombre.toLowerCase().trim()}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  for (const group of Object.values(groups)) {
    if (group.length <= 1) continue;
    group.sort((a, b) => b.id_articulo - a.id_articulo);
    for (const dup of group.slice(1)) {
      await deleteMenuItem(dup.id_articulo);
    }
  }
}

/* =====================================================
   HELPERS
   ===================================================== */
function getAllFromIndex(db, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const req   = index.getAll(value);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* =====================================================
   ORDENES CRUD
   ===================================================== */
export async function saveOrder(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readwrite');
    const store = tx.objectStore('ordenes');
    const req   = store.add({
      nombre_mesa:            data.nombre_mesa,
      fecha:                  data.fecha                  || todayStr(),
      hora_orden:             data.hora_orden              || new Date().toISOString(),
      hora_enviada_cocina:    data.hora_enviada_cocina     || null,
      hora_completada:        data.hora_completada         || null,
      tiempo_preparacion_min: data.tiempo_preparacion_min  || null,
      metodo_pago:            data.metodo_pago             || null,
      subtotal:               data.subtotal                || 0,
      efectivo_recibido:      data.efectivo_recibido       || null,
      cambio:                 data.cambio                  || null,
      ticket_enviado:         data.ticket_enviado          || false,
      ticket_email:           data.ticket_email            || null,
      folio:                  data.folio                   || null,
      estado:                 data.estado                  || 'pendiente',
      cliente_email:          data.cliente_email           || null,
      cliente_telefono:       data.cliente_telefono        || null,
      descuento_pct:          data.descuento_pct           || 0,
      descuento_monto:        data.descuento_monto         || 0,
      descuento_motivo:       data.descuento_motivo        || null,
    });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function updateOrder(id_orden, changes) {
  const db    = await openDB();
  const order = await getOrder(id_orden);
  if (!order) throw new Error(`Order ${id_orden} not found`);

  return new Promise((resolve, reject) => {
    const tx      = db.transaction('ordenes', 'readwrite');
    const store   = tx.objectStore('ordenes');
    const updated = Object.assign({}, order, changes, { id_orden });
    const req     = store.put(updated);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function getOrder(id_orden) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readonly');
    const store = tx.objectStore('ordenes');
    const req   = store.get(id_orden);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function getOpenOrders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readonly');
    const store = tx.objectStore('ordenes');
    const req   = store.getAll();
    req.onsuccess = (e) => {
      const all = e.target.result || [];
      resolve(all.filter(o => o.estado !== 'cobrada' && o.estado !== 'cancelada'));
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getKitchenOrders() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readonly');
    const store = tx.objectStore('ordenes');
    const req   = store.getAll();
    req.onsuccess = (e) => {
      const all = e.target.result || [];
      resolve(all.filter(o => o.estado === 'cobrada' && !o.hora_completada));
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function getOrdersByDate(date) {
  const db = await openDB();
  return getAllFromIndex(db, 'ordenes', 'fecha', date);
}

/**
 * Get all orders with fecha >= from AND fecha <= to (inclusive, YYYY-MM-DD strings).
 */
export async function getOrdersInRange(from, to) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readonly');
    const store = tx.objectStore('ordenes');
    const req   = store.getAll();
    req.onsuccess = (e) => {
      const all = e.target.result || [];
      resolve(all.filter(o => o.fecha >= from && o.fecha <= to));
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/* =====================================================
   DETALLE_ORDEN CRUD
   ===================================================== */
export async function saveDetalle(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('detalle_orden', 'readwrite');
    const store = tx.objectStore('detalle_orden');
    const req   = store.add({
      id_orden:        data.id_orden,
      categoria:       data.categoria       || '',
      articulo:        data.articulo,
      porcion:         data.porcion         || 'completa',
      cantidad:        data.cantidad        || 1,
      precio_unitario: data.precio_unitario || 0,
      subtotal_linea:  data.subtotal_linea  || 0,
      notas:           data.notas           || '',
    });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function getDetallesByOrder(id_orden) {
  const db = await openDB();
  return getAllFromIndex(db, 'detalle_orden', 'id_orden', id_orden);
}

export async function deleteDetallesByOrder(id_orden) {
  const db      = await openDB();
  const details = await getDetallesByOrder(id_orden);
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('detalle_orden', 'readwrite');
    const store = tx.objectStore('detalle_orden');
    details.forEach(d => store.delete(d.id_detalle));
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
}

/* =====================================================
   MENU_ARTICULOS CRUD
   ===================================================== */
export async function getMenuItems(opts = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readonly');
    const store = tx.objectStore('menu_articulos');
    const req   = store.getAll();
    req.onsuccess = (e) => {
      let items = e.target.result || [];
      if (opts.activo !== undefined) items = items.filter(i => i.activo === opts.activo);
      if (opts.categoria)            items = items.filter(i => i.categoria === opts.categoria);
      items.sort((a, b) => {
        if (a.categoria < b.categoria) return -1;
        if (a.categoria > b.categoria) return 1;
        return (a.orden_display || 0) - (b.orden_display || 0);
      });
      resolve(items);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function saveMenuItem(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readwrite');
    const store = tx.objectStore('menu_articulos');
    const req   = store.add({
      categoria:          data.categoria,
      nombre:             data.nombre,
      precio_completo:    data.precio_completo  || 0,
      precio_media:       data.precio_media     ?? null,
      tiene_media:        data.tiene_media      || false,
      activo:             data.activo           !== undefined ? data.activo : true,
      orden_display:      data.orden_display    || 1,
      fecha_modificacion: new Date().toISOString()
    });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function updateMenuItem(id_articulo, changes) {
  const db   = await openDB();
  const item = await getMenuItemById(id_articulo);
  if (!item) throw new Error(`MenuItem ${id_articulo} not found`);

  return new Promise((resolve, reject) => {
    const tx      = db.transaction('menu_articulos', 'readwrite');
    const store   = tx.objectStore('menu_articulos');
    const updated = Object.assign({}, item, changes, {
      id_articulo,
      fecha_modificacion: new Date().toISOString()
    });
    const req = store.put(updated);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function deleteMenuItem(id_articulo) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readwrite');
    const store = tx.objectStore('menu_articulos');
    const req   = store.delete(id_articulo);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function getMenuItemById(id_articulo) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readonly');
    const store = tx.objectStore('menu_articulos');
    const req   = store.get(id_articulo);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* =====================================================
   CRASH RECOVERY
   ===================================================== */
export async function snapshotInProgress() {
  try {
    const open = await getOpenOrders();
    if (open.length === 0) {
      localStorage.removeItem('sj_orders_inprogress');
    } else {
      localStorage.setItem('sj_orders_inprogress', JSON.stringify(open));
    }
  } catch (e) {
    console.warn('snapshotInProgress failed:', e);
  }
}

export async function recoverOrders() {
  const raw = localStorage.getItem('sj_orders_inprogress');
  if (!raw) return 0;

  let snapshot;
  try { snapshot = JSON.parse(raw); } catch {
    localStorage.removeItem('sj_orders_inprogress');
    return 0;
  }

  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    localStorage.removeItem('sj_orders_inprogress');
    return 0;
  }

  let recovered = 0;
  for (const order of snapshot) {
    try {
      const existing = await getOrder(order.id_orden);
      if (!existing) {
        const { id_orden, ...orderData } = order;
        await saveOrder(orderData);
        recovered++;
      }
    } catch (e) {
      console.warn('recoverOrders error:', e);
    }
  }
  return recovered;
}

/* =====================================================
   UTILITY
   ===================================================== */
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function generateFolio() {
  const date = todayStr();
  const key  = `sj_folio_${date}`;
  const n    = (parseInt(localStorage.getItem(key) || '0', 10)) + 1;
  localStorage.setItem(key, String(n));
  return `${date.replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
}
