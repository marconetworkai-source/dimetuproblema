// Vercel serverless function — proxies form data to Airtable
// Token never exposed to browser; all validation happens server-side

const RATE_LIMIT = new Map(); // in-memory, resets per cold start (fine for low traffic)

function getRealIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function rateCheck(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  RATE_LIMIT.set(ip, entry);
  return entry.count <= 5; // max 5 submissions per minute per IP
}

function sanitize(str, maxLen = 2000) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export default async function handler(req, res) {
  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — only allow same origin (Vercel deployment)
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  const allowedOrigins = [
    `https://${host}`,
    'http://localhost:3000',
    'http://localhost:5500',
  ];
  if (origin && !allowedOrigins.some(o => origin.startsWith(o.replace(/^https?:\/\//, '')))) {
    // Allow if origin matches host regardless of protocol
    const originHost = origin.replace(/^https?:\/\//, '').split('/')[0];
    if (originHost !== host) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  // Rate limit
  const ip = getRealIp(req);
  if (!rateCheck(ip)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un minuto.' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  const {
    nombre, email, sector, sectorOtro, descripcion, solucion,
    precio, pais, ciudadProvincia, enterado, enteradoRrss, enteradoOtroText,
  } = body || {};

  // ── Validación server-side ──────────────────────────────────
  const errors = [];

  if (!sanitize(nombre)) errors.push('nombre requerido');
  if (!validateEmail(sanitize(email, 200))) errors.push('email inválido');
  if (!sanitize(sector)) errors.push('sector requerido');
  if (sector === 'Otro' && !sanitize(sectorOtro, 500)) errors.push('sector otro requerido');

  const desc = sanitize(descripcion);
  if (desc.length < 50) errors.push('descripción mínimo 50 caracteres');

  if (!sanitize(precio)) errors.push('precio requerido');
  if (!sanitize(pais)) errors.push('país requerido');
  if (!sanitize(ciudadProvincia)) errors.push('ciudad/provincia requerida');
  if (!Array.isArray(enterado) || enterado.length === 0) errors.push('cómo te enteraste requerido');

  if (errors.length) {
    return res.status(422).json({ error: errors.join(', ') });
  }

  // ── Env vars ────────────────────────────────────────────────
  const token   = process.env.AIRTABLE_API_TOKEN;
  const baseId  = process.env.AIRTABLE_BASE_ID;
  const tableId = process.env.AIRTABLE_TABLE_ID;

  if (!token || !baseId || !tableId) {
    console.error('Missing env vars');
    return res.status(500).json({ error: 'Configuración del servidor incompleta' });
  }

  // ── Build Airtable record ────────────────────────────────────
  const fields = {
    'Nombre':                 sanitize(nombre, 200),
    'Email':                  sanitize(email, 200),
    'Sector':                 sanitize(sector, 100),
    'Descripción del problema': desc,
    'Cuánto pagarías':        sanitize(precio, 100),
    'País':                   sanitize(pais, 100),
    'Ciudad / Provincia':     sanitize(ciudadProvincia, 200),
    'Cómo te enteraste':      (Array.isArray(enterado) ? enterado : []).map(s => sanitize(s, 100)),
    'Fecha de envío':         new Date().toISOString(),
  };

  if (sanitize(solucion)) fields['Cómo lo resolverías'] = sanitize(solucion);
  if (sector === 'Otro' && sanitize(sectorOtro)) fields['Sector (otro)'] = sanitize(sectorOtro, 300);
  if (Array.isArray(enteradoRrss) && enteradoRrss.length) {
    fields['Redes sociales'] = enteradoRrss.map(s => sanitize(s, 100));
  }
  if (enterado?.includes('Otro') && sanitize(enteradoOtroText)) {
    fields['Cómo (otro)'] = sanitize(enteradoOtroText, 300);
  }

  // ── POST to Airtable ─────────────────────────────────────────
  try {
    const atRes = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      }
    );

    if (!atRes.ok) {
      const err = await atRes.text();
      console.error('Airtable error:', atRes.status, err);
      return res.status(502).json({ error: 'Error al guardar. Inténtalo de nuevo.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(502).json({ error: 'Error de conexión. Inténtalo de nuevo.' });
  }
}
