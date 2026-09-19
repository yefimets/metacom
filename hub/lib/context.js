'use strict';

const { buildApi } = require('../api/index.js');

class Procedure {
  constructor(def) {
    this.access = def.access;
    this.handler = def.handler;
  }

  // eslint-disable-next-line class-methods-use-this
  async enter() {}

  // eslint-disable-next-line class-methods-use-this
  leave() {}

  invoke(context, args) {
    return this.handler(args, context);
  }
}

/// The ApplicationContext metacom's Server needs: a console, session persistence (unused,
/// the hub keeps its own connection table) and method lookup.
const createContext = (deps) => {
  const units = buildApi(deps);
  return {
    console: deps.console,
    auth: { saveSession: async () => {} },
    static: { constructor: { name: 'Static' } },
    getMethod(unit, _version, name) {
      const def = units[unit]?.[name];
      return def ? new Procedure(def) : null;
    },
  };
};

module.exports = { createContext };
