/* global it, describe */
'use strict'
const expect = require('chai').expect
const objectSanitizer = require('../lib/object-sanitizer')

describe('objectSanitizer basic', function () {
  // used in insert, find, count etc.
  it('should sanitizes numbers', function () {
    const obj = { a: 0, b: 12 }
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify({ a: '?', b: '?' }))
  })

  it('should sanitizes strings', function () {
    const obj = { a: 'hide', b: 'me' }
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify({ a: '?', b: '?' }))
  })

  it('should sanitizes double quoted strings', function () {
    const obj = { a: 'hide', b: 'me' }
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify({ a: '?', b: '?' }))
  })

  // used in insertMany
  it('should sanitizes an array of objects', function () {
    const obj = [{ a: 1, b: 'hide' }, { a: 2 }, { a: 3 }]
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify([{ a: '?', b: '?' }, { a: '?' }, { a: '?' }]))
  })

  // used in UpdateOne for example
  it('should sanitizes nested objects', function () {
    const obj = { $set: { b: 1, doin: 'updateOne' } }
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify({ $set: { b: '?', doin: '?' } }))
  })

  // used in bulkWrite for example
  it('should sanitizes complex stuff', function () {
    const obj = [
      { insertOne: { document: { _id: 4, char: 'Dithras', class: 'barbarian', lvl: 4 } } },
      { insertOne: { document: { _id: 5, char: 'Taeln', class: 'fighter', lvl: 3 } } },
      {
        updateOne: {
          filter: { char: 'Eldon' },
          update: { $set: { status: 'Critical Injury' } }
        }
      },
      { deleteOne: { filter: { char: 'Brisbane' } } },
      {
        replaceOne: {
          filter: { char: 'Meldane' },
          replacement: { char: 'Tanys', class: 'oracle', lvl: 4 }
        }
      }
    ]
    const result = objectSanitizer.sanitize(obj)
    expect(JSON.stringify(result)).equal(JSON.stringify([{ insertOne: { document: { _id: '?', char: '?', class: '?', lvl: '?' } } }, { insertOne: { document: { _id: '?', char: '?', class: '?', lvl: '?' } } }, { updateOne: { filter: { char: '?' }, update: { $set: { status: '?' } } } }, { deleteOne: { filter: { char: '?' } } }, { replaceOne: { filter: { char: '?' }, replacement: { char: '?', class: '?', lvl: '?' } } }]))
  })
})
