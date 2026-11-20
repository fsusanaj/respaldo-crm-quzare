const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Mark inactive users as offline (every 5 minutes)
exports.markInactiveUsersOffline = functions.pubsub.schedule("every 5 minutes").onRun(async (context) => {
    const now = new Date();
    const inactiveThreshold = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago
    
    console.log(`[markInactiveUsersOffline] Running at ${now.toISOString()}`);
    
    try {
        // Find all users with isOnline: true
        const snapshot = await db.collection("users")
            .where("isOnline", "==", true)
            .get();
        
        let offlineCount = 0;
        const batch = db.batch();
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const lastLogin = data.lastLogin && data.lastLogin.toDate ? data.lastLogin.toDate() : null;
            
            // If no lastLogin or lastLogin is older than 10 minutes, mark as offline
            if (!lastLogin || lastLogin < inactiveThreshold) {
                batch.update(doc.ref, { isOnline: false });
                offlineCount++;
                console.log(`[markInactiveUsersOffline] Marking ${data.email} as offline (lastLogin: ${lastLogin ? lastLogin.toISOString() : 'none'})`);
            }
        });
        
        if (offlineCount > 0) {
            await batch.commit();
            console.log(`[markInactiveUsersOffline] Marked ${offlineCount} users as offline`);
        } else {
            console.log(`[markInactiveUsersOffline] No inactive users found`);
        }
    } catch (error) {
        console.error("[markInactiveUsersOffline] Error:", error);
    }
});

// Scheduled function to run every 5 minutes
exports.checkReminders = functions.pubsub.schedule("every 5 minutes").onRun(async (context) => {
    const now = new Date();
    // Look ahead 35 minutes (cover the 5 min gap + 30 min alert window)
    const futureWindow = new Date(now.getTime() + 35 * 60 * 1000); 

    console.log(`[checkReminders] Running at ${now.toISOString()}`);

    try {
        // Query all clients with reminders
        // NOTE: In a production app with huge data, this should be optimized 
        // (e.g., separate collection for active reminders or compound indexes).
        // For this scale, client-side filtering of reminders array is acceptable.
        
        // We can't easily query inside the 'reminders' array for specific dates in Firestore without
        // changing the data structure. So we fetch docs that *have* reminders.
        // Optimization: Add a field 'hasPendingReminders': true to clients.
        
        // For now, grabbing clients that have the 'reminders' field.
        const snapshot = await db.collection("clientes")
            .orderBy("nombre") // Just a valid order to stream
            .get();

        const notificationsToSend = [];
        const batch = db.batch();
        let batchCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            const reminders = data.reminders || [];
            if (reminders.length === 0) return;

            let clientUpdated = false;
            let updatedReminders = [...reminders];

            updatedReminders.forEach((r, index) => {
                if (r.triggered || r.triggeredPush) return; // Already handled

                const reminderDate = r.fecha && r.fecha.toDate ? r.fecha.toDate() : new Date(r.fecha);

                // If reminder is in the past OR within the next 35 minutes
                if (reminderDate <= futureWindow) {
                    // It is time!
                    
                    // Mark as triggered for Push
                    updatedReminders[index].triggeredPush = true; 
                    updatedReminders[index].triggered = true; // Mark as triggered for UI as well 
                    clientUpdated = true;

                    // Prepare Notification
                    // We need the user's FCM token. 
                    // The client doc has 'userId' (sales rep).
                    // We need to fetch that user's profile to get the token.
                    notificationsToSend.push({
                        userId: data.userId,
                        title: `Recordatorio: ${data.nombre}`,
                        body: `${r.nota} - ${reminderDate.toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}` + (r.createdBy ? `\nProgramado por: ${r.createdBy}` : ""),
                        clientId: doc.id
                    });
                }
            });

            if (clientUpdated) {
                batch.update(doc.ref, { reminders: updatedReminders });
                batchCount++;
            }
        });

        // Commit updates to Firestore (marking as triggered)
        if (batchCount > 0) {
            await batch.commit();
            console.log(`[checkReminders] Updated ${batchCount} client docs.`);
        }

        // Send Notifications
        for (const notif of notificationsToSend) {
            if (!notif.userId) continue;

            const userDoc = await db.collection("users").doc(notif.userId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                if (userData.fcmToken) {
                    const message = {
                        notification: {
                            title: notif.title,
                            body: notif.body,
                        },
                        token: userData.fcmToken,
                        webpush: {
                             notification: {
                                icon: 'https://app-crm-camiones.web.app/img/logo-quzare.jpeg', // Needs absolute URL
                                click_action: 'https://app-crm-camiones.web.app/'
                             }
                        }
                    };

                    try {
                        const response = await admin.messaging().send(message);
                        console.log(`[checkReminders] Sent to ${notif.userId}: ${response}`);
                    } catch (error) {
                        console.error(`[checkReminders] Error sending to ${notif.userId}:`, error);
                        // Optional: Handle invalid tokens (delete them)
                    }
                } else {
                     console.log(`[checkReminders] No token for user ${notif.userId}`);
                }
            }
        }

    } catch (error) {
        console.error("[checkReminders] Error:", error);
    }
});

// Sincronización del inventario de camiones al proyecto de la página web externa
exports.syncInventoryToWeb = functions.firestore
    .document("inventario/{truckId}")
    .onWrite(async (change, context) => {
        const truckId = context.params.truckId;
        
        let dbWeb;
        try {
            // Se requiere dinámicamente para que no rompa la carga si aún no suben el JSON
            const serviceAccountWeb = require("./proyecto-web-service-account.json");
            const existingApp = admin.apps.find(app => app && app.name === "appWeb");
            const appWeb = existingApp || admin.initializeApp({
                credential: admin.credential.cert(serviceAccountWeb)
            }, "appWeb");
            dbWeb = appWeb.firestore();
        } catch (error) {
            console.error("[syncInventoryToWeb] Error al inicializar el proyecto Firebase Web secundario. " +
                "Asegúrate de que 'functions/proyecto-web-service-account.json' exista y sea válido. Detalles:", error);
            return null;
        }

        const destRef = dbWeb.collection("trucks").doc(truckId);

        // Caso 1: Eliminación del camión en el CRM -> Eliminar en la Web
        if (!change.after.exists) {
            console.log(`[syncInventoryToWeb] Eliminando camión ${truckId} de la página web`);
            try {
                await destRef.delete();
                console.log(`[syncInventoryToWeb] Camión ${truckId} eliminado exitosamente de la página web`);
            } catch (error) {
                console.error(`[syncInventoryToWeb] Error al eliminar camión ${truckId} en la web:`, error);
            }
            return null;
        }

        // Caso 2: Creación o Modificación en el CRM -> Sincronizar en la Web
        const data = change.after.data();
        console.log(`[syncInventoryToWeb] Sincronizando camión ${truckId} a la página web`);

        // Dar formato legible al precio (ej: $1,400,000 MXN)
        const formattedPrice = typeof data.precio === 'number' 
            ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0 }).format(data.precio) + ' MXN'
            : (data.precio ? `$${data.precio} MXN` : "Consultar Precio");

        // Imagen de portada
        const coverImage = data.foto || (data.fotos && data.fotos[0]) || "img/logo-1-cruzare.jpg";

        // Mapeamos los campos del CRM a la estructura esperada por quzare.html
        const publicData = {
            id: truckId,
            title: `${data.marca || ""} ${data.modelo || ""}`.trim(),
            year: String(data.anio || data.año || ""),
            price: formattedPrice,
            image: coverImage,
            engine: `${data.motor || ""} ${data.hp || ""}`.trim() || "-",
            trans: data.transmision || "-",
            frontAxle: data.eje_delantero || "-",
            rearAxle: data.eje_trasero || "-",
            suspension: data.suspension || "-",
            ratio: data.paso || "-",
            desc: data.descripcion || "",
            interiorImages: data.fotos || [], 
            engineImages: data.fotos || [], 
            videoPage: "",
            engineSound: "",
            specs: {
                motor: {
                    model: data.motor || "-",
                    disp: "-",
                    power: data.hp || "-",
                    torque: "-",
                    emissions: "-",
                    b10: "-"
                },
                clutch: {
                    brand: "-",
                    type: "-",
                    size: "-",
                    act: "-"
                },
                trans: {
                    model: data.transmision || "-",
                    speeds: "-",
                    ratio: "-",
                    final: "-",
                    torque: "-",
                    retarder: "-"
                },
                frontAxle: {
                    type: "-",
                    susp: "-",
                    cap: data.eje_delantero || "-"
                },
                rearAxle: {
                    type: data.eje_trasero || "-",
                    susp: data.suspension || "-",
                    ratio: data.paso || "-"
                },
                tires: {
                    size: data.medida_llantas || "-",
                    rim: `${data.rines_delanteros || ""} / ${data.rines_traseros || ""}`.trim() || "-",
                    qty: "-"
                },
                elec: {
                    alt: "-",
                    volt: "-",
                    bat: "-"
                },
                load: {
                    pbc: "-"
                }
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // NOTA: Excluimos intencionalmente 'precio_adquisicion', 'gastos_unidad', 'isCommission',
        // 'commissionPercentage', 'clave_vehicular', 'repuve', 'placas' y 'serie' (VIN) por privacidad.

        try {
            await destRef.set(publicData, { merge: true });
            console.log(`[syncInventoryToWeb] Camión ${truckId} sincronizado exitosamente en la página web`);
        } catch (error) {
            console.error(`[syncInventoryToWeb] Error al guardar el camión ${truckId} en la web:`, error);
        }

        return null;
    });

// Sincronización masiva de inventario existente (una sola ejecución por URL)
exports.migrateInventoryToWeb = functions.https.onRequest(async (req, res) => {
    let dbWeb;
    try {
        const serviceAccountWeb = require("./proyecto-web-service-account.json");
        const existingApp = admin.apps.find(app => app && app.name === "appWeb");
        const appWeb = existingApp || admin.initializeApp({
            credential: admin.credential.cert(serviceAccountWeb)
        }, "appWeb");
        dbWeb = appWeb.firestore();
    } catch (error) {
        res.status(500).send("Error al inicializar el proyecto Firebase Web secundario: " + error.message);
        return;
    }

    try {
        // 1. Limpiar toda la colección 'trucks' existente en la web (elimina cargas manuales anteriores)
        const webSnapshot = await dbWeb.collection("trucks").get();
        if (webSnapshot.size > 0) {
            const batch = dbWeb.batch();
            webSnapshot.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`[migrateInventoryToWeb] Limpiados ${webSnapshot.size} camiones de la web antes de sincronizar.`);
        }

        // 2. Traer del CRM y copiar a la web
        const snapshot = await db.collection("inventario").get();
        let count = 0;
        
        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            const truckId = docSnap.id;
            
            const formattedPrice = typeof data.precio === 'number' 
                ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0 }).format(data.precio) + ' MXN'
                : (data.precio ? `$${data.precio} MXN` : "Consultar Precio");

            const coverImage = data.foto || (data.fotos && data.fotos[0]) || "img/logo-1-cruzare.jpg";

            const publicData = {
                id: truckId,
                title: `${data.marca || ""} ${data.modelo || ""}`.trim(),
                year: String(data.anio || data.año || ""),
                price: formattedPrice,
                image: coverImage,
                engine: `${data.motor || ""} ${data.hp || ""}`.trim() || "-",
                trans: data.transmision || "-",
                frontAxle: data.eje_delantero || "-",
                rearAxle: data.eje_trasero || "-",
                suspension: data.suspension || "-",
                ratio: data.paso || "-",
                desc: data.descripcion || "",
                interiorImages: data.fotos || [], 
                engineImages: data.fotos || [], 
                videoPage: "",
                engineSound: "",
                specs: {
                    motor: {
                        model: data.motor || "-",
                        disp: "-",
                        power: data.hp || "-",
                        torque: "-",
                        emissions: "-",
                        b10: "-"
                    },
                    clutch: {
                        brand: "-",
                        type: "-",
                        size: "-",
                        act: "-"
                    },
                    trans: {
                        model: data.transmision || "-",
                        speeds: "-",
                        ratio: "-",
                        final: "-",
                        torque: "-",
                        retarder: "-"
                    },
                    frontAxle: {
                        type: "-",
                        susp: "-",
                        cap: data.eje_delantero || "-"
                    },
                    rearAxle: {
                        type: data.eje_trasero || "-",
                        susp: data.suspension || "-",
                        ratio: data.paso || "-"
                    },
                    tires: {
                        size: data.medida_llantas || "-",
                        rim: `${data.rines_delanteros || ""} / ${data.rines_traseros || ""}`.trim() || "-",
                        qty: "-"
                    },
                    elec: {
                        alt: "-",
                        volt: "-",
                        bat: "-"
                    },
                    load: {
                        pbc: "-"
                    }
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            await dbWeb.collection("trucks").doc(truckId).set(publicData, { merge: true });
            count++;
        }

        res.status(200).send(`Sincronización masiva exitosa. Se migraron ${count} unidades del inventario a la página web.`);
    } catch (error) {
        console.error("Error migrating inventory:", error);
        res.status(500).send("Error en la migración de datos: " + error.message);
    }
});

