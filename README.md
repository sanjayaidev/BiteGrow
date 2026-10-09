# BiteGrow

Multi-tenant restaurant site. One deployment serves many restaurants: each request is matched to a restaurant by its hostname, and the storefront is rendered on the server from that restaurant's rows in Supabase.

Features: scroll-scrubbed video hero, menu with optional 3D/AR dishes, customer accounts and saved baskets, dine-in (table QR) / pickup / delivery ordering, a staff order desk, an admin panel (menu, CSV import, videos, settings), WhatsApp order hand-off, and an AI assistant on the website and on WhatsApp / Instagram / Messenger.

## Requirements

- Node.js 18 or newer
- A Supabase project
- `ffmpeg` is bundled in the repo root (Linux build) and is only used for admin video uploads

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create the database. In Supabase, open **SQL Editor** and run these files in order (each is safe to re-run):

   1. `db/base.sql` — core schema
   2. `db/002_admin_meta_ai.sql` — admin, Meta and assistant tables
   3. `db/003_ai_alibaba.sql`
   4. `db/004_reload_schema.sql` — refreshes the Supabase API schema cache
   5. `db/insert.sql` — optional demo restaurant "Red House" with 10 dishes
   6. `db/homepage.sql` — optional homepage settings and 3D models for the demo restaurant

3. In Supabase **Storage**, create a public bucket named `videos` with a 5 MB file limit (needed for admin video uploads).

4. Copy the environment file and fill it in:

   ```
   cp .env.example .env
   ```

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required. Everything else is explained in `.env.example`. The service_role key is server-only; never expose it to the browser.

5. Start the server:

   ```
   npm start        # production
   npm run dev      # restarts on file changes
   ```

   Open http://localhost:3000. The admin panel is at `/admin`.

## Choosing the restaurant

The restaurant is found from the hostname:

- With `BASE_DOMAIN` set, `<slug>.<BASE_DOMAIN>` opens that restaurant (e.g. `redhouse.bitegrow.app`). Custom domains can be listed in `bg_tenant_domains`.
- Otherwise `DEFAULT_TENANT` is used. Outside production you can also add `?tenant=<slug>` to any URL to try another restaurant.

## Tests

```
npm test
```

The tests run against an in-memory fake of the database, so they need no Supabase connection.

## Project layout

```
server.js            app setup and route mounting
src/tenant.js        hostname -> restaurant lookup
src/render.js        server-side storefront rendering
src/routes/          auth, cart, orders, admin, menu, media, Meta webhook, assistant
src/lib/             order maths, CSV import, assistant, secrets, AI client
src/middleware/      sign-in and role checks
public/              storefront (index.html is a template), admin.html, assets
db/                  SQL to run in Supabase
test/                node:test suites
```

## Deploying

Behind a proxy such as Render or Railway, set `TRUST_PROXY_HOPS=1` (the default), `NODE_ENV=production`, and `BASE_DOMAIN` if you use subdomains. For the Meta webhook, register `https://<your-domain>/webhooks/meta` in your Meta app using the values of `META_APP_SECRET` and `META_VERIFY_TOKEN`.

Keep `APP_SECRET_KEY` fixed once set: it encrypts the saved Meta tokens, and changing it makes them unreadable.
