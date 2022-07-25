'use strict'

let ao
let aob
let cls

module.exports = function (agent) {
  ao = agent
  aob = ao.addon
  // check for property to avoid triggering node 14 warning on
  // non-existent property in unfinished module.exports
  if (Object.prototype.hasOwnProperty.call(ao, 'cls')) {
    cls = ao.cls
  }

  // define the properties (some of which are part of the API)
  definePropertiesOn(ao)

  // make these globally available
  class Event {}
  Event.init = function () {}

  class Span {
    enter () {}
  }

  Span.init = function () {}
  Span.makeEntrySpan = function makeEntrySpan (name, settings, data) {
    // use the task id from settings or (primarily used in testing) make new.
    const traceTaskId = settings.traceTaskId || ao.addon.Event.makeRandom(settings.doSample)

    const span = new Span(name, { traceTaskId, edge: settings.edge }, data)

    // fill in entry-span-specific properties.
    span.doMetrics = settings.doMetrics
    span.topSpan = true

    return span
  }

  class Metrics {
    start () {}
    stop () {}
    resetInterval () {}
  }

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
    wrapLambdaHandler
  }
}

function definePropertiesOn (ao) {
  Object.defineProperty(ao, 'traceMode', {
    get () { return ao.modeToStringMap[0] },
    set (value) {
      // ignore any attempts to set traceMode.
    }
  })

  Object.defineProperty(ao, 'sampleRate', {
    get () { return 0 },
    set (value) {
      // ignore any attempt to set the sampleRate.
    }
  })

  Object.defineProperty(ao, 'tracing', {
    get () { return false }
  })

  Object.defineProperty(ao, 'traceId', {
    get () { return undefined }
  })

  Object.defineProperty(ao, 'lastEvent', {
    get () { return undefined }
  })

  Object.defineProperty(ao, 'lastSpan', {
    get () { return undefined }
  })

  const maps = {}
  Object.defineProperty(ao, 'maps', {
    get () { return maps }
  })

  const storeName = 'ao-cls-context'

  Object.defineProperty(ao, 'requestStore', {
    get () { return cls.getNamespace(storeName) || cls.createNamespace(storeName) }
  })

  ao.resetRequestStore = function () {
    cls.destroyNamespace(storeName)
  }

  ao.clsCheck = function (msg) {
    return false
  }

  ao.stack = function (test, n) {
    return ''
  }

  ao.bind = function (fn) {
    return fn
  }

  ao.bindEmitter = function (em) {
    return em
  }

  ao.backtrace = function () {
    const e = new Error('backtrace')
    return e.stack.replace(/[^\n]*\n\s+/, '').replace(/\n\s*/g, '\n')
  }

  ao.setCustomTxNameFunction = function (probe, fn) {
    return false
  }
}

function readyToSample (ms, obj) {
  const status = aob.isReadyToSample(ms)
  // if the caller wants the actual status provide it
  if (obj && typeof obj === 'object') {
    obj.status = status
  }

  return status === 1
}

function getTraceSettings (traceparent, tracestate, options) {
  // note: with liboboe 10.3.0 the api has changed to work with a traceparnet/tracestate duo insted of xtrace.
  // liboobe still uses the term xtrace in keys (and thus so do the bindings) even though
  // the format is now that of traceparnet (dash delimited).
  // put traceparent value into xtrace key
  const osettings = aob.Settings.getTraceSettings({ xtrace: traceparent, tracestate })
  // compatibility to avoid a synchronized bindings release
  if (!osettings.traceTaskId) {
    osettings.traceTaskId = osettings.metadata
  }
  return osettings
}

function sampling (item) {
  return false
}

function traceToEvent (traceparent) {
  return aob.Event.makeFromString(traceparent)
}

function patchResponse () {}
function addResponseFinalizer () {}

function instrumentHttp (build, run, options, res) {
  return run()
}

function instrument (span, run, options, callback) {
  // Verify that a run function is given
  if (typeof run !== 'function') {
    ao.loggers.error(`ao.instrument() run function is ${typeof run}`)
    return
  }

  // Normalize dynamic arguments
  try {
    if (typeof options === 'function') {
      callback = options
    } else {
      if (typeof options !== 'object') {
        options = {}
      }
    }

    if (!callback && run.length) {
      callback = function () {}
    }
  } catch (e) {
    ao.loggers.error('ao.instrument failed to normalize arguments', e.stack)
  }

  return run(callback)
}

function pInstrument (name, task, options = {}) {
  if (typeof task !== 'function') {
    return instrument(...arguments)
  }
  return task()
}

function startOrContinueTrace (traceparent, tracestate, build, run, opts, cb) {
  // Verify that a run function is given
  if (typeof run !== 'function') return

  if (typeof opts !== 'object') {
    cb = opts
  }
  if (!cb && run.length) {
    cb = function () {}
  }
  return run(cb)
}

function pStartOrContinueTrace (traceparent, tracestate, name, task, options = {}) {
  if (typeof task !== 'function') {
    return
  }

  return task()
}

function reportError (error) {

}

function reportInfo (data) {

}

function sendMetrics (metrics) {
  return aob.Reporter.sendMetrics(metrics)
}

function getTraceObjectForLog () {
  return {}
}

function getTraceStringForLog () {
  return ''
}

function wrapLambdaHandler (fn) {
  return fn
}
