/**
 * db.js — IndexedDB persistence layer for Sabor Jarocho
 * Database: "saborjarocho_db" v1
 * Stores: ordenes, detalle_orden, menu_articulos
 */

const DB_NAME = 'saborjarocho_db';
const DB_VERSION = 1;

let _db = null;

/**
 * Open (or create) the IndexedDB database.
 * Returns a Promise that resolves to the IDBDatabase instance.
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // ordenes store
      if (!db.objectStoreNames.contains('ordenes')) {
        const ordenesStore = db.createObjectStore('ordenes', {
          keyPath: 'id_orden',
          autoIncrement: true
        });
        ordenesStore.createIndex('fecha',       'fecha',       { unique: false });
        ordenesStore.createIndex('estado',      'estado',      { unique: false });
        ordenesStore.createIndex('nombre_mesa', 'nombre_mesa', { unique: false });
      }

      // detalle_orden store
      if (!db.objectStoreNames.contains('detalle_orden')) {
        const detalleStore = db.createObjectStore('detalle_orden', {
          keyPath: 'id_detalle',
          autoIncrement: true
        });
        detalleStore.createIndex('id_orden', 'id_orden', { unique: false });
      }

      // menu_articulos store
      if (!db.objectStoreNames.contains('menu_articulos')) {
        const menuStore = db.createObjectStore('menu_articulos', {
          keyPath: 'id_articulo',
          autoIncrement: true
        });
        menuStore.createIndex('categoria',     'categoria',     { unique: false });
        menuStore.createIndex('activo',        'activo',        { unique: false });
        menuStore.createIndex('orden_display', 'orden_display', { unique: false });
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      // Seed menu on first launch
      if (!localStorage.getItem('sj_seeded')) {
        seedMenu(_db).then(() => resolve(_db));
      } else {
        resolve(_db);
      }
    };

    req.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/* =====================================================
   MENU SEEDING
   ===================================================== */
const SEED_DATA = [
  { categoria: 'Empanadas',       nombre: 'Queso',             tiene_media: true,  orden_display: 1 },
  { categoria: 'Empanadas',       nombre: 'Pollo',             tiene_media: true,  orden_display: 2 },
  { categoria: 'Empanadas',       nombre: 'Carne molida',      tiene_media: true,  orden_display: 3 },
  { categoria: 'Chiles rellenos', nombre: 'Pollo',             tiene_media: true,  orden_display: 1 },
  { categoria: 'Chiles rellenos', nombre: 'Carne molida',      tiene_media: true,  orden_display: 2 },
  { categoria: 'Tostadas',        nombre: 'Deshebrada',        tiene_media: true,  orden_display: 1 },
  { categoria: 'Tostadas',        nombre: 'Pollo',             tiene_media: true,  orden_display: 2 },
  { categoria: 'Tostadas',        nombre: 'Carne molida',      tiene_media: true,  orden_display: 3 },
  { categoria: 'Garnachas',       nombre: 'Deshebrada',        tiene_media: true,  orden_display: 1 },
  { categoria: 'Picaditas',       nombre: 'Salsa',             tiene_media: true,  orden_display: 1 },
  { categoria: 'Picaditas',       nombre: 'Frijoles',          tiene_media: true,  orden_display: 2 },
  { categoria: 'Picaditas',       nombre: 'Pollo',             tiene_media: true,  orden_display: 3 },
  { categoria: 'Picaditas',       nombre: 'Carne molida',      tiene_media: true,  orden_display: 4 },
  { categoria: 'Picaditas',       nombre: 'Deshebrada',        tiene_media: true,  orden_display: 5 },
  { categoria: 'Platillos',       nombre: 'Plátanos rellenos', tiene_media: false, orden_display: 1 },
  { categoria: 'Platillos',       nombre: 'Plátanos fritos',   tiene_media: false, orden_display: 2 },
  { categoria: 'Platillos',       nombre: 'Papas preparadas',  tiene_media: false, orden_display: 3 },
  { categoria: 'Platillos',       nombre: 'Tacos dorados',     tiene_media: false, orden_display: 4 },
  { categoria: 'Platillos',       nombre: 'Huevos preparados', tiene_media: false, orden_display: 5 },
  { categoria: 'Bebidas',         nombre: 'Refresco',          tiene_media: false, orden_display: 1 },
  { categoria: 'Bebidas',         nombre: 'Agua fresca',       tiene_media: false, orden_display: 2 },
  { categoria: 'Bebidas',         nombre: 'Agua natural',      tiene_media: false, orden_display: 3 },
];

async function seedMenu(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('menu_articulos', 'readwrite');
    const store = tx.objectStore('menu_articulos');
    const now = new Date().toISOString();

    SEED_DATA.forEach(item => {
      store.add({
        categoria:          item.categoria,
        nombre:             item.nombre,
        precio_completo:    0,
        precio_media:       item.tiene_media ? 0 : null,
        tiene_media:        item.tiene_media,
        activo:             true,
        orden_display:      item.orden_display,
        fecha_modificacion: now
      });
    });

    tx.oncomplete = () => {
      localStorage.setItem('sj_seeded', 'true');
      resolve();
    };
    tx.onerror = (e) => reject(e.target.error);
  });
}

/* =====================================================
   HELPERS
   ===================================================== */
function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror  = (e) => reject(e.target.error);
  });
}

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

/**
 * Save a new order. Returns Promise<id_orden>
 */
export async function saveOrder(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readwrite');
    const store = tx.objectStore('ordenes');
    const req   = store.add({
      nombre_mesa:            data.nombre_mesa,
      fecha:                  data.fecha       || todayStr(),
      hora_orden:             data.hora_orden  || new Date().toISOString(),
      hora_enviada_cocina:    data.hora_enviada_cocina    || null,
      hora_completada:        data.hora_completada        || null,
      tiempo_preparacion_min: data.tiempo_preparacion_min || null,
      metodo_pago:            data.metodo_pago            || null,
      subtotal:               data.subtotal               || 0,
      efectivo_recibido:      data.efectivo_recibido      || null,
      cambio:                 data.cambio                 || null,
      ticket_enviado:         data.ticket_enviado         || false,
      ticket_email:           data.ticket_email           || null,
      folio:                  data.folio                  || null,
      estado:                 data.estado                 || 'pendiente'
    });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Update specific fields on an existing order.
 */
export async function updateOrder(id_orden, changes) {
  const db    = await openDB();
  const order = await getOrder(id_orden);
  if (!order) throw new Error(`Order ${id_orden} not found`);

  return new Promise((resolve, reject) => {
    const tx    = db.transaction('ordenes', 'readwrite');
    const store = tx.objectStore('ordenes');
    const updated = Object.assign({}, order, changes, { id_orden });
    const req = store.put(updated);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Get a single order by id. Returns Promise<order|undefined>
 */
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

/**
 * Get all open orders (not cobrada or cancelada).
 */
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

/**
 * Get all orders for a specific date (YYYY-MM-DD).
 */
export async function getOrdersByDate(date) {
  const db = await openDB();
  return getAllFromIndex(db, 'ordenes', 'fecha', date);
}

/* =====================================================
   DETALLE_ORDEN CRUD
   ===================================================== */

/**
 * Save a new order detail line. Returns Promise<id_detalle>
 */
export async function saveDetalle(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('detalle_orden', 'readwrite');
    const store = tx.objectStore('detalle_orden');
    const req   = store.add({
      id_orden:       data.id_orden,
      categoria:      data.categoria,
      articulo:       data.articulo,
      porcion:        data.porcion        || 'completa',
      cantidad:       data.cantidad       || 1,
      precio_unitario: data.precio_unitario || 0,
      subtotal_linea: data.subtotal_linea  || 0
    });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Get all detail lines for an order.
 */
export async function getDetallesByOrder(id_orden) {
  const db = await openDB();
  return getAllFromIndex(db, 'detalle_orden', 'id_orden', id_orden);
}

/**
 * Delete all detail lines for an order (used when re-sending to kitchen).
 */
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

/**
 * Get all menu items, optionally filtered.
 * opts: { activo: bool, categoria: string }
 */
export async function getMenuItems(opts = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readonly');
    const store = tx.objectStore('menu_articulos');
    const req   = store.getAll();
    req.onsuccess = (e) => {
      let items = e.target.result || [];
      if (opts.activo !== undefined) {
        items = items.filter(i => i.activo === opts.activo);
      }
      if (opts.categoria) {
        items = items.filter(i => i.categoria === opts.categoria);
      }
      // Sort by categoria then orden_display
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

/**
 * Save a new menu item. Returns Promise<id_articulo>
 */
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

/**
 * Update specific fields on a menu item.
 */
export async function updateMenuItem(id_articulo, changes) {
  const db   = await openDB();
  const item = await getMenuItemById(id_articulo);
  if (!item) throw new Error(`MenuItem ${id_articulo} not found`);

  return new Promise((resolve, reject) => {
    const tx    = db.transaction('menu_articulos', 'readwrite');
    const store = tx.objectStore('menu_articulos');
    const updated = Object.assign({}, item, changes, {
      id_articulo,
      fecha_modificacion: new Date().toISOString()
    });
    const req = store.put(updated);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Delete a menu item by id.
 */
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

/**
 * Get a single menu item by id.
 */
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

/**
 * Snapshot all in-progress orders to localStorage.
 * Called after every order state change.
 */
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

/**
 * On app load: check sj_orders_inprogress, verify against IndexedDB,
 * re-insert any missing ones. Returns count of recovered orders.
 */
export async function recoverOrders() {
  const raw = localStorage.getItem('sj_orders_inprogress');
  if (!raw) return 0;

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
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
        // Re-insert the order (without id so autoIncrement works)
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

/**
 * Generate folio for today. Format: YYYYMMDD-NNN
 */
export function generateFolio() {
  const date = todayStr();
  const key  = `sj_folio_${date}`;
  const n    = (parseInt(localStorage.getItem(key) || '0', 10)) + 1;
  localStorage.setItem(key, String(n));
  return `${date.replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
}
