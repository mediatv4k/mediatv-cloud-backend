// ==========================================
// MOTOR DE COBRANZA AUTOMÁTICA DIARIA (BOT 24/7 BLINDADO)
// ==========================================
function iniciarMotorCobranzaCloud(db, whatsappClient) {
    console.log("[BOT CLOUD] 🟢 Motor de cobranza automática iniciado y a la escucha...");
    
    // Revisa cada 30 segundos para mayor precisión en el minuto exacto
    setInterval(async () => {
        try {
            const now = new Date();
            // Ajuste exacto a hora Venezuela (UTC-4)
            const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const horaStr = String(horaActualVE.getHours()).padStart(2, '0') + ":" + String(horaActualVE.getMinutes()).padStart(2, '0');

            // HORA FIJA DE PRUEBA O AUTOMÁTICA (Puedes cambiar aquí o dejarlo abierto)
            // Para asegurarnos de que dispare, puedes definir la hora directamente o leerla:
            const horaProgramada = "14:42"; // <-- La hora que probaste ahorita (puedes ajustarla a la que desees)

            console.log(`[BOT CLOUD] ⏱️ Chequeo de hora - Servidor VE: ${horaStr} | Programada: ${horaProgramada}`);

            if (horaStr === horaProgramada) {
                console.log(`[BOT CLOUD] 🚀 ¡Coincidencia de hora! Ejecutando barrido de cobranza...`);
                
                // Consultar colección de clientes en Firestore (Ajustado para colección 'clientes')
                const snapshot = await db.collection('clientes').get();
                const hoy = new Date();
                hoy.setHours(0, 0, 0, 0);

                let enviadosCount = 0;

                for (const doc of snapshot.docs) {
                    const client = doc.data();
                    const fechaExpStr = client["Fecha Expira"] || client.expira || client.FechaExpira;
                    if (!fechaExpStr) continue;
                    
                    const fechaExp = new Date(fechaExpStr + "T00:00:00");
                    const diffTime = fechaExp - hoy;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    let mensaje = "";
                    let tipoEnvio = "";

                    // REGLA 1: Por Vencer (1 a 5 días antes)
                    if (diffDays >= 0 && diffDays <= 5) {
                        tipoEnvio = "🟡 Por Vencer";
                        mensaje = `¡Hola ${client.Nombre || client.nombre || 'Cliente'}! 🤝 Te saluda el *Equipo de Soporte de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${client.Usuario || client.usuario}*) vence en ${diffDays === 0 ? 'HOY' : diffDays + ' día(s)'}. ⏳\n\n💳 Puedes procesar tu renovación rápida y segura en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${client.Usuario || client.usuario}`;
                    }
                    // REGLA 2: Vencidos Recientes (1 a 5 días después)
                    else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
                        const diasVencido = Math.abs(diffDays);
                        tipoEnvio = "🔴 Vencido Reciente";
                        mensaje = `¡Hola ${client.Nombre || client.nombre || 'Cliente'}! ⚠️ Te saluda el *Equipo de Soporte de MediaTV*.\n\nNotamos que tu suscripción para el usuario (*${client.Usuario || client.usuario}*) venció hace ${diasVencido} día(s). 🔴\n\n✨ ¡No te quedes sin tu entretenimiento! Reactiva tu cuenta al instante en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${client.Usuario || client.usuario}`;
                    }

                    // Enviar WhatsApp si hay mensaje y teléfono válido
                    const telRaw = client.Teléfono || client.telefono;
                    if (mensaje && telRaw) {
                        let telefono = String(telRaw).replace(/\D/g, '');
                        if (telefono.length >= 10) {
                            const jid = telefono + "@s.whatsapp.net";
                            await whatsappClient.sendMessage(jid, { text: mensaje });
                            enviadosCount++;
                            console.log(`[BOT CLOUD] ✅ Mensaje [${tipoEnvio}] enviado con éxito a ${client.Nombre} (${telefono})`);
                            await new Promise(r => setTimeout(r, 4000)); // Pausa anti-bloqueo
                        }
                    }
                }
                console.log(`[BOT CLOUD] 🎯 Barrido finalizado. Total de cobros despachados: ${enviadosCount}`);
            }
        } catch (error) {
            console.error("[BOT CLOUD ERROR] Fallo crítico en el motor de cobros:", error);
        }
    }, 30000); // Revisa cada 30 segundos
}