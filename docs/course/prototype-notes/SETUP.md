# GlobalClass — Complete Setup & Run Guide

> **From a fresh machine to a running livestream in under 20 minutes.**  
> Follow every step in order. Do not skip any step.

---

## Table of Contents
1. [Prerequisites Overview](#1-prerequisites-overview)
2. [Install Docker Desktop (Windows)](#2-install-docker-desktop-windows)
3. [Install Node.js](#3-install-nodejs)
4. [Get LiveKit Cloud API Keys](#4-get-livekit-cloud-api-keys)
5. [Configure Environment Files](#5-configure-environment-files)
6. [Start the Backend Services](#6-start-the-backend-services)
7. [Run the Database Migration](#7-run-the-database-migration)
8. [Start the Frontend](#8-start-the-frontend)
9. [Full Smoke Test](#9-full-smoke-test)
10. [Verify Microservices (Fault Isolation Demo)](#10-verify-microservices-fault-isolation-demo)
11. [Stopping and Restarting](#11-stopping-and-restarting)
    - [Applying Local Code Changes (Rebuilding)](#applying-local-code-changes-rebuilding)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites Overview

You need **3 things** installed on your machine:

| Tool | Minimum Version | What It's Used For |
|------|----------------|-------------------|
| Docker Desktop | 4.x | Runs PostgreSQL, Redis, backend services, Nginx |
| Node.js | 18.x LTS | Runs the React frontend (`npm start`) |
| A web browser | Chrome/Firefox/Edge | For the live demo with multiple users |

You also need:
- A **LiveKit Cloud account** (free tier — no credit card needed)
- A **terminal** (Windows PowerShell or Windows Terminal)

---

## 2. Install Docker Desktop (Windows)

### Step 2.1 — Download Docker Desktop

1. Open your browser and go to: **https://www.docker.com/products/docker-desktop/**
2. Click **"Download for Windows"**
3. The file `Docker Desktop Installer.exe` will download (approx. 500 MB)

### Step 2.2 — Install Docker Desktop

1. Double-click `Docker Desktop Installer.exe`
2. When asked, keep the default options:
   - ✅ "Use WSL 2 instead of Hyper-V" (recommended on Windows 10/11)
   - ✅ "Add shortcut to Desktop"
3. Click **"Ok"** — installation takes 2–5 minutes
4. Click **"Close and restart"** to reboot your computer

### Step 2.3 — Start Docker Desktop

1. After reboot, open **Docker Desktop** from your Start menu or Desktop shortcut
2. Wait for the whale icon 🐳 to stop animating in the taskbar (takes ~30 seconds)
3. You will see the Docker Desktop welcome screen

### Step 2.4 — Verify Docker is Working

Open **PowerShell** (search for "PowerShell" in Start menu) and run:

```powershell
docker --version
```

Expected output (version number may differ):
```
Docker version 27.3.1, build ce12230
```

Then run:
```powershell
docker compose version
```

Expected output:
```
Docker Compose version v2.29.7
```

Then run a quick test:
```powershell
docker run hello-world
```

Expected output ends with:
```
Hello from Docker!
This message shows that your installation appears to be working correctly.
```

> If you see `"docker: command not found"` — Docker is not installed correctly. Go back to Step 2.1.  
> If you see `"Cannot connect to the Docker daemon"` — Docker Desktop is not running. Open it from the taskbar.

---

## 3. Install Node.js

### Step 3.1 — Download Node.js

1. Go to: **https://nodejs.org/**
2. Click the **"LTS"** version (currently 20.x or 22.x — both work)
3. Download the **Windows Installer (.msi)**

### Step 3.2 — Install Node.js

1. Open the `.msi` file
2. Click through all defaults — do not change any settings
3. When it asks to install tools for native modules, you can skip it (click "Next")

### Step 3.3 — Verify Node.js

Open a **new** PowerShell window (important — existing windows won't see the new installation) and run:

```powershell
node --version
```
Expected: `v20.x.x` or similar

```powershell
npm --version
```
Expected: `10.x.x` or similar

> If Node.js commands are not found, restart PowerShell and try again.

---

## 4. Get LiveKit Cloud API Keys

LiveKit is the SFU (Selective Forwarding Unit) that powers the live streaming. It's free for a prototype.

### Step 4.1 — Create Account

1. Open your browser and go to: **https://cloud.livekit.io**
2. Click **"Sign Up"** in the top right
3. Sign up with **GitHub** (easiest) or your email
4. Verify your email if prompted

### Step 4.2 — Create a Project

1. After logging in, you will see the LiveKit Cloud dashboard
2. Click **"New Project"** (or the `+` button)
3. Give it a name: `globalclass`
4. Select the **Free tier** (no credit card required)
5. Choose the region closest to you (e.g., `ap-south-1` for India)
6. Click **"Create Project"**

### Step 4.3 — Get Your Credentials

1. You will be taken to your project dashboard
2. On the left sidebar, click **"Settings"** or **"Keys"**
3. You will see a table with your credentials
4. Copy and save all three values somewhere safe (Notepad is fine):

| Field | Example Value |
|-------|--------------|
| **WebSocket URL** | `wss://globalclass-ab1cd234.livekit.cloud` |
| **API Key** | `APIaAbBcCdDeEfFgGhH` |
| **Secret Key** | `veryLongRandomStringThatYouShouldNeverShare` |

> ⚠️ Keep these values ready — you'll paste them into `.env` files in the next step.  
> ⚠️ Never commit the `.env` file to Git.

---

## 5. Configure Environment Files

You need to create **two** `.env` files: one at the root `globalclass/` level and one inside `streaming-engine/`.

### Step 5.1 — Open a Terminal in the Project

```powershell
cd c:\my_workspace\SE\project-3\openLecture\globalclass
```

### Step 5.2 — Create the Root `.env` File

```powershell
Copy-Item .env.example .env
```

Now open `.env` in Notepad (or your code editor):

```powershell
notepad .env
```

The file looks like:
```env
JWT_SECRET=your_jwt_secret_change_in_production
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Fill in the values:**
- `JWT_SECRET` → make up any long random string, e.g. `globalclass_super_secret_2024_jwt`
- `LIVEKIT_URL` → paste your WebSocket URL from Step 4.3 (starts with `wss://`)
- `LIVEKIT_API_KEY` → paste your API Key from Step 4.3
- `LIVEKIT_API_SECRET` → paste your Secret Key from Step 4.3

Save and close the file.

### Step 5.3 — Create the Streaming Engine `.env` File

```powershell
Copy-Item streaming-engine\.env.example streaming-engine\.env
```

Open it:
```powershell
notepad streaming-engine\.env
```

Fill it in the same way:
```env
PORT=4001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=globalclass
DB_USER=postgres
DB_PASSWORD=postgres

# Must be the SAME value as the root .env JWT_SECRET
JWT_SECRET=globalclass_super_secret_2024_jwt

LIVEKIT_URL=wss://globalclass-ab1cd234.livekit.cloud
LIVEKIT_API_KEY=APIaAbBcCdDeEfFgGhH
LIVEKIT_API_SECRET=veryLongRandomStringThatYouShouldNeverShare
```

> ⚠️ **Critical:** `JWT_SECRET` must be **exactly the same** in both `.env` files.  
> This is because the Core API issues JWTs and the Streaming Engine verifies them.  
> If they don't match, `POST /api/stream/start` will return 401 Unauthorized.

### Step 5.4 — Create the Backend `.env` File

```powershell
Copy-Item backend\.env.example backend\.env
```

Open it:
```powershell
notepad backend\.env
```

Fill in only `JWT_SECRET` (same value as above). The DB/Redis settings are already correct for Docker:
```env
PORT=4000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=globalclass
DB_USER=postgres
DB_PASSWORD=postgres
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=globalclass_super_secret_2024_jwt
JWT_EXPIRES_IN=24h
```

### Step 5.5 — Verify All Three `.env` Files Exist

```powershell
ls .env
ls backend\.env
ls streaming-engine\.env
```

All three should appear. If any is missing, redo that step.

---

## 6. Start the Backend Services

This starts **5 containers**: PostgreSQL, Redis, Core API, Streaming Engine, and Nginx.

### Step 6.1 — Make sure Docker Desktop is Running

Check your Windows taskbar — you should see the Docker whale icon 🐳 (not spinning).

### Step 6.2 — Start All Services

In PowerShell, from the `globalclass/` directory:

```powershell
docker compose up --build
```

> The `--build` flag builds the Docker images from the Dockerfiles on first run.  
> This takes **3–5 minutes** the first time (downloading base images and installing npm packages).  
> Subsequent runs take ~30 seconds because Docker caches the images.

### Step 6.3 — Watch the Logs

You will see logs from all containers. Look for these success messages:

```
core-api-1           | [Core API] Running on port 4000
core-api-1           | [Core API] Owns: Auth, Catalog, Scheduling, Q&A WebSocket
streaming-engine-1   | [Streaming Engine] Running on port 4001
streaming-engine-1   | [Streaming Engine] LiveKit URL: wss://globalclass-ab1cd234.livekit.cloud
```

> If you see `[Streaming Engine] LiveKit URL: ⚠️  NOT SET` → your `.env` or `streaming-engine/.env` is missing LiveKit values. Go back to Step 5.

Wait until you see **no more new log lines** scrolling (about 30 seconds after the services start).

### Step 6.4 — Verify All Containers Are Running

**Open a second PowerShell window** (keep the first one with logs) and run:

```powershell
docker compose ps
```

Expected output (all should show `running`):

```
NAME                  SERVICE            STATUS    PORTS
globalclass-api-gateway-1   api-gateway       running   0.0.0.0:80->80/tcp
globalclass-core-api-1      core-api          running   0.0.0.0:4000->4000/tcp
globalclass-postgres-1      postgres          running   0.0.0.0:5432->5432/tcp
globalclass-redis-1         redis             running   0.0.0.0:6379->6379/tcp
globalclass-streaming-engine-1  streaming-engine  running   0.0.0.0:4001->4001/tcp
```

If any container shows `exited` or `restarting`, check the logs with:
```powershell
docker compose logs <service-name>
# e.g.:
docker compose logs core-api
```

### Step 6.5 — Verify the API Gateway

Test that nginx is routing correctly:

```powershell
# Should return: {"status":"ok","service":"core-api"}
curl http://localhost/health/core

# Should return: {"status":"ok","service":"streaming-engine"}
curl http://localhost/health/streaming
```

If `curl` is not available, open your browser and visit:
- http://localhost/health/core
- http://localhost/health/streaming

Both should show JSON responses.

---

## 7. Run the Database Migration

This creates all the database tables (users, lectures, enrollments, questions, votes).  
**Only do this once** — or when you want to reset the database to empty.

In the second PowerShell window (the one that isn't showing Docker logs):

```powershell
cd c:\my_workspace\SE\project-3\openLecture\globalclass\backend
npm run migrate
```

Expected output:
```
Migration complete
```

If you see `Migration failed: error: database "globalclass" does not exist`:
- The PostgreSQL container is not fully started yet. Wait 10 more seconds and try again.

If you see `password authentication failed`:
- Your `backend/.env` has wrong DB credentials. Make sure `DB_USER=postgres` and `DB_PASSWORD=postgres`.

---

## 8. Start the Frontend

The React frontend runs as a dev server with hot-reload.

### Step 8.1 — Install Frontend Dependencies

This only needs to be done once (or after pulling new changes):

```powershell
cd c:\my_workspace\SE\project-3\openLecture\globalclass\frontend
npm install
```

Wait for it to finish. You will see:
```
added 1324 packages, and audited 1325 packages in Xs
```

> Ignore the deprecation warnings — they come from react-scripts dependencies and don't affect functionality.

### Step 8.2 — Start the Frontend Dev Server

```powershell
npm start
```

Expected output:
```
Compiled successfully!

You can now view globalclass-frontend in the browser.

  Local:            http://localhost:3000
  On Your Network:  http://192.168.x.x:3000

Note that the development build is not optimized.
To create a production build, use npm run build.
```

Your browser should automatically open **http://localhost:3000**.  
If it doesn't, open it manually.

### Step 8.3 — Verify the Frontend Loaded

You should see the **Login** page with:
- "Welcome Back" heading
- Email and Password fields
- A "Login" button
- A "Register" link

If you see a blank page or an error:
- Check that the Docker services from Step 6 are still running
- Open browser DevTools (F12) → Console tab and look for error messages

---

## 9. Full Smoke Test

Use **3 separate browser tabs** for this test.

### Tab 1 — Register as Instructor

1. Go to http://localhost:3000/register
2. Fill in:
   - **Full Name**: Dr. Smith
   - **Email**: instructor@test.com
   - **Password**: password123
   - **Institution**: MIT
   - **Role**: Click **🏫 Instructor**
3. Click **Register**
4. You will be redirected to the Login page
5. Log in with `instructor@test.com` / `password123`
6. You will see the **Course Catalog** (empty)

### Tab 2 — Register as Student 1

1. Go to http://localhost:3000/register
2. Fill in:
   - **Full Name**: Alice
   - **Email**: alice@test.com
   - **Password**: password123
   - **Institution**: MIT
   - **Role**: Click **🎓 Student**
3. Click **Register** → Log in
4. You will see the Course Catalog

### Tab 3 — Register as Student 2

1. Go to http://localhost:3000/register
2. Fill in:
   - **Full Name**: Bob
   - **Email**: bob@test.com
   - **Password**: password123
   - **Institution**: MIT
   - **Role**: Click **🎓 Student**
3. Click **Register** → Log in
4. You will see the Course Catalog

---

### Create and Start a Lecture (Tab 1 — Instructor)

1. Click **"+ Create Lecture"**
2. Fill in:
   - **Title**: Introduction to Distributed Systems
   - **Description**: Covering CAP theorem, Paxos, and Raft
   - **Scheduled At**: Select any future date/time
3. Click **"Create Lecture"**
4. The lecture card appears with status: `scheduled`
5. Click **"Go Live"** button → status changes to `live`
6. Click **"Open Room"** → you are now on the Lecture Page

---

### Enroll Students (Tabs 2 and 3)

1. Refresh the Catalog page in Tab 2 (Student Alice)
2. Click **"Enroll"** on the lecture, then click **"Join Live"**
3. Do the same in Tab 3 (Student Bob)
4. All 3 tabs should now be on `/lecture/:id` with the Q&A panel on the right

---

### Test Live Streaming

1. In **Tab 1 (Instructor)**, click **"🎥 Start Streaming"**
2. Browser will ask for camera and microphone permission → click **"Allow"**
3. The button changes to **"LIVE via SFU"** and you can see yourself in the video panel
4. In **Tab 2 (Student Alice)**: video panel shows a spinner → within 5–10 seconds, the instructor's video appears
5. In **Tab 3 (Student Bob)**: same — video appears without disrupting Alice's stream
6. ✅ **This proves the SFU works**: LiveKit routes video to 2 students simultaneously

---

### Test Q&A System

1. In **Tab 2 (Alice)**: type `"When does CAP theorem apply?"` → click **"↑ Ask"**
2. The question appears **instantly** in all 3 tabs (real-time WebSocket push)
3. In **Tab 3 (Bob)**: type `"Can you explain Paxos?"` → click **"↑ Ask"**
4. In **Tab 2 (Alice)**: click the **↑ upvote** button on Bob's question
5. Vote count increases in all tabs instantly
6. In **Tab 1 (Instructor)**: change the **ranking strategy** dropdown to "By Votes"
7. Questions re-order in all tabs instantly
8. In **Tab 1 (Instructor)**: click **"✓ Mark answered"** on a question
9. Question moves from the default tab to the "Answered" tab

---

### Test Durability (PostgreSQL Flush)

1. Refresh any browser tab (hard refresh: Ctrl+Shift+R)
2. Navigate back to the lecture page
3. All questions and votes are **still there** — they were flushed to PostgreSQL by the write-behind buffer

---

### End the Stream

1. In **Tab 1 (Instructor)**: click **"⏹ End Stream"**
2. Tabs 2 and 3 show: "The lecture stream has ended." overlay
3. Q&A panel still works — questions can still be answered after stream ends

---

## 10. Verify Microservices (Fault Isolation Demo)

This is the most important demo for your viva — it proves the services are truly independent.

In PowerShell (from `globalclass/` directory):

```powershell
# Stop ONLY the streaming engine
docker compose stop streaming-engine
```

Now in the browser:
1. **Q&A still works** — submit a question, it appears in all tabs instantly
2. **Streaming fails gracefully** — instructor sees "Failed to start stream" error
3. The rest of the application is unaffected

To restore:
```powershell
docker compose start streaming-engine
```

Streaming works again — **no restart of Q&A or Core API needed**.

> During your viva, say: _"This demonstrates fault isolation — a core property of microservices. A failure in the streaming engine doesn't cascade to the Q&A or authentication systems."_

---

## 11. Stopping and Restarting

### Stop Everything
```powershell
# In the PowerShell window showing Docker logs, press Ctrl+C
# Or in any PowerShell window:
docker compose down
```

### Stop Without Deleting Data
```powershell
docker compose stop
```

### Restart (data is preserved)
```powershell
docker compose up
```

### Full Reset (deletes all database data)
```powershell
docker compose down -v
docker compose up --build
# Then re-run migration:
cd backend && npm run migrate
```

### Applying Local Code Changes (Rebuilding)
If you edit code files locally (e.g. backend routes or proxy settings), the Docker containers **do not** automatically pick up these changes because they are running previously bundled images. You need to repackage (rebuild) the containers.

**To rebuild just one specific microservice (Recommended for speed):**
If you only edited code in the `core-api` (like we did today), you can rebuild just that specific container without taking down the database or streaming engine:
```powershell
docker compose up -d --build core-api
```
*(Replace `core-api` with `streaming-engine` if you edited the streaming codebase).*

**To repackage ALL containers at once (Safest fallback option):**
If you made widespread changes and want everything cleanly rebuilt:
```powershell
docker compose up -d --build
```
> **Note:** The `-d` flag runs them in the background (detached mode) and immediately replaces the old running instances with the new ones. If you want to view logs right after, use `docker compose logs -f`.

---

## 12. Troubleshooting

### "Port 80 is already in use"
Something else is using port 80 (e.g., IIS, another nginx, Skype legacy).

**Fix:**
```powershell
# Find what's using port 80
netstat -ano | findstr :80

# Or change nginx port in docker-compose.yml:
# ports: ["8080:80"]
# Then visit http://localhost:8080 instead
```

---

### "Port 5432 is already in use"
A local PostgreSQL installation is running.

**Fix:**
```powershell
# Stop local PostgreSQL service
Stop-Service postgresql*
# Then retry docker compose up
```

---

### "Migration complete" but login fails ("Invalid email or password")
The `.env` JWT_SECRET values don't match between backend and streaming-engine, OR the DB migration ran on the wrong database.

**Fix:**
1. Confirm both `.env` files have identical `JWT_SECRET`
2. Run `docker compose logs core-api` and look for DB connection errors

---

### Streaming "Failed to start stream. Check LiveKit config."
LiveKit environment variables are missing or wrong.

**Fix:**
```powershell
docker compose logs streaming-engine
```
Look for the line:
```
[Streaming Engine] LiveKit URL: ⚠️  NOT SET
```
If seen → `streaming-engine/.env` is missing. Go back to Step 5.3.

If the URL is shown but still fails → double-check your API Key and Secret from LiveKit Cloud. Try regenerating them at https://cloud.livekit.io.

---

### Student sees "Lecture is not live" or spinner never resolves
The instructor hasn't clicked "Go Live" in the catalog AND "Start Streaming" in the room.

**Fix:**
1. Instructor in Catalog: click **"Go Live"** → status must show `live`
2. Instructor in Lecture Room: click **"🎥 Start Streaming"**
3. Students: the poll will pick up the live status within 4 seconds

---

### "Cannot connect to the Docker daemon" 
Docker Desktop is not running.

**Fix:** Open Docker Desktop from the Start menu. Wait for the whale icon to stop animating.

---

### WebSocket connection fails (Q&A messages not appearing)
Check that nginx is running and routing `/ws/qa` correctly:
```powershell
docker compose ps api-gateway
```
Should show `running`. If not:
```powershell
docker compose restart api-gateway
```

---

### npm install fails with ENOENT or EPERM errors
Run PowerShell **as Administrator**:
1. Right-click PowerShell → "Run as Administrator"
2. Re-run `npm install`

---

## Quick Reference Card

```
─────────────────────────────────────────────────
GLOBALCLASS — QUICK START
─────────────────────────────────────────────────
1. Ensure Docker Desktop is running (whale icon)

2. cd globalclass/
   docker compose up --build        ← all backends

3. cd backend/
   npm run migrate                  ← first time only

4. cd frontend/
   npm install                      ← first time only
   npm start                        ← opens localhost:3000

5. Demo: 3 tabs — 1 instructor + 2 students
   Instructor → Create → Go Live → Open Room → Start Streaming
   Students   → Enroll → Join Live → ask questions → vote

─────────────────────────────────────────────────
FAULT ISOLATION DEMO:
  docker compose stop streaming-engine
  → Q&A still works. Streaming fails gracefully.
  docker compose start streaming-engine
─────────────────────────────────────────────────

PORTS:
  Frontend:         http://localhost:3000
  API Gateway:      http://localhost:80
  Core API:         http://localhost:4000
  Streaming Engine: http://localhost:4001
─────────────────────────────────────────────────
```
