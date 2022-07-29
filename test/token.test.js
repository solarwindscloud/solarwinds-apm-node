/* global it, describe */
'use strict'

const token = process.env.SW_APM_TEST_SERVICE_KEY.split(':')[0]
const name = 'swoken-Modification-test'
process.env.SW_APM_SERVICE_KEY = `${token}:${name}`

const apm = require('..')
const assert = require('assert')

describe('verify that a swoken is handled correctly', function () {
  it('the service name should be lower case', function () {
    assert.strictEqual(apm.cfg.serviceKey, `${token}:${name.toLowerCase()}`)
  })

  it('shouldn\'t change the environment variable', function () {
    assert.strictEqual(process.env.SW_APM_SERVICE_KEY, `${token}:${name}`)
  })
})
