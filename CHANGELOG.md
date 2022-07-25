## SolarWinds APM changelog


v11.0.0 is the first SolarWinds APM version. Versions prior to v11.0.0 were branded AppOptics APM. See: https://github.com/appoptics/appoptics-apm-node/blob/master/CHANGELOG.md

### v11.0.0

Features
- Add W3C Trace Context functionality using liboboe 10.3.x+ in mode 1.
- Add Trace Context in Logs that match the Open Telemetry Specification.
- Add Trace Context in Queries (SQL/CQL) to allow integration with SolarWinds DPM using Query Tags.
- Add auto instrumentation of Node's native DNS module.
- Add auto instrumentation to the promise interface of Node's native fs module.
- Add auto instrumentation log4js package.
- Upgrade tedious (MS SQL) probe to support latest.
- Upgrade pino logging probe to support latest.

Maintenance
- Refactor the logging probes API simplifying both api methods and configuration settings.
- Refactor the morgan probe simplifying implementation and improving functionality.
- Change naming of headers and reported KV pairs for Trigger Trace requests.
- Update http/s probe KV pairs.
- Improve SQL Sanitization moving it form Bindings to Agent.
- Remove array-flatten from dependencies.
- Remove methods from dependencies.
- Remove minimist from dependencies.
- Remove glob from dependencies.
- Remove cls-hooked from dependencies.
- Replace debug-custom with debug dependency.
- Gracefully Disable Lambda Functionality until issues are resolved and code refactored.
- Remove bin functionality which was outdated and undocumented.
- Remove deprecated environment variables.
- Remove the code used to detect and potentially handle conflicts with newrelic, strong-agent and appdynamics and also removes the ignoreConfilicts config setting.
- Remove disabled notifier "dead code".
- Remove semver Conditionals for Outdated Node-Versions. If it is not a supported version, behavior is expected to be unexpected.
- Remove debug code.
- Remove support for node versions 10 and 12. Supported versions are now 14, 16 and 18.
- Remove support from old versions of hapi and vision packages.
- Remove support for pg package versions under 7.
- Remove support for amqp package. Package has not been updated in 4 years. Not actively tested. Has alternative.

Breaking changes
- SolarWinds APM is not expected to be backwards compatible with AppOptics APM.

Bug fix
- Completely remove support node-cassandra-cql package.
- Fix false warning of main file loaded before agent.
- Fix the q probe to only binds when tracing.
- Resolve circular dependencies.
- Always masks the Service Key.
