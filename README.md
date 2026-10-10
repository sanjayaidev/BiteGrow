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

## Platform admin (all restaurants)

Set `PLATFORM_ADMIN_KEY` in the environment (at least 12 characters; leave it empty to switch the page off) and open `/platform` on any hostname of your deployment. Sign in with that key to:

- see every restaurant, search them, and open each one's site or admin page
- add a restaurant (web name, name, logo, timezone, currency, languages) with an optional first domain and owner account
- edit a restaurant's name, tab title, **logo**, timezone, currency, order prefix and languages
- suspend or re-activate a restaurant (its site shows "currently unavailable"; nothing is deleted)
- add or remove its domains, and make someone its owner (creating the account with a temporary password if needed)

There is no delete button on purpose: deleting a restaurant would also delete its menu and orders. Suspend it instead.

The key is checked in constant time and wrong guesses are rate limited (10 per 15 minutes per address). It is kept in the browser tab's session storage only, so closing the tab signs you out. Serve the site over HTTPS, and change the key by changing the environment variable and restarting.

Restaurant owners can still set their own **logo** in their admin under Settings → Restaurant details (an `https://` link, or a file shipped in `public/`, such as `img/logo.png`). Leave it empty to show the restaurant's name as text.

## Dine-in tables and QR codes

In the admin panel, open **Tables** to add tables one by one or as a numbered range (for example 1 to 20, or T1 to T12 with the prefix `T`). Each table gets its own QR code: view, download or print it, or use **Print all QR codes** for a sheet. Scanning a code opens the menu already knowing the table.

Once a restaurant has any table here, checkout accepts only those tables. With none, customers type their own table number. Switching a table off or deleting it makes its printed QR code stop working; renaming keeps it working.

## Team

The owner can open **Team** in the admin panel to add people to the restaurant. An **admin** can run the menu, orders, tables and settings; **staff** only see the Orders screen, which suits the kitchen. Enter the person's email: if they already have an account on the site it is attached to the restaurant, otherwise enter a temporary password to create one (they can change it later with "Forgot password"). The owner's role cannot be changed or removed, and nobody can remove themselves.

## Homepage layout

**Homepage** in the admin panel controls how the opening video plays (by itself, by drag or scroll, or both), its speed from 1 to 10, and whether the Top pick (3D) section is shown and which dish it features. Without a choice the best-rated dish that has a 3D model is used.

## Orders desk

New orders show up on the **Orders** screen within 10 seconds and are marked "New". Tick **Play a sound when a new order arrives** to hear a chime; the choice is remembered on that device, and the browser needs one click on the page first before it will play sound.

## Order status

After ordering, customers can tap **Track my order** to see a live step list (Received, Confirmed, Being prepared, Ready, Completed) that refreshes by itself. Guests can return to their last order from the same device through the basket or sign-in screens; signed-in customers can track live orders and reorder past ones (**Order again**) under **My orders**.

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
src/routes/          auth, cart, orders, admin, menu, tables, media, Meta webhook, assistant
src/lib/             order maths, CSV import, assistant, secrets, AI client
src/middleware/      sign-in and role checks
public/              storefront (index.html is a template), admin.html, assets
db/                  SQL to run in Supabase
test/                node:test suites
```

## Deploying

Behind a proxy such as Render or Railway, set `TRUST_PROXY_HOPS=1` (the default), `NODE_ENV=production`, and `BASE_DOMAIN` if you use subdomains. For the Meta webhook, register `https://<your-domain>/webhooks/meta` in your Meta app using the values of `META_APP_SECRET` and `META_VERIFY_TOKEN`.

Keep `APP_SECRET_KEY` fixed once set: it encrypts the saved Meta tokens, and changing it makes them unreadable.
