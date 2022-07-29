/* global it, describe, before, after */
'use strict'

const { apm, startTest, endTest } = require('../1.test-common.js')
const expect = require('chai').expect

const bcrypt = require('bcrypt')
const pkg = require('bcrypt/package')

describe('probes.bcrypt ' + pkg.version, function () {
  let prevll
  before(function () {
    startTest(__filename, { enable: false, customFormatter: 'terse' })
    prevll = apm.logLevel
    // apm.logLevelAdd('span')
  })
  after(function () {
    // apm.requestStore.dumpCtx()

    endTest()
    apm.logLevel = prevll
  })

  it('should trace through async bcrypt', function (done) {
    const test = 'foo'
    const password = 'this is a test'

    process.env.DEBUG_CLS_HOOKED = 1

    apm.startOrContinueTrace(
      '',
      '',
      'test-bcrypt',
      function (cb) {
        apm.requestStore.set(test, 'bar')
        bcrypt.genSalt(10, function (err, salt) {
          bcrypt.hash(password, salt, function (err, hash) {
            bcrypt.compare(password, hash, function (err, res) {
              // the passwords should match
              res.should.equal(true)
              const result = apm.requestStore.get(test)
              expect(result).equal('bar', 'context.get(foo) should equal bar')
              return cb()
            })
          })
        })
      },
      { enabled: true },
      function () { done() }
    )
  })
})
