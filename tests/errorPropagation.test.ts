import { Effect, flushSync } from '../src/effect'
import { Computation } from '../src/core'

it('should propagate errors through memos', () => {
  const m = new Computation(undefined, () => {
    throw new Error('test')
  })
  const c = new Computation(undefined, () => {
    return m.read()
  })
  expect(() => c.read()).toThrowError('test')
})

it('should recover from errors', () => {
  const errorThrower = vi.fn(() => {
    throw new Error('test')
  })
  const s = new Computation(1, null)
  const m = new Computation(undefined, () => {
    if (s.read() === 1) errorThrower()
    else return 2
  })
  const c = new Computation(undefined, () => {
    return m.read()
  })
  expect(() => c.read()).toThrowError('test')
  s.write(2)
  expect(() => c.read()).not.toThrow()
})

it('should subscribe to errors', () => {
  const errorThrower = vi.fn(() => {
    throw new Error('test')
  })
  const s = new Computation(false, null)
  const m = new Computation(undefined, () => {
    if (s.read()) errorThrower()
    else return 2
  })
  let errored = false
  new Effect(undefined, () => {
    errored = m.error()
  })
  flushSync()
  expect(errored).toBe(false)
  s.write(true)
  flushSync()
  expect(errored).toBe(true)
})
