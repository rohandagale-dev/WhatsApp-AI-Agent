// Loads .env from the project root regardless of the current working directory.
// Require this instead of calling dotenv.config() directly, so scripts work when
// run from a subdirectory (e.g. `node services/trainingService.js` vs `cd services`).
const path = require('path');

const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

module.exports = { envPath };
