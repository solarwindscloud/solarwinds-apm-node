'use strict'

const apm = require('../lib')
const util = require('util')

// require should so that individual tests can be debugged using
// "mocha --inspect-brk test/test-file.js". if should is not included
// here then it's not included by the gulpfile (because it's not run)
// so it will be undefined.
const should = require('should') // eslint-disable-line

const env = process.env

if (env.SW_APM_REPORTER !== 'udp') {
  apm.loggers.warn('It looks like you need to "source env.sh bash" for tests to work correctly')
}

apm.loggers.addGroup({
  groupName: 'test',
  subNames: ['info', 'mock-port', 'messages', 'span', 'cls', 'debug']
})

if (!apm.g.taskDict) {
  apm.g.taskDict = {}
}

function startTest (file, options = {}) {
  apm.g.current = file.slice(file.lastIndexOf('/') + 1)
  apm.loggers.test.info('starting test: ', file)
  apm.loggers.test.cls(`entering ${apm.g.current}: %c`, apm.requestStore)

  applyOptions(options)
}

function endTest (options = {}) {
  apm.loggers.test.cls(`exiting ${apm.g.current}: %c`, apm.requestStore)

  applyOptions(options)
}

const debugOptions = {
  enable: false
}

function applyOptions (options) {
  // work when using standard cls-hooked.
  if (!apm.requestStore.setDebugOptions) {
    return
  }
  // don't modify the caller's options object
  let opts = Object.assign({}, options)

  // handle different name
  if (opts.customFormatter) {
    opts.ctxFmtter = formatters[opts.customFormatter]
    delete opts.customFormatter

    opts = Object.assign({}, debugOptions, opts)
  }
  apm.requestStore.setDebugOptions(opts)
}

const formatters = {
  terse: clsFormatTerse,
  abbrev: clsFormatAbbrev
}

function clsFormatTerse (active) {
  if (!active) {
    return active
  }
  const ls = active.lastSpan
  const le = active.lastEvent

  const terse = {
    id: active.id,
    name: active.lastSpan ? ls.name : '<none>',
    label: active.lastEvent ? le.Label : '<none>',
    iuc: active._iuc,
    xuc: active._xuc
  }
  return util.inspect(terse)
}

function clsFormatAbbrev (active) {
  if (!active) {
    return active
  }

  const utilOptions = {
    depth: 2,
    colors: true
  }

  const otherKeys = Object.keys(active).filter(k => ['id', 'lastSpan', 'lastEvent'].indexOf(k) === -1)
  const ls = active.lastSpan
  const le = active.lastEvent
  const abbrev = {
    id: active.id,
    lastSpan: active.lastSpan ? `${ls.name}:${ls._async ? 'async' : ''}` : 'none',
    lastEvent: active.lastEvent ? `${le.label}` : 'none'
  }
  otherKeys.forEach(k => {
    abbrev[k] = active[k]
  })
  return util.inspect(abbrev, utilOptions)
}

// make function available without explicit imports
apm.g.testing = startTest // replace no-op
apm.g.startTest = startTest
apm.g.endTest = endTest

exports.apm = apm
exports.startTest = startTest
exports.endTest = endTest
