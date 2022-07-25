/* global it, describe, before, beforeEach, after */
'use strict'

const helper = require('../helper')
const { ao } = require('../1.test-common')

const { graphql, graphqlSync, buildSchema } = require('graphql')

describe('probes.graphql', function () {
  let emitter

  beforeEach(function (done) {
    setTimeout(function () {
      done()
    }, 100)
  })

  //
  // Intercept messages for analysis
  //
  before(function (done) {
    ao.probes.fs.enabled = false
    emitter = helper.backend(done)
    ao.sampleRate = ao.addon.MAX_SAMPLE_RATE
    ao.traceMode = 'always'
    ao.g.testing(__filename)
  })
  after(function (done) {
    ao.probes.fs.enabled = true
    emitter.close(done)
  })

  // this test exists only to fix a problem with oboe not reporting a UDP
  // send failure.
  it('UDP might lose a message', function (done) {
    helper.test(emitter, function (done) {
      ao.instrument('fake', function () { })
      done()
    }, [
      function (msg) {
        msg.should.have.property('Label').oneOf('entry', 'exit')
        msg.should.have.property('Layer', 'fake')
      }
    ], done)
  })

  //
  // Define tests
  //

  // Construct a schema, using GraphQL schema language
  const schema = buildSchema(`
    type Query {
      hello: String,
      helloSync: String
    }
  `)

  // The rootValue provides a resolver function for each API endpoint
  const rootValue = {
    hello: () => {
      return 'Hello world!'
    },
    helloSync: () => {
      return 'Hello Sync world!'
    }
  }

  it('should instrument graphql pure call', function (done) {
    helper.test(emitter, function (done) {
      // Run the GraphQL query '{ hello }' and print out the response
      graphql({
        schema,
        source: '{ hello }',
        rootValue
      }).then((response) => {
        response.data.hello.should.equal('Hello world!')
        done()
      }).catch(e => {
        console.log(e)
        done()
      })
    }, [
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('Layer', 'graphql')
        msg.should.have.property('Label', 'entry')
      },
      // parse
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('InboundQuery', '{ hello }')
        msg.should.have.property('Layer', 'graphql.parse')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.parse')
        msg.should.have.property('Label', 'exit')
      },
      // validate
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('Key', 'query')
        msg.should.have.property('Layer', 'graphql.validate')
        msg.should.have.property('Label', 'entry')
        // checks.exit(msg)
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.validate')
        msg.should.have.property('Label', 'exit')
      },
      // execute
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('InboundQuery', '{ hello }')
        msg.should.have.property('Key', 'query')
        msg.should.have.property('Layer', 'graphql.execute')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'Query.hello')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'Query.hello')
        msg.should.have.property('Label', 'exit')
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.execute')
        msg.should.have.property('Label', 'exit')
      },
      // top level exit
      function (msg) {
        msg.should.have.property('Layer', 'graphql')
        msg.should.have.property('Label', 'exit')
      }
    ], done)
  })

  it('should instrument graphqlSync pure call', function (done) {
    helper.test(emitter, function (done) {
      // Run the GraphQL query '{ hello }' and print out the response
      const response = graphqlSync({
        schema,
        source: '{ helloSync }',
        rootValue
      })
      response.data.helloSync.should.equal('Hello Sync world!')
      done()
    }, [
      // top level entry
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('Layer', 'graphql')
        msg.should.have.property('Label', 'entry')
      },
      // parse
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('InboundQuery', '{ helloSync }')
        msg.should.have.property('Layer', 'graphql.parse')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.parse')
        msg.should.have.property('Label', 'exit')
      },
      // validate
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('Key', 'query')
        msg.should.have.property('Layer', 'graphql.validate')
        msg.should.have.property('Label', 'entry')
        // checks.exit(msg)
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.validate')
        msg.should.have.property('Label', 'exit')
      },
      // execute
      function (msg) {
        msg.should.have.property('Spec', 'graphql')
        msg.should.have.property('InboundQuery', '{ helloSync }')
        msg.should.have.property('Key', 'query')
        msg.should.have.property('Layer', 'graphql.execute')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'Query.helloSync')
        msg.should.have.property('Label', 'entry')
      },
      function (msg) {
        msg.should.have.property('Layer', 'Query.helloSync')
        msg.should.have.property('Label', 'exit')
      },
      function (msg) {
        msg.should.have.property('Layer', 'graphql.execute')
        msg.should.have.property('Label', 'exit')
      },
      // top level exit
      function (msg) {
        msg.should.have.property('Layer', 'graphql')
        msg.should.have.property('Label', 'exit')
      }
    ], done)
  })
})
