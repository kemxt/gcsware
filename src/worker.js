// gcsware.com runs this script before serving the files in public/. It does two things:
// 1. Sends plain-http visitors to https, so Google stops indexing http:// copies of the pages.
// 2. Passes the store API calls through to gcscheats.com. The store API doesn't allow browser
//    requests from gcsware.com (no CORS), so the pages call /api/... here instead.
const STORE = 'https://gcscheats.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol === 'http:' && url.hostname === 'gcsware.com') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/payment') return payment(request);
    if (url.pathname === '/api/recent-orders') return recentOrders(request, url);

    return env.ASSETS.fetch(request);
  }
};

// Checkout: forwards only the product id. The store validates it and returns the Stripe payment_url.
async function payment(request) {
  if (request.method !== 'POST') return json({ success: false, message: 'Method not allowed' }, 405);
  const body = await request.json().catch(() => null);
  const productId = Number(body && body.product_id);
  if (!Number.isInteger(productId)) return json({ success: false, message: 'Invalid product' }, 400);
  return toStore(request, '/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: productId })
  });
}

// Purchase toast: the store's latest orders for one product (it only says how long ago).
async function recentOrders(request, url) {
  if (request.method !== 'GET') return json([], 405);
  const id = url.searchParams.get('product_id') || '';
  if (!/^\d+$/.test(id)) return json([], 400);
  return toStore(request, '/api/recent-orders?product_id=' + id, { headers: {} });
}

async function toStore(request, path, init) {
  // Pass the buyer's IP and browser along, so the store doesn't only see Cloudflare's.
  const headers = new Headers(init.headers);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip);
  const ua = request.headers.get('User-Agent');
  if (ua) headers.set('User-Agent', ua);
  try {
    const res = await fetch(STORE + path, { ...init, headers });
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return json({ success: false, message: 'Store unreachable' }, 502);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
