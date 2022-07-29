/* global it, describe, before, after */
'use strict'

const helper = require('../helper')
const { apm } = require('../1.test-common')

const pkg = require('koa-route/package')

let canGenerator = false
try {
  eval('(function* () {})()')
  canGenerator = true
} catch (e) {
}

function noop () {}

describe('probes/koa-route ' + pkg.version, function () {
  let emitter
  const tests = canGenerator && require('./koa')

  //
  // Intercept messages for analysis
  //
  before(function (done) {
    apm.probes.fs.enabled = false
    emitter = helper.backend(done)
    apm.sampleRate = apm.addon.MAX_SAMPLE_RATE
    apm.traceMode = 'always'
    apm.g.testing(__filename)
  })
  after(function (done) {
    apm.probes.fs.enabled = true
    emitter.close(done)
  })

  // this test exists only to fix a problem with oboe not reporting a UDP
  // send failure.
  it('UDP might lose a message', function (done) {
    helper.test(emitter, function (done) {
      apm.instrument('fake', function () { })
      done()
    }, [
      function (msg) {
        msg.should.have.property('Label').oneOf('entry', 'exit')
        msg.should.have.property('Layer', 'fake')
      }
    ], done)
  })

  //
  // Tests
  //
  if (!canGenerator) {
    it.skip('should support koa-route controllers', noop)
    it.skip('should skip when disabled', noop)
  } else {
    it('should support koa-route controllers', function (done) {
      tests.route(emitter, done)
    })
    it('should skip when disabled', function (done) {
      tests.route_disabled(emitter, done)
    })
  }
})
