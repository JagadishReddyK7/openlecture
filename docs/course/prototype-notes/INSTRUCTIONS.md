# GlobalClass — Setup & Installation Instructions

Complete guide to setting up and running the GlobalClass prototype locally.

> **Recommended:** See [SETUP.md](SETUP.md) for the quickest path using Docker for PostgreSQL and Redis — no native installs needed for the database or cache.

---

## Prerequisites — Software to Install

### 1. Node.js (v18 or higher)

**Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```
`
**macOS:**
```bash
brew install node@18
```

**Windows:**
Download and run the installer from https://nodejs.org (choose LTS version)

Verify:
```bash
node --version   # should print v18.x.x
npm --version    # should print 9.x.x or higher
```

---

### 2. PostgreSQL (v15)

**Ubuntu / Debian:**
```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

**macOS:**
```bash
brew install postgresql@15
brew services start postgresql@15
```

**Windows:**
Download installer from https://www.postgresql.org/download/windows/

After installation, create the database and set the password:
```bash
sudo -u postgres psql -c "CREATE DATABASE globalclass;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
```

Verify:
```bash
psql --version   # should print psql (PostgreSQL) 15.x
```

---

### 3. Redis (v7)

**Ubuntu / Debian:**
```bash
sudo apt install -y redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

**macOS:**
```bash
brew install redis
brew services start redis
```

**Windows:**
Redis does not have an official Windows build. Use WSL (Windows Subsystem for Linux) and follow the Ubuntu instructions above, or use the Memurai alternative: https://www.memurai.com

Verify:
```bash
redis-cli ping   # should print PONG
```

---

### 4. Git

**Ubuntu / Debian:**
```bash
sudo apt install -y git
```

**macOS:**
```bash
brew install git
```

**Windows:**
Download from https://git-scm.com/download/win

---

## Project Setup

### Step 1 — Clone the repository

```bash
git clone <your-github-repo-url>
cd globalclass
```

---

### Step 2 — Backend setup

```bash
cd backend
```

Install dependencies:
```bash
npm install
```

Create your environment file:
```bash
cp .env.example .env
```

The default `.env` values work out of the box if you followed the PostgreSQL setup above:
```
PORT=4000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=globalclass
DB_USER=postgres
DB_PASSWORD=postgres
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=your_jwt_secret_here
JWT_EXPIRES_IN=24h
```

> **Important:** Change `JWT_SECRET` to any long random string before running.

Run database migrations:
```bash
npm run migrate
```

Start the backend server:
```bash
npm run dev       # development (auto-restarts on file changes)
# or
npm start         # production
```

The backend runs on **http://localhost:4000**

---

### Step 3 — Frontend setup

Open a new terminal tab:

```bash
cd frontend
```

Install dependencies:
```bash
npm install
```

Start the frontend:
```bash
npm start
```

The frontend runs on **http://localhost:3000**

---

## Running the Application

Once both servers are running, open your browser and go to:

```
http://localhost:3000
```

You will see the login page. Register a new account or use the test credentials below.

---

## Test Credentials (optional — create via register page or curl)

**Create via the Register page** at http://localhost:3000/register

Or create via curl:

```bash
# Create instructor
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Instructor","email":"instructor@test.com","password":"password123","role":"instructor","institution":"MIT"}'

# Create student
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Student","email":"student@test.com","password":"password123","role":"student","institution":"Stanford"}'
```

---

## Alternative Setup — Docker

If you prefer Docker over manual installation, you only need:

**Install Docker:**

**Ubuntu:**
```bash
sudo apt update
sudo apt install -y docker.io docker-compose
sudo systemctl start docker
sudo usermod -aG docker $USER
# Log out and back in after this
```

**macOS / Windows:**
Download Docker Desktop from https://www.docker.com/products/docker-desktop

**Run everything with one command:**
```bash
cd globalclass
docker-compose up --build
```

**Run migrations:**
```bash
docker-compose exec backend npm run migrate
```

Open http://localhost:3000

---

## Project Structure Overview

```
globalclass/
├── backend/                  Node.js + Express backend
│   ├── src/
│   │   ├── config/           Database and Redis connections
│   │   ├── middleware/       JWT authentication
│   │   ├── routes/           REST API endpoints
│   │   ├── services/         Business logic (Q&A, streaming, ranking)
│   │   ├── websocket/        WebSocket handlers (Q&A, WebRTC signaling)
│   │   └── db/migrations/    SQL schema
│   └── package.json
├── frontend/                 React frontend
│   ├── src/
│   │   ├── components/       UI components (Q&A panel, video, navbar)
│   │   ├── hooks/            useWebSocket, useWebRTC
│   │   ├── pages/            Login, Register, CourseCatalog, LecturePage
│   │   └── services/         Axios API client
│   └── package.json
├── docker-compose.yml
├── .gitignore
├── INSTRUCTIONS.md           This file
└── README.md
```

---

## Common Issues

**PostgreSQL connection refused:**
```bash
sudo systemctl status postgresql    # check if running
sudo systemctl start postgresql
```

**Redis connection refused:**
```bash
sudo systemctl status redis-server
sudo systemctl start redis-server
redis-cli ping                      # should return PONG
```

**Port 4000 or 3000 already in use:**
```bash
sudo lsof -i :4000    # find what's using the port
kill -9 <PID>
```

**Migration fails — database does not exist:**
```bash
sudo -u postgres psql -c "CREATE DATABASE globalclass;"
```
