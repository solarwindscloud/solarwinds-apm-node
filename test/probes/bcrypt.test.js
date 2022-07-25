/* global it, describe, before, after */
'use strict'

const { ao, startTest, endTest } = require('../1.test-common.js')
const expect = require('chai').expect

const bcrypt = require('bcrypt')
const pkg = require('bcrypt/package')

describe('probes.bcrypt ' + pkg.version, function () {
  before(function () {
    startTest(__filename, { enable: false, customFormatter: 'terse' })
  })
  after(function () {
    endTest()
  })

  it('should trace through async bcrypt', function (done) {
    const test = 'foo'
    const password = 'this is a test'

    ao.startOrContinueTrace(
      '',
      '',
      'test-bcrypt',
      function (cb) {
        ao.requestStore.set(test, 'bar')
        bcrypt.genSalt(10, function (err, salt) {
          bcrypt.hash(password, salt, function (err, hash) {
            bcrypt.compare(password, hash, function (err, res) {
              // the passwords should match
              res.should.equal(true)
              const result = ao.requestStore.get(test)
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
