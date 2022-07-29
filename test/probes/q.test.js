/* global describe, before */
'use strict'

const { apm } = require('../1.test-common')

const pkg = require('q/package')

describe('probes/q ' + pkg.version, function () {
  before(function () {
    apm.g.testing(__filename)
  })
  require('./promises')(require('q'))
})
