// GET /api/count — devuelve el número real de respuestas en Airtable
// Cachea 60 s para no abusar de la API. El display nunca baja de 324.

const BASE_SEED = 324; // mínimo que se muestra siempre
let _cached  = BASE_SEED;
let _cacheAt = 0;
const TTL    = 60_000; // 60 segundos

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Devuelve caché si es reciente
  if (Date.now() - _cacheAt < TTL) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ count: _cached });
  }

  const token  = process.env.AIRTABLE_API_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    return res.status(200).json({ count: _cached });
  }

  try {
    let total  = 0;
    let offset;

    // Pagina la tabla con el campo mínimo para contar registros
    do {
      const url = new URL(`https://api.airtable.com/v0/${baseId}/Respuestas`);
      url.searchParams.set('fields[]', 'Nombre');
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const atRes = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(9000),
      });

      if (!atRes.ok) break;

      const data = await atRes.json();
      total  += data.records?.length ?? 0;
      offset  = data.offset;
    } while (offset);

    // Nunca muestra menos de BASE_SEED
    _cached  = Math.max(BASE_SEED, total);
    _cacheAt = Date.now();

  } catch (err) {
    console.error('[count] Airtable error:', err.message);
    // Devuelve el último valor conocido; no actualizamos cacheAt para reintentar pronto
  }

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({ count: _cached });
}
