import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import express from 'express'

import { getDashboardData } from './lib/dashboard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const clientDist = path.resolve(projectRoot, 'dist')
const port = Number.parseInt(process.env.PORT ?? '8787', 10)

const app = express()

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.get('/api/usage', async (_request, response) => {
  try {
    const data = await getDashboardData()
    response.json(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown server error'
    response.status(500).json({ error: message })
  }
})

app.use(async (request, response, next) => {
  try {
    await fs.access(clientDist)
    next()
  } catch {
    if (request.path.startsWith('/api/')) {
      response.status(404).json({ error: 'API route not found.' })
      return
    }

    response.status(503).send('Frontend build not found. Run `npm run build` before `npm run start`.')
  }
})

app.use(express.static(clientDist))

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(clientDist, 'index.html'))
})

app.listen(port, () => {
  console.log(`ACP Monitor listening on http://localhost:${port}`)
})
