const express = require('express')
const path = require('path')
const fs = require('fs')
const YTDlpWrap = require('yt-dlp-wrap').default

const router = express.Router()
const ytDlp = new YTDlpWrap('yt-dlp')

// Store progress of active downloads
const activeDownloads = new Map()

// Clean up any legacy or leftover downloads on startup
const downloadsDir = path.join(__dirname, '../../downloads')
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
    const { url } = req.body
    const downloadId = Date.now().toString()

    if (!url) {
      return res.status(400).json({ error: 'URL required' })
    }

    // Move downloads outside the server root to avoid nodemon interference
    const downloadsDir = path.join(__dirname, '../../downloads')
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
      '--postprocessor-args',
      'ffmpeg:-c copy',
      '--no-playlist',
      '--force-overwrites',
      '--no-part',
      '--no-cache-dir',
      '--no-mtime',
      '--no-continue',
      '--concurrent-fragments',
      '5',
      '-o',
      outputPath,
    ]

    console.log(`Starting download ${downloadId}...`)

    const process = ytDlp.exec(args)

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
  const outputPath = path.join(__dirname, '../../downloads', filename)

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