require('dotenv').config()

const express = require('express')
const session = require('express-session')
const SQLiteStore = require('connect-sqlite3')(session)
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3')

const bcrypt = require('bcrypt')
const yaml = require('js-yaml')
const { Readable } = require('stream')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// Must match the BASE constant in scripts/player.js

// ── S3 configuration ───────────────────────────────────────────────────────────

const BUCKET = process.env.S3_BUCKET
const ENDPOINT = process.env.S3_ENDPOINT
const SUBPATH = process.env.S3_SUBPATH || 'music/'
const METADATA = process.env.S3_METADATA || 'metadata/'
const REGION = process.env.S3_REGION || 'eu-frankfurt-1'
const FORCE_PATH_STYLE = process.env.FORCE_PATH_STYLE === 'true'

const hasCredentials = !!(
  process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
)

// Private bucket: use SDK v3 with signed requests
let s3 = null
if (hasCredentials) {
  s3 = new S3Client({
    endpoint: `https://${ENDPOINT}`,
    region: REGION,
    forcePathStyle: FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

const SUPPORTED_FORMATS = ['mp3', 'ogg', 'wav', 'flac']
const SUPPORTED_FORMATS_REGEXP = new RegExp(
  `\\.(${SUPPORTED_FORMATS.join('|')})$`,
  'i',
)

// ── Startup cache ─────────────────────────────────────────────────────────────
// Populated once at startup so client connections never trigger S3 list requests.

let songsCache = null // string[] | null
let metadataFilesCache = null // Set<string> of basenames | null

async function warmCache() {
  const listSongs = hasCredentials ? listPrivateSongs : listPublicSongs
  const listMetadata = hasCredentials
    ? listPrivateMetadataFiles
    : listPublicMetadataFiles

  const [songs, metadataFiles] = await Promise.all([
    listSongs().catch((err) => {
      console.error('Failed to list songs:', err)
      return null
    }),
    listMetadata().catch((err) => {
      console.error('Failed to list metadata files:', err)
      return null
    }),
  ])

  songsCache = songs
  metadataFilesCache = metadataFiles
  console.log(
    `Cache warmed: ${songs?.length ?? 0} songs, ${metadataFiles?.size ?? 0} metadata files`,
  )
}

// ── Public bucket helpers (plain unsigned fetch, no SDK) ──────────────────────

function publicBucketBase() {
  if (FORCE_PATH_STYLE) {
    return `https://${ENDPOINT}/${BUCKET}`
  } else {
    return `https://${BUCKET}.${ENDPOINT}`
  }
}

async function listPublicSongs() {
  const songs = []
  let continuationToken

  do {
    let url = `${publicBucketBase()}?list-type=2&prefix=${encodeURIComponent(SUBPATH)}`
    if (continuationToken)
      url += `&continuation-token=${encodeURIComponent(continuationToken)}`

    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`S3 list error: ${res.status}`)
    }

    const xml = await res.text()

    for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const filename = key.slice(SUBPATH.length)
      if (filename && SUPPORTED_FORMATS_REGEXP.test(filename)) {
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

async function listPublicMetadataFiles() {
  if (!METADATA) return null
  const files = new Set()
  let continuationToken

  do {
    let url = `${publicBucketBase()}?list-type=2&prefix=${encodeURIComponent(METADATA)}`
    if (continuationToken)
      url += `&continuation-token=${encodeURIComponent(continuationToken)}`

    const res = await fetch(url)
    if (!res.ok) return null
    const xml = await res.text()

    for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const filename = key.slice(METADATA.length)
      if (filename.endsWith('.yml')) files.add(filename.slice(0, -4))
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml)
    const tokenMatch = xml.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
    )
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined
  } while (continuationToken)

  return files
}

async function streamPublicAudio(key, range, res) {
  const url = `${publicBucketBase()}/${SUBPATH}${encodeURIComponent(key)}`
  const headers = range ? { Range: range } : {}
  const s3res = await fetch(url, { headers })

  const ct = s3res.headers.get('content-type')
  const cl = s3res.headers.get('content-length')
  const cr = s3res.headers.get('content-range')
  if (ct) {
    res.set('Content-Type', ct)
  }
  if (cl) {
    res.set('Content-Length', cl)
  }
  if (cr) {
    res.set('Content-Range', cr)
  }
  res.set('Accept-Ranges', 'bytes')
  res.status(range ? 206 : s3res.status)

  Readable.fromWeb(s3res.body).pipe(res)
}

async function fetchPublicLyrics(key) {
  if (METADATA) {
    const baseName = key.replace(SUPPORTED_FORMATS_REGEXP, '')
    const url = `${publicBucketBase()}/${METADATA}${encodeURIComponent(baseName)}.yml`
    const res = await fetch(url)

    if (res.ok) {
      const text = await res.text()
      const parsed = yaml.load(text)
      return parsed?.lyrics ?? null
    } else {
      return null
    }
  } else {
    return null
  }
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
    store: new SQLiteStore({ db: 'sessions.db', dir: '.' }),
    secret: process.env.SESSION_SECRET || 'please-change-this-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    },
  }),
)

// Static assets — no secrets here
const staticOpts = { maxAge: '7d' }
app.use('/styles', express.static(path.join(__dirname, 'styles'), staticOpts))
app.use('/scripts', express.static(path.join(__dirname, 'scripts'), staticOpts))
app.use('/assets', express.static(path.join(__dirname, 'assets'), staticOpts))

// ── API router ──────────────────────────────────────

const router = express.Router()

function requireAuth(req, res, next) {
  if (req.session?.user) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
})

const usersFile = path.join(__dirname, 'users.json')
const users = fs.existsSync(usersFile)
  ? JSON.parse(fs.readFileSync(usersFile, 'utf-8'))
  : {}

/** POST /api/auth  { password } → sets session cookie */
router.post('/auth', authLimiter, async (req, res) => {
  const { password } = req.body || {}
  let matched = null
  for (const [name, hash] of Object.entries(users)) {
    if (await bcrypt.compare(password, hash)) matched = name
  }

  if (matched) {
    console.log(`User ${matched} authenticated successfully`)

    req.session.user = matched
    res.json({ ok: true })
  } else {
    console.log('Failed authentication attempt with password: ', password)

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
  if (songsCache) return res.json(songsCache)

  try {
    const songs = hasCredentials
      ? await listPrivateSongs()
      : await listPublicSongs()
    songsCache = songs
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

// Lyrics are lightweight — cache them in memory for the lifetime of the server process.
// Map value is the lyrics string or null ("no lyrics"); Map.has() distinguishes a cached
// null from an uncached entry.
const lyricsCache = new Map()

/** GET /api/lyrics?key=<filename> → { lyrics: string | null } */
router.get('/lyrics', requireAuth, async (req, res) => {
  const { key } = req.query
  if (!key || !METADATA) {
    return res.json({ lyrics: null })
  }

  if (key.includes('..') || key.includes('/')) {
    return res.status(400).json({ error: 'Invalid key' })
  }
  if (lyricsCache.has(key)) {
    return res.json({ lyrics: lyricsCache.get(key) })
  }

  if (
    metadataFilesCache &&
    !metadataFilesCache.has(key.replace(SUPPORTED_FORMATS_REGEXP, ''))
  ) {
    lyricsCache.set(key, null)
    return res.json({ lyrics: null })
  }

  try {
    let lyrics = null

    if (!hasCredentials) {
      lyrics = await fetchPublicLyrics(key)
    } else {
      const baseName = key.replace(SUPPORTED_FORMATS_REGEXP, '')
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

    lyricsCache.set(key, lyrics)
    res.json({ lyrics })
  } catch (err) {
    const status = err.$metadata?.httpStatusCode
    if (status === 404 || err.name === 'NoSuchKey') {
      lyricsCache.set(key, null)
      res.json({ lyrics: null })
    } else {
      console.error('Error fetching lyrics:', err)
      res.json({ lyrics: null })
    }
  }
})

app.use('/api', router)

// ── Private bucket helpers ────────────────────────────────────────────────────

async function listPrivateMetadataFiles() {
  if (!METADATA) return null
  const files = new Set()
  let continuationToken

  do {
    const data = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: METADATA,
        ContinuationToken: continuationToken,
      }),
    )

    for (const obj of data.Contents || []) {
      const filename = obj.Key.slice(METADATA.length)
      if (filename.endsWith('.yml')) files.add(filename.slice(0, -4))
    }

    continuationToken = data.IsTruncated
      ? data.NextContinuationToken
      : undefined
  } while (continuationToken)

  return files
}

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
      if (key && SUPPORTED_FORMATS_REGEXP.test(key)) {
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

warmCache().then(() => {
  app.listen(PORT, () => {
    console.log(`Player running at http://localhost:${PORT}`)
  })
})
