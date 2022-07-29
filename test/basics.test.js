/* global it, describe */
'use strict'

// note: expect() triggers a lint no-unused-expressions. no apparent reason
/* eslint-disable no-unused-expressions */

const apm = require('..')
const Span = apm.Span
const expect = require('chai').expect

const helper = require('./helper')
const makeSettings = helper.makeSettings

let ifapmb // execute or skip test depending on whether bindings are loaded.
let MAX_SAMPLE_RATE

if (apm.addon) {
  ifapmb = it
  MAX_SAMPLE_RATE = apm.addon.MAX_SAMPLE_RATE
} else {
  ifapmb = it.skip
  MAX_SAMPLE_RATE = 1000000
}

describe('basics', function () {
  it('should set trace mode as string or integer and always get a string', function () {
    apm.traceMode = 'never'
    expect(apm.traceMode).equal('disabled')

    apm.traceMode = 'always'
    expect(apm.traceMode).equal('enabled')

    apm.traceMode = 0
    expect(apm.traceMode).equal('disabled')

    apm.traceMode = 1
    expect(apm.traceMode).equal('enabled')

    apm.traceMode = 'disabled'
    expect(apm.traceMode).equal('disabled')

    apm.traceMode = 'enabled'
    expect(apm.traceMode).equal('enabled')
  })

  ifapmb('should set and get sample rate', function () {
    apm.sampleRate = 0
    expect(apm.sampleRate).equal(0, 'when setting to 0')
    apm.sampleRate = 1000000
    expect(apm.sampleRate).equal(1000000, 'when setting to 1000000')
    apm.sampleRate = 100
    expect(apm.sampleRate).equal(100, 'when setting to 100')
  })

  // TODO: check helper.checkLogMessages and why substitution happens at .github but not locally
  ifapmb.skip('should handle invalid sample rates correctly', function () {
    const logChecks = [
      { level: 'warn', message: 'Invalid sample rate: %s, not changed', values: [NaN] },
      { level: 'warn', message: 'Sample rate (%s) out of range, using %s', values: [2000000, 1000000] },
      { level: 'warn', message: 'Sample rate (%s) out of range, using %s', values: [-10, 0] }
    ]
    helper.checkLogMessages(logChecks)

    apm.sampleRate = NaN
    expect(apm.sampleRate).equal(100, '(unchanged) when trying to set to NaN')
    apm.sampleRate = 2000000
    expect(apm.sampleRate).equal(1000000, 'when trying to set to 2000000')
    apm.sampleRate = -10
    expect(apm.sampleRate).equal(0, 'when trying to set to a negative number')
    apm.sampleRate = 100
    expect(apm.sampleRate).equal(100, 'setting back to the original')
  })

  it('should set sample source', function () {
    apm.sampleSource = 100
  })

  it('should get sample source', function () {
    expect(apm.sampleSource).equal(100)
  })

  ifapmb('should be able to check an Event\'s sample flag', function () {
    const md0 = new apm.addon.Event.makeRandom() // eslint-disable-line new-cap
    const md1 = new apm.addon.Event.makeRandom(1) // eslint-disable-line new-cap

    expect(apm.sampling(md0)).equal(false)
    expect(apm.sampling(md0.toString())).equal(false)
    expect(apm.sampling(md1)).equal(true)
    expect(apm.sampling(md1.toString())).equal(true)
  })

  ifapmb('should be able to detect if it is in a trace', function () {
    expect(apm.tracing).to.be.false
    const span = Span.makeEntrySpan('test', makeSettings())

    span.run(function () {
      expect(apm.tracing).equal(true)
    })
  })

  it('should support sampling using getTraceSettings()', function () {
    const skipSample = apm.skipSample
    apm.skipSample = false
    apm.traceMode = 'always'
    apm.sampleRate = MAX_SAMPLE_RATE
    let s = apm.getTraceSettings()
    expect(s).to.not.be.false

    apm.sampleRate = 1
    const samples = []
    for (let i = 0; i < 1000; i++) {
      s = apm.getTraceSettings()
      samples.push(s.doSample)
    }
    samples.should.containEql(false)
    apm.skipSample = skipSample
  })

  ifapmb('should not call sampleRate setter from sample function', function () {
    apm.sampleRate = apm.addon.MAX_SAMPLE_RATE
    apm.traceMode = 'always'
    const skipSample = apm.skipSample
    apm.skipSample = false

    function after (err) {
      expect(err).equal(undefined)
      apm.addon.Context.setDefaultSampleRate = old
      apm.skipSample = skipSample
    }

    const old = apm.addon.Context.setDefaultSampleRate
    apm.addon.Context.setDefaultSampleRate = function () {
      after()
      throw new Error('Should not have called sampleRate setter')
    }

    apm.getTraceSettings()
    after()
  })

  it('should not re-execute package even if deleted from the require.cache', function () {
    const logChecks = [
      { level: 'warn', message: 'solarwinds-apm is being executed more than once' }
    ]
    helper.checkLogMessages(logChecks)
    const key = require.resolve('..')
    delete require.cache[key]
    const apm2 = require('..')
    expect(apm).equal(apm2)
  })
})
