// ==========================================
// MOTOR DE COBRANZA AUTOMÁTICA DIARIA (BOT 24/7)
// ==========================================
function iniciarMotorCobranzaCloud(db, whatsappClient) {
    // Revisa cada 60 minutos si es la hora programada en los settings
    setInterval(async () => {
        try {
            const statusConfig = process.env.CLOUD_ENVIO_STATUS || "Activo";
            if (statusConfig === "Pausado") return;

            const horaProgramada = process.env.CLOUD_ENVIO_HORA || "09:00"; // Hora configurada
            const now = new Date();
            // Ajuste a hora Venezuela (UTC-4)
            const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const horaStr = String(horaActualVE.getHours()).padStart(2, '0') + ":" + String(horaActualVE.getMinutes()).padStart(2, '0');

            // Compara si coincide con la hora programada (margen de 1 minuto)
            if (horaStr === horaProgramada) {
                console.log(`[BOT CLOUD] 🚀 Ejecutando barrido diario de cobranza a las ${horaStr} (VE)...`);
                
                // Consultar colección de clientes en Firestore
                const snapshot = await db.collection('clientes').get();
                const hoy = new Date();
                hoy.setHours(0, 0, 0, 0);

                let enviadosCount = 0;

                for (const doc of snapshot.docs) {
                    const client = doc.data();
                    if (!client.Fecha Expira && !client.expira) continue;
                    
                    const fechaExpStr = client.Fecha Expira || client.expira;
                    const fechaExp = new Date(fechaExpStr + "T00:00:00");
                    
                    // Diferencia en días (Expiración - Hoy)
                    const diffTime = fechaExp - hoy;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    let mensaje = "";
                    let tipoEnvio = "";

                    // REGLA 1: Por Vencer (1 a 5 días antes)
                    if (diffDays >= 0 && diffDays <= 5) {
                        tipoEnvio = "🟡 Por Vencer";
                        mensaje = `¡Hola ${client.Nombre || client.nombre}! 🤝 Te saluda el *Equipo de Soporte de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${client.Usuario || client.usuario}*) vence en ${diffDays === 0 ? 'HOY' : diffDays + ' día(s)'}. ⏳\n\n💳 Puedes procesar tu renovación rápida y segura en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${client.Usuario || client.usuario}`;
                    }
                    // REGLA 2: Vencidos Recientes (1 a 5 días después)
                    else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
                        const diasVencido = Math.abs(diffDays);
                        tipoEnvio = "🔴 Vencido Reciente";
                        mensaje = `¡Hola ${client.Nombre || client.nombre}! ⚠️ Te saluda el *Equipo de Soporte de MediaTV*.\n\nNotamos que tu suscripción para el usuario (*${client.Usuario || client.usuario}*) venció hace ${diasVencido} día(s). 🔴\n\n✨ ¡No te quedes sin tu entretenimiento! Reactiva tu cuenta al instante en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${client.Usuario || client.usuario}`;
                    }
                    // REGLA 3: ≥ 6 días vencidos -> NO SE HACE NADA (Silencio automático)

                    // Si hay mensaje y el cliente tiene teléfono válido, disparar WhatsApp
                    if (mensaje && client.Teléfono || client.telefono) {
                        let telefono = (client.Teléfono || client.telefono).replace(/\D/g, '');
                        if (telefono.length >= 10) {
                            const jid = telefono + "@s.whatsapp.net";
                            await whatsappClient.sendMessage(jid, { text: mensaje });
                            enviadosCount++;
                            console.log(`[BOT CLOUD] ✅ Enviado [${tipoEnvio}] a ${client.Nombre} (${telefono})`);
                            // Pausa de 5 segundos entre mensajes para evitar bloqueo de WhatsApp
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }
                }
                console.log(`[BOT CLOUD] 🎯 Barrido completado. Total de avisos enviados: ${enviadosCount}`);
            }
        } catch (error) {
            console.error("[BOT CLOUD ERROR] Error en la rutina de cobro automático:", error);
        }
    }, 60000); // Revisa cada minuto
}