/**
 * Gets songs from the server API and plays them in the custom WEB-player.
 * S3 interactions have been moved server-side; this file only talks to /api/*.
 */

const API = 'api'

const $ = (selector) => {
  const el = document.querySelector(selector)
  if (!el) {
    throw new Error(`Element not found for selector: ${selector}`)
  }
  return el
}

const DOM = {
  overlay: $('.overlay'),
  audio: $('.audio'),
  songName: $('.song-name'),
  toggleButton: $('.toggle-button'),
  time: $('.current-time'),
  volumeButton: $('.volume-button'),
  progress: $('.progress'),
  volume: $('.volume-regulator'),
  canvas: $('.canvas'),
  spinner: $('.load-spinner'),
  lyricsButton: $('.toggle-lyrics-button'),
  lyricsPanel: $('.lyrics-panel'),
  lyricsContent: $('.lyrics-content'),
  lyricsText: $('.lyrics-text'),
  toggleBarsButton: $('.toggle-bars-button'),
  shuffleButton: $('.shuffle-button'),
  queuePanel: $('.queue-panel'),
  queueList: $('.queue-list'),
  queueSearch: $('.queue-search'),
  queueButton: $('.toggle-queue-button'),
  loginForm: $('.login-form'),
  loginPassword: $('.login-password'),
  loginSubmit: $('.login-submit'),
  loginError: $('.login-error'),
}

const Player = {
  songs: [],
  originalSongs: [],
  index: 0,
  isLoading: true,
}
const Queue = {
  visible: false,
  searchQuery: '',
}
const Lyrics = {
  current: null,
  visible: false,
}
const Audio = {
  context: null,
  analyzer: null,
  gainNode: null,
  lastVolume: 0.5,
  isSeeking: false,
  seekTimeout: null,
  pendingSeek: null,
  config: {
    fftSize: 512,
    minDecibels: -90,
    smoothingTimeConstant: 0.75,
  },

  init() {
    if (!this.context) {
      this.context = new AudioContext()
      const src = this.context.createMediaElementSource(DOM.audio)

      this.analyzer = this.context.createAnalyser()
      this.analyzer.fftSize = this.config.fftSize
      this.analyzer.minDecibels = this.config.minDecibels
      this.analyzer.smoothingTimeConstant = this.config.smoothingTimeConstant

      this.gainNode = this.context.createGain()
      src.connect(this.gainNode)
      this.gainNode.connect(this.analyzer)
      this.analyzer.connect(this.context.destination)

      Object.assign(this.analyzer, this.config)
      this.gainNode.gain.value = this.lastVolume

      Visualizer.init()
    }
  },

  resume() {
    if (this.context?.state === 'suspended') {
      this.context.resume()
    }
  },

  setVolume(value) {
    this.lastVolume = value

    if (this.gainNode) {
      this.gainNode.gain.setTargetAtTime(value, this.context.currentTime, 0.01)
    }
  },
}

const supportedFormats = ['.mp3', '.ogg', '.wav', '.flac']

const Visualizer = {
  rafId: null,
  context: null,
  canvas: null,
  canvasOptions: {
    innerHeight: null,
    innerWidth: null,
    capHeight: 2,
    barWidth: 11,
    barHeight: null,
    barSpacing: 22,
    barCount: null,
    styles: null,
    frequencyUpper: null,
    frequencyLimit: null,
  },
  dpr: 1,
  colors: {
    cap: '#fff',
    barTop: '#0f3443',
    barMiddle: '#1b8d93ff',
    barBottom: '#54d1daff',
  },
  frequencyData: null,
  decayData: null,
  stopped: false,

  setupContext() {
    this.canvas = this.canvas || DOM.canvas
    this.dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = rect.width * this.dpr
    this.canvas.height = rect.height * this.dpr
    const ctx = this.canvas.getContext('2d')
    ctx.scale(this.dpr, this.dpr)

    this.context = ctx
  },

  initializeOptions() {
    const innerHeight = this.canvas.height / this.dpr
    const innerWidth = this.canvas.width / this.dpr
    const barHeight = innerHeight - this.canvasOptions.capHeight
    const barCount = Math.round(innerWidth / this.canvasOptions.barSpacing)
    const styles = {
      capStyle: this.colors.cap,
      gradient: (() => {
        const g = this.context.createLinearGradient(0, barHeight, 0, 0)

        g.addColorStop(1, this.colors.barTop)
        g.addColorStop(0.5, this.colors.barMiddle)
        g.addColorStop(0, this.colors.barBottom)
        return g
      })(),
    }

    const frequencyUpper = (Audio.context?.sampleRate || 44100) / 2
    const frequencyLimit = Math.min(16e3, frequencyUpper)

    Object.assign(this.canvasOptions, {
      innerHeight,
      innerWidth,
      barHeight,
      barCount,
      styles,
      frequencyUpper,
      frequencyLimit,
    })
  },

  init() {
    this.setupContext()
    this.initializeOptions()

    if (!this.frequencyData) {
      this.frequencyData = new Uint8Array(Audio.analyzer.frequencyBinCount)
      this.decayData = new Float32Array(Audio.analyzer.frequencyBinCount)
    }
  },

  updateCanvasParameters() {
    this.setupContext()
    this.initializeOptions()
  },

  drawFrame() {
    if (this.canvasOptions && Audio.analyzer) {
      const ctx = this.context
      const opts = this.canvasOptions

      ctx.clearRect(0, 0, opts.innerWidth, opts.innerHeight)

      const decay = this.decayData

      const step =
        (decay.length * (opts.frequencyLimit / opts.frequencyUpper) - 1) /
        (opts.barCount - 1)

      const startX =
        (opts.innerWidth -
          (opts.barSpacing * (opts.barCount - 1) + opts.barWidth)) /
        2

      for (let i = 0; i < opts.barCount; i++) {
        const value = decay[Math.floor(i * step)] / 255
        const x = startX + opts.barSpacing * i

        if (x >= 0 && x + opts.barWidth <= opts.innerWidth) {
          ctx.fillStyle = opts.styles.gradient
          ctx.fillRect(
            x,
            opts.barHeight * (1 - value) + opts.capHeight,
            opts.barWidth,
            opts.barHeight * value,
          )

          ctx.fillStyle = opts.styles.capStyle
          ctx.fillRect(
            x,
            opts.barHeight * (1 - value),
            opts.barWidth,
            opts.capHeight,
          )
        }
      }
    }
  },

  computeDecay(decayData, frequencyData, canSample) {
    const nextDecay = new Float32Array(decayData.length)
    let isActive = false

    for (let i = 0; i < decayData.length; i++) {
      const input = canSample ? frequencyData[i] : 0
      const val = Math.max(input, decayData[i] * 0.92)
      nextDecay[i] = val
      if (!isActive && val > 0.05) {
        isActive = true
      }
    }

    return { nextDecay, isActive }
  },

  render() {
    const canSample = !DOM.audio.paused && !Audio.isSeeking && !isMuted()

    if (canSample) {
      Audio.analyzer.getByteFrequencyData(this.frequencyData)
    }

    const { nextDecay, isActive } = this.computeDecay(
      this.decayData,
      this.frequencyData,
      canSample,
    )

    this.decayData = nextDecay

    if (isActive || canSample) {
      this.drawFrame()
      this.rafId = requestAnimationFrame(this.render.bind(this))
    } else {
      this.stop()
    }
  },

  start() {
    if (!this.rafId) {
      this.render()
    }
  },

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  },
}

const unsafeChars = /[\/\\\?\%\#\:\<\>\|\"\\*]/g
const escapeRegex = /__([0-9A-Fa-f]{2})__/g

function decodeFilename(encoded) {
  return encoded.replace(escapeRegex, (_, hex) => {
    const code = parseInt(hex, 16)

    return isNaN(code) ? `__${hex}__` : String.fromCharCode(code)
  })
}

window.AudioContext =
  window.AudioContext || window.webkitAudioContext || window.mozAudioContext

DOM.audio.volume = 1

/**
 * Loads songs in their original order on startup.
 * @param {string[]} songs. Array of songs' names received from Object Storage.
 */
function loadMusic(songs) {
  DOM.audio.currentTime = 0
  navigator.mediaSession.playbackState = 'paused'
  Player.songs = songs
  Player.originalSongs = songs
    .slice()
    .sort((a, b) => prepareTitle(a).localeCompare(prepareTitle(b)))
  Player.index = 0

  showFirst()
}

/**
 * Shuffles the playlist in-place (Fisher-Yates) and jumps to a random song.
 */
function shufflePlaylist() {
  DOM.shuffleButton.classList.add('shuffle-button--active')
  let remaining = Player.songs.length,
    index,
    temp

  while (remaining > 0) {
    index = Math.floor(Math.random() * remaining)
    remaining--
    temp = Player.songs[remaining]
    Player.songs[remaining] = Player.songs[index]
    Player.songs[index] = temp
  }

  Player.index = Math.floor(Math.random() * Player.songs.length)

  changeSong()
  setTimeout(
    () => DOM.shuffleButton.classList.remove('shuffle-button--active'),
    1000,
  )
}

/**
 * Loads the first element of song list to the HTML. Also turns off the overlay.
 */
function showFirst() {
  DOM.progress.value = 0

  if (
    navigator.mediaSession.playbackState === 'paused' &&
    DOM.audio.src === ''
  ) {
    updateTitle()
    disableLoader()

    DOM.audio.src = songUrl(Player.songs[0])
    DOM.songName.style.display = 'inline-block'
    loadSongLyrics()
  }
}

/**
 * Shows loader spinner at the very beginning.
 */
function initLoader() {
  DOM.overlay.style.display = 'block'
  DOM.spinner.style.display = 'block'
  DOM.loginForm.style.display = 'none'
}

/**
 * Disables shadowing of background and loader spinner.
 */
function disableLoader() {
  DOM.overlay.style.display = 'none'
  DOM.spinner.style.display = 'none'
}

function showCanvas() {
  DOM.canvas.style.display = 'block'
}

function hideCanvas() {
  DOM.canvas.style.display = 'none'
}

/**
 * Switches from loading spinner to the login form.
 */
function showLoginForm() {
  DOM.spinner.style.display = 'none'
  DOM.loginForm.style.display = 'flex'
  DOM.loginError.textContent = ''
  DOM.loginPassword.value = ''
  DOM.loginPassword.focus()
}

/**
 * Submits the login form to the server.
 */
async function submitLogin() {
  const password = DOM.loginPassword.value
  DOM.loginError.textContent = ''
  DOM.loginSubmit.disabled = true

  try {
    const res = await fetch(`${API}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      DOM.loginForm.style.display = 'none'
      DOM.spinner.style.display = 'block'
      await requestSongs()
      addListeners()
    } else {
      DOM.loginError.textContent = 'Wrong password'
      DOM.loginPassword.value = ''
      DOM.loginPassword.focus()
    }
  } catch {
    DOM.loginError.textContent = 'Connection error'
  } finally {
    DOM.loginSubmit.disabled = false
  }
}

/**
 * Updates session data on changing of song.
 * @param {string} title. Song[i].Key (title of song).
 */
function updateMetadata(fullTitle, year) {
  if ('mediaSession' in navigator) {
    let captureGroups = fullTitle.split(/\s-\s/)

    navigator.mediaSession.metadata = new MediaMetadata({
      artist: captureGroups[0],
      title: captureGroups[1],
      artwork: [{ src: 'assets/earth.webp' }],
      album: year, // Put year in album field cause there is no such field sadly
    })
  }
}

/**
 * Performs title transformations.
 * @param {string} title. Initial name of song with extensions.
 * @return {string} preparedTitle
 */
function prepareTitle(title) {
  return decodeFilename(title.replace(/\.(mp3|ogg|wav|flac)$/, ''))
}

/**
 * Updates title of song on switch. Also removes extension from the title.
 */
function updateTitle() {
  const preparedTitleWithYear = prepareTitle(Player.songs[Player.index])

  const [fullTitle, possibleYear] = preparedTitleWithYear
    .split(/(\d{4})$/)
    .map((v) => (v ? v.trim() : v))

  DOM.songName.textContent = document.title = fullTitle
  updateMetadata(fullTitle, possibleYear)
  updateMarquee()
}

/**
 * Recalculates marquee scroll for the current title based on available container width.
 * Safe to call after resize or any layout change.
 */
function updateMarquee() {
  DOM.songName.classList.remove('song-name--scrolling')
  DOM.songName.style.removeProperty('--marquee-offset')
  DOM.songName.style.removeProperty('--marquee-duration')

  const overflow =
    DOM.songName.scrollWidth - DOM.songName.parentElement.clientWidth

  if (overflow > 0) {
    const duration = Math.max(3, overflow / 40)
    DOM.songName.style.setProperty('--marquee-offset', `-${overflow}px`)
    DOM.songName.style.setProperty('--marquee-duration', `${duration}s`)
    DOM.songName.classList.add('song-name--scrolling')
  }
}

/**
 * Handles song index when switching from last song in list to the first and vice versa.
 * @param {number} index. Current song index.
 * @param {number} length. Length of song list.
 * @return {number} normalized index.
 */
function normalizeSongIndex(index, length) {
  if (index >= length) {
    return 0
  } else if (index < 0) {
    return length + index
  } else {
    return index
  }
}

/**
 * Sets the logic of toggle button. Also opens/closes contexts.
 */
function toggleMusic() {
  if (DOM.audio.src != '' && DOM.audio.paused) {
    playCurrentSong()
  } else if (DOM.audio.src != '' && !DOM.audio.paused) {
    pauseSong()
  }
}

/**
 * Updates audio source to load song by index.
 * @param {number} index. Index of song to load.
 */
function loadSong(index) {
  DOM.audio.pause()
  DOM.audio.src = songUrl(Player.songs[index])
  DOM.audio.load()
}

/**
 * Starts playing current song.
 */
function playCurrentSong() {
  Audio.init()
  Audio.resume()
  DOM.audio.play().catch(() => {})
  navigator.mediaSession.playbackState = 'playing'
}

/**
 * Pauses current song.
 */
function pauseSong() {
  DOM.audio.pause()
  navigator.mediaSession.playbackState = 'paused'
}

/**
 * Updates song on changing of index.
 */
function changeSong() {
  navigator.mediaSession.playbackState = 'paused'

  loadSong(Player.index)
  updateTitle()
  playCurrentSong()
  loadSongLyrics()
  updateQueuePanel()
}

/**
 * Sets the logic of next song button. Also changes visuals.
 */
function nextSong() {
  incrementSong()
  changeSong()
}

/**
 * Sets the logic of previous song button. Also visual changes.
 */
function previousSong() {
  decrementSong()
  changeSong()
}

/**
 * Based on current timing of audio component fill the text area left of position element.
 */
function updateDisplayedTime() {
  if (Math.floor(DOM.audio.currentTime % 60) < 10)
    DOM.time.innerHTML =
      Math.floor(DOM.audio.currentTime / 60) +
      ':0' +
      Math.floor(DOM.audio.currentTime % 60)
  else
    DOM.time.innerHTML =
      Math.floor(DOM.audio.currentTime / 60) +
      ':' +
      Math.floor(DOM.audio.currentTime % 60)
}

/**
 * Returns the URL for an audio file routed through the server proxy.
 * @param {string} title. Song filename (no subpath prefix).
 * @return {string} url
 */
function songUrl(title) {
  return `${API}/audio?key=` + encodeURIComponent(title)
}

/**
 * Requests songs from the server.
 */
async function requestSongs() {
  try {
    const res = await fetch(`${API}/songs`)
    if (!res.ok) throw new Error('Server returned ' + res.status)
    const songs = await res.json()
    loadMusic(songs)
  } catch (err) {
    console.error('Error fetching songs:', err)
  }
}

/**
 * Increment current song index.
 */
function incrementSong() {
  Player.index = normalizeSongIndex(Player.index + 1, Player.songs.length)
}

/**
 * Decrement current song index.
 */
function decrementSong() {
  Player.index = normalizeSongIndex(Player.index - 1, Player.songs.length)
}

/**
 * Switches to the next song if the previous has ended.
 */
function nextSongOnEnd() {
  incrementSong()
  updateTitle()

  DOM.audio.src = songUrl(Player.songs[Player.index])
  DOM.audio.play()
  updateQueuePanel()
}

/**
 * Moves slider according to current time.
 */
function moveSlider() {
  if (!Audio.isSeeking) {
    DOM.progress.value = (DOM.audio.currentTime * 100) / DOM.audio.duration
  }

  if (DOM.audio.currentTime === 0) {
    DOM.progress.value = 1
  } else {
    DOM.progress.value = (DOM.audio.currentTime * 100) / DOM.audio.duration
  }

  updateDisplayedTime()
}

/**
 * Checks whether the audio is muted.
 */
function isMuted() {
  const vol = DOM.volume ? Number(DOM.volume.value) : Audio.lastVolume
  return vol < 0.0001
}

/**
 * Toggles the visualization bars on/off.
 */
function toggleBars() {
  if (Visualizer.context) {
    const stopped = !Visualizer.stopped

    Visualizer.stopped = stopped

    if (stopped) {
      Visualizer.stop()
      DOM.toggleBarsButton.classList.add('toggle-bars-button--active')

      hideCanvas()
    } else {
      Visualizer.start()
      DOM.toggleBarsButton.classList.remove('toggle-bars-button--active')

      showCanvas()
    }
  }
}

/**
 * Toggles the mute icon according to the volume.
 */
function updateVolumeButtonIcon() {
  DOM.volumeButton.src = isMuted() ? 'assets/mute.png' : 'assets/volume.png'
}

/**
 * Changes the volume according to the slider position.
 */
function changeVolume() {
  const vol = Number(DOM.volume.value)
  Audio.lastVolume = vol

  if (!Audio.gainNode || !Audio.context) {
    Audio.init()
  }

  if (!isMuted()) {
    Visualizer.start()
  }

  Audio.gainNode.gain.setTargetAtTime(vol, Audio.context.currentTime, 0.01)
  updateVolumeButtonIcon()
}

/**
 * Toggles mute on click.
 */
function toggleMute() {
  if (!Audio.gainNode || !Audio.context) {
    Audio.init()
    return
  }

  Audio.gainNode.gain.cancelScheduledValues(Audio.context.currentTime)

  if (Audio.gainNode.gain.value > 0.001) {
    Audio.lastVolume = Audio.gainNode.gain.value
    Audio.gainNode.gain.setTargetAtTime(0, Audio.context.currentTime, 0.04)
    DOM.volume.value = 0
  } else {
    Audio.gainNode.gain.setTargetAtTime(
      Audio.lastVolume,
      Audio.context.currentTime,
      0.04,
    )
    DOM.volume.value = Audio.lastVolume
    Visualizer.start()
  }

  updateVolumeButtonIcon()
}

/**
 * Updates play/pause icon based on slider value.
 */
function updatePlayIcon() {
  DOM.toggleButton.src = DOM.audio.paused
    ? 'assets/play.png'
    : 'assets/pause.png'
}

/**
 * Shows or hides the lyrics button based on whether lyrics are available.
 */
function updateLyricsButton() {
  DOM.lyricsButton.style.display = Lyrics.current ? 'block' : 'none'
}

/**
 * Shows the lyrics panel with the current song's lyrics.
 */
function showLyricsPanel() {
  renderLyrics(Lyrics.current || '')

  DOM.lyricsPanel.style.display = 'flex'
  Lyrics.visible = true
  DOM.lyricsButton.classList.add('toggle-lyrics-button--active')

  requestAnimationFrame(() => {
    DOM.lyricsContent.scrollTop = 0
  })
}

/**
 * Hides the lyrics panel.
 */
function hideLyricsPanel() {
  DOM.lyricsPanel.style.display = 'none'
  Lyrics.visible = false
  DOM.lyricsButton.classList.remove('toggle-lyrics-button--active')
}

/**
 * Toggles the lyrics panel on/off.
 */
function toggleLyrics() {
  if (Lyrics.visible) {
    hideLyricsPanel()
  } else if (Lyrics.current) {
    hideQueuePanel()

    showLyricsPanel()
  }
}

/**
 * Loads lyrics for the current song from the server, then updates the button visibility.
 */
async function loadSongLyrics() {
  Lyrics.current = null
  hideLyricsPanel()
  updateLyricsButton()

  try {
    const res = await fetch(
      `${API}/lyrics?key=` + encodeURIComponent(Player.songs[Player.index]),
    )
    if (res.ok) {
      const data = await res.json()
      Lyrics.current = data.lyrics ?? null
    }
  } catch {
    Lyrics.current = null
  }

  updateLyricsButton()
}

/**
 * Renders lyrics text by splitting it into lines and creating divs for each line.
 * @param {string} text. Song text in single string
 */
function renderLyrics(text) {
  DOM.lyricsText.innerHTML = ''

  const lines = (text || '').split('\n')
  const fragment = document.createDocumentFragment()

  lines.forEach((line) => {
    const el = document.createElement('div')
    el.className = 'lyric-line'
    el.textContent = line

    if (line.trim() === '') {
      el.classList.add('verse-break')
    }

    fragment.appendChild(el)
  })

  DOM.lyricsText.appendChild(fragment)
}

/**
 * Toggles the queue panel (song list + search) on/off.
 */
function toggleQueue() {
  if (Queue.visible) {
    hideQueuePanel()
  } else {
    hideLyricsPanel()

    showQueuePanel()
  }
}

function showQueuePanel() {
  Queue.visible = true
  DOM.queuePanel.style.display = 'flex'
  DOM.queueButton.classList.add('toggle-queue-button--active')
  updateQueuePanel()

  requestAnimationFrame(() => DOM.queueSearch.focus())
}

function hideQueuePanel() {
  Queue.visible = false
  DOM.queuePanel.style.display = 'none'
  DOM.queueButton.classList.remove('toggle-queue-button--active')
}

/**
 * Redraws the queue panel contents. No-ops when the panel is hidden.
 */
function updateQueuePanel() {
  if (!Queue.visible) {
    return
  }

  const query = Queue.searchQuery.toLowerCase().trim()

  if (query) {
    renderSearchResults(query)
  } else {
    renderNearSongs()
  }
}

/**
 * Renders previous, current and next songs in the queue panel.
 */
function renderNearSongs() {
  const { songs, index } = Player
  DOM.queueList.textContent = ''

  if (songs.length === 0) {
    return
  }

  const items = []

  ;[-2, -1, 0, 1, 2].forEach((offset) => {
    const idx = normalizeSongIndex(index + offset, songs.length)
    const type = offset < 0 ? 'prev' : offset > 0 ? 'next' : 'current'
    items.push({ idx, type })
  })

  const fragment = document.createDocumentFragment()

  items.forEach(({ idx, type }) => {
    const el = document.createElement('div')
    el.className = `queue-item queue-item--${type}`
    el.textContent = prepareTitle(songs[idx])

    if (type !== 'current') {
      el.addEventListener('click', () => {
        Player.index = idx
        changeSong()
      })
    }

    fragment.appendChild(el)
  })

  DOM.queueList.appendChild(fragment)
}

/**
 * Renders search results filtered by query string.
 * @param {string} query. Lowercase trimmed search string.
 */
function renderSearchResults(query) {
  DOM.queueList.textContent = ''

  const matches = Player.originalSongs
    .filter((song) => prepareTitle(song).toLowerCase().includes(query))
    .slice(0, 30)

  if (matches.length === 0) {
    const el = document.createElement('div')
    el.className = 'queue-empty'
    el.textContent = 'No songs found'
    DOM.queueList.appendChild(el)
    return
  }

  const fragment = document.createDocumentFragment()

  matches.forEach((song) => {
    const idx = Player.songs.indexOf(song)
    const el = document.createElement('div')
    const isCurrent = idx === Player.index
    el.className = `queue-item${isCurrent ? ' queue-item--current' : ''}`
    el.textContent = prepareTitle(song)

    if (!isCurrent && idx !== -1) {
      el.addEventListener('click', () => {
        Player.index = idx
        Queue.searchQuery = ''
        DOM.queueSearch.value = ''
        changeSong()
      })
    }

    fragment.appendChild(el)
  })

  DOM.queueList.appendChild(fragment)
}

/**
 * Adds all necessary event listeners for the player controls.
 */
function addListeners() {
  let resizeTimeout
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout)
    resizeTimeout = setTimeout(() => {
      Visualizer.updateCanvasParameters()
      updateMarquee()
    }, 25)
  })

  DOM.audio.addEventListener('ended', nextSongOnEnd)
  DOM.audio.addEventListener('timeupdate', moveSlider)
  DOM.audio.addEventListener('play', () => {
    Visualizer.start()

    updatePlayIcon()
  })

  DOM.audio.addEventListener('pause', () => {
    updatePlayIcon()
  })

  DOM.audio.addEventListener('seeking', () => {
    Audio.isSeeking = true

    if (Audio.gainNode && !Audio.context) {
      Audio.gainNode.gain.cancelScheduledValues(Audio.context.currentTime)
      Audio.gainNode.gain.setValueAtTime(
        Audio.lastVolume,
        Audio.context.currentTime,
      )
    }
  })

  DOM.audio.addEventListener('seeked', async () => {
    Audio.isSeeking = false

    if (Audio.context && Audio.context.state !== 'running') {
      try {
        await Audio.context.resume() // Safari may auto-suspend, so resume
      } catch (err) {
        console.warn('AudioContext resume failed after seek', err)
      }
    }

    if (Audio.gainNode) {
      Audio.gainNode.gain.setTargetAtTime(
        Number(DOM.volume.value),
        Audio.context.currentTime,
        0.03,
      )
    }

    Visualizer.start()
  })

  DOM.progress.addEventListener('input', () => {
    if (Audio.seekTimeout) clearTimeout(Audio.seekTimeout)

    Audio.seekTimeout = setTimeout(() => {
      if (!DOM.audio.duration || isNaN(DOM.audio.duration)) {
        Audio.pendingSeek = DOM.progress.value
        return
      }

      Audio.isSeeking = true
      DOM.audio.currentTime = (DOM.audio.duration / 100) * DOM.progress.value
    }, 20)
  })

  DOM.audio.addEventListener('loadedmetadata', () => {
    if (Audio.pendingSeek !== null) {
      DOM.audio.currentTime = (DOM.audio.duration / 100) * Audio.pendingSeek

      Audio.pendingSeek = null
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (Lyrics.visible) {
        hideLyricsPanel()
      }

      if (Queue.visible) {
        hideQueuePanel()
      }
    }
  })

  DOM.queueSearch.addEventListener('input', (e) => {
    Queue.searchQuery = e.target.value
    updateQueuePanel()
  })

  DOM.volumeButton.addEventListener('click', toggleMute)
  DOM.volume.addEventListener('input', changeVolume)

  navigator.mediaSession.setActionHandler('previoustrack', previousSong)
  navigator.mediaSession.setActionHandler('nexttrack', nextSong)
  navigator.mediaSession.setActionHandler('pause', toggleMusic)
  navigator.mediaSession.setActionHandler('play', toggleMusic)
}

/**
 * Boot sequence: check auth, show login if needed, otherwise start the player.
 */
window.addEventListener('load', async () => {
  initLoader()

  // Wire up login form
  DOM.loginSubmit.addEventListener('click', submitLogin)
  DOM.loginPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLogin()
  })

  // Check if the session cookie is still valid
  const res = await fetch(`${API}/me`)
  if (res.ok) {
    await requestSongs()
    addListeners()
  } else {
    showLoginForm()
  }
})
