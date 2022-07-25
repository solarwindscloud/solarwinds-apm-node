'use strict'

const shimmer = require('shimmer')
const requirePatch = require('../require-patch')

const ao = require('..')
const conf = ao.probes.graphql

const executeModule = requirePatch.relativeRequire('graphql/execution/execute.js')
const parserModule = requirePatch.relativeRequire('graphql/language/parser.js')
const validateModule = requirePatch.relativeRequire('graphql/validation/validate.js')

const getKey = (d) => {
  if (!d) return ''
  const found = d.definitions && d.definitions.find(def => def.operation)
  return found.operation || ''
}

const getInboundQuery = (d) => {
  if (!d) return ''
  return d.loc.source.body
}

const pathToArray = (path) => {
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

let patchedResolve = false

function wrapFieldResolver (fr) {
  if (patchedResolve) return patchedResolve

  const f = shimmer.wrap({ [fr.name]: fr }, fr.name, (fr) => {
    return function wrappedFieldResolver (source, args, contextValue, info) {
      return ao.instrument(
        () => {
          const kvpairs = {
            Spec: 'graphql',
            Layer: `${info.parentType}.${info.fieldName}`,
            Path: pathToArray(info && info.path).join('.')
          }

          return {
            name: `${info.parentType}.${info.fieldName}`,
            kvpairs
          }
        },
        () => fr.apply(this, arguments),
        conf
      )
    }
  })

  patchedResolve = f

  return f
}

function patchExecute (execute) {
  // function may get a single object with the arguments names as keys or a list of arguments
  return function wrappedExecute (argsOrSchema, document, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) {
    const args = arguments

    if (arguments.length > 1) {
      args[0] = argsOrSchema
      args[1] = document
      args[2] = rootValue
      args[3] = contextValue
      args[4] = variableValues
      args[5] = operationName
      args[6] = wrapFieldResolver(fieldResolver || executeModule.defaultFieldResolver)
      args[7] = typeResolver
    } else {
      args[0].fieldResolver = wrapFieldResolver(argsOrSchema.fieldResolver || executeModule.defaultFieldResolver)
    }

    return ao.instrument(
      () => {
        const kvpairs = {
          Spec: 'graphql',
          Layer: 'graphql.execute',
          Key: getKey(argsOrSchema.document || document || null), // a.k.a graphql.operation.type
          InboundQuery: getInboundQuery(argsOrSchema.document || document || null) || '', // may be an object or a string a.k.a graphql.source
          Path: '',
          Operation: argsOrSchema.operationName || operationName || '', // may be an object or a string a.k.a graphql.operation.name
          Operations: ''
        }

        return {
          name: 'graphql.execute',
          kvpairs,
          finalize (span, last) {

          }
        }
      },
      () => execute.apply(this, args),
      conf
    )
  }
}

function patchValidate (validate) {
  return function wrappedValidate (schema, documentAST) {
    return ao.instrument(
      () => {
        const kvpairs = {
          Spec: 'graphql',
          Layer: 'graphql.validate',
          Key: getKey(documentAST || null), // a.k.a graphql.operation.type
          InboundQuery: '',
          Path: '',
          Operation: '',
          Operations: ''
        }

        return {
          name: 'graphql.validate',
          kvpairs
        }
      },
      () => validate.apply(this, arguments),
      conf
    )
  }
}

function patchParse (parse) {
  return function wrappedParse (source, options) {
    return ao.instrument(
      () => {
        const kvpairs = {
          Spec: 'graphql',
          Layer: 'graphql.parse',
          InboundQuery: source.body || source || '' // may be an object or a string a.k.a graphql.source
        }

        return {
          name: 'graphql.parse',
          kvpairs
        }
      },
      () => parse.apply(this, arguments),
      conf
    )
  }
}

function patchGraphql (graphql) {
  return function wrappedGraphql (argsOrSchema, source, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) {
    return ao.pInstrument(
      () => {
        const kvpairs = {
          Spec: 'graphql',
          Layer: 'graphql',
          Operation: 'graphql'
        }

        return {
          name: 'graphql',
          kvpairs
        }
      },
      () => graphql.apply(this, arguments),
      conf
    )
  }
}

function patchGraphqlSync (graphql) {
  return function wrappedGraphql (argsOrSchema, source, rootValue, contextValue, variableValues, operationName, fieldResolver, typeResolver) {
    return ao.instrument(
      () => {
        const kvpairs = {
          Spec: 'graphql',
          Layer: 'graphql',
          Operation: 'graphqlSync'
        }

        return {
          name: 'graphql',
          kvpairs
        }
      },
      () => graphql.apply(this, arguments),
      conf
    )
  }
}

module.exports = function (graphql, info) {
  // properties of graphql are non writable and non configurable
  // copy object to a new one
  const gq = { ...graphql }

  gq.graphql = shimmer.wrap(gq, 'graphql', patchGraphql)
  gq.graphqlSync = shimmer.wrap(gq, 'graphqlSync', patchGraphqlSync)

  gq.execute = shimmer.wrap(executeModule, 'execute', patchExecute)
  gq.parse = shimmer.wrap(parserModule, 'parse', patchParse)
  gq.validate = shimmer.wrap(validateModule, 'validate', patchValidate)

  return gq
}
