# Shopify Marketplace — Opsætningsguide

En app der lader dine kunder sætte brugt babytøj til salg direkte igennem deres Shopify-konto.

---

## Hvad du skal bruge

- En **Shopify Partner konto** (gratis på partners.shopify.com)
- En server — anbefalet: **Railway** (railway.app) — gratis at starte, ~$5/md ved brug
- Din eksisterende Shopify butik

---

## Trin 1 — Opret en Shopify app

1. Gå til [partners.shopify.com](https://partners.shopify.com) og log ind
2. Klik **Apps → Create app → Create app manually**
3. Giv den et navn: fx "Marketplace"
4. Under **App setup**, noter din **API key** og **API secret key**
5. Klik **Extensions → App proxy** og tilføj:
   - **Subpath prefix:** `apps`
   - **Subpath:** `marketplace`
   - **Proxy URL:** `https://DIN-SERVER-URL` (udfyldes i trin 3)
6. Installer appen i din butik via **Test on development store**

---

## Trin 2 — Opret Admin API access token

1. I din Shopify Admin: gå til **Settings → Apps and sales channels → Develop apps**
2. Klik **Create an app** → navngiv den "Marketplace Backend"
3. Under **Configuration**, giv den disse rettigheder:
   - `write_products` — oprette og publicere produkter
   - `read_products`
   - `write_inventory`
   - `read_customers`
4. Klik **Install app** og kopiér **Admin API access token** (vises kun én gang!)

---

## Trin 3 — Deploy til Railway

1. Gå til [railway.app](https://railway.app) og log ind med GitHub
2. Klik **New Project → Deploy from GitHub repo**
3. Upload eller push dette projekt til et GitHub-repo og vælg det
4. Under **Variables**, tilføj disse miljøvariabler:

```
SHOPIFY_STORE_DOMAIN    =  din-butik.myshopify.com
SHOPIFY_ADMIN_TOKEN     =  shpat_... (fra trin 2)
SHOPIFY_API_SECRET      =  ... (fra trin 1, API secret key)
ADMIN_PASSWORD          =  vælg-en-sikker-adgangskode
PORT                    =  3000
```

5. Deploy projektet — Railway giver dig en URL, fx `https://shopify-marketplace-xxxx.railway.app`
6. Gå tilbage til din Shopify Partner app og opdatér **Proxy URL** med denne URL

---

## Trin 4 — Test det

1. Gå til din butik som logget-ind kunde:
   `https://din-butik.myshopify.com/apps/marketplace`
2. Du skulle nu se formularen til at sætte ting til salg
3. Administrationspanelet finder du på:
   `https://DIN-SERVER-URL/admin/marketplace`
   Log ind med den adgangskode du valgte i miljøvariablerne

---

## Sådan fungerer det

```
Kunde besøger /apps/marketplace
        ↓
Shopify verificerer kunden er logget ind
og sender customer_id til din server
        ↓
Kunden udfylder formular og uploader billeder
        ↓
Din server opretter et DRAFT produkt i Shopify
med sælgerens customer_id som metafelt
        ↓
Du godkender i admin-panelet
        ↓
Produktet publiceres og tilføjes til
"Brugt & Genbrugt" collection automatisk
        ↓
Køb og betaling kører som normalt igennem din butik
```

---

## Tilføj link i kundens navigation

Gå til **Shopify Admin → Online Store → Navigation** og tilføj:
- Navn: `Sæt til salg`
- URL: `/apps/marketplace`

---

## Projektstruktur

```
shopify-marketplace/
├── server.js          # Backend — Express server med Shopify API
├── package.json
├── .env.example       # Kopiér til .env og udfyld
└── public/
    ├── marketplace.html   # Kunde-UI (serveret via App Proxy)
    └── admin.html         # Admin-panel til godkendelse
```

---

## Spørgsmål?

Kontakt din udvikler eller åbn en sag på GitHub.
