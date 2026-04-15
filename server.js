require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_STORE_DOMAIN,
  ADMIN_PASSWORD,
  PORT = 3000
} = process.env;

const SHOPIFY_API_SECRET = SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = '2024-01';
const COLLECTION_TITLE = 'Brugt & Genbrugt';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET
    })
  });

  if (!res.ok) throw new Error(`Token fejl: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 86400) * 1000;
  return cachedToken;
}

async function shopifyAdmin(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function shopifyREST(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: body ? JSON.stringify(body) : null
  });
  return res.json();
}

function verifyProxySignature(query) {
  const { signature, ...rest } = query;
  if (!signature) return false;
  const sorted = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('');
  const hash = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(sorted).digest('hex');
  return hash === signature;
}

let cachedCollectionId = null;

async function getOrCreateCollection() {
  if (cachedCollectionId) return cachedCollectionId;
  const data = await shopifyREST('/custom_collections.json?title=Brugt+%26+Genbrugt');
  if (data.custom_collections?.length > 0) {
    cachedCollectionId = data.custom_collections[0].id;
    return cachedCollectionId;
  }
  const created = await shopifyREST('/custom_collections.json', 'POST', {
    custom_collection: {
      title: COLLECTION_TITLE,
      body_html: '<p>Køb og sælg brugt babytøj og -udstyr direkte fra andre forældre.</p>',
      published: true
    }
  });
  cachedCollectionId = created.custom_collection.id;
  return cachedCollectionId;
}

async function addToCollection(productId, collectionId) {
  await shopifyREST('/collects.json', 'POST', { collect: { product_id: productId, collection_id: collectionId } });
}

async function attachImageToProduct(productId, base64Data, filename) {
  const mimeType = filename.match(/\.(png)$/i) ? 'image/png' : 'image/jpeg';
  await shopifyREST(`/products/${productId}/images.json`, 'POST', {
    image: { attachment: base64Data.replace(/^data:image\/\w+;base64,/, ''), filename, content_type: mimeType }
  });
}

// ─── KUNDE ROUTES ────────────────────────────────────────────────────────────

app.get(['/', '/apps/marketplace', '/apps/marketplace/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'marketplace.html'));
});

app.get(['/api/mine', '/apps/marketplace/api/mine'], async (req, res) => {
  const customerId = req.query.logged_in_customer_id;
  if (!customerId) return res.json({ listings: [] });

  const data = await shopifyAdmin(`
    query GetCustomerListings($query: String!) {
      products(first: 50, query: $query) {
        edges {
          node {
            id title status descriptionHtml createdAt
            images(first: 1) { edges { node { url } } }
            variants(first: 1) { edges { node { price } } }
            metafield(namespace: "marketplace", key: "seller_id") { value }
          }
        }
      }
    }
  `, { query: `tag:seller_${customerId}` });

  const listings = data.data?.products?.edges?.map(({ node }) => ({
    id: node.id, title: node.title, status: node.status,
    description: node.descriptionHtml,
    price: node.variants?.edges[0]?.node?.price,
    image: node.images?.edges[0]?.node?.url,
    createdAt: node.createdAt
  })) || [];

  res.json({ listings });
});

app.post(['/api/list', '/apps/marketplace/api/list'], upload.array('images', 5), async (req, res) => {
  const customerId = req.query.logged_in_customer_id;
  const customerEmail = req.query.customer_email || '';
  if (!customerId) return res.status(401).json({ error: 'Du skal være logget ind' });

  const { title, description, price, condition, category } = req.body;
  if (!title || !price || !description) return res.status(400).json({ error: 'Udfyld alle felter' });

  const conditionLabel = { ny: 'Ny med mærke', god: 'God stand', brugt: 'Let brugt', slidt: 'Slidt' }[condition] || condition;

  try {
    const productData = await shopifyREST('/products.json', 'POST', {
      product: {
        title,
        body_html: `<p>${description}</p><p><strong>Stand:</strong> ${conditionLabel}</p><p><strong>Kategori:</strong> ${category || 'Andet'}</p>`,
        vendor: 'Marketplace', product_type: category || 'Babytøj', status: 'draft',
        tags: [`seller_${customerId}`, `seller_email_${customerEmail}`, 'marketplace', condition, category],
        variants: [{ price: parseFloat(price).toFixed(2), inventory_management: 'shopify', inventory_quantity: 1, fulfillment_service: 'manual' }],
        metafields: [
          { namespace: 'marketplace', key: 'seller_id', value: customerId, type: 'single_line_text_field' },
          { namespace: 'marketplace', key: 'seller_email', value: customerEmail, type: 'single_line_text_field' },
          { namespace: 'marketplace', key: 'condition', value: conditionLabel, type: 'single_line_text_field' },
          { namespace: 'marketplace', key: 'status', value: 'afventer_godkendelse', type: 'single_line_text_field' }
        ]
      }
    });

    const productId = productData.product?.id;
    if (!productId) throw new Error('Produkt ikke oprettet');

    if (req.files?.length) {
      for (const file of req.files) {
        await attachImageToProduct(productId, file.buffer.toString('base64'), file.originalname);
      }
    }

    res.json({ success: true, message: 'Dit opslag er sendt til godkendelse. Vi vender tilbage snarest!' });
  } catch (err) {
    console.error('Opret produkt fejl:', err);
    res.status(500).json({ error: 'Noget gik galt. Prøv igen.' });
  }
});

app.delete(['/api/listing/:id', '/apps/marketplace/api/listing/:id'], async (req, res) => {
  const customerId = req.query.logged_in_customer_id;
  if (!customerId) return res.status(401).json({ error: 'Ikke logget ind' });
  const product = await shopifyREST(`/products/${req.params.id}.json`);
  if (!product.product?.tags?.includes(`seller_${customerId}`)) return res.status(403).json({ error: 'Ikke din annonce' });
  if (product.product?.status === 'active') return res.status(400).json({ error: 'Kan ikke slette et aktivt opslag — kontakt os' });
  await shopifyREST(`/products/${req.params.id}.json`, 'DELETE');
  res.json({ success: true });
});

// ─── ADMIN ROUTES ────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Ikke autoriseret' });
  const [, pass] = auth.split(' ');
  if (Buffer.from(pass, 'base64').toString() !== `:${ADMIN_PASSWORD}`) return res.status(401).json({ error: 'Forkert adgangskode' });
  next();
}

app.get('/admin/marketplace', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/marketplace/api/pending', adminAuth, async (req, res) => {
  const data = await shopifyAdmin(`
    query {
      products(first: 50, query: "tag:marketplace status:draft") {
        edges {
          node {
            id title status descriptionHtml createdAt tags
            images(first: 3) { edges { node { url } } }
            variants(first: 1) { edges { node { price } } }
            sellerEmail: metafield(namespace: "marketplace", key: "seller_email") { value }
            sellerId: metafield(namespace: "marketplace", key: "seller_id") { value }
            condition: metafield(namespace: "marketplace", key: "condition") { value }
          }
        }
      }
    }
  `);

  const listings = data.data?.products?.edges?.map(({ node }) => ({
    gid: node.id, id: node.id.replace('gid://shopify/Product/', ''),
    title: node.title, description: node.descriptionHtml,
    price: node.variants?.edges[0]?.node?.price,
    images: node.images?.edges?.map(e => e.node.url),
    sellerEmail: node.sellerEmail?.value, sellerId: node.sellerId?.value,
    condition: node.condition?.value, createdAt: node.createdAt
  })) || [];

  res.json({ listings });
});

app.post('/admin/marketplace/api/approve/:id', adminAuth, async (req, res) => {
  try {
    await shopifyREST(`/products/${req.params.id}.json`, 'PUT', { product: { id: req.params.id, status: 'active' } });
    const collectionId = await getOrCreateCollection();
    await addToCollection(req.params.id, collectionId);
    res.json({ success: true, message: 'Produkt godkendt og publiceret' });
  } catch (err) {
    res.status(500).json({ error: 'Godkendelse fejlede' });
  }
});

app.delete('/admin/marketplace/api/reject/:id', adminAuth, async (req, res) => {
  try {
    await shopifyREST(`/products/${req.params.id}.json`, 'DELETE');
    res.json({ success: true, message: 'Opslag afvist og slettet' });
  } catch (err) {
    res.status(500).json({ error: 'Afvisning fejlede' });
  }
});

app.listen(PORT, () => console.log(`Marketplace server kører på port ${PORT}`));
