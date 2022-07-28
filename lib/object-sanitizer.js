'use strict'

const v8 = require('v8')

const structuredClone = obj => {
  return v8.deserialize(v8.serialize(obj))
}

/* exportable */

const sanitize = (obj) => {
  // recursively go down the object
  const drill = (item) => {
    if (item instanceof Object) {
      Object.keys(item).forEach(key => {
        // replace strings, string buffers and numbers with a ?
        if (typeof item[key] === 'string' || Buffer.isBuffer(item[key]) || !isNaN(item[key])) {
          item[key] = '?'
        } else {
          drill(item[key])
        }
      })
    }
    return item
  }

  return drill(structuredClone(obj))
}

module.exports = {
  sanitize
}
