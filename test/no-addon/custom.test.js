/* global it, describe */
'use strict'

process.env.SW_APM_TEST_NO_BINDINGS = '1'

const apm = require('../..')
const apmb = apm.addon
const assert = require('assert')

const soon = global.setImmediate || process.nextTick

// eslint-disable-next-line no-unused-vars
function psoon () {
  return new Promise((resolve, reject) => {
    soon(resolve)
  })
}

const traceparent = '00-0123456789abcdef0123456789abcdef-7a71b110e5e3588d-01'

// Without the native liboboe bindings present,
// the custom instrumentation should be a no-op
describe('custom (without native bindings present)', function () {
  it('should have a bindings version of \'not loaded\'', function () {
    assert(apm.addon.version === 'not loaded')
  })

  it('should passthrough instrumentHttp', function () {
    let counter = 0
    apm.instrumentHttp('span-name', function () {
      counter += 1
    })
    assert(counter === 1)
  })

  it('should passthrough sync instrument', function () {
    let counter = 0
    apm.instrument('test', function () {
      counter++
    })
    assert(counter === 1, 'counter should be 1')
  })

  it('should passthrough async instrument', function (done) {
    function localDone () {
      done()
    }
    apm.instrument('test', soon, {}, localDone)
  })

  it('should passthrough pInstrument', function () {
    let counter = 0

    function pfunc () {
      counter += 1
      return Promise.resolve(99)
    }

    return apm.pInstrument('test', pfunc).then(r => {
      assert(counter === 1, 'counter should be 1')
      assert(r === 99, 'the result of pInstrument should be 99')
      return r
    })
  })

  it('should passthrough sync startOrContinueTrace', function () {
    let counter = 0
    apm.startOrContinueTrace(null, null, 'test', function () {
      counter++
    })
    assert(counter === 1, 'counter should be equal to 1')
  })

  it('should passthrough async startOrContinueTrace', function (done) {
    function localDone () {
      done()
    }
    apm.startOrContinueTrace(null, null, 'test', soon, localDone)
  })

  it('should passthrough pStartOrContinueTrace', function () {
    let counter = 0

    function pfunc () {
      counter += 1
      return Promise.resolve(99)
    }
    return apm.pStartOrContinueTrace(null, null, 'test', pfunc).then(r => {
      assert(counter === 1, 'counter should be 1')
      assert(r === 99, 'the result of pStartOrContinueTrace should be 99')
      return r
    })
  })

  it('should passthrough requestStore', function () {
    const store = apm.requestStore

    assert(typeof store === 'object')
    assert(store.name === 'apm-cls-context')
    assert(store.constructor.name === 'Namespace')
  })

  it('should support callback shifting', function (done) {
    apm.instrument('test', soon, done)
  })

  it('should supply API functions and properties', function () {
    assert(apm.traceMode === 'disabled')
    assert(apm.sampleRate === 0)
    assert(apm.tracing === false)
    assert(apm.traceId === undefined)
    assert(apm.lastEvent === undefined)
    assert(apm.lastSpan === undefined)
    assert(apm.requestStore && typeof apm.requestStore.get === 'function')
    assert(typeof apm.resetRequestStore === 'function')
    assert(apm.clsCheck() === false)
    assert(apm.stack() === '')
    assert(apm.bind('x') === 'x')
    assert(apm.bindEmitter('x') === 'x')
    assert(apm.backtrace())
    assert(apm.setCustomTxNameFunction('x') === false)

    assert(apm.readyToSample() === false)
    assert(apm.getTraceSettings().doSample === false)
    assert(apm.sampling() === false)
    assert(apm.traceToEvent('') === undefined)
    assert(apm.traceToEvent(traceparent) instanceof apmb.Event)
    assert(apm.patchResponse('x') === undefined)
    assert(apm.addResponseFinalizer('x') === undefined)
    assert(apm.traceId === undefined)
    assert(apm.reportError(new Error('xyzzy')) === undefined)
    assert(apm.reportInfo('this is info') === undefined)

    const o = apm.getTraceObjectForLog()
    assert(typeof o === 'object')
    assert(Object.keys(o).length === 0)

    assert(apm.getTraceStringForLog() === '')
  })
})
