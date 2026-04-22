require('dotenv').config()

const express = require('express')
const session = require('express-session')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3')
const yaml = require('js-yaml')
const { Readable } = require('stream')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// Must match the BASE constant in scripts/player.js

// ── S3 configuration ───────────────────────────────────────────────────────────

const BUCKET = process.env.S3_BUCKET
const ENDPOINT = process.env.S3_ENDPOINT
const SUBPATH = process.env.S3_SUBPATH || 'music/'
const METADATA = process.env.S3_METADATA || 'metadata/'
const REGION = process.env.S3_REGION || 'ru-central1'

const hasCredentials = !!(
  process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
)

// Private bucket: use SDK v3 with signed requests
let s3 = null
if (hasCredentials) {
  s3 = new S3Client({
    endpoint: `https://${ENDPOINT}`,
    region: REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

const SUPPORTED_FORMATS = ['.mp3', '.ogg', '.wav', '.flac']

// ── Public bucket helpers (plain unsigned fetch, no SDK) ──────────────────────

function publicBucketBase() {
  return `https://${BUCKET}.${ENDPOINT}`
}

async function listPublicSongs() {
  const songs = []
  let continuationToken

  do {
    let url = `${publicBucketBase()}?list-type=2&prefix=${encodeURIComponent(SUBPATH)}`
    if (continuationToken)
      url += `&continuation-token=${encodeURIComponent(continuationToken)}`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`S3 list error: ${res.status}`)
    const xml = await res.text()

    for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const filename = key.slice(SUBPATH.length)
      if (
        filename &&
        SUPPORTED_FORMATS.some((f) => filename.toLowerCase().endsWith(f))
      ) {
        songs.push(filename)
      }
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml)
    const tokenMatch = xml.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
    )
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined
  } while (continuationToken)

  return songs
}

async function streamPublicAudio(key, range, res) {
  const url = `${publicBucketBase()}/${SUBPATH}${encodeURIComponent(key)}`
  const headers = range ? { Range: range } : {}
  const s3res = await fetch(url, { headers })

  const ct = s3res.headers.get('content-type')
  const cl = s3res.headers.get('content-length')
  const cr = s3res.headers.get('content-range')
  if (ct) res.set('Content-Type', ct)
  if (cl) res.set('Content-Length', cl)
  if (cr) res.set('Content-Range', cr)
  res.set('Accept-Ranges', 'bytes')
  res.status(range ? 206 : s3res.status)

  Readable.fromWeb(s3res.body).pipe(res)
}

async function fetchPublicLyrics(key) {
  if (!METADATA) return null
  const baseName = key.replace(/\.(mp3|ogg|wav|flac)$/i, '')
  const url = `${publicBucketBase()}/${METADATA}${encodeURIComponent(baseName)}.yml`
  const res = await fetch(url)
  if (!res.ok) return null
  const text = await res.text()
  const parsed = yaml.load(text)
  return parsed?.lyrics ?? null
}

// ── App-level middleware ───────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
      },
    },
  }),
)
app.use(express.json())

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    },
  }),
)

// Static assets — no secrets here
app.use('/styles', express.static(path.join(__dirname, 'styles')))
app.use('/scripts', express.static(path.join(__dirname, 'scripts')))
app.use('/assets', express.static(path.join(__dirname, 'assets')))

// ── API router ──────────────────────────────────────

const router = express.Router()

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
})

/** POST /api/auth  { password } → sets session cookie */
router.post('/auth', authLimiter, (req, res) => {
  const { password } = req.body || {}
  if (password && password === process.env.AUTH_PASSWORD) {
    req.session.authenticated = true
    res.json({ ok: true })
  } else {
    res.status(401).json({ error: 'Wrong password' })
  }
})

/** GET /api/me → 200 if authenticated, 401 otherwise */
router.get('/me', requireAuth, (_req, res) => {
  res.json({ ok: true })
})

/** POST /api/logout */
router.post('/logout', (req, res) => {
  req.session.destroy()
  res.json({ ok: true })
})

/** GET /api/songs → string[] of song keys */
router.get('/songs', requireAuth, async (_req, res) => {
  try {
    const songs = hasCredentials
      ? await listPrivateSongs()
      : await listPublicSongs()
    res.json(songs)
  } catch (err) {
    console.error('Error listing songs:', err)
    res.status(500).json({ error: 'Failed to list songs' })
  }
})

/** GET /api/audio?key=<filename> — streams audio with range support */
router.get('/audio', requireAuth, async (req, res) => {
  const { key } = req.query
  if (!key) return res.status(400).json({ error: 'Missing key parameter' })

  const range = req.headers.range

  try {
    if (!hasCredentials) {
      await streamPublicAudio(key, range, res)
      return
    }

    const params = { Bucket: BUCKET, Key: SUBPATH + key }
    if (range) params.Range = range

    const result = await s3.send(new GetObjectCommand(params))

    if (result.ContentType) res.set('Content-Type', result.ContentType)
    if (result.ContentLength !== undefined)
      res.set('Content-Length', String(result.ContentLength))
    if (result.ContentRange) res.set('Content-Range', result.ContentRange)
    res.set('Accept-Ranges', 'bytes')
    res.status(range ? 206 : 200)

    const body = result.Body
    const nodeStream =
      typeof body.pipe === 'function' ? body : Readable.fromWeb(body)
    nodeStream.on('error', () => {
      if (!res.headersSent) res.status(500).end()
    })
    res.on('close', () => nodeStream.destroy())
    nodeStream.pipe(res)
  } catch (err) {
    console.error('Error streaming audio:', err)
    if (!res.headersSent) res.status(500).end()
  }
})

/** GET /api/lyrics?key=<filename> → { lyrics: string | null } */
router.get('/lyrics', requireAuth, async (req, res) => {
  const { key } = req.query
  if (!key || !METADATA) return res.json({ lyrics: null })

  if (!key || key.includes('..') || key.includes('/'))
    return res.status(400).json({ error: 'Invalid key' })

  try {
    let lyrics = null

    if (!hasCredentials) {
      lyrics = await fetchPublicLyrics(key)
    } else {
      const baseName = key.replace(/\.(mp3|ogg|wav|flac)$/i, '')
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: METADATA + baseName + '.yml',
        }),
      )
      const text = await result.Body.transformToString()
      const parsed = yaml.load(text)
      lyrics = parsed?.lyrics ?? null
    }

    res.json({ lyrics })
  } catch (err) {
    const status = err.$metadata?.httpStatusCode
    if (status === 404 || err.name === 'NoSuchKey') {
      res.json({ lyrics: null })
    } else {
      console.error('Error fetching lyrics:', err)
      res.json({ lyrics: null })
    }
  }
})

app.use('/api', router)

// ── Private bucket helpers ────────────────────────────────────────────────────

async function listPrivateSongs() {
  const songs = []
  let continuationToken

  do {
    const data = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: SUBPATH,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of data.Contents || []) {
      const key = obj.Key.slice(SUBPATH.length)
      if (key && SUPPORTED_FORMATS.some((f) => key.toLowerCase().endsWith(f))) {
        songs.push(key)
      }
    }

    continuationToken = data.IsTruncated
      ? data.NextContinuationToken
      : undefined
  } while (continuationToken)

  return songs
}

// ── Main page ──────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Player running at http://localhost:${PORT}`)
})
