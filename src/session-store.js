const session = require('express-session');

// Persists sessions in SQLite so logins survive restarts.
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      'INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data'
    );
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.timer = setInterval(() => this.pruneStmt.run(Date.now()), 15 * 60 * 1000);
    this.timer.unref();
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.setStmt.run(sid, expires, JSON.stringify(sess));
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.delStmt.run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SqliteStore;
