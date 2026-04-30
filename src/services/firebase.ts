import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer, setDoc, serverTimestamp, collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json'; // adjust path if needed

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

export const loginWithGoogle = async () => {
    try {
        const result = await signInWithPopup(auth, googleProvider);
        const user = result.user;
        
        // Ensure user document exists
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDocFromServer(userRef);
        if (!userSnap.exists()) {
            await setDoc(userRef, {
                uid: user.uid,
                email: user.email || '',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        }
        return user;
    } catch (e: any) {
        console.error("Login failed", e);
        throw e;
    }
};

export const logout = () => signOut(auth);

// Error Handling Function
export function handleFirestoreError(error: any, operationType: string, path: string | null) {
  const currentUser = auth.currentUser;
  const errorInfo = {
    error: error.message,
    operationType,
    path,
    authInfo: currentUser ? {
      userId: currentUser.uid,
      email: currentUser.email,
      emailVerified: currentUser.emailVerified,
      isAnonymous: currentUser.isAnonymous,
      providerInfo: currentUser.providerData.map(p => ({ providerId: p.providerId, displayName: p.displayName, email: p.email }))
    } : null
  };
  console.error("Firestore DB Error: ", JSON.stringify(errorInfo, null, 2));
  throw new Error(error.message);
}
