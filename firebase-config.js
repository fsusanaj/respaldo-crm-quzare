// 1. Importamos las herramientas de Firebase desde internet (CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

// 2. Tu configuración (Las credenciales que ya tienes)
const firebaseConfig = {
  apiKey: "AIzaSyD0hZwfRfiYJliysT4v42JT0r7HV37IxIU",
  authDomain: "app-crm-camiones.firebaseapp.com",
  projectId: "app-crm-camiones",
  storageBucket: "app-crm-camiones.firebasestorage.app",
  messagingSenderId: "241190039626",
  appId: "1:241190039626:web:ebb95aca494519083df6b3",
  measurementId: "G-CZF5RBFQ68"
};

// 3. Inicializamos (Encendemos Firebase)
const app = initializeApp(firebaseConfig);

// 4. EXPORTAMOS (Compartimos) las herramientas ya configuradas
// Aquí decimos: "Quien quiera usar la base de datos, importe 'db' de este archivo"
export const db = getFirestore(app);
export const auth = getAuth(app);