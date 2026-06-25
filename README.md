# 🔍 Agent Venturi: Phoenix Controls Expert v2.0

Phoenix Controls HVAC AI field toolkit with user authentication and cloud chat history.

---

## What's New in v2.0

- **Login system** — Users sign up / sign in with email or Google (powered by Clerk)
- **Cloud chat history** — Chats save to a real database and follow users across any device
- **Per-user data** — Alarm logs and equipment registry are private to each user
- **Secure API** — Every request is authenticated; no unauthenticated access to the AI

---

## Setup Guide — Step by Step

### Step 1 — Create a Clerk account (free)

1. Go to **https://clerk.com** and click "Start building for free"
2. Sign up and create a new application
3. Name it "Agent Venturi Phoenix Controls Expert"
4. Under "How will your users sign in?" — select **Email** and optionally **Google**
5. Click **Create application**
6. Go to **API Keys** in the left sidebar
7. Copy two keys:
   - **Publishable key** — starts with `pk_test_...` (safe for frontend)
   - **Secret key** — starts with `sk_test_...` (server only, keep private)

### Step 2 — Create a Supabase account (free)

1. Go to **https://supabase.com** and click "Start your project"
2. Sign up and click **New project**
3. Name it `agent-venturi`, choose a region close to you, set a database password
4. Wait ~2 minutes for the project to provision
5. Go to **Settings → API** in the left sidebar
6. Copy two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **service_role key** — under "Project API keys" → `service_role` (keep private)

### Step 3 — Set up the database

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open the file `database/schema.sql` from this project
4. Copy the entire contents and paste into the SQL editor
5. Click **Run** (green button)
6. You should see "Success. No rows returned" — your tables are created

### Step 4 — Configure your environment

In your project root folder, create a file called `.env` (copy from `.env.example`):

```
ANTHROPIC_API_KEY=sk-ant-your-actual-key
CLERK_SECRET_KEY=sk_test_your-clerk-secret-key
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
PORT=3001
NODE_ENV=development
ALLOWED_ORIGIN=http://localhost:3000
REACT_APP_CLERK_PUBLISHABLE_KEY=pk_test_your-clerk-publishable-key
```

> ⚠️ REACT_APP_ variables go in the root .env (not /server/.env).
> Both files should be in .gitignore — never commit them.

### Step 5 — Install dependencies

Open a terminal in your project folder and run:

```bash
# Frontend dependencies
npm install

# Server dependencies
cd server && npm install && cd ..
```

### Step 6 — Run locally

```bash
npm run dev
```

- Frontend → http://localhost:3000
- Server → http://localhost:3001

You should see a login screen. Sign up with your email and you're in.

---

## Deploying to Railway (Production)

### Environment variables to add in Railway dashboard:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `REACT_APP_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys |
| `NODE_ENV` | Set to `production` |
| `ALLOWED_ORIGIN` | Your Railway URL (e.g. `https://agent-venturi.up.railway.app`) |

### Update Clerk for production:

1. In Clerk dashboard → **Domains**
2. Add your Railway URL as an allowed origin
3. Railway will give you a URL after first deploy — add it there

### Build & start command for Railway:

- **Build**: `npm install && cd server && npm install && cd .. && npm run build`
- **Start**: `NODE_ENV=production node server/index.js`

---

## How the Auth Flow Works

```
User visits app
       ↓
Clerk shows login/signup screen (fully built, no code needed)
       ↓
User signs in → Clerk issues a JWT token
       ↓
Frontend attaches token to every API request (Authorization: Bearer ...)
       ↓
Server verifies token with Clerk SDK (ClerkExpressRequireAuth)
       ↓
Clerk confirms token → req.auth.userId is set
       ↓
Server uses userId to read/write only that user's data in Supabase
       ↓
User sees their own chats, alarms, equipment — nobody else's
```

---

## Project Structure

```
agent-venturi/
├── database/
│   └── schema.sql              ← Run this in Supabase SQL editor
├── public/
│   └── index.html
├── src/
│   ├── index.js                ← Wraps app in ClerkProvider
│   ├── api.js                  ← Authenticated API helper functions
│   └── App.js                  ← Full Agent Venturi application
├── server/
│   ├── index.js                ← Express server with Clerk + Supabase
│   └── package.json
├── .env.example                ← Template — copy to .env
├── .env                        ← Your actual config (DO NOT COMMIT)
├── .gitignore
├── package.json
└── README.md
```

---

## Adding Payments Later (Stripe)

When you're ready to charge for access:

1. Create a Stripe account at stripe.com
2. Add `STRIPE_SECRET_KEY` to your server `.env`
3. Add `REACT_APP_STRIPE_PUBLISHABLE_KEY` to your frontend `.env`
4. Add a `subscriptions` table to Supabase
5. Check subscription status in the `/api/chat` route before processing
6. Add a `/api/billing` route for Stripe webhooks

We can build all of this out when you're ready.

---

## Support

Phoenix Controls: (800) 340-0007 | www.phoenixcontrols.com
