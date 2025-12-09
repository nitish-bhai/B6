
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, updateDoc, increment, addDoc, serverTimestamp } from "firebase/firestore";
import { UserProfile, Transaction } from "../types";

const firebaseConfig = {
  apiKey: "AIzaSyDWBos5f3koVvfnJ5otTvHVIzD4QDGNvjU",
  authDomain: "studio-8371121982-c36f9.firebaseapp.com",
  projectId: "studio-8371121982-c36f9",
  storageBucket: "studio-8371121982-c36f9.firebasestorage.app",
  messagingSenderId: "939482534019",
  appId: "1:939482534019:web:0ef3816f1c10398559cbb6"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Use initializeFirestore to force long polling which is more robust in some environments
// where WebSockets might be restricted or unreliable (fixing [code=unavailable] error).
export const db = initializeFirestore(app, {
    experimentalForceLongPolling: true
});

/**
 * Creates or updates a user's profile document in Firestore.
 * It merges the provided data with any existing document.
 * @param uid The user's ID.
 * @param profileData A partial or full UserProfile object.
 */
export const setUserProfile = async (uid: string, profileData: Partial<UserProfile>): Promise<void> => {
    const userDocRef = doc(db, 'users', uid);
    await setDoc(userDocRef, profileData, { merge: true });
};

export const getUserProfile = async (uid:string): Promise<UserProfile | null> => {
    const userDocRef = doc(db, 'users', uid);
    const docSnap = await getDoc(userDocRef);
    if (docSnap.exists()) {
        const data = docSnap.data();
        // Ensure usage object exists if older record
        if (!data.usage) {
            data.usage = { aiScans: 0, promosGenerated: 0, inventoryCount: 0 };
        }
        return data as UserProfile;
    }
    return null;
};

/**
 * Increments the usage counter for a specific feature.
 * @param uid The user's ID.
 * @param field The usage field to increment (e.g., 'aiScans').
 */
export const incrementUserUsage = async (uid: string, field: 'aiScans' | 'promosGenerated'): Promise<void> => {
    const userDocRef = doc(db, 'users', uid);
    await updateDoc(userDocRef, {
        [`usage.${field}`]: increment(1)
    });
};

/**
 * Finds users of a specific role who are associated with any of the provided categories.
 * @param categories An array of category strings to match against.
 * @param role The role to filter by ('seller' or 'supplier').
 * @returns A promise that resolves to an array of matching UserProfile objects.
 */
export const findUsersByCategories = async (categories: string[], role: 'seller' | 'supplier'): Promise<UserProfile[]> => {
    if (!categories || categories.length === 0) return [];
    
    const usersRef = collection(db, 'users');
    // Firestore 'array-contains-any' queries are limited to 10 elements in the array.
    // For this app's scale, we'll query on the first 10 selected categories.
    const categoriesToQuery = categories.slice(0, 10);
    
    const q = query(usersRef, where('role', '==', role), where('categories', 'array-contains-any', categoriesToQuery));
    
    const querySnapshot = await getDocs(q);
    const users: UserProfile[] = [];
    querySnapshot.forEach((doc) => {
        users.push(doc.data() as UserProfile);
    });
    return users;
};

// --- Admin Functions ---

/**
 * Fetches all users in the system.
 * NOTE: In a production environment with thousands of users, this should be paginated or handled via Cloud Functions.
 */
export const getAllUsers = async (): Promise<UserProfile[]> => {
    const usersRef = collection(db, 'users');
    const snapshot = await getDocs(usersRef);
    return snapshot.docs.map(doc => doc.data() as UserProfile);
};

/**
 * Records a financial transaction.
 */
export const recordTransaction = async (
    userId: string, 
    userName: string, 
    amount: number, 
    plan: 'pro', 
    paymentMethod: string
): Promise<void> => {
    const txRef = collection(db, 'transactions');
    await addDoc(txRef, {
        userId,
        userName,
        amount,
        plan,
        date: serverTimestamp(),
        status: 'success',
        paymentMethod
    });
};

/**
 * Fetches all transaction history.
 */
export const getAllTransactions = async (): Promise<Transaction[]> => {
    const txRef = collection(db, 'transactions');
    const snapshot = await getDocs(txRef);
    const transactions = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    } as Transaction));
    // Sort desc in memory
    return transactions.sort((a, b) => {
         const dateA = a.date?.toMillis ? a.date.toMillis() : 0;
         const dateB = b.date?.toMillis ? b.date.toMillis() : 0;
         return dateB - dateA;
    });
};
