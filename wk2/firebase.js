// Firebase setup for the Node.js server.
// Prefer Admin SDK locally so server reads/writes are not blocked by RTDB rules.
const fs = require('fs');
const path = require('path');

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://magic-wand-conndev-default-rtdb.firebaseio.com';

function createClientDb() {
  const { initializeApp } = require('firebase/app');
  const { getDatabase } = require('firebase/database');

  const firebaseConfig = {
    apiKey: 'AIzaSyDWJTKpCJAUZxJI5_SVggsr5qu3T0j6l4M',
    authDomain: 'magic-wand-conndev.firebaseapp.com',
    databaseURL,
    projectId: 'magic-wand-conndev',
    storageBucket: 'magic-wand-conndev.firebasestorage.app',
    messagingSenderId: '843131930034',
    appId: '1:843131930034:web:dead5c4b1ea669e535d0ab',
    measurementId: 'G-K50L55D71C',
  };

  const firebaseApp = initializeApp(firebaseConfig);
  const db = getDatabase(firebaseApp);

  return { firebaseApp, db, firebaseMode: 'client' };
}

function getServiceAccountObject() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const filePath = path.isAbsolute(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
      ? process.env.FIREBASE_SERVICE_ACCOUNT_PATH
      : path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  const defaultPaths = [
    path.resolve(__dirname, 'service-account.json'),
    path.resolve(__dirname, 'firebase-service-account.json'),
    path.resolve(__dirname, 'serviceAccountKey.json'),
  ];

  const existingPath = defaultPaths.find((candidate) => fs.existsSync(candidate));
  if (existingPath) {
    return JSON.parse(fs.readFileSync(existingPath, 'utf8'));
  }

  return null;
}

function createAdminDb() {
  const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');

  const serviceAccount = getServiceAccountObject();
  const options = { databaseURL };

  if (serviceAccount) {
    options.credential = cert(serviceAccount);
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    options.credential = applicationDefault();
  } else {
    return null;
  }

  const firebaseApp = getApps().length > 0 ? getApps()[0] : initializeApp(options);
  const db = getDatabase(firebaseApp);

  return { firebaseApp, db, firebaseMode: 'admin' };
}

let firebaseSetup;

try {
  firebaseSetup = createAdminDb();
} catch (err) {
  console.warn(`[firebase] Admin SDK init failed, falling back to client SDK: ${err.message}`);
}

if (!firebaseSetup) {
  firebaseSetup = createClientDb();
  console.warn(
    '[firebase] Using client SDK for the Node server. Local reads are still subject to RTDB security rules. ' +
      'Set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS to use admin access.',
  );
} else {
  console.log(`[firebase] Using ${firebaseSetup.firebaseMode} SDK for server database access`);
}

module.exports = firebaseSetup;
