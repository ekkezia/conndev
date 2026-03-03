import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDWJTKpCJAUZxJI5_SVggsr5qu3T0j6l4M",
  authDomain: "magic-wand-conndev.firebaseapp.com",
  databaseURL: "https://magic-wand-conndev-default-rtdb.firebaseio.com",
  projectId: "magic-wand-conndev",
  storageBucket: "magic-wand-conndev.firebasestorage.app",
  messagingSenderId: "843131930034",
  appId: "1:843131930034:web:dead5c4b1ea669e535d0ab",
  measurementId: "G-K50L55D71C",
};

const firebaseApp = initializeApp(firebaseConfig);
export const db = getDatabase(firebaseApp);
