'use strict'

const shimmer = require('shimmer')

let apm
let apmb
let cls
let log
let Event
let Span

let dbBind
let dbInfo
let dbSettingsError

const udp = process.env.SW_APM_REPORTER === 'udp'

module.exports = function (agent) {
  apm = agent
  apmb = apm.addon
  cls = apm.cls
  log = apm.loggers

  // define the properties (some of which are part of the API)
  definePropertiesOn(apm)

  // create the debounced loggers
  dbBind = new log.Debounce('bind')
  dbInfo = new log.Debounce('info')
  dbSettingsError = new log.Debounce('error')

  // keep weakmap references in a central place.
  apm.maps.responseIsPatched = responseIsPatched
  apm.maps.responseFinalizers = responseFinalizers

  // each invocation in lambda is counted
  // use property check that does not trigger node 14 warning on
  // non-existent property in unfinished module.exports
  if (Object.prototype.hasOwnProperty.call(apm, 'lambda')) {
    apm.lambda.invocations = 0
  }

  // make these globally available.
  Event = require('./event')
  Span = require('./span')
  const Metrics = require('./metrics')

  // return the API
  return {
    // core classes
    Event,
    Span,
    Metrics,

    // basic functions
    readyToSample,
    getTraceSettings,
    sampling,
    traceToEvent,

    // emitter (http) instrumentation
    patchResponse,
    addResponseFinalizer,
    instrumentHttp,

    // non-emitter instrumentation
    instrument,
    pInstrument,
    startOrContinueTrace,
    pStartOrContinueTrace,

    // miscellaneous
    reportError,
    reportInfo,
    sendMetrics,

    // log instrumentation
    getTraceObjectForLog,
    getTraceStringForLog,

    // lambda
    wrapLambdaHandler // wrap user handler
  }
}

//
// Abstract settings with setters and getters
//
let traceMode
let sampleRate

function definePropertiesOn (apm) {
  /**
   * Get and set the trace mode
   *
   * @name apm.traceMode
   * @property {string} - the sample mode
   */
  Object.defineProperty(apm, 'traceMode', {
    get () { return apm.modeToStringMap[traceMode] },
    set (value) {
      if (!(value in apm.modeMap)) {
        log.error('invalid traceMode', value)
        return
      }
      log.info('setting traceMode to ' + value)
      value = apm.modeMap[value]
      apmb.Settings.setTracingMode(value)
      traceMode = value
    }
  })

  /**
   * @ignore
   * Get and set the sample rate. The number is parts of 1,000,000
   * so 100,000 represents a 10% sample rate.
   *
   * @name apm.sampleRate
   * @property {number} - this value divided by 1000000 is the sample rate.
   */
  Object.defineProperty(apm, 'sampleRate', {
    get () { return sampleRate },
    set (value) {
      log.info('set sample rate to ' + value)
      const rateUsed = apmb.Settings.setDefaultSampleRate(value)
      if (rateUsed !== value && value !== -1) {
        if (rateUsed === -1) {
          // value was not a valid number, don't use it
          log.warn('Invalid sample rate: %s, not changed', value)
          return
        }
        //
        log.warn('Sample rate (%s) out of range, using %s', value, rateUsed)
      }
      sampleRate = rateUsed
    }
  })

  /**
   * Return whether or not the current code path is being traced.
   *
   * @name apm.tracing
   * @property {boolean}
   * @readOnly
   */
  Object.defineProperty(apm, 'tracing', {
    get () { return !!apm.lastEvent }
  })

  /**
   * Get X-Trace ID of the last event
   *
   * @name apm.traceId
   * @property {string} - the trace ID as a string or undefined if not tracing.
   * @readOnly
   */
  Object.defineProperty(apm, 'traceId', {
    get () {
      const last = apm.lastEvent
      if (last) return last.toString()
    }
  })

  const asyncHooks = require('async_hooks')
  Object.defineProperty(apm, 'lastEvent', {
    get () {
      let last
      try {
        last = apm.requestStore.get('lastEvent')
      } catch (e) {
        // avoid logging during node bootstrap phase. https://nodejs.org/api/async_hooks.html.
        if (asyncHooks.executionAsyncId() !== 1) {
          log.error('Cannot get lastEvent. Context may be lost.')
        }
      }
      return last
    },
    set (value) {
      try {
        apm.requestStore.set('lastEvent', value)
      } catch (e) {
        log.error('Can not set lastEvent. Context may be lost.')
      }
    }
  })

  Object.defineProperty(apm, 'lastSpan', {
    get () {
      let last
      try {
        last = apm.requestStore.get('lastSpan')
      } catch (e) {
        // avoid logging during node bootstrap phase. https://nodejs.org/api/async_hooks.html.
        if (asyncHooks.executionAsyncId() !== 1) {
          log.error('Cannot get lastSpan. Context may be lost.')
        }
      }
      return last
    },
    set (value) {
      try {
        apm.requestStore.set('lastSpan', value)
      } catch (e) {
        log.error('Can not set lastSpan. Context may be lost.')
      }
    }
  })

  const maps = Object.create(null)
  Object.defineProperty(apm, 'maps', {
    get () { return maps }
  })

  // this being defined is shorthand for being executed in a lambda environment.
  if (apm.execEnv.id === 'lambda') {
    const lambda = {}
    Object.defineProperty(apm, 'lambda', {
      get () { return lambda }
    })
  }

  //
  // maintain context through asynchronous callback chains. this is derived
  // from jeff-lewis' cls-hooked which was derived from forrest norvell's
  // continuation-local-storage.
  //
  const contextName = 'apm-cls-context'
  const clsOpts = { captureHooks: false }

  let aceContext
  Object.defineProperty(apm, 'requestStore', {
    get () {
      if (aceContext) {
        return aceContext
      }
      return (aceContext = cls.createNamespace(contextName, clsOpts))
    }
  })

  apm.resetRequestStore = function resetRequestStore (options) {
    cls.destroyNamespace(contextName)
    aceContext = cls.createNamespace(contextName, options || clsOpts)
  }

  apm.clsCheck = function clsCheck (msg) {
    const c = apm.requestStore
    const ok = c && c.active
    if (msg) {
      log.debug('CLS%s %s', ok ? '' : ' NOT ACTIVE', msg)
    }
    return ok
  }

  //
  // apm.stack - generate a stack trace with the call to this function removed
  //
  // text - used as Error(text)
  // n - the depth of the stack trace to generate.
  //
  apm.stack = function stack (text, n) {
    const original = Error.stackTraceLimit
    // increase the stackTraceLimit by one so this function call
    // can be removed.
    if (!n) {
      n = Error.stackTraceLimit
    }
    Error.stackTraceLimit = n + 1

    const e = new Error(text)
    const stackLines = e.stack.split('\n')

    Error.stackTraceLimit = original
    // remove the call to this function
    return [stackLines[0]].concat(stackLines.slice(2)).join('\n')
  }

  /**
   * Generate a backtrace string
   *
   * @method apm.backtrace
   * @returns {string} the backtrace
   */
  apm.backtrace = function backtrace () {
    const e = new Error('backtrace')
    return e.stack.replace(/[^\n]*\n\s+/, '').replace(/\n\s*/g, '\n')
  }

  /**
   * Bind a function to the CLS context if tracing.
   *
   * @method apm.bind
   * @param {function} fn - The function to bind to the context
   * @return {function} The bound function or the unmodified argument if it can't
   *   be bound.
   */
  apm.bind = function bind (fn) {
    try {
      if (apm.tracing && typeof fn === 'function') {
        return apm.requestStore.bind(fn)
      }

      const name = fn ? fn.name : 'anonymous'
      // it's not quite right so issure diagnostic message
      if (!apm.clsCheck()) {
        const e = new Error('CLS NOT ACTIVE')
        log.bind('apm.bind(%s) - no context', name, e.stack)
      } else if (!apm.tracing) {
        log.bind('apm.bind(%s) - not tracing', name)
      } else if (fn !== undefined) {
        const e = new Error('Not a function')
        log.bind('apm.bind(%s) - not a function', fn, e.stack)
      }
    } catch (e) {
      log.error('failed to bind callback', e.stack)
    }

    // return the caller's argument no matter what.
    return fn
  }

  /**
   * Bind an emitter if tracing
   *
   * @method apm.bindEmitter
   * @param {EventEmitter} em The emitter to bind to the trace context
   * @return {EventEmitter} The bound emitter or the original emitter if an error.
   */
  apm.bindEmitter = function bindEmitter (em) {
    let emitter = false
    try {
      if (em && typeof em.on === 'function') {
        emitter = true
        // allow binding if tracing. no last event has been setup when the
        // http instrumentation binds the events but there must be CLS context.
        if (apm.tracing || apm.clsCheck()) {
          apm.requestStore.bindEmitter(em)
          return em
        }
      }

      const e = new Error('CLS NOT ACTIVE')
      if (!apm.clsCheck()) {
        dbBind.log('apm.bindEmitter - no context', e.stack)
      } else if (!apm.tracing) {
        dbInfo.log('apm.bindEmitter - not tracing')
      } else if (!emitter) {
        dbBind.log('apm.bindEmitter - non-emitter', e.stack)
      } else {
        dbBind.log('apm.bindEmitter - couldn\'t bind emitter')
      }
    } catch (e) {
      log.error('failed to bind emitter', e.stack)
    }

    // return the original if it couldn't be bound for any reason.
    return em
  }

  /**
   * Set a custom transaction name function for a specific probe. This is
   * most commonly used when setting custom names for all or most routes.
   *
   * @method apm.setCustomTxNameFunction
   * @param {string} probe - The probe to set the function for
   * @param {function} fn - A function that returns a string custom name or a
   *                        falsey value indicating the default should be used.
   *                        Pass a falsey value for the function to clear.
   * @returns {boolean} true if successfully set else false
   *
   * @example
   * // custom transaction function signatures for supported probes:
   * express: customFunction (req, res)
   * hapi/hapi: customFunction (request)
   */
  apm.setCustomTxNameFunction = function setCustomTxNameFunction (probe, fn) {
    // if the probe exists set the function and return success
    if (probe in apm.probes && typeof fn === 'function') {
      apm.probes[probe].customNameFunc = fn
      return true
    }
    // return failure
    return false
  }

  apm.wrappedFlag = Symbol('apm-wrapped')
}

//= ===================================================================================
// none of the following can be invoked before the initialization function is called
// and sets apm.
//= ===================================================================================

/**
 * Check whether the agent is ready to sample. It will wait up to
 * the specified number of milliseconds before returning.
 * @method apm.readyToSample
 * @param {Number} ms - milliseconds to wait; default 0 means don't wait (poll).
 * @param {Object} [obj] - if present obj.status will receive low level status
 * @returns {boolean} - true if ready to sample; false if not
 */
/**
 * @ignore
 * UNKNOWN 0
 * OK 1
 * TRY_LATER 2
 * LIMIT_EXCEEDED 3
 * unused (was INVALID_API_KEY) 4
 * CONNECT_ERROR 5
 */
function readyToSample (ms, obj) {
  const status = apmb.isReadyToSample(ms)
  // if the caller wants the actual status provide it
  if (obj && typeof obj === 'object') {
    obj.status = status
  }

  return status === 1
}

/**
 * @typedef {object} TraceSettings
 * @property {boolean} doSample - the sample decision
 * @property {boolean} doMetrics - the metrics decision
 * @property {Event} traceTaskId - the parent event to get task id from
 * @property {boolean} edge - true to edge back to parent op id
 * @property {number} source - the sample decision source
 * @property {number} rate - the sample rate used
 * @property {number} mode - local mode to use for decision
 * @property {boolean} ttRequested - trigger trace requested
 * @property {string} ttOptions - X-Trace-Options header value
 * @property {string} ttSignature - X-Trace-Options-Signature header value
 * @property {integer} ttTimestamp - UNIX timestamp value from X-Trace-Options
 */

/**
 * make an alias for what will become the new oboe sample call.
 *
 * @ignore
 * @method apm.getTraceSettings
 * @param {string} traceparent
 * @param {string} tracestate
 * @param {number} [localMode=undefined]
 * @returns {TraceSettings} settings
 */
function getTraceSettings (traceparent, tracestate, options = {}) {
  // note: with liboboe 10.3.0 the api has changed to work with a traceparnet/tracestate duo insted of xtrace.
  // liboobe still uses the term xtrace in keys (and thus so do the bindings) even though
  // the format is now that of traceparnet (dash delimited).
  // put traceparent value into xtrace key
  let settings = { xtrace: traceparent, tracestate }

  // maintain backward compatibility for any custom instrumentation users.
  if (typeof options === 'number') {
    settings.mode = options
  }

  // add options but don't allow an x-trace to be specified in options.
  settings = Object.assign(options, settings)

  let osettings = apmb.Settings.getTraceSettings(settings)

  // handle this for testing as oboe doesn't set doMetrics under the UDP
  // protocol.
  if (udp) {
    osettings.doMetrics = osettings.doSample
  }
  // capture the inbound x-trace.
  osettings.inboundXtrace = settings.xtrace

  // record this for debugging purposes
  apm.lastSettings = osettings

  if (osettings.status > 0) {
    dbSettingsError.log(`getTraceSettings() - ${osettings.message}(${osettings.status})`)
    // if an error it's not clear which properties will be set. make sure values exist.
    osettings = Object.assign({
      doSample: false,
      doMetrics: false,
      source: 5,
      rate: 0,
      edge: false,
      metadata: apmb.Event.makeRandom(0)
    }, osettings)
    // if getTraceSettings() failed then don't count the x-trace even if it was valid.
    osettings.inboundXtrace = false
  }

  // compatibility across bindings versions
  if (!('traceTaskId' in osettings)) {
    osettings.traceTaskId = osettings.metadata
  }

  return osettings
}

/**
 * Determine if the sample flag is set for the various forms of
 *  data.
 *
 * @method apm.sampling
 * @param {string|Event|addon.Event} item - the item to get the sampling flag of
 * @returns {boolean} - true if the sample flag is set else false.
 */

function sampling (item) {
  if (typeof item === 'string' && (item.length === 55)) {
    return item[item.length - 1] === '1'
  }

  if (item instanceof Event) {
    return item.event.getSampleFlag()
  }

  if (item instanceof apmb.Event) {
    return item.getSampleFlag()
  }

  throw new Error('Sampling called with ' + item)
}

/**
 * Convert an traceparent ID to an event containing the task ID and op ID.
 *
 * @method apm.traceToEvent
 * @param {string} traceparent - traceparent ID
 * @return {addon.Event|undefined} - addon.Event object
 *                                      containing an internal
 *                                      format of the traceparent
 *                                      if valid or undefined
 *                                      if not.
 */
function traceToEvent (traceparent) {
  return apmb.Event.makeFromString(traceparent)
}

/**
 * Patch an HTTP response object to trigger apm-response-end events
 *
 * @ignore
 * @method apm.patchResponse
 * @param {HTTPResponse} res HTTP Response object
 */
const responseIsPatched = new WeakMap()

function patchResponse (res) {
  if (!responseIsPatched.get(res)) {
    responseIsPatched.set(res, true)
    shimmer.wrap(res, 'end', fn => function () {
      // Find and run finalizers
      const finalizers = responseFinalizers.get(res) || []
      finalizers.reverse().forEach(finalizer => finalizer())

      // Cleanup after ourselves
      responseFinalizers.delete(res)
      responseIsPatched.delete(res)

      // Run the real end function
      return fn.apply(this, arguments)
    })
  }
}

/**
 * Add a finalizer to trigger when the response ends
 *
 * @ignore
 * @method apm.addResponseFinalizer
 * @param {HTTPResponse} res - HTTP Response to attach a finalizer to
 * @param {function} finalizer - Finalization function
 */
const responseFinalizers = new WeakMap()

function addResponseFinalizer (res, finalizer) {
  const finalizers = responseFinalizers.get(res)
  finalizers
    ? finalizers.push(finalizer)
    : responseFinalizers.set(res, [finalizer])
}

/**
 * @typedef {object} spanInfo
 * @property {string} name - the name for the span
 * @property {object} [kvpairs] - kvpairs to add to the span
 * @property {function} [finalize] - callback receiving created span
 */

/**
 * @typedef {function} spanInfoFunction
 * @returns {spanInfo}
 */

/**
 * Instrument HTTP request/response
 *
 * @method apm.instrumentHttp
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} run - code to instrument and run
 * @param {object} [options] - options
 * @param {object} [options.enabled] - enable tracing, on by default
 * @param {object} [options.collectBacktraces] - collect backtraces
 * @param {HTTPResponse} res - HTTP response to patch
 * @returns the value returned by the run function or undefined if it can't be run.
 */
function instrumentHttp (build, run, options, res) {
  // If not tracing, skip
  const last = apm.lastSpan
  if (!last) {
    apm.loggers.warn('instrumentHttp: no last span')
    return run()
  }
  if ('enabled' in options && !options.enabled) {
    apm.loggers.info('instrumentHttp: disabled by option')
    return run()
  }

  patchResponse(res)

  let span
  try {
    let name = build
    let kvpairs = {}
    let finalize
    // Build span
    if (typeof build === 'function') {
      const spanInfo = build()
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs || {}
      finalize = spanInfo.finalize
    }

    // attach backtrace if this trace is sampled and configured.
    if (options.collectBacktraces && last.doSample) {
      kvpairs.Backtrace = apm.backtrace(4)
    }
    span = last.descend(name, kvpairs)

    if (finalize) {
      finalize(span, last)
    }
  } catch (e) {
    apm.loggers.error('instrumentHttp failed to build span %s', e.stack)
  }

  let ctx
  try {
    if (span && span.topSpan) {
      ctx = apm.requestStore.createContext()
      apm.requestStore.enter(ctx)
    }
  } catch (e) {
    apm.loggers.error('instrumentHttp failed to enter span %l', span)
  }

  if (span) {
    span.enter()
    apm.addResponseFinalizer(res, apm.bind(() => {
      span.exit()
      try {
        if (ctx) {
          apm.requestStore.exit(ctx)
        } else if (span.topSpan) {
          apm.loggers.error('no context for topSpan')
        }
      } catch (e) {
        apm.loggers.error('instrumentHttp failed to exit span %l', span)
      }
    }))
  }

  try {
    return run.call(span)
  } catch (err) {
    if (span) span.setExitError(err)
    throw err
  }
}

/**
 * Apply custom instrumentation to a synchronous or async-callback function.
 *
 * @method apm.instrument
 * @param {string|spanInfoFunction} span - span name or span-info function
 *     If `span` is a string then a span is created with that name. If it
 *     is a function it will be run only if tracing; it must return a
 *     spanInfo-compatible object - see instrumenting-a-module.md in guides/.
 * @param {function} run - the function to instrument<br/><br/>
 *     Synchronous `run` function:<br/>
 *     the signature has no callback, e.g., `function run () {...}`. If a
 *     synchronous `run` function throws an error agent will report that
 *     error for the span and re-throw the error.<br/>
 *     <br/>
 *     Asynchronous `run` function:<br/>
 *     the signature must include a done callback that is used to let
 *     agent know when your instrumented async code is done running,
 *     e.g., `function run (done) {...}`. In order to report an error for
 *     an async span the done function must be called with an Error object
 *     as the argument.
 * @param {object} [options] - options
 * @param {boolean} [options.enabled=true] - enable tracing
 * @param {boolean} [options.collectBacktraces=false] - collect stack traces.
 * @param {function} [callback] - optional callback, if async
 * @returns {value} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * //
 * // A synchronous `run` function.
 * //
 * //   If the run function is synchronous the signature does not include
 * //   a callback, e.g., `function run () {...}`.
 * //
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * function run () {
 *   const contents = fs.readFileSync('some-file', 'utf8')
 *   // do things with contents
 * }
 *
 * apm.instrument(spanInfo, run)
 *
 * @example
 * //
 * // An asynchronous `run` function.
 * //
 * // Rather than callback directly, you give the done argument.
 * // This tells the agent when your instrumented code is done running.
 * //
 * // The `callback` function is the callback you normally would have given
 * // directly to the code you want to instrument. It receives the same
 * // arguments as were received by the `done` callback for the `run` function
 * // and the same `this` context is also applied to it.
 *
 * function spanInfo () {
 *   return {name: 'custom', {Foo: 'bar'}}
 * }
 *
 * function run (done) {
 *   fs.readFile('some-file', done)
 * }
 *
 * function callback (err, data) {
 *   console.log('file contents are: ' + data)
 * }
 *
 * apm.instrument(spanInfo, run, callback)
 */
function instrument (span, run, options, callback) {
  // Verify that a run function is given
  if (typeof run !== 'function') {
    apm.loggers.error(`apm.instrument() run function is ${typeof run}`)
    return
  }

  // Normalize dynamic arguments
  try {
    if (typeof options === 'function') {
      callback = options
      options = { enabled: true }
    } else {
      if (typeof options !== 'object') {
        if (options !== undefined) {
          apm.loggers.warn(`apm.instrument() options is ${typeof options}`)
        }
        options = {}
      }
      // default enabled to true if not explicitly false
      options = Object.assign({ enabled: true }, options)
    }

    if (!callback && run.length) {
      callback = function () {}
    }
  } catch (e) {
    apm.loggers.error('apm.instrument failed to normalize arguments', e.stack)
  }

  // in startup mode run the callback as is.
  // during startup fs probe will read multiple files of included packages
  // there is no last span for that and it should not be instrumented
  if (apm.startup) {
    return run(callback)
  }

  // If not tracing, there is some error, skip.
  const last = apm.lastSpan
  if (!last) {
    apm.loggers.info('apm.instrument found no lastSpan')
    return run(callback)
  }

  // If not enabled, skip but maintain context
  if (!options.enabled) {
    apm.loggers.info('apm.instrument disabled by option')
    return run(apm.bind(callback))
  }

  return runInstrument(last, span, run, options, callback)
}

/**
 * Apply custom instrumentation to a promise-returning asynchronous function.
 *
 * @method apm.pInstrument
 * @param {string|spanInfoFunction} span - span name or span-info function
 *     If `span` is a string then a span is created with that name. If it
 *     is a function it will be run only if tracing; it must return a
 *     spanInfo-compatible object - see instrumenting-a-module.md in guides/.
 * @param {function} run - the function to instrument<br/><br/>
 *     This function must return a promise.
 * @param {object} [options] - options
 * @param {boolean} [options.enabled=true] - enable tracing
 * @param {boolean} [options.collectBacktraces=false] - collect stack traces.
 * @returns {Promise} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * //
 * // A synchronous `run` function.
 * //
 * //   If the run function is synchronous the signature does not include
 * //   a callback, e.g., `function run () {...}`.
 * //
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * function run () {
 *   return axios.get('https://google.com').then(r => {
 *     ...
 *     return r;
 *   })
 * }
 *
 * apm.pInstrument(spanInfo, run).then(...)
 */
function pInstrument (name, task, options = {}) {
  if (typeof task !== 'function') {
    return instrument(...arguments)
  }

  const wrapped = cb => {
    const p = task()
    if (!p || !p.then) {
      cb()
      return p
    }
    return p.then(r => {
      cb()
      return r
    }).catch(e => {
      cb(e)
      throw e
    })
  }

  // this needs to appear async to apm.instrument, so wrapped supplies a callback. but
  // this code doesn't have a callback because the resolution of the promise is what
  // signals the task function's completion, so no 4th argument is supplied.
  //
  // apm.instrument returns wrapped()'s value which is the original promise
  // that task() returns. the resolution of the promise is the value that
  // task() resolved the promise with or a thrown error. the point of
  // wrapped() is to make the callback that results in exiting the the span before
  // resolving the promise.
  return instrument(name, wrapped, options)
}

//
// This builds a span descending from the supplied span using the apm.instrument's arguments
//
function runInstrument (last, make, run, options, callback) {
  // Verify that a name or span-info function is given
  if (!~['function', 'string'].indexOf(typeof make)) {
    apm.loggers.error('apm.runInstrument found no span name or span-info()')
    return run(callback)
  }

  // Build span. Because last must exist this function cannot be used
  // for a topSpan.
  let span
  try {
    let name = make
    let kvpairs = {}
    let finalize
    if (typeof make === 'function') {
      const spanInfo = make(last)
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs
      finalize = spanInfo.finalize
    }
    if (name) {
      span = last.descend(name, kvpairs)
    } else {
      const msg = typeof make === 'function' ? ' by span-info()' : ''
      apm.loggers.error(`no name supplied to runInstrument${msg}`)
    }

    if (finalize) {
      finalize(span, last)
    }
  } catch (e) {
    apm.loggers.error('apm.runInstrument failed to build span', e.stack)
  }

  // run span
  return runSpan(span, run, options, callback)
}

//
// Set backtrace, if configured to do so, and run already constructed span
//
function runSpan (span, run, options, callback) {
  if (!span) {
    return run(callback)
  }

  // Attach backtrace if sampling and enabled.
  if (span.doSample && options.collectBacktraces) {
    span.events.entry.set({ Backtrace: apm.backtrace() })
  }

  // Detect if sync or async, and run span appropriately
  if (callback) {
    return span.runAsync(makeWrappedRunner(run, callback))
  }
  return span.runSync(run)
}

// This makes a callback-wrapping span runner
function makeWrappedRunner (run, callback) {
  return wrap => run(wrap(callback))
}

/**
 * Start or continue a trace. Continue is in the sense of continuing a
 * trace based on an X-Trace ID received from an external source, e.g.,
 * HTTP headers or message queue headers.
 *
 * @method apm.startOrContinueTrace
 * @param {string} traceparent - traceparent ID to continue from or null
 * @param {string} tracestate - tracestate ID to continue from or null
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} runner - run this function. sync if no arguments, async if one.
 * @param {object}  [opts] - options
 * @param {boolean} [opts.enabled=true] - enable tracing
 * @param {boolean} [opts.collectBacktraces=false] - collect backtraces
 * @param {boolean} [opts.forceNewTrace=false] - force a new trace, ignoring any existing context (but not traceparent)
 * @param {string|function} [opts.customTxName] - name or function
 * @param {function} [callback] - this is supplied as the callback if runner is async.
 * @returns {value} the value returned by the run function or undefined if it can't be run
 *
 * @example
 * apm.startOrContinueTrace(
 *   null,
 *   'sync-span-name',
 *   functionToRun,           // synchronous so function takes no arguments
 *   {customTxName: 'special-span-name'}
 * )
 * @example
 * apm.startOrContinueTrace(
 *   null,
 *   'sync-span-name',
 *   functionToRun,
 *   // note - no context is provided for the customTxName function. If
 *   // context is required the caller should wrap the function in a closure.
 *   {customTxName: customNameFunction}
 * )
 * @example
 * // this is the function that should be instrumented
 * request('https://www.google.com', function realCallback (err, res, body) {...})
 * // because asyncFunctionToRun only accepts one parameter it must be
 * // wrapped, so the function to run becomes
 * function asyncFunctionToRun (cb) {
 *   request('https://www.google.com', cb)
 * }
 * // and realCallback is supplied as the optional callback parameter
 *
 * apm.startOrContinueTrace(
 *   null,
 *   'async-span-name',
 *   asyncFunctionToRun,     // async, so function takes one argument
 *   // no options this time
 *   realCallback            // receives request's callback arguments.
 * )
 */
function startOrContinueTrace (traceparent, tracestate, build, run, opts, cb) {
  // Verify that a run function is given
  if (typeof run !== 'function') return

  try {
    if (typeof opts !== 'object') {
      cb = opts
      opts = { enabled: true }
    } else {
      // default enabled to true if not explicitly false
      opts = Object.assign({ enabled: true }, opts)
    }

    if (!cb && run.length) {
      cb = function () {}
    }
  } catch (e) {
    apm.loggers.error('apm.startOrContinueTrace can\'t normalize arguments', e.stack)
  }

  // verify that a span name or span-info function is provided. it is called
  // build for historical reasons.
  if (!~['function', 'string'].indexOf(typeof build)) {
    return run(cb)
  }

  // If not enabled, skip
  if (!opts.enabled) {
    return run(apm.bind(cb))
  }

  // If already tracing, continue the existing trace ignoring any traceparent
  // passed as the first argument, unless forcing a new trace.
  const last = apm.lastSpan
  if (last && !opts.forceNewTrace) {
    return runInstrument(last, build, run, opts, cb)
  }

  // Should this be sampled?
  let settings
  try {
    settings = getTraceSettings(traceparent, tracestate)
  } catch (e) {
    apm.loggers.error('apm.startOrContinueTrace can\'t get a sample decision', e.stack)
    settings = { doSample: false, doMetrics: false, source: 5, rate: 0 }
  }

  let span
  try {
    // try to create the span
    let name = build
    let kvpairs = {}
    let finalize
    if (typeof build === 'function') {
      const spanInfo = build()
      name = spanInfo.name
      kvpairs = spanInfo.kvpairs
      finalize = spanInfo.finalize
    }
    span = Span.makeEntrySpan(name, settings, kvpairs)

    if (finalize) {
      // there is no last span or runInstrument() would already have been called.
      finalize(span)
    }
  } catch (e) {
    apm.loggers.error('apm.startOrContinueTrace failed to build span %s', e.stack)
  }

  // if no span can't do sampling or inbound metrics - need a context.
  if (!span) {
    return run(cb)
  }

  // Add sampling data to entry if there was not already a traceparent id
  if (settings.doSample && !traceparent) {
    span.events.entry.set({
      SampleSource: settings.source,
      SampleRate: settings.rate
    })
  }

  return runSpan(span, run, opts, cb)
}

/**
 * Start or continue a trace running a function that returns a promise. Continue is in
 * the sense of continuing a trace based on an X-Trace ID received from an external
 * source, e.g., HTTP headers or message queue headers.
 *
 * @method apm.pStartOrContinueTrace
 * @param {string} traceparent - traceparent ID to continue from or null
 * @param {string} tracestate - tracestate ID to continue from or null
 * @param {string|spanInfoFunction} span - name or function returning spanInfo
 * @param {function} run - the promise-returning function to instrument
 * @param {object}  [opts] - options
 * @param {boolean} [opts.enabled=true] - enable tracing
 * @param {boolean} [opts.collectBacktraces=false] - collect backtraces
 * @param {boolean} [opts.forceNewTrace=false] - ignore any existing context and force a new trace
 * @param {string|function} [opts.customTxName] - name or function
 *
 * @returns {Promise} the value returned by the run function or undefined if it can't be run
 *
 * @example
 *
 * function spanInfo () {
 *   return {name: 'custom', kvpairs: {Foo: 'bar'}}
 * }
 *
 * // axios returns a promise
 * function functionToRun () {
 *   return axios.get('https://google.com').then(r => {
 *     ...
 *     return r;
 *   })
 * }
 *
 * apm.pStartOrContinueTrace(
 *   null,
 *   spanInfo,
 *   functionToRun,
 * ).then(...)
 */
async function pStartOrContinueTrace (traceparent, tracestate, protoSpan, func, opts) {
  // Verify that a run function is given
  if (typeof func !== 'function') {
    apm.loggers.error(`pStartOrContinueTrace requires a function, not ${typeof func}`)
    return
  }

  opts = Object.assign({ enabled: true }, opts)

  // If not enabled there's nothing to do. the async context should be maintained
  // by node/v8 through the promise execution.
  if (!opts.enabled) {
    return func()
  }

  // If already tracing, continue the existing trace ignoring any traceparent passed as the first
  // argument, unless forcing a new trace. startOrContinueTrace() returns runInstrument() at
  // this point but both logic paths are kept here in this function.
  let last
  if (!opts.forceNewTrace) {
    last = apm.lastSpan
  }

  // get information needed for the span
  let name
  let kvpairs = {}
  let finalize
  if (typeof protoSpan === 'string') {
    name = protoSpan
  } else if (typeof protoSpan === 'function') {
    try {
      // last is defined only if there is a trace in progress AND not forcing a new trace.
      ({ name, kvpairs, finalize } = protoSpan(last))
    } catch (e) {
      apm.loggers.debug(`span-info() failed ${e.message}`)
    }

    const protoSpanErrors = []
    // if (error) {
    //  protoSpanErrors.push(error.message);
    // }
    if (!name || typeof name !== 'string') {
      protoSpanErrors.push('name')
    }
    if (kvpairs && typeof kvpairs !== 'object') {
      protoSpanErrors.push('kvpairs')
    }
    if (finalize && typeof finalize !== 'function') {
      protoSpanErrors.push('finalize function')
    }
    if (protoSpanErrors.length) {
      apm.loggers.error(`pStartOrContinueTrace span-info bad values: ${protoSpanErrors.join(', ')}`)
      return func()
    }
  } else {
    apm.loggers.error(`pStartOrContinueTrace span argument must be a string or function, not ${typeof protoSpan}`)
    return func()
  }

  let span
  let state // allows more specific error message
  try {
    if (last) {
      state = `execute last.descend(${name})`
      span = last.descend(name, kvpairs)
    } else {
      state = 'getTraceSettings()'
      const settings = getTraceSettings(traceparent, tracestate)
      state = 'makeEntrySpan()'
      span = Span.makeEntrySpan(name, settings, kvpairs)
      // Add sampling data to entry if there was not already a traceparent ID
      if (settings.doSample && !traceparent) {
        span.events.entry.set({
          SampleSource: settings.source,
          SampleRate: settings.rate
        })
      }
    }
    state = 'finalize()'
    if (finalize) {
      // note that last will be undefined if there was an x-trace or forceNewTrace is true.
      finalize(span, last)
    }
  } catch (e) {
    apm.loggers.error(`pStartOrContinueTrace failed to ${state}`, e.stack)
    return func()
  }

  // if no span can't do sampling or inbound metrics - need a context. is this possible if nothing in
  // the try block above fails?
  if (!span) {
    apm.loggers.error('pStartOrContinueTrace failed to get a span, not instrumenting')
    return func()
  }

  return span.runPromise(func, opts)
}

/**
 * Report an error event in the current trace.
 *
 * @method apm.reportError
 * @param {Error} error - The error instance to report
 */
function reportError (error) {
  const last = apm.lastSpan
  if (last) last.error(error)
}

/**
 * Report an info event in the current trace.
 *
 * @method apm.reportInfo
 * @param {object} data - Data to report in the info event
 */
function reportInfo (data) {
  const last = apm.lastSpan
  if (last) last.info(data)
}

//
// sendMetric(name, object)
//
// only the first argument is required for an increment call.
//
// name - the name of the metric
// object - an object containing optional parameters
// object.count - the number of observations being reported (default: 1)
// object.addHostTag - boolean - add {host: hostname} to tags.
// object.tags - an object containing {tag: value} pairs.
// object.value - if present this call is a valued-based call and this contains
//                the value, or sum of values if count is greater than 1, being
//                reported.
//
// there are two types of metrics:
//   1) count-based - the number of times something has occurred (no value associated with this metric)
//   2) value-based - a specific value is being reported (or a sum of values)
//
//

/**
 * @typedef {object} metric
 * @property {string} name - name of the metric
 * @property {integer} [count=1] - count of the metric
 * @property {number} [value] - if summary, value or sum of values
 * @property {boolean} [addHostTag=false] - add a hostname tag
 * @property {object} [tags] - key-value pairs that can be used for filtering
 *
 * @property {boolean} [testing=false] - return array of correct metrics in addition
 *     to an array of metrics with errors.
 * @property {boolean} [noop=false] - do not actually send the metrics to the collector
 */

/**
 * @typedef {object} SendMetricsReturn
 * @property {array} errors - an array of metrics for which an error occurred
 * @property {array} [correct] - if globalOption.testing specified the correctly
 *                               processed metrics are returned in this array.
 */

/**
 * Send custom metrics. There are two types of metrics:
 * 1) count-based - the number of times something has occurred (no
 *                  value is associated with this type)
 * 2) value-based - a specific value (or sum of values if count > 1).
 *
 * The metrics submitted are aggregated by metric name and tag(s), then
 * sent every 60 seconds.
 *
 * @method apm.sendMetrics
 * @param {(metric|metric[])} metrics - a metric or an array of metrics
 * @param {object} [gopts] - supply defaults to be applied to each metric.
 * @param {boolean} [gopts.addHostTag=false] - add a hostname tag
 * @param {object} [gopts.tags] - tags to add to each metric. the tags are
 *     added as "metric.tags = Object.assign({}, gopts.tags, metric.tags)"
 *
 * @returns {SendMetricsReturn}
 *
 * @example
 *
 * // send a single metric
 * apm.sendMetrics({name: 'my.counts.basic'});
 * apm.sendMetrics({name: 'my.values.some', value: 42.42});
 *
 * // send multiple metrics (most efficient)
 * apm.sendMetrics([
 *   // default count is 1
 *   {name: 'my.counts.defaulted'},
 *   {name: 'my.counts.multiple', count: 3},
 *   {name: 'my.values.xyzzy', value: 10},
 *   // report two values for which the sum is 25.
 *   {name: 'my.values.xyzzy', count: 2, value: 25}
 * ]);
 *
 * // add tags that can be used for filtering on the host
 * apm.sendMetrics([
 *   {name: 'my.metric.end-of-file', tags: {class: 'error', subsystem: 'fs'}}
 * ]);
 *
 * // add a hostname tag automatically.
 * apm.sendMetrics([
 *   {name: 'my.metric.end-of-file', tags: {class: 'error'}, addHostTag: true}
 * ]);
 *
 * // add a hostname tag and an application tag to each metric.
 * apm.sendMetrics(
 *   [
 *     {name: 'my.metric', tags: {class: 'status'}},
 *     {name: 'my.time', value: 33.3, tags: {class: 'performance'}}
*    ],
 *   {addHostTag: true, tags: {application: 'x'}}
 * );
 *
 * // default class to 'status' for metrics that don't supply a class
 * // tag.
 * apm.sendMetrics(
 *   [
 *     {name: 'my.metric'},
 *     {name: 'my.time', value: 33.3, tags: {class: 'performance'}}
 *   ],
 *   {tags: {class: 'status'}}
 * );
 */
function sendMetrics (metrics, gopts = {}) {
  const addHostTag = gopts.addHostTag
  const globalTags = gopts.tags

  if (!Array.isArray(metrics)) {
    metrics = [metrics]
  }

  // merge global options into individual metrics
  const merged = []
  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i]

    const metric = Object.assign({ addHostTag }, m)
    metric.tags = Object.assign({}, globalTags, m.tags)
    merged.push(metric)
  }

  return apmb.Reporter.sendMetrics(merged)
}

/**
 * Return an object representation of the trace containing trace_id, span_id, trace_flags. The primary intended use for this is
 * to insert custom tokens in log packages.
 *
 * @method apm.getTraceObjectForLog
 * @returns {object} - the trace log  object (e.g. { trace_id:..., span_id: ..., trace_flages: ...})

 * @example
 *
 * log4js.addLayout('json', function (config) {
 *   return function (logEvent) {
 *     logEvent.context = { ...logEvent.context, ...apm.getTraceObjectForLog() }
 *     return JSON.stringify(logEvent)
 *   }
 * })

 * log4js.configure({
 *   appenders: {
 *     out: { type: 'stdout', layout: { type: 'json' } }
 *   },
 *   categories: {
 *     default: { appenders: ['out'], level: 'info' }
 *   }
 * })
 * const logger = log4js.getLogger()
 * logger.info('doing something.')
 */
function getTraceObjectForLog () {
  // if truthy and tracing insert it based on sample setting. otherwise if 'always'
  // then insert a trace ID regardless. No explicit check for 'traced' is required.
  let last
  if ((apm.cfg.insertTraceIdsIntoLogs) && (last = apm.lastEvent)) {
    if (apm.cfg.insertTraceIdsIntoLogs !== 'sampledOnly' || last.event.getSampleFlag()) {
      const parts = last.toString().split('-')
      return {
        trace_id: parts[1],
        span_id: parts[2],
        trace_flags: parts[3]
      }
    }
  } else if (apm.cfg.insertTraceIdsIntoLogs === 'always') {
    return {
      trace_id: '0'.repeat(32),
      span_id: '0'.repeat(16),
      trace_flags: '0'.repeat(2)
    }
  }
  return null
}

/**
 * Return text delimited representation of the trace containing trace_id, span_id, trace_flags. The primary intended use for this is
 * to insert custom tokens in log packages.
 *
 * @method apm.getTraceStringForLog
 * @param {string} [delimiter] - the delimiter to use
 *
 * @returns {string} - the trace log string (e.g. trace_id:... span_id: ..., trace_flages: ...)
 *
 * @example
 * log4js.configure({
 *   appenders: {
 *     out: {
 *       type: 'stdout',
 *       layout: {
 *         type: 'pattern',
 *         pattern: '%d %p %c %x{user} says: %m is: %x{trace} %n',
 *         tokens: {
 *           user: function (logEvent) {
 *             return 'Jake'
 *           },
 *           trace: function () {
 *             return typeof apm !=='undefined' ? apm.getTraceStringForLog() : ''
 *           }
 *         }
 *       }
 *     }
 *   },
 *   categories: { default: { appenders: ['out'], level: 'info' } }
 * })
 * const logger = log4js.getLogger()
 * logger.info('token from api')
 */
function getTraceStringForLog (delimiter = ' ') {
  const obj = apm.getTraceObjectForLog()
  return obj ? Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(delimiter) : ''
}

/**
 * Wrap the lambda handler function so it can be traced by AppOptics APM.
 *
 * @method apm.wrapLambdaHandler
 * @param {function} [handler] - wraps your lambda handler function so it
 *                               is instrumented. your handler must return
 *                               a promise, be a JavaScript async function,
 *                               or implement the callback signature.
 * @returns {function} - an async function, wrapping handler, to be used
 *                       instead of handler.
 *
 * @example
 * const apm = require('appoptics-apm');
 *
 * const wrappedHandler = apm.wrapLambdaHandler(myHandler);
 *
 * async function myHandler (event, context) {
 *   // implementation
 *   // ...
 * }
 *
 * // set the handler to the wrapped function.
 * exports.handler = wrappedHandler;
 *
 * @example
 * const apm = require('appoptics-apm');
 *
 * const wrappedHandler = apm.wrapLambdaHandler(myHandler);
 *
 * function myHandler (event, context, callback) {
 *   // implementation
 *   // ...
 *   if (error) {
 *     callback(error);
 *   }
 *
 *   callback(null, result);
 * }
 */
function wrapLambdaHandler (userHandler) {
  if (userHandler[apm.wrappedFlag]) {
    log.debug('already wrapped')
    return userHandler[apm.wrappedFlag]
  }

  const wrappedFunction = async function (event, context) {
    // check enable at execution-time so the enable flag can be turned on/off
    // dynamically. if it was disabled at startup then enabling it won't
    // cause traces because many pieces were not loaded at startup. disabling
    // it will stop traces from starting if it was enabled at startup.
    if (!apm.cfg.enabled || !apm.lambda) {
      log.debug(`not wrapping function: ${apm.cfg.enabled ? 'not in lambda' : 'disabled'}`)
      return userHandler.apply(null, arguments)
    }

    // if event is not an object then we really don't know what to do with it.
    if (typeof event !== 'object') {
      event = Object.create(null)
    }

    const userHandlerName = userHandler.name || 'anonymous'

    let traceparent
    let tracestate
    if (typeof event.headers === 'object') {
      event.headers = lowercaseHeaders(event.headers)
      // try to find an traceparent/tracestate header. if it is valid then the type
      // of request matters because we will insert an traceparent/tracestate header
      // in the response if possible. if there is not a valid traceparent/tracestate
      // header then topSpan is not set to a specific type and no
      // traceparent/tracestate header insertion will take place at span exit.
      traceparent = getTraceContext(event.headers)
      tracestate = event.headers.tracestate || undefined
      if (traceparent) {
        log.debug(`lambda: found inbound traceparent ${traceparent}`)
      }
    }

    // determine if the request comes from the api gateway. and collect
    // the http method to use for the transaction name. default to lambda-
    // generic.
    let topSpanType = 'lambda-generic'
    let method = ''
    if (typeof event.requestContext === 'object') {
      const rc = event.requestContext
      if (event.version === '2.0' &&
          typeof event.headers === 'object' &&
          event.headers.host &&
          typeof rc.http === 'object' &&
          typeof rc.http.method === 'string') {
        method = rc.http.method + '.'
        topSpanType = 'lambda-api-gateway-v2'
      } else if (typeof event.headers === 'object' &&
          event.headers.host &&
          typeof event.httpMethod === 'string' &&
          typeof rc.httpMethod === 'string') {
        method = rc.httpMethod + '.'
        topSpanType = 'lambda-api-gateway-v1'
      }
    }
    log.debug('topSpanType =', topSpanType)

    // span.topSpan is normally a boolean. but for lambda topSpan is set to a string. if an http-
    // type span coming in through the AWS api-gateway then span.topSpan is set to a value
    // specifying which api-gateway version was detected. this allows subsequent code
    // to make decisions based on the source of the request. it is used to make decisions about
    // what KV pairs to create and whether to insert an x-trace header into the reply.
    let finalize
    if (topSpanType) {
      finalize = (span) => {
        span.defaultTxName = process.env.SW_APM_TRANSACTION_NAME || `${method.toUpperCase()}${context.functionName}`
        span.topSpan = topSpanType
      }
    }

    const promiseReturningHandler = promiseOnlyHandler(userHandler)
    const name = `nodejs-lambda-${userHandlerName}`

    function spanInfo () {
      // kv pairs are set according to the type of the span whether or not an x-trace
      // header will be returned.
      return { name, kvpairs: makeLambdaKVPairs(topSpanType, event, context), finalize }
    }
    return pStartOrContinueTrace(
      traceparent,
      tracestate,
      spanInfo,
      () => promiseReturningHandler(event, context),
      { forceNewTrace: true }
    )
  }

  userHandler[apm.wrappedFlag] = wrappedFunction

  return wrappedFunction
}

function promiseOnlyHandler (handler) {
  // lambda functions can complete via a callback(err, result) or
  // returning a promise that resolves to result, or rejects.
  // this forces the callback to return a promise and allows only
  // one of those methods to complete.
  return (event, context) => {
    let cbToPromise
    // convert the callback to a promise
    const cbp = new Promise((resolve, reject) => {
      cbToPromise = (error, result) => {
        if (error) {
          reject(error)
        } else {
          resolve(result)
        }
      }
    })

    const p = handler(event, context, cbToPromise)

    // if the function returns a promise then let it race the callback so the
    // first one done is used.
    if (p && typeof p.then === 'function') {
      return Promise.race([cbp, p])
    }

    return cbp
  }
}

function lowercaseHeaders (headers) {
  const lcheaders = {}
  for (const key of Object.keys(headers)) {
    lcheaders[key.toLocaleLowerCase()] = headers[key]
  }

  return lcheaders
}

function getTraceContext (headers) {
  // find an x-trace header in the event object. it could be from the api-gateway or
  // via an AWS.Lambda.invoke() call; if the latter then the event must be set manually
  // in the Payload option, e.g.
  //
  // const lambda = new AWS.Lambda();
  // const promise = lambda.invoke({
  //                    FunctionName: 'xyzzy',
  //                    Payload: '{"headers": {"x-trace": ...}}',
  //                    Qualifier: '$LATEST'
  //                  }).promise();
  // The Payload value appears as event for the called function.
  if (typeof headers.traceparent !== 'string') {
    return undefined
  }
  if (apm.traceToEvent(headers.traceparent)) {
    return headers.traceparent
  }

  return undefined
}

function makeLambdaKVPairs (topSpanType, event, context) {
  const kvpairs = {
    Spec: topSpanType !== 'lambda-generic' ? 'aws-lambda:ws' : 'aws-lambda',
    InvocationCount: apm.lambda.invocations
  }

  // map context property names to KV names. any values that can be
  // false (e.g. 0 or '') need to be exceptions.
  const contextProps = {
    functionVersion: 'FunctionVersion',
    invokedFunctionArn: 'InvokedFunctionARN',
    awsRequestId: 'AWSRequestID',
    memoryLimitInMB: 'MemoryLimitInMB',
    logStreamName: 'LogStreamName'
  }
  for (const prop in contextProps) {
    if (context[prop]) {
      kvpairs[contextProps[prop]] = context[prop]
    }
  }

  if (process.env.AWS_REGION) {
    kvpairs.AWSRegion = process.env.AWS_REGION
  }

  if (topSpanType === 'lambda-api-gateway-v1') {
    kvpairs.HTTPMethod = event.httpMethod.toUpperCase()
    if (event.path) {
      kvpairs.URL = event.path
    }
  } else if (topSpanType === 'lambda-api-gateway-v2') {
    kvpairs.HTTPMethod = event.requestContext.http.method.toUpperCase()
    if (event.requestContext.http.path) {
      kvpairs.URL = event.requestContext.http.path
    }
  } else {
    return kvpairs
  }

  // now it's apig - either rest v1, http v1, or http v2. note that
  // headers being an object is a prerequisite for the spanType to be
  // either lambda-api-gateway-(v1|v2), and the keys will be lowercase.
  const reqContextProps = {
    resourceId: 'APIGatewayResourceID',
    stage: 'APIGatewayStage'
  }
  for (const prop in reqContextProps) {
    if (event.requestContext[prop]) {
      kvpairs[reqContextProps[prop]] = event.requestContext[prop]
    }
  }

  // the headers we are interested in should not be multivalue headers.
  const headerKeys = {
    'x-forwarded-for': 'Forwarded-For',
    'x-forwarded-proto': 'Forwarded-Proto',
    'x-forwarded-port': 'Forwarded-Port',
    host: 'HTTP-Host'
  }
  const headers = event.headers
  for (const key in headerKeys) {
    if (headers[key]) {
      kvpairs[headerKeys[key]] = headers[key]
    }
  }

  return kvpairs
}
