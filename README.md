# S3 Music Player — Server Edition

A self-hosted music player that streams audio from an S3-compatible bucket. Credentials stay server-side — the browser never touches S3 directly.

> **⚠️ For non-commercial use only**
> All included songs are either in the public domain or licensed under Creative Commons: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

![Demonstration](https://github.com/darkost12/s3-player-server/blob/main/demonstration.png)

---

## How it works

The Node.js/Express server authenticates users with a password, proxies S3 audio with range request support (so seeking works without buffering the whole file), and serves lyrics from YAML metadata files.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/darkost12/player-server
cd player-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. The required fields are:

- `SESSION_SECRET` — a long random string for signing session cookies
- `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION` — your S3-compatible bucket details
- `S3_SUBPATH`, `S3_METADATA` — directories for audio files and metadata files in the bucket
- `S3_ACCESS_KEY`, `S3_SECRET_KEY` — leave empty for a public bucket

### 3. Add users

```bash
node add-user.js <name> <password>
```

This hashes the password with bcrypt and stores it in `users.json`. Do this before starting the server.

### 4. Run

**Directly with Node:**
```bash
npm start
```

**With Docker:**
```bash
docker build -t player-server .
docker run -d \
  --name player \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -v $(pwd)/users.json:/app/users.json \
  player-server:latest
```

Note the `-v` flag — `users.json` is not baked into the image, so it must be mounted at runtime.

The server listens on port `3000` by default (configurable via `PORT` in `.env`).

---

## nginx reverse proxy (optional)

See `nginx.conf.example` for a full config. The notable options it demonstrates:

- **Non-standard port** — useful if you want the player on a port other than 443 without conflicting with other services on the same server.
- **Secret URL prefix** — exposes the player only at `/<HASH>/` (e.g. `/a851fc/`) so it isn't reachable at the root. This is optional — remove those `location` blocks if you just want the player at `/`.

---

## Song metadata and lyrics

Place a YAML file next to each song in your S3 metadata prefix. See `metadata.example.yml` for the format. The `lyrics` field supports multi-line text.

---

## S3 key encoding

S3 doesn't support some special characters in object keys. The player escapes them in the format `__{urlEncodedHex}__`. For example, `/` becomes `__2F__` and `:` becomes `__3A__`.
