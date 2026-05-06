# NIT-IN — Node Identity Token · Integrated Network

> Hardware-attested sovereign identity protocol for embedded devices.
> Patent pending — USPTO Application 19/668,817 · Filed May 6, 2026

---

## What It Is

NIT-IN is a local mesh network where every device—Arduino sensor nodes and human participants alike—mints a cryptographically unique **Node Identity Token (NIT)**. Nodes discover each other, score resonance (similarity of sensor fingerprints + behavior), and build a living social graph without a central authority.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Hub server | Node.js · Express 4 · WebSocket (ws) |
| Persistence | SQLite (better-sqlite3) · WAL mode |
| Federation | UDP LAN peer discovery + WS bridging |
| Firmware | Arduino C++ · EEPROM-persisted identity |
| Frontend | Vanilla HTML/CSS/JS · D3 v7 force graph |

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | D3 force graph dashboard — live node map |
| `/social` | Living Feed — real-time sensor events + signals |
| `/onboard` | 5-phase Genesis ceremony — mint your NIT |
| `/profile/:nit_id` | Node biography — edit, export credential |
| `/admin` | Hub operator panel — stats, clear feed, peers |

---

## API

```
GET  /health                     — ok + mode
GET  /api/nodes                  — all nodes
GET  /api/nodes/:id              — node + edges + posts
GET  /api/nodes/:id/export       — signed NIT credential JSON
PATCH /api/nodes/:id             — edit bio/name/location/website
GET  /api/feed                   — activity feed (limit param)
GET  /api/graph                  — D3 nodes + edges
GET  /api/stats                  — network density + counts
GET  /api/network                — local stats + federation peers
GET  /api/peers                  — connected peer hubs
POST /api/mint                   — create human NIT
POST /api/signal                 — post HUMAN_SIGNAL
POST /api/ingest                 — raw Arduino telemetry
POST /api/admin/clear-feed       — wipe feed (admin)
```

---

## Run Locally

```bash
npm install

# Simulate 20 virtual Arduino nodes
npm run sim

# Hardware mode (Arduino Uno on USB serial)
npm start

# Inject a virtual Arduino node
npm run virtual
```

Dashboard: [http://localhost:3001](http://localhost:3001)

---

## Founder Node

```
NIT-USR-0001 · imacKris · hw_sig 338061C968FA0250
firmware: BIRTH_RIGHTS_v1.0 · sovereign: true
genesis: 2026-05-05
```

---

## Patent

USPTO Nonprovisional · Application 19/668,817 · 35 USC 111(a)  
Confirmation 2090 · Patent Center 75905877 · Filed May 6, 2026

---

*Private repository — imKrisK*
