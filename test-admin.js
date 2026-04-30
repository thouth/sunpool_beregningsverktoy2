import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

initializeApp({ projectId: firebaseConfig.projectId });
const db = getFirestore(firebaseConfig.firestoreDatabaseId);

async function test() {
  try {
    const s = await db.collection('projects').limit(1).get();
    console.log("Success! Docs:", s.size);
  } catch(e) {
    console.error("FAIL:", e);
  }
}
test();
