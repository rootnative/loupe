import { describe, expect, it } from 'vitest'
import { localFetch } from './context'

describe('localFetch', () => {
  it.each([
    'https://example.com/',
    'http://192.168.1.5:8081/status',
    'https://abc-anonymous-8081.exp.direct/index.bundle',
  ])('refuses %s: loupe calls only this machine', async (url) => {
    await expect(localFetch(url)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining(new URL(url).host),
    })
  })
})
