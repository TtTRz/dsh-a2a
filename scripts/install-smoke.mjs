/** Install a packed plugin (or an explicit spec) into a fresh Harness profile. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = await mkdtemp(join(tmpdir(), 'dsh-a2a-install-'))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(DSH_|A2A_|DEEPSEEK_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key]
}
env.DSH_HOME = home
env.DSH_A2A_CWD = join(home, 'workspace')
env.A2A_HOST = '127.0.0.1'
env.A2A_ENABLED = '1'

function run(command, args, cwd = home) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout)
  return result.stdout
}

let child
let stopped
try {
  assert.equal(run('dsh', ['--version']).trim(), '0.1.7-rc.2')
  let spec = process.argv[2]
  if (!spec) {
    run('npm', ['run', 'build'], root)
    const packed = JSON.parse(
      run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], root),
    )
    spec = join(home, packed[0].filename)
  }
  const profile = join(home, 'profiles', 'web')
  const installArgs = ['plugin', '--profile', 'web', 'add', spec]
  try {
    run('dsh', installArgs)
  } catch (error) {
    // pnpm 11 requires the exact resolved Git identity, not just the package name.
    const key = error.message.match(/^\s+(dsh-a2a@git\+[^\r\n]+): true$/m)?.[1]
    if (!key) throw error
    const workspace = join(profile, 'pnpm-workspace.yaml')
    const config = await readFile(workspace, 'utf8')
    assert.doesNotMatch(config, /^allowBuilds:/m)
    await writeFile(workspace, `${config}\nallowBuilds:\n  ${JSON.stringify(key)}: true\n`)
    run('dsh', installArgs)
  }
  console.log('Installed plugin into a fresh profile')
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-a2a'])
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-a2a'))

  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  env.A2A_PORT = String(reservation.address().port)
  await new Promise((done) => reservation.close(done))
  child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stopped = once(child, 'close')
  let output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      output += data.toString()
    })
  }
  let ready = false
  let lastProbeError
  for (let attempt = 0; attempt < 120; attempt += 1) {
    assert.equal(child.exitCode, null, 'Harness exited before plugin activation')
    const webUrl = output.match(/dsh web: (http:\/\/\S+)/)?.[1]
    if (webUrl) {
      const url = new URL(webUrl)
      try {
        const card = await fetch(`http://127.0.0.1:${env.A2A_PORT}/.well-known/agent-card.json`, {
          signal: AbortSignal.timeout(1000),
        })
        assert.equal(card.status, 200, 'Agent Card HTTP status')
        assert.equal((await card.json()).name, 'dsh-a2a')
        const login = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(1000),
        })
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ')
        assert.ok(cookie, 'Harness browser session cookie')
        const headers = { Cookie: cookie }
        const page = await fetch(new URL('/', url), {
          headers,
          signal: AbortSignal.timeout(1000),
        })
        const html = await page.text()
        const bootJson = html.match(/globalThis\["__DSH_BOOT__"\] = (.+?);?<\/script>/)?.[1]
        assert.ok(
          bootJson,
          `Harness boot manifest (HTTP ${page.status}): ${html.match(/.{0,40}__DSH_BOOT__.{0,70}/)?.[0] ?? html.match(/<title>(.*?)<\/title>/)?.[1] ?? 'no title'}`,
        )
        const graph = JSON.parse(bootJson)
        const entry = graph.entries.find((item) => item.id === 'dsh-a2a')
        assert.ok(entry, 'A2A browser entry')
        for (const dependency of entry.inject ?? []) {
          assert.ok(
            graph.entries.some((item) => item.id === dependency),
            dependency,
          )
        }
        const client = await fetch(new URL(entry.url, url), {
          headers,
          signal: AbortSignal.timeout(1000),
        })
        assert.equal(client.status, 200, 'Browser bundle HTTP status')
        assert.match(await client.text(), /dsh-a2a/)
        ready = true
        break
      } catch (error) {
        lastProbeError = error
        if (attempt === 20) console.log(`Waiting for plugin: ${error.message}`)
        // Startup can publish the web URL before the plugin listener is ready.
      }
    }
    await delay(250)
  }
  assert.ok(
    ready,
    `${lastProbeError ?? 'No web URL'}\n${output.replace(/token=[^\s&]+/g, 'token=[redacted]')}`,
  )
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find package|failed to start/i)
  console.log('PASS: fresh profile install, Agent Card, and browser bundle on dsh 0.1.7-rc.2')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await stopped
    clearTimeout(timer)
  }
  await rm(home, { recursive: true, force: true })
}
