'use strict';

// Shared by the plugin tests (node --test also runs this file; it contains no tests).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Returns the folder of a test app after linking this package into its
 * node_modules, so CAP discovers cds-plugin.js like an installed dependency.
 */
function testApp(name) {
  const dir = path.join(__dirname, name);
  const link = path.join(dir, 'node_modules', 'cap-hana-vector-publisher');
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(ROOT, link, 'junction');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return dir;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name));
}

/** axios request that resolves for every status, optionally as a mocked user */
function requester(axios) {
  return (method, url, { data, user } = {}) =>
    axios.request({
      method,
      url,
      data,
      auth: user && { username: user, password: user },
      validateStatus: () => true
    });
}

/** Polls fn until it returns a truthy value */
async function waitFor(fn, { timeout = 5000, interval = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

module.exports = { ROOT, testApp, fixture, requester, waitFor };
