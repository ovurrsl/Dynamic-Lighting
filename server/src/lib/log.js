/**
 * Minimal structured logger.
 *
 * One JSON object per line, straight to stdout, which is what the host
 * captures. Pino was measured as part of Fastify's ~107 ms import cost; on a
 * process that restarts on every idle request, paying that for log formatting
 * is the wrong trade at this traffic level.
 *
 * Structured rather than pretty on purpose: these logs are read when a customer
 * reports that activation failed, and grepping for a licence key matters more
 * than colour.
 */
const LEVELS = { silent: 100, error: 50, warn: 40, info: 30, debug: 20 }

export function createLogger ({ level = 'info', write = (line) => process.stdout.write(line) } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  const emit = (levelName, fields, message) => {
    if (LEVELS[levelName] < threshold) return
    write(`${JSON.stringify({
      level: levelName,
      time: new Date().toISOString(),
      msg: message,
      ...fields
    })}\n`)
  }

  // Accepts either (message) or (fields, message), matching the shape most Node
  // loggers use so call sites do not have to think about it.
  const method = (levelName) => (first, second) =>
    (typeof first === 'string'
      ? emit(levelName, {}, first)
      : emit(levelName, first ?? {}, second ?? ''))

  return {
    level,
    error: method('error'),
    warn: method('warn'),
    info: method('info'),
    debug: method('debug')
  }
}
