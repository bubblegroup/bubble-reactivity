import {
  catchError,
  createEffect,
  createRoot,
  createSignal,
  flushSync,
} from '../src'

it('should let errors bubble up when not handled', () => {
  const error = new Error()
  expect(() => {
    createRoot(() => {
      createEffect(() => {
        throw error
      })
    })
    flushSync()
  }).toThrowError(error)
})

it('should handle error', () => {
  const error = new Error()
  const handler = vi.fn()

  catchError(() => {
    throw error
  }, handler)

  expect(handler).toHaveBeenCalledWith(error)
})

it('should forward error to another handler', () => {
  const error = new Error()
  const rootHandler = vi.fn()

  const [$x, setX] = createSignal(0)

  catchError(() => {
    createEffect(() => {
      $x()
      catchError(
        () => {
          throw error
        },
        (e) => {
          expect(e).toBe(error)
          throw e
        }
      )
    })
  }, rootHandler)

  flushSync()
  expect(rootHandler).toHaveBeenCalledWith(error)

  setX(1)
  flushSync()
  expect(rootHandler).toHaveBeenCalledTimes(2)
})

it('should not duplicate error handler', () => {
  const error = new Error()
  const handler = vi.fn()

  const [$x, setX] = createSignal(0)
  let shouldThrow = false

  createEffect(() => {
    $x()
    catchError(() => {
      if (shouldThrow) throw error
    }, handler)
  })

  setX(1)
  flushSync()

  shouldThrow = true
  setX(2)
  flushSync()
  expect(handler).toHaveBeenCalledTimes(1)
})

it('should not trigger wrong handler', () => {
  const error = new Error()
  const rootHandler = vi.fn()
  const handler = vi.fn()

  const [$x, setX] = createSignal(0)
  let shouldThrow = false

  createRoot(() => {
    catchError(() => {
      createEffect(() => {
        $x()
        if (shouldThrow) throw error
      })

      createEffect(() => {
        catchError(() => {
          // no-op
        }, handler)
      })
    }, rootHandler)
  })

  flushSync()
  shouldThrow = true
  setX(1)
  flushSync()

  expect(rootHandler).toHaveBeenCalledWith(error)
  expect(handler).not.toHaveBeenCalledWith(error)
})
