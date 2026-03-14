/**
 * google.js — Google OAuth2, Gmail, and Drive integration
 * Uses Google Identity Services (GSI) loaded lazily from CDN.
 * Token encrypted with AES-GCM using PIN-derived key.
 */

const GOOGLE_CLIENT_ID = '57266911341-j9b17p9tvt4120c9np8v90gaf0vi14rj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'sj_google_token';

let tokenClient = null;
let gsiLoaded = false;

/* =====================================================
   GSI LOADING
   ===================================================== */

function loadGSI() {
  if (gsiLoaded || window.google?.accounts?.oauth2) {
    gsiLoaded = true;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      gsiLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load GSI script'));
    document.head.appendChild(script);
  });
}

/* =====================================================
   CRYPTO HELPERS (AES-GCM, PIN-derived key)
   ===================================================== */

async function getPinKeyMaterial() {
  const pinHash = localStorage.getItem('sj_admin_pin');
  if (!pinHash) throw new Error('No PIN set');
  // Use the hex hash string as raw key material
  const rawKey = new TextEncoder().encode(pinHash.slice(0, 32)); // 32 bytes = 256 bits
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function encryptToken(tokenData) {
  const key = await getPinKeyMaterial();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(tokenData));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return JSON.stringify({
    iv:   bufferToBase64(iv.buffer),
    data: bufferToBase64(ciphertext)
  });
}

async function decryptToken(stored) {
  try {
    const { iv, data } = JSON.parse(stored);
    const key        = await getPinKeyMaterial();
    const decrypted  = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(iv) },
      key,
      base64ToBuffer(data)
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

/* =====================================================
   PUBLIC API
   ===================================================== */

/**
 * Initiate Google OAuth2 flow.
 * Stores encrypted token in localStorage on success.
 */
export async function connectGoogle() {
  await loadGSI();

  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope:     SCOPES,
      callback:  async (tokenResponse) => {
        if (tokenResponse.error) {
          reject(new Error(tokenResponse.error));
          return;
        }
        const tokenData = {
          access_token: tokenResponse.access_token,
          expiry_time:  Date.now() + 3600000
        };
        try {
          const encrypted = await encryptToken(tokenData);
          localStorage.setItem(TOKEN_KEY, encrypted);
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

/**
 * Get a valid access token, or null if not connected/expired.
 */
export async function getToken() {
  const stored = localStorage.getItem(TOKEN_KEY);
  if (!stored) return null;

  const tokenData = await decryptToken(stored);
  if (!tokenData) return null;

  // Check expiry
  if (Date.now() >= tokenData.expiry_time) {
    // Try to refresh silently
    try {
      await loadGSI();
      return await new Promise((resolve) => {
        if (!tokenClient) {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope:     SCOPES,
            callback:  async (tokenResponse) => {
              if (tokenResponse.error) { resolve(null); return; }
              const newData = {
                access_token: tokenResponse.access_token,
                expiry_time:  Date.now() + 3600000
              };
              const encrypted = await encryptToken(newData);
              localStorage.setItem(TOKEN_KEY, encrypted);
              resolve(newData.access_token);
            }
          });
        }
        tokenClient.requestAccessToken({ prompt: '' });
      });
    } catch {
      return null;
    }
  }

  return tokenData.access_token;
}

/**
 * Returns true if a valid (non-expired) token exists.
 */
export async function isConnected() {
  const token = await getToken();
  return !!token;
}

/**
 * Disconnect Google account (remove stored token).
 */
export function disconnectGoogle() {
  localStorage.removeItem(TOKEN_KEY);
}

/* =====================================================
   SEND TICKET VIA GMAIL
   ===================================================== */

/**
 * Build RFC 2822 email as base64url string for Gmail API.
 */
function buildEmailBody(toEmail, orderData, detalles, config) {
  const conf = config || {};
  const businessName = conf.nombre || 'Sabor Jarocho';
  const address      = conf.direccion || 'Av. P. de la Victoria 2118, Partido Senecú, 32459';
  const closingMsg   = conf.cierre || 'Gracias por su visita. ¡Vuelva pronto!';

  const fechaStr = new Date(orderData.hora_orden).toLocaleDateString('es-MX', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const horaStr = new Date(orderData.hora_orden).toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit'
  });

  const formatMXN = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

  const itemRows = detalles.map((d, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8f9fa';
    const porcion = d.porcion === 'media' ? '½ orden' : '1 orden';
    return `
      <tr style="background:${bg}">
        <td style="padding:7px 10px;">${d.articulo}</td>
        <td style="padding:7px 10px;text-align:center;">${porcion}</td>
        <td style="padding:7px 10px;text-align:center;">${d.cantidad}</td>
        <td style="padding:7px 10px;text-align:right;">${formatMXN(d.precio_unitario)}</td>
        <td style="padding:7px 10px;text-align:right;">${formatMXN(d.subtotal_linea)}</td>
      </tr>`;
  }).join('');

  const paymentRows = orderData.metodo_pago === 'efectivo' ? `
    <tr><td style="padding:5px 10px;color:#555;">Recibido</td><td style="padding:5px 10px;text-align:right;">${formatMXN(orderData.efectivo_recibido)}</td></tr>
    <tr><td style="padding:5px 10px;color:#555;">Cambio</td><td style="padding:5px 10px;text-align:right;color:#27500A;font-weight:bold;">${formatMXN(orderData.cambio)}</td></tr>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Arial,sans-serif;font-size:15px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:20px 0;">
<tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <tr><td style="background:#1A5276;padding:24px 24px 18px;text-align:center;">
    <div style="color:#fff;font-size:24px;font-weight:800;">${businessName}</div>
    <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px;">${address}</div>
  </td></tr>
  <tr><td style="padding:20px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;margin-bottom:18px;">
      <tr style="background:#f4f6f8;">
        <td style="padding:8px 12px;font-weight:700;font-size:13px;color:#555;">FOLIO</td>
        <td style="padding:8px 12px;font-size:13px;">${orderData.folio || '—'}</td>
        <td style="padding:8px 12px;font-weight:700;font-size:13px;color:#555;">MESA</td>
        <td style="padding:8px 12px;font-size:13px;">${orderData.nombre_mesa}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;font-weight:700;font-size:13px;color:#555;">FECHA</td>
        <td style="padding:8px 12px;font-size:13px;">${fechaStr}</td>
        <td style="padding:8px 12px;font-weight:700;font-size:13px;color:#555;">HORA</td>
        <td style="padding:8px 12px;font-size:13px;">${horaStr}</td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;margin-bottom:18px;">
      <tr style="background:#1A5276;">
        <th style="padding:9px 10px;color:#fff;text-align:left;font-size:13px;">Artículo</th>
        <th style="padding:9px 10px;color:#fff;text-align:center;font-size:13px;">Porción</th>
        <th style="padding:9px 10px;color:#fff;text-align:center;font-size:13px;">Cant.</th>
        <th style="padding:9px 10px;color:#fff;text-align:right;font-size:13px;">Precio Unit.</th>
        <th style="padding:9px 10px;color:#fff;text-align:right;font-size:13px;">Subtotal</th>
      </tr>
      ${itemRows}
      <tr style="border-top:2px solid #1A5276;">
        <td colspan="4" style="padding:10px;font-weight:800;font-size:16px;color:#1A5276;text-align:right;">TOTAL</td>
        <td style="padding:10px;font-weight:800;font-size:16px;color:#1A5276;text-align:right;">${formatMXN(orderData.subtotal)}</td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:6px;margin-bottom:18px;">
      <tr><td style="padding:8px 12px;font-weight:700;font-size:13px;color:#555;">Método de pago</td>
          <td style="padding:8px 12px;font-size:13px;">${orderData.metodo_pago === 'tarjeta' ? 'Tarjeta' : 'Efectivo'}</td></tr>
      ${paymentRows}
    </table>
  </td></tr>
  <tr><td style="padding:16px 24px;text-align:center;border-top:1px solid #e0e0e0;">
    <em style="color:#888;font-size:13px;">${closingMsg}</em>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return html;
}

function makeBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Send ticket email via Gmail API.
 */
export async function sendTicket(toEmail, orderData, detalles, config) {
  try {
    const token = await getToken();
    if (!token) return { success: false, error: 'No autenticado con Google' };

    const htmlBody    = buildEmailBody(toEmail, orderData, detalles, config);
    const subject     = `Ticket Sabor Jarocho — Folio ${orderData.folio || '?'} — ${orderData.nombre_mesa}`;
    const emailString = [
      `To: ${toEmail}`,
      `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody
    ].join('\r\n');

    const raw = makeBase64Url(emailString);

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ raw })
    });

    if (!response.ok) {
      const err = await response.text();
      return { success: false, error: err };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* =====================================================
   DRIVE BACKUP
   ===================================================== */

const BACKUP_FILENAME = 'SaborJarocho_Ventas_Historial.csv';

/**
 * Append CSV content to Drive backup file (creates if missing).
 */
export async function backupToDrive(csvContent) {
  try {
    const token = await getToken();
    if (!token) return { success: false, error: 'No autenticado con Google' };

    // Search for existing file
    const searchRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILENAME}'&spaces=drive&fields=files(id,name)`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const files = searchData.files || [];

    if (files.length > 0) {
      // File exists — get current content then append
      const fileId = files[0].id;
      const contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const existing = await contentRes.text();
      const combined  = existing ? existing + '\n' + csvContent : csvContent;

      const boundary = 'backup_boundary_sj';
      const multipart = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: BACKUP_FILENAME }),
        `--${boundary}`,
        'Content-Type: text/csv; charset=UTF-8',
        '',
        combined,
        `--${boundary}--`
      ].join('\r\n');

      const patchRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
        {
          method:  'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  `multipart/related; boundary=${boundary}`
          },
          body: multipart
        }
      );
      if (!patchRes.ok) {
        const err = await patchRes.text();
        return { success: false, error: err };
      }
      return { success: true, fileId };
    } else {
      // Create new file
      const boundary = 'backup_boundary_sj';
      const multipart = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: BACKUP_FILENAME, mimeType: 'text/csv' }),
        `--${boundary}`,
        'Content-Type: text/csv; charset=UTF-8',
        '',
        csvContent,
        `--${boundary}--`
      ].join('\r\n');

      const createRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  `multipart/related; boundary=${boundary}`
          },
          body: multipart
        }
      );
      if (!createRes.ok) {
        const err = await createRes.text();
        return { success: false, error: err };
      }
      const created = await createRes.json();
      return { success: true, fileId: created.id };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Build CSV content from today's orders.
 */
export function buildBackupCSV(orders, detallesMap) {
  const header = 'Folio,Mesa,Fecha,Hora,Estado,Método Pago,Subtotal,Efectivo Recibido,Cambio,Artículo,Porción,Cantidad,Precio Unit,Subtotal Línea\n';
  const rows = [];
  for (const order of orders) {
    const detalles = detallesMap[order.id_orden] || [];
    if (detalles.length === 0) {
      rows.push([
        order.folio || '', order.nombre_mesa, order.fecha,
        order.hora_orden, order.estado, order.metodo_pago || '',
        order.subtotal || 0, order.efectivo_recibido || '',
        order.cambio || '', '', '', '', '', ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    } else {
      detalles.forEach(d => {
        rows.push([
          order.folio || '', order.nombre_mesa, order.fecha,
          order.hora_orden, order.estado, order.metodo_pago || '',
          order.subtotal || 0, order.efectivo_recibido || '',
          order.cambio || '', d.articulo, d.porcion, d.cantidad,
          d.precio_unitario, d.subtotal_linea
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      });
    }
  }
  return header + rows.join('\n');
}
