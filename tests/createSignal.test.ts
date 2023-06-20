import { createSignal, flushSync } from '../src'

afterEach(() => flushSync())

it('should store and return value on read', () => {
  const [$x] = createSignal(1)
  expect($x).toBeInstanceOf(Function)
  expect($x()).toBe(1)
})

it('should update signal via setter', () => {
  const [$x, setX] = createSignal(1)
  setX(2)
  expect($x()).toBe(2)
})

it('should accept equals option', () => {
  const [$x, setX] = createSignal(1, {
    // Skip even numbers.
    equals: (prev, next) => prev + 1 === next,
  })

  setX(11)
  expect($x()).toBe(11)

  setX(12)
  expect($x()).toBe(11)

  setX(13)
  expect($x()).toBe(13)

  setX(14)
  expect($x()).toBe(13)
})
