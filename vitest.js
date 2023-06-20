import { createVitest } from 'vitest/node'
import process from 'node:process'

const vitest = await createVitest('test', {
  include: [`tests/gc.test.ts`],
  globals: true,
  watch: process.argv.includes('--watch'),
})

await vitest.start()
