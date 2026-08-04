// Mounts a router under a minimal Express app for supertest, with a stub
// session (no real express-session/SqlSessionStore) — good enough for
// testing route handlers, which only ever read/write req.session.user and
// call req.session.regenerate()/destroy() with a callback.

import express from 'express';

export function buildTestApp(router, { sessionUser = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    req.session = {
      user: sessionUser,
      cookie: {},
      regenerate(cb) { cb(null); },
      destroy(cb) { cb(); },
    };
    next();
  });

  app.use('/', router);
  return app;
}
