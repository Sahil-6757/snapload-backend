const express = require('express')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')
const YTDlpWrap = require('yt-dlp-wrap').default
const ffmpegStatic = require('ffmpeg-static')
const https = require('https')

const router = express.Router()

const appRoot = path.join(__dirname, '..')

// Custom direct downloader to follow redirects and bypass GitHub API rate limit
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    
    const request = (targetUrl) => {
      https.get(targetUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Follow redirect
          request(response.headers.location)
          return
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: Status Code ${response.statusCode}`))
          return
        }
        
        response.pipe(file)
        
        file.on('finish', () => {
          file.close()
          resolve()
        })
      }).on('error', (err) => {
        fs.unlink(dest, () => {})
        reject(err)
      })
    }
    
    request(url)
  })
}

let ytDlpBinaryPath = 'yt-dlp'
let initPromise = Promise.resolve()

try {
  execSync('yt-dlp --version')
  console.log('Using global yt-dlp binary.')
} catch (e) {
  const binDir = path.join(appRoot, 'bin')
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true })
  }

  const binaryName = os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const localPath = path.join(binDir, binaryName)

  if (fs.existsSync(localPath)) {
    ytDlpBinaryPath = localPath
    console.log(`Using existing local yt-dlp binary at: ${ytDlpBinaryPath}`)
  } else {
    console.log(`Global yt-dlp not found. Downloading to local path: ${localPath}...`)
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`
    initPromise = downloadFile(downloadUrl, localPath)
      .then(() => {
        try {
          fs.chmodSync(localPath, '755')
        } catch (chmodErr) {
          // Ignore permission changes on Windows
        }
        console.log('Local yt-dlp binary download completed successfully.')
      })
      .catch(err => {
        console.error('Failed to download yt-dlp binary from GitHub:', err.message || err)
      })

    ytDlpBinaryPath = localPath
  }
}

const ytDlp = new YTDlpWrap(ytDlpBinaryPath)

// Store progress of active downloads
const activeDownloads = new Map()

// Clean up any legacy or leftover downloads on startup
const downloadsDir = path.join(appRoot, 'downloads')
if (fs.existsSync(downloadsDir)) {
  fs.readdir(downloadsDir, (err, files) => {
    if (!err && files) {
      files.forEach(file => {
        if (file.startsWith('snapload-')) {
          const filePath = path.join(downloadsDir, file)
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) console.log(`Cleaned up leftover download: ${file}`)
          })
        }
      })
    }
  })
}

// SSE Endpoint for progress
router.get('/progress/:id', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const id = req.params.id

  const interval = setInterval(() => {
    const progress = activeDownloads.get(id)
    if (progress) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`)
      if (progress.status === 'completed' || progress.status === 'error') {
        clearInterval(interval)
        res.end()
      }
    }
  }, 500)

  req.on('close', () => {
    clearInterval(interval)
  })
})

router.post('/', async (req, res) => {
  try {
    await initPromise
    const { url } = req.body
    const downloadId = Date.now().toString()

    if (!url) {
      return res.status(400).json({ error: 'URL required' })
    }

    // Move downloads outside the server root to avoid nodemon interference
    const downloadsDir = path.join(appRoot, 'downloads')
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true })
    }

    const filename = `snapload-${downloadId}.mp4`
    const outputPath = path.join(downloadsDir, filename)

    const args = [
      url,
      '-f',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best',
      '--merge-output-format',
      'mp4',
      '--ffmpeg-location',
      ffmpegStatic,
      '--postprocessor-args',
      'ffmpeg:-c copy',
      '--no-playlist',
      '--force-overwrites',
      '--no-part',
      '--no-cache-dir',
      '--no-mtime',
      '--no-continue',
      '--throttled-rate',
      '100K',
      '--concurrent-fragments',
      '12',
      '--downloader-args',
      'ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
      '-o',
      outputPath,
    ]

    console.log(`Starting download ${downloadId}...`)

    const process = ytDlp.exec(args)

    if (process.ytDlpProcess) {
      process.ytDlpProcess.stdout.on('data', (data) => {
        console.log(`[yt-dlp stdout ${downloadId}]: ${data.toString().trim()}`)
      })

      process.ytDlpProcess.stderr.on('data', (data) => {
        console.error(`[yt-dlp stderr ${downloadId}]: ${data.toString().trim()}`)
      })
    }

    // Send the ID back to the client immediately
    res.json({ downloadId })

    activeDownloads.set(downloadId, { percent: 0, status: 'starting' })

    process.on('progress', (progress) => {
      activeDownloads.set(downloadId, {
        percent: progress.percent,
        totalSize: progress.totalSize,
        currentSpeed: progress.currentSpeed,
        eta: progress.eta,
        status: 'downloading'
      })
    })

    process.on('error', (err) => {
      console.log(`yt-dlp error (${downloadId}):`, err)
      activeDownloads.set(downloadId, { status: 'error', error: 'Download failed' })
    })

    process.on('close', (code) => {
      console.log(`Process ${downloadId} exited with code:`, code)

      if (code !== 0) {
        activeDownloads.set(downloadId, { status: 'error', error: 'Process failed' })
        return
      }

      activeDownloads.set(downloadId, { percent: 100, status: 'completed', filename })
    })
  } catch (error) {
    console.log('Server error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// New endpoint to actually fetch the completed file
router.get('/file/:id', (req, res) => {
  const id = req.params.id
  const filename = `snapload-${id}.mp4`
  const outputPath = path.join(appRoot, 'downloads', filename)

  console.log(`Client requested file download for ID: ${id}`)
  console.log(`Looking for file at: ${outputPath}`)

  if (fs.existsSync(outputPath)) {
    console.log('File found! Starting transfer...')
    res.download(outputPath, filename, (err) => {
      if (err) {
        console.log('File download error or aborted:', err)
      }
      
      // Clean up after the transfer finishes or is aborted
      setTimeout(() => {
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath)
            console.log(`Successfully deleted file: ${outputPath}`)
          }
        } catch (unlinkErr) {
          console.error(`Error deleting file ${outputPath}:`, unlinkErr)
        }
        activeDownloads.delete(id)
      }, 1000)
    })
  } else {
    res.status(404).send('File not found')
  }
})

module.exports = router