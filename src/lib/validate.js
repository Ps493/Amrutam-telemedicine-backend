'use strict';
const { E } = require('./errors');
// Validate and replace req.body / req.query / req.params with the parsed (stripped, coerced) value.
const validate = (schemas) => (req, _res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const r = schemas[part].safeParse(req[part]);
    if (!r.success) return next(E.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
    Object.defineProperty(req, part, { value: r.data, writable: true, configurable: true });
  }
  next();
};
module.exports = { validate };
