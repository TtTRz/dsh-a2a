import { createServer } from 'node:net'

/** Grab a free TCP port by binding 0 briefly and releasing it. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind a free port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
